from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.invoice_sharing import InvoiceDocumentCreate, RenewalInvoiceRequest, public_invoice_shape
from app.routers.invoices import _renewal_document, _shape


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
    original = source()
    invoice = _renewal_document(original, request(), date(2026, 10, 8))
    assert invoice.invoice_kind == "renewal" and invoice.project_value == Decimal("12000")
    assert invoice.currency == "LKR" and original["currency"] == "USD"
    assert str(invoice.renewal_source_invoice_id) == original["id"]
    assert invoice.renewal_amount is None and invoice.renewal_due_date is None
    assert len(invoice.payments) == 1 and not invoice.payments[0].is_paid
    assert invoice.payment_instructions == "Account details" and invoice.status == "sent"


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
