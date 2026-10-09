from __future__ import annotations

import base64
from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from PIL import Image, ImageDraw
from pydantic import ValidationError
from starlette.requests import Request

from app.agreement_template import CONSENT_TEXT, GENERAL_AGREEMENT, PROJECT_OVERVIEW, SECTIONS
from app.config import Settings
from app.models import AgreementCreate, AgreementUpdate, SignAgreementRequest
from app.pdf import agreement_pdf
from app.routers import agreements
from app.security import hash_public_token


TOKEN = "private-agreement-token-for-testing-1234567890"


@pytest.fixture
def settings():
    return Settings(supabase_url="https://example.supabase.co", supabase_publishable_key="test", supabase_secret_key="secret")


def request() -> Request:
    return Request({"type": "http", "method": "POST", "path": "/sign", "headers": [(b"user-agent", b"Test browser")], "client": ("127.0.0.1", 1234), "server": ("test", 80), "scheme": "http"})


def record(settings) -> dict:
    row = {
        "id": str(uuid4()), "public_id": str(uuid4()), "reference": "HICH-AGR-001", "version": 2,
        "status": "viewed", "client_id": str(uuid4()), "client_name": "Acme", "client_phone": "+94771234567",
        "client_email": "client@example.com", "title": "Development agreement", "project_title": "Storefront",
        "description": "Build the approved storefront and payment integration.", "terms": {"Visits": "Approved separately"},
        "amount": "120000.00", "currency": "LKR", "expires_at": None,
        "clients": {"name": "CRM edited name", "email": "crm@example.com", "phone": "different phone"},
        "access_token_hash": hash_public_token(TOKEN, settings.token_hash_pepper.get_secret_value()),
    }
    row["content_sha256"] = agreements._document_digest(row)
    return row


def signing_payload(row, **changes):
    data = {"signer_name": "Jane Smith", "signer_job_role": "Director", "typed_signature": "Jane Smith", "consent": True,
            "expected_version": row["version"], "expected_content_sha256": row["content_sha256"]}
    return SignAgreementRequest(**(data | changes))


class FakeStorage:
    def __init__(self):
        self.uploaded = {}
        self.removed = []
        self.bucket = None

    def from_(self, bucket):
        self.bucket = bucket
        return self

    def upload(self, *, path, file, file_options):
        self.uploaded[path] = file

    def remove(self, paths):
        self.removed.extend(paths)
        for path in paths:
            self.uploaded.pop(path, None)

    def download(self, path):
        return self.uploaded[path]


class FakeGateway:
    def __init__(self, row, on_update=None):
        self.row = deepcopy(row)
        self.on_update = on_update
        self.storage = FakeStorage()
        self.service = self
        self.updates = []

    def table(self, name):
        assert name == "agreements"
        return FakeQuery(self)


class FakeQuery:
    def __init__(self, gateway):
        self.gateway = gateway
        self.filters = []
        self.changes = None

    def is_(self, name, value):
        assert value == "null"
        self.filters.append(lambda row: row.get(name) is None)
        return self

    def select(self, _): return self
    def limit(self, _): return self

    def eq(self, name, value):
        self.filters.append(lambda row: row.get(name) == value)
        return self

    def neq(self, name, value):
        self.filters.append(lambda row: row.get(name) != value)
        return self

    def in_(self, name, values):
        self.filters.append(lambda row: row.get(name) in values)
        return self

    def update(self, changes):
        self.changes = changes
        return self

    def execute(self):
        if self.changes and self.gateway.on_update:
            self.gateway.on_update(self.gateway.row)
        if not all(test(self.gateway.row) for test in self.filters):
            return SimpleNamespace(data=[])
        if self.changes:
            self.gateway.updates.append(deepcopy(self.changes))
            self.gateway.row.update(self.changes)
        return SimpleNamespace(data=[deepcopy(self.gateway.row)])


@pytest.fixture(autouse=True)
def no_audit_or_rate_limit(monkeypatch):
    monkeypatch.setattr(agreements, "audit", lambda *args, **kwargs: None)
    monkeypatch.setattr(agreements, "enforce_rate_limit", lambda *args, **kwargs: None)


