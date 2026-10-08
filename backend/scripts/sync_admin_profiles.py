from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Iterable


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import get_settings  # noqa: E402
from app.security import normalize_email  # noqa: E402
from app.supabase_client import get_supabase  # noqa: E402


def _users(response: Any) -> Iterable[Any]:
    if isinstance(response, list):
        return response
    return getattr(response, "users", None) or []


def main() -> int:
    settings = get_settings()
    allowed = settings.admin_email_set
    if not allowed:
        print("ADMIN_EMAILS must contain at least one address.", file=sys.stderr)
        return 2

    gateway = get_supabase()
    matched: dict[str, Any] = {}
    page = 1
    try:
        while page <= 20:
            page_users = list(_users(gateway.service.auth.admin.list_users(page=page, per_page=1000)))
            for user in page_users:
                email = normalize_email(getattr(user, "email", "") or "")
                if email in allowed:
                    matched[email] = user
            if len(page_users) < 1000:
                break
            page += 1
    except Exception:
        print("Could not read Supabase Auth users. Check the URL and secret key.", file=sys.stderr)
        return 1

    missing = sorted(allowed - frozenset(matched))
    if missing:
        print(
            "No Supabase Auth user exists for: " + ", ".join(missing),
            file=sys.stderr,
        )
        return 1

    records = []
    for email, user in matched.items():
        metadata = getattr(user, "user_metadata", None) or {}
        records.append(
            {
                "id": str(user.id),
                "email": email,
                "full_name": metadata.get("full_name") or metadata.get("name"),
                "role": "admin",
                "active": True,
            }
        )

    try:
        gateway.service.table("profiles").upsert(records, on_conflict="id").execute()
    except Exception:
        print(
            "Could not synchronize profiles. Apply the migrations in supabase/migrations first.",
            file=sys.stderr,
        )
        return 1
    print(f"Synchronized {len(records)} administrator profile(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
