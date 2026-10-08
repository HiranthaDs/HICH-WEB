from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import hmac
import re
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from ..config import Settings, get_settings
from ..data import audit, db_failure, first, rows
from ..dependencies import Principal, current_admin, require_deletion_pin
from ..invoice_sharing import (
    InvoiceDocumentCreate,
    InvoiceDocumentUpdate,
    InvoiceShareRequest,
    RenewalInvoiceRequest,
    invoice_token,
    invoice_token_hash,
    public_invoice_shape,
)
from ..models import (
    MilestoneCreate,
    MilestoneUpdate,
    PaymentCreate,
    PaymentUpdate,
    json_ready,
)
from ..security import client_ip, enforce_rate_limit
from ..supabase_client import SupabaseGateway, get_supabase
from ..income import COLOMBO


router = APIRouter(prefix="/invoices", tags=["invoices"])
public_router = APIRouter(prefix="/public/invoices", tags=["public invoices"])
INVOICE_SELECT = "*,clients(name,company,email,phone),invoice_milestones(*),payments(*)"


def _invoice_number() -> str:
    return f"INV-{datetime.now(timezone.utc):%Y%m}-{UUID(int=__import__('secrets').randbits(128)).hex[:8].upper()}"


def _shape(record: dict[str, Any]) -> dict[str, Any]:
    record = record.copy()
    record.pop("share_nonce", None)
    record.pop("share_token_hash", None)
    client = record.get("clients") or {}
    milestones = sorted(record.pop("invoice_milestones", []) or [], key=lambda item: (item.get("position", 0), item.get("created_at", "")))
    payment_records = sorted(record.get("payments", []) or [], key=lambda item: item.get("paid_at", ""), reverse=True)
    payments_by_milestone: dict[str, list[dict[str, Any]]] = {}
    for payment in payment_records:
        payments_by_milestone.setdefault(str(payment.get("milestone_id") or ""), []).append(payment)
    phases: list[dict[str, Any]] = []
    for milestone in milestones:
        linked = payments_by_milestone.get(str(milestone.get("id")), [])
        paid_for_phase = sum((Decimal(str(item.get("amount") or 0)) for item in linked), Decimal())
        milestone_amount = Decimal(str(milestone.get("amount") or 0))
        is_paid = milestone.get("status") == "paid" or (milestone_amount > 0 and paid_for_phase >= milestone_amount)
        paid_at = linked[0].get("paid_at") if linked and linked[0].get("date_confirmed") is not False else None
        phases.append(
            {
                "id": milestone.get("id"),
                "name": milestone.get("title"),
                "amount": milestone.get("amount"),
                "status": f"Paid {str(paid_at)[:10]}" if is_paid and paid_at else str(milestone.get("status") or "pending").title(),
                "is_paid": is_paid,
                "isPaid": is_paid,
                "paid_at": paid_at,
                "paid_amount": str(paid_for_phase),
            }
        )
    paid = sum((Decimal(str(item.get("amount") or 0)) for item in payment_records), Decimal())
    effective_status = record.get("status")
    total = Decimal(str(record.get("project_value") or 0))
    if effective_status not in {"draft", "void"}:
        effective_status = "paid" if total > 0 and paid >= total else "partial" if paid > 0 else "sent"
    try:
        due_date = date.fromisoformat(str(record.get("due_date"))[:10]) if record.get("due_date") else None
        if due_date and due_date < datetime.now(COLOMBO).date() and effective_status not in {"paid", "void"} and paid < Decimal(str(record.get("project_value") or 0)):
            effective_status = "overdue"
    except ValueError:
        pass
    return record | {
        "reference": record.get("invoice_number"),
        "amount": record.get("project_value"),
        "paid_amount": str(paid),
        "balance_due": str(max(Decimal(0), total - paid)),
        "client_name": client.get("company") or client.get("name"),
        "client_email": client.get("email"),
        "phone": client.get("phone"),
        "status": effective_status,
        "milestones": milestones,
        "payments": phases,
        "payment_records": payment_records,
    }


def _get(invoice_id: UUID, gateway: SupabaseGateway) -> dict[str, Any]:
    result = gateway.service.table("invoices").select(INVOICE_SELECT).is_("deleted_at", "null").eq("id", str(invoice_id)).limit(1).execute()
    return _shape(first(result, "Invoice"))


