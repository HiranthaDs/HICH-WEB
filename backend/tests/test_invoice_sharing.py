from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.invoice_sharing import (
    DEFAULT_PAYMENT_INSTRUCTIONS,
    InvoiceDocumentCreate, InvoiceDocumentUpdate, InvoiceShareRequest,
    invoice_token, invoice_token_hash, public_invoice_shape,
)
from app.routers.invoices import _shape, public_router
from app.security import rate_limiter
from app.supabase_client import get_supabase


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None, supabase_url="https://example.supabase.co", supabase_publishable_key="publishable",
        supabase_secret_key="test-secret-only", token_hash_pepper="test-pepper", public_app_url="https://hich.example",
    )


def invoice_record() -> dict:
    return {
        "id": str(uuid4()), "invoice_number": "INV-2026-100", "project_title": "Online store",
        "project_value": "12000.00", "currency": "LKR", "status": "sent", "revision": 3,
        "share_active": True, "share_nonce": str(uuid4()), "share_token_hash": "private-hash",
        "notes": "Private collection notes", "created_by": "private-operator",
        "payment_instructions": "Bank transfer using the invoice reference", "customer_note": "Thank you",
        "clients": {"name": "Jane", "company": "Example", "phone": "+94770000000", "email": "private@example.com", "notes": "Private client notes"},
        "invoice_milestones": [
            {"id": "phase-1", "title": "Deposit", "amount": "4000.00", "position": 0, "status": "paid", "invoice_id": "private-id"},
            {"id": "phase-2", "title": "Delivery", "amount": "8000.00", "position": 1, "status": "pending"},
        ],
        "payments": [{"id": "private-payment-id", "milestone_id": "phase-1", "amount": "4000.00", "currency": "LKR", "paid_at": "2026-10-01", "notes": "Private payment note", "reference": "private-transfer-reference"}],
    }


def test_public_invoice_whitelist_includes_balances_but_no_private_data() -> None:
    original = invoice_record()
    before = deepcopy(original)
    public = public_invoice_shape(_shape(original))
    assert original == before  # shaping must not discard source milestone data
    assert public["balance_due"] == "8000.00"
    assert public["paid_amount"] == "4000.00"
    assert public["client"]["phone"] == "+94770000000"
    assert public["status"] == "partial"
    assert public["payment_instructions"].startswith("Bank transfer")
    assert public["milestones"][0]["title"] == "Deposit"
    assert "private" not in str(public).lower()
    assert "notes" not in public
    assert "email" not in public["client"]


def test_default_payment_instructions_are_added_when_invoice_has_none() -> None:
    public = public_invoice_shape(_shape(invoice_record() | {"payment_instructions": None}))
    assert public["payment_instructions"] == DEFAULT_PAYMENT_INSTRUCTIONS
    assert "119020299485" in public["payment_instructions"]


def test_link_tokens_survive_secret_rotation_but_change_with_nonce(settings: Settings) -> None:
    invoice_id, nonce = str(uuid4()), str(uuid4())
    token = invoice_token(invoice_id, nonce, settings)
    assert len(token) == 46
    assert token == invoice_token(invoice_id, nonce, settings)
    assert token != invoice_token(invoice_id, str(uuid4()), settings)
    assert token != invoice_token(str(uuid4()), nonce, settings)
    assert token not in invoice_token_hash(token, settings)
    changed_key = settings.model_copy(update={"token_hash_pepper": settings.supabase_secret_key})
    assert token == invoice_token(invoice_id, nonce, changed_key)
    assert invoice_token_hash(token, settings) == invoice_token_hash(token, changed_key)


def test_invoice_input_preserves_public_fields_and_requires_valid_phases() -> None:
    invoice = InvoiceDocumentCreate(client_id=uuid4(), amount="100", payment_instructions="Use invoice reference", customer_note="Thank you")
    assert invoice.payment_instructions == "Use invoice reference"
    with pytest.raises(ValidationError, match="Milestones must add up"):
        InvoiceDocumentCreate(client_id=uuid4(), amount="100", milestones=[{"title": "Deposit", "amount": "90"}])
    with pytest.raises(ValidationError, match="not both"):
        InvoiceDocumentUpdate(payments=[], milestones=[])
    with pytest.raises(ValidationError):
        InvoiceDocumentUpdate(expected_revision=0)


def test_legacy_expiry_payload_is_accepted_but_never_applied() -> None:
    for expiry in (None, datetime.now(timezone.utc) - timedelta(days=1), datetime.now(timezone.utc) + timedelta(days=1)):
        assert InvoiceShareRequest(expires_at=expiry).model_dump() == {"rotate": False}


@pytest.mark.parametrize("project_currency,renewal_currency", [("USD", "GBP"), ("LKR", "USD"), ("GBP", "LKR")])
def test_project_and_renewal_amounts_keep_independent_currencies(project_currency, renewal_currency):
    invoice = InvoiceDocumentCreate(client_id=uuid4(), amount="100.50", currency=project_currency,
                                    renewal_amount="25.25", renewal_currency=renewal_currency)
    assert str(invoice.project_value) == "100.50"
    assert str(invoice.renewal_amount) == "25.25"
    public = public_invoice_shape(_shape(invoice_record() | {
        "project_value": str(invoice.project_value), "currency": invoice.currency,
        "renewal_amount": str(invoice.renewal_amount), "renewal_currency": invoice.renewal_currency,
    }))
    assert public["amount"] == "100.50"
    assert public["currency"] == project_currency
    assert public["renewal_amount"] == "25.25"
    assert public["renewal_currency"] == renewal_currency


