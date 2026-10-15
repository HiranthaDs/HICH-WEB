from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import config
from app.config import Settings, get_settings
from app.routers import operations
from app.supabase_client import get_supabase


@pytest.fixture
def delivery_client(monkeypatch):
    settings = Settings(
        _env_file=None,
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="public",
        supabase_secret_key="secret",
        admin_emails="admin@example.com",
    )
    monkeypatch.setattr(config, "get_settings", lambda: settings)
    from app import main

    # The module creates its default app on first import. Keep its original
    # settings dependency available after this isolated fixture is restored.
    main.get_settings = get_settings
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    document = {"id": "change-1", "status": "sent", "description": "Approved scope details. " * 500}
    monkeypatch.setattr(operations, "find_change", lambda *_args: document)
    app = main.create_app()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_supabase] = lambda: SimpleNamespace()
    return TestClient(app), document


def test_compressed_client_documents_keep_private_delivery_headers(delivery_client):
    client, document = delivery_client
    response = client.get("/api/public/changes/test-link", headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in response.headers["vary"].lower()
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.json()["change"]["description"] == document["description"]


def test_clients_without_compression_receive_the_same_document(delivery_client):
    client, document = delivery_client
    response = client.get("/api/public/changes/test-link", headers={"Accept-Encoding": "identity"})

    assert response.status_code == 200
    assert "content-encoding" not in response.headers
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["change"]["description"] == document["description"]
