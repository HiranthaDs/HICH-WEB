"""Invoice publication models and the explicit boundary for client-visible data."""

from __future__ import annotations

import base64
import hashlib
import hmac
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .config import Settings
from .models import InvoiceCreate, InvoiceUpdate
from .security import hash_public_token, is_stable_public_token, stable_public_token, stable_public_token_hash

DEFAULT_PAYMENT_INSTRUCTIONS = """Account Name: Hich Web
Account Number: 119020299485
Bank: HNB (Hatton National Bank)
Branch: Kandana"""


class RenewalItem(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    service: Literal["domain", "hosting", "domain_hosting"]
    description: str = Field(min_length=1, max_length=240)
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)


class RenewalInvoiceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    renewal_period_date: date
    items: list[RenewalItem] = Field(min_length=1, max_length=20)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    due_date: date
    apply_late_fee: bool = False
    late_fee_accepted: bool = False
    customer_note: str | None = Field(default=None, max_length=5000)

    @model_validator(mode="after")
    def accepted_charge(self) -> "RenewalInvoiceRequest":
        if self.apply_late_fee and not self.late_fee_accepted:
            raise ValueError("Confirm the client's acceptance before applying a late-payment surcharge")
        return self


class InvoiceDocumentCreate(InvoiceCreate):
    payment_instructions: str | None = Field(default=None, max_length=5000)
    customer_note: str | None = Field(default=None, max_length=5000)
    invoice_kind: Literal["project", "renewal"] = "project"
    renewal_source_invoice_id: UUID | None = None
    renewal_period_date: date | None = None
    renewal_items: list[RenewalItem] = Field(default_factory=list, max_length=20)
    renewal_late_fee: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=2)
    renewal_late_fee_accepted: bool = False

    @model_validator(mode="after")
    def one_line_item_format(self) -> "InvoiceDocumentCreate":
        if self.payments and self.milestones:
            raise ValueError("Use payment phases or milestones, not both")
        if self.milestones and sum((item.amount for item in self.milestones), Decimal()) != self.project_value:
            raise ValueError("Milestones must add up to the project value")
        if self.invoice_kind == "renewal":
            if not self.renewal_source_invoice_id or not self.renewal_period_date or not self.renewal_items:
                raise ValueError("A renewal invoice needs its source invoice, renewal cycle and service charges")
            base = sum((item.amount for item in self.renewal_items), Decimal())
            if base + self.renewal_late_fee != self.project_value:
                raise ValueError("Renewal service charges and surcharge must add up to the invoice total")
            if self.renewal_late_fee and (not self.renewal_late_fee_accepted or self.renewal_period_date >= self.issue_date
                                        or self.renewal_late_fee != (base * Decimal("0.18")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)):
                raise ValueError("The accepted 18% surcharge applies once to an overdue renewal base")
            if self.renewal_amount or self.renewal_due_date:
                raise ValueError("Keep future renewal settings on the source project invoice")
        elif self.renewal_items or self.renewal_source_invoice_id or self.renewal_period_date or self.renewal_late_fee:
            raise ValueError("Renewal billing details belong on a renewal invoice")
        return self


class InvoiceDocumentUpdate(InvoiceUpdate):
    payment_instructions: str | None = Field(default=None, max_length=5000)
    customer_note: str | None = Field(default=None, max_length=5000)
    expected_revision: int | None = Field(default=None, ge=1)
    renewal_items: list[RenewalItem] | None = Field(default=None, min_length=1, max_length=20)
    renewal_late_fee: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    renewal_late_fee_accepted: bool | None = None

    @model_validator(mode="after")
    def one_line_item_format(self) -> "InvoiceDocumentUpdate":
        if self.payments is not None and self.milestones is not None:
            raise ValueError("Use payment phases or milestones, not both")
        return self


class InvoiceShareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rotate: bool = False
    # Older browser bundles send this. Accept it without applying a deadline.
    expires_at: datetime | None = Field(default=None, exclude=True)


def invoice_token(invoice_id: str, nonce: str, settings: Settings) -> str:
    """Return the key-independent v2 token used for newly published links."""
    del settings  # retained in the signature for compatibility with existing callers
    return stable_public_token(invoice_id, nonce)


def invoice_token_hash(token: str, settings: Settings) -> str:
    if is_stable_public_token(token):
        return stable_public_token_hash("invoice", token)
    return hash_public_token(f"invoice:{token}", settings.token_hash_pepper.get_secret_value())


def legacy_invoice_token(invoice_id: str, nonce: str, key: str) -> str:
    digest = hmac.new(key.encode(), f"hich-invoice-v1:{invoice_id}:{nonce}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def invoice_token_hash_candidates(token: str, settings: Settings) -> tuple[str, ...]:
    """Lookup hashes for current v2 links and all configured legacy peppers."""
    if is_stable_public_token(token):
        return (stable_public_token_hash("invoice", token),)
    peppers = ("", *settings.legacy_link_key_set)
    return tuple(dict.fromkeys(hash_public_token(f"invoice:{token}", pepper) for pepper in peppers))


def recover_legacy_invoice_token(record: dict[str, Any], settings: Settings) -> str | None:
    """Reconstruct a legacy deterministic URL when its former key is available."""
    invoice_id, nonce, expected = record.get("id"), record.get("share_nonce"), str(record.get("share_token_hash") or "")
    if not invoice_id or not nonce or not expected:
        return None
    hash_peppers = ("", *settings.legacy_link_key_set)
    for key in settings.legacy_link_key_set:
        token = legacy_invoice_token(str(invoice_id), str(nonce), key)
        if any(hmac.compare_digest(hash_public_token(f"invoice:{token}", pepper), expected) for pepper in hash_peppers):
            return token
    return None


def public_invoice_shape(record: dict[str, Any]) -> dict[str, Any]:
    """Never pass through invoice, client, milestone, or payment dictionaries."""
    fields = (
        "invoice_number", "reference", "project_title", "project_value", "amount", "currency",
        "issue_date", "due_date", "renewal_amount", "renewal_currency", "renewal_due_date",
        "status", "paid_amount", "payment_method", "payment_instructions", "customer_note",
        "revision", "created_at", "updated_at",
        "invoice_kind", "renewal_period_date", "renewal_late_fee",
    )
    public = {key: record.get(key) for key in fields}
    public["payment_instructions"] = public.get("payment_instructions") or DEFAULT_PAYMENT_INSTRUCTIONS
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
        {key: item.get(key) for key in ("name", "amount", "status", "is_paid", "paid_at", "paid_amount")}
        for item in record.get("payments", [])
    ]
    public["payment_records"] = [
        {key: item.get(key) for key in ("receipt_number", "amount", "currency", "method", "paid_at", "date_confirmed")}
        for item in record.get("payment_records", [])
    ]
    public["renewal_items"] = [
        {key: item.get(key) for key in ("service", "description", "amount")}
        for item in record.get("renewal_items", []) or []
    ]
    return public
