from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status

from .config import Settings, get_settings
from .security import is_allowed_admin
from .supabase_client import SupabaseGateway, get_supabase


@dataclass(frozen=True)
class Principal:
    id: UUID
    email: str
    full_name: str | None = None
    role: str = "admin"


def _access_token(request: Request, settings: Settings) -> str | None:
    token = request.cookies.get(settings.access_cookie_name)
    authorization = request.headers.get("authorization", "")
    if not token and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    return token


def current_user(
    request: Request,
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Principal:
    token = _access_token(request, settings)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    try:
        result = gateway.auth_client().auth.get_user(token)
        user = result.user
        email = user.email if user else None
        if not user or not email:
            raise ValueError("Missing authenticated user")
        metadata = user.user_metadata or {}
        return Principal(
            id=UUID(str(user.id)),
            email=email,
            full_name=metadata.get("full_name") or metadata.get("name"),
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is invalid or expired",
        ) from exc


def current_admin(
    principal: Principal = Depends(current_user),
    settings: Settings = Depends(get_settings),
) -> Principal:
    if not is_allowed_admin(principal.email, settings.admin_email_set):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access required")
    return principal

