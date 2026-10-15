from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.document_views import attach_open_counts, record_proposal_open, tracking_schema_missing


class DatabaseError(Exception):
    def __init__(self, code, message=""):
        super().__init__(message)
        self.code = code


class BrokenQuery:
    def __init__(self, code): self.code = code
    def select(self, *_): return self
    def eq(self, *_): return self
    def in_(self, *_): return self
    def execute(self): raise DatabaseError(self.code)


def test_uninstalled_counter_migration_is_not_reported_as_zero():
    record = {"id": str(uuid4())}
    db = SimpleNamespace(service=SimpleNamespace(table=lambda _: BrokenQuery("PGRST205")))
    attach_open_counts(db, "proposal", [record])
    assert record["view_count"] is None
    assert record["last_opened_at"] is None


def test_unrelated_counter_errors_are_not_silently_hidden():
    db = SimpleNamespace(service=SimpleNamespace(table=lambda _: BrokenQuery("42501")))
    with pytest.raises(DatabaseError):
        attach_open_counts(db, "proposal", [{"id": str(uuid4())}])


def test_uninstalled_tracking_rpc_reports_service_unavailable():
    db = SimpleNamespace(service=SimpleNamespace(rpc=lambda *_: BrokenQuery("PGRST202")))
    with pytest.raises(HTTPException) as exc:
        record_proposal_open(db, {"id": str(uuid4()), "access_token_hash": "a" * 64}, str(uuid4()))
    assert exc.value.status_code == 503


@pytest.mark.parametrize("code,message", [
    ("42P01", 'relation "public.document_open_counts" does not exist'),
    ("42P01", 'relation "public.proposal_open_events" does not exist'),
    ("42883", 'function public.record_proposal_open does not exist'),
])
def test_missing_tracking_dependencies_are_recognized(code, message):
    assert tracking_schema_missing(DatabaseError(code, message), "rpc")


@pytest.mark.parametrize("code,message", [
    ("42501", 'permission denied for proposal_open_events'),
    ("42P01", 'relation "public.proposals" does not exist'),
    ("42883", 'function public.unrelated_function does not exist'),
])
def test_other_tracking_failures_are_not_misreported_as_missing_migrations(code, message):
    assert not tracking_schema_missing(DatabaseError(code, message), "rpc")


def test_available_tracking_reports_real_zero_and_existing_counts():
    empty, opened = {"id": str(uuid4())}, {"id": str(uuid4())}

    class CountQuery(BrokenQuery):
        def execute(self):
            return SimpleNamespace(data=[{
                "document_id": opened["id"], "open_count": 12, "last_opened_at": "2026-10-15T08:00:00Z",
            }])

    db = SimpleNamespace(service=SimpleNamespace(table=lambda _: CountQuery(None)))
    attach_open_counts(db, "proposal", [empty, opened])
    assert empty["view_count"] == 0
    assert empty["last_opened_at"] is None
    assert opened["view_count"] == 12
    assert opened["last_opened_at"] == "2026-10-15T08:00:00Z"
