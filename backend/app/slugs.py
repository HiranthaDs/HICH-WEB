from __future__ import annotations

import re
import unicodedata


def normalize_project_slug(value: str, max_length: int = 240) -> str:
    """Turn a human-entered project name into a database-safe URL segment."""
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")[:max_length].rstrip("-")
