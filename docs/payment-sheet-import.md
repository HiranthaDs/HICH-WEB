# Payment sheet replacement

`backend/scripts/import_payment_sheet.py` validates the legacy payment sheet format
(ID, payer, JSON), then creates a plan and two SQL files. It does not connect to or
change a database itself.

1. Read spreadsheet metadata and all populated rows through the Sheets connector.
   Save the range response as `supabase/.temp/<import>/source.json`.
2. Take a consistent JSON backup of every public table, including profiles. Save
   signed PDFs and signature assets with a checksum manifest before any reset.
3. Run `python backend/scripts/import_payment_sheet.py <source> <backup> <output-dir>`.
   Project currency defaults to LKR; use `--currency` if the source owner specifies
   a different currency. Renewal currencies are preserved independently.
4. Review the counts, totals and warnings. Run `replace-dry-run.sql` through
   `supabase db query --linked --file`. This transaction rolls back every change.
5. Only execute `replace-commit.sql` when replacement is authorized and the
   reviewed dry run passes. The transaction locks business tables, compares their
   contents with the backup, and refuses to proceed if records changed. Refresh
   the backup and review changes if that guard fails.
6. Verify imported phase totals, receipt totals, current balances and income
   reports. Confirm existing login accounts remain available.

The explicit reset table list excludes `profiles`, `auth.users` and storage.
Business records and their version/audit history are replaced; a new import audit
entry records the reconciliation summary. Existing agreement storage objects are
retained along with the private backup. Never commit source data, backups or SQL
containing customer records; keep them in the ignored `supabase/.temp` directory.

Missing renewal dates, emails and addresses stay empty. A project whose listed
phases total less than its contract value receives an unpaid balance phase. Phases
exceeding contract value, duplicate references and malformed payment data stop
the import. Original source JSON is preserved in the administrator-only client
metadata.

Legacy paid receipts without dates have `date_confirmed = false`. Their amount
counts toward lifetime collections and the invoice balance, but is excluded from
period income and displayed as "Date not recorded". The required database
timestamp is a placeholder, not a confirmed payment date. Enter the actual date
through Edit receipt to include that payment in dated reports. Missing years in
otherwise dated receipts use the source document's year and appear in warnings.

Normal portal deletion is separate from this explicit reset. It requires the
server-side PIN and removes records from active lists and public links while
retaining financial history and signed evidence. The PIN is configured by
`DELETION_PIN`; successful confirmations do not consume the failed-attempt limit.
