from copy import deepcopy
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.config import Settings, get_settings
from app.dependencies import Principal, current_admin, current_user, portal_profile
from app.supabase_client import get_supabase
from app.middleware import BrowserOriginMiddleware
from app.commercial_terms import scheduled_terms
from app.income import income_report
from app.routers import auth, agreements, communications, invoices
from app.security import rate_limiter
from app.agreement_template import default_terms


def settings(**extra):
    return Settings(_env_file=None, supabase_url="https://example.supabase.co", supabase_publishable_key="public", supabase_secret_key="secret", admin_emails="owner@example.com", cookie_secure=False, **extra)


class ProfileQuery:
    def __init__(self, profile=None): self.profile = profile
    def select(self, *_): return self
    def eq(self, *_): return self
    def limit(self, *_): return self
    def insert(self, *_): return self
    def execute(self): return SimpleNamespace(data=[self.profile] if self.profile else [])


def gateway(profile=None):
    return SimpleNamespace(service=SimpleNamespace(table=lambda _: ProfileQuery(profile)))


def test_render_environment_origin_is_allowed_without_trusting_host_headers():
    cfg = settings(environment="production", frontend_origins="https://old.example", public_app_url="https://old.example", render_external_url="https://hich-web.onrender.com")
    app = FastAPI(); app.add_middleware(BrowserOriginMiddleware, settings=cfg)
    @app.post("/login")
    def login(): return {"ok": True}
    client = TestClient(app)
    assert client.post("/login", headers={"Origin": "https://hich-web.onrender.com"}).status_code == 200
    assert client.post("/login", headers={"Origin": "https://evil.example", "Host": "evil.example", "X-Forwarded-Host": "evil.example"}).status_code == 403
    assert client.post("/login", headers={"Referer": "https://evil.example/login"}).status_code == 403


def test_public_login_path_is_normalized_and_render_replaces_production_localhost_links():
    assert str(settings(public_app_url="https://hich-web.onrender.com/admin/login").public_app_url).rstrip("/") == "https://hich-web.onrender.com"
    cfg = settings(environment="production", public_app_url="http://localhost:5173", render_external_url="https://hich-web.onrender.com")
    assert str(cfg.public_app_url).rstrip("/") == "https://hich-web.onrender.com"


@pytest.mark.parametrize("profile, permitted", [
    ({"role": "staff", "active": True, "portal_access": True}, True),
    ({"role": "admin", "active": True, "portal_access": True}, True),
    ({"role": "staff", "active": True, "portal_access": False}, False),
    ({"role": "client", "active": True, "portal_access": True}, False),
    ({"role": "admin", "active": False, "portal_access": True}, False),
])
def test_only_approved_active_profiles_gain_dynamic_access(profile, permitted):
    assert bool(portal_profile("new@example.com", settings(), gateway(profile))) == permitted


def test_disabled_bootstrap_admin_is_blocked_and_database_failures_fail_closed():
    assert portal_profile("owner@example.com", settings(), gateway({"role": "admin", "active": False})) is None
    broken = SimpleNamespace(service=SimpleNamespace(table=lambda _: (_ for _ in ()).throw(RuntimeError("offline"))))
    with pytest.raises(HTTPException) as exc:
        portal_profile("owner@example.com", settings(), broken)
    assert exc.value.status_code == 503


def test_deletion_pin_is_required_by_server_for_delete_and_withdrawal():
    cfg = settings(); principal = Principal(uuid4(), "owner@example.com")
    app = FastAPI(); app.dependency_overrides[current_user] = lambda: principal
    app.dependency_overrides[get_settings] = lambda: cfg
    app.dependency_overrides[get_supabase] = lambda: gateway()
    mutations = []
    @app.delete("/records")
    def delete(_: Principal = Depends(current_admin)): mutations.append("delete"); return {}
    @app.post("/changes/void")
    def withdraw(_: Principal = Depends(current_admin)): mutations.append("void"); return {}
    rate_limiter.clear(); client = TestClient(app)
    assert client.delete("/records").status_code == 403
    assert client.delete("/records", headers={"X-Deletion-PIN": "1234"}).status_code == 403
    assert client.post("/changes/void").status_code == 403
    assert mutations == []
    assert client.delete("/records", headers={"X-Deletion-PIN": "2113"}).status_code == 200
    assert client.post("/changes/void", headers={"X-Deletion-PIN": "2113"}).status_code == 200
    assert mutations == ["delete", "void"]


