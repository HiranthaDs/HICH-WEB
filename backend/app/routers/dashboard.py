from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends

from ..data import db_failure, rows
from ..dependencies import Principal, current_admin
from ..intelligence import analyze_business
from ..supabase_client import SupabaseGateway, get_supabase


router = APIRouter(tags=["dashboard"])


def _money(value: object) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except Exception:
        return Decimal("0")


@router.get("/dashboard")
def dashboard(
    _: Principal = Depends(current_admin),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        clients = rows(gateway.service.table("clients").select("id,name,company,email,phone,status").neq("status", "archived").execute())
        agreements = rows(gateway.service.table("agreements").select("id,title,status,sent_at,viewed_at,expires_at,updated_at").execute())
        invoices = rows(
            gateway.service.table("invoices")
            .select("id,invoice_number,project_title,status,project_value,currency,due_date,renewal_amount,renewal_currency,renewal_due_date,client_id,clients(name,company,email,phone)")
            .neq("status", "void")
            .execute()
        )
        payments = rows(gateway.service.table("payments").select("invoice_id,amount,currency,paid_at").execute())
        projects = rows(gateway.service.table("portfolio_projects").select("id,published").execute())
        activity = rows(
            gateway.service.table("audit_logs")
            .select("*")
            .order("created_at", desc=True)
            .limit(12)
            .execute()
        )

        # The legacy portal is LKR-first. Mixed-currency values stay out of the aggregate.
        invoiced = sum((_money(item.get("project_value")) for item in invoices if item.get("currency") == "LKR"), Decimal())
        collected = sum((_money(item.get("amount")) for item in payments if item.get("currency") == "LKR"), Decimal())
        outstanding = max(Decimal(), invoiced - collected)
        awaiting = sum(1 for item in agreements if item.get("status") in {"sent", "viewed"})
        active_clients = sum(1 for item in clients if item.get("status") == "active")
        current = datetime.now(timezone.utc)

        paid_by_invoice: dict[str, Decimal] = defaultdict(Decimal)
        for payment in payments:
            paid_by_invoice[str(payment.get("invoice_id") or "")] += _money(payment.get("amount"))

        invoice_cards: list[dict[str, Any]] = []
        renewal_cards: list[dict[str, Any]] = []
        for item in invoices:
            client = item.get("clients") or {}
            paid_amount = paid_by_invoice[str(item.get("id") or "")]
            effective_status = item.get("status")
            try:
                due_at = datetime.fromisoformat(str(item.get("due_date")).replace("Z", "+00:00")) if item.get("due_date") else None
                if due_at and due_at.date() < current.date() and paid_amount < _money(item.get("project_value")):
                    effective_status = "overdue"
            except (TypeError, ValueError):
                pass
            if item.get("status") not in {"paid", "void"}:
                invoice_cards.append(
                    item
                    | {
                        "reference": item.get("invoice_number"),
                        "amount": item.get("project_value"),
                        "paid_amount": float(paid_amount),
                        "status": effective_status,
                        "client_name": client.get("company") or client.get("name"),
                        "phone": client.get("phone"),
                    }
                )
            try:
                renewal_due = datetime.fromisoformat(str(item.get("renewal_due_date"))) if item.get("renewal_due_date") else None
            except (TypeError, ValueError):
                renewal_due = None
            if item.get("renewal_amount") and renewal_due and -14 <= (renewal_due.date() - current.date()).days <= 60:
                renewal_cards.append(
                    {
                        "id": item.get("id"),
                        "invoice_id": item.get("id"),
                        "client_name": client.get("company") or client.get("name"),
                        "phone": client.get("phone"),
                        "amount": item.get("renewal_amount"),
                        "currency": item.get("renewal_currency") or item.get("currency"),
                        "due_date": item.get("renewal_due_date"),
                    }
                )
        invoice_cards.sort(key=lambda item: (item.get("due_date") is None, str(item.get("due_date") or "")))
        renewal_cards.sort(key=lambda item: str(item.get("due_date") or ""))

        statuses = [
            {"status": value, "name": value.title(), "count": sum(1 for row in agreements if row.get("status") == value)}
            for value in ("draft", "sent", "viewed", "signed", "expired", "void")
        ]
        revenue_by_month: dict[str, Decimal] = defaultdict(Decimal)
        for payment in payments:
            if payment.get("currency") != "LKR" or not payment.get("paid_at"):
                continue
            try:
                paid_at = datetime.fromisoformat(str(payment["paid_at"]).replace("Z", "+00:00"))
                revenue_by_month[paid_at.strftime("%Y-%m")] += _money(payment.get("amount"))
            except (TypeError, ValueError):
                continue
        month_keys: list[str] = []
        year, month = current.year, current.month
        for _index in range(11, -1, -1):
            target_month = month - _index
            target_year = year
            while target_month <= 0:
                target_month += 12
                target_year -= 1
            month_keys.append(f"{target_year:04d}-{target_month:02d}")
        revenue_points = [
            {
                "month": key,
                "label": datetime.strptime(key, "%Y-%m").strftime("%b %Y"),
                "value": float(revenue_by_month[key]),
                "revenue": float(revenue_by_month[key]),
                "paid": float(revenue_by_month[key]),
            }
            for key in month_keys
        ]
        result = {
            "metrics": {
                "total_revenue": float(collected),
                "pending_revenue": float(outstanding),
                "active_clients": active_clients,
                "awaiting_signatures": awaiting,
            },
            "total_revenue": float(collected),
            "pending_revenue": float(outstanding),
            "active_clients": active_clients,
            "awaiting_signatures": awaiting,
            "clients_total": len(clients),
            "agreements_total": len(agreements),
            "invoices_total": len(invoices),
            "portfolio_projects": len(projects),
            "recent_activity": activity,
            "upcoming_invoices": invoice_cards[:8],
            "upcoming_renewals": renewal_cards[:8],
            "agreement_statuses": statuses,
            "revenue": revenue_points,
            "intelligence": analyze_business(
                clients=clients,
                agreements=agreements,
                invoices=invoices,
                payments=payments,
                projects=projects,
                now=current,
            ),
        }
        return {"dashboard": result}
    except Exception as exc:
        raise db_failure(exc, "load the dashboard") from exc
