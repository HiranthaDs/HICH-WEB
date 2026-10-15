from __future__ import annotations

from typing import Any, Literal

from fastapi import HTTPException

from .data import first, rows
from .security import utcnow
from .supabase_client import SupabaseGateway


DocumentType = Literal["agreement", "proposal"]


def tracking_schema_missing(exc: Exception, component: Literal["table", "rpc"]) -> bool:
    """Recognize only missing tracking objects, never unrelated database errors."""
    code = getattr(exc, "code", None)
    if component == "table":
        return code == "PGRST205" or (code == "42P01" and "document_open_counts" in str(exc).lower())
    text = str(exc).lower()
    return (
        code == "PGRST202"
        or (code == "42P01" and any(name in text for name in ("document_open_counts", "proposal_open_events")))
        or (code == "42883" and "record_proposal_open" in text)
    )


def mark_agreement_viewed(
    gateway: SupabaseGateway, record: dict[str, Any]
) -> dict[str, Any]:
    """Keep the signing workflow's first-view status without counting visits."""
    if record["status"] != "sent":
        return {"document_status": record["status"], "first_viewed_at": record.get("viewed_at"), "first_opened": False}
    table = "agreements"
    allowed = {"sent", "viewed", "signed", "expired"}

    def current() -> dict[str, Any]:
        latest = first(
            gateway.service.table(table).select("status,viewed_at")
            .eq("id", record["id"])
            .eq("access_token_hash", record["access_token_hash"])
            .is_("deleted_at", "null").limit(1).execute(),
            "Document",
        )
        if latest["status"] not in allowed:
            raise HTTPException(status_code=404, detail="Document not found")
        return latest

    latest = record
    first_opened = False
    if latest["status"] == "sent":
        viewed_at = utcnow().isoformat()
        updated = rows(
            gateway.service.table(table).update({"status": "viewed", "viewed_at": viewed_at})
            .eq("id", record["id"]).eq("access_token_hash", record["access_token_hash"])
            .eq("status", "sent").is_("deleted_at", "null").execute()
        )
        if updated:
            latest = updated[0]
            first_opened = True
        else:
            latest = current()
    return {
        "document_status": latest["status"],
        "first_viewed_at": latest.get("viewed_at"),
        "view_count": None,
        "last_opened_at": None,
        "first_opened": first_opened,
    }


def record_proposal_open(
    gateway: SupabaseGateway, record: dict[str, Any], opening_id: str
) -> dict[str, Any]:
    """Record a displayed proposal once, including when a browser retries."""
    try:
        result = gateway.service.rpc("record_proposal_open", {
            "p_proposal_id": record["id"],
            "p_access_token_hash": record["access_token_hash"],
            "p_opening_id": opening_id,
        }).execute()
    except Exception as exc:
        if not tracking_schema_missing(exc, "rpc"):
            raise
        raise HTTPException(status_code=503, detail="Proposal tracking is not available yet") from exc
    return first(result, "Document")


def attach_open_counts(
    gateway: SupabaseGateway, document_type: DocumentType, records: list[dict[str, Any]]
) -> None:
    """Add counts to an admin result without exposing the counters to public links."""
    if not records:
        return
    ids = [str(record["id"]) for record in records]
    counts: dict[str, dict[str, Any]] = {}
    try:
        # Keep PostgREST filter URLs below common reverse-proxy length limits.
        for start in range(0, len(ids), 100):
            result = rows(
                gateway.service.table("document_open_counts")
                .select("document_id,open_count,last_opened_at")
                .eq("document_type", document_type)
                .in_("document_id", ids[start:start + 100])
                .execute()
            )
            counts.update({str(item["document_id"]): item for item in result})
    except Exception as exc:
        if not tracking_schema_missing(exc, "table"):
            raise
        for record in records:
            record["view_count"] = None
            record["last_opened_at"] = None
        return
    for record in records:
        counter = counts.get(str(record["id"]), {})
        record["view_count"] = int(counter.get("open_count") or 0)
        record["last_opened_at"] = counter.get("last_opened_at")
