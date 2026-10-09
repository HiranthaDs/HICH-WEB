"""Build a detailed agreement schedule from only the supplied commercial data."""
from decimal import Decimal
from fastapi import HTTPException

SCHEDULE_HEADING = "Project-specific commercial schedule"
VISIT_TERM_HEADINGS = {
    "32. Hich Web visiting fee and final-balance credit",
    "Visit and travel fees",
}
RENEWAL_TERM_HEADINGS = {
    "34. Renewal deadlines and disclosed late charges",
    "Renewal late-payment surcharge",
}
PAYMENT_TERM_HEADINGS = {"Payment schedule"}


def _money(value: object) -> Decimal | None:
    if value in (None, ""):
        return None
    return Decimal(str(value))


def _without_named_terms(terms: object, headings: set[str]) -> object:
    if isinstance(terms, dict):
        return {key: value for key, value in terms.items() if key not in headings}
    if isinstance(terms, list):
        return [item for item in terms if not any(str(item).startswith(f"{heading}: ") for heading in headings)]
    # Free-form custom terms remain authoritative. Only generated structured
    # template clauses are automatically filtered.
    return terms


def _with_default_terms(terms: object, headings: set[str]) -> object:
    if not isinstance(terms, dict):
        return terms
    # Structured generated terms can safely regain a previously inapplicable
    # standard clause when the administrator later supplies that detail.
    from .agreement_template import default_terms
    defaults = default_terms()
    result = dict(terms)
    for heading in headings:
        if heading in defaults:
            result.setdefault(heading, defaults[heading])
    return result


def _with_schedule(terms: object, body: str) -> object:
    if isinstance(terms, dict):
        return {key: value for key, value in terms.items() if key != SCHEDULE_HEADING} | {SCHEDULE_HEADING: body}
    marker = SCHEDULE_HEADING + ": "
    if isinstance(terms, list):
        return [item for item in terms if not str(item).startswith(marker)] + [marker + body]
    return str(terms).split("\n\n" + marker, 1)[0] + "\n\n" + marker + body


def validate_commercial_schedule(record: dict) -> None:
    fee = Decimal(str(record.get("visiting_fee_lkr") or 0))
    amount = _money(record.get("amount"))
    if fee and not Decimal(5000) <= fee <= Decimal(15000):
        raise HTTPException(422, "The visiting fee must be zero or between LKR 5,000 and LKR 15,000")
    if amount is not None and record.get("currency") == "LKR" and fee > amount:
        raise HTTPException(422, "The visiting fee cannot exceed the total project amount")
    phases = record.get("payment_schedule") or []
    if phases and amount is not None and sum((Decimal(str(p["amount"])) for p in phases), Decimal()) != amount:
        raise HTTPException(422, "The agreement payment schedule must add up to the project budget")
    if any(Decimal(str(p.get("received_amount") or 0)) > Decimal(str(p["amount"])) for p in phases):
        raise HTTPException(422, "Received amounts cannot exceed their scheduled milestone amount")


def scheduled_terms(record: dict, *, validate: bool = True) -> object:
    terms = record.get("terms") or {}
    if validate:
        validate_commercial_schedule(record)
    if record.get("commercial_details_visible", True) is False:
        terms = _without_named_terms(terms, VISIT_TERM_HEADINGS | RENEWAL_TERM_HEADINGS | PAYMENT_TERM_HEADINGS)
        return _with_schedule(
            terms,
            "This is a scope-only agreement. Project prices, payment milestones, visiting fees, "
            "payment instructions and renewal figures are intentionally excluded from this document. "
            "No charge is created by this agreement unless a separate written quotation or invoice is accepted.",
        )

    fee = Decimal(str(record.get("visiting_fee_lkr") or 0))
    amount = _money(record.get("amount"))
    phases = record.get("payment_schedule") or []
    renewal_amount = _money(record.get("renewal_amount"))
    has_renewal = bool(renewal_amount or record.get("renewal_due_date"))
    if not fee:
        terms = _without_named_terms(terms, VISIT_TERM_HEADINGS)
    else:
        terms = _with_default_terms(terms, VISIT_TERM_HEADINGS)
    if not has_renewal:
        terms = _without_named_terms(terms, RENEWAL_TERM_HEADINGS)
    else:
        terms = _with_default_terms(terms, RENEWAL_TERM_HEADINGS)
    if not phases:
        terms = _without_named_terms(terms, PAYMENT_TERM_HEADINGS)
    else:
        terms = _with_default_terms(terms, PAYMENT_TERM_HEADINGS)

    paragraphs = []
    if amount is not None and amount > 0:
        paragraphs.append(
            f"Project total: {record.get('currency', 'LKR')} {amount:,.2f}. This is the total recorded for the "
            "agreed scope, subject only to written change approval, separately accepted third-party charges "
            "and any mandatory tax expressly itemised on an invoice."
        )
    else:
        has_itemised_charge = bool(fee or phases or renewal_amount)
        paragraphs.append(
            "No overall project total is stated in this agreement. "
            + (
                "Only the individual charges expressly itemised below form part of this agreement; every other "
                "development price, deposit, instalment or charge requires a separate accepted written quotation or invoice."
                if has_itemised_charge
                else "No development price, deposit, instalment or other charge becomes payable unless it is set out "
                "in a separate written quotation or invoice and accepted."
            )
        )
    if fee:
        credit = (
            "It forms part of the stated project price and is credited once against the final balance after it is "
            "actually received and recorded on the invoice; it must not be charged twice."
            if amount is not None and amount > 0
            else "Because no overall project total is stated, it is the charge for the agreed visit. It is credited "
            "against a later project price only if the later accepted quotation or invoice expressly records that credit."
        )
        paragraphs.append(f"Visiting fee: LKR {fee:,.2f}, payable before the confirmed visit. This booking fee is non-refundable once the agreed visit is delivered or the Client cancels the reserved visit, except where applicable law requires a refund or Hich Web cancels without an agreed replacement. {credit} For non-LKR projects, the parties must agree the conversion rate and credit in writing before collection.")
    if phases:
        paragraphs.append("Agreed payment schedule (snapshot at preparation):\n" + "\n".join(
            f"- {p['name']}: {record.get('currency', 'LKR')} {Decimal(str(p['amount'])):,.2f} — {'recorded paid' if p.get('is_paid') else 'pending'}; received at preparation: {record.get('currency', 'LKR')} {Decimal(str(p.get('received_amount') or 0)):,.2f}" for p in phases
        ) + "\nThe live invoice is the payment ledger. Later payments reduce the outstanding balance; they do not change the signed scope or agreed total.")
    if record.get("project_due_date"):
        paragraphs.append(f"Invoice payment due date: {record['project_due_date']}. Delivery milestones and their dependencies must be confirmed in the accepted scope.")
    if record.get("payment_instructions"):
        paragraphs.append("Payment instructions:\n" + record["payment_instructions"])
    if has_renewal:
        details = []
        if renewal_amount:
            details.append(f"annual renewal amount: {record.get('renewal_currency') or 'LKR'} {renewal_amount:,.2f}")
        if record.get("renewal_due_date"):
            details.append(f"service expiry / renewal due date: {record['renewal_due_date']}")
        paragraphs.append(
            "Renewal details: " + "; ".join(details) + ". Renewal is separate from the development total, "
            "requires cleared payment and provider confirmation, and is governed by the detailed renewal clause below."
        )
    return _with_schedule(terms, "\n\n".join(paragraphs))
