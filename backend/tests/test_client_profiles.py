from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.routers.clients import get_client_profile, list_clients


class Query:
    def __init__(self, records):
        self.records = records
        self.filters = []
        self.start, self.end = 0, None

    def is_(self, name, value):
        assert value == "null"
        self.filters.append(lambda row: row.get(name) is None)
        return self

    def select(self, _): return self
    def order(self, *_, **__): return self
    def eq(self, key, value):
        self.filters.append(lambda row: row.get(key) == value)
        return self
    def neq(self, key, value):
        self.filters.append(lambda row: row.get(key) != value)
        return self
    def in_(self, key, values):
        self.filters.append(lambda row: row.get(key) in values)
        return self
    def range(self, start, end):
        self.start, self.end = start, end + 1
        return self
    def limit(self, limit):
        self.end = limit
        return self
    def execute(self):
        result = [deepcopy(row) for row in self.records if all(test(row) for test in self.filters)]
        return SimpleNamespace(data=result[self.start:self.end])


def gateway(data):
    return SimpleNamespace(service=SimpleNamespace(table=lambda table: Query(data[table])))


def test_profile_loads_all_documents_and_never_another_clients_history():
    client_id, other_id = uuid4(), uuid4()
    invoices = [{"id": str(uuid4()), "client_id": str(client_id), "project_value": "20.50", "currency": "GBP", "status": "sent", "payments": []} for _ in range(501)]
    invoices.append({"id": str(uuid4()), "client_id": str(other_id), "project_value": "999", "status": "sent"})
    agreements = [{"id": str(uuid4()), "client_id": str(client_id), "title": "Client agreement"}, {"id": str(uuid4()), "client_id": str(other_id), "title": "Other client agreement"}]
    client = {"id": str(client_id), "name": "Invoice client", "address": "Colombo", "notes": "Admin note"}
    result = get_client_profile(client_id, None, gateway({"clients": [client], "invoices": invoices, "agreements": agreements}))["profile"]
    assert result["client"] == client
    assert len(result["invoices"]) == 501
    assert all(row["client_id"] == str(client_id) for row in result["invoices"])
    assert result["invoices"][0]["amount"] == "20.50"
    assert result["invoices"][0]["balance_due"] == "20.50"
    assert len(result["agreements"]) == 1
    assert result["agreements"][0]["title"] == "Client agreement"


def test_unknown_client_profile_returns_not_found():
    with pytest.raises(HTTPException) as error:
        get_client_profile(uuid4(), None, gateway({"clients": []}))
    assert error.value.status_code == 404


def test_deleted_clients_and_documents_do_not_reappear_in_profile():
    client_id = uuid4()
    client = {"id": str(client_id), "name": "Test Client"}
    data = {"clients": [client], "invoices": [{"id": "deleted-invoice", "client_id": str(client_id), "deleted_at": "2026-10-08"}], "agreements": [{"id": "deleted-agreement", "client_id": str(client_id), "deleted_at": "2026-10-08"}]}
    profile = get_client_profile(client_id, None, gateway(data))["profile"]
    assert profile["invoices"] == [] and profile["agreements"] == []
    client["deleted_at"] = "2026-10-08"
    with pytest.raises(HTTPException) as exc:
        get_client_profile(client_id, None, gateway(data))
    assert exc.value.status_code == 404


def test_client_totals_preserve_each_currency_and_paginate_all_invoices():
    client_id = str(uuid4())
    invoices = [{"id": str(uuid4()), "client_id": client_id, "project_value": "1.25", "currency": "USD", "status": "paid"} for _ in range(501)]
    invoices.extend([
        {"id": str(uuid4()), "client_id": client_id, "project_value": "100", "currency": "LKR", "status": "sent"},
        {"id": str(uuid4()), "client_id": client_id, "project_value": "42.50", "currency": "GBP", "status": "sent"},
        {"id": str(uuid4()), "client_id": client_id, "project_value": "999", "currency": "GBP", "status": "void"},
    ])
    result = list_clients(q=None, client_status=None, limit=100, offset=0, _=None, gateway=gateway({"clients": [{"id": client_id, "name": "Example"}], "invoices": invoices}))["clients"]["items"][0]
    assert result["project_count"] == 503
    assert result["totals_by_currency"] == {"USD": 626.25, "LKR": 100.0, "GBP": 42.5}
    assert result["total_value"] == 100.0
