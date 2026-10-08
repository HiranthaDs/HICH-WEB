from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from fastapi import HTTPException, Request, Response, status

from .config import Settings


SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
DATA_URL_RE = re.compile(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$")
IMAGE_MAGIC = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/webp": (b"RIFF",),
}


def normalize_email(value: str) -> str:
    return value.strip().casefold()


def is_allowed_admin(email: str | None, allowlist: frozenset[str]) -> bool:
    return bool(email) and normalize_email(email) in allowlist


def new_public_token() -> str:
    return secrets.token_urlsafe(32)


def hash_public_token(token: str, pepper: str = "") -> str:
    return hmac.new(pepper.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()


def content_sha256(*parts: object) -> str:
    canonical = "\x1f".join("" if part is None else str(part) for part in parts)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def decode_image_data_url(value: str, max_bytes: int) -> tuple[bytes, str, str]:
    match = DATA_URL_RE.fullmatch(value.strip())
    if not match:
        raise ValueError("Signature must be a PNG, JPEG, or WebP data URL")
    content_type, encoded = match.groups()
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Signature image is not valid base64") from exc
    if not payload or len(payload) > max_bytes:
        raise ValueError(f"Signature image must be between 1 and {max_bytes} bytes")
    if not any(payload.startswith(prefix) for prefix in IMAGE_MAGIC[content_type]):
        raise ValueError("Signature image content does not match its declared type")
    if content_type == "image/webp" and payload[8:12] != b"WEBP":
        raise ValueError("Signature image content does not match its declared type")
    extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[content_type]
    return payload, content_type, extension


def validate_image_bytes(payload: bytes, content_type: str, max_bytes: int) -> str:
    if content_type not in IMAGE_MAGIC:
        raise ValueError("Only PNG, JPEG, and WebP images are supported")
    if not payload or len(payload) > max_bytes:
        raise ValueError(f"Image must be between 1 and {max_bytes} bytes")
    if not any(payload.startswith(prefix) for prefix in IMAGE_MAGIC[content_type]):
        raise ValueError("Image content does not match its declared type")
    if content_type == "image/webp" and payload[8:12] != b"WEBP":
        raise ValueError("Image content does not match its declared type")
    return {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[content_type]


def client_ip(request: Request, trust_proxy_headers: bool) -> str:
    if trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


def set_session_cookies(
    response: Response,
    settings: Settings,
    access_token: str,
    refresh_token: str,
    expires_in: int,
) -> str:
    common = {
        "httponly": True,
        "secure": settings.cookie_secure,
        "samesite": "strict",
        "domain": settings.cookie_domain,
        "path": "/",
    }
    response.set_cookie(
        settings.access_cookie_name,
        access_token,
        max_age=min(max(expires_in, 300), settings.access_cookie_max_age),
        **common,
    )
    response.set_cookie(
        settings.refresh_cookie_name,
        refresh_token,
        max_age=settings.refresh_cookie_max_age,
        **common,
    )
    csrf_token = secrets.token_urlsafe(32)
    response.set_cookie(
        settings.csrf_cookie_name,
        csrf_token,
        max_age=settings.refresh_cookie_max_age,
        httponly=False,
        secure=settings.cookie_secure,
        samesite="strict",
        domain=settings.cookie_domain,
        path="/",
    )
    return csrf_token


def clear_session_cookies(response: Response, settings: Settings) -> None:
    for name in (settings.access_cookie_name, settings.refresh_cookie_name, settings.csrf_cookie_name):
        response.delete_cookie(name, domain=settings.cookie_domain, path="/")


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    remaining: int
    retry_after: int


class SlidingWindowRateLimiter:
    """Small process-local limiter; production-wide limits remain enforced by Supabase Auth."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window_seconds: int) -> RateLimitResult:
        now = self._clock()
        cutoff = now - window_seconds
        with self._lock:
            events = self._events[key]
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= limit:
                retry_after = max(1, int(window_seconds - (now - events[0])))
                return RateLimitResult(False, 0, retry_after)
            events.append(now)
            return RateLimitResult(True, max(0, limit - len(events)), 0)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()


rate_limiter = SlidingWindowRateLimiter()


def enforce_rate_limit(key: str, limit: int, window_seconds: int) -> None:
    result = rate_limiter.check(key, limit, window_seconds)
    if not result.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests. Please try again later.",
            headers={"Retry-After": str(result.retry_after)},
        )


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