class Query:
    def __init__(self, records: list[dict]):
        self.records = records
        self.filters = []
        self.memberships = []

    def select(self, _): return self
    def eq(self, key, value):
        self.filters.append((key, value))
        return self
    def limit(self, _): return self
    def in_(self, key, values):
        self.memberships.append((key, values))
        return self
    def execute(self):
        return SimpleNamespace(data=[deepcopy(record) for record in self.records
                                     if all(record.get(key) == value for key, value in self.filters)
                                     and all(record.get(key) in values for key, values in self.memberships)])


def public_client(settings: Settings, record: dict) -> TestClient:
    rate_limiter.clear()
    app = FastAPI()
    app.include_router(public_router)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_supabase] = lambda: SimpleNamespace(service=SimpleNamespace(table=lambda _: Query([record])))
    return TestClient(app)


def test_public_endpoint_reloads_latest_data_with_same_token(settings: Settings) -> None:
    record = invoice_record()
    token = invoice_token(record["id"], record["share_nonce"], settings)
    record["share_token_hash"] = invoice_token_hash(token, settings)
    client = public_client(settings, record)
    result = client.get(f"/public/invoices/{token}")
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.headers["referrer-policy"] == "no-referrer"
    assert result.json()["invoice"]["revision"] == 3
    record.update({"revision": 4, "project_title": "Updated online store"})
    result = client.get(f"/public/invoices/{token}")
    assert result.json()["invoice"]["project_title"] == "Updated online store"
    assert result.json()["invoice"]["revision"] == 4
    assert "share_token_hash" not in result.text


@pytest.mark.parametrize("change,expected", [
    ({"share_active": False}, 404), ({"status": "draft"}, 404), ({"status": "void"}, 404),
    ({"share_expires_at": "2000-01-01T00:00:00Z"}, 200),
    ({"deleted_at": "2026-10-01T00:00:00Z"}, 404),
])
def test_public_endpoint_respects_revocation_but_ignores_old_deadlines(settings: Settings, change: dict, expected: int) -> None:
    record = invoice_record()
    token = invoice_token(record["id"], record["share_nonce"], settings)
    record["share_token_hash"] = invoice_token_hash(token, settings)
    record.update(change)
    assert public_client(settings, record).get(f"/public/invoices/{token}").status_code == expected


def test_public_endpoint_rejects_unknown_and_malformed_links(settings: Settings) -> None:
    client = public_client(settings, invoice_record())
    assert client.get("/public/invoices/guess").status_code == 404
    assert client.get(f"/public/invoices/{'a' * 43}").status_code == 404


def test_public_pdf_checks_bearer_link_and_returns_download(settings: Settings) -> None:
    record = invoice_record()
    token = invoice_token(record["id"], record["share_nonce"], settings)
    record["share_token_hash"] = invoice_token_hash(token, settings)
    client = public_client(settings, record)
    result = client.get(f"/public/invoices/{token}/pdf")
    assert result.status_code == 200
    assert result.content.startswith(b"%PDF")
    assert result.headers["content-type"] == "application/pdf"
    assert result.headers["cache-control"] == "no-store"
    record["share_active"] = False
    assert client.get(f"/public/invoices/{token}/pdf").status_code == 404


def test_invoice_legacy_url_works_when_former_key_is_configured(settings: Settings) -> None:
    from pydantic import SecretStr
    from app.invoice_sharing import legacy_invoice_token
    from app.security import hash_public_token
    record = invoice_record()
    token = legacy_invoice_token(record["id"], record["share_nonce"], "old-key")
    record["share_token_hash"] = hash_public_token(f"invoice:{token}", "old-key")
    changed = settings.model_copy(update={"legacy_public_link_keys": SecretStr("old-key")})
    assert public_client(changed, record).get(f"/public/invoices/{token}").status_code == 200


@pytest.mark.parametrize("initial", ["unpublished", "unrecoverable-legacy", "v2"])
def test_share_creates_or_recovers_working_link_without_missing_schema_column(settings, monkeypatch, initial):
    from uuid import UUID
    from starlette.requests import Request
    from app.routers import invoices
    row = invoice_record()
    if initial == "unpublished":
        row.update(share_nonce=None, share_token_hash=None, share_active=False)
    elif initial == "v2":
        row["share_token_hash"] = invoice_token_hash(invoice_token(row["id"], row["share_nonce"], settings), settings)
    original_nonce = row["share_nonce"]

    class PublicationQuery(Query):
        def is_(self, key, value):
            assert value == "null"
            return self.eq(key, None)

        def select(self, selection):
            assert "share_token_version" not in selection
            return self

    class Service:
        def table(self, name):
            assert name == "invoices"
            return PublicationQuery([row])

        def rpc(self, name, fields):
            assert name == "publish_invoice_link"
            assert fields["p_expires_at"] is None
            if fields["p_rotate"] or not row["share_active"] or not row.get("share_nonce"):
                row.update(share_nonce=fields["p_nonce"], share_token_hash=fields["p_token_hash"], share_active=True)
            return SimpleNamespace(execute=lambda: SimpleNamespace(data=[deepcopy(row)]))

    monkeypatch.setattr(invoices, "audit", lambda *args: None)
    gateway = SimpleNamespace(service=Service())
    request = Request({"type": "http", "headers": [], "method": "POST", "path": "/share"})
    result = invoices.share_invoice(UUID(row["id"]), request, InvoiceShareRequest(expires_at=None), None, settings, gateway)
    assert result["token"].startswith("v2_")
    assert invoice_token_hash(result["token"], settings) == row["share_token_hash"]
    again = invoices.share_invoice(UUID(row["id"]), request, None, None, settings, gateway)
    assert result["share_url"] == again["share_url"]
    if initial == "v2":
        assert row["share_nonce"] == original_nonce
