from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from ..data import db_failure, rows
from ..dependencies import Principal, current_admin
from ..supabase_client import SupabaseGateway, get_supabase


router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("")
def list_audit_events(
    action: str | None = Query(default=None, max_length=100),
    entity_type: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _: Principal = Depends(current_admin),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        query = gateway.service.table("audit_logs").select("*,profiles(email,full_name)").order("created_at", desc=True)
        if action:
            query = query.eq("action", action)
        if entity_type:
            query = query.eq("entity_type", entity_type)
        result = rows(query.range(offset, offset + limit - 1).execute())
        for item in result:
            profile = item.pop("profiles", None) or {}
            item["actor"] = profile.get("full_name") or profile.get("email") or "System/Public"
            item["actor_email"] = profile.get("email")
            item["target"] = f"{item.get('entity_type')}: {item.get('entity_id') or 'n/a'}"
            item["details"] = item.get("metadata", {}).get("description") if isinstance(item.get("metadata"), dict) else None
        return {"events": {"items": result, "total": len(result)}}
    except Exception as exc:
        raise db_failure(exc, "load the audit log") from exc