def test_staff_cannot_manage_users_and_admin_cannot_remove_own_access():
    with pytest.raises(HTTPException) as exc:
        auth.manage_users(Principal(uuid4(), "staff@example.com", role="staff"))
    assert exc.value.status_code == 403
    principal = Principal(uuid4(), "owner@example.com")
    with pytest.raises(HTTPException) as exc:
        auth.update_user(principal.id, auth.UpdateUserRequest(full_name="Owner", role="staff", active=True), Request({"type": "http", "headers": []}), principal, settings(), gateway())
    assert exc.value.status_code == 409


def test_valid_deletions_do_not_consume_failed_pin_limit():
    from app.dependencies import require_deletion_pin
    rate_limiter.clear()
    principal = Principal(uuid4(), "owner@example.com")
    good = Request({"type": "http", "headers": [(b"x-deletion-pin", b"2113")]})
    bad = Request({"type": "http", "headers": [(b"x-deletion-pin", b"0000")]})
    for _ in range(20):
        require_deletion_pin(good, settings(), principal)
    for _ in range(8):
        with pytest.raises(HTTPException) as exc:
            require_deletion_pin(bad, settings(), principal)
        assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc:
        require_deletion_pin(bad, settings(), principal)
    assert exc.value.status_code == 429
    require_deletion_pin(good, settings(), principal)


def test_temporary_password_creates_confirmed_user_without_leaking_secret(monkeypatch):
    account, created, audits = {}, [], []
    class Query(ProfileQuery):
        def upsert(self, changes): account.update(changes); return self
        def execute(self): return SimpleNamespace(data=[account.copy()] if account else [])
    def create(data):
        created.append(data)
        return SimpleNamespace(user=SimpleNamespace(id=uuid4()))
    gateway = SimpleNamespace(service=SimpleNamespace(table=lambda _: Query(), auth=SimpleNamespace(admin=SimpleNamespace(create_user=create))))
    monkeypatch.setattr(auth, "audit", lambda *args: audits.append(args))
    rate_limiter.clear()
    secret = "Temporary-pass-1234"
    payload = auth.CreateUserRequest(email="staff@example.com", full_name="New Staff", temporary_password=secret)
    result = auth.create_user(payload, Request({"type": "http", "headers": []}), Principal(uuid4(), "owner@example.com"), settings(), gateway)
    assert created[0]["password"] == secret and created[0]["email_confirm"] is True
    assert result["user"]["portal_access"] is True
    assert secret not in str(result) and secret not in str(audits) and secret not in repr(payload)
    account["portal_access"] = False
    with pytest.raises(HTTPException) as exc:
        auth.create_user(payload, Request({"type": "http", "headers": []}), Principal(uuid4(), "owner@example.com"), settings(), gateway)
    assert exc.value.status_code == 409 and len(created) == 1


def test_existing_auth_signup_can_be_granted_portal_access_without_duplicate_invitation():
    account = {"id": str(uuid4()), "email": "existing@example.com", "full_name": "Existing User", "role": "staff", "active": True, "portal_access": False}
    recovery = []
    class Query(ProfileQuery):
        def update(self, changes): account.update(changes); return self
        def execute(self): return SimpleNamespace(data=[account.copy()])
    g = SimpleNamespace(service=SimpleNamespace(table=lambda _: Query(account)), auth_client=lambda: SimpleNamespace(auth=SimpleNamespace(reset_password_for_email=lambda email, options: recovery.append((email, options)))))
    rate_limiter.clear()
    result = auth.create_user(auth.CreateUserRequest(email=account["email"], full_name="Approved Staff", role="staff"), Request({"type": "http", "headers": []}), Principal(uuid4(), "owner@example.com"), settings(), g)
    assert result["user"]["portal_access"] is True
    assert result["user"]["role"] == "staff"
    assert recovery[0][0] == account["email"]
    with pytest.raises(HTTPException) as exc:
        auth.create_user(auth.CreateUserRequest(email=account["email"], full_name="Approved Staff", role="staff"), Request({"type": "http", "headers": []}), Principal(uuid4(), "owner@example.com"), settings(), g)
    assert exc.value.status_code == 409


