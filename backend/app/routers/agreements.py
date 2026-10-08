from __future__ import annotations

import json
import hashlib
from io import BytesIO
from datetime import datetime
from decimal import Decimal
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import Response as FastAPIResponse
from PIL import Image, UnidentifiedImageError

from ..config import Settings, get_settings
from ..agreement_template import CONSENT_TEXT, template_payload
from ..commercial_terms import scheduled_terms
from ..data import audit, db_failure, first, rows
from ..dependencies import Principal, current_admin, require_deletion_pin
from ..models import AgreementCreate, AgreementUpdate, SignAgreementRequest, json_ready
from ..pdf import agreement_pdf
from ..security import (
    client_ip,
    content_sha256,
    decode_image_data_url,
    enforce_rate_limit,
    hash_public_token,
    new_public_token,
    utcnow,
)
from ..supabase_client import SupabaseGateway, get_supabase


router = APIRouter(prefix="/agreements", tags=["agreements"])
public_router = APIRouter(prefix="/public/agreements", tags=["public"])

AGREEMENT_SELECT = "*,clients(name,company,email,phone),portfolio_projects(title)"
DOCUMENT_FIELDS = (
    "reference", "client_id", "client_name", "client_email", "client_phone", "project_id",
    "title", "project_title", "description", "terms", "amount", "currency", "expires_at",
    "renewal_amount", "renewal_currency", "renewal_due_date",
    "source_invoice_id", "visiting_fee_lkr", "payment_schedule", "payment_instructions", "project_due_date",
)


def _document_snapshot(record: dict[str, Any]) -> dict[str, Any]:
    client = record.get("clients") or {}
    snapshot = {key: record.get(key) for key in DOCUMENT_FIELDS}
    snapshot.update({
        "reference": record.get("reference") or str(record.get("public_id") or record.get("id")),
        "client_name": record.get("client_name") or client.get("company") or client.get("name"),
        "client_email": record.get("client_email") or client.get("email"),
        "client_phone": record.get("client_phone") or client.get("phone"),
        "version": record.get("version", 1),
    })
    return snapshot


def _document_digest(record: dict[str, Any]) -> str:
    snapshot = _document_snapshot(record)
    snapshot.pop("version", None)
    if snapshot.get("amount") is not None:
        snapshot["amount"] = format(Decimal(str(snapshot["amount"])), ".2f")
    if snapshot.get("renewal_amount") is not None:
        snapshot["renewal_amount"] = format(Decimal(str(snapshot["renewal_amount"])), ".2f")
    if snapshot.get("visiting_fee_lkr") is not None:
        snapshot["visiting_fee_lkr"] = format(Decimal(str(snapshot["visiting_fee_lkr"])), ".2f")
    return content_sha256(json.dumps(snapshot, sort_keys=True, default=str, ensure_ascii=False))


def _ensure_shareable(record: dict[str, Any]) -> None:
    document = _document_snapshot(record)
    missing = [name for name in ("client_name", "client_phone", "project_title") if not document.get(name)]
    if document.get("amount") is None:
        missing.append("amount")
    if missing:
        raise HTTPException(status_code=422, detail=f"Complete these fields before sharing: {', '.join(missing)}")
    if record.get("expires_at"):
        expiry = datetime.fromisoformat(str(record["expires_at"]).replace("Z", "+00:00"))
        if expiry <= utcnow():
            raise HTTPException(status_code=422, detail="Choose a future expiry date before sharing")


def _decode_signature(value: str, max_bytes: int) -> tuple[bytes, str, str]:
    image_bytes, content_type, extension = decode_image_data_url(value, max_bytes)
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            if source.width > 4096 or source.height > 4096 or source.width * source.height > 8_000_000:
                raise ValueError("Signature image dimensions are too large")
            source.load()
            rgba = source.convert("RGBA")
            background = Image.new("RGBA", rgba.size, "white")
            background.alpha_composite(rgba)
            grey = background.convert("L")
            histogram = grey.histogram()
            if sum(histogram[:220]) < 10 or grey.getextrema()[1] - grey.getextrema()[0] < 10:
                raise ValueError("Draw your signature before submitting")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("Signature image could not be read") from exc
    return image_bytes, content_type, extension


