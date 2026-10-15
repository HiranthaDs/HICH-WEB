# Proposal opens and renewal invoices

Apply pending migrations in filename order before deploying the updated backend and frontend together:

1. `supabase/migrations/20261014100000_document_open_counts.sql`
2. `supabase/migrations/20261015100000_renewal_preparation_workflow.sql`
3. `supabase/migrations/20261015110000_proposal_open_events.sql`

Keep any earlier unapplied migrations in the sequence. Do not rerun already applied migrations. The configured database was checked read-only during this change: both tracking tables were missing. These migrations have been tested against an isolated PostgreSQL instance; they have not been applied to the connected database.

Verify `/api/health/ready` after applying migrations. This now checks both tracking tables as well as the existing application schema. No new environment variables are required. Email delivery continues to use the existing SMTP settings; WhatsApp, copying the message, and copying the client link remain available through the sharing panel.

## What an open means

Proposal content loads independently of tracking. The browser records an open after the proposal iframe finishes loading in a visible tab. A reload or a separate visit counts again; retries use the same opening ID and count once. Admin editor previews, copying a link, and fetching the document API do not count. An administrator visiting the actual client link does count. These are link opens, not unique people or proof that a client read the proposal.

Historical known opens are preserved. Repeat visits before tracking was installed cannot be reconstructed. Unavailable tracking appears as **Unavailable**, rather than an incorrect zero. Proposal cards refresh every 30 seconds while visible and when the window regains focus; client profile counts refresh on focus. Agreement views retain their signing status workflow without displaying or incrementing link-open counters.

## Renewal workflow

Use **Invoices → Renewals**, or open a renewal from a client profile or the dashboard. Review the source project, service expiry, charges, currency and payment due date. Preparing a renewal creates a draft. Preparing the client message publishes its stable link; choose a delivery action in the sharing panel. Record cleared payments against the renewal invoice. Paid cycles stay available in the history, while the project's next annual renewal date advances once.

An existing invoice is located by its source project and renewal cycle, including after its due date passes or the source advances to the next year. Reopening it does not create another bill. Payment and service renewal are separate: paying the invoice does not confirm that the domain or hosting provider has renewed the service.

## Verification

```powershell
npm run build
python -m pytest backend/tests
node scripts/document-payment-db-smoke.cjs
```

The database smoke runner uses PGlite with synthetic records and applies every migration. It verifies renewal preparation, publishing, repeated requests, receipt isolation and yearly advancement, plus proposal counters, duplicate retries, historical totals and revoked/deleted links. Browser smoke scripts use intercepted API responses and do not send messages or write to the connected database.
