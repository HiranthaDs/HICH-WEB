from __future__ import annotations

import base64
from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from PIL import Image, ImageDraw
from pydantic import ValidationError
from starlette.requests import Request

from app.agreement_template import CONSENT_TEXT, GENERAL_AGREEMENT, PROJECT_OVERVIEW, SECTIONS
from app.config import Settings
from app.models import AgreementCreate, AgreementShareRequest, AgreementUpdate, SignAgreementRequest
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
        "amount": "120000.00", "currency": "LKR", "commercial_details_visible": True, "expires_at": None,
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
        self.counters = []

    def table(self, name):
        if name == "agreements":
            return FakeQuery(self)
        assert name == "document_open_counts"
        return CounterQuery(self)

    def rpc(self, name, payload):
        assert name == "record_document_open"
        return FakeViewRpc(self, payload)


class CounterQuery:
    def __init__(self, gateway):
        self.gateway = gateway
        self.filters = []

    def select(self, _): return self
    def eq(self, name, value): self.filters.append(lambda row: row.get(name) == value); return self
    def in_(self, name, values): self.filters.append(lambda row: row.get(name) in values); return self

    def execute(self):
        return SimpleNamespace(data=[deepcopy(row) for row in self.gateway.counters if all(test(row) for test in self.filters)])


class FakeViewRpc:
    def __init__(self, gateway, payload):
        self.gateway = gateway
        self.payload = payload

    def execute(self):
        row = self.gateway.row
        assert self.payload["p_document_type"] == "agreement"
        if (row["id"] != self.payload["p_document_id"] or row.get("access_token_hash") != self.payload["p_access_token_hash"]
                or row.get("status") not in {"sent", "viewed", "signed", "expired"} or row.get("deleted_at") is not None):
            return SimpleNamespace(data=[])
        first_opened = row["status"] == "sent"
        if first_opened:
            row.update({"status": "viewed", "viewed_at": "2026-10-14T08:00:00Z"})
        count = next((item for item in self.gateway.counters if item["document_id"] == row["id"]), None)
        if count is None:
            count = {"document_type": "agreement", "document_id": row["id"], "open_count": 0}
            self.gateway.counters.append(count)
        count["open_count"] += 1
        count["last_opened_at"] = "2026-10-14T08:00:00Z"
        return SimpleNamespace(data=[{"document_status": row["status"], "first_viewed_at": row.get("viewed_at"),
                                      "view_count": count["open_count"], "last_opened_at": count["last_opened_at"],
                                      "first_opened": first_opened}])


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


@pytest.mark.parametrize("commercial_details_visible", [True, False])
@pytest.mark.parametrize("fee", [None, "", 0, "0.00"])
def test_existing_agreement_can_remove_visiting_fee_and_keep_signing_available(settings, commercial_details_visible, fee):
    row = record(settings) | {"visiting_fee_lkr": "5000.00", "commercial_details_visible": commercial_details_visible}
    row["terms"] = agreements.scheduled_terms(row)
    gateway = FakeGateway(row)
    payload = AgreementUpdate(visiting_fee_lkr=fee, expected_version=row["version"])

    saved = agreements.update_agreement(UUID(row["id"]), payload, request(), None, settings, gateway)["agreement"]

    assert float(saved["visiting_fee_lkr"]) == 0
    assert "Visiting fee: LKR" not in str(saved["terms"])
    assert "32. Hich Web visiting fee and final-balance credit" not in saved["terms"]
    agreements._ensure_shareable(gateway.row)


def test_phone_and_project_are_required_but_budget_is_optional_before_sharing(settings):
    row = record(settings)
    row["amount"] = None
    agreements._ensure_shareable(row)
    row.pop("client_phone")
    row["clients"] = {}
    with pytest.raises(HTTPException) as exc:
        agreements._ensure_shareable(row)
    assert exc.value.status_code == 422
    assert "client_phone" in exc.value.detail
    assert "amount" not in exc.value.detail


