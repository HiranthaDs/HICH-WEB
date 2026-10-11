from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.calendar import calendar_report
from app.config import Settings, get_settings
from app.routers import dashboard
from app.routers.dashboard import calendar_view
from app.supabase_client import get_supabase


def invoice(invoice_id: str, **extra):
    return {
        "id": invoice_id,
        "client_id": f"client-{invoice_id}",
        "invoice_number": f"INV-{invoice_id}",
        "invoice_kind": "project",
        "project_title": f"Project {invoice_id}",
        "project_value": "1000",
        "currency": "LKR",
        "status": "sent",
        "clients": {"name": f"Client {invoice_id}"},
        **extra,
    }


def events_of(report, event_type: str):
    return [event for event in report["events"] if event["type"] == event_type]


def test_calendar_uses_colombo_receipt_date_keeps_void_cash_and_excludes_unconfirmed_dates():
    invoices = [invoice("void", status="void", deleted_at="2026-10-02T00:00:00Z")]
    payments = [
        {
            "id": "confirmed",
            "invoice_id": "void",
            "amount": "250.50",
            "currency": "LKR",
            "paid_at": "2026-09-30T19:00:00Z",
            "date_confirmed": True,
        },
        {
            "id": "unknown-date",
            "invoice_id": "void",
            "amount": "100",
            "currency": "LKR",
            "paid_at": "2026-10-01T08:00:00Z",
            "date_confirmed": False,
        },
    ]

    report = calendar_report(invoices, payments, [], date(2026, 10, 1), date(2026, 10, 31))
    receipts = events_of(report, "receipt")

    assert len(receipts) == 1
    assert receipts[0]["date"] == "2026-10-01"
    assert receipts[0]["amount"] == Decimal("250.50")
    assert receipts[0]["invoice_status"] == "void"


def test_calendar_invoice_due_event_is_the_remaining_balance_and_filters_inactive_documents():
    invoices = [
        invoice("open", due_date="2026-10-01"),
        invoice("draft", status="draft", due_date="2026-10-31"),
        invoice("deleted", deleted_at="2026-10-01T00:00:00Z", due_date="2026-10-15"),
        invoice("outside", due_date="2026-11-01"),
    ]
    payments = [
        {
            "id": "undated-but-cleared",
            "invoice_id": "open",
            "amount": "250",
            "currency": "LKR",
            "paid_at": "2026-10-01T00:00:00Z",
            "date_confirmed": False,
        }
    ]

    report = calendar_report(invoices, payments, [], date(2026, 10, 1), date(2026, 10, 31))
    due = events_of(report, "invoice_due")

    assert len(due) == 1
    assert due[0]["invoice_id"] == "open"
    assert due[0]["date"] == "2026-10-01"
    assert due[0]["amount"] == Decimal("750")
    assert events_of(report, "receipt") == []


def test_calendar_renewals_use_billed_total_and_dedupe_linked_or_matching_agreements():
    source = invoice(
        "source",
        agreement_id="agreement-linked",
        renewal_amount="120",
        renewal_currency="USD",
        renewal_due_date="2026-10-20",
    )
    bill = invoice(
        "bill",
        invoice_kind="renewal",
        renewal_source_invoice_id="source",
        renewal_period_date="2026-10-20",
        project_value="135",
        currency="USD",
        status="paid",
        invoice_number="REN-PAID",
    )
    agreements = [
        {
            "id": "agreement-linked",
            "client_id": source["client_id"],
            "status": "signed",
            "project_title": source["project_title"],
            "renewal_amount": "120",
            "renewal_currency": "USD",
            "renewal_due_date": "2026-10-20",
            "clients": source["clients"],
        },
        {
            "id": "agreement-matching",
            "client_id": source["client_id"],
            "status": "signed",
            "project_title": source["project_title"],
            "renewal_amount": "120",
            "renewal_currency": "USD",
            "renewal_due_date": "2026-10-20",
            "clients": source["clients"],
        },
        {
            "id": "agreement-only",
            "client_id": "client-only",
            "reference": "AGR-ONLY",
            "status": "signed",
            "project_title": "Agreement-only care",
            "renewal_amount": "80",
            "renewal_currency": "GBP",
            "renewal_due_date": "2026-10-31",
            "clients": {"company": "Only Company"},
        },
    ]

    report = calendar_report([source, bill], [], agreements, date(2026, 10, 1), date(2026, 10, 31))
    renewals = events_of(report, "renewal_due")

    assert len(renewals) == 2
    project_event = next(event for event in renewals if event.get("source_invoice_id") == "source")
    assert project_event["invoice_id"] == "bill"
    assert project_event["reference"] == "REN-PAID"
    assert project_event["amount"] == Decimal("135")
    assert project_event["status"] == "paid"
    agreement_event = next(event for event in renewals if event.get("agreement_id") == "agreement-only")
    assert agreement_event["date"] == "2026-10-31"
    assert agreement_event["currency"] == "GBP"


def test_calendar_returns_every_renewal_in_range_without_dashboard_truncation():
    invoices = [
        invoice(
            str(index),
            renewal_amount="100",
            renewal_due_date=f"2026-10-{index + 1:02d}",
        )
        for index in range(12)
    ]
    report = calendar_report(invoices, [], [], date(2026, 10, 1), date(2026, 10, 31))

    assert len(events_of(report, "renewal_due")) == 12
    assert report["events"][0]["date"] == "2026-10-01"


@pytest.mark.parametrize(
    "start,end,message",
    [
        (date(2026, 10, 2), date(2026, 10, 1), "on or after"),
        (date(2025, 1, 1), date(2026, 1, 3), "366 days"),
    ],
)
def test_calendar_endpoint_rejects_invalid_ranges_before_querying(start, end, message):
    with pytest.raises(HTTPException, match=message) as exc:
        calendar_view(start, end, None, None)
    assert exc.value.status_code == 422


def test_calendar_endpoint_requires_an_authenticated_portal_user():
    settings = Settings(
        _env_file=None,
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="public",
        supabase_secret_key="secret",
    )
    app = FastAPI()
    app.include_router(dashboard.router)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_supabase] = lambda: SimpleNamespace()

    response = TestClient(app).get("/calendar?start=2026-10-01&end=2026-10-31")

    assert response.status_code == 401
    assert response.json()["detail"] == "Authentication required"
