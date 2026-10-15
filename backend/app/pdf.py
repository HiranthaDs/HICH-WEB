from __future__ import annotations

import hashlib
import json
import re
from threading import Lock
from html import escape
from io import BytesIO
from pathlib import Path
from decimal import Decimal
from datetime import datetime, timedelta, timezone
from functools import lru_cache, partial
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.graphics.barcode import createBarcodeDrawing
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Flowable, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.platypus import Image as PlatypusImage

from .commercial_terms import scheduled_terms
from .invoice_sharing import with_default_payment_instructions


def _text(value: object) -> str:
    return escape("" if value is None else str(value)).replace("\n", "<br/>")


def _money(value: object, currency: str = "LKR") -> str:
    return f"{currency} {Decimal(str(value or 0)):,.2f}"


def _renewal_service_name(value: object) -> str:
    raw = str(value or "Renewal service")
    return {"domain": "Domain", "hosting": "Hosting", "domain_hosting": "Domain & hosting"}.get(raw, raw)


def _stable_pdf_document_id(content: bytes) -> bytes:
    """Make identical invoice content produce identical download and preview bytes."""
    match = re.search(rb"/ID\s*\[\s*<([0-9a-fA-F]{32})><([0-9a-fA-F]{32})>\s*\]", content)
    if not match:
        return content
    first_start, first_end = match.span(1)
    second_start, second_end = match.span(2)
    empty_id = b"0" * 32
    normalized = (
        content[:first_start] + empty_id + content[first_end:second_start]
        + empty_id + content[second_end:]
    )
    document_id = hashlib.sha256(normalized).hexdigest()[:32].encode("ascii")
    return (
        content[:first_start] + document_id + content[first_end:second_start]
        + document_id + content[second_end:]
    )


@lru_cache(maxsize=1)
def _invoice_fonts() -> tuple[str, str]:
    """Embed the same family as the client page, independent of installed device fonts."""
    directory = Path(__file__).resolve().parent / "assets" / "fonts"
    for name in ("Regular", "Bold"):
        pdfmetrics.registerFont(TTFont(f"Invoice-{name}", str(directory / f"PlusJakartaSans-{name}.ttf")))
    pdfmetrics.registerFontFamily("Invoice-Regular", normal="Invoice-Regular", bold="Invoice-Bold",
                                  italic="Invoice-Regular", boldItalic="Invoice-Bold")
    return "Invoice-Regular", "Invoice-Bold"


def _invoice_date(value: object) -> str:
    if not value:
        return "—"
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo:
            parsed = parsed.astimezone(timezone(timedelta(hours=5, minutes=30)))
        return f"{parsed.strftime('%b')} {parsed.day}, {parsed.year}"
    except ValueError:
        return str(value)


class _InvoiceBalance(Flowable):
    """Screen invoice's navy balance band, with vector text and a status pill."""

    def __init__(self, width: float, label: str, amount: str, due: str, status: str):
        super().__init__()
        self.width, self.height = width, 27 * mm
        self.label, self.amount, self.due, self.status = label, amount, due, status

    def draw(self) -> None:
        canvas = self.canv
        regular, bold = _invoice_fonts()
        canvas.saveState()
        clip = canvas.beginPath()
        clip.rect(0, 0, self.width, self.height)
        canvas.clipPath(clip, stroke=0, fill=0)
        canvas.linearGradient(0, self.height, self.width, 0, [
            colors.HexColor("#182b4a"), colors.HexColor("#263d64"), colors.HexColor("#315276"),
        ], positions=[0, .72, 1])
        inset = 7.5 * mm
        canvas.setFillColor(colors.HexColor("#c8d5e8"))
        canvas.setFont(regular, 8)
        canvas.drawString(inset, self.height - 7 * mm, self.label)
        pill_width = max(20 * mm, pdfmetrics.stringWidth(self.status, bold, 7) + 7 * mm)
        size = 27
        available = self.width - 3 * inset - pill_width
        while pdfmetrics.stringWidth(self.amount, bold, size) > available and size > 10:
            size -= .5
        canvas.setFillColor(colors.white)
        canvas.setFont(bold, size)
        canvas.drawString(inset, self.height - 18 * mm, self.amount)
        if self.due:
            canvas.setFillColor(colors.HexColor("#c8d5e8"))
            canvas.setFont(regular, 7)
            canvas.drawString(inset, 4.5 * mm, self.due)
        pill_x, pill_y = self.width - inset - pill_width, self.height / 2 - 3.2 * mm
        canvas.setFillColor(colors.HexColor("#b9efcf"))
        canvas.roundRect(pill_x, pill_y, pill_width, 6.4 * mm, 3.2 * mm, fill=1, stroke=0)
        canvas.setFillColor(colors.HexColor("#163b2d"))
        canvas.setFont(bold, 7)
        canvas.drawCentredString(pill_x + pill_width / 2, pill_y + 2.2 * mm, self.status)
        canvas.restoreState()