def _share_url(settings: Settings, token: str) -> str:
    return f"{str(settings.public_app_url).rstrip('/')}/sign/{quote(token, safe='')}"


def _shape(record: dict[str, Any], settings: Settings, token: str | None = None) -> dict[str, Any]:
    if record.get("status") == "signed" and record.get("signed_snapshot"):
        record = record | record["signed_snapshot"] | {"clients": {}, "portfolio_projects": {}}
    client = record.get("clients") or {}
    project = record.get("portfolio_projects") or {}
    shaped = record | {
        "reference": record.get("reference") or str(record.get("public_id") or record.get("id")),
        "client_name": record.get("client_name") or client.get("company") or client.get("name"),
        "client_email": record.get("client_email") or client.get("email"),
        "client_phone": record.get("client_phone") or client.get("phone"),
        "project_title": record.get("project_title") or project.get("title"),
        "content": record.get("description"),
        "signed": record.get("status") == "signed",
        "version": record.get("version", 1),
    }
    if token:
        shaped["token"] = token
        shaped["share_url"] = _share_url(settings, token)
        shaped["signing_token"] = token
        shaped["signing_path"] = f"/sign/{token}"
    return shaped


def _public_shape(record: dict[str, Any], settings: Settings) -> dict[str, Any]:
    """Return only fields intentionally disclosed to possession-based public links."""

    # Signed names, contact information and terms never follow later CRM edits.
    if record.get("status") == "signed" and record.get("signed_snapshot"):
        record = record | record["signed_snapshot"] | {"clients": {}, "portfolio_projects": {}}
    client = record.get("clients") or {}
    project = record.get("portfolio_projects") or {}
    public_id = str(record.get("public_id") or record.get("id"))
    return {
        "id": public_id,
        "public_id": public_id,
        "reference": record.get("reference") or public_id,
        "title": record.get("title"),
        "status": record.get("status"),
        "client": {
            "name": record.get("client_name") or client.get("name"),
            "email": record.get("client_email") or client.get("email"),
            "phone": record.get("client_phone") or client.get("phone"),
        },
        "client_name": record.get("client_name") or client.get("company") or client.get("name"),
        "client_email": record.get("client_email") or client.get("email"),
        "client_phone": record.get("client_phone") or client.get("phone"),
        "project_title": record.get("project_title") or project.get("title"),
        "description": record.get("description"),
        "content": record.get("description"),
        "terms": record.get("terms") or {},
        "amount": record.get("amount"),
        "renewal_amount": record.get("renewal_amount"),
        "renewal_currency": record.get("renewal_currency"),
        "renewal_due_date": record.get("renewal_due_date"),
        "visiting_fee_lkr": record.get("visiting_fee_lkr"),
        "payment_schedule": record.get("payment_schedule"),
        "payment_instructions": record.get("payment_instructions"),
        "project_due_date": record.get("project_due_date"),
        "currency": record.get("currency") or "LKR",
        "created_at": record.get("created_at"),
        "sent_at": record.get("sent_at"),
        "viewed_at": record.get("viewed_at"),
        "expires_at": record.get("expires_at"),
        "signed_at": record.get("signed_at"),
        "signer_name": record.get("signer_name"),
        "signer_job_role": record.get("signer_job_role"),
        "version": record.get("version", 1),
        "content_sha256": record.get("content_sha256"),
        "consent_text": record.get("consent_text") or CONSENT_TEXT,
        "signed_record_sha256": record.get("signed_record_sha256"),
        "signed": record.get("status") == "signed",
        "studio_name": settings.app_name.removesuffix(" API"),
    }


