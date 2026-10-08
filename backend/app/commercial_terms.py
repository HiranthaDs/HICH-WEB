"""Commercial schedule validated once and displayed identically in signing and PDF."""
from decimal import Decimal
from fastapi import HTTPException

SCHEDULE_HEADING = "Project-specific commercial schedule"


def validate_commercial_schedule(record: dict) -> None:
    fee = Decimal(str(record.get("visiting_fee_lkr") or 0))
    amount = Decimal(str(record.get("amount") or 0))
    if fee and not Decimal(5000) <= fee <= Decimal(15000):
        raise HTTPException(422, "The visiting fee must be zero or between LKR 5,000 and LKR 15,000")
    if record.get("currency") == "LKR" and fee > amount:
        raise HTTPException(422, "The visiting fee cannot exceed the total project amount")
    phases = record.get("payment_schedule") or []
    if phases and sum((Decimal(str(p["amount"])) for p in phases), Decimal()) != amount:
        raise HTTPException(422, "The agreement payment schedule must add up to the project budget")
    if any(Decimal(str(p.get("received_amount") or 0)) > Decimal(str(p["amount"])) for p in phases):
        raise HTTPException(422, "Received amounts cannot exceed their scheduled milestone amount")


def scheduled_terms(record: dict) -> object:
    validate_commercial_schedule(record)
    terms = record.get("terms") or {}
    fee = Decimal(str(record.get("visiting_fee_lkr") or 0))
    phases = record.get("payment_schedule") or []
    if not fee and not phases and not record.get("payment_instructions") and not record.get("project_due_date"):
        if isinstance(terms, dict):
            return {key: value for key, value in terms.items() if key != SCHEDULE_HEADING}
        if isinstance(terms, list):
            return [item for item in terms if not str(item).startswith(SCHEDULE_HEADING + ": ")]
        return str(terms).split("\n\n" + SCHEDULE_HEADING + ": ", 1)[0]
    paragraphs = []
    if fee:
        paragraphs.append(f"Visiting fee: LKR {fee:,.2f}, payable before the confirmed visit. This booking fee is non-refundable once the agreed visit is delivered or the Client cancels the reserved visit, except where applicable law requires a refund or Hich Web cancels without an agreed replacement. It forms part of the project price and is credited once against the final balance after it is actually received and recorded on the invoice. It is not an extra project charge. For non-LKR projects, the parties must agree the conversion rate and credit in writing before collection.")
    if phases:
        paragraphs.append("Agreed payment schedule (snapshot at preparation):\n" + "\n".join(
            f"- {p['name']}: {record.get('currency', 'LKR')} {Decimal(str(p['amount'])):,.2f} — {'recorded paid' if p.get('is_paid') else 'pending'}; received at preparation: {record.get('currency', 'LKR')} {Decimal(str(p.get('received_amount') or 0)):,.2f}" for p in phases
        ) + "\nThe live invoice is the payment ledger. Later payments reduce the outstanding balance; they do not change the signed scope or agreed total.")
    if record.get("project_due_date"):
        paragraphs.append(f"Invoice payment due date: {record['project_due_date']}. Delivery milestones and their dependencies must be confirmed in the accepted scope.")
    if record.get("payment_instructions"):
        paragraphs.append("Payment instructions:\n" + record["payment_instructions"])
    body = "\n\n".join(paragraphs)
    if isinstance(terms, dict):
        return terms | {SCHEDULE_HEADING: body}
    marker = SCHEDULE_HEADING + ": "
    if isinstance(terms, list):
        return [item for item in terms if not str(item).startswith(marker)] + [marker + body]
    return str(terms).split("\n\n" + marker, 1)[0] + "\n\n" + marker + body
