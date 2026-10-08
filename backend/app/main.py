from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .middleware import BrowserOriginMiddleware, RequestContextMiddleware
from .routers import agreements, audit, auth, clients, dashboard, health, invoices, portfolio, operations


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    if not settings.admin_email_set:
        message = "ADMIN_EMAILS must contain at least one administrator email"
        if settings.environment == "production":
            raise RuntimeError(message)
        logger.warning(message)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        docs_url="/api/docs" if settings.environment != "production" else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.environment != "production" else None,
        lifespan=lifespan,
    )
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(BrowserOriginMiddleware, settings=settings)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Accept", "Authorization", "Content-Type", "X-Request-ID", "X-CSRF-Token"],
    )

    prefix = settings.api_prefix.rstrip("/")
    app.include_router(health.router, prefix=prefix)
    app.include_router(auth.router, prefix=prefix)
    app.include_router(dashboard.router, prefix=prefix)
    app.include_router(clients.router, prefix=prefix)
    app.include_router(agreements.router, prefix=prefix)
    app.include_router(invoices.router, prefix=prefix)
    app.include_router(invoices.public_router, prefix=prefix)
    app.include_router(operations.router, prefix=prefix)
    app.include_router(operations.public_router, prefix=prefix)
    app.include_router(portfolio.router, prefix=prefix)
    app.include_router(audit.router, prefix=prefix)
    app.include_router(agreements.public_router, prefix=prefix)
    app.include_router(portfolio.public_router, prefix=prefix)

    # In the single Render service the Vite build sits beside backend/. API routes
    # are registered first so SPA fallback can never shadow them.
    frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if frontend_dist.is_dir() and (frontend_dist / "index.html").is_file():
        assets_dir = frontend_dist / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

        @app.get("/{spa_path:path}", include_in_schema=False)
        def serve_spa(spa_path: str) -> FileResponse:
            if spa_path == prefix.lstrip("/") or spa_path.startswith(prefix.lstrip("/") + "/"):
                raise HTTPException(status_code=404, detail="API route not found")
            candidate = (frontend_dist / spa_path).resolve()
            try:
                candidate.relative_to(frontend_dist.resolve())
            except ValueError as exc:
                raise HTTPException(status_code=404, detail="Not found") from exc
            if candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(frontend_dist / "index.html")
    return app


app = create_app()
