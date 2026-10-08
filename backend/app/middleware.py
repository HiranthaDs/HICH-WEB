from __future__ import annotations

import secrets
from urllib.parse import urlsplit

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse, Response

from .config import Settings
from .security import SAFE_METHODS


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("x-request-id", "")[:100] or secrets.token_hex(12)
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        private_document = request.url.path.startswith(("/api/", "/sign/", "/invoice/", "/change/", "/collection/"))
        response.headers["Referrer-Policy"] = "no-referrer" if private_document else "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Cache-Control"] = "no-store" if private_document else "private, no-cache"
        response.headers["X-Frame-Options"] = "DENY"
        return response


class BrowserOriginMiddleware(BaseHTTPMiddleware):
    """Reject cross-origin browser mutations while keeping non-browser API clients usable."""

    def __init__(self, app: object, settings: Settings) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        configured = {origin.rstrip("/") for origin in settings.allowed_origins}
        public = str(settings.public_app_url).rstrip("/")
        configured.add(public)
        self.allowed = configured

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.method not in SAFE_METHODS:
            origin = request.headers.get("origin")
            if origin and origin.rstrip("/") not in self.allowed:
                return JSONResponse({"detail": "Origin is not allowed"}, status_code=403)
            if not origin:
                referer = request.headers.get("referer")
                if referer:
                    parts = urlsplit(referer)
                    referer_origin = f"{parts.scheme}://{parts.netloc}".rstrip("/")
                    if referer_origin not in self.allowed:
                        return JSONResponse({"detail": "Origin is not allowed"}, status_code=403)
        return await call_next(request)
