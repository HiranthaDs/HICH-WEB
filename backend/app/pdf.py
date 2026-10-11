from __future__ import annotations

from html import escape
from io import BytesIO
from pathlib import Path
from decimal import Decimal
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.platypus import Image as PlatypusImage

from .commercial_terms import scheduled_terms


def _text(value: object) -> str:
    return escape("" if value is None else str(value)).replace("\n", "<br/>")


def _money(value: object, currency: str = "LKR") -> str:
    return f"{currency} {Decimal(str(value or 0)):,.2f}"


def invoice_pdf(invoice: dict[str, Any]) -> bytes:
    """Render a portable A4 invoice with repeatable table headers and receipt ledger."""
    output = BytesIO()
    reference = str(invoice.get("reference") or invoice.get("invoice_number") or "Invoice")
    document = SimpleDocTemplate(output, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                                 topMargin=18 * mm, bottomMargin=20 * mm,
                                 title=f"Invoice {reference}", author="Hich Web")
    styles = getSampleStyleSheet()
    styles["BodyText"].fontSize = 9
    styles["BodyText"].leading = 13
    styles["BodyText"].spaceBefore = 0
    styles["BodyText"].spaceAfter = 0
    styles["Heading2"].textColor = colors.HexColor("#3348A0")
    styles["Heading2"].fontSize = 12
    styles["Heading2"].leading = 16
    styles["Heading2"].spaceBefore = 6
    styles["Heading2"].keepWithNext = True
    styles.add(ParagraphStyle(name="Money", parent=styles["BodyText"], alignment=TA_RIGHT))
    story: list[Any] = []
    currency = invoice.get("currency") or "LKR"
    p = lambda value: Paragraph(_text(value), styles["BodyText"])

    def table(headers: list[str], rows: list[list[object]], widths: list[float]) -> Table:
        result = Table([[p(value) for value in headers]] + [[p(value) for value in row] for row in rows],
                       colWidths=[width * mm for width in widths], repeatRows=1, hAlign="LEFT")
        result.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EDF0FA")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("LINEBELOW", (0, 0), (-1, -1), .3, colors.HexColor("#DFE3EB")),
        ]))
        return result

    renewal = invoice.get("invoice_kind") == "renewal"
    story.extend([Paragraph("HICH WEB", styles["Heading2"]),
                  Paragraph("RENEWAL INVOICE" if renewal else "INVOICE", styles["Title"]),
                  p(f"{reference}  |  {str(invoice.get('status') or 'draft').upper()}  |  Revision {invoice.get('revision') or 1}"),
                  Spacer(1, 6 * mm)])
    client = invoice.get("client") or invoice.get("clients") or {}
    if not isinstance(client, dict):
        client = {"name": client}
    story.append(table(["Billed to", "Invoice details"], [[
        "\n".join(str(value) for value in [invoice.get("client_name") or client.get("company") or client.get("name"), client.get("phone") or invoice.get("phone")] if value),
        f"Issued: {str(invoice.get('issue_date') or '-')[:10]}\nPayment due: {str(invoice.get('due_date') or '-')[:10]}",
    ]], [90, 84]))
    story.extend([Spacer(1, 5 * mm), Paragraph(_text(invoice.get("project_title") or "Services"), styles["Heading2"])])
    charges = [[item.get("description"), _money(item.get("amount"), currency)] for item in invoice.get("renewal_items", [])]
    if not charges:
        charges = [[invoice.get("project_title") or "Development services", _money(invoice.get("amount") or invoice.get("project_value"), currency)]]
    if renewal and Decimal(str(invoice.get("renewal_late_fee") or 0)) > 0:
        charges.append(["Agreed late-payment surcharge (18%, once)", _money(invoice["renewal_late_fee"], currency)])
    story.append(table(["Description", "Amount"], charges, [119, 55]))
    total = Decimal(str(invoice.get("amount") or invoice.get("project_value") or 0))
    paid = Decimal(str(invoice.get("paid_amount") or 0))
    story.extend([Spacer(1, 4 * mm), table(["Invoice total", "Received", "Balance due"],
                 [[_money(total, currency), _money(paid, currency), _money(max(Decimal(), total - paid), currency)]], [58, 58, 58])])
    phases = invoice.get("payments") or []
    if phases:
        story.extend([Spacer(1, 5 * mm), Paragraph("Payment plan", styles["Heading2"]),
            table(["Milestone", "Amount", "Received", "Status"], [[
                phase.get("name"), _money(phase.get("amount"), currency), _money(phase.get("paid_amount"), currency),
                "Paid" if phase.get("is_paid") else "Part paid" if Decimal(str(phase.get("paid_amount") or 0)) else "Pending",
            ] for phase in phases], [68, 40, 40, 26])])
    receipts = invoice.get("payment_records") or []
    if receipts:
        story.extend([Spacer(1, 5 * mm), Paragraph("Payments received", styles["Heading2"]),
            table(["Receipt", "Date", "Method", "Amount"], [[
                receipt.get("receipt_number") or "Recorded payment", "Not recorded" if receipt.get("date_confirmed") is False else str(receipt.get("paid_at") or "")[:10],
                receipt.get("method") or "Payment", _money(receipt.get("amount"), receipt.get("currency") or currency),
            ] for receipt in receipts], [49, 31, 47, 47])])
    for heading, value in [("Payment instructions", invoice.get("payment_instructions") if total > paid else None), ("Note", invoice.get("customer_note"))]:
        if value:
            story.extend([Spacer(1, 4 * mm), Paragraph(heading, styles["Heading2"]), p(value)])
    if renewal:
        story.extend([Spacer(1, 4 * mm), p("Payment status confirms funds received. Service renewal is confirmed separately after provider processing.")])

    def footer(canvas: Any, doc: Any) -> None:
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#667085"))
        canvas.drawString(18 * mm, 11 * mm, f"Hich Web | {reference}")
        canvas.drawRightString(A4[0] - 18 * mm, 11 * mm, f"Page {doc.page}")
        canvas.restoreState()

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()


