"""Deterministic calendar events derived from invoices, receipts and renewals."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from .income import local_date


def _money(value: object) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal()


def _date(value: object) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _client(record: dict[str, Any]) -> tuple[object, str]:
    client = record.get("clients") or {}
    return record.get("client_id"), client.get("company") or client.get("name") or "Client"


def _renewal_key(record: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(record.get("client_id") or ""),
        str(record.get("project_title") or record.get("title") or "").strip().casefold(),
        str(record.get("renewal_due_date") or "")[:10],
    )


def calendar_report(
    invoices: list[dict[str, Any]],
    payments: list[dict[str, Any]],
    agreements: list[dict[str, Any]],
    start: date,
    end: date,
) -> dict[str, Any]:
    """Build calendar events for an inclusive date range.

    Receipt dates are converted to Asia/Colombo by ``income.local_date``. Receipts
    remain visible when their invoice is later voided because voiding is not a
    refund. Future due events, however, exclude voided or deleted documents.
    """

    by_invoice = {str(invoice.get("id")): invoice for invoice in invoices if invoice.get("id")}
    paid_by_invoice: dict[str, Decimal] = defaultdict(Decimal)
    events: list[dict[str, Any]] = []

    for index, payment in enumerate(payments):
        invoice = by_invoice.get(str(payment.get("invoice_id") or ""))
        if not invoice:
            continue
        invoice_currency = invoice.get("currency") or "LKR"
        payment_currency = payment.get("currency") or invoice_currency
        if payment_currency == invoice_currency:
            paid_by_invoice[str(invoice.get("id"))] += _money(payment.get("amount"))

        if payment.get("date_confirmed") is False:
            continue
        received = local_date(payment.get("paid_at"))
        if not received or not start <= received <= end:
            continue
        client_id, client_name = _client(invoice)
        reference = invoice.get("invoice_number")
        payment_id = payment.get("id") or f"{invoice.get('id')}-{index}"
        events.append(
            {
                "id": f"receipt:{payment_id}",
                "type": "receipt",
                "date": received.isoformat(),
                "title": f"Payment received · {reference or invoice.get('project_title') or client_name}",
                "amount": _money(payment.get("amount")),
                "currency": payment_currency,
                "client_id": client_id,
                "client_name": client_name,
                "invoice_id": invoice.get("id"),
                "reference": reference,
                "project_title": invoice.get("project_title"),
                "status": "received",
                "invoice_status": invoice.get("status"),
                "method": payment.get("method"),
                "payment_reference": payment.get("reference"),
            }
        )

    for invoice in invoices:
        if invoice.get("deleted_at") or invoice.get("status") in {"draft", "void"}:
            continue
        due = _date(invoice.get("due_date"))
        if not due or not start <= due <= end:
            continue
        total = _money(invoice.get("project_value"))
        balance = max(Decimal(), total - paid_by_invoice[str(invoice.get("id"))])
        if balance <= 0:
            continue
        client_id, client_name = _client(invoice)
        reference = invoice.get("invoice_number")
        events.append(
            {
                "id": f"invoice-due:{invoice.get('id')}",
                "type": "invoice_due",
                "date": due.isoformat(),
                "title": f"Invoice due · {reference or invoice.get('project_title') or client_name}",
                "amount": balance,
                "currency": invoice.get("currency") or "LKR",
                "client_id": client_id,
                "client_name": client_name,
                "invoice_id": invoice.get("id"),
                "reference": reference,
                "project_title": invoice.get("project_title"),
                "status": invoice.get("status") or "sent",
                "invoice_status": invoice.get("status"),
            }
        )

    renewal_bills: dict[tuple[str, str], dict[str, Any]] = {}
    for invoice in invoices:
        if (
            invoice.get("deleted_at")
            or invoice.get("status") == "void"
            or invoice.get("invoice_kind") != "renewal"
            or not invoice.get("renewal_source_invoice_id")
            or not invoice.get("renewal_period_date")
        ):
            continue
        renewal_bills[(str(invoice["renewal_source_invoice_id"]), str(invoice["renewal_period_date"])[:10])] = invoice

    project_invoices = [
        invoice
        for invoice in invoices
        if (invoice.get("invoice_kind") or "project") == "project"
        and invoice.get("status") != "void"
        and not invoice.get("deleted_at")
    ]
    renewal_sources = [
        invoice
        for invoice in project_invoices
        if _money(invoice.get("renewal_amount")) > 0 and _date(invoice.get("renewal_due_date"))
    ]
    represented_agreements = {str(invoice.get("agreement_id")) for invoice in renewal_sources if invoice.get("agreement_id")}
    represented_invoice_ids = {str(invoice.get("id")) for invoice in renewal_sources if invoice.get("id")}
    represented_keys = {_renewal_key(invoice) for invoice in renewal_sources}

    for invoice in renewal_sources:
        due = _date(invoice.get("renewal_due_date"))
        amount = _money(invoice.get("renewal_amount"))
        if amount <= 0 or not due or not start <= due <= end:
            continue
        bill = renewal_bills.get((str(invoice.get("id")), due.isoformat()))
        client_id, client_name = _client(invoice)
        event_invoice = bill or invoice
        event_amount = _money(bill.get("project_value")) if bill else amount
        events.append(
            {
                "id": f"renewal-due:invoice:{invoice.get('id')}:{due.isoformat()}",
                "type": "renewal_due",
                "date": due.isoformat(),
                "title": f"Renewal due · {invoice.get('project_title') or client_name}",
                "amount": event_amount,
                "currency": (bill.get("currency") if bill else invoice.get("renewal_currency")) or invoice.get("currency") or "LKR",
                "client_id": client_id,
                "client_name": client_name,
                "invoice_id": event_invoice.get("id"),
                "source_invoice_id": invoice.get("id"),
                "reference": event_invoice.get("invoice_number"),
                "project_title": invoice.get("project_title"),
                "status": bill.get("status") if bill else "scheduled",
                "invoice_status": bill.get("status") if bill else None,
            }
        )

    for agreement in agreements:
        due = _date(agreement.get("renewal_due_date"))
        amount = _money(agreement.get("renewal_amount"))
        if (
            agreement.get("deleted_at")
            or agreement.get("status") in {"draft", "void", "expired"}
            or amount <= 0
            or not due
            or not start <= due <= end
            or str(agreement.get("id")) in represented_agreements
            or str(agreement.get("source_invoice_id")) in represented_invoice_ids
            or _renewal_key(agreement) in represented_keys
        ):
            continue
        client_id, client_name = _client(agreement)
        events.append(
            {
                "id": f"renewal-due:agreement:{agreement.get('id')}:{due.isoformat()}",
                "type": "renewal_due",
                "date": due.isoformat(),
                "title": f"Renewal due · {agreement.get('project_title') or agreement.get('title') or client_name}",
                "amount": amount,
                "currency": agreement.get("renewal_currency") or agreement.get("currency") or "LKR",
                "client_id": client_id,
                "client_name": client_name,
                "agreement_id": agreement.get("id"),
                "reference": agreement.get("reference"),
                "project_title": agreement.get("project_title") or agreement.get("title"),
                "status": "scheduled",
            }
        )

    order = {"receipt": 0, "invoice_due": 1, "renewal_due": 2}
    events.sort(key=lambda event: (event["date"], order.get(str(event["type"]), 9), str(event["id"])))
    return {"start": start.isoformat(), "end": end.isoformat(), "events": events}