_INVOICE_PDF_CACHE: dict[str, bytes] = {}
_INVOICE_PDF_CACHE_LOCK = Lock()
_INVOICE_PDF_CACHE_SIZE = 64


def _render_invoice_pdf(invoice: dict[str, Any]) -> bytes:
    """Portable version of PublicInvoice's design, shared by download and print/save."""
    output = BytesIO()
    reference = str(invoice.get("reference") or invoice.get("invoice_number") or "Invoice")
    document = SimpleDocTemplate(output, pagesize=A4, leftMargin=12 * mm, rightMargin=12 * mm,
                                 topMargin=10 * mm, bottomMargin=12 * mm,
                                 title=f"Invoice {reference}", author="Hich Web")
    regular, bold = _invoice_fonts()
    ink, muted, line, brand = [colors.HexColor(value) for value in ("#202239", "#64677d", "#e8e9f2", "#2233ff")]
    # Account for the frame's six-point padding on each side.
    width = document.width - 12
    inset = 7.5 * mm
    inner = width - 2 * inset
    body = ParagraphStyle("InvoiceBody", fontName=regular, fontSize=8, leading=12, textColor=ink,
                          spaceBefore=0, spaceAfter=0, splitLongWords=True)
    strong = ParagraphStyle("InvoiceStrong", parent=body, fontName=bold)
    small = ParagraphStyle("InvoiceSmall", parent=body, fontSize=6.5, leading=9, textColor=muted)
    label = ParagraphStyle("InvoiceLabel", parent=small, fontName=bold, fontSize=6, leading=9)
    heading = ParagraphStyle("InvoiceHeading", parent=strong, fontSize=9, leading=12,
                             spaceBefore=0, spaceAfter=6, keepWithNext=True)
    right = ParagraphStyle("InvoiceRight", parent=body, alignment=TA_RIGHT)
    right_small = ParagraphStyle("InvoiceRightSmall", parent=small, alignment=TA_RIGHT)
    story: list[Any] = []
    currency = invoice.get("currency") or "LKR"
    total = Decimal(str(invoice.get("amount") or invoice.get("project_value") or 0))
    paid = Decimal(str(invoice.get("paid_amount") or 0))
    balance = Decimal(str(invoice.get("balance_due") if invoice.get("balance_due") is not None else max(Decimal(), total - paid)))
    is_paid = balance <= 0 or invoice.get("status") == "paid"
    renewal = invoice.get("invoice_kind") == "renewal"

    def p(value: object, style: ParagraphStyle = body) -> Paragraph:
        return Paragraph(_text(value), style)

    def box(data: list[list[Any]], widths: list[float], *, padding: float = 0, align: str = "LEFT") -> Table:
        result = Table(data, colWidths=widths, hAlign=align, splitInRow=1)
        result.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), padding),
            ("RIGHTPADDING", (0, 0), (-1, -1), padding),
            ("TOPPADDING", (0, 0), (-1, -1), padding),
            ("BOTTOMPADDING", (0, 0), (-1, -1), padding),
        ]))
        return result

    def section(title: str, content: Flowable) -> None:
        story.extend([Spacer(1, 4 * mm), box([[Paragraph(_text(title), heading)]], [inner], align="CENTER"), content])

    def table(headers: list[str], rows: list[list[Any]], widths: list[float]) -> Table:
        header_styles = [ParagraphStyle(f"Header-{index}", parent=label, alignment=TA_RIGHT if index == len(headers) - 1 else 0)
                         for index in range(len(headers))]
        data = [[p(value.upper(), style) for value, style in zip(headers, header_styles)]] + rows
        result = box(data, widths, padding=2 * mm, align="CENTER")
        result.repeatRows = 1
        result.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f5f5ff")),
            ("LINEBELOW", (0, 0), (-1, -1), .4, line),
        ]))
        return result

    logo_path = Path(__file__).resolve().parents[2] / "frontend" / "public" / "hich.png"
    if not logo_path.exists():
        logo_path = Path(__file__).resolve().parents[2] / "hich.png"
    logo = PlatypusImage(str(logo_path), width=27 * mm, height=13.5 * mm, kind="proportional") if logo_path.exists() else p("HICH WEB", strong)
    masthead_title = ParagraphStyle("InvoiceTitle", parent=strong, fontSize=16, leading=20, alignment=TA_RIGHT)
    masthead_label = ParagraphStyle("InvoiceType", parent=right_small, textColor=brand, fontName=bold)
    masthead = box([[
        [logo, p("WEBSITES & SYSTEMS", label)],
        [p("RENEWAL INVOICE" if renewal else "INVOICE", masthead_label), Spacer(1, 2 * mm), p(reference, masthead_title)],
    ]], [width * .32, width * .68], padding=inset)
    masthead.setStyle(TableStyle([
        ("TOPPADDING", (0, 0), (-1, -1), 4 * mm), ("BOTTOMPADDING", (0, 0), (-1, -1), 4 * mm),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    status = str(invoice.get("status") or "draft").replace("_", " ").title()
    due = f"Payment due {_invoice_date(invoice['due_date'])}" if not is_paid and invoice.get("due_date") else ""
    story.extend([masthead, _InvoiceBalance(width, "Invoice total" if is_paid else "Balance due",
                                           _money(total if is_paid else balance, currency), due, status)])

    client = invoice.get("client") or invoice.get("clients") or {}
    if not isinstance(client, dict):
        client = {"name": client}
    metadata = [
        [p("BILLED TO", label), Spacer(1, 1.5 * mm), p(invoice.get("client_name") or client.get("company") or client.get("name") or "Client", strong)],
        [p("FOR", label), Spacer(1, 1.5 * mm), p(invoice.get("project_title") or ("Domain & hosting renewal" if renewal else "Development services"), strong)],
        [p("ISSUE DATE", label), Spacer(1, 1.5 * mm), p(_invoice_date(invoice.get("issue_date")), strong)],
        [p("DUE DATE", label), Spacer(1, 1.5 * mm), p("Paid" if is_paid else _invoice_date(invoice.get("due_date")), strong)],
    ]
    if phone := invoice.get("phone") or client.get("phone"):
        metadata[0].extend([Spacer(1, mm), p(phone, small)])
    meta = box([metadata], [width * ratio for ratio in (.2875, .3375, .1875, .1875)], padding=4 * mm)
    meta.setStyle(TableStyle([("LINEAFTER", (0, 0), (-2, -1), .4, line), ("LINEBELOW", (0, 0), (-1, -1), .4, line)]))
    story.append(meta)

    if renewal and invoice.get("renewal_period_date"):
        period = box([[p("SERVICE PERIOD / EXPIRY", label), p(_invoice_date(invoice["renewal_period_date"]), right)]],
                     [width * .55, width * .45], padding=3 * mm)
        period.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#eff0ff"))]))
        story.append(period)

    charges: list[list[Any]] = []
    if renewal:
        for item in invoice.get("renewal_items") or []:
            description = [p(item.get("description"), strong)]
            if item.get("service"):
                description.extend([Spacer(1, mm), p(_renewal_service_name(item["service"]), small)])
            charges.append([description, p("Paid" if is_paid else "Due", small), p(_money(item.get("amount"), currency), right)])
        if Decimal(str(invoice.get("renewal_late_fee") or 0)) > 0:
            charges.append([[p("Late fee", strong), p("Agreed one-time surcharge (18%)", small)],
                            p("Paid" if is_paid else "Due", small), p(_money(invoice["renewal_late_fee"], currency), right)])
    else:
        for phase in invoice.get("payments") or []:
            description = [p(phase.get("name"), strong)]
            if phase.get("paid_at"):
                description.extend([Spacer(1, mm), p(f"Received {_invoice_date(phase['paid_at'])}", small)])
            state = "Paid" if phase.get("is_paid") or phase.get("isPaid") else "Part paid" if Decimal(str(phase.get("paid_amount") or 0)) else "Due"
            charges.append([description, p(state, small), p(_money(phase.get("amount"), currency), right)])
    if not charges:
        charges.append([p(invoice.get("project_title") or "Development services", strong),
                        p("Paid" if is_paid else "Due", small), p(_money(total, currency), right)])
    section("Invoice details", table(["Description", "Status", "Amount"], charges, [inner * .58, inner * .15, inner * .27]))

    total_width = min(86 * mm, inner)
    total_value = ParagraphStyle("InvoiceBalanceValue", parent=right, fontName=bold, fontSize=14, leading=19, textColor=brand)
    total_label = ParagraphStyle("InvoiceBalanceLabel", parent=small, textColor=brand)
    totals = box([
        [p("Subtotal", small), p(_money(total, currency), right)],
        [p("Payments received", small), p(f"− {_money(paid, currency)}", right)],
        [p("Balance due", total_label), p(_money(balance, currency), total_value)],
    ], [total_width * .43, total_width * .57], padding=2.25 * mm)
    totals.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8f9fd")),
        ("BOX", (0, 0), (-1, -1), .4, colors.HexColor("#e3e7f4")),
        ("LINEABOVE", (0, -1), (-1, -1), .4, colors.HexColor("#dfe3f7")),
        ("VALIGN", (0, -1), (-1, -1), "MIDDLE"),
    ]))
    story.extend([Spacer(1, 4 * mm), box([["", totals]], [inner - total_width, total_width], align="CENTER")])

    notes: list[list[Flowable]] = []
    if not is_paid:
        notes.append([Paragraph("Payment details", heading), p(with_default_payment_instructions(invoice.get("payment_instructions")), small),
                      Spacer(1, 2 * mm), p(f"Please include {reference} with your payment.", small)])
    if invoice.get("customer_note"):
        notes.append([Paragraph("Note", heading), p(invoice["customer_note"], small)])
    if notes:
        # Long customer notes can continue onto another page without clipping.
        columns: list[Any] = [notes[0]]
        widths = [inner]
        if len(notes) == 2:
            columns = [notes[0], "", notes[1]]
            widths = [(inner - 3 * mm) / 2, 3 * mm, (inner - 3 * mm) / 2]
        cards = box([columns], widths, padding=4 * mm, align="CENTER")
        for column in (0, 2) if len(notes) == 2 else (0,):
            cards.setStyle(TableStyle([
                ("BACKGROUND", (column, 0), (column, -1), colors.HexColor("#fbfcff")),
                ("BOX", (column, 0), (column, -1), .4, line),
            ]))
        story.extend([Spacer(1, 4 * mm), cards])

    receipts = invoice.get("payment_records") or []
    if receipts:
        section("Payment receipts", table(["Received", "Method", "Amount"], [[
            [p("Date not recorded" if receipt.get("date_confirmed") is False else _invoice_date(receipt.get("paid_at"))),
             p(receipt.get("receipt_number") or "Recorded payment", small)],
            p(receipt.get("method") or "Payment", small), p(_money(receipt.get("amount"), receipt.get("currency") or currency), right),
        ] for receipt in receipts], [inner * .38, inner * .35, inner * .27]))

    if not renewal and Decimal(str(invoice.get("renewal_amount") or 0)) > 0:
        renewal_note = box([[
            [p("Annual care / renewal", strong), p(f"Service expiry / renewal due {_invoice_date(invoice.get('renewal_due_date'))} · billed separately", small)],
            p(_money(invoice["renewal_amount"], invoice.get("renewal_currency") or currency), right),
        ]], [inner * .70, inner * .30], padding=3.5 * mm, align="CENTER")
        renewal_note.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fff6e7"))]))
        story.extend([Spacer(1, 4 * mm), renewal_note])

    # Keep the existing machine-readable reference, below the client-facing content.
    qr = createBarcodeDrawing("QR", value=reference, barLevel="M", width=17 * mm, height=17 * mm)
    barcode = createBarcodeDrawing("Code128", value=reference, barWidth=.25 * mm, barHeight=6 * mm, humanReadable=False)
    if barcode.width > 70 * mm:
        scale = 70 * mm / barcode.width
        barcode.scale(scale, 1)
        barcode.width = 70 * mm
    footer = box([[
        [p("Thank you for your business.", strong), p("Hich Web · Websites & systems", small), Spacer(1, 2 * mm), barcode],
        [p(f"Revision {invoice.get('revision') or 1} · Updated {_invoice_date(invoice.get('updated_at') or invoice.get('created_at') or invoice.get('issue_date'))}", right_small),
         p("This secure link always shows the latest saved invoice.", right_small)],
        qr,
    ]], [inner * .45, inner * .43, inner * .12], padding=0, align="CENTER")
    footer.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, -1), .4, line), ("TOPPADDING", (0, 0), (-1, -1), 4 * mm),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("RIGHTPADDING", (1, 0), (1, -1), 3 * mm),
    ]))
    story.extend([Spacer(1, 4 * mm), KeepTogether([footer])])

    def page_footer(canvas: Any, doc: Any) -> None:
        canvas.saveState()
        canvas.setFont(regular, 6)
        canvas.setFillColor(muted)
        canvas.drawString(12 * mm, 8 * mm, f"Hich Web · {reference}")
        canvas.drawRightString(A4[0] - 12 * mm, 8 * mm, f"Page {doc.page}")
        canvas.restoreState()

    document.build(story, onFirstPage=page_footer, onLaterPages=page_footer, canvasmaker=partial(Canvas, invariant=1))
    return _stable_pdf_document_id(output.getvalue())


def invoice_pdf(invoice: dict[str, Any]) -> bytes:
    """Return one stable PDF for identical saved invoice content."""
    cache_key = hashlib.sha256(
        json.dumps(invoice, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()
    with _INVOICE_PDF_CACHE_LOCK:
        cached = _INVOICE_PDF_CACHE.get(cache_key)
    if cached is not None:
        return cached

    rendered = _render_invoice_pdf(invoice)
    with _INVOICE_PDF_CACHE_LOCK:
        # A concurrent request may have completed while this one rendered. Use
        # the first completed copy so download and inline preview stay exact.
        cached = _INVOICE_PDF_CACHE.get(cache_key)
        if cached is not None:
            return cached
        if len(_INVOICE_PDF_CACHE) >= _INVOICE_PDF_CACHE_SIZE:
            _INVOICE_PDF_CACHE.pop(next(iter(_INVOICE_PDF_CACHE)))
        _INVOICE_PDF_CACHE[cache_key] = rendered
    return rendered


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
