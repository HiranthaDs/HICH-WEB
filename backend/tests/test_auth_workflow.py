from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.middleware import BrowserOriginMiddleware, RequestContextMiddleware
from app.models import LoginRequest
from app.routers import auth
from app.security import rate_limiter
from app.supabase_client import get_supabase


@pytest.fixture
def auth_client():
    settings = Settings(_env_file=None, supabase_url="https://example.supabase.co", supabase_publishable_key="public", supabase_secret_key="secret", admin_emails="admin@example.com", cookie_secure=False, frontend_origins="http://localhost:5173", public_app_url="http://localhost:5173")
    user = SimpleNamespace(id=str(uuid4()), email="admin@example.com", user_metadata={})
    session = SimpleNamespace(access_token="valid-test-access", refresh_token="valid-test-refresh", expires_in=3600)
    credentials = []
    class FakeAuth:
        def sign_in_with_password(self, data):
            credentials.append(data)
            return SimpleNamespace(user=user, session=session)
        def get_user(self, token):
            assert token == session.access_token
            return SimpleNamespace(user=user)
        def refresh_session(self, token):
            assert token == session.refresh_token
            return SimpleNamespace(user=user, session=session)
    class Audit:
        def insert(self, _): return self
        def execute(self): return SimpleNamespace(data=[])
    gateway = SimpleNamespace(auth_client=lambda: SimpleNamespace(auth=FakeAuth()), service=SimpleNamespace(table=lambda _: Audit()))
    app = FastAPI()
    app.add_middleware(BrowserOriginMiddleware, settings=settings)
    app.add_middleware(RequestContextMiddleware)
    app.include_router(auth.router, prefix="/api")
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_supabase] = lambda: gateway
    rate_limiter.clear()
    return TestClient(app), credentials


def test_login_with_loopback_origin_sets_cookie_and_survives_reload(auth_client):
    client, credentials = auth_client
    result = client.post('/api/auth/login', headers={'Origin': 'http://127.0.0.1:5173'}, json={'email':'admin@example.com','password':' password with spaces '})
    assert result.status_code == 200
    assert credentials[0]['password'] == ' password with spaces '
    assert 'HttpOnly' in result.headers['set-cookie']
    assert client.get('/api/auth/me').status_code == 200
    assert client.post('/api/auth/refresh').status_code == 200
    assert client.post('/api/auth/logout').status_code == 204
    assert client.get('/api/auth/me').status_code == 401


def test_login_rejects_unknown_admin_and_untrusted_origin(auth_client):
    client, credentials = auth_client
    assert client.post('/api/auth/login', json={'email':'visitor@example.com','password':'secret'}).status_code == 401
    assert credentials == []
    assert client.post('/api/auth/login', headers={'Origin':'https://untrusted.example'}, json={'email':'admin@example.com','password':'secret'}).status_code == 403


def test_login_does_not_impose_new_password_policy_on_existing_credentials():
    assert LoginRequest(email='admin@example.com', password='oldpwd').password == 'oldpwd'


def test_production_does_not_add_development_origins():
    settings = Settings(_env_file=None, environment='production', supabase_url='https://example.supabase.co', supabase_publishable_key='public', supabase_secret_key='secret', frontend_origins='https://hich.example')
    assert settings.allowed_origins == ['https://hich.example']
