from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Iterable


# Allow `python backend/scripts/bootstrap_admin.py` from the repository root.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import get_settings  # noqa: E402
from app.security import normalize_email  # noqa: E402
from app.supabase_client import get_supabase  # noqa: E402


def _users(response: Any) -> Iterable[Any]:
    if isinstance(response, list):
        return response
    users = getattr(response, "users", None)
    if users is not None:
        return users
    return []


def main() -> int:
    email = (os.environ.get("ADMIN_BOOTSTRAP_EMAIL") or os.environ.get("ADMIN_EMAIL") or "").strip()
    password = os.environ.get("ADMIN_BOOTSTRAP_PASSWORD") or os.environ.get("ADMIN_PASSWORD") or ""
    full_name = os.environ.get("ADMIN_FULL_NAME", "Administrator").strip() or "Administrator"
    if not email or not password:
        print("ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are required.", file=sys.stderr)
        return 2
    if len(password) < 12:
        print("ADMIN_BOOTSTRAP_PASSWORD must contain at least 12 characters.", file=sys.stderr)
        return 2

    settings = get_settings()
    if normalize_email(email) not in settings.admin_email_set:
        print("ADMIN_BOOTSTRAP_EMAIL must also be present in ADMIN_EMAILS.", file=sys.stderr)
        return 2

    gateway = get_supabase()
    existing = None
    page = 1
    while page <= 20 and existing is None:
        page_users = list(_users(gateway.service.auth.admin.list_users(page=page, per_page=1000)))
        existing = next(
            (user for user in page_users if normalize_email(getattr(user, "email", "") or "") == normalize_email(email)),
            None,
        )
        if len(page_users) < 1000:
            break
        page += 1

    attributes = {
        "email": email,
        "password": password,
        "email_confirm": True,
        "user_metadata": {"full_name": full_name},
    }
    if existing is None:
        result = gateway.service.auth.admin.create_user(attributes)
        user = result.user
        action = "created"
    else:
        user = gateway.service.auth.admin.update_user_by_id(str(existing.id), attributes)
        user = getattr(user, "user", user)
        action = "updated"
    if not user or not getattr(user, "id", None):
        print("Supabase did not return an administrator user.", file=sys.stderr)
        return 1

    gateway.service.table("profiles").upsert(
        {
            "id": str(user.id),
            "email": email,
            "full_name": full_name,
            "role": "admin",
            "active": True,
        },
        on_conflict="id",
    ).execute()
    print(f"Administrator {action}: {email}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
