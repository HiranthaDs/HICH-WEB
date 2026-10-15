from copy import deepcopy
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.dependencies import Principal, current_admin
from app.income import COLOMBO
from app.invoice_sharing import InvoiceDocumentCreate, RenewalInvoiceRequest, public_invoice_shape
from app.routers import invoices
from app.routers.invoices import _renewal_document, _shape
from app.supabase_client import get_supabase


def source(**extra):
    return {"id": str(uuid4()), "client_id": str(uuid4()), "invoice_kind": "project", "status": "paid",
            "project_title": "Business website", "project_value": "100000", "currency": "USD",
            "renewal_amount": "12000", "renewal_currency": "LKR", "renewal_due_date": "2026-10-01",
            "payment_method": "Bank transfer", "payment_instructions": "Account details", **extra}


def request(**extra):
    return RenewalInvoiceRequest(renewal_period_date="2026-10-01", due_date="2026-10-08", currency="LKR",
        items=[{"service": "domain", "description": "example.test domain renewal", "amount": "4000"},
               {"service": "hosting", "description": "Annual hosting", "amount": "8000"}], **extra)


def test_renewal_bill_contains_only_services_in_renewal_currency_and_no_project_receipts():
    original = source(payments=[{"amount": "100000", "paid_at": "2025-10-08"}])
    custom = RenewalInvoiceRequest(
        renewal_period_date="2026-10-01", due_date="2026-10-08", currency="LKR",
        items=[{"service": "Business email and SSL", "description": "Managed email and certificate renewal", "amount": "12000"}],
    )
    invoice = _renewal_document(original, custom, date(2026, 10, 8))
    assert invoice.invoice_kind == "renewal" and invoice.project_value == Decimal("12000")
    assert invoice.currency == "LKR" and original["currency"] == "USD"
    assert str(invoice.renewal_source_invoice_id) == original["id"]
    assert invoice.renewal_amount is None and invoice.renewal_due_date is None
    assert len(invoice.payments) == 1 and not invoice.payments[0].is_paid
    assert invoice.renewal_items[0].service == "Business email and SSL"
    assert invoice.payments[0].amount == Decimal("12000")
    assert invoice.payment_instructions == "Account details" and invoice.status == "draft"


def test_overdue_renewal_surcharge_requires_acceptance_and_is_rounded_once():
    with pytest.raises(ValidationError, match="acceptance"):
        request(apply_late_fee=True)
    invoice = _renewal_document(source(), request(apply_late_fee=True, late_fee_accepted=True), date(2026, 10, 8))
    assert invoice.renewal_late_fee == Decimal("2160.00")
    assert invoice.project_value == Decimal("14160.00")
    assert invoice.payments[0].amount == invoice.project_value
    tiny = RenewalInvoiceRequest(renewal_period_date="2026-10-01", due_date="2026-10-08", currency="LKR",
        items=[{"service": "domain", "description": "Rounding", "amount": "0.25"}], apply_late_fee=True, late_fee_accepted=True)
    assert _renewal_document(source(), tiny, date(2026, 10, 8)).renewal_late_fee == Decimal("0.05")


@pytest.mark.parametrize("change, code", [({"status": "void"}, 422), ({"invoice_kind": "renewal"}, 422), ({"renewal_due_date": "2026-11-01"}, 409)])
def test_renewal_rejects_invalid_or_changed_source(change, code):
    with pytest.raises(HTTPException) as exc:
        _renewal_document(source(**change), request(), date(2026, 10, 8))
    assert exc.value.status_code == code


def test_surcharge_not_due_on_deadline_and_new_invoice_due_date_cannot_be_past():
    with pytest.raises(HTTPException, match="not overdue"):
        _renewal_document(source(), request(apply_late_fee=True, late_fee_accepted=True), date(2026, 10, 1))
    with pytest.raises(HTTPException, match="issue date"):
        _renewal_document(source(), request(), date(2026, 10, 9))


