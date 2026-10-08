from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field, model_validator

from ..config import Settings, get_settings
from ..data import audit, db_failure, first, rows
from ..dependencies import Principal, current_admin
from ..models import APIModel, json_ready
from ..security import client_ip, hash_public_token, new_public_token, enforce_rate_limit
from ..supabase_client import SupabaseGateway, get_supabase
from .portfolio import PUBLIC_PROJECT_SELECT, _enrich_project

router = APIRouter(tags=["operations"])
public_router = APIRouter(prefix="/public", tags=["public"])


class TaskCreate(APIModel):
    title: str = Field(min_length=2, max_length=240)
    due_date: date | None = None
    priority: Literal["low", "normal", "high"] = "normal"
    status: Literal["open", "done"] = "open"
    client_id: UUID | None = None
    notes: str | None = Field(default=None, max_length=5000)


class TaskUpdate(APIModel):
    title: str | None = Field(default=None, min_length=2, max_length=240)
    due_date: date | None = None
    priority: Literal["low", "normal", "high"] | None = None
    status: Literal["open", "done"] | None = None
    client_id: UUID | None = None
    notes: str | None = Field(default=None, max_length=5000)


class ChangeCreate(APIModel):
    agreement_id: UUID
    title: str = Field(min_length=2, max_length=240)
    description: str = Field(min_length=20, max_length=20000)
    amount: Decimal = Field(ge=0, max_digits=14, decimal_places=2)
    currency: str = Field(default="LKR", pattern=r"^[A-Z]{3}$")
    extra_days: int = Field(default=0, ge=0, le=3650)


class ChangeApproval(APIModel):
    signer_name: str = Field(min_length=2, max_length=160)
    signer_job_role: str = Field(min_length=2, max_length=160)
    consent: bool

    @model_validator(mode="after")
    def require_consent(self):
        if not self.consent:
            raise ValueError("Explicit acceptance is required")
        return self


class CollectionCreate(APIModel):
    title: str = Field(min_length=2, max_length=240)
    description: str | None = Field(default=None, max_length=2000)
    category: str | None = Field(default=None, max_length=120)
    project_ids: list[UUID] = Field(min_length=1, max_length=100)


def change_public(record: dict[str, Any]) -> dict[str, Any]:
    return {key: record.get(key) for key in ("id", "title", "description", "amount", "currency", "extra_days", "status", "project_title", "reference", "approved_at", "signer_name", "signer_job_role", "created_at")}


def collection_shape(record: dict[str, Any], settings: Settings) -> dict[str, Any]:
    return record | {"share_url": f"{str(settings.public_app_url).rstrip('/')}/collection/{record['public_id']}"}


@router.get("/operations/tasks")
def tasks(_: Principal = Depends(current_admin), gateway: SupabaseGateway = Depends(get_supabase)):
    try:
        return {"tasks": rows(gateway.service.table("operation_tasks").select("*,clients(name)").order("created_at", desc=True).limit(500).execute())}
    except Exception as exc:
        raise db_failure(exc, "load follow-ups") from exc


@router.post("/operations/tasks", status_code=201)
def create_task(payload: TaskCreate, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    try:
        record = first(gateway.service.table("operation_tasks").insert(json_ready(payload) | {"created_by": str(principal.id)}).execute())
        audit(gateway.service, request, settings, "create", "follow_up", record["id"], principal)
        return {"task": record}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "save follow-up") from exc


@router.patch("/operations/tasks/{task_id}")
def update_task(task_id: UUID, payload: TaskUpdate, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    try:
        changes = json_ready(payload, exclude_unset=True)
        for key in {"due_date", "client_id", "notes"} & payload.model_fields_set:
            if getattr(payload, key) is None:
                changes[key] = None
        record = first(gateway.service.table("operation_tasks").update(changes).eq("id", str(task_id)).execute())
        audit(gateway.service, request, settings, payload.status or "update", "follow_up", task_id, principal)
        return {"task": record}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "update follow-up") from exc


@router.delete("/operations/tasks/{task_id}")
def delete_task(task_id: UUID, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    try:
        first(gateway.service.table("operation_tasks").delete().eq("id", str(task_id)).execute(), "Follow-up")
        audit(gateway.service, request, settings, "delete", "follow_up", task_id, principal)
        return {"message": "Follow-up deleted"}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "delete follow-up") from exc


