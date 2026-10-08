from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from supabase_auth.errors import AuthApiError
from pydantic import BaseModel, ConfigDict, EmailStr, Field

from ..config import Settings, get_settings
from ..data import audit
from ..dependencies import Principal, current_admin
from ..models import LoginRequest
from ..security import (
    clear_session_cookies,
    client_ip,
    enforce_rate_limit,
    is_allowed_admin,
    normalize_email,
    set_session_cookies,
)
from ..supabase_client import SupabaseGateway, get_supabase


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


class RecoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    access_token: str = Field(min_length=20, max_length=20000)
    refresh_token: str = Field(min_length=5, max_length=20000)
    password: str = Field(min_length=12, max_length=256)


@router.post("/recover")
def recover_password(payload: RecoveryRequest, request: Request, settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    enforce_rate_limit(f"recover:{client_ip(request, settings.trust_proxy_headers)}", 3, 900)
    if is_allowed_admin(str(payload.email), settings.admin_email_set):
        try:
            gateway.auth_client().auth.reset_password_for_email(str(payload.email), {"redirect_to": f"{str(settings.public_app_url).rstrip('/')}/admin/reset-password"})
        except Exception as exc:
            logger.warning("Password recovery service unavailable (%s)", type(exc).__name__)
            raise HTTPException(503, "Password recovery is temporarily unavailable. Please try again later.") from exc
    return {"message": "If this address has administrator access, a password reset link has been requested. Check your inbox and spam folder."}


@router.post("/reset-password")
def reset_password(payload: ResetPasswordRequest, request: Request, response: Response, settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    enforce_rate_limit(f"reset:{client_ip(request, settings.trust_proxy_headers)}", 5, 900)
    try:
        auth = gateway.auth_client().auth
        session_response = auth.set_session(payload.access_token, payload.refresh_token)
        user = session_response.user
        if not user or not is_allowed_admin(user.email, settings.admin_email_set):
            raise HTTPException(403, "Administrator access required")
        # Supabase validates token expiry and updates only the authenticated user.
        auth.update_user({"password": payload.password})
        principal = Principal(id=UUID(str(user.id)), email=user.email)
        audit(gateway.service, request, settings, "password_reset", "session", actor=principal)
        clear_session_cookies(response, settings)
        return {"message": "Password updated. Sign in with your new password."}
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Password reset rejected (%s)", type(exc).__name__)
        raise HTTPException(400, "This reset link is invalid or expired. Request a new link; choose a password different from your previous one.") from exc


def _user_payload(principal: Principal) -> dict[str, object]:
    return {
        "id": str(principal.id),
        "email": principal.email,
        "name": principal.full_name,
        "full_name": principal.full_name,
        "role": principal.role,
    }


@router.post("/login")
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, object]:
    ip = client_ip(request, settings.trust_proxy_headers)
    enforce_rate_limit(
        f"login:{ip}:{normalize_email(str(payload.email))}",
        settings.login_rate_limit,
        settings.login_rate_window_seconds,
    )
    if not is_allowed_admin(str(payload.email), settings.admin_email_set):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    try:
        auth_response = gateway.auth_client().auth.sign_in_with_password(
            {"email": str(payload.email), "password": payload.password}
        )
        session = auth_response.session
        user = auth_response.user
        if not session or not user or not user.email:
            raise ValueError("Supabase returned no session")
        if not is_allowed_admin(user.email, settings.admin_email_set):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access required")
        metadata = user.user_metadata or {}
        principal = Principal(
            id=UUID(str(user.id)),
            email=user.email,
            full_name=metadata.get("full_name") or metadata.get("name"),
        )
        csrf_token = set_session_cookies(
            response,
            settings,
            session.access_token,
            session.refresh_token,
            int(session.expires_in or settings.access_cookie_max_age),
        )
        audit(gateway.service, request, settings, "login", "session", actor=principal)
        return {
            "user": _user_payload(principal),
            "csrf_token": csrf_token,
            "expires_in": int(session.expires_in or settings.access_cookie_max_age),
        }
    except HTTPException:
        raise
    except AuthApiError as exc:
        if exc.status in {400, 401, 403}:
            logger.info("Rejected admin login for %s", payload.email)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password",
            ) from exc
        logger.exception("Supabase Auth rejected the login request")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Authentication service is temporarily unavailable",
        ) from exc
    except Exception as exc:
        logger.exception("Could not reach Supabase Auth")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Authentication service is temporarily unavailable",
        ) from exc


@router.post("/refresh")
def refresh(
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, object]:
    refresh_token = request.cookies.get(settings.refresh_cookie_name)
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh session required")
    try:
        auth_response = gateway.auth_client().auth.refresh_session(refresh_token)
        session = auth_response.session
        user = auth_response.user
        if not session or not user or not user.email or not is_allowed_admin(user.email, settings.admin_email_set):
            raise ValueError("Invalid refreshed session")
        metadata = user.user_metadata or {}
        principal = Principal(
            id=UUID(str(user.id)),
            email=user.email,
            full_name=metadata.get("full_name") or metadata.get("name"),
        )
        csrf_token = set_session_cookies(
            response,
            settings,
            session.access_token,
            session.refresh_token,
            int(session.expires_in or settings.access_cookie_max_age),
        )
        return {"user": _user_payload(principal), "csrf_token": csrf_token}
    except Exception:
        rejected = JSONResponse({"detail": "Refresh session is invalid"}, status_code=401)
        clear_session_cookies(rejected, settings)
        return rejected


@router.get("/me")
def me(principal: Principal = Depends(current_admin)) -> dict[str, object]:
    return {"user": _user_payload(principal)}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> None:
    audit(gateway.service, request, settings, "logout", "session", actor=principal)
    clear_session_cookies(response, settings)
