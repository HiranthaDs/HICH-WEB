from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile, status

from ..config import Settings, get_settings
from ..data import audit, db_failure, first, rows
from ..dependencies import Principal, current_admin
from ..models import PortfolioImageUpdate, PortfolioProjectCreate, PortfolioProjectUpdate, json_ready
from ..security import validate_image_bytes
from ..slugs import normalize_project_slug
from ..supabase_client import SupabaseGateway, get_supabase


router = APIRouter(prefix="/portfolio", tags=["portfolio"])
public_router = APIRouter(prefix="/public", tags=["public"])
PUBLIC_PROJECT_SELECT = "id,project_code,title,slug,url,main_description,sub_description,category,featured,published,sort_order,created_at,updated_at,portfolio_images(id,storage_path,alt_text,position,is_cover,created_at)"


def _slugify(value: str) -> str:
    return normalize_project_slug(value, 220) or f"project-{uuid4().hex[:8]}"


def _public_url(gateway: SupabaseGateway, settings: Settings, path: str) -> str:
    return str(gateway.service.storage.from_(settings.portfolio_bucket).get_public_url(path))


def _enrich_project(project: dict[str, Any], gateway: SupabaseGateway, settings: Settings) -> dict[str, Any]:
    image_rows = project.pop("portfolio_images", None) or project.get("image_records") or []
    image_rows = sorted(image_rows, key=lambda image: (image.get("position", 0), image.get("created_at", "")))
    for image in image_rows:
        image["public_url"] = _public_url(gateway, settings, image["storage_path"])
    project["image_records"] = image_rows
    project["images"] = [image["public_url"] for image in image_rows]
    project["image_urls"] = list(project["images"])
    return project


def _fetch_project(project_id: UUID, gateway: SupabaseGateway, settings: Settings) -> dict[str, Any]:
    result = gateway.service.table("portfolio_projects").select("*,portfolio_images(*)").eq("id", str(project_id)).limit(1).execute()
    return _enrich_project(first(result, "Portfolio project"), gateway, settings)


