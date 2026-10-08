import json
from copy import deepcopy
from datetime import date
from decimal import Decimal

import pytest

from scripts.import_payment_sheet import plan_import, replacement_sql, TABLES
from app.income import income_report


def source():
    record = {"refId": "TEST1", "payerName": "Test Client", "payerCompany": "Test Company", "payerPhone": "0771234567", "date": "Oct 7, 2026", "time": "12:36 PM", "method": "Bank Trasfer", "projectValue": 1000, "renewalAmount": 40, "renewalCurrency": "USD", "payments": [{"name": "Advance", "amount": 200, "status": "Completed", "isPaid": True}, {"name": "Second", "amount": 300, "status": "Settled on Jan 13", "isPaid": True}]}
    return {"values": [["ID", "Payer", "JSON"], ["TEST1", "Test Client", json.dumps(record)]]}


def test_import_preserves_renewal_currency_unknown_dates_and_unlisted_balance():
    plan = plan_import(source())
    assert plan["summary"]["outstanding"] == "500"
    assert plan["tables"]["invoices"][0]["renewal_currency"] == "USD"
    assert plan["tables"]["payments"][0]["date_confirmed"] is False
    assert plan["tables"]["payments"][1]["paid_at"].startswith("2026-01-13")
    assert plan["tables"]["invoice_milestones"][-1]["amount"] == "500"
    assert plan["tables"]["clients"][0]["phone"] == "+94771234567"
    assert plan_import(source()) == plan  # retry identifiers remain stable


def test_import_refuses_duplicate_rows_and_overallocated_phases():
    duplicate = source(); duplicate["values"].append(deepcopy(duplicate["values"][1]))
    with pytest.raises(ValueError, match="duplicate"):
        plan_import(duplicate)
    invalid = source(); record = json.loads(invalid["values"][1][2]); record["projectValue"] = 100
    invalid["values"][1][2] = json.dumps(record)
    with pytest.raises(ValueError, match="exceed"):
        plan_import(invalid)
    with pytest.raises(ValueError, match="empty"):
        plan_import({"values": [["ID"]]})


def test_replacement_requires_complete_backup_and_defaults_to_rollback():
    plan = plan_import(source())
    with pytest.raises(ValueError, match="missing"):
        replacement_sql(plan, {})
    sql = replacement_sql(plan, {t: [] for t in TABLES})
    assert sql.endswith("rollback;")
    assert "Backup is stale" in sql
    truncate = next(line for line in sql.splitlines() if line.startswith("truncate"))
    assert "profiles" not in truncate and "auth" not in truncate and "cascade" not in truncate


def test_undated_receipts_reduce_balance_but_do_not_invent_monthly_income():
    plan = plan_import(source())
    report = income_report(plan["tables"]["invoices"], plan["tables"]["payments"], date(2026, 1, 1), date(2026, 12, 31), date(2026, 10, 8))
    totals = report["currencies"][0]
    assert totals["lifetime_collected"] == Decimal(500)
    assert totals["outstanding"] == Decimal(500)
    assert totals["collected"] == Decimal(300)
    assert totals["undated_collected"] == Decimal(200)
    assert len(report["ledger"]) == 1
    assert len(report["undated_receipts"]) == 1
