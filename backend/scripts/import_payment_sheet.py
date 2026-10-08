"""Validate a payment-sheet export and prepare a guarded, atomic replacement SQL file.

This tool only writes local files. Run the generated rollback script first, inspect
its report, then execute the commit script with the linked Supabase CLI.
Keep source exports, backups and generated SQL under the gitignored supabase/.temp.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

COLOMBO = timezone(timedelta(hours=5, minutes=30))
TABLES = ["clients", "invoices", "invoice_milestones", "payments", "agreements", "agreement_versions", "invoice_versions", "operation_tasks", "change_orders", "portfolio_images", "portfolio_projects", "portfolio_collections", "audit_logs"]


def money(value):
    result = Decimal(str(value))
    if not result.is_finite() or result < 0 or result != result.quantize(Decimal("0.01")):
        raise ValueError("Amounts must be nonnegative with at most two decimal places")
    return result


def identifier(value):
    return str(uuid5(NAMESPACE_URL, "hich-payment-sheet:" + value))


def plan_import(source, currency="LKR"):
    if not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError("Invalid project currency")
    result = {name: [] for name in ("clients", "invoices", "invoice_milestones", "payments")}
    seen = set()
    warnings = []
    for row_number, row in enumerate(source["values"][1:], 2):
        if not row or not any(row):
            continue
        if len(row) < 3:
            raise ValueError(f"Row {row_number}: expected ID, payer and JSON")
        raw = json.loads(row[2])
        ref = str(raw["refId"]).strip()
        if not ref or ref != row[0] or ref in seen:
            raise ValueError(f"Row {row_number}: duplicate or inconsistent reference")
        seen.add(ref)
        issued = datetime.strptime(raw["date"], "%b %d, %Y").date()
        document_time = datetime.strptime(raw["date"] + " " + raw["time"], "%b %d, %Y %I:%M %p").replace(tzinfo=COLOMBO).isoformat()
        total = money(raw["projectValue"])
        if not total:
            raise ValueError(f"{ref}: project value must be positive")
        client_id, invoice_id = identifier(ref + ":client"), identifier(ref + ":invoice")
        phone = re.sub(r"[^+0-9]", "", raw.get("payerPhone", "")) or None
        if phone and phone.startswith("0") and len(phone) == 10:
            phone = "+94" + phone[1:]
        name = str(raw["payerName"]).strip()
        if not name or name != str(row[1]).strip():
            raise ValueError(f"{ref}: inconsistent payer name")
        company = str(raw.get("payerCompany") or "").strip() or None
        result["clients"].append({"id": client_id, "name": name, "company": company, "phone": phone, "status": "active", "metadata": {"import_source": "Google Sheets payment export", "source_row": row_number, "original_record": raw}})
        method = "Cash" if raw["method"].casefold() == "cash" else "Bank transfer"
        renewal_currency = raw.get("renewalCurrency") or currency
        if not re.fullmatch(r"[A-Z]{3}", renewal_currency):
            raise ValueError(f"{ref}: invalid renewal currency")
        result["invoices"].append({"id": invoice_id, "invoice_number": ref, "client_id": client_id, "project_title": company or name, "currency": currency, "project_value": str(total), "renewal_amount": str(money(raw.get("renewalAmount", 0))), "renewal_currency": renewal_currency, "issue_date": issued.isoformat(), "payment_method": method, "status": "sent", "created_at": document_time, "notes": f"Imported from payment Google Sheet, row {row_number}. Project currency assumed {currency}. Renewal and project due dates were not recorded in the source."})
        phase_total = Decimal()
        for index, phase in enumerate(raw["payments"]):
            amount = money(phase["amount"])
            if not amount or not isinstance(phase["isPaid"], bool):
                raise ValueError(f"{ref}: invalid payment phase")
            phase_total += amount
            phase_id = identifier(f"{ref}:phase:{index}")
            result["invoice_milestones"].append({"id": phase_id, "invoice_id": invoice_id, "title": phase["name"], "amount": str(amount), "position": index, "status": "pending", "description": phase.get("status")})
            if not phase["isPaid"]:
                continue
            status = phase.get("status", "").strip()
            confirmed = status.startswith("Settled on ")
            if confirmed:
                date_text = status.removeprefix("Settled on ")
                if "," not in date_text:
                    date_text += f", {issued.year}"
                    warnings.append(f"{ref} phase {index + 1}: payment year inferred as {issued.year}")
                received = datetime.strptime(date_text, "%b %d, %Y").replace(hour=12, tzinfo=COLOMBO)
                if received.date() > issued:
                    raise ValueError(f"{ref}: payment is after source document date")
            else:
                if status != "Completed":
                    raise ValueError(f"{ref}: unrecognized paid status {status!r}")
                # Schema requires a timestamp; the explicit flag excludes this
                # placeholder from period reports and date displays until corrected.
                received = datetime.combine(issued, datetime.min.time(), COLOMBO)
                warnings.append(f"{ref} phase {index + 1}: receipt date missing; excluded from dated income")
            result["payments"].append({"id": identifier(f"{ref}:receipt:{index}"), "invoice_id": invoice_id, "milestone_id": phase_id, "amount": str(amount), "currency": currency, "method": method, "reference": f"Sheet {ref}, phase {index + 1}", "paid_at": received.isoformat(), "date_confirmed": confirmed, "notes": "Imported source status: " + status + (". Actual receipt date was not recorded; confirm it in Edit payment." if not confirmed else "")})
        if phase_total > total:
            raise ValueError(f"{ref}: phases exceed project value")
        if phase_total < total:
            balance = total - phase_total
            result["invoice_milestones"].append({"id": identifier(ref + ":balance"), "invoice_id": invoice_id, "title": "Remaining project balance", "amount": str(balance), "position": len(raw["payments"]), "status": "pending", "description": "Project value less all phases listed in the source sheet."})
            warnings.append(f"{ref}: added unpaid balance phase {balance} {currency}")
    if not seen:
        raise ValueError("Source contains no invoices; refusing an empty replacement")
    total = sum((money(i["project_value"]) for i in result["invoices"]), Decimal())
    paid = sum((money(p["amount"]) for p in result["payments"]), Decimal())
    return {"tables": result, "summary": {"counts": {key: len(value) for key, value in result.items()}, "currency": currency, "project_value": str(total), "received": str(paid), "outstanding": str(total - paid), "warnings": warnings}}


def literal(value):
    return "'" + json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("'", "''") + "'::jsonb"


def replacement_sql(plan, backup, commit=False):
    if set(TABLES) - set(backup):
        raise ValueError("Backup is missing business tables")
    statements = ["begin;", "set local lock_timeout = '15s';", "lock table " + ", ".join("public." + t for t in TABLES) + " in access exclusive mode;"]
    for table in TABLES:
        if table == "audit_logs":
            continue
        expected = [{k: v for k, v in row.items() if k not in {"deleted_at", "date_confirmed"}} for row in backup[table]]
        statements.append(f"do $$ begin if exists ((select to_jsonb(r) - array['deleted_at','date_confirmed'] from public.{table} r except select value from jsonb_array_elements({literal(expected)})) union all (select value from jsonb_array_elements({literal(expected)}) except select to_jsonb(r) - array['deleted_at','date_confirmed'] from public.{table} r)) then raise exception 'Backup is stale: {table} changed'; end if; end $$;")
    statements.append("truncate table " + ", ".join("public." + t for t in TABLES) + ";")
    for table, records in plan["tables"].items():
        if records:
            columns = ", ".join(records[0])
            statements.append(f"insert into public.{table} ({columns}) select {columns} from jsonb_populate_recordset(null::public.{table}, {literal(records)});")
    summary = plan["summary"]
    statements.append(f"insert into public.audit_logs(action, entity_type, metadata) values ('sheet_database_replacement', 'workspace', {literal(summary)});")
    for table, count in summary["counts"].items():
        statements.append(f"do $$ begin if (select count(*) from public.{table}) <> {count} then raise exception 'Import count mismatch: {table}'; end if; end $$;")
    statements.append(f"do $$ begin if (select sum(project_value) from public.invoices) <> {summary['project_value']} or (select sum(amount) from public.payments) <> {summary['received']} then raise exception 'Import amount mismatch'; end if; end $$;")
    statements.append("select jsonb_build_object('clients',(select count(*) from public.clients),'invoices',(select count(*) from public.invoices),'phases',(select count(*) from public.invoice_milestones),'receipts',(select count(*) from public.payments),'project_value',(select sum(project_value) from public.invoices),'received',(select sum(amount) from public.payments),'profiles_preserved',(select count(*) from public.profiles)) as import_report;")
    statements.append("commit;" if commit else "rollback;")
    return "\n".join(statements)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("backup", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--currency", default="LKR")
    args = parser.parse_args()
    plan = plan_import(json.loads(args.source.read_text(encoding="utf-8-sig")), args.currency)
    backup = json.loads(args.backup.read_text(encoding="utf-8-sig"))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "plan.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    for commit in (False, True):
        (args.output_dir / ("replace-commit.sql" if commit else "replace-dry-run.sql")).write_text(replacement_sql(plan, backup, commit), encoding="utf-8")
    print(json.dumps(plan["summary"], indent=2))
