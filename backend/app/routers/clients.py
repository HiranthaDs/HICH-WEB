from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from ..config import Settings, get_settings
from ..data import audit, db_failure, first, rows
from ..dependencies import Principal, current_admin, require_deletion_pin
from ..models import ClientCreate, ClientUpdate, json_ready
from ..supabase_client import SupabaseGateway, get_supabase


router = APIRouter(prefix="/clients", tags=["clients"])


@router.get("")
def list_clients(
    q: str | None = Query(default=None, max_length=100),
    client_status: str | None = Query(default=None, alias="status", max_length=30),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _: Principal = Depends(current_admin),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        query = gateway.service.table("clients").select("*").is_("deleted_at", "null").order("created_at", desc=True).order("id")
        if q:
            query = query.or_(f"name.ilike.%{q}%,company.ilike.%{q}%,email.ilike.%{q}%")
        if client_status:
            query = query.eq("status", client_status)
        result = rows(query.range(offset, offset + limit - 1).execute())
        client_ids = {str(item.get("id")) for item in result}
        invoice_rows: list[dict[str, Any]] = []
        if client_ids:
            while True:
                batch = rows(
                    gateway.service.table("invoices")
                    .select("id,client_id,project_value,currency,status,invoice_kind,updated_at")
                    .in_("client_id", list(client_ids)).neq("status", "void").order("id")
                    .range(len(invoice_rows), len(invoice_rows) + 499).execute()
                )
                invoice_rows.extend(batch)
                if len(batch) < 500:
                    break
        counts: dict[str, int] = defaultdict(int)
        totals: dict[str, Decimal] = defaultdict(Decimal)
        totals_by_currency: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
        latest: dict[str, str] = {}
        for invoice in invoice_rows:
            client_id = str(invoice.get("client_id") or "")
            if client_id not in client_ids:
                continue
            updated_at = str(invoice.get("updated_at") or "")
            if updated_at > latest.get(client_id, ""):
                latest[client_id] = updated_at
            # A renewal bill is a separate financial document for an existing
            # project, not another project or another copy of its lifetime value.
            if (invoice.get("invoice_kind") or "project") != "project":
                continue
            counts[client_id] += 1
            try:
                value = Decimal(str(invoice.get("project_value") or 0))
                currency = invoice.get("currency") or "LKR"
                totals_by_currency[client_id][currency] += value
                if currency == "LKR":
                    totals[client_id] += Decimal(str(invoice.get("project_value") or 0))
            except (InvalidOperation, TypeError, ValueError):
                pass
        items = [
            item | {
                "project_count": counts[str(item.get("id"))],
                "total_value": float(totals[str(item.get("id"))]),
                "totals_by_currency": {currency: float(value) for currency, value in totals_by_currency[str(item.get("id"))].items()},
                "last_activity": latest.get(str(item.get("id"))) or item.get("updated_at"),
            }
            for item in result
        ]
        return {"clients": {"items": items, "total": len(items)}}
    except Exception as exc:
        raise db_failure(exc, "load clients") from exc


@router.post("", status_code=status.HTTP_201_CREATED)
def create_client(
    payload: ClientCreate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    record = json_ready(payload) | {"created_by": str(principal.id)}
    try:
        created = first(gateway.service.table("clients").insert(record).execute(), "Client")
        audit(gateway.service, request, settings, "create", "client", created["id"], principal)
        return {"client": created}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "create the client") from exc


@router.get("/{client_id}")
def get_client(
    client_id: UUID,
    _: Principal = Depends(current_admin),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        record = first(gateway.service.table("clients").select("*").is_("deleted_at", "null").eq("id", str(client_id)).limit(1).execute(), "Client")
        return {"client": record}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the client") from exc


@router.get("/{client_id}/profile")
def get_client_profile(
    client_id: UUID,
    _: Principal = Depends(current_admin),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    """Return the complete, client-scoped document history for the admin profile."""
    from .invoices import INVOICE_SELECT, _shape as invoice_shape

    def documents(table: str, select: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        while True:
            batch = rows(gateway.service.table(table).select(select).is_("deleted_at", "null").eq("client_id", str(client_id))
                         .order("created_at", desc=True).order("id")
                         .range(len(result), len(result) + 499).execute())
            result.extend(batch)
            if len(batch) < 500:
                return result

    try:
        client = first(gateway.service.table("clients").select("*").is_("deleted_at", "null").eq("id", str(client_id)).limit(1).execute(), "Client")
        invoices = [invoice_shape(record) for record in documents("invoices", INVOICE_SELECT)]
        agreements = documents("agreements", "id,client_id,reference,title,project_title,status,amount,currency,renewal_amount,renewal_currency,renewal_due_date,created_at,updated_at,sent_at,signed_at,signer_name,signer_job_role,expires_at,version")
        return {"profile": {"client": client, "invoices": invoices, "agreements": agreements}}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the client profile") from exc


@router.put("/{client_id}")
@router.patch("/{client_id}")
def update_client(
    client_id: UUID,
    payload: ClientUpdate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    changes = json_ready(payload, exclude_unset=True)
    if changes.get("status") == "archived":
        current = first(gateway.service.table("clients").select("status").eq("id", str(client_id)).limit(1).execute(), "Client")
        if current.get("status") != "archived":
            require_deletion_pin(request, settings, principal)
    if not changes:
        return get_client(client_id, principal, gateway)
    try:
        updated = first(gateway.service.table("clients").update(changes).eq("id", str(client_id)).is_("deleted_at", "null").execute(), "Client")
        audit(gateway.service, request, settings, "update", "client", client_id, principal, {"fields": sorted(changes)})
        return {"client": updated}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "update the client") from exc


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_client(
    client_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    try:
        first(gateway.service.table("clients").update({"status": "archived", "deleted_at": datetime.now(timezone.utc).isoformat()}).eq("id", str(client_id)).execute(), "Client")
        audit(gateway.service, request, settings, "delete", "client", client_id, principal)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "archive the client") from exc