def test_hash_covers_client_contact_reference_price_and_terms(settings):
    row = record(settings)
    original = agreements._document_digest(row)
    for field, value in (("reference", "OTHER"), ("client_phone", "123456"), ("amount", "50.00"), ("terms", {"Scope": "Other"})):
        assert agreements._document_digest(row | {field: value}) != original
    assert agreements._document_digest(row | {"amount": 120000, "version": 99}) == original


def test_scope_only_agreement_redacts_all_commercial_details(settings):
    row = record(settings) | {
        "commercial_details_visible": False,
        "renewal_amount": "120.00",
        "renewal_currency": "USD",
        "renewal_due_date": "2027-10-09",
        "visiting_fee_lkr": "5000.00",
        "payment_schedule": [{"name": "Advance", "amount": "60000.00"}],
        "payment_instructions": "Private bank details",
        "project_due_date": "2026-11-01",
        "terms": {
            "Scope": "Website",
            "Visit and travel fees": "Specific visiting amount LKR 5,000",
            "Renewal late-payment surcharge": "Specific renewal USD 120",
            "Project-specific commercial schedule": "Project total LKR 120,000 and bank details",
        },
    }

    public = agreements._public_shape(row, settings)

    assert public["commercial_details_visible"] is False
    assert public["amount"] is None
    assert public["renewal_amount"] is None
    assert public["renewal_currency"] is None
    assert public["renewal_due_date"] is None
    assert public["visiting_fee_lkr"] is None
    assert public["payment_schedule"] == []
    assert public["payment_instructions"] is None
    assert public["project_due_date"] is None
    assert "120,000" not in str(public["terms"])
    assert "USD 120" not in str(public["terms"])
    assert "bank details" not in str(public["terms"])
    assert agreements._document_digest(row) != agreements._document_digest(row | {"commercial_details_visible": True})


def test_scope_only_mode_is_inferred_when_production_schema_lacks_visibility_column(settings):
    row = record(settings)
    row.pop("commercial_details_visible")
    row["terms"] = {
        "Scope": "Website",
        "Project-specific commercial schedule": (
            "This is a scope-only agreement. Project prices and payment milestones are intentionally excluded."
        ),
    }

    shaped = agreements._shape(row, settings)
    public = agreements._public_shape(row, settings)

    assert shaped["commercial_details_visible"] is False
    assert public["commercial_details_visible"] is False
    assert public["amount"] is None


def test_optional_agreement_schema_error_detection():
    assert agreements._missing_optional_schema(Exception({
        "message": "Could not find the 'commercial_details_visible' column of 'agreements' in the schema cache",
        "code": "PGRST204",
    }))
    assert agreements._missing_optional_schema(Exception({
        "message": "column agreements.share_nonce does not exist",
        "code": "42703",
    }))
    assert not agreements._missing_optional_schema(Exception({"message": "connection timed out"}))


def test_agreement_without_budget_can_be_signed_and_rendered(settings):
    row = record(settings) | {"amount": None}
    row["content_sha256"] = agreements._document_digest(row)
    gateway = FakeGateway(row)

    result = agreements.sign_agreement(TOKEN, signing_payload(row), request(), settings, gateway)["agreement"]

    assert result["signed"] is True
    assert gateway.row["signed_snapshot"]["amount"] is None
    assert gateway.storage.uploaded[gateway.row["signed_pdf_storage_path"]].startswith(b"%PDF")


def test_scope_only_agreement_signs_on_legacy_schema_without_exposing_placeholder(settings):
    row = record(settings) | {
        "amount": None,
        "terms": {"Project-specific commercial schedule": f"{agreements.SCOPE_ONLY_MARKER} Prices are issued separately."},
    }
    row.pop("commercial_details_visible")
    row["content_sha256"] = agreements._document_digest(row)
    gateway = FakeGateway(row)

    public = agreements.sign_agreement(TOKEN, signing_payload(row), request(), settings, gateway)["agreement"]

    assert gateway.row["signed_snapshot"]["amount"] == "0.00"
    assert gateway.row["signed_snapshot"][agreements.LEGACY_AMOUNT_PLACEHOLDER_KEY] is True
    assert public["commercial_details_visible"] is False
    assert public["amount"] is None