@router.get("/operations/changes")
def changes(_: Principal = Depends(current_admin), gateway: SupabaseGateway = Depends(get_supabase)):
    try:
        return {"changes": rows(gateway.service.table("change_orders").select("id,agreement_id,title,description,amount,currency,extra_days,status,project_title,reference,approved_at,signer_name,signer_job_role,created_at").order("created_at", desc=True).limit(500).execute())}
    except Exception as exc:
        raise db_failure(exc, "load scope changes") from exc


@router.post("/operations/changes", status_code=201)
def create_change(payload: ChangeCreate, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    try:
        agreement = first(gateway.service.table("agreements").select("id,status,currency,project_title,public_id").eq("id", str(payload.agreement_id)).execute(), "Agreement")
        if agreement["status"] != "signed":
            raise HTTPException(422, "Scope changes require a signed base agreement")
        if payload.currency != agreement["currency"]:
            raise HTTPException(422, "Use the base agreement currency")
        record = first(gateway.service.table("change_orders").insert(json_ready(payload) | {"created_by": str(principal.id), "project_title": agreement.get("project_title"), "reference": f"CHG-{new_public_token()[:8].upper()}"}).execute())
        audit(gateway.service, request, settings, "create", "scope_change", record["id"], principal)
        return {"change": change_public(record) | {"agreement_id": record["agreement_id"]}}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "create scope change") from exc


@router.post("/operations/changes/{change_id}/share")
def share_change(change_id: UUID, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    token = new_public_token()
    try:
        updated = rows(gateway.service.table("change_orders").update({"access_token_hash": hash_public_token(token, settings.token_hash_pepper.get_secret_value()), "status": "sent"}).eq("id", str(change_id)).in_("status", ["draft", "sent"]).execute())
        if not updated:
            raise HTTPException(409, "Only pending changes can be shared")
        audit(gateway.service, request, settings, "share", "scope_change", change_id, principal)
        return {"share_url": f"{str(settings.public_app_url).rstrip('/')}/change/{token}"}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "share scope change") from exc


@router.put("/operations/changes/{change_id}")
def update_change(change_id: UUID, payload: ChangeCreate, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    try:
        agreement = first(gateway.service.table("agreements").select("status,currency,project_title").eq("id", str(payload.agreement_id)).limit(1).execute(), "Agreement")
        if agreement["status"] != "signed" or payload.currency != agreement["currency"]:
            raise HTTPException(422, "Use a signed base agreement and its currency")
        saved = rows(gateway.service.table("change_orders").update(json_ready(payload) | {"project_title": agreement.get("project_title"), "status": "draft", "access_token_hash": None}).eq("id", str(change_id)).in_("status", ["draft", "sent"]).execute())
        if not saved:
            raise HTTPException(409, "Only unapproved scope changes can be edited. Approved changes are retained as signed records.")
        audit(gateway.service, request, settings, "update", "scope_change", change_id, principal)
        return {"change": change_public(saved[0]) | {"agreement_id": saved[0]["agreement_id"]}}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "update the scope change") from exc


@router.post("/operations/changes/{change_id}/void")
def void_change(change_id: UUID, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    try:
        record = rows(gateway.service.table("change_orders").update({"status": "void", "access_token_hash": None}).eq("id", str(change_id)).in_("status", ["draft", "sent"]).execute())
        if not record:
            raise HTTPException(409, "Approved changes cannot be voided")
        audit(gateway.service, request, settings, "void", "scope_change", change_id, principal)
        return {"message": "Scope change voided"}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "void scope change") from exc


def find_change(token: str, gateway: SupabaseGateway, settings: Settings):
    if len(token) != 43:
        raise HTTPException(404, "Change approval link not found")
    return first(gateway.service.table("change_orders").select("*").eq("access_token_hash", hash_public_token(token, settings.token_hash_pepper.get_secret_value())).in_("status", ["sent", "approved"]).limit(1).execute(), "Change approval link")


@public_router.get("/changes/{token}")
def public_change(token: str, request: Request, gateway: SupabaseGateway = Depends(get_supabase), settings: Settings = Depends(get_settings)):
    enforce_rate_limit(f"change-read:{client_ip(request, settings.trust_proxy_headers)}", 120, 60)
    try:
        return {"change": change_public(find_change(token, gateway, settings))}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load scope change") from exc