def _agreement_by_id(agreement_id: UUID, gateway: SupabaseGateway) -> dict[str, Any]:
    return first(
        gateway.service.table("agreements").select(AGREEMENT_SELECT).is_("deleted_at", "null").eq("id", str(agreement_id)).limit(1).execute(),
        "Agreement",
    )


def _agreement_by_token(token: str, settings: Settings, gateway: SupabaseGateway) -> dict[str, Any]:
    if len(token) < 32 or len(token) > 200:
        raise HTTPException(status_code=404, detail="Agreement not found")
    digest = hash_public_token(token, settings.token_hash_pepper.get_secret_value())
    record = first(
        gateway.service.table("agreements").select(AGREEMENT_SELECT).eq("access_token_hash", digest).is_("deleted_at", "null").limit(1).execute(),
        "Agreement",
    )
    expiry = record.get("expires_at")
    if expiry and record.get("status") not in {"signed", "void", "expired"}:
        expires_at = datetime.fromisoformat(str(expiry).replace("Z", "+00:00"))
        if expires_at <= utcnow():
            updated = rows(gateway.service.table("agreements").update({"status": "expired"}).eq("id", record["id"]).eq("version", record.get("version", 1)).in_("status", ["draft", "sent", "viewed"]).execute())
            if updated:
                record["status"] = "expired"
            else:
                record = _agreement_by_id(UUID(record["id"]), gateway)
                if record.get("access_token_hash") != digest:
                    raise HTTPException(status_code=404, detail="Agreement not found")
    return record


def _resolve_client(payload: AgreementCreate, principal: Principal, gateway: SupabaseGateway) -> UUID:
    if payload.client_id:
        first(gateway.service.table("clients").select("id").eq("id", str(payload.client_id)).limit(1).execute(), "Client")
        return payload.client_id
    if payload.client_email:
        found = rows(gateway.service.table("clients").select("id").eq("email", str(payload.client_email)).limit(1).execute())
        if found:
            return UUID(found[0]["id"])
    created = first(
        gateway.service.table("clients")
        .insert(
            {
                "name": payload.client_name,
                "email": str(payload.client_email) if payload.client_email else None,
                "phone": payload.client_phone,
                "status": "active",
                "created_by": str(principal.id),
            }
        )
        .execute(),
        "Client",
    )
    return UUID(created["id"])


@router.get("/template")
def default_agreement_template(_: Principal = Depends(current_admin)) -> dict[str, Any]:
    return {"template": template_payload()}


