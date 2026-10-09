from __future__ import annotations

from html import escape
from io import BytesIO
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.platypus import Image as PlatypusImage


def _text(value: object) -> str:
    return escape("" if value is None else str(value)).replace("\n", "<br/>")


def agreement_pdf(agreement: dict[str, Any], signature_bytes: bytes | None = None) -> bytes:
    """Render a stable, server-generated agreement record without executing user HTML."""

    if agreement.get("signed_snapshot"):
        agreement = agreement | agreement["signed_snapshot"] | {"clients": {}, "portfolio_projects": {}}
    output = BytesIO()
    document = SimpleDocTemplate(
        output,
        pagesize=A4,
        rightMargin=22 * mm,
        leftMargin=22 * mm,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        title=str(agreement.get("title") or "Agreement"),
        author="Hich",
    )
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="CenteredTitle", parent=styles["Title"], alignment=TA_CENTER, spaceAfter=12))
    styles.add(ParagraphStyle(name="SmallMuted", parent=styles["BodyText"], fontSize=8, textColor=colors.HexColor("#667085")))
    styles["BodyText"].leading = 14
    story: list[Any] = []
    logo_path = Path(__file__).resolve().parents[2] / "hich.png"
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
    if show_commercial:
        details.insert(-1, ["Budget", f"{_text(agreement.get('currency') or 'LKR')} {_text(agreement.get('amount') if agreement.get('amount') is not None else 'Not specified')}"])
    if show_commercial and agreement.get("renewal_amount") is not None:
        details.extend([
            ["Annual renewal", f"{_text(agreement.get('renewal_currency') or 'LKR')} {_text(agreement.get('renewal_amount'))}"],
            ["Service expires / renews", _text(agreement.get("renewal_due_date") or "To be agreed")],
        ])
    details = [[Paragraph(label, styles["BodyText"]), Paragraph(value, styles["BodyText"])] for label, value in details]
    table = Table(details, colWidths=[35 * mm, 115 * mm])
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
    story.extend([table, Spacer(1, 8 * mm), Paragraph("Agreement", styles["Heading2"])])
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
            for key, value in terms.items():
                story.append(Paragraph(f"<b>{_text(key)}</b>: {_text(value)}", styles["BodyText"]))
        else:
            story.append(Paragraph(_text(terms), styles["BodyText"]))

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
        canvas.drawString(22 * mm, 11 * mm, "Hich | Website & System Development")
        canvas.drawRightString(A4[0] - 22 * mm, 11 * mm, f"Page {doc.page}")
        canvas.restoreState()

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()
