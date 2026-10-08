from __future__ import annotations

from functools import lru_cache

from supabase import Client, ClientOptions, create_client

from .config import Settings, get_settings


def _options() -> ClientOptions:
    return ClientOptions(auto_refresh_token=False, persist_session=False)


class SupabaseGateway:
    """Creates isolated Auth clients and exposes a server-only privileged data client."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.service: Client = create_client(
            str(settings.supabase_url).rstrip("/"),
            settings.supabase_secret_key.get_secret_value(),
            options=_options(),
        )

    def auth_client(self) -> Client:
        # Auth clients contain in-memory session state and must never be shared between requests.
        return create_client(
            str(self.settings.supabase_url).rstrip("/"),
            self.settings.supabase_publishable_key.get_secret_value(),
            options=_options(),
        )


@lru_cache
def get_supabase() -> SupabaseGateway:
    return SupabaseGateway(get_settings())