def test_reassigning_agreement_clears_old_invoice_association(monkeypatch):
    client_id, new_client_id, agreement_id = uuid4(), uuid4(), uuid4()
    record = {"id": str(agreement_id), "public_id": str(uuid4()), "client_id": str(client_id), "source_invoice_id": str(uuid4()), "title": "Development", "project_title": "Website", "amount": "20000", "currency": "LKR", "status": "draft", "version": 1, "terms": {"Scope": "Website"}}
    class Query(ProfileQuery):
        def __init__(self, table): self.table = table
        def update(self, changes): record.update(changes); return self
        def neq(self, *_): return self
        def execute(self): return SimpleNamespace(data=[{"name": "New Client", "phone": "+94771111111", "email": "new@example.com"}] if self.table == "clients" else [record.copy()])
    g = SimpleNamespace(service=SimpleNamespace(table=lambda table: Query(table)))
    monkeypatch.setattr(agreements, "_agreement_by_id", lambda *_: record.copy())
    result = agreements.update_agreement(agreement_id, agreements.AgreementUpdate(client_id=new_client_id), Request({"type": "http", "headers": []}), Principal(uuid4(), "owner@example.com"), settings(), g)
    assert result["agreement"]["source_invoice_id"] is None
    assert result["agreement"]["client_id"] == str(new_client_id)


def test_password_change_verifies_current_password_and_revokes_refresh_sessions():
    cfg = settings(); principal = Principal(uuid4(), "owner@example.com")
    calls = []
    class Auth:
        def sign_in_with_password(self, data):
            calls.append("verify")
            if data["password"] != "correct-current": raise HTTPException(403, "Current password is incorrect")
            return SimpleNamespace(user=SimpleNamespace(id=str(principal.id)))
        def update_user(self, data): calls.append(("update", data["password"]))
        def sign_out(self, options): calls.append(("logout", options["scope"]))
    g = gateway(); g.auth_client = lambda: SimpleNamespace(auth=Auth())
    request = Request({"type": "http", "headers": []})
    rate_limiter.clear()
    with pytest.raises(HTTPException):
        auth.change_password(auth.ChangePasswordRequest(current_password="wrong-current", password="new-long-passphrase"), request, Response(), principal, cfg, g)
    assert calls == ["verify"]
    response = Response()
    auth.change_password(auth.ChangePasswordRequest(current_password="correct-current", password="new-long-passphrase"), request, response, principal, cfg, g)
    assert calls[-2:] == [("update", "new-long-passphrase"), ("logout", "global")]
    assert 'Max-Age=0' in response.headers.get("set-cookie", "")


def test_visiting_fee_is_included_once_and_commercial_changes_affect_document_digest():
    record = {"amount": "40000", "currency": "LKR", "visiting_fee_lkr": "5000", "terms": {"Scope": "Website"}, "payment_schedule": [{"name": "Visiting fee", "amount": "5000", "received_amount": "5000", "is_paid": True}, {"name": "Final", "amount": "35000"}]}
    before = deepcopy(record)
    terms = scheduled_terms(record)
    assert record == before
    assert "credited once" in terms["Project-specific commercial schedule"]
    assert scheduled_terms(record | {"terms": terms}) == terms
    assert agreements._document_digest(record) != agreements._document_digest(record | {"visiting_fee_lkr": "6000"})
    assert agreements._document_digest(record) == agreements._document_digest(record | {"amount": 40000.0, "visiting_fee_lkr": 5000.0})
    cleared = scheduled_terms(record | {"visiting_fee_lkr": 0, "payment_schedule": [], "terms": terms})
    assert "Project-specific commercial schedule" not in cleared
    scope_only = scheduled_terms(record | {"commercial_details_visible": False, "terms": terms})
    assert "Project-specific commercial schedule" not in scope_only


def test_new_agreements_explicitly_disclose_agreed_renewal_surcharge_before_signing():
    terms = default_terms()
    assert "Client accepts a single 18%" in terms["Renewal late-payment surcharge"]
    assert "not VAT" in terms["Renewal late-payment surcharge"]
    assert "amounts already paid" in terms["Renewal late-payment surcharge"]


@pytest.mark.parametrize("patch", [{"visiting_fee_lkr": 4999}, {"visiting_fee_lkr": 15001}, {"amount": 4000, "visiting_fee_lkr": 5000}, {"payment_schedule": [{"name": "Final", "amount": 7000}]}])
def test_invalid_fee_or_payment_allocation_is_rejected(patch):
    with pytest.raises(HTTPException) as exc:
        scheduled_terms({"amount": 10000, "currency": "LKR", "visiting_fee_lkr": 0} | patch)
    assert exc.value.status_code == 422


