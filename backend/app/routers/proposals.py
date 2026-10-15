from __future__ import annotations

import hmac
import secrets
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel

from ..config import Settings, get_settings
from ..data import audit, db_failure, first, rows
from ..dependencies import Principal, current_admin, require_deletion_pin
from ..document_views import attach_open_counts, record_proposal_open
from ..models import ProposalCreate, ProposalShareRequest, ProposalUpdate, json_ready
from ..security import content_sha256, stable_public_token, stable_public_token_hash, utcnow
from ..supabase_client import SupabaseGateway, get_supabase


router = APIRouter(prefix="/proposals", tags=["proposals"])
public_router = APIRouter(prefix="/public/proposals", tags=["public"])

PROPOSAL_SELECT = "*,clients(id,name,company,email,phone,address,status)"
PROPOSAL_LIST_SELECT = "id,public_id,client_id,client_name,client_email,client_phone,reference,title,status,version,access_token_hash,share_nonce,sent_at,viewed_at,created_at,updated_at,clients(id,name,company,email,phone,address,status)"
PROPOSAL_PUBLIC_SELECT = "id,public_id,reference,title,html_content,status,version,client_name,created_at,sent_at,viewed_at,clients(name)"
DOCUMENT_FIELDS = {"client_id", "reference", "title", "html_content"}


def _proposal_reference() -> str:
    return f"PROP-{100000 + secrets.randbelow(900000)}"


def _proposal_token(public_id: str, nonce: str) -> str:
    return stable_public_token(public_id, nonce)


def _token_hash(token: str) -> str:
    return stable_public_token_hash("proposal", token)


def _share_url(settings: Settings, token: str) -> str:
    return f"{str(settings.public_app_url).rstrip('/')}/proposal/{quote(token, safe='')}"


def _recover_token(record: dict[str, Any]) -> str | None:
    if not record.get("share_nonce") or not record.get("access_token_hash"):
        return None
    candidate = _proposal_token(str(record["public_id"]), str(record["share_nonce"]))
    return candidate if hmac.compare_digest(_token_hash(candidate), str(record["access_token_hash"])) else None


def _shape(record: dict[str, Any], settings: Settings, token: str | None = None) -> dict[str, Any]:
    client = record.get("clients") or {}
    shaped = record | {
        # Admin views follow the linked CRM record so client edits appear
        # everywhere consistently. Stored values remain a delivery snapshot.
        "client_name": client.get("name") or record.get("client_name"),
        "client_company": client.get("company"),
        "client_email": client.get("email") or record.get("client_email"),
        "client_phone": client.get("phone") or record.get("client_phone"),
        "client_address": client.get("address"),
        "client": client,
        "version": record.get("version", 1),
    }
    recovered = token or (_recover_token(record) if record.get("status") in {"sent", "viewed"} else None)
    if recovered:
        shaped["share_url"] = _share_url(settings, recovered)
    shaped.pop("access_token_hash", None)
    shaped.pop("share_nonce", None)
    return shaped


def _public_shape(record: dict[str, Any]) -> dict[str, Any]:
    client = record.get("clients") or {}
    return {
        "id": str(record.get("public_id") or record.get("id")),
        "reference": record.get("reference"),
        "title": record.get("title"),
        "html_content": record.get("html_content"),
        "status": record.get("status"),
        "version": record.get("version", 1),
        "client_name": client.get("name") or record.get("client_name"),
        "created_at": record.get("created_at"),
        "sent_at": record.get("sent_at"),
        "viewed_at": record.get("viewed_at"),
    }


def _proposal_by_id(proposal_id: UUID, gateway: SupabaseGateway) -> dict[str, Any]:
    record = first(
        gateway.service.table("proposals").select(PROPOSAL_SELECT).is_("deleted_at", "null")
        .eq("id", str(proposal_id)).limit(1).execute(),
        "Proposal",
    )
    attach_open_counts(gateway, "proposal", [record])
    return record