@router.get("")
def list_agreements(
    agreement_status: str | None = Query(default=None, alias="status", max_length=30),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        query = gateway.service.table("agreements").select(AGREEMENT_SELECT).is_("deleted_at", "null").order("created_at", desc=True).order("id")
        if agreement_status:
            query = query.eq("status", agreement_status)
        result = rows(query.range(offset, offset + limit - 1).execute())
        items = [_shape(item, settings) for item in result]
        return {"agreements": {"items": items, "total": len(items)}}
    except Exception as exc:
        raise db_failure(exc, "load agreements") from exc


@router.get("/from-invoice/{invoice_id}")
def agreement_from_invoice(invoice_id: UUID, _: Principal = Depends(current_admin),
                           gateway: SupabaseGateway = Depends(get_supabase)):
    from .invoices import _get
    invoice = _get(invoice_id, gateway)
    if invoice.get("status") == "void":
        raise HTTPException(409, "Choose an active invoice for the agreement")
    client = invoice.get("clients") or {}
    phases = [{"name": p["name"], "amount": p["amount"], "is_paid": p["is_paid"], "paid_at": p.get("paid_at"), "received_amount": p.get("paid_amount", "0")} for p in invoice.get("payments", []) if Decimal(str(p.get("amount") or 0)) > 0]
    return {"agreement": {
        **template_payload(), "source_invoice_id": str(invoice_id), "client_id": invoice["client_id"],
        "client_name": client.get("name") or invoice.get("client_name"), "client_email": client.get("email"),
        "client_phone": client.get("phone"), "project_title": invoice.get("project_title"),
        "amount": invoice["amount"], "currency": invoice["currency"], "payment_schedule": phases,
        "visiting_fee_lkr": str(next((Decimal(str(p["amount"])) for p in phases if "visit" in p["name"].lower() and Decimal(5000) <= Decimal(str(p["amount"])) <= Decimal(15000)), Decimal())) if invoice["currency"] == "LKR" else "0",
        "payment_instructions": invoice.get("payment_instructions"), "project_due_date": invoice.get("due_date"),
        "renewal_amount": invoice.get("renewal_amount"), "renewal_currency": invoice.get("renewal_currency"),
        "renewal_due_date": invoice.get("renewal_due_date"),
    }}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_agreement(
    payload: AgreementCreate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    token = new_public_token()
    prepared_terms = scheduled_terms(json_ready(payload))
    try:
        client_id = _resolve_client(payload, principal, gateway)
        client = first(gateway.service.table("clients").select("name,company,email,phone").eq("id", str(client_id)).limit(1).execute(), "Client")
        record = json_ready(
            payload,
            exclude={"content", "send_immediately"},
        )
        record.update(
            {
                "client_id": str(client_id),
                "client_name": payload.client_name or client.get("company") or client.get("name"),
                "client_email": str(payload.client_email) if payload.client_email else client.get("email"),
                "client_phone": payload.client_phone or client.get("phone"),
                "reference": payload.reference or f"HICH-AGR-{utcnow():%Y}-{uuid4().hex[:8].upper()}",
                "created_by": str(principal.id),
                "public_id": str(uuid4()),
                "access_token_hash": hash_public_token(token, settings.token_hash_pepper.get_secret_value()),
                "status": "sent" if payload.send_immediately else "draft",
                "sent_at": utcnow().isoformat() if payload.send_immediately else None,
            }
        )
        if payload.source_invoice_id:
            source = first(gateway.service.table("invoices").select("client_id,status").eq("id", str(payload.source_invoice_id)).limit(1).execute(), "Invoice")
            if source["client_id"] != str(client_id) or source["status"] == "void":
                raise HTTPException(422, "The source invoice must belong to this client and remain active")
        record["terms"] = prepared_terms
        record["content_sha256"] = _document_digest(record)
        if payload.send_immediately:
            _ensure_shareable(record)
        created = first(gateway.service.table("agreements").insert(record).execute(), "Agreement")
        audit(gateway.service, request, settings, "create", "agreement", created["id"], principal)
        return {"agreement": _shape(_agreement_by_id(UUID(created["id"]), gateway), settings, token)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "create the agreement") from exc


@router.get("/{agreement_id}")
def get_agreement(
    agreement_id: UUID,
    _: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        return {"agreement": _shape(_agreement_by_id(agreement_id, gateway), settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the agreement") from exc


@router.put("/{agreement_id}")
@router.patch("/{agreement_id}")
def update_agreement(
    agreement_id: UUID,
    payload: AgreementUpdate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    current = _agreement_by_id(agreement_id, gateway)
    if current.get("status") == "signed":
        raise HTTPException(status_code=409, detail="Signed agreements are immutable")
    if payload.status == "signed":
        raise HTTPException(status_code=422, detail="Agreements can only become signed through the secure signing flow")
    if payload.status in {"void", "expired"}:
        require_deletion_pin(request, settings, principal)
    if payload.expected_version is not None and payload.expected_version != current.get("version", 1):
        raise HTTPException(status_code=409, detail="This agreement changed. Reload before saving.")
    changes = json_ready(payload, exclude_unset=True, exclude={"content", "expected_version"})
    if "expires_at" in payload.model_fields_set:
        changes["expires_at"] = payload.expires_at.isoformat() if payload.expires_at else None
    for key in ("renewal_amount", "renewal_due_date", "source_invoice_id", "payment_instructions", "project_due_date"):
        if key in payload.model_fields_set and getattr(payload, key) is None:
            changes[key] = None
    if payload.content is not None and payload.description is None:
        changes["description"] = payload.content
    try:
        if "client_id" in changes and str(changes["client_id"]) != str(current["client_id"]) and "source_invoice_id" not in changes:
            changes["source_invoice_id"] = None
        if changes.get("source_invoice_id"):
            source = first(gateway.service.table("invoices").select("client_id,status").eq("id", changes["source_invoice_id"]).limit(1).execute(), "Invoice")
            if source["client_id"] != str(changes.get("client_id", current["client_id"])) or source["status"] == "void":
                raise HTTPException(422, "The source invoice must belong to this client and remain active")
        if changes.keys() & {"terms", "amount", "currency", "visiting_fee_lkr", "payment_schedule", "payment_instructions", "project_due_date"}:
            changes["terms"] = scheduled_terms(current | changes)
        if "client_id" in changes:
            client = first(gateway.service.table("clients").select("name,company,email,phone").eq("id", changes["client_id"]).limit(1).execute(), "Client")
            for key, value in {"client_name": client.get("company") or client.get("name"), "client_email": client.get("email"), "client_phone": client.get("phone")}.items():
                changes.setdefault(key, value)
        if changes.keys() & set(DOCUMENT_FIELDS):
            changes["content_sha256"] = _document_digest(current | changes)
            if current.get("status") == "viewed" and "status" not in changes:
                changes.update({"status": "sent", "viewed_at": None})
        if any(key in changes and changes[key] != current.get(key) for key in ("client_id", "client_name", "client_phone", "client_email")):
            # A prior recipient must not retain access to a reassigned document.
            changes.update({"access_token_hash": None, "status": "draft", "sent_at": None, "viewed_at": None})
        if (current | changes).get("status") in {"sent", "viewed"}:
            _ensure_shareable(current | changes)
        if changes:
            updated = rows(gateway.service.table("agreements").update(changes).eq("id", str(agreement_id)).eq("version", current.get("version", 1)).neq("status", "signed").execute())
            if not updated:
                raise HTTPException(status_code=409, detail="This agreement changed. Reload before saving.")
            audit(gateway.service, request, settings, "update", "agreement", agreement_id, principal, {"fields": sorted(changes)})
        return {"agreement": _shape(_agreement_by_id(agreement_id, gateway), settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "update the agreement") from exc


@router.post("/{agreement_id}/share")
def share_agreement(
    agreement_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    current = _agreement_by_id(agreement_id, gateway)
    if current.get("status") == "signed":
        raise HTTPException(status_code=409, detail="The agreement is already signed")
    if current.get("status") == "void":
        raise HTTPException(status_code=409, detail="A void agreement cannot be shared")
    _ensure_shareable(current)
    token = new_public_token()
    changes = {
        "access_token_hash": hash_public_token(token, settings.token_hash_pepper.get_secret_value()),
        "status": "sent",
        "sent_at": utcnow().isoformat(),
        "viewed_at": None,
    }
    try:
        updated = rows(gateway.service.table("agreements").update(changes).eq("id", str(agreement_id)).eq("version", current.get("version", 1)).neq("status", "signed").execute())
        if not updated:
            raise HTTPException(status_code=409, detail="This agreement changed. Reload before sharing.")
        audit(gateway.service, request, settings, "share", "agreement", agreement_id, principal)
        url = _share_url(settings, token)
        return {"share": {"url": url, "share_url": url, "token": token, "version": updated[0].get("version", 1)}}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "create the signing link") from exc


@router.delete("/{agreement_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_or_void_agreement(
    agreement_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    current = _agreement_by_id(agreement_id, gateway)
    try:
        changes = {"deleted_at": utcnow().isoformat()}
        if current.get("status") != "signed":
            changes.update({"status": "void", "access_token_hash": None})
        first(gateway.service.table("agreements").update(changes).eq("id", str(agreement_id)).execute(), "Agreement")
        audit(gateway.service, request, settings, "delete", "agreement", agreement_id, principal,
              {"previous_status": current.get("status"), "evidence_retained": True})
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "remove the agreement") from exc


@router.get("/{agreement_id}/pdf")
def download_agreement_pdf(
    agreement_id: UUID,
    _: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> FastAPIResponse:
    try:
        record = _agreement_by_id(agreement_id, gateway)
        if record.get("status") == "signed" and record.get("signed_pdf_storage_path"):
            content = gateway.service.storage.from_(settings.agreement_pdf_bucket).download(record["signed_pdf_storage_path"])
        else:
            signature_bytes = None
            if record.get("signature_storage_path"):
                signature_bytes = gateway.service.storage.from_(settings.signature_bucket).download(record["signature_storage_path"])
            content = agreement_pdf(record, signature_bytes)
        filename = f"agreement-{record.get('public_id', agreement_id)}.pdf"
        return FastAPIResponse(
            content=content,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "generate the agreement PDF") from exc


@router.get("/{agreement_id}/versions")
def agreement_versions(
    agreement_id: UUID,
    _: Principal = Depends(current_admin),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        _agreement_by_id(agreement_id, gateway)
        versions = rows(
            gateway.service.table("agreement_versions")
            .select("id,agreement_id,version,snapshot,content_sha256,created_by,created_at")
            .eq("agreement_id", str(agreement_id))
            .order("version", desc=True)
            .execute()
        )
        return {"versions": {"items": versions, "total": len(versions)}}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load agreement versions") from exc


@public_router.get("/{token}")
def public_agreement(
    token: str,
    request: Request,
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        record = _agreement_by_token(token, settings, gateway)
        if record.get("status") in {"draft", "void"}:
            raise HTTPException(status_code=404, detail="Agreement not found")
        if record.get("status") == "sent":
            now = utcnow().isoformat()
            gateway.service.table("agreements").update({"status": "viewed", "viewed_at": now}).eq("id", record["id"]).eq("status", "sent").execute()
            record["status"] = "viewed"
            record["viewed_at"] = now
            audit(gateway.service, request, settings, "view", "agreement", record["id"])
        return {"agreement": _public_shape(record, settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the agreement") from exc


@public_router.get("/{token}/pdf")
def public_signed_agreement_pdf(
    token: str,
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> FastAPIResponse:
    try:
        record = _agreement_by_token(token, settings, gateway)
        if record.get("status") != "signed" or not record.get("signed_pdf_storage_path"):
            raise HTTPException(status_code=404, detail="A signed copy is not available")
        content = gateway.service.storage.from_(settings.agreement_pdf_bucket).download(record["signed_pdf_storage_path"])
        return FastAPIResponse(content=content, media_type="application/pdf", headers={
            "Content-Disposition": f'attachment; filename="signed-agreement-{record["public_id"]}.pdf"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        })
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "download the signed agreement") from exc


@public_router.post("/{token}/sign")
def sign_agreement(
    token: str,
    payload: SignAgreementRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    ip = client_ip(request, settings.trust_proxy_headers)
    enforce_rate_limit(f"sign:{ip}:{hash_public_token(token)[:16]}", settings.signing_rate_limit, settings.signing_rate_window_seconds)
    record = _agreement_by_token(token, settings, gateway)
    if record.get("status") == "signed":
        raise HTTPException(status_code=409, detail="This agreement has already been signed")
    if record.get("status") not in {"sent", "viewed"}:
        raise HTTPException(status_code=410, detail="This agreement is no longer available for signing")
    if payload.expected_version != record.get("version", 1) or payload.expected_content_sha256 != record.get("content_sha256"):
        raise HTTPException(status_code=409, detail="This agreement changed. Reload and review the current version before signing.")
    _ensure_shareable(record)

    client = record.get("clients") or {}
    signer_email = str(payload.signer_email or record.get("client_email") or client.get("email") or "") or None
    signature_path: str | None = None
    signed_pdf_path: str | None = None
    signature_type = "typed"
    signature_value = payload.typed_signature or payload.signer_name
    signature_digest = content_sha256(signature_value)
    image: bytes | None = None
    committed = False
    try:
        if payload.signature_data_url:
            image, content_type, extension = _decode_signature(payload.signature_data_url, settings.max_signature_bytes)
            signature_path = f"agreements/{record['id']}/{uuid4().hex}.{extension}"
            gateway.service.storage.from_(settings.signature_bucket).upload(
                path=signature_path,
                file=image,
                file_options={"content-type": content_type, "cache-control": "private, max-age=31536000", "upsert": "false"},
            )
            signature_type = "drawn"
            signature_digest = hashlib.sha256(image).hexdigest()

        signed_at = utcnow()
        signed_snapshot = _document_snapshot(record) | {
            "public_id": record["public_id"],
            "content_sha256": record["content_sha256"],
            "signer_name": payload.signer_name,
            "signer_job_role": payload.signer_job_role,
            "signer_email": signer_email,
            "consent_text": CONSENT_TEXT,
            "consent_accepted": True,
            "signature_type": signature_type,
            "signature_sha256": signature_digest,
            "signed_at": signed_at.isoformat(),
        }
        record_digest = content_sha256(
            json.dumps(signed_snapshot, sort_keys=True, default=str, ensure_ascii=False),
            ip,
            request.headers.get("user-agent", "")[:500],
        )
        changes = {
            "status": "signed",
            "signed_at": signed_at.isoformat(),
            "signer_name": payload.signer_name,
            "signer_job_role": payload.signer_job_role,
            "signer_email": signer_email,
            "signed_snapshot": signed_snapshot,
            "consent_accepted": True,
            "signature_type": signature_type,
            "typed_signature": signature_value if signature_type == "typed" else None,
            "signature_storage_path": signature_path,
            "signature_sha256": signature_digest,
            "signed_record_sha256": record_digest,
            "signer_ip": ip,
            "signer_user_agent": request.headers.get("user-agent", "")[:500] or None,
            "consent_text": CONSENT_TEXT,
        }
        pdf_record = record | changes
        signed_pdf = agreement_pdf(pdf_record, image)
        signed_pdf_digest = hashlib.sha256(signed_pdf).hexdigest()
        signed_pdf_path = f"agreements/{record['id']}/{record_digest}.pdf"
        gateway.service.storage.from_(settings.agreement_pdf_bucket).upload(
            path=signed_pdf_path,
            file=signed_pdf,
            file_options={"content-type": "application/pdf", "cache-control": "private, max-age=31536000", "upsert": "false"},
        )
        changes["signed_pdf_storage_path"] = signed_pdf_path
        changes["signed_pdf_sha256"] = signed_pdf_digest
        updated = rows(
            gateway.service.table("agreements")
            .update(changes)
            .eq("id", record["id"])
            .eq("version", payload.expected_version)
            .eq("content_sha256", payload.expected_content_sha256)
            .eq("access_token_hash", hash_public_token(token, settings.token_hash_pepper.get_secret_value()))
            .in_("status", ["sent", "viewed"])
            .execute()
        )
        if not updated:
            raise HTTPException(status_code=409, detail="The agreement was changed before signing; reload and try again")
        committed = True
        audit(
            gateway.service,
            request,
            settings,
            "sign",
            "agreement",
            record["id"],
            metadata={"signature_type": signature_type, "signed_record_sha256": record_digest},
        )
        return {"agreement": _public_shape(record | changes, settings)}
    except Exception as exc:
        if signature_path and not committed:
            try:
                gateway.service.storage.from_(settings.signature_bucket).remove([signature_path])
            except Exception:
                pass
        if signed_pdf_path and not committed:
            try:
                gateway.service.storage.from_(settings.agreement_pdf_bucket).remove([signed_pdf_path])
            except Exception:
                pass
        if isinstance(exc, HTTPException):
            raise
        if isinstance(exc, ValueError):
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        raise db_failure(exc, "sign the agreement") from exc
