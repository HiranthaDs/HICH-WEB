from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ..config import Settings, get_settings
from ..supabase_client import SupabaseGateway, get_supabase


router = APIRouter(tags=["health"])


@router.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict[str, str]:
    return {"status": "ok", "service": settings.app_name, "environment": settings.environment}


@router.get("/health/ready")
def readiness(
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, str]:
    try:
        gateway.service.table("profiles").select("id").limit(1).execute()
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database is unavailable") from exc
    return {"status": "ready", "service": settings.app_name, "environment": settings.environment}

