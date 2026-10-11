"""Generate synthetic PDF review artifacts; optional dependency: PyMuPDF."""
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.agreement_template import default_terms
from app.commercial_terms import scheduled_terms
from app.pdf import agreement_pdf, invoice_pdf

output = ROOT / "docs" / "ui-review" / "documents-2.0.1"
output.mkdir(parents=True, exist_ok=True)
invoice = {
    "reference": "INV-SAMPLE", "project_title": "Website and business management system",
    "client_name": "Sample Company", "currency": "LKR", "amount": 416700, "paid_amount": 116700,
    "status": "partial", "revision": 3, "issue_date": "2026-10-11", "due_date": "2026-11-11",
    "payments": [
        {"name": "Advance payment", "amount": 116700, "paid_amount": 116700, "is_paid": True},
        {"name": "Mid-project payment", "amount": 150000, "paid_amount": 0},
        {"name": "Final balance", "amount": 150000, "paid_amount": 0},
    ],
    "payment_records": [{"receipt_number": "RCT-00000001", "amount": 116700, "currency": "LKR", "paid_at": "2026-10-11", "method": "Bank transfer"}],
    "payment_instructions": "Use the invoice reference with your transfer. Contact Hich Web for account details.",
    "customer_note": "Thank you for choosing Hich Web.",
}
agreement = {
    "reference": "AGR-SAMPLE", "title": "Website & Systems Development Agreement", "client_name": "Sample Company",
    "client_phone": "+94 77 000 0000", "project_title": invoice["project_title"], "amount": None, "currency": "LKR",
    "visiting_fee_lkr": 5000, "renewal_amount": 12000, "renewal_currency": "LKR", "renewal_due_date": "2027-10-11",
    "status": "draft", "version": 1, "description": "Design and develop the pages, workflows and integrations listed in the accepted project schedule.",
}
agreement["terms"] = scheduled_terms(agreement | {"terms": default_terms()})
for name, content in [("invoice", invoice_pdf(invoice)), ("agreement-selected-charges", agreement_pdf(agreement))]:
    (output / f"{name}.pdf").write_bytes(content)
    document = pymupdf.open(stream=content, filetype="pdf")
    for page_index in sorted({0, len(document) - 1}):
        document[page_index].get_pixmap(matrix=pymupdf.Matrix(1.3, 1.3)).save(output / f"{name}-page-{page_index + 1}.png")
    print(f"{name}: {len(document)} pages")