@router.get("")
def list_invoices(
    invoice_status: str | None = Query(default=None, alias="status", max_length=30),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _: Principal = Depends(current_admin),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        query = gateway.service.table("invoices").select(INVOICE_SELECT).is_("deleted_at", "null").order("created_at", desc=True).order("id")
        if invoice_status:
            query = query.eq("status", invoice_status)
        result = rows(query.range(offset, offset + limit - 1).execute())
        items = [_shape(item) for item in result]
        return {"invoices": {"items": items, "total": len(items)}}
    except Exception as exc:
        raise db_failure(exc, "load invoices") from exc


def _document_failure(exc: Exception, operation: str) -> HTTPException:
    message = str(exc).lower()
    if "invoice_revision_conflict" in message:
        return HTTPException(status_code=409, detail="This invoice was updated elsewhere. Reload it before saving.")
    if "invoice_not_found" in message:
        return HTTPException(status_code=404, detail="Invoice not found")
    if "invoice_void" in message:
        return HTTPException(status_code=409, detail="Voided invoices cannot be changed or shared")
    if "renewal_invoice_cycle_unique" in message:
        return HTTPException(status_code=409, detail="A renewal invoice already exists for this cycle. Open it instead.")
    if "invoice_validation:" in message:
        reason = message.split("invoice_validation:", 1)[1].split("'", 1)[0].split('"', 1)[0].strip()
        return HTTPException(status_code=422, detail=reason[:200])
    if "23514" in message or "check constraint" in message:
        return HTTPException(status_code=422, detail="Invoice values or dates do not satisfy the required rules")
    return db_failure(exc, operation)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_invoice(
    payload: InvoiceDocumentCreate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    if payload.status == "void":
        require_deletion_pin(request, settings, principal)
    record = json_ready(
        payload,
        exclude={"milestones", "payments", "amount", "reference", "client_name", "phone", "paid_amount"},
    )
    record.update({"invoice_number": payload.invoice_number or payload.reference or _invoice_number(),
                   "project_value": str(payload.project_value), "created_by": str(principal.id)})
    if payload.status in {"partial", "paid", "overdue"}:
        record["status"] = "sent"
    try:
        created = first(gateway.service.rpc("save_invoice_document", {
            "p_invoice_id": None, "p_fields": record,
            "p_phases": [json_ready(phase) for phase in payload.payments] if payload.payments else None,
            "p_milestones": [json_ready(item) for item in payload.milestones] if payload.milestones else None,
            "p_actor_id": str(principal.id), "p_expected_revision": None,
        }).execute(), "Invoice")
        invoice_id = UUID(created["id"])
        audit(gateway.service, request, settings, "create", "invoice", invoice_id, principal)
        return {"invoice": _get(invoice_id, gateway)}
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "create the invoice") from exc


def _renewal_document(source: dict[str, Any], payload: RenewalInvoiceRequest, today: date) -> InvoiceDocumentCreate:
    if source.get("invoice_kind") == "renewal" or source.get("status") == "void":
        raise HTTPException(422, "Choose an active project invoice as the renewal source")
    if str(source.get("renewal_due_date") or "")[:10] != payload.renewal_period_date.isoformat():
        raise HTTPException(409, "The renewal date has changed. Reload the source invoice before billing.")
    if payload.due_date < today:
        raise HTTPException(422, "The new invoice payment due date cannot be before its issue date")
    base = sum((item.amount for item in payload.items), Decimal())
    late = Decimal(0)
    if payload.apply_late_fee:
        if payload.renewal_period_date >= today:
            raise HTTPException(422, "The renewal is not overdue; no late-payment surcharge is due")
        late = (base * Decimal("0.18")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    total = base + late
    if total >= Decimal("1000000000000"):
        raise HTTPException(422, "The renewal invoice total exceeds the supported amount")
    return InvoiceDocumentCreate(
        client_id=source["client_id"], agreement_id=source.get("agreement_id"),
        project_title=f"Domain & hosting renewal — {source.get('project_title') or 'Website'}"[:240],
        amount=total, currency=payload.currency, issue_date=today, due_date=payload.due_date,
        payment_method=source.get("payment_method"), payment_instructions=source.get("payment_instructions"),
        customer_note=payload.customer_note, status="sent",
        payments=[{"name": "Renewal payment", "amount": total}], invoice_kind="renewal",
        renewal_source_invoice_id=source["id"], renewal_period_date=payload.renewal_period_date,
        renewal_items=payload.items, renewal_late_fee=late, renewal_late_fee_accepted=payload.late_fee_accepted,
    )


@router.post("/{invoice_id}/renewal-invoice")
def create_renewal_invoice(
    invoice_id: UUID, payload: RenewalInvoiceRequest, request: Request,
    principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        document = _renewal_document(_get(invoice_id, gateway), payload, datetime.now(COLOMBO).date())
        record = json_ready(document, exclude={"milestones", "payments", "amount", "reference", "client_name", "phone", "paid_amount"})
        record.update({"invoice_number": _invoice_number().replace("INV-", "REN-", 1),
                       "project_value": str(document.project_value), "created_by": str(principal.id)})
        created = first(gateway.service.rpc("create_renewal_invoice", {
            "p_source_id": str(invoice_id), "p_period_date": payload.renewal_period_date.isoformat(),
            "p_fields": record, "p_actor_id": str(principal.id),
        }).execute(), "Renewal invoice")
        audit(gateway.service, request, settings, "prepare_renewal", "invoice", created["id"], principal,
              {"source_invoice_id": str(invoice_id), "renewal_period_date": payload.renewal_period_date.isoformat()})
        return {"invoice": _get(UUID(created["id"]), gateway)}
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "prepare the renewal invoice") from exc


@router.get("/{invoice_id}")
def get_invoice(
    invoice_id: UUID,
    _: Principal = Depends(current_admin),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        return {"invoice": _get(invoice_id, gateway)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the invoice") from exc


@router.put("/{invoice_id}")
@router.patch("/{invoice_id}")
def update_invoice(
    invoice_id: UUID,
    payload: InvoiceDocumentUpdate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    needs_pin = payload.status == "void"
    if payload.payments is not None:
        current = _get(invoice_id, gateway)
        by_id = {str(phase.id): phase for phase in payload.payments if phase.id}
        for old in current.get("payments", []):
            phase = by_id.get(str(old.get("id")))
            if not phase or (old.get("is_paid") and (not (phase.is_paid or phase.isPaid) or Decimal(str(old["amount"])) != phase.amount)):
                needs_pin = True
    if payload.milestones is not None and _get(invoice_id, gateway).get("payments"):
        needs_pin = True
    if needs_pin:
        require_deletion_pin(request, settings, principal)
    changes = json_ready(
        payload, exclude_unset=True,
        exclude={"amount", "reference", "payments", "milestones", "client_name", "phone", "paid_amount", "expected_revision"},
    )
    # Explicit null clears optional fields; omitted fields keep their existing value.
    clearable = {"agreement_id", "project_title", "renewal_amount", "renewal_currency", "renewal_due_date",
                 "due_date", "payment_method", "notes", "payment_instructions", "customer_note"}
    for field in clearable.intersection(payload.model_fields_set):
        if getattr(payload, field) is None:
            changes[field] = None
    if payload.reference is not None and payload.invoice_number is None:
        changes["invoice_number"] = payload.reference
    if payload.amount is not None and payload.project_value is None:
        changes["project_value"] = str(payload.amount)
    if changes.get("status") in {"partial", "paid", "overdue"}:
        changes.pop("status")
    try:
        first(gateway.service.rpc("save_invoice_document", {
            "p_invoice_id": str(invoice_id), "p_fields": changes,
            "p_phases": [json_ready(phase) for phase in payload.payments] if payload.payments is not None else None,
            "p_milestones": [json_ready(item) for item in payload.milestones] if payload.milestones is not None else None,
            "p_actor_id": str(principal.id), "p_expected_revision": payload.expected_revision,
        }).execute(), "Invoice")
        if changes or payload.payments is not None or payload.milestones is not None:
            fields = sorted(changes) + (["payment_phases"] if payload.payments is not None else [])
            audit(gateway.service, request, settings, "update", "invoice", invoice_id, principal, {"fields": fields})
        return {"invoice": _get(invoice_id, gateway)}
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "update the invoice") from exc


@router.delete("/{invoice_id}", status_code=status.HTTP_204_NO_CONTENT)
def void_invoice(
    invoice_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    try:
        first(gateway.service.table("invoices").update({"status": "void", "deleted_at": datetime.now(timezone.utc).isoformat()}).eq("id", str(invoice_id)).execute(), "Invoice")
        audit(gateway.service, request, settings, "delete", "invoice", invoice_id, principal)
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "void the invoice") from exc


@router.post("/{invoice_id}/milestones", status_code=status.HTTP_201_CREATED)
def create_milestone(
    invoice_id: UUID,
    payload: MilestoneCreate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    record = json_ready(payload) | {"invoice_id": str(invoice_id), "amount": str(payload.amount)}
    try:
        created = first(gateway.service.table("invoice_milestones").insert(record).execute(), "Milestone")
        audit(gateway.service, request, settings, "create", "invoice_milestone", created["id"], principal, {"invoice_id": str(invoice_id)})
        return {"milestone": created, "invoice": _get(invoice_id, gateway)}
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "create the milestone") from exc


@router.put("/{invoice_id}/milestones/{milestone_id}")
@router.patch("/{invoice_id}/milestones/{milestone_id}")
def update_milestone(
    invoice_id: UUID,
    milestone_id: UUID,
    payload: MilestoneUpdate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    changes = json_ready(payload, exclude_unset=True)
    try:
        updated = first(
            gateway.service.table("invoice_milestones").update(changes).eq("id", str(milestone_id)).eq("invoice_id", str(invoice_id)).execute(),
            "Milestone",
        )
        audit(gateway.service, request, settings, "update", "invoice_milestone", milestone_id, principal)
        return {"milestone": updated, "invoice": _get(invoice_id, gateway)}
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "update the milestone") from exc


@router.delete("/{invoice_id}/milestones/{milestone_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_milestone(
    invoice_id: UUID,
    milestone_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    try:
        deleted = rows(gateway.service.table("invoice_milestones").delete().eq("id", str(milestone_id)).eq("invoice_id", str(invoice_id)).execute())
        if not deleted:
            raise HTTPException(status_code=404, detail="Milestone not found")
        audit(gateway.service, request, settings, "delete", "invoice_milestone", milestone_id, principal)
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "delete the milestone") from exc


@router.post("/{invoice_id}/payments", status_code=status.HTTP_201_CREATED)
def create_payment(
    invoice_id: UUID,
    payload: PaymentCreate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    record = json_ready(payload) | {
        "invoice_id": str(invoice_id),
        "amount": str(payload.amount),
        "created_by": str(principal.id),
    }
    try:
        created = first(gateway.service.table("payments").insert(record).execute(), "Payment")
        audit(gateway.service, request, settings, "create", "payment", created["id"], principal, {"invoice_id": str(invoice_id)})
        return {"payment": created, "invoice": _get(invoice_id, gateway)}
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "record the payment") from exc


@router.put("/{invoice_id}/payments/{payment_id}")
@router.patch("/{invoice_id}/payments/{payment_id}")
def update_payment(
    invoice_id: UUID,
    payment_id: UUID,
    payload: PaymentUpdate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    if payload.amount is not None:
        current = first(gateway.service.table("payments").select("amount").eq("id", str(payment_id)).eq("invoice_id", str(invoice_id)).limit(1).execute(), "Payment")
        if payload.amount < Decimal(str(current["amount"])):
            require_deletion_pin(request, settings, principal)
    changes = json_ready(payload, exclude_unset=True)
    if payload.paid_at is not None:
        changes["date_confirmed"] = True
    for key in {"milestone_id", "method", "reference", "notes"} & payload.model_fields_set:
        if getattr(payload, key) is None:
            changes[key] = None
    try:
        updated = first(
            gateway.service.table("payments").update(changes).eq("id", str(payment_id)).eq("invoice_id", str(invoice_id)).execute(),
            "Payment",
        )
        audit(gateway.service, request, settings, "update", "payment", payment_id, principal)
        return {"payment": updated, "invoice": _get(invoice_id, gateway)}
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "update the payment") from exc


@router.delete("/{invoice_id}/payments/{payment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_payment(
    invoice_id: UUID,
    payment_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    try:
        deleted = rows(gateway.service.table("payments").delete().eq("id", str(payment_id)).eq("invoice_id", str(invoice_id)).execute())
        if not deleted:
            raise HTTPException(status_code=404, detail="Payment not found")
        audit(gateway.service, request, settings, "delete", "payment", payment_id, principal)
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "delete the payment") from exc


@router.post("/{invoice_id}/share")
def share_invoice(
    invoice_id: UUID,
    request: Request,
    payload: InvoiceShareRequest | None = None,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    options = payload or InvoiceShareRequest()
    nonce = str(uuid4())
    token = invoice_token(str(invoice_id), nonce, settings)
    try:
        record = first(gateway.service.rpc("publish_invoice_link", {
            "p_invoice_id": str(invoice_id), "p_nonce": nonce,
            "p_token_hash": invoice_token_hash(token, settings), "p_rotate": options.rotate,
            "p_expires_at": options.expires_at.isoformat() if options.expires_at else None,
            "p_set_expiry": "expires_at" in options.model_fields_set,
        }).execute(), "Invoice")
        token = invoice_token(str(invoice_id), str(record["share_nonce"]), settings)
        if not hmac.compare_digest(invoice_token_hash(token, settings), str(record["share_token_hash"])):
            raise HTTPException(status_code=409, detail="The signing key changed. Regenerate this invoice link.")
        audit(gateway.service, request, settings, "share_rotated" if options.rotate else "share", "invoice", invoice_id, principal)
        return {
            "share_url": f"{str(settings.public_app_url).rstrip('/')}/invoice/{token}",
            "token": token, "expires_at": record.get("share_expires_at"),
            "invoice": _get(invoice_id, gateway),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise _document_failure(exc, "publish the invoice link") from exc


@router.delete("/{invoice_id}/share", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invoice_share(
    invoice_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    try:
        first(gateway.service.table("invoices").update({
            "share_active": False, "share_nonce": None, "share_token_hash": None,
        }).eq("id", str(invoice_id)).execute(), "Invoice")
        audit(gateway.service, request, settings, "share_revoked", "invoice", invoice_id, principal)
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "revoke the invoice link") from exc


@router.get("/{invoice_id}/versions")
def invoice_versions(
    invoice_id: UUID,
    limit: int = Query(default=30, ge=1, le=100),
    _: Principal = Depends(current_admin),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        first(gateway.service.table("invoices").select("id").eq("id", str(invoice_id)).limit(1).execute(), "Invoice")
        versions = rows(gateway.service.table("invoice_versions")
                        .select("version,snapshot,created_at").eq("invoice_id", str(invoice_id))
                        .order("version", desc=True).limit(limit).execute())
        for version in versions:
            snapshot = version.get("snapshot") or {}
            version["snapshot"] = _shape(snapshot | {"invoice_milestones": snapshot.get("milestones", []), "clients": snapshot.get("client", {})})
        return {"versions": versions}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load invoice history") from exc


@public_router.get("/{token}")
def get_public_invoice(
    token: str,
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    enforce_rate_limit(f"public-invoice:{client_ip(request, settings.trust_proxy_headers)}", 120, 60)
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise HTTPException(status_code=404, detail="Invoice link is unavailable")
    try:
        found = rows(gateway.service.table("invoices").select(INVOICE_SELECT)
                     .eq("share_token_hash", invoice_token_hash(token, settings))
                     .eq("share_active", True).limit(1).execute())
        if not found or found[0].get("deleted_at") or found[0].get("status") in {"draft", "void"}:
            raise HTTPException(status_code=404, detail="Invoice link is unavailable")
        record = found[0]
        expires_at = record.get("share_expires_at")
        if expires_at:
            expiry = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
            expiry = expiry.replace(tzinfo=timezone.utc) if expiry.tzinfo is None else expiry
            if expiry <= datetime.now(timezone.utc):
                raise HTTPException(status_code=410, detail="This invoice link has expired. Please request a new link.")
        return {"invoice": public_invoice_shape(_shape(record))}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the invoice") from exc
