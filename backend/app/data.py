from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import HTTPException, Request, status
from supabase import Client

from .config import Settings
from .dependencies import Principal
from .security import client_ip


logger = logging.getLogger(__name__)
T = TypeVar("T")


TRANSIENT_DATABASE_CODES = frozenset({
    "PGRST000", "PGRST001", "PGRST002", "PGRST003",
    "40001", "40P01", "53300", "53400", "57014", "57P01", "57P02", "57P03",
})
TRANSIENT_DATABASE_TEXT = (
    "connection reset", "connection refused", "connection terminated", "connection closed",
    "could not connect", "failed to connect", "server disconnected", "temporarily unavailable",
    "timeout", "timed out", "pool timeout", "too many connections", "bad gateway",
    "service unavailable", "gateway timeout",
)


def database_error_code(exc: Exception) -> str | None:
    code = getattr(exc, "code", None)
    if code:
        return str(code).upper()
    details = exc.args[0] if exc.args else None
    if isinstance(details, dict) and details.get("code"):
        return str(details["code"]).upper()
    return None


def transient_database_error(exc: Exception) -> bool:
    """Identify retryable read failures without retrying validation/data errors."""
    code = database_error_code(exc)
    if code in TRANSIENT_DATABASE_CODES or (code and code.startswith("08")):
        return True
    name = type(exc).__name__.casefold()
    text = str(exc).casefold()
    return any(marker in name for marker in ("timeout", "connecterror", "networkerror")) or any(
        marker in text for marker in TRANSIENT_DATABASE_TEXT
    )


def retry_database_read(operation: Callable[[], T], *, attempts: int = 3, base_delay: float = 0.15) -> T:
    """Retry an idempotent database read only when the failure is transient."""
    if attempts < 1:
        raise ValueError("attempts must be positive")
    for attempt in range(attempts):
        try:
            return operation()
        except Exception as exc:
            if attempt + 1 >= attempts or not transient_database_error(exc):
                raise
            logger.warning("Transient database read failed (attempt %s/%s): %s", attempt + 1, attempts, exc)
            if base_delay > 0:
                time.sleep(base_delay * (2 ** attempt))
    raise RuntimeError("unreachable")


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