def test_permanent_v2_agreement_signs_after_key_rotation_and_old_deadline(settings):
    from pydantic import SecretStr
    row = record(settings) | {"share_nonce": str(uuid4()), "expires_at": "2000-01-01T00:00:00Z"}
    token = agreements._agreement_token(row["public_id"], row["share_nonce"], settings)
    row["access_token_hash"] = agreements._token_hash(token, settings)
    row["content_sha256"] = agreements._document_digest(row)
    changed = settings.model_copy(update={"token_hash_pepper": SecretStr("new-pepper"), "supabase_secret_key": SecretStr("new-key")})
    gateway = FakeGateway(row)
    assert agreements._recover_token(row, changed) == token
    result = agreements.sign_agreement(token, signing_payload(row), request(), changed, gateway)["agreement"]
    assert result["signed"] is True
    assert gateway.row["signed_snapshot"]["expires_at"] == "2000-01-01T00:00:00Z"
    assert result["expires_at"] is None


def test_legacy_agreement_lookup_accepts_configured_former_pepper(settings):
    from pydantic import SecretStr
    row = record(settings)
    row["access_token_hash"] = hash_public_token(TOKEN, "former-pepper")
    changed = settings.model_copy(update={"token_hash_pepper": SecretStr("new-pepper"), "legacy_public_link_keys": SecretStr("former-pepper")})
    assert agreements._agreement_by_token(TOKEN, changed, FakeGateway(row))["id"] == row["id"]


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


def test_copying_agreement_link_is_stable_and_explicit_replacement_rotates_it(settings):
    row = record(settings) | {"status": "sent", "share_nonce": None}
    gateway = FakeGateway(row)
    principal = SimpleNamespace(id=uuid4())

    first = agreements.share_agreement(UUID(row["id"]), request(), None, principal, settings, gateway)["share"]
    agreements.public_agreement(first["token"], request(), settings, gateway)
    viewed_at = gateway.row["viewed_at"]
    second = agreements.share_agreement(UUID(row["id"]), request(), None, principal, settings, gateway)["share"]
    assert gateway.row["status"] == "viewed"
    assert gateway.row["viewed_at"] == viewed_at
    assert gateway.counters == []
    replacement = agreements.share_agreement(UUID(row["id"]), request(), AgreementShareRequest(rotate=True), principal, settings, gateway)["share"]

    assert first["url"] == second["url"]
    assert replacement["url"] != first["url"]
    assert gateway.counters == []


def test_first_share_publishes_preallocated_draft_link(settings):
    nonce = str(uuid4())
    row = record(settings) | {"status": "draft", "share_nonce": nonce}
    token = agreements._agreement_token(row["public_id"], nonce, settings)
    row["access_token_hash"] = agreements._token_hash(token, settings)
    gateway = FakeGateway(row)

    shared = agreements.share_agreement(
        UUID(row["id"]), request(), None, SimpleNamespace(id=uuid4()), settings, gateway
    )["share"]

    assert shared["token"] == token
    assert gateway.row["share_nonce"] == nonce
    assert gateway.row["status"] == "sent"
    assert gateway.row["sent_at"]
    public = agreements.public_agreement(token, request(), settings, gateway)["agreement"]
    assert public["status"] == "viewed"


def test_signed_agreement_revisit_does_not_count_or_update_signed_record(settings):
    row = record(settings) | {"status": "signed", "viewed_at": "2026-10-10T09:00:00Z"}
    gateway = FakeGateway(row)
    gateway.counters.append({"document_type": "agreement", "document_id": row["id"], "open_count": 1,
                             "last_opened_at": row["viewed_at"]})

    first = agreements.public_agreement(TOKEN, request(), settings, gateway)["agreement"]
    second = agreements.public_agreement(TOKEN, request(), settings, gateway)["agreement"]

    assert first["status"] == second["status"] == "signed"
    assert gateway.counters[0]["open_count"] == 1
    assert gateway.updates == []
    assert gateway.row == row


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