@router.get("")
def list_projects(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        result = rows(
            gateway.service.table("portfolio_projects")
            .select("*,portfolio_images(*)")
            .order("sort_order")
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        items = [_enrich_project(item, gateway, settings) for item in result]
        return {"projects": {"items": items, "total": len(items)}}
    except Exception as exc:
        raise db_failure(exc, "load portfolio projects") from exc


@public_router.get("/portfolio")
def public_portfolio(
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        result = rows(
            gateway.service.table("portfolio_projects")
            .select(PUBLIC_PROJECT_SELECT)
            .eq("published", True)
            .order("sort_order")
            .order("created_at", desc=True)
            .execute()
        )
        items = [_enrich_project(item, gateway, settings) for item in result]
        return {"projects": {"items": items, "total": len(items)}}
    except Exception as exc:
        raise db_failure(exc, "load the public portfolio") from exc


@router.post("", status_code=status.HTTP_201_CREATED)
def create_project(
    payload: PortfolioProjectCreate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    record = json_ready(payload, exclude={"images", "image_urls"}) | {"created_by": str(principal.id)}
    record["published"] = False
    if not record.get("slug"):
        record["slug"] = _slugify(payload.title)
    if not record.get("project_code"):
        record["project_code"] = str(record["slug"]).replace("-", "_").upper()[:50]
    try:
        created = first(gateway.service.table("portfolio_projects").insert(record).execute(), "Portfolio project")
        audit(gateway.service, request, settings, "create", "portfolio_project", created["id"], principal)
        return {"project": _fetch_project(UUID(created["id"]), gateway, settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "create the portfolio project") from exc


@router.get("/{project_id}")
def get_project(
    project_id: UUID,
    _: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    try:
        return {"project": _fetch_project(project_id, gateway, settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "load the portfolio project") from exc


@router.put("/{project_id}")
@router.patch("/{project_id}")
def update_project(
    project_id: UUID,
    payload: PortfolioProjectUpdate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    changes = json_ready(payload, exclude_unset=True, exclude={"images", "image_urls"})
    try:
        if changes:
            first(gateway.service.table("portfolio_projects").update(changes).eq("id", str(project_id)).execute(), "Portfolio project")
            audit(gateway.service, request, settings, "update", "portfolio_project", project_id, principal, {"fields": sorted(changes)})
        return {"project": _fetch_project(project_id, gateway, settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "update the portfolio project") from exc


@router.post("/{project_id}/images", status_code=status.HTTP_201_CREATED)
def upload_project_images(
    project_id: UUID,
    request: Request,
    images: list[UploadFile] = File(...),
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    if not images or len(images) > 3:
        raise HTTPException(status_code=422, detail="Upload between 1 and 3 images")
    _fetch_project(project_id, gateway, settings)
    existing = rows(gateway.service.table("portfolio_images").select("position").eq("project_id", str(project_id)).execute())
    if len(existing) + len(images) > 3:
        raise HTTPException(status_code=422, detail="A portfolio project can have at most 3 images")
    next_position = max((int(item.get("position", 0)) for item in existing), default=-1) + 1
    uploaded_paths: list[str] = []
    image_records: list[dict[str, Any]] = []
    try:
        for index, upload in enumerate(images):
            content_type = (upload.content_type or "").lower()
            content = upload.file.read(settings.max_image_bytes + 1)
            try:
                extension = validate_image_bytes(content, content_type, settings.max_image_bytes)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=f"{upload.filename or 'Image'}: {exc}") from exc
            path = f"projects/{project_id}/{uuid4().hex}.{extension}"
            gateway.service.storage.from_(settings.portfolio_bucket).upload(
                path=path,
                file=content,
                file_options={"content-type": content_type, "cache-control": "31536000", "upsert": "false"},
            )
            uploaded_paths.append(path)
            image_records.append(
                {
                    "project_id": str(project_id),
                    "storage_path": path,
                    "alt_text": (upload.filename or "Project image")[:300],
                    "position": next_position + index,
                    "is_cover": not existing and index == 0,
                }
            )
        gateway.service.table("portfolio_images").insert(image_records).execute()
        audit(gateway.service, request, settings, "upload_images", "portfolio_project", project_id, principal, {"count": len(images)})
        return {"project": _fetch_project(project_id, gateway, settings)}
    except HTTPException:
        if uploaded_paths:
            gateway.service.storage.from_(settings.portfolio_bucket).remove(uploaded_paths)
        raise
    except Exception as exc:
        if uploaded_paths:
            try:
                gateway.service.storage.from_(settings.portfolio_bucket).remove(uploaded_paths)
            except Exception:
                pass
        raise db_failure(exc, "upload the portfolio images") from exc


@router.patch("/{project_id}/images/{image_id}")
def update_project_image(
    project_id: UUID,
    image_id: UUID,
    payload: PortfolioImageUpdate,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> dict[str, Any]:
    changes = json_ready(payload, exclude_unset=True)
    try:
        if changes.get("is_cover"):
            gateway.service.table("portfolio_images").update({"is_cover": False}).eq("project_id", str(project_id)).execute()
        first(
            gateway.service.table("portfolio_images").update(changes).eq("id", str(image_id)).eq("project_id", str(project_id)).execute(),
            "Portfolio image",
        )
        audit(gateway.service, request, settings, "update", "portfolio_image", image_id, principal)
        return {"project": _fetch_project(project_id, gateway, settings)}
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "update the portfolio image") from exc


@router.delete("/{project_id}/images/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_image(
    project_id: UUID,
    image_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    try:
        image = first(gateway.service.table("portfolio_images").select("*").eq("id", str(image_id)).eq("project_id", str(project_id)).execute(), "Portfolio image")
        gateway.service.table("portfolio_images").delete().eq("id", str(image_id)).execute()
        remaining = rows(
            gateway.service.table("portfolio_images")
            .select("id")
            .eq("project_id", str(project_id))
            .order("position")
            .execute()
        )
        if image.get("is_cover"):
            if remaining:
                gateway.service.table("portfolio_images").update({"is_cover": True}).eq("id", remaining[0]["id"]).execute()
        if len(remaining) < 2:
            gateway.service.table("portfolio_projects").update({"published": False}).eq("id", str(project_id)).execute()
        gateway.service.storage.from_(settings.portfolio_bucket).remove([image["storage_path"]])
        audit(gateway.service, request, settings, "delete", "portfolio_image", image_id, principal)
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "delete the portfolio image") from exc


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: UUID,
    request: Request,
    principal: Principal = Depends(current_admin),
    settings: Settings = Depends(get_settings),
    gateway: SupabaseGateway = Depends(get_supabase),
) -> Response:
    try:
        paths = [item["storage_path"] for item in rows(gateway.service.table("portfolio_images").select("storage_path").eq("project_id", str(project_id)).execute())]
        deleted = rows(gateway.service.table("portfolio_projects").delete().eq("id", str(project_id)).execute())
        if not deleted:
            raise HTTPException(status_code=404, detail="Portfolio project not found")
        if paths:
            gateway.service.storage.from_(settings.portfolio_bucket).remove(paths)
        audit(gateway.service, request, settings, "delete", "portfolio_project", project_id, principal)
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as exc:
        raise db_failure(exc, "delete the portfolio project") from exc
