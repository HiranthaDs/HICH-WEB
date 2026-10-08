from __future__ import annotations

from app.config import Settings
from app.routers.agreements import _public_shape


def test_public_agreement_shape_has_explicit_boundary() -> None:
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="publishable",
        supabase_secret_key="secret",
    )
    record = {
        "id": "internal-id",
        "public_id": "public-id",
        "title": "Agreement",
        "status": "viewed",
        "client_id": "client-id",
        "description": "Description",
        "terms": ["One"],
        "currency": "LKR",
        "clients": {"name": "Jane", "email": "jane@example.com"},
        "access_token_hash": "never-public",
        "signature_storage_path": "private/path.png",
        "signed_pdf_storage_path": "private/path.pdf",
        "signer_ip": "127.0.0.1",
        "signer_user_agent": "private agent",
        "created_by": "private-user",
        "signature_sha256": "private-hash",
    }
    shaped = _public_shape(record, settings)
    assert shaped["id"] == "public-id"
    assert shaped["client_name"] == "Jane"
    for forbidden in (
        "access_token_hash",
        "signature_storage_path",
        "signed_pdf_storage_path",
        "signer_ip",
        "signer_user_agent",
        "created_by",
        "signature_sha256",
    ):
        assert forbidden not in shaped
