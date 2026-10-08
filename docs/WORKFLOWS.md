# Hich Web operations

Open `/admin/login` directly. The public website deliberately has no administrator navigation link. Local development runs at `http://localhost:5173` or `http://127.0.0.1:5173`; use the same hostname throughout your session.

## Agreements

1. Choose **Agreements → New agreement**. Select an existing client or enter a new client's name, phone and optional email.
2. Enter an agreement ID (or let Hich generate one), project name and budget. Add an annual renewal amount in **USD or LKR** and the service expiry/renewal date where applicable. The signing deadline is separate from service expiry.
3. Review the project description and commercial terms. The standard agreement includes 31 detailed sections covering websites and systems, scope changes, visit fees, domains, payments, IP, support, security, cancellation and other obligations. Specify the legal contracting entity and actual scope, rates and payment schedule in the project schedule before commercial use.
4. **Create signing link** saves the agreement and opens a sharing panel. Copy the link or open WhatsApp/email to review and send the message yourself.
5. Clients can go directly to the signature form. They enter their full name and job role, tick acceptance, and draw or type an electronic signature. The complete agreement remains available; there is no forced scrolling or reading test.
6. A server timestamp, consent, signer details, commercial snapshot, document version, signature and PDF evidence are retained. Signed records cannot be edited. Both the administrator and recipient can download the signed PDF.

If a recipient's details change, the previous signing link is invalidated. Editing the terms invalidates an already-open signing form's version; the client must reload before accepting. Use a new agreement or a priced scope change after signing.

The agreement is an editable commercial template, not a guarantee of enforceability. Review it with local counsel. Typed/drawn signatures are evidence of electronic acceptance, not certificate-backed digital signatures.

## Invoices and renewals

1. Choose **Invoices → New invoice**, select a client and enter the project, total, due date and payment phases. Phases must add up exactly to the total.
2. Add public payment instructions and a client note. **Internal notes** stay private.
3. Set the annual renewal amount independently in USD or LKR and enter **Service expiry / renewal date**. This renewal is separate from the development total; it is not silently counted as an additional invoice line.
4. Save, then choose **Share**. The same client link displays the latest saved invoice after edits. Resend it from the sharing panel when necessary.
5. Use **History** for saved revisions, **Replace link** to invalidate the old URL, **Revoke link** to stop access, and **Link expiry** to set a deadline. Clients can print or save the invoice as PDF.

Payment status comes from actual recorded payments and due dates. Mixed currencies are displayed separately. Changing the invoice's client revokes its old link. Saved revisions use transactions and optimistic concurrency to prevent partial saves and stale overwrites.

## Completed projects

Add a title, category, live website URL and descriptions under **Completed projects**. Screenshots are optional (up to three). Publish when the project is ready to share. Only published projects are visible publicly.

Use category links such as `/?category=E-commerce#work` to show every published project in that category. **Create collection** saves a handpicked set of published projects with its own title, introduction and client link. Removing a collection invalidates its link and keeps the projects. Unpublishing a project also removes it from public collections.

## Ten additional productivity features

1. Priced scope change approvals against signed agreements, recording accepted fees and delivery extensions.
2. Database-backed follow-ups with deadlines, priority, client links and completion tracking.
3. Saved, shareable portfolio collections.
4. Ctrl/Cmd+K search across clients, agreements, invoices and projects.
5. CSV exports for agreements, invoices and follow-ups with spreadsheet formula escaping.
6. Duplicate an agreement into a new unsigned draft without copying the previous client's identity.
7. Searchable clause navigation and a direct jump to the signing form.
8. Saved invoice revision history.
9. Invoice link expiry, rotation and revocation.
10. Client-downloadable signed agreement receipts and printable invoices.

The dashboard also retains existing collections, renewal and risk insights. New work includes password recovery and an interactive Design / Build / Launch model on the public website, with keyboard controls and reduced-motion support.

## Authentication and operation

The login flow preserves passwords exactly, permits existing credentials without imposing a new-password length rule, accepts both local loopback addresses in development, protects against an initial session-check race, and checks that cookies work before opening the administrator workspace. Supabase verifies the credentials; the backend additionally checks `ADMIN_EMAILS`.

**Forgot password** requests a Supabase reset email only when the administrator clicks it. Configure the Supabase Auth site URL and allowed redirect URL to include `PUBLIC_APP_URL/admin/reset-password`; configure email delivery for production. A valid email reset link is required to set a new password. No password was changed during implementation.

`PUBLIC_APP_URL` must be your externally reachable HTTPS origin before links are sent to clients outside your computer. Keep `FRONTEND_ORIGINS` aligned, use `COOKIE_SECURE=true` in production, and keep the token pepper stable (changing it invalidates links). This update does not deploy a new public hosting service.

## Verification

Run `npm run build` and `python -m pytest backend/tests -q`. `scripts/ui-smoke.cjs` exercises isolated browser fixtures at desktop/mobile widths; see `docs/ui-review` for screenshots. These fixtures contain synthetic sample records, not real customer data.

The 8 October 2026 migrations add agreement evidence/renewals, transactional invoice publication/history, and operations/collections. Apply migrations in filename order with the Supabase CLI. They were applied to the linked project during this update. The existing administrator account, passwords and client business records were preserved.
