from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "backend"


class Settings(BaseSettings):
    """Runtime configuration loaded exclusively from environment variables."""

    environment: Literal["development", "test", "production"] = "development"
    app_name: str = "Hich Client Portal API"
    api_prefix: str = "/api"

    supabase_url: AnyHttpUrl
    supabase_publishable_key: SecretStr
    supabase_secret_key: SecretStr
    admin_emails: str = ""

    frontend_origins: str = "http://localhost:5173"
    public_app_url: AnyHttpUrl = "http://localhost:8000"
    render_external_url: AnyHttpUrl | None = None
    # Vercel exposes these as hostnames (without a scheme). Keeping them as
    # strings lets the same settings model run outside Vercel as well.
    vercel_project_production_url: str = ""
    vercel_url: str = ""
    # Vercel Services injects this URL from the service named "frontend".
    frontend_url: str = ""
    deletion_pin: SecretStr = SecretStr("2113")
    smtp_host: str = ""
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_username: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_from_email: str = ""
    smtp_from_name: str = "Hich Web"
    smtp_ssl: bool = False

    access_cookie_name: str = "hich_access"
    refresh_cookie_name: str = "hich_refresh"
    csrf_cookie_name: str = "hich_csrf"
    cookie_secure: bool = True
    cookie_domain: str | None = None
    access_cookie_max_age: int = Field(default=3600, ge=300, le=86400)
    refresh_cookie_max_age: int = Field(default=2_592_000, ge=3600)

    token_hash_pepper: SecretStr = SecretStr("")
    # Comma-separated former TOKEN_HASH_PEPPER or SUPABASE_SECRET_KEY values.
    # These are read-only compatibility keys for links issued before v2 tokens.
    legacy_public_link_keys: SecretStr = SecretStr("")
    trust_proxy_headers: bool = True
    portfolio_bucket: str = "portfolio-assets"
    signature_bucket: str = "agreement-signatures"
    agreement_pdf_bucket: str = "agreement-pdfs"
    max_image_bytes: int = Field(default=6_000_000, ge=100_000, le=20_000_000)
    max_signature_bytes: int = Field(default=1_500_000, ge=50_000, le=5_000_000)

    login_rate_limit: int = Field(default=8, ge=1, le=100)
    login_rate_window_seconds: int = Field(default=900, ge=10, le=3600)
    signing_rate_limit: int = Field(default=12, ge=1, le=100)
    signing_rate_window_seconds: int = Field(default=3600, ge=60, le=86400)

    model_config = SettingsConfigDict(
        env_file=(
            PROJECT_ROOT / ".env",
            PROJECT_ROOT / ".env.local",
            BACKEND_ROOT / ".env",
            BACKEND_ROOT / ".env.local",
        ),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("cookie_domain", mode="before")
    @classmethod
    def blank_domain_is_none(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator("public_app_url", "render_external_url", mode="after")
    @classmethod
    def public_origin_only(cls, value: AnyHttpUrl | None) -> AnyHttpUrl | None:
        if value is None:
            return None
        parsed = urlsplit(str(value))
        return AnyHttpUrl(urlunsplit((parsed.scheme, parsed.netloc, "", "", "")))

    @model_validator(mode="after")
    def production_public_url(self) -> "Settings":
        if self.environment == "production" and self.public_app_url.host in {"localhost", "127.0.0.1", "0.0.0.0"}:
            deployment_origin = self._vercel_origin(self.vercel_project_production_url) or self._vercel_origin(self.frontend_url) or self._vercel_origin(self.vercel_url)
            if deployment_origin:
                self.public_app_url = AnyHttpUrl(deployment_origin)
            elif self.render_external_url:
                self.public_app_url = self.render_external_url
        return self

    @staticmethod
    def _vercel_origin(value: str) -> str | None:
        """Return the HTTPS origin from a trusted Vercel system hostname."""
        candidate = value.strip()
        if not candidate:
            return None
        if "://" not in candidate:
            candidate = f"https://{candidate}"
        parsed = urlsplit(candidate)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            return None
        return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))

    @property
    def admin_email_set(self) -> frozenset[str]:
        return frozenset(
            item.strip().casefold() for item in self.admin_emails.split(",") if item.strip()
        )

    @property
    def allowed_origins(self) -> list[str]:
        origins = [item.strip().rstrip("/") for item in self.frontend_origins.split(",") if item.strip()]
        # Render provides this trusted environment value, independent of proxy Host headers.
        if self.render_external_url:
            origins.append(str(self.render_external_url).rstrip("/"))
        # These trusted system values cover the stable production hostname and
        # the deployment currently running the API (including preview builds).
        for value in (self.vercel_project_production_url, self.vercel_url, self.frontend_url):
            origin = self._vercel_origin(value)
            if origin:
                origins.append(origin)
        # Browsers treat localhost and 127.0.0.1 as distinct origins. Both are
        # common entry points for Vite/Uvicorn during local development.
        if self.environment != "production":
            for origin in list(origins):
                parsed = urlsplit(origin)
                if parsed.hostname in {"localhost", "127.0.0.1"}:
                    alternate = "127.0.0.1" if parsed.hostname == "localhost" else "localhost"
                    netloc = f"{alternate}:{parsed.port}" if parsed.port else alternate
                    origins.append(urlunsplit((parsed.scheme, netloc, "", "", "")))
        return list(dict.fromkeys(origins))

    @property
    def legacy_link_key_set(self) -> tuple[str, ...]:
        current_pepper = self.token_hash_pepper.get_secret_value()
        current_supabase_key = self.supabase_secret_key.get_secret_value()
        previous = self.legacy_public_link_keys.get_secret_value().split(",")
        return tuple(dict.fromkeys(
            value.strip()
            for value in (current_pepper, current_supabase_key, *previous)
            if value.strip()
        ))


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
