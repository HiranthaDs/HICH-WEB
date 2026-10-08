from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from supabase_auth.errors import AuthApiError
from pydantic import BaseModel, ConfigDict, EmailStr, Field

from ..config import Settings, get_settings
from ..data import audit
from ..dependencies import Principal, current_admin, portal_profile, manage_users, require_deletion_pin
from ..data import rows, first, db_failure
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
    if portal_profile(str(payload.email), settings, gateway):
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
        if not user or not user.email or not portal_profile(user.email, settings, gateway, str(user.id)):
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
    if not portal_profile(str(payload.email), settings, gateway):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    try:
        auth_response = gateway.auth_client().auth.sign_in_with_password(
            {"email": str(payload.email), "password": payload.password}
        )
        session = auth_response.session
        user = auth_response.user
        if not session or not user or not user.email:
            raise ValueError("Supabase returned no session")
        profile = portal_profile(user.email, settings, gateway, str(user.id))
        if not profile:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access required")
        metadata = user.user_metadata or {}
        principal = Principal(
            id=UUID(str(user.id)),
            email=user.email,
            full_name=metadata.get("full_name") or metadata.get("name"),
            role=profile["role"],
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
        if not session or not user or not user.email:
            raise ValueError("Invalid refreshed session")
        profile = portal_profile(user.email, settings, gateway, str(user.id))
        if not profile:
            raise ValueError("Account has no portal access")
        metadata = user.user_metadata or {}
        principal = Principal(
            id=UUID(str(user.id)),
            email=user.email,
            full_name=metadata.get("full_name") or metadata.get("name"),
            role=profile["role"],
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


class ChangePasswordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=12, max_length=256)


class CreateUserRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=160)
    role: str = Field(default="staff", pattern="^(admin|staff)$")


class UpdateUserRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    full_name: str = Field(min_length=2, max_length=160)
    role: str = Field(pattern="^(admin|staff)$")
    active: bool


@router.post("/change-password")
def change_password(payload: ChangePasswordRequest, request: Request, response: Response,
                    principal: Principal = Depends(current_admin), settings: Settings = Depends(get_settings),
                    gateway: SupabaseGateway = Depends(get_supabase)):
    enforce_rate_limit(f"change-password:{principal.id}", 5, 900)
    if payload.current_password == payload.password:
        raise HTTPException(422, "Choose a new password different from your current password")
    auth_client = gateway.auth_client().auth
    try:
        verified = auth_client.sign_in_with_password({"email": principal.email, "password": payload.current_password})
        if not verified.user or str(verified.user.id) != str(principal.id):
            raise HTTPException(403, "Current password is incorrect")
    except HTTPException:
        raise
    except AuthApiError as exc:
        raise HTTPException(403, "Current password is incorrect") from exc
    try:
        auth_client.update_user({"password": payload.password})
        auth_client.sign_out({"scope": "global"})
        clear_session_cookies(response, settings)
        audit(gateway.service, request, settings, "password_changed", "user", principal.id, principal)
        return {"message": "Password changed. Sign in again with your new password."}
    except Exception as exc:
        raise HTTPException(503, "Password update could not be completed. Try signing in with your new password before retrying.") from exc


@router.get("/users")
def list_users(_: Principal = Depends(manage_users), gateway: SupabaseGateway = Depends(get_supabase), settings: Settings = Depends(get_settings)):
    try:
        accounts = rows(gateway.service.table("profiles").select("id,email,full_name,role,active,portal_access,created_at").in_("role", ["admin", "staff"]).order("created_at", desc=True).execute())
        return {"users": [account | {"role": "admin" if is_allowed_admin(account["email"], settings.admin_email_set) else account["role"]} for account in accounts if account.get("portal_access") or is_allowed_admin(account["email"], settings.admin_email_set)]}
    except Exception as exc:
        raise db_failure(exc, "load users") from exc


