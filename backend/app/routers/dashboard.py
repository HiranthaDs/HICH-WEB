from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ..data import db_failure, rows
from ..dependencies import Principal, current_admin
from ..intelligence import analyze_business
from ..income import income_report, COLOMBO
from ..supabase_client import SupabaseGateway, get_supabase


router = APIRouter(tags=["dashboard"])


def all_records(gateway, table: str, select: str):
    result = []
    while True:
        batch = rows(gateway.service.table(table).select(select).order("id").range(len(result), len(result) + 499).execute())
        result.extend(batch)
        if len(batch) < 500:
            return result


@router.get("/income")
def income(start: date = Query(...), end: date = Query(...), _: Principal = Depends(current_admin), gateway: SupabaseGateway = Depends(get_supabase)):
    if end < start:
        raise HTTPException(422, "The end date must be on or after the start date")
    try:
        invoices = all_records(gateway, "invoices", "id,client_id,invoice_number,project_title,status,project_value,currency,issue_date,due_date,clients(name,company)")
        payments = all_records(gateway, "payments", "id,invoice_id,amount,currency,paid_at,method,reference")
        return {"income": income_report(invoices, payments, start, end, datetime.now(COLOMBO).date())}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the income summary") from exc


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
        clients = [item for item in all_records(gateway, "clients", "id,name,company,email,phone,status") if item["status"] != "archived"]
        agreements = all_records(gateway, "agreements", "id,source_invoice_id,client_id,title,project_title,status,sent_at,viewed_at,expires_at,updated_at,renewal_amount,renewal_currency,renewal_due_date,clients(name,company,email,phone)")
        all_invoices = all_records(gateway, "invoices", "id,agreement_id,invoice_kind,renewal_source_invoice_id,renewal_period_date,invoice_number,project_title,status,project_value,currency,due_date,renewal_amount,renewal_currency,renewal_due_date,client_id,clients(name,company,email,phone)")
        invoices = [item for item in all_invoices if item["status"] != "void"]
        payments = all_records(gateway, "payments", "id,invoice_id,amount,currency,paid_at")
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
        awaiting = sum(1 for item in agreements if item.get("status") in {"sent", "viewed"})
        active_clients = sum(1 for item in clients if item.get("status") == "active")
        current = datetime.now(COLOMBO)

        paid_by_invoice: dict[str, Decimal] = defaultdict(Decimal)
        for payment in payments:
            paid_by_invoice[str(payment.get("invoice_id") or "")] += _money(payment.get("amount"))
        outstanding = sum((max(Decimal(), _money(item.get("project_value")) - paid_by_invoice[str(item["id"])]) for item in invoices if item.get("currency") == "LKR" and item.get("status") != "draft"), Decimal())

        invoice_cards: list[dict[str, Any]] = []
        renewal_cards: list[dict[str, Any]] = []
        settled_renewals = {(str(item.get("renewal_source_invoice_id")), str(item.get("renewal_period_date"))[:10])
                           for item in invoices if item.get("invoice_kind") == "renewal" and item.get("status") != "draft"
                           and paid_by_invoice[str(item["id"])] >= _money(item.get("project_value"))}
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
            if item.get("status") not in {"draft", "void"} and paid_amount < _money(item.get("project_value")):
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
            if item.get("renewal_amount") and renewal_due and (renewal_due.date() - current.date()).days <= 60 and (str(item["id"]), renewal_due.date().isoformat()) not in settled_renewals:
                renewal_cards.append(
                    {
                        "id": item.get("id"),
                        "invoice_id": item.get("id"),
                        "client_name": client.get("company") or client.get("name"),
                        "phone": client.get("phone"),
                        "email": client.get("email"), "project_title": item.get("project_title"),
                        "amount": item.get("renewal_amount"),
                        "currency": item.get("renewal_currency") or item.get("currency"),
                        "due_date": item.get("renewal_due_date"),
                    }
                )
        invoice_cards.sort(key=lambda item: (item.get("due_date") is None, str(item.get("due_date") or "")))
        linked_ids = {str(item.get("agreement_id")) for item in invoices if item.get("agreement_id")}
        invoice_ids = {str(item["id"]) for item in invoices}
        keys = {(str(item.get("client_id")), item.get("project_title"), item.get("renewal_due_date")) for item in invoices}
        for item in agreements:
            if item.get("status") in {"draft", "void", "expired"} or not item.get("renewal_due_date") or not item.get("renewal_amount"):
                continue
            if str(item["id"]) in linked_ids or str(item.get("source_invoice_id")) in invoice_ids or (str(item.get("client_id")), item.get("project_title"), item.get("renewal_due_date")) in keys:
                continue
            renewal_due = date.fromisoformat(str(item["renewal_due_date"])[:10])
            if (renewal_due - current.date()).days <= 60:
                client = item.get("clients") or {}
                renewal_cards.append({"id": f"agreement-{item['id']}", "client_name": client.get("company") or client.get("name"), "phone": client.get("phone"), "email": client.get("email"), "project_title": item.get("project_title"), "amount": item["renewal_amount"], "currency": item.get("renewal_currency") or "LKR", "due_date": item["renewal_due_date"]})
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
