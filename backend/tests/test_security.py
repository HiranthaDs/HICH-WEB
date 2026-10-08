from __future__ import annotations

import base64

import pytest

from app.security import (
    SlidingWindowRateLimiter,
    content_sha256,
    decode_image_data_url,
    hash_public_token,
    is_allowed_admin,
    new_public_token,
    normalize_email,
    validate_image_bytes,
)


def test_email_allowlist_is_case_insensitive() -> None:
    allowlist = frozenset({"admin@example.com"})
    assert normalize_email(" Admin@Example.COM ") == "admin@example.com"
    assert is_allowed_admin("Admin@Example.com", allowlist)
    assert not is_allowed_admin("other@example.com", allowlist)
    assert not is_allowed_admin(None, allowlist)


def test_public_tokens_are_random_and_hash_is_peppered() -> None:
    first = new_public_token()
    second = new_public_token()
    assert first != second
    assert len(first) >= 40
    assert hash_public_token(first, "pepper-a") == hash_public_token(first, "pepper-a")
    assert hash_public_token(first, "pepper-a") != hash_public_token(first, "pepper-b")
    assert first not in hash_public_token(first, "pepper-a")


def test_signature_data_url_validation() -> None:
    png = b"\x89PNG\r\n\x1a\n" + b"safe-test-payload"
    value = "data:image/png;base64," + base64.b64encode(png).decode()
    content, mime, extension = decode_image_data_url(value, 1024)
    assert content == png
    assert mime == "image/png"
    assert extension == "png"

    with pytest.raises(ValueError, match="declared type"):
        decode_image_data_url("data:image/png;base64," + base64.b64encode(b"not png").decode(), 1024)


def test_raw_image_validation_checks_type_size_and_magic() -> None:
    jpeg = b"\xff\xd8\xff" + b"payload"
    assert validate_image_bytes(jpeg, "image/jpeg", 100) == "jpg"
    with pytest.raises(ValueError, match="supported"):
        validate_image_bytes(jpeg, "image/gif", 100)
    with pytest.raises(ValueError, match="between"):
        validate_image_bytes(jpeg * 100, "image/jpeg", 100)


def test_sliding_window_rate_limiter() -> None:
    now = [100.0]
    limiter = SlidingWindowRateLimiter(clock=lambda: now[0])
    assert limiter.check("login:a", 2, 10).allowed
    assert limiter.check("login:a", 2, 10).allowed
    blocked = limiter.check("login:a", 2, 10)
    assert not blocked.allowed
    assert blocked.retry_after == 10
    now[0] = 111.0
    assert limiter.check("login:a", 2, 10).allowed


def test_content_hash_is_order_sensitive_and_stable() -> None:
    assert content_sha256("a", "b") == content_sha256("a", "b")
    assert content_sha256("a", "b") != content_sha256("b", "a")