@router.post("/users", status_code=201)
def create_user(payload: CreateUserRequest, request: Request, principal: Principal = Depends(manage_users),
                settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    enforce_rate_limit(f"invite-user:{principal.id}", 10, 900)
    email = normalize_email(str(payload.email))
    try:
        existing = rows(gateway.service.table("profiles").select("id,portal_access,role,active").eq("email", email).limit(1).execute())
        if existing and (existing[0].get("portal_access") or is_allowed_admin(email, settings.admin_email_set)):
            raise HTTPException(409, "This user already exists. Edit their access instead.")
        if existing:
            saved = first(gateway.service.table("profiles").update({"full_name": payload.full_name, "role": payload.role, "active": True, "portal_access": True}).eq("id", existing[0]["id"]).execute(), "User")
            message = "Existing account granted portal access. Password reset email requested."
            try:
                gateway.auth_client().auth.reset_password_for_email(email, {"redirect_to": f"{str(settings.public_app_url).rstrip('/')}/admin/reset-password"})
            except Exception:
                message = "Portal access granted. Reset email could not be requested; use Send password reset to retry."
            audit(gateway.service, request, settings, "user_access_granted", "user", saved["id"], principal, {"role": payload.role})
            return {"user": saved, "message": message}
        invited = gateway.service.auth.admin.invite_user_by_email(email, options={
            "redirect_to": f"{str(settings.public_app_url).rstrip('/')}/admin/reset-password",
            "data": {"full_name": payload.full_name},
        })
        if not invited.user:
            raise HTTPException(502, "The authentication service did not return the invited user")
        user_id = str(invited.user.id)
        try:
            saved = first(gateway.service.table("profiles").upsert({
                "id": user_id, "email": email, "full_name": payload.full_name, "role": payload.role, "active": True, "portal_access": True,
            }).execute(), "User")
        except Exception as exc:
            # Invitation can be delivered before profile provisioning; default staff must not gain access.
            gateway.service.auth.admin.delete_user(user_id)
            raise exc
        audit(gateway.service, request, settings, "user_invited", "user", user_id, principal, {"role": payload.role})
        return {"user": saved, "message": "Invitation sent. The user sets their own password through the secure email link."}
    except HTTPException:
        raise
    except AuthApiError as exc:
        raise HTTPException(409 if exc.status in {400, 422} else 502, "Could not invite this email. Check whether it already has an account and verify the Supabase email settings.") from exc
    except Exception as exc:
        raise db_failure(exc, "invite the user") from exc


@router.put("/users/{user_id}")
def update_user(user_id: UUID, payload: UpdateUserRequest, request: Request,
                principal: Principal = Depends(manage_users), settings: Settings = Depends(get_settings),
                gateway: SupabaseGateway = Depends(get_supabase)):
    if user_id == principal.id and (not payload.active or payload.role != "admin"):
        raise HTTPException(409, "You cannot remove your own administrator access")
    try:
        if not payload.active:
            require_deletion_pin(request, settings, principal)
        target = first(gateway.service.table("profiles").select("id,email").eq("id", str(user_id)).limit(1).execute(), "User")
        if is_allowed_admin(target["email"], settings.admin_email_set) and payload.role != "admin":
            raise HTTPException(409, "Bootstrap administrators keep their admin role. Remove the email from ADMIN_EMAILS before changing that role.")
        saved = first(gateway.service.table("profiles").update(payload.model_dump() | {"portal_access": True}).eq("id", str(user_id)).execute(), "User")
        audit(gateway.service, request, settings, "user_access_updated", "user", user_id, principal, {"role": payload.role, "active": payload.active})
        return {"user": saved}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "update user access") from exc


@router.post("/users/{user_id}/recover")
def recover_user(user_id: UUID, request: Request, principal: Principal = Depends(manage_users),
                 settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    enforce_rate_limit(f"admin-recovery:{principal.id}", 5, 900)
    profile = first(gateway.service.table("profiles").select("email,active,role").eq("id", str(user_id)).limit(1).execute(), "User")
    if not profile.get("active") or profile.get("role") not in {"admin", "staff"}:
        raise HTTPException(409, "Restore portal access before requesting password recovery")
    try:
        gateway.auth_client().auth.reset_password_for_email(profile["email"], {"redirect_to": f"{str(settings.public_app_url).rstrip('/')}/admin/reset-password"})
        audit(gateway.service, request, settings, "user_recovery_requested", "user", user_id, principal)
        return {"message": "Password reset email requested."}
    except Exception as exc:
        raise HTTPException(503, "Password recovery is temporarily unavailable") from exc