def test_default_template_is_complete_and_editable():
    agreement = AgreementCreate(client_name="Acme")
    assert agreement.description == PROJECT_OVERVIEW
    assert all(heading in agreement.terms for heading, _ in SECTIONS)
    assert len(SECTIONS) >= 30
    for required in ("visit fee", "registrar", "change request", "written", "extra", "governing law", "payment", "non-excludable"):
        assert required in GENERAL_AGREEMENT.lower()
    agreement.terms["Visit and travel fees"] = "LKR 5,000 approved before travel"
    assert AgreementCreate(client_name="Other").terms["Visit and travel fees"] != agreement.terms["Visit and travel fees"]


def test_generated_agreement_reference_is_fixed_width_numeric_and_nonconstant(monkeypatch):
    random_values = iter((0, 899_999_999_999))
    monkeypatch.setattr(agreements.secrets, "randbelow", lambda upper: next(random_values))

    first = agreements._agreement_reference()
    second = agreements._agreement_reference()

    assert first == "100000000000"
    assert second == "999999999999"
    assert first != second
    assert all(len(reference) == 12 and reference.isdigit() and reference[0] != "0" for reference in (first, second))
    assert AgreementCreate(client_name="Legacy", reference="HICH-AGR-001").reference == "HICH-AGR-001"


@pytest.mark.parametrize("status", ["draft", "sent", "signed", "void"])
def test_delete_removes_agreement_and_public_link_but_retains_evidence(settings, status):
    row = record(settings) | {"status": status, "signed_pdf_sha256": "a" * 64}
    gateway = FakeGateway(row)
    response = agreements.delete_or_void_agreement(row["id"], request(), None, settings, gateway)
    assert response.status_code == 204
    assert gateway.row["deleted_at"]
    assert gateway.row["signed_pdf_sha256"] == row["signed_pdf_sha256"]
    assert gateway.row["status"] == ("signed" if status == "signed" else "void")
    with pytest.raises(HTTPException) as exc:
        agreements._agreement_by_id(row["id"], gateway)
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        agreements._agreement_by_token(TOKEN, settings, gateway)
    assert exc.value.status_code == 404


def test_signing_requires_role_current_version_and_explicit_boolean_consent(settings):
    data = signing_payload(record(settings)).model_dump()
    for missing in ("signer_job_role", "expected_version", "expected_content_sha256"):
        with pytest.raises(ValidationError):
            SignAgreementRequest(**{key: value for key, value in data.items() if key != missing})
    for invalid in (False, "true", 1):
        with pytest.raises(ValidationError):
            SignAgreementRequest(**(data | {"consent": invalid}))


def test_naive_expiry_is_rejected():
    with pytest.raises(ValidationError, match="timezone"):
        AgreementUpdate(expires_at="2027-01-01T12:00:00")


def test_phone_and_budget_required_before_sharing(settings):
    row = record(settings)
    agreements._ensure_shareable(row)
    row.pop("client_phone")
    row["clients"] = {}
    row["amount"] = None
    with pytest.raises(HTTPException) as exc:
        agreements._ensure_shareable(row)
    assert exc.value.status_code == 422
    assert "client_phone" in exc.value.detail and "amount" in exc.value.detail


def test_hash_covers_client_contact_reference_price_and_terms(settings):
    row = record(settings)
    original = agreements._document_digest(row)
    for field, value in (("reference", "OTHER"), ("client_phone", "123456"), ("amount", "50.00"), ("terms", {"Scope": "Other"})):
        assert agreements._document_digest(row | {field: value}) != original
    assert agreements._document_digest(row | {"amount": 120000, "version": 99}) == original