def test_public_paid_renewal_invoice_exposes_services_and_receipts_without_source_data():
    raw = {"id": str(uuid4()), "invoice_kind": "renewal", "invoice_number": "REN-TEST", "project_value": "12000", "currency": "LKR", "status": "paid",
        "renewal_source_invoice_id": "private-project-id", "renewal_period_date": "2026-10-01", "renewal_late_fee": "0",
        "renewal_items": [{"service": "domain", "description": "Domain renewal", "amount": "4000"}, {"service": "hosting", "description": "Hosting renewal", "amount": "8000"}],
        "invoice_milestones": [{"id": "phase", "title": "Renewal payment", "amount": "12000", "status": "paid"}],
        "payments": [{"milestone_id": "phase", "amount": "12000", "currency": "LKR", "method": "Bank transfer", "paid_at": "2026-10-08", "reference": "private-bank-reference"}],
        "clients": {"name": "Client", "email": "private@example.test"}, "notes": "private notes"}
    public = public_invoice_shape(_shape(raw))
    assert public["status"] == "paid" and public["balance_due"] == "0"
    assert public["paid_amount"] == "12000" and len(public["renewal_items"]) == 2
    assert public["payment_records"][0]["method"] == "Bank transfer"
    assert "private" not in str(public) and "renewal_source_invoice_id" not in public


def test_many_phases_preserve_amounts_and_receipt_totals():
    invoice = InvoiceDocumentCreate(client_id=uuid4(), amount="10000", payments=[
        {"name": name, "amount": "2000"} for name in ["Advance", "Design approval", "Development", "Testing", "Final"]])
    assert len(invoice.payments) == 5
    shaped = _shape({"project_value": "10000", "status": "sent", "invoice_milestones": [
        {"id": f"phase-{i}", "title": p.name, "amount": str(p.amount), "position": i} for i, p in enumerate(invoice.payments)],
        "payments": [{"milestone_id": "phase-2", "amount": "500", "paid_at": "2026-10-01"}]})
    assert len(shaped["payments"]) == 5 and shaped["balance_due"] == "9500"
    assert shaped["payments"][2]["paid_amount"] == "500" and not shaped["payments"][2]["is_paid"]


def test_service_total_must_match_and_unagreed_surcharge_cannot_be_saved():
    data = _renewal_document(source(), request(), date(2026, 10, 8)).model_dump()
    with pytest.raises(ValidationError, match="invoice total"):
        InvoiceDocumentCreate(**{**data, "project_value": Decimal("13000"), "amount": Decimal("13000"), "payments": []})
    with pytest.raises(ValidationError, match="accepted 18%"):
        InvoiceDocumentCreate(**{**data, "project_value": Decimal("14160"), "amount": Decimal("14160"), "payments": [], "renewal_late_fee": Decimal("2160")})


def test_unpublished_past_due_draft_is_not_reported_as_overdue():
    shaped = _shape({"project_value": "12000", "status": "draft", "due_date": "2000-01-01"})
    assert shaped["status"] == "draft"


class RenewalQuery:
    def __init__(self, records):
        self.records = records
        self.predicates = []

    def select(self, _): return self
    def limit(self, _): return self
    def eq(self, key, value):
        self.predicates.append(lambda row: row.get(key) == value)
        return self
    def neq(self, key, value):
        self.predicates.append(lambda row: row.get(key) != value)
        return self
    def is_(self, key, value):
        assert value == "null"
        return self.eq(key, None)
    def execute(self):
        return SimpleNamespace(data=[deepcopy(row) for row in self.records if all(check(row) for check in self.predicates)])


class RenewalService:
    def __init__(self, records):
        self.records = records
        self.calls = []

    def table(self, name):
        assert name == "invoices"
        return RenewalQuery(self.records)

    def rpc(self, name, parameters):
        assert name == "create_renewal_invoice"
        self.calls.append(parameters)
        bill = {**parameters["p_fields"], "id": str(uuid4())}
        self.records.append(bill)
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[deepcopy(bill)]))


@pytest.fixture
def renewal_api(monkeypatch):
    def build(*records):
        service = RenewalService(list(records))
        app = FastAPI()
        app.include_router(invoices.router)
        app.dependency_overrides[current_admin] = lambda: Principal(uuid4(), "admin@example.test")
        app.dependency_overrides[get_supabase] = lambda: SimpleNamespace(service=service)
        app.dependency_overrides[get_settings] = lambda: Settings(
            _env_file=None, supabase_url="https://example.supabase.co", supabase_publishable_key="publishable",
            supabase_secret_key="test-secret-only", public_app_url="https://hich.example",
        )
        monkeypatch.setattr(invoices, "audit", lambda *args, **kwargs: None)
        return TestClient(app), service
    return build


def saved_bill(original, **extra):
    return {"id": str(uuid4()), "client_id": original["client_id"], "invoice_kind": "renewal", "status": "sent",
            "invoice_number": "REN-SAVED", "project_value": "12000", "currency": "LKR",
            "renewal_source_invoice_id": original["id"], "renewal_period_date": "2026-10-01", **extra}


