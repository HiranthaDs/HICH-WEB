# Portal workflows — 8 October 2026

## Client and invoice workflow

- Create an invoice using a searchable client selector or save a new client inline. Client profiles show contact details, invoices, agreements, payment receipts and renewal dates.
- Invoice editing places payments first. **Add mid payment** splits the pending final balance without increasing the agreed total. **Record final payment** marks that phase received. Use **Add payment** for an actual partial receipt, with its received date and bank reference.
- **Add visiting fee** moves LKR 5,000–15,000 from the pending final balance to a visiting-fee phase. It stays within the project total. Mark it received only when cleared funds arrive. A foreign-currency visiting-fee credit requires an agreed conversion rate.
- Receipt edits and removals recalculate balances. The PIN is required before a receipt is reduced or deleted, a stored phase is removed, an invoice is voided or a client is archived. Paid phases cannot be removed until their receipts are corrected. Invoice revisions retain previous financial records.
- Saving an invoice or receipt prepares a client message showing reference, total, received payments, milestone breakdown, balance, due date and payment instructions.

## Agreements

Choose **Create agreement** on an invoice or select **Copy from invoice** in the agreement editor. The latest saved invoice supplies the client, project, currency, budget, payment schedule, instructions and renewal details. Client records are searchable. Agreements display newest first.

The selected visiting fee and invoice payment schedule are persisted in the commercial schedule and included in the signed snapshot, content digest, version history and PDF. The fee is non-refundable under the accepted booking conditions and applicable law, and credited once to the project balance when actually collected. Later invoice receipts update the ledger without rewriting signed contractual terms.

General clauses now cover visiting-fee credits, transfer quotations using current Hich Web/vendor rates, renewal deadlines, disclosed late charges, payment evidence and authorised changes. Confirm the contracting legal entity, accepted scope and local legal requirements before sharing. Signed agreements and approved scope changes remain immutable.

## Access and deletion

Settings provides administrator invitations, user name/role/access editing, password-reset emails, and current-password-verified password changes. Staff work on client records; only administrators manage access. Supabase sends invitations and recovery links; configure its email service and redirect allowlist for `https://hich-web.onrender.com/admin/reset-password`.

Database profiles have a `portal_access` flag defaulting to false. Ordinary Auth signups do not gain portal access. Approved active staff/admin profiles and the bootstrap `ADMIN_EMAILS` allowlist can log in. Disabling a profile immediately blocks subsequent portal requests, including existing access tokens. An administrator cannot remove their own access. Password changes revoke refresh sessions and require a fresh login on this device; already-issued access tokens remain valid until their provider-enforced expiry.

The server verifies the deletion PIN (`2113` by default) and rate-limits attempts. A missing or incorrect PIN cannot delete, archive, void or revoke a record through the portal. Sensitive signed records remain protected even with the PIN.

## Messages and email delivery

Share panels include an editable structured WhatsApp/email message, an HTML preview, a downloadable multipart `.eml` email draft and an email-app composer. These require the operator to review and send. Direct **Send professional email** is available when backend SMTP is configured; it uses authenticated TLS, plain-text and HTML alternatives and an audit entry. No client messages are sent during tests or deployment.

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` and optionally `SMTP_FROM_NAME`. Use port 587 with `SMTP_SSL=false` for STARTTLS, or the provider's implicit-TLS port with `SMTP_SSL=true`. Credentials stay on the backend. Email acceptance by the provider is reported honestly; it does not guarantee inbox delivery.

Renewal reminders include amount, currency, expiry date, payment instructions and provider-expiry consequences. A checkbox confirms that the client expressly accepted the 18% late-payment surcharge. It is applied once in the message to the unpaid renewal base after the due date, without compounding. Without acceptance, the message explains conditional terms rather than asserting an incurred charge. No surcharge is silently posted to an invoice. VAT is separate and applies only where legally required; it is not triggered solely by lateness. Reference: [Sri Lanka IRD VAT guidance](https://www.ird.gov.lk/en/type%20of%20taxes/sitepages/value%20added%20tax%20%28vat%29.aspx).

## Income summary

The new income page filters receipt dates in Asia/Colombo and keeps each currency separate. It shows collected and invoiced amounts for the selected period, current outstanding and overdue balances, draft value, lifetime receipts, retained receipts on void invoices, overpayments, aging buckets, monthly/method/client breakdowns, receipt ledger and CSV exports. Voiding an invoice does not erase real cash receipts or imply a refund. Expenses, refunds and exchange-rate conversions are not recorded, so this is a cash/receivables report rather than net profit.

## Deployment and validation

Apply migrations in filename order before publishing the code. `20261008140000_agreement_gbp_renewals.sql` and `20261008160000_portal_workflows.sql` were applied to the existing linked project for this update. The new migration preserves business records and adds access flags, agreement commercial fields, version tracking and payment safeguards.

Render's trusted `RENDER_EXTERNAL_URL` is included in allowed browser origins. Public URLs are normalized to an origin, and a production localhost public URL falls back to Render's address. `render.yaml` uses `https://hich-web.onrender.com` for public links and allowed frontend origins. Login requests from arbitrary origins remain blocked. `/api/health` reports application version `1.1.0` so deployment can be verified.

Validation: `npm run build`, `python -m pytest backend/tests -q`, and `npm run test:ui:portal` against the local Vite server on port 5174. Browser fixtures exercise allocation, partial receipts, agreement copying, invitations, PIN rejection, email preview and layouts at 320/390 px. Screenshots and results are in `docs/ui-review/portal-updates`.