def test_income_keeps_currency_separate_and_does_not_erase_retained_void_receipts():
    records = [
        {"id": "a", "client_id": "client-a", "currency": "LKR", "project_value": "10000", "status": "partial", "issue_date": "2026-10-01", "due_date": "2026-10-01"},
        {"id": "b", "client_id": "client-b", "currency": "LKR", "project_value": "10000", "status": "void", "issue_date": "2026-10-01"},
        {"id": "c", "client_id": "client-c", "currency": "USD", "project_value": "100", "status": "sent", "issue_date": "2026-10-01"},
        {"id": "d", "client_id": "client-d", "currency": "LKR", "project_value": "40000", "status": "draft", "issue_date": "2026-10-01"},
    ]
    payments = [{"invoice_id": "a", "amount": "2500", "currency": "LKR", "paid_at": "2026-09-30T20:00:00Z"}, {"invoice_id": "b", "amount": "9000", "currency": "LKR", "paid_at": "2026-10-03T00:00:00Z"}, {"invoice_id": "c", "amount": "25", "currency": "USD", "paid_at": "2026-10-03T00:00:00Z"}]
    report = income_report(records, payments, date(2026, 10, 1), date(2026, 10, 31), date(2026, 10, 8))
    lkr = next(item for item in report["currencies"] if item["currency"] == "LKR")
    usd = next(item for item in report["currencies"] if item["currency"] == "USD")
    assert lkr["collected"] == Decimal(11500)
    assert lkr["collected_on_void"] == Decimal(9000)
    assert lkr["outstanding"] == lkr["overdue"] == Decimal(7500)
    assert lkr["invoiced"] == Decimal(10000)
    assert lkr["draft_value"] == Decimal(40000)
    assert usd["collected"] == Decimal(25) and usd["outstanding"] == Decimal(75)
    assert sum(lkr["aging"].values()) == lkr["outstanding"]
    assert len(report["receivables"]) == 2


def test_partial_payment_shape_preserves_received_amount_without_marking_phase_fully_paid():
    shaped = invoices._shape({"project_value": "10000", "currency": "LKR", "status": "sent", "invoice_milestones": [{"id": "phase", "title": "Mid payment", "amount": "10000", "status": "pending"}], "payments": [{"milestone_id": "phase", "amount": "3000", "paid_at": "2026-10-01"}]})
    assert shaped["payments"][0]["paid_amount"] == "3000"
    assert shaped["payments"][0]["is_paid"] is False
    assert shaped["paid_amount"] == "3000" and shaped["balance_due"] == "7000"


def test_professional_email_escapes_client_content_and_has_plain_text_alternative(monkeypatch):
    sent = []
    class SMTP:
        def __init__(self, *_, **__): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def ehlo(self): pass
        def starttls(self, **kwargs): assert kwargs["context"].check_hostname
        def login(self, *_): pass
        def send_message(self, message): sent.append(message)
    monkeypatch.setattr(communications.smtplib, "SMTP", SMTP)
    cfg = settings(smtp_host="smtp.example.com", smtp_username="sender", smtp_password="secret", smtp_from_email="hello@example.com")
    request = Request({"type": "http", "headers": []})
    rate_limiter.clear()
    communications.send_email(communications.EmailRequest(to="client@example.com", subject="Invoice <update>", body="Hello <script>alert(1)</script>,\n\nINVOICE SUMMARY\nBalance: LKR 5,000"), request, Principal(uuid4(), "owner@example.com"), cfg, gateway())
    assert len(sent) == 1
    assert sent[0].get_body(preferencelist=('plain',)).get_content().startswith('Hello <script>')
    html = sent[0].get_body(preferencelist=('html',)).get_content()
    assert '<script>' not in html and '&lt;script&gt;' in html
    assert 'HICH WEB' in html and 'INVOICE SUMMARY' in html


def test_email_configuration_does_not_claim_delivery_when_unconfigured():
    with pytest.raises(HTTPException) as exc:
        communications.send_email(communications.EmailRequest(to="client@example.com", subject="Invoice", body="Payment update"), Request({"type": "http", "headers": []}), Principal(uuid4(), "owner@example.com"), settings(), gateway())
    assert exc.value.status_code == 503
