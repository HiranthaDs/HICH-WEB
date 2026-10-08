from __future__ import annotations

from datetime import datetime, timezone

from app.intelligence import analyze_business
from app.routers.invoices import _shape
from app.routers.portfolio import _slugify


def test_intelligence_prioritizes_overdue_cash_and_forecasts_due_work() -> None:
    result = analyze_business(
        clients=[{"id": "client-1", "status": "active", "email": "client@example.com"}],
        agreements=[],
        invoices=[
            {
                "id": "invoice-1",
                "status": "sent",
                "project_value": "100000",
                "currency": "LKR",
                "due_date": "2026-09-01",
            },
            {
                "id": "invoice-2",
                "status": "partial",
                "project_value": "50000",
                "currency": "LKR",
                "due_date": "2026-10-20",
            },
        ],
        payments=[
            {"invoice_id": "invoice-1", "amount": "25000", "currency": "LKR", "paid_at": "2026-08-01T00:00:00Z"},
            {"invoice_id": "invoice-2", "amount": "10000", "currency": "LKR", "paid_at": "2026-10-01T00:00:00Z"},
        ],
        projects=[{"id": "project-1", "published": True}],
        now=datetime(2026, 10, 7, tzinfo=timezone.utc),
    )

    assert result["overdue_balance"] == 75000.0
    assert result["cash_forecast_30d"] == 32000.0
    assert result["risk_level"] in {"medium", "high"}
    assert result["insights"][0]["id"] == "overdue-cash"


def test_invoice_shape_keeps_unpaid_milestones_visible() -> None:
    shaped = _shape(
        {
            "id": "invoice-1",
            "invoice_number": "INV-1",
            "status": "sent",
            "project_value": "1000",
            "due_date": "2000-01-01",
            "clients": {"name": "Client"},
            "invoice_milestones": [
                {"id": "phase-1", "title": "Advance", "amount": "500", "status": "pending", "position": 0},
                {"id": "phase-2", "title": "Final", "amount": "500", "status": "paid", "position": 1},
            ],
            "payments": [
                {"id": "payment-1", "milestone_id": "phase-2", "amount": "500", "paid_at": "2026-01-02T00:00:00Z"}
            ],
        }
    )

    assert len(shaped["payments"]) == 2
    assert shaped["payments"][0]["is_paid"] is False
    assert shaped["payments"][1]["is_paid"] is True
    assert shaped["paid_amount"] == "500"
    assert shaped["status"] == "overdue"


def test_portfolio_slugify_handles_spaces_and_unicode() -> None:
    assert _slugify("  Café Storefront — 2026 ") == "cafe-storefront-2026"