def agreement_pdf(agreement: dict[str, Any], signature_bytes: bytes | None = None) -> bytes:
    """Render a stable, server-generated agreement record without executing user HTML."""

    if agreement.get("signed_snapshot"):
        agreement = agreement | agreement["signed_snapshot"] | {"clients": {}, "portfolio_projects": {}}
    if agreement.get("commercial_details_visible", True) is False:
        agreement = agreement | {"terms": scheduled_terms(agreement | {"commercial_details_visible": False}, validate=False)}
    output = BytesIO()
    document = SimpleDocTemplate(
        output,
        pagesize=A4,
        rightMargin=22 * mm,
        leftMargin=22 * mm,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        title=str(agreement.get("title") or "Agreement"),
        author="Hich Web",
    )
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="CenteredTitle", parent=styles["Title"], alignment=TA_CENTER, spaceAfter=12))
    styles.add(ParagraphStyle(name="SmallMuted", parent=styles["BodyText"], fontSize=8, textColor=colors.HexColor("#667085")))
    styles["BodyText"].leading = 14
    styles["BodyText"].fontSize = 9
    styles["Heading2"].textColor = colors.HexColor("#3348A0")
    styles["Heading2"].keepWithNext = True
    story: list[Any] = []
    logo_path = Path(__file__).resolve().parents[2] / "hich.png"
    if not logo_path.exists():
        logo_path = Path(__file__).resolve().parents[2] / "frontend" / "public" / "hich.png"
    if logo_path.exists():
        logo = PlatypusImage(str(logo_path), width=35 * mm, height=17 * mm, kind="proportional")
        logo.hAlign = "LEFT"
        story.extend([logo, Spacer(1, 4 * mm)])
    story.extend([
        Paragraph(_text(agreement.get("title") or "Agreement"), styles["CenteredTitle"]),
        Paragraph(f"Reference: {_text(agreement.get('reference') or agreement.get('public_id') or agreement.get('id'))} | Version {_text(agreement.get('version', 1))}", styles["SmallMuted"]),
        Spacer(1, 8 * mm),
    ])
    client = agreement.get("clients") or {}
    show_commercial = agreement.get("commercial_details_visible", True) is not False
    details = [
        ["Client", _text(agreement.get("client_name") or client.get("company") or client.get("name"))],
        ["Email", _text(agreement.get("client_email") or client.get("email"))],
        ["Phone", _text(agreement.get("client_phone") or client.get("phone"))],
        ["Project", _text(agreement.get("project_title"))],
        ["Status", _text(str(agreement.get("status") or "draft").upper())],
    ]
    if show_commercial and agreement.get("amount") is not None and float(agreement["amount"]) > 0:
        details.insert(-1, ["Project total", _text(_money(agreement.get('amount'), agreement.get('currency') or 'LKR'))])
    if show_commercial and float(agreement.get("visiting_fee_lkr") or 0) > 0:
        details.append(["Visiting fee", _text(_money(agreement["visiting_fee_lkr"]))])
    if show_commercial and agreement.get("renewal_amount") is not None and float(agreement["renewal_amount"]) > 0:
        details.append(["Annual renewal", _text(_money(agreement.get('renewal_amount'), agreement.get('renewal_currency') or 'LKR'))])
    if show_commercial and agreement.get("renewal_due_date"):
        details.append(["Service expires / renews", _text(agreement["renewal_due_date"])])
    details = [[Paragraph(label, styles["BodyText"]), Paragraph(value, styles["BodyText"])] for label, value in details]
    table = Table(details, colWidths=[40 * mm, 126 * mm], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F2F4F7")),
                ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#344054")),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D0D5DD")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                ("PADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    story.extend([table, Spacer(1, 6 * mm), Paragraph("Project scope", styles["Heading2"])])
    for paragraph in str(agreement.get("description") or "").split("\n\n"):
        is_heading = len(paragraph) < 180 and paragraph.split(".", 1)[0].isdigit()
        story.extend([Paragraph(_text(paragraph), styles["Heading2"] if is_heading else styles["BodyText"]), Spacer(1, 3 * mm)])

    terms = agreement.get("terms")
    if terms:
        story.extend([Spacer(1, 4 * mm), Paragraph("Terms", styles["Heading2"])])
        if isinstance(terms, list):
            for item in terms:
                story.append(Paragraph(f"• {_text(item)}", styles["BodyText"]))
        elif isinstance(terms, dict):
            ordered = sorted(terms.items(), key=lambda item: item[0] != "Project-specific commercial schedule")
            for key, value in ordered:
                story.append(Paragraph(_text(key), styles["Heading2"]))
                for paragraph in str(value).split("\n\n"):
                    story.extend([Paragraph(_text(paragraph), styles["BodyText"]), Spacer(1, 2 * mm)])
        else:
            for paragraph in str(terms).split("\n\n"):
                story.extend([Paragraph(_text(paragraph), styles["BodyText"]), Spacer(1, 2 * mm)])

    if agreement.get("status") == "signed":
        story.extend(
            [
                Spacer(1, 8 * mm),
                Paragraph("Electronic Signature Record", styles["Heading2"]),
                Paragraph(f"Signed by: {_text(agreement.get('signer_name'))}", styles["BodyText"]),
                Paragraph(f"Job role: {_text(agreement.get('signer_job_role'))}", styles["BodyText"]),
                Paragraph(f"Signer email: {_text(agreement.get('signer_email'))}", styles["BodyText"]),
                Paragraph(f"Signed at (UTC): {_text(agreement.get('signed_at'))}", styles["BodyText"]),
                Paragraph(f"Consent: {_text(agreement.get('consent_text'))}", styles["BodyText"]),
                Paragraph(f"Content SHA-256: {_text(agreement.get('content_sha256'))}", styles["SmallMuted"]),
                Paragraph(f"Record SHA-256: {_text(agreement.get('signed_record_sha256'))}", styles["SmallMuted"]),
            ]
        )
        if signature_bytes:
            signature_stream = BytesIO(signature_bytes)
            signature_image = PlatypusImage(signature_stream, width=55 * mm, height=22 * mm, kind="proportional")
            story.extend([Spacer(1, 3 * mm), signature_image])
        elif agreement.get("typed_signature"):
            typed_style = ParagraphStyle(
                name="TypedSignature",
                parent=styles["BodyText"],
                fontName="Times-Italic",
                fontSize=20,
                leading=24,
                textColor=colors.HexColor("#101828"),
            )
            story.extend([Spacer(1, 3 * mm), Paragraph(_text(agreement.get("typed_signature")), typed_style)])
        story.extend(
            [
                Spacer(1, 2 * mm),
                Paragraph("Electronic signature", styles["SmallMuted"]),
                Paragraph("This record captures affirmative consent, timestamp, signature digest, and request metadata.", styles["SmallMuted"]),
            ]
        )
    def footer(canvas: Any, doc: Any) -> None:
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#667085"))
        canvas.drawString(22 * mm, 11 * mm, f"Hich Web | {str(agreement.get('reference') or 'Agreement')[:48]}")
        canvas.drawRightString(A4[0] - 22 * mm, 11 * mm, f"Page {doc.page}")
        canvas.restoreState()

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()
