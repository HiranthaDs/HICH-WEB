"""Cash receipts and receivables reported separately, in their original currencies."""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

COLOMBO = timezone(timedelta(hours=5, minutes=30))


def money(value) -> Decimal:
    return Decimal(str(value or 0))


def local_date(value) -> date | None:
    if not value:
        return None
    try:
        instant = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (instant.replace(tzinfo=timezone.utc) if instant.tzinfo is None else instant).astimezone(COLOMBO).date()
    except ValueError:
        return None


def income_report(invoices: list[dict], payments: list[dict], start: date, end: date, today: date) -> dict:
    by_id = {str(invoice["id"]): invoice for invoice in invoices}
    paid = defaultdict(Decimal)
    summaries = {}
    months = defaultdict(Decimal)
    methods = defaultdict(Decimal)
    clients = {}
    ledger = []

    def summary(currency):
        return summaries.setdefault(currency, {"currency": currency, "invoiced": Decimal(), "collected": Decimal(), "collected_on_void": Decimal(), "lifetime_collected": Decimal(), "outstanding": Decimal(), "draft_value": Decimal(), "overpayments": Decimal(), "overdue": Decimal(), "invoices": 0, "receipts": 0, "aging": {key: Decimal() for key in ("not_due", "1_30", "31_60", "61_90", "over_90", "no_due_date")}})

    for payment in payments:
        invoice = by_id.get(str(payment.get("invoice_id")))
        if not invoice:
            continue
        currency = payment.get("currency") or invoice.get("currency") or "LKR"
        amount = money(payment.get("amount"))
        if currency == (invoice.get("currency") or "LKR"):
            paid[str(invoice["id"])] += amount
        totals = summary(currency)
        totals["lifetime_collected"] += amount
        day = local_date(payment.get("paid_at"))
        if not day or not start <= day <= end:
            continue
        totals["collected"] += amount
        totals["receipts"] += 1
        if invoice.get("status") == "void":
            totals["collected_on_void"] += amount
        months[(currency, day.strftime("%Y-%m"))] += amount
        method = payment.get("method") or "Unspecified"
        methods[(currency, method)] += amount
        client = invoice.get("clients") or {}
        name = client.get("company") or client.get("name") or "Client"
        client_key = (currency, str(invoice.get("client_id")))
        entry = clients.setdefault(client_key, {"currency": currency, "client_id": invoice.get("client_id"), "name": name, "collected": Decimal(), "receipts": 0})
        entry["collected"] += amount; entry["receipts"] += 1
        ledger.append({"id": payment.get("id"), "invoice_id": invoice["id"], "client_id": invoice.get("client_id"), "client_name": name, "reference": invoice.get("invoice_number"), "project_title": invoice.get("project_title"), "amount": amount, "currency": currency, "method": method, "payment_reference": payment.get("reference"), "paid_at": payment.get("paid_at"), "invoice_status": invoice.get("status")})

    receivables = []
    for invoice in invoices:
        currency = invoice.get("currency") or "LKR"
        totals = summary(currency)
        value = money(invoice.get("project_value"))
        received = paid[str(invoice["id"])]
        if invoice.get("status") == "void":
            continue
        if invoice.get("status") == "draft":
            totals["draft_value"] += value
            continue
        totals["invoices"] += 1
        issued = date.fromisoformat(str(invoice["issue_date"])[:10]) if invoice.get("issue_date") else None
        if issued and start <= issued <= end:
            totals["invoiced"] += value
        balance = max(Decimal(), value - received)
        totals["overpayments"] += max(Decimal(), received - value)
        totals["outstanding"] += balance
        due = date.fromisoformat(str(invoice["due_date"])[:10]) if invoice.get("due_date") else None
        days = (today - due).days if due else None
        bucket = "no_due_date" if days is None else "not_due" if days <= 0 else "1_30" if days <= 30 else "31_60" if days <= 60 else "61_90" if days <= 90 else "over_90"
        totals["aging"][bucket] += balance
        if days and days > 0:
            totals["overdue"] += balance
        if balance:
            client = invoice.get("clients") or {}
            receivables.append({"invoice_id": invoice["id"], "client_id": invoice.get("client_id"), "reference": invoice.get("invoice_number"), "client_name": client.get("company") or client.get("name"), "project_title": invoice.get("project_title"), "currency": currency, "total": value, "paid": received, "balance": balance, "due_date": invoice.get("due_date"), "days_overdue": max(0, days or 0)})
    return {"start": start.isoformat(), "end": end.isoformat(), "as_of": today.isoformat(), "currencies": list(summaries.values()), "monthly": [{"currency": currency, "month": month, "collected": value} for (currency, month), value in sorted(months.items())], "methods": [{"currency": currency, "method": method, "collected": value} for (currency, method), value in sorted(methods.items())], "clients": sorted(clients.values(), key=lambda entry: entry["collected"], reverse=True), "ledger": sorted(ledger, key=lambda entry: str(entry["paid_at"]), reverse=True), "receivables": sorted(receivables, key=lambda entry: entry["days_overdue"], reverse=True), "note": "Cash receipts use payment dates in Asia/Colombo and include retained receipts on void invoices. Voiding is not a refund. Receivables are current balances on issued invoices; drafts and void invoices are excluded. This is a cash and receivables report, not net profit: expenses, refunds and exchange-rate conversion are not recorded here."}
