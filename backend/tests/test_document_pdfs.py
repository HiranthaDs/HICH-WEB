from io import BytesIO

import pytest

from app.agreement_template import default_terms
from app.commercial_terms import scheduled_terms
from app.pdf import agreement_pdf, invoice_pdf

pypdf = pytest.importorskip("pypdf", reason="Install backend/requirements-dev.txt for PDF content checks")


def text_of(content):
    reader = pypdf.PdfReader(BytesIO(content))
    return reader, "\n".join(page.extract_text() for page in reader.pages)


@pytest.fixture
def project_invoice():
    return {
        "reference": "INV-20261011-0042", "project_title": "Business website & management system",
        "client_name": "Sample Company", "phone": "+94 77 123 4567",
        "issue_date": "2026-10-11", "due_date": "2026-10-25", "updated_at": "2026-10-11T09:30:00Z",
        "amount": "416700.00", "paid_amount": "116700.00", "balance_due": "300000.00",
        "currency": "LKR", "status": "partial", "revision": 3,
        "payments": [
            {"name": "Initial payment", "amount": "116700.00", "paid_amount": "116700.00", "is_paid": True, "paid_at": "2026-10-11"},
            {"name": "Development milestone", "amount": "150000.00", "paid_amount": "0.00", "is_paid": False},
            {"name": "Final handover", "amount": "150000.00", "paid_amount": "0.00", "is_paid": False},
        ],
        "payment_records": [{
            "receipt_number": "RCT-00000042", "amount": "116700.00", "currency": "LKR",
            "paid_at": "2026-10-11", "method": "Bank transfer", "date_confirmed": True,
        }],
        "payment_instructions": "Bank transfer to Hich Web\nAccount 12345678",
        "customer_note": "Thank you for choosing Hich Web.",
        "renewal_amount": "20000.00", "renewal_currency": "LKR", "renewal_due_date": "2027-10-11",
        "notes": "SECRET-ADMIN-NOTE", "share_token": "SECRET-SHARE-TOKEN",
    }


def test_invoice_pdf_matches_client_document_and_embeds_logo_on_one_page(project_invoice):
    reader, text = text_of(invoice_pdf(project_invoice))
    assert len(reader.pages) == 1
    assert list(reader.pages[0].images), "The saved invoice must embed the brand logo."
    assert reader.metadata.title == "Invoice INV-20261011-0042"
    for value in (
        "INV-20261011-0042", "Sample Company", "Business website & management system",
        "Initial payment", "Development milestone", "Final handover", "RCT-00000042",
        "LKR 416,700.00", "LKR 116,700.00", "LKR 300,000.00", "LKR 20,000.00",
        "Bank transfer to Hich Web", "Thank you for choosing Hich Web.",
    ):
        assert value in text
    assert "SECRET-ADMIN-NOTE" not in text
    assert "SECRET-SHARE-TOKEN" not in text


def test_paid_renewal_pdf_preserves_items_and_surcharge_without_payment_prompt(project_invoice):
    invoice = project_invoice | {
        "reference": "REN-20261011-0042", "invoice_kind": "renewal", "status": "paid",
        "amount": "11800.00", "paid_amount": "11800.00", "balance_due": "0.00",
        "renewal_period_date": "2026-10-01", "renewal_amount": None, "payments": [], "payment_records": [],
        "renewal_items": [
            {"service": "domain", "description": "Annual domain renewal", "amount": "3000.00"},
            {"service": "hosting", "description": "Annual hosting renewal", "amount": "7000.00"},
        ],
        "renewal_late_fee": "1800.00",
    }
    reader, text = text_of(invoice_pdf(invoice))
    assert len(reader.pages) == 1
    assert "RENEWAL INVOICE" in text.upper()
    for value in ("Annual domain renewal", "Annual hosting renewal", "LKR 3,000.00", "LKR 7,000.00", "LKR 1,800.00", "LKR 11,800.00", "LKR 0.00"):
        assert value in text
    assert "Bank transfer to Hich Web" not in text


@pytest.mark.parametrize("reference", ["INV-20261011-0042", "REN-2026/10.11_042"])
def test_printed_invoice_qr_and_barcode_decode_to_exact_invoice_number(project_invoice, reference):
    # Optional raster checks exercise the final PDF, including code scale and quiet zones.
    # Runtime deployments only require ReportLab; these tools are for development checks.
    pymupdf = pytest.importorskip("pymupdf", reason="Install PyMuPDF for printed barcode checks")
    zxingcpp = pytest.importorskip("zxingcpp", reason="Install zxing-cpp for printed barcode checks")
    pillow = pytest.importorskip("PIL.Image")
    content = invoice_pdf(project_invoice | {"reference": reference})
    with pymupdf.open(stream=content, filetype="pdf") as document:
        page = document[0].get_pixmap(dpi=200, alpha=False)
        raster = pillow.frombytes("RGB", (page.width, page.height), page.samples)
        codes = zxingcpp.read_barcodes(raster)
    decoded = {(code.format, code.text) for code in codes}
    assert (zxingcpp.BarcodeFormat.QRCode, reference) in decoded
    assert (zxingcpp.BarcodeFormat.Code128, reference) in decoded


def test_long_agreement_has_all_clauses_and_separate_selected_charges_without_total():
    record = {
        "title": "Website & Systems Development Agreement", "reference": "AGR-PDF", "client_name": "Sample Client",
        "project_title": "Business website and management system", "amount": None, "currency": "LKR",
        "visiting_fee_lkr": 5000, "renewal_amount": 75, "renewal_currency": "USD", "status": "draft",
    }
    record["terms"] = scheduled_terms(record | {"terms": default_terms()})
    reader, text = text_of(agreement_pdf(record))
    assert len(reader.pages) > 2
    assert "No overall project total is stated" in text
    assert "LKR 5,000.00" in text and "USD 75.00" in text
    assert "40. Review of material terms" in text
    for index, page in enumerate(reader.pages, 1):
        assert f"Page {index}" in page.extract_text()
        assert "AGR-PDF" in page.extract_text()
    _, scope_only = text_of(agreement_pdf(record | {"commercial_details_visible": False}))
    assert "LKR 5,000.00" not in scope_only and "USD 75.00" not in scope_only


def test_invoice_pdf_receipt_ledger_paginates_and_never_prints_internal_notes():
    invoice = {
        "reference": "INV-PDF", "project_title": "System delivery", "client_name": "Sample Client",
        "amount": "10000.00", "paid_amount": "8000.00", "currency": "LKR", "status": "partial",
        "notes": "SECRET-INTERNAL-NOTES", "customer_note": "Thank you <script>example</script>",
        "payment_records": [{"receipt_number": f"RCT-{i:08d}", "amount": 100, "currency": "LKR", "paid_at": "2026-10-11", "method": "Bank transfer"} for i in range(80)],
    }
    reader, text = text_of(invoice_pdf(invoice))
    assert len(reader.pages) > 1
    assert "LKR 2,000.00" in text and "RCT-00000079" in text
    assert "SECRET-INTERNAL-NOTES" not in text
    assert "<script>example</script>" in text
    assert "Receipt" in reader.pages[1].extract_text()
