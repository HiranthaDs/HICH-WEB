from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timezone
from decimal import Decimal, InvalidOperation
from typing import Any


def _money(value: object) -> Decimal:
    try:
        return Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal()


def _moment(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        try:
            parsed_date = date.fromisoformat(str(value)[:10])
            return datetime.combine(parsed_date, time.min, tzinfo=timezone.utc)
        except (TypeError, ValueError):
            return None


def _insight(
    insight_id: str,
    severity: str,
    category: str,
    title: str,
    summary: str,
    recommendation: str,
    action_label: str,
    action_path: str,
    impact: int,
) -> dict[str, Any]:
    return {
        "id": insight_id,
        "severity": severity,
        "category": category,
        "title": title,
        "summary": summary,
        "recommendation": recommendation,
        "action_label": action_label,
        "action_path": action_path,
        "impact": impact,
    }


def analyze_business(
    *,
    clients: list[dict[str, Any]],
    agreements: list[dict[str, Any]],
    invoices: list[dict[str, Any]],
    payments: list[dict[str, Any]],
    projects: list[dict[str, Any]],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Create deterministic, explainable operating insights from workspace data."""

    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    payment_by_invoice: dict[str, Decimal] = defaultdict(Decimal)
    for payment in payments:
        payment_by_invoice[str(payment.get("invoice_id") or "")] += _money(payment.get("amount"))

    open_invoices: list[tuple[dict[str, Any], Decimal, datetime | None]] = []
    overdue: list[tuple[dict[str, Any], Decimal, datetime]] = []
    forecast = Decimal()
    for invoice in invoices:
        if invoice.get("status") in {"paid", "void"}:
            continue
        balance = max(
            Decimal(),
            _money(invoice.get("project_value") or invoice.get("amount"))
            - payment_by_invoice[str(invoice.get("id") or "")],
        )
        due = _moment(invoice.get("due_date"))
        open_invoices.append((invoice, balance, due))
        if due and due.date() < current.date() and balance > 0:
            overdue.append((invoice, balance, due))
        if balance > 0 and due and 0 <= (due.date() - current.date()).days <= 30:
            weight = Decimal("0.8") if invoice.get("status") == "partial" else Decimal("0.65")
            forecast += balance * weight

    renewals = []
    for invoice in invoices:
        due = _moment(invoice.get("renewal_due_date"))
        amount = _money(invoice.get("renewal_amount"))
        if due and amount > 0 and -14 <= (due.date() - current.date()).days <= 45:
            renewals.append((invoice, amount, due))
            if 0 <= (due.date() - current.date()).days <= 30:
                forecast += amount * Decimal("0.7")

    stale_agreements = []
    expiring_agreements = []
    for agreement in agreements:
        if agreement.get("status") not in {"sent", "viewed"}:
            continue
        last_touch = _moment(agreement.get("viewed_at") or agreement.get("sent_at") or agreement.get("updated_at"))
        if last_touch and (current - last_touch).days >= 7:
            stale_agreements.append(agreement)
        expiry = _moment(agreement.get("expires_at"))
        if expiry and 0 <= (expiry.date() - current.date()).days <= 7:
            expiring_agreements.append(agreement)

    paid_90 = Decimal()
    paid_previous_90 = Decimal()
    for payment in payments:
        paid_at = _moment(payment.get("paid_at"))
        if not paid_at or payment.get("currency", "LKR") != "LKR":
            continue
        age = (current - paid_at).days
        if 0 <= age < 90:
            paid_90 += _money(payment.get("amount"))
        elif 90 <= age < 180:
            paid_previous_90 += _money(payment.get("amount"))
    momentum: float | None = None
    if paid_previous_90 > 0:
        momentum = round(float((paid_90 - paid_previous_90) / paid_previous_90 * 100), 1)

    published = sum(1 for project in projects if project.get("published"))
    active_clients = [client for client in clients if client.get("status") == "active"]
    unreachable_clients = [client for client in active_clients if not client.get("email") and not client.get("phone")]
    overdue_balance = sum((balance for _, balance, _ in overdue), Decimal())

    insights: list[dict[str, Any]] = []
    if overdue:
        oldest_days = max((current.date() - due.date()).days for _, _, due in overdue)
        insights.append(_insight(
            "overdue-cash", "critical" if oldest_days >= 30 else "warning", "Cash flow",
            f"{len(overdue)} overdue invoice{'s' if len(overdue) != 1 else ''} need attention",
            f"LKR {overdue_balance:,.0f} is overdue; the oldest balance is {oldest_days} days late.",
            "Contact the oldest overdue client first, record any payment, then work down by balance.",
            "Review invoices", "/admin/invoices", 100 + oldest_days,
        ))
    if stale_agreements:
        insights.append(_insight(
            "stale-signatures", "warning", "Pipeline",
            f"{len(stale_agreements)} agreement{'s are' if len(stale_agreements) != 1 else ' is'} waiting for a response",
            "These agreements have been sent or viewed but have had no progress for at least seven days.",
            "Reshare each secure signing link with a short personal follow-up.",
            "Follow up", "/admin/agreements", 80 + len(stale_agreements),
        ))
    elif expiring_agreements:
        insights.append(_insight(
            "expiring-agreements", "warning", "Pipeline",
            f"{len(expiring_agreements)} agreement{'s expire' if len(expiring_agreements) != 1 else ' expires'} this week",
            "A timely reminder can prevent the signing link from expiring.",
            "Contact the client before the expiry date.",
            "Review agreements", "/admin/agreements", 75,
        ))
    if renewals:
        renewal_total = sum((amount for _, amount, _ in renewals), Decimal())
        insights.append(_insight(
            "renewal-window", "opportunity", "Retention",
            f"{len(renewals)} renewal{'s are' if len(renewals) != 1 else ' is'} in the next 45 days",
            f"The renewal opportunity is worth approximately LKR {renewal_total:,.0f}.",
            "Confirm scope and send renewal reminders before the due dates.",
            "Open invoices", "/admin/invoices", 60 + len(renewals),
        ))
    if projects and published == 0:
        insights.append(_insight(
            "portfolio-hidden", "opportunity", "Growth", "Your portfolio is not publishing any work",
            f"All {len(projects)} portfolio project{'s are' if len(projects) != 1 else ' is'} currently hidden.",
            "Publish the strongest completed case study to turn the public site into a lead source.",
            "Manage portfolio", "/admin/portfolio", 55,
        ))
    elif not projects:
        insights.append(_insight(
            "portfolio-empty", "opportunity", "Growth", "Add proof of your best work",
            "The public portfolio has no project stories yet.",
            "Create one concise case study with a result, process summary and two strong images.",
            "Add a project", "/admin/portfolio", 50,
        ))
    if unreachable_clients:
        insights.append(_insight(
            "missing-contacts", "info", "Data quality",
            f"{len(unreachable_clients)} active client record{'s need' if len(unreachable_clients) != 1 else ' needs'} contact details",
            "Reminders and document delivery work best when each active client has an email or phone number.",
            "Complete the missing client details.",
            "Review clients", "/admin/clients", 35,
        ))
    if momentum is not None and momentum >= 15:
        insights.append(_insight(
            "revenue-momentum", "success", "Growth", "Revenue momentum is improving",
            f"Collected revenue over the latest 90 days is {momentum:.1f}% higher than the previous period.",
            "Protect the momentum by following up on open invoices and upcoming renewals.",
            "View cash flow", "/admin/invoices", 45,
        ))
    if not insights:
        insights.append(_insight(
            "healthy-operations", "success", "Operations", "The workspace looks healthy",
            "There are no overdue cash, stale signature or portfolio visibility issues in the current data.",
            "Keep client and payment activity current so the signal remains accurate.",
            "View activity", "/admin/activity", 20,
        ))

    score = 100
    score -= min(35, len(overdue) * 10 + int(min(overdue_balance / Decimal("100000"), 15)))
    if overdue:
        oldest_days = max((current.date() - due.date()).days for _, _, due in overdue)
        score -= min(20, max(5, oldest_days // 3))
    score -= min(20, len(stale_agreements) * 5)
    score -= min(10, len(expiring_agreements) * 3)
    score -= 8 if projects and published == 0 else 0
    score -= min(10, len(unreachable_clients) * 2)
    score = max(0, min(100, score))
    risk_level = "high" if score < 55 else "medium" if score < 80 else "low"
    sorted_insights = sorted(insights, key=lambda item: item["impact"], reverse=True)[:5]

    if overdue:
        narrative = "Cash collection is the highest-priority action, followed by signature follow-ups and renewals."
    elif stale_agreements:
        narrative = "The financial picture is stable, but the agreement pipeline needs follow-up to keep work moving."
    elif renewals:
        narrative = "Operations are stable, with a near-term opportunity to secure upcoming renewals."
    else:
        narrative = "No urgent operational risk is visible. Keep records current and focus on steady pipeline growth."

    return {
        "health_score": score,
        "risk_level": risk_level,
        "narrative": narrative,
        "cash_forecast_30d": float(forecast.quantize(Decimal("0.01"))),
        "overdue_balance": float(overdue_balance.quantize(Decimal("0.01"))),
        "revenue_momentum_percent": momentum,
        "generated_at": current.isoformat(),
        "insights": sorted_insights,
    }
