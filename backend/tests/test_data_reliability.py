from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.data import retry_database_read, transient_database_error
from app.routers.invoices import list_invoices


class DatabaseError(Exception):
    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


def test_database_read_retries_transient_failures_until_success():
    calls = 0

    def operation():
        nonlocal calls
        calls += 1
        if calls < 3:
            raise DatabaseError("connection pool timeout", "PGRST003")
        return {"items": ["invoice"]}

    assert retry_database_read(operation, attempts=3, base_delay=0) == {"items": ["invoice"]}
    assert calls == 3


def test_database_read_does_not_retry_non_transient_failures():
    calls = 0

    def operation():
        nonlocal calls
        calls += 1
        raise DatabaseError("invalid input syntax", "22P02")

    with pytest.raises(DatabaseError):
        retry_database_read(operation, attempts=3, base_delay=0)

    assert calls == 1
    assert transient_database_error(DatabaseError("invalid input syntax", "22P02")) is False


class InvoiceReadGateway:
    def __init__(self, transient_failures: int):
        self.transient_failures = transient_failures
        self.calls = 0
        self.service = self

    def table(self, name: str):
        assert name == "invoices"
        return InvoiceReadQuery(self)


class InvoiceReadQuery:
    def __init__(self, gateway: InvoiceReadGateway):
        self.gateway = gateway

    def select(self, _): return self
    def is_(self, *_): return self
    def order(self, *_, **__): return self
    def eq(self, *_): return self
    def range(self, *_): return self

    def execute(self):
        self.gateway.calls += 1
        if self.gateway.calls <= self.gateway.transient_failures:
            raise DatabaseError("connection pool timeout", "PGRST003")
        return SimpleNamespace(data=[deepcopy({
            "id": "invoice-id", "invoice_number": "INV-RETRY", "project_value": "100.00",
            "currency": "LKR", "status": "sent", "clients": {"name": "Client"},
            "invoice_milestones": [], "payments": [],
        })])


def test_invoice_list_recovers_from_a_transient_database_failure():
    gateway = InvoiceReadGateway(transient_failures=1)

    result = list_invoices(None, 100, 0, None, gateway)

    assert result["invoices"]["total"] == 1
    assert result["invoices"]["items"][0]["invoice_number"] == "INV-RETRY"
    assert gateway.calls == 2


def test_invoice_list_marks_exhausted_transient_failure_as_retryable():
    gateway = InvoiceReadGateway(transient_failures=3)

    with pytest.raises(HTTPException) as exc:
        list_invoices(None, 100, 0, None, gateway)

    assert exc.value.status_code == 503
    assert exc.value.headers == {"Retry-After": "2"}
    assert gateway.calls == 3
