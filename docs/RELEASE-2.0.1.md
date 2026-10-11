# Hich Web V 2.0.1

## Deployment

Apply outstanding Supabase migrations in filename order before deploying this frontend/backend together. In particular:

1. `supabase/migrations/20261011100000_permanent_document_links.sql`
2. `supabase/migrations/20261011110000_payment_receipt_integrity.sql`

These migrations retain records and signed evidence. Historical agreement expiry values stay in the signed snapshot/digest but no longer control access or signing. Previously expired, shared, undeleted agreements become available again. Explicitly revoked, voided or deleted documents remain unavailable. Payment metadata is backfilled without revalidating voided receipts or changing financial history. Apply on a backup-restorable database and deploy the corresponding code immediately afterward.

On Vercel, use `PUBLIC_APP_URL=https://hich-web.vercel.app` and include this origin in `FRONTEND_ORIGINS` when it is not supplied by the platform's trusted system variables. Public URL settings must identify the client-facing frontend, not a separate API hostname.

New v2 document links do not depend on application secrets and survive their rotation. For pre-v2 URLs, optionally provide former `TOKEN_HASH_PEPPER` / token-generation key values through the server-only `LEGACY_PUBLIC_LINK_KEYS` variable. Do not restore a revoked Supabase key as the active API key. If an old signing key is unavailable, Share creates a working replacement URL; the unknown historical URL cannot be reconstructed. Explicit Replace link still invalidates the previous URL.

## Behaviour

- Settings shows `V 2.0.1`. Invoice sharing accepts the obsolete expiry field from cached browser bundles without applying it; the current frontend no longer sends it.
- Invoice/agreement client access has no time deadline. Payment due dates and service renewal dates remain meaningful. Records persist in Supabase; retaining data indefinitely also requires the deployed database/storage and backups to be maintained.
- Record a payment includes visiting-fee allocation, mid/final payment shortcuts, editable milestones, allocation totals and received/outstanding balances. Save the payment plan before entering a cleared receipt. Fully paid phase amounts are fixed in this panel; correct their receipts first. Saving a plan alone does not send a message.
- Receipt creation uses a persistent retry key and permanent receipt number. The prepared message identifies the exact saved receipt and new balance. Sharing failure does not undo a saved receipt. Receipt deletion requires the deletion PIN. Client payment history includes receipt numbers.
- Paying a renewal invoice advances the matching source renewal cycle by one year, once. Receipt correction/deletion does not move the date backwards; review the next service date if the provider cancels or changes the renewal.
- Income includes a month calendar with cleared receipts, invoice deadlines and upcoming renewals. Each event retains its original currency; receipt days use Asia/Colombo time.
- Invoice PDFs are generated on the server with an amount summary, payment plan and receipt ledger. Agreement PDFs have a commercial summary first, readable clause headings and page references. Already stored signed PDFs remain immutable.

## Agreement variants

New drafts include 40 titled clauses covering website and custom system development, e-commerce, integrations, scope changes, client duties, payment, source rights, launch, maintenance, security and exit. Existing signed agreements are not rewritten.

With “Include entered amounts”, a full price appears only if entered. Visiting fees and annual renewals can appear independently when no project total is supplied. With “Scope-only agreement”, structured commercial details are hidden. Manually written custom terms remain the administrator's responsibility: review them for any prices or private information before sharing.

The template is a drafting starting point, not a guarantee against claims. Complete the contracting legal entity, project scope, liability allocation and governing-law/forum schedule and obtain local legal review. Sri Lanka's [Unfair Contract Terms Act No. 26 of 1997](https://www.srilankalaw.lk/YearWisePdf/1997/UNFAIR_CONTRACT_TERMS_ACT,_26_OF_1997.pdf) restricts exclusions of liability and applies reasonableness requirements; the template therefore preserves mandatory rights and makes material conditions visible.

## Verification

Run backend tests with `python -m pip install -r backend/requirements-dev.txt` then `python -m pytest backend/tests`. Build with `npm run build --prefix frontend`.

The in-memory PostgreSQL check is `node scripts/document-payment-db-smoke.cjs` after optionally installing `@electric-sql/pglite` without saving it as an application dependency. It applies all actual portal migrations over local auth/storage stubs and verifies receipt backfill, retries, overpayment protection, milestone ownership, renewal advancement and publication. It does not connect to live Supabase or validate platform storage/auth services or simultaneous database sessions.

Browser checks: run Vite on port 5174 and execute `scripts/portal-updates-smoke.cjs` and `scripts/renewal-invoices-smoke.cjs`. These intercept API calls and never send real client messages. Synthetic PDF previews can be regenerated with `python scripts/preview-documents.py` after installing optional `PyMuPDF`.
