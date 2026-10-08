from __future__ import annotations

from dataclasses import dataclass
import hmac
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status

from .config import Settings, get_settings
from .security import is_allowed_admin, enforce_rate_limit, client_ip
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
    gateway: SupabaseGateway = Depends(get_supabase),
    request: Request = None,
) -> Principal:
    profile = portal_profile(principal.email, settings, gateway, str(principal.id))
    if not profile:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access required")
    if request and (request.method == "DELETE" or request.url.path.endswith("/void")):
        require_deletion_pin(request, settings, principal)
    return Principal(principal.id, principal.email, profile.get("full_name") or principal.full_name, profile["role"])


def portal_profile(email: str, settings: Settings, gateway: SupabaseGateway, user_id: str | None = None) -> dict | None:
    """Only service-managed active profiles grant access; user_metadata never grants roles."""
    try:
        query = gateway.service.table("profiles").select("id,email,full_name,role,active,portal_access")
        result = query.eq("id", user_id).limit(1).execute() if user_id else query.eq("email", email.strip().casefold()).limit(1).execute()
        if result.data:
            profile = result.data[0]
            if not profile.get("active"):
                return None
            if is_allowed_admin(email, settings.admin_email_set):
                return profile | {"role": "admin"}
            return profile if profile.get("portal_access") and profile.get("role") in {"admin", "staff"} else None
    except Exception as exc:
        raise HTTPException(503, "User access could not be verified. Apply the portal workflow migration and try again.") from exc
    return {"role": "admin"} if is_allowed_admin(email, settings.admin_email_set) else None


def require_deletion_pin(request: Request, settings: Settings, principal: Principal) -> None:
    enforce_rate_limit(f"delete-pin:{principal.id}:{client_ip(request, settings.trust_proxy_headers)}", 8, 900)
    if not hmac.compare_digest(request.headers.get("x-deletion-pin", ""), settings.deletion_pin.get_secret_value()):
        raise HTTPException(403, "Enter the correct deletion PIN to confirm this action.")


def manage_users(principal: Principal = Depends(current_admin)) -> Principal:
    if principal.role != "admin":
        raise HTTPException(403, "Only administrators can manage user access")
    return principal