def _proposal_by_token(token: str, gateway: SupabaseGateway) -> dict[str, Any]:
    if len(token) < 32 or len(token) > 200:
        raise HTTPException(status_code=404, detail="Proposal not found")
    return first(
        gateway.service.table("proposals").select(PROPOSAL_PUBLIC_SELECT).eq("access_token_hash", _token_hash(token))
        .is_("deleted_at", "null").in_("status", ["sent", "viewed"]).limit(1).execute(),
        "Proposal",
    )


def _client_snapshot(client_id: UUID, gateway: SupabaseGateway) -> dict[str, Any]:
    client = first(
        gateway.service.table("clients").select("id,name,company,email,phone,address").is_("deleted_at", "null")
        .eq("id", str(client_id)).limit(1).execute(),
        "Client",
    )
    return {
        "client_id": str(client_id),
        "client_name": client.get("name"),
        "client_email": client.get("email"),
        "client_phone": client.get("phone"),
    }


@router.get("")
def list_proposals(
    proposal_status: str | None = Query(default=None, alias="status", max_length=30),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        # HTML documents can be up to 2 MB. Keep the library fast by loading
        # source only when an administrator opens the editor or preview.
        query = gateway.service.table("proposals").select(PROPOSAL_LIST_SELECT).is_("deleted_at", "null").order("created_at", desc=True).order("id")
        if proposal_status:
            query = query.eq("status", proposal_status)
        result = rows(query.range(offset, offset + limit - 1).execute())
        attach_open_counts(gateway, "proposal", result)
        items = [_shape(item, settings) for item in result]
        return {"proposals": {"items": items, "total": len(items)}}
    except Exception as exc:
        raise db_failure(exc, "load proposals") from exc


@router.post("", status_code=status.HTTP_201_CREATED)
def create_proposal(
    payload: ProposalCreate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        snapshot = _client_snapshot(payload.client_id, gateway)
        record = json_ready(payload) | snapshot | {
            "reference": payload.reference or _proposal_reference(),
            "public_id": str(uuid4()),
            "content_sha256": content_sha256(payload.html_content),
            "created_by": str(principal.id),
            "status": "draft",
        }
        created = first(gateway.service.table("proposals").insert(record).execute(), "Proposal")
        audit(gateway.service, request, settings, "create", "proposal", created["id"], principal)
        return {"proposal": _shape(_proposal_by_id(UUID(created["id"]), gateway), settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "create the proposal") from exc


@router.get("/{proposal_id}")
def get_proposal(
    proposal_id: UUID,
    _: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        return {"proposal": _shape(_proposal_by_id(proposal_id, gateway), settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the proposal") from exc


@router.put("/{proposal_id}")
@router.patch("/{proposal_id}")
def update_proposal(
    proposal_id: UUID,
    payload: ProposalUpdate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    current = _proposal_by_id(proposal_id, gateway)
    if payload.expected_version is not None and payload.expected_version != current.get("version", 1):
        raise HTTPException(status_code=409, detail="This proposal changed. Reload before saving.")
    for field in ("client_id", "reference", "title", "html_content"):
        if field in payload.model_fields_set and getattr(payload, field) is None:
            raise HTTPException(status_code=422, detail=f"{field.replace('_', ' ').capitalize()} cannot be blank")
    changes = json_ready(payload, exclude_unset=True, exclude={"expected_version"})
    try:
        client_changed = "client_id" in changes and str(changes["client_id"]) != str(current["client_id"])
        for field in DOCUMENT_FIELDS:
            if field in changes and changes[field] == current.get(field):
                changes.pop(field)
        if client_changed:
            changes.update(_client_snapshot(UUID(str(changes["client_id"])), gateway))
            changes.update({"access_token_hash": None, "share_nonce": None, "status": "draft", "sent_at": None, "viewed_at": None})
        if "html_content" in changes:
            changes["content_sha256"] = content_sha256(changes["html_content"])
        if changes.keys() & DOCUMENT_FIELDS:
            changes["version"] = int(current.get("version", 1)) + 1
            if not client_changed and current.get("status") in {"sent", "viewed"}:
                changes.update({"status": "sent", "viewed_at": None})
        if changes:
            updated = rows(
                gateway.service.table("proposals").update(changes).eq("id", str(proposal_id))
                .eq("version", current.get("version", 1)).is_("deleted_at", "null").execute()
            )
            if not updated:
                raise HTTPException(status_code=409, detail="This proposal changed. Reload before saving.")
            audit(gateway.service, request, settings, "update", "proposal", proposal_id, principal, {"fields": sorted(changes)})
        return {"proposal": _shape(_proposal_by_id(proposal_id, gateway), settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "update the proposal") from exc


@router.post("/{proposal_id}/share")
def share_proposal(
    proposal_id: UUID,
    request: Request,
    payload: ProposalShareRequest | None = None,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    current = _proposal_by_id(proposal_id, gateway)
    options = payload or ProposalShareRequest()
    token = None if options.rotate else _recover_token(current)
    if token is not None:
        # Copying or re-sending a stable link must not erase the fact that the
        # client already viewed it or rewrite the original delivery time.
        audit(gateway.service, request, settings, "share", "proposal", proposal_id, principal)
        url = _share_url(settings, token)
        return {"share": {"url": url, "share_url": url, "token": token}}
    nonce = str(uuid4())
    token = _proposal_token(str(current["public_id"]), nonce)
    changes = {
        "share_nonce": nonce,
        "access_token_hash": _token_hash(token),
        "status": "sent",
        "sent_at": utcnow().isoformat(),
        "viewed_at": None,
    }
    try:
        query = gateway.service.table("proposals").update(changes).eq("id", str(proposal_id)).eq("version", current.get("version", 1)).is_("deleted_at", "null")
        query = query.eq("access_token_hash", current["access_token_hash"]) if current.get("access_token_hash") else query.is_("access_token_hash", "null")
        updated = rows(query.execute())
        if not updated:
            latest = _proposal_by_id(proposal_id, gateway)
            recovered = _recover_token(latest) if not options.rotate and latest.get("version") == current.get("version") else None
            if recovered:
                url = _share_url(settings, recovered)
                return {"share": {"url": url, "share_url": url, "token": recovered}}
            raise HTTPException(status_code=409, detail="This proposal changed. Reload before sharing.")
        audit(gateway.service, request, settings, "share_rotated" if options.rotate else "share", "proposal", proposal_id, principal)
        url = _share_url(settings, token)
        return {"share": {"url": url, "share_url": url, "token": token}}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "create the proposal link") from exc


@router.delete("/{proposal_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_proposal(
    proposal_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    require_deletion_pin(request, settings, principal)
    try:
        first(
            gateway.service.table("proposals").update({
                "status": "archived",
                "deleted_at": utcnow().isoformat(),
                "access_token_hash": None,
                "share_nonce": None,
            }).eq("id", str(proposal_id)).is_("deleted_at", "null").execute(),
            "Proposal",
        )
        audit(gateway.service, request, settings, "delete", "proposal", proposal_id, principal)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "remove the proposal") from exc


@public_router.get("/{token}")
def public_proposal(
    token: str,
    request: Request,
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        record = _proposal_by_token(token, gateway)
        return {"proposal": _public_shape(record)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the proposal") from exc


class ProposalOpenRequest(BaseModel):
    opening_id: UUID


@public_router.post("/{token}/open", status_code=status.HTTP_204_NO_CONTENT)
def open_proposal(
    token: str,
    payload: ProposalOpenRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    try:
        if len(token) < 32 or len(token) > 200:
            raise HTTPException(status_code=404, detail="Proposal not found")
        # The document body is unnecessary here; the RPC rechecks the token
        # under a row lock before updating status and counters atomically.
        record = first(
            gateway.service.table("proposals").select("id,access_token_hash")
            .eq("access_token_hash", _token_hash(token)).is_("deleted_at", "null")
            .in_("status", ["sent", "viewed"]).limit(1).execute(), "Proposal",
        )
        opened = record_proposal_open(gateway, record, str(payload.opening_id))
        if opened["first_opened"]:
            audit(gateway.service, request, settings, "view", "proposal", record["id"])
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "record the proposal open") from exc