def test_sign_records_snapshot_role_consent_and_pdf_without_later_crm_changes(settings):
    row = record(settings)
    gateway = FakeGateway(row)
    result = agreements.sign_agreement(TOKEN, signing_payload(row), request(), settings, gateway)["agreement"]
    assert result["signed"] is True
    saved = gateway.row
    assert saved["consent_accepted"] is True
    assert saved["signed_snapshot"]["client_phone"] == row["client_phone"]
    assert saved["signed_snapshot"]["signer_job_role"] == "Director"
    assert saved["signed_snapshot"]["consent_text"] == CONSENT_TEXT
    assert gateway.storage.uploaded[saved["signed_pdf_storage_path"]].startswith(b"%PDF")
    saved["clients"].update(name="Changed", phone="Another", email="new@example.com")
    public = agreements._public_shape(saved, settings)
    assert public["client_name"] == "Acme"
    assert public["client_phone"] == "+94771234567"
    assert public["client_email"] == "client@example.com"
    assert "signed_snapshot" not in public and "signer_ip" not in public


def test_repeat_signing_rejected_without_new_files(settings):
    row = record(settings)
    gateway = FakeGateway(row)
    payload = signing_payload(row)
    agreements.sign_agreement(TOKEN, payload, request(), settings, gateway)
    uploaded = dict(gateway.storage.uploaded)
    with pytest.raises(HTTPException) as exc:
        agreements.sign_agreement(TOKEN, payload, request(), settings, gateway)
    assert exc.value.status_code == 409
    assert gateway.storage.uploaded == uploaded


@pytest.mark.parametrize("change", [{"version": 3}, {"content_sha256": "f" * 64}])
def test_stale_browser_cannot_sign_changed_agreement(settings, change):
    row = record(settings)
    payload = signing_payload(row)
    gateway = FakeGateway(row | change)
    with pytest.raises(HTTPException) as exc:
        agreements.sign_agreement(TOKEN, payload, request(), settings, gateway)
    assert exc.value.status_code == 409
    assert not gateway.storage.uploaded


@pytest.mark.parametrize("change", [{"version": 3}, {"access_token_hash": "revoked"}, {"status": "signed"}])
def test_concurrent_edit_revocation_or_sign_cannot_commit_stale_signature(settings, change):
    row = record(settings)
    gateway = FakeGateway(row, on_update=lambda current: current.update(change))
    with pytest.raises(HTTPException) as exc:
        agreements.sign_agreement(TOKEN, signing_payload(row), request(), settings, gateway)
    assert exc.value.status_code == 409
    assert not gateway.updates
    assert not gateway.storage.uploaded
    assert gateway.storage.removed


def test_unsigned_public_pdf_is_unavailable_and_signed_copy_matches_stored_bytes(settings):
    row = record(settings)
    gateway = FakeGateway(row)
    with pytest.raises(HTTPException) as exc:
        agreements.public_signed_agreement_pdf(TOKEN, settings, gateway)
    assert exc.value.status_code == 404
    agreements.sign_agreement(TOKEN, signing_payload(row), request(), settings, gateway)
    response = agreements.public_signed_agreement_pdf(TOKEN, settings, gateway)
    assert response.body == gateway.storage.uploaded[gateway.row["signed_pdf_storage_path"]]
    assert response.headers["cache-control"] == "private, no-store"


def image_url(draw=False):
    image = Image.new("RGBA", (200, 80), "white")
    if draw:
        ImageDraw.Draw(image).line([(10, 50), (40, 15), (70, 55), (130, 25), (185, 60)], fill="black", width=3)
    output = BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def test_blank_drawn_signature_rejected_but_valid_signature_persisted(settings):
    row = record(settings)
    gateway = FakeGateway(row)
    with pytest.raises(HTTPException) as exc:
        agreements.sign_agreement(TOKEN, signing_payload(row, typed_signature=None, signature_data_url=image_url()), request(), settings, gateway)
    assert exc.value.status_code == 422
    assert not gateway.storage.uploaded
    agreements.sign_agreement(TOKEN, signing_payload(row, typed_signature=None, signature_data_url=image_url(True)), request(), settings, gateway)
    assert gateway.row["signature_type"] == "drawn"
    assert len(gateway.storage.uploaded) == 2


def test_long_template_renders_multiple_pages(settings):
    document = agreement_pdf(record(settings) | {"description": GENERAL_AGREEMENT})
    assert document.startswith(b"%PDF")
    assert document.count(b"/Type /Page\n") > 5
