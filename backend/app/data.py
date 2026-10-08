from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException, Request, status
from supabase import Client

from .config import Settings
from .dependencies import Principal
from .security import client_ip


logger = logging.getLogger(__name__)


def rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None)
    return data if isinstance(data, list) else []


def first(response: Any, label: str = "Resource") -> dict[str, Any]:
    data = rows(response)
    if not data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{label} not found")
    return data[0]


def db_failure(exc: Exception, operation: str = "complete the database operation") -> HTTPException:
    logger.exception("Supabase operation failed: %s", operation)
    text = str(exc).lower()
    if "duplicate key" in text or "23505" in text or "already exists" in text:
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A record with that value already exists")
    if "foreign key" in text or "23503" in text:
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A referenced record does not exist")
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Could not {operation}")


def audit(
    db: Client,
    request: Request,
    settings: Settings,
    action: str,
    entity_type: str,
    entity_id: object | None = None,
    actor: Principal | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    record = {
        "actor_user_id": str(actor.id) if actor else None,
        "action": action,
        "entity_type": entity_type,
        "entity_id": str(entity_id) if entity_id is not None else None,
        "request_id": getattr(request.state, "request_id", None),
        "ip_address": client_ip(request, settings.trust_proxy_headers),
        "user_agent": request.headers.get("user-agent", "")[:500] or None,
        "metadata": metadata or {},
    }
    try:
        db.table("audit_logs").insert(record).execute()
    except Exception:
        # Business operations should remain available if only audit insertion is degraded.
        logger.exception("Audit log insertion failed for %s %s", entity_type, action)
