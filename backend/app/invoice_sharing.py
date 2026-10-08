"""Invoice publication models and the explicit boundary for client-visible data."""

from __future__ import annotations

import base64
import hashlib
import hmac
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .config import Settings
from .models import InvoiceCreate, InvoiceUpdate
from .security import hash_public_token


class InvoiceDocumentCreate(InvoiceCreate):
    payment_instructions: str | None = Field(default=None, max_length=5000)
    customer_note: str | None = Field(default=None, max_length=5000)

    @model_validator(mode="after")
    def one_line_item_format(self) -> "InvoiceDocumentCreate":
        if self.payments and self.milestones:
            raise ValueError("Use payment phases or milestones, not both")
        if self.milestones and sum((item.amount for item in self.milestones), Decimal()) != self.project_value:
            raise ValueError("Milestones must add up to the project value")
        return self


class InvoiceDocumentUpdate(InvoiceUpdate):
    payment_instructions: str | None = Field(default=None, max_length=5000)
    customer_note: str | None = Field(default=None, max_length=5000)
    expected_revision: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def one_line_item_format(self) -> "InvoiceDocumentUpdate":
        if self.payments is not None and self.milestones is not None:
            raise ValueError("Use payment phases or milestones, not both")
        return self


class InvoiceShareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rotate: bool = False
    expires_at: datetime | None = None

    @field_validator("expires_at")
    @classmethod
    def future_expiry(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        value = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
        if value <= datetime.now(timezone.utc):
            raise ValueError("Link expiry must be in the future")
        return value


def invoice_token(invoice_id: str, nonce: str, settings: Settings) -> str:
    """Recreate a stable, unguessable link without storing its bearer token."""
    key = settings.token_hash_pepper.get_secret_value() or settings.supabase_secret_key.get_secret_value()
    digest = hmac.new(key.encode(), f"hich-invoice-v1:{invoice_id}:{nonce}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def invoice_token_hash(token: str, settings: Settings) -> str:
    return hash_public_token(f"invoice:{token}", settings.token_hash_pepper.get_secret_value())


def public_invoice_shape(record: dict[str, Any]) -> dict[str, Any]:
    """Never pass through invoice, client, milestone, or payment dictionaries."""
    fields = (
        "invoice_number", "reference", "project_title", "project_value", "amount", "currency",
        "issue_date", "due_date", "renewal_amount", "renewal_currency", "renewal_due_date",
        "status", "paid_amount", "payment_method", "payment_instructions", "customer_note",
        "revision", "created_at", "updated_at",
    )
    public = {key: record.get(key) for key in fields}
    client = record.get("clients") or {}
    public["client"] = {key: client.get(key) for key in ("name", "company", "phone")}
    public["client_name"] = client.get("company") or client.get("name") or record.get("client_name")
    public["phone"] = client.get("phone") or record.get("phone")
    public["balance_due"] = str(max(Decimal(0), Decimal(str(record.get("project_value") or 0)) - Decimal(str(record.get("paid_amount") or 0))))
    public["milestones"] = [
        {key: item.get(key) for key in ("title", "description", "amount", "due_date", "status", "position")}
        for item in record.get("milestones", [])
    ]
    public["payments"] = [
        {key: item.get(key) for key in ("name", "amount", "status", "is_paid", "paid_at")}
        for item in record.get("payments", [])
    ]
    public["payment_records"] = [
        {key: item.get(key) for key in ("amount", "currency", "method", "paid_at")}
        for item in record.get("payment_records", [])
    ]
    return public
