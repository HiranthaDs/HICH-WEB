from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.routers.health import readiness


class Query:
    def __init__(self, table: str, calls: list[tuple[str, str]], failing_table: str | None = None):
        self.table = table
        self.calls = calls
        self.failing_table = failing_table
        self.columns = ""

    def select(self, columns: str):
        self.columns = columns
        return self

    def limit(self, _limit: int):
        return self

    def execute(self):
        self.calls.append((self.table, self.columns))
        if self.table == self.failing_table:
            raise RuntimeError(f"{self.table} is unavailable")
        return SimpleNamespace(data=[])


def gateway(failing_table: str | None = None):
    calls: list[tuple[str, str]] = []
    service = SimpleNamespace(table=lambda table: Query(table, calls, failing_table))
    return SimpleNamespace(service=service), calls


def settings():
    return SimpleNamespace(app_name="Hich Client Portal API", environment="test")


def test_readiness_checks_the_proposal_schema():
    db, calls = gateway()

    result = readiness(settings(), db)

    assert result["status"] == "ready"
    assert ("proposals", "id,client_id,html_content,share_nonce,deleted_at") in calls
    assert ("document_open_counts", "document_type,document_id,open_count,last_opened_at") in calls


@pytest.mark.parametrize("table", ["proposals", "document_open_counts", "proposal_open_events", "invoices"])
def test_readiness_fails_when_document_schema_is_missing(table):
    db, _ = gateway(table)

    with pytest.raises(HTTPException) as error:
        readiness(settings(), db)

    assert error.value.status_code == 503