@public_router.post("/changes/{token}/approve")
def approve_change(token: str, payload: ChangeApproval, request: Request, gateway: SupabaseGateway = Depends(get_supabase), settings: Settings = Depends(get_settings)):
    enforce_rate_limit(f"change-approve:{client_ip(request, settings.trust_proxy_headers)}", settings.signing_rate_limit, settings.signing_rate_window_seconds)
    try:
        record = find_change(token, gateway, settings)
        patch = json_ready(payload) | {"status": "approved", "approved_at": datetime.now(timezone.utc).isoformat(), "signer_ip": client_ip(request, settings.trust_proxy_headers), "signer_user_agent": request.headers.get("user-agent", "")[:500], "consent_text": "I am authorised to approve this additional scope, fee and schedule extension."}
        result = rows(gateway.service.table("change_orders").update(patch).eq("id", record["id"]).eq("status", "sent").eq("access_token_hash", record["access_token_hash"]).execute())
        if not result:
            raise HTTPException(409, "This approval has already been recorded or withdrawn")
        audit(gateway.service, request, settings, "approve", "scope_change", record["id"])
        return {"change": change_public(result[0])}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "record scope approval") from exc


@router.get("/collections")
def collections(_: Principal = Depends(current_admin), gateway: SupabaseGateway = Depends(get_supabase), settings: Settings = Depends(get_settings)):
    try:
        return {"collections": [collection_shape(record, settings) for record in rows(gateway.service.table("portfolio_collections").select("*").order("created_at", desc=True).limit(500).execute())]}
    except Exception as exc:
        raise db_failure(exc, "load collections") from exc


@router.post("/collections", status_code=201)
def create_collection(payload: CollectionCreate, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    ids = list(dict.fromkeys(str(value) for value in payload.project_ids))
    try:
        projects = rows(gateway.service.table("portfolio_projects").select("id").eq("published", True).in_("id", ids).execute())
        if len(projects) != len(ids):
            raise HTTPException(422, "Collections can only contain published completed projects")
        record = first(gateway.service.table("portfolio_collections").insert(json_ready(payload) | {"project_ids": ids, "created_by": str(principal.id)}).execute())
        audit(gateway.service, request, settings, "create", "portfolio_collection", record["id"], principal)
        return {"collection": collection_shape(record, settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "save project collection") from exc


@router.put("/collections/{collection_id}")
def update_collection(collection_id: UUID, payload: CollectionCreate, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    ids = list(dict.fromkeys(str(value) for value in payload.project_ids))
    try:
        projects = rows(gateway.service.table("portfolio_projects").select("id").eq("published", True).in_("id", ids).execute())
        if len(projects) != len(ids):
            raise HTTPException(422, "Collections can only contain published completed projects")
        record = first(gateway.service.table("portfolio_collections").update(json_ready(payload) | {"project_ids": ids}).eq("id", str(collection_id)).execute(), "Collection")
        audit(gateway.service, request, settings, "update", "portfolio_collection", collection_id, principal)
        return {"collection": collection_shape(record, settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "update the project collection") from exc


@router.delete("/collections/{collection_id}")
def remove_collection(collection_id: UUID, request: Request, principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    try:
        first(gateway.service.table("portfolio_collections").delete().eq("id", str(collection_id)).execute(), "Collection")
        audit(gateway.service, request, settings, "delete", "portfolio_collection", collection_id, principal)
        return {"message": "Collection link removed"}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "remove collection") from exc


@public_router.get("/collections/{public_id}")
def public_collection(public_id: UUID, gateway: SupabaseGateway = Depends(get_supabase), settings: Settings = Depends(get_settings)):
    try:
        record = first(gateway.service.table("portfolio_collections").select("public_id,title,description,category,project_ids").eq("public_id", str(public_id)).execute(), "Collection")
        projects = rows(gateway.service.table("portfolio_projects").select(PUBLIC_PROJECT_SELECT).eq("published", True).in_("id", record["project_ids"]).execute())
        ordering = {value: index for index, value in enumerate(record["project_ids"])}
        projects.sort(key=lambda project: ordering.get(project["id"], 0))
        return {"collection": {key: record.get(key) for key in ("title", "description", "category")}, "projects": [_enrich_project(project, gateway, settings) for project in projects]}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load project collection") from exc