def test_existing_renewal_is_found_without_browser_list_or_current_source_cycle(renewal_api):
    original = source(renewal_due_date="2027-10-01")
    bill = saved_bill(original, status="paid", payments=[{"amount": "12000", "paid_at": "2026-10-08"}])
    client, _ = renewal_api(original, bill)
    assert client.get(f"/invoices/{original['id']}/renewal-invoice").json() == {"invoice": None}
    result = client.get(f"/invoices/{original['id']}/renewal-invoice?period_date=2026-10-01")
    assert result.status_code == 200
    assert result.json()["invoice"]["id"] == bill["id"]
    assert result.json()["invoice"]["status"] == "paid"
    assert result.json()["invoice"]["balance_due"] == "0"


@pytest.mark.parametrize("extra", [{"status": "void"}, {"deleted_at": "2026-10-08T00:00:00Z"}])
def test_voided_or_deleted_renewal_is_not_reopened(renewal_api, extra):
    original = source()
    client, _ = renewal_api(original, saved_bill(original, **extra))
    result = client.get(f"/invoices/{original['id']}/renewal-invoice")
    assert result.status_code == 200 and result.json() == {"invoice": None}


def test_retry_reuses_saved_renewal_before_new_issue_date_validation(renewal_api):
    original = source(renewal_due_date="2027-10-01")
    bill = saved_bill(original)
    client, service = renewal_api(original, bill)
    payload = request().model_dump(mode="json") | {"due_date": "2000-01-01"}
    result = client.post(f"/invoices/{original['id']}/renewal-invoice", json=payload)
    assert result.status_code == 200
    assert result.json()["invoice"]["id"] == bill["id"]
    assert result.json()["reused"] is True
    assert service.calls == []


def test_prepare_creates_draft_once_and_retry_keeps_original_charges(renewal_api):
    today = datetime.now(COLOMBO).date()
    period = (today - timedelta(days=7)).isoformat()
    original = source(renewal_due_date=period)
    client, service = renewal_api(original)
    payload = request().model_dump(mode="json") | {"renewal_period_date": period, "due_date": today.isoformat()}
    response = client.post(f"/invoices/{original['id']}/renewal-invoice", json=payload)
    assert response.status_code == 200
    prepared = response.json()
    assert prepared["invoice"]["status"] == "draft" and prepared["reused"] is False
    assert service.calls[0]["p_fields"]["status"] == "draft"
    assert prepared["invoice"]["project_value"] == "12000"
    assert prepared["invoice"]["currency"] == "LKR"
    assert prepared["invoice"]["payment_records"] == []
    # Double-submit/retry must not silently overwrite the saved financial document.
    payload["items"][0]["amount"] = "9000"
    retried = client.post(f"/invoices/{original['id']}/renewal-invoice", json=payload).json()
    assert retried["invoice"]["id"] == prepared["invoice"]["id"]
    assert retried["invoice"]["project_value"] == "12000" and retried["reused"] is True
    assert len(service.calls) == 1


def test_new_renewal_still_rejects_stale_cycle_and_invalid_due_date(renewal_api):
    original = source(renewal_due_date="2027-10-01")
    client, service = renewal_api(original)
    payload = request().model_dump(mode="json")
    assert client.post(f"/invoices/{original['id']}/renewal-invoice", json=payload).status_code == 409
    payload.update(renewal_period_date="2027-10-01", due_date="2000-01-01")
    assert client.post(f"/invoices/{original['id']}/renewal-invoice", json=payload).status_code == 422
    assert service.calls == []


def test_renewal_copies_full_length_stored_instructions_without_display_defaults(renewal_api):
    today = datetime.now(COLOMBO).date()
    period = (today - timedelta(days=7)).isoformat()
    instructions = "Payment details " + "x" * (5000 - len("Payment details "))
    original = source(renewal_due_date=period, payment_instructions=instructions)
    client, service = renewal_api(original)
    payload = request().model_dump(mode="json") | {"renewal_period_date": period, "due_date": today.isoformat()}
    response = client.post(f"/invoices/{original['id']}/renewal-invoice", json=payload)
    assert response.status_code == 200
    assert service.calls[0]["p_fields"]["payment_instructions"] == instructions
    assert response.json()["invoice"]["payment_instructions"].startswith(instructions)
