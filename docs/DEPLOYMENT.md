# Deployment and operations

This runbook provisions Supabase and deploys the React and FastAPI applications as one Render web service. Commands assume they are run from the repository root unless stated otherwise.

## 1. Rotate exposed credentials first

Do this before running the application or creating a public deployment.

1. In Supabase, open **Project Settings → API Keys**. Create a new secret key, update the trusted backend configuration, verify it, and delete the exposed secret key.
2. In Supabase, open **Database → Settings** and reset the database password. The application normally uses the Supabase Data API and does not require `DATABASE_URL`, but an exposed database password remains dangerous.
3. Reset any administrator password that was shared or reused. Use a unique password that is different from the database password.
4. Remove old credentials from local files, Render variables, CI variables, notes, logs, and Git history as applicable.
5. Enable [MFA on the Supabase dashboard account](https://supabase.com/docs/guides/platform/multi-factor-authentication). Application-user MFA needs its own enrollment and challenge UI and should not be marked mandatory until that flow is implemented and tested.

The publishable key can appear in a browser, but it is not an authorization boundary. Row Level Security (RLS) and grants must still restrict `anon` and `authenticated` access. A secret key bypasses RLS and must exist only in trusted backend configuration.

See Supabase's [API key guidance and rotation procedure](https://supabase.com/docs/guides/getting-started/api-keys) and [database password reset guide](https://supabase.com/docs/guides/troubleshooting/how-do-i-reset-my-supabase-database-password-oTs5sB).

## 2. Prepare Supabase

### Apply the SQL migration

1. Open the intended project in the Supabase dashboard and verify its project name/reference before making changes.
2. If the project already contains data, take a restorable backup before applying any schema change.
3. Open **SQL Editor → New query**.
4. Open `supabase/migrations/20261007190000_initial_schema.sql` locally.
5. Paste the complete file into the SQL Editor, review the selected project again, and select **Run**.
6. Confirm the transaction completes without an error.
7. In **Table Editor**, verify the application tables exist. In **Database → Policies**, verify RLS is enabled and policies are present on exposed tables.

The initial migration is intended for a new project and is not a reset script. Do not rerun it over a provisioned schema or edit it after an environment depends on it. Add later changes as new numbered migrations and apply them in filename order. Do not paste a database password or secret API key into a migration.

The backend uses Supabase's HTTPS APIs at runtime; a direct Postgres connection string is not required. If a future migration tool uses a connection string from Render, copy the correct connection details from Supabase's **Connect** panel. Persistent IPv4 services should use the shared session pooler, reserved password characters must be percent-encoded, and SSL should be required. See [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

### Verify Storage

The migration provisions these buckets:

| Bucket | Access | Purpose |
| --- | --- | --- |
| `portfolio-assets` | Public reads | Images belonging to deliberately published portfolio projects |
| `agreement-signatures` | Private | Client signature artifacts associated with signed agreements |
| `agreement-pdfs` | Private | Server-generated final agreement PDFs |

In **Storage**, confirm all three buckets exist and check their public/private flags, allowed MIME types, and size limits. Agreement signatures and PDFs must remain private. The backend accesses them with its server-only key; never expose either object through a permanent public URL.

Because `portfolio-assets` is public, possession of an object URL is enough to read the image even when its project is later unpublished. Upload only material approved for public use; unpublishing removes it from the portfolio listing but is not a confidentiality control. Delete or replace an object when public access must end.

Supabase Storage writes, moves, and deletes should go through the Storage API rather than direct mutations of `storage.objects`. See [bucket access models](https://supabase.com/docs/guides/storage/buckets/fundamentals) and [Storage access control](https://supabase.com/docs/guides/storage/security/access-control).

### Configure Auth

1. In **Authentication → Providers**, keep Email enabled.
2. Set the Site URL to the current application origin. For local work, use `http://localhost:5173`; after deployment, use the Render or custom-domain HTTPS origin.
3. Add only the redirect origins the application actually uses.
4. For this administrator-only portal, disable unrestricted public sign-up after the first administrator has been bootstrapped.
5. Keep [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits) enabled. Consider [CAPTCHA protection](https://supabase.com/docs/guides/auth/auth-captcha) if public auth or password-recovery screens are later added.

### Bootstrap the first administrator

The bootstrap is intentionally separate from application startup. It creates or updates one Supabase Auth user with a server-side secret key. Run it only when deliberately provisioning or recovering an administrator, because rerunning it for an existing email replaces that user's password.

Set temporary variables in the shell, ensuring the email also appears in `ADMIN_EMAILS`. `Get-Credential` keeps the password itself out of PowerShell command history:

```powershell
$bootstrapCredential = Get-Credential -UserName "admin@example.com" -Message "Supabase administrator bootstrap"
$env:ADMIN_BOOTSTRAP_EMAIL = $bootstrapCredential.UserName
$env:ADMIN_BOOTSTRAP_PASSWORD = $bootstrapCredential.GetNetworkCredential().Password
$env:ADMIN_FULL_NAME = "Portal Administrator"
```

Run the bootstrap script from the repository root:

```powershell
python backend/scripts/bootstrap_admin.py
```

After it reports success:

1. Sign in and change the temporary password if the bootstrap password is not the final randomly generated credential.
2. Verify the user is confirmed in **Supabase → Authentication → Users**.
3. Remove the temporary variables from the current shell:

```powershell
Remove-Item Env:ADMIN_BOOTSTRAP_EMAIL -ErrorAction SilentlyContinue
Remove-Item Env:ADMIN_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:ADMIN_FULL_NAME -ErrorAction SilentlyContinue
Remove-Variable bootstrapCredential -ErrorAction SilentlyContinue
```

4. Do not add the bootstrap password to `.env`, `render.yaml`, Git, screenshots, or deployment logs.

The backend validates the Supabase user token and then checks the normalized email against `ADMIN_EMAILS` for every administrator route. Removing an email from that allowlist revokes portal access even if the Supabase Auth account still exists.

## 3. Run locally

Create and activate a virtual environment, then install both dependency sets:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
npm install
npm --prefix frontend install
```

Create local configuration:

```powershell
Copy-Item .env.example .env
```

Replace all placeholder values in `.env`. For the Vite workflow, set `PUBLIC_APP_URL=http://localhost:5173` so generated signing links open the React application. Use `COOKIE_SECURE=false` only for local HTTP development. Then start both servers:

```powershell
npm run dev
```

Visit `http://localhost:5173`. The Vite development server proxies `/api` to FastAPI at `http://localhost:8000`.

## 4. Environment variables

Pydantic loads names case-insensitively from process variables, `.env`, or `.env.local`. Process variables take precedence. Values marked secret must never be committed or prefixed with `VITE_`.

### Required production values

| Variable | Secret | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | No | Supabase project HTTPS URL. |
| `SUPABASE_PUBLISHABLE_KEY` | No | Public application key used by the backend's isolated Auth clients. |
| `SUPABASE_SECRET_KEY` | **Yes** | Server-only key for privileged database and Storage operations; bypasses RLS. |
| `ADMIN_EMAILS` | No | Comma-separated, normalized administrator email allowlist. |
| `PUBLIC_APP_URL` | No | Canonical public origin, with no trailing path. Used to construct signing links. |
| `FRONTEND_ORIGINS` | No | Comma-separated exact origins permitted by CORS; normally the same public origin in production. |
| `TOKEN_HASH_PEPPER` | **Yes** | Long random value mixed into signing-token hashes. Keep it stable or outstanding signing links will stop resolving. |

### Application and session settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENVIRONMENT` | `development` | One of `development`, `test`, or `production`. |
| `APP_NAME` | `Hich Client Portal API` | Service name used in API metadata and health responses. |
| `API_PREFIX` | `/api` | Prefix for backend routes. Keep the frontend API setting aligned if changed. |
| `COOKIE_SECURE` | `true` | Sends session cookies only over HTTPS. Set `false` only on local HTTP. |
| `COOKIE_DOMAIN` | unset | Optional cookie domain. Leave unset for a host-only cookie. |
| `ACCESS_COOKIE_NAME` | `hich_access` | Access-token cookie name. |
| `REFRESH_COOKIE_NAME` | `hich_refresh` | Refresh-token cookie name. |
| `CSRF_COOKIE_NAME` | `hich_csrf` | CSRF token cookie name. |
| `ACCESS_COOKIE_MAX_AGE` | `3600` | Maximum access-cookie lifetime in seconds. |
| `REFRESH_COOKIE_MAX_AGE` | `2592000` | Refresh-cookie lifetime in seconds. |
| `TRUST_PROXY_HEADERS` | `true` | Uses the first forwarded IP supplied by the trusted hosting proxy for audits and limits. |

### Storage, upload, and rate-limit settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORTFOLIO_BUCKET` | `portfolio-assets` | Portfolio image bucket. Must match the provisioned bucket. |
| `SIGNATURE_BUCKET` | `agreement-signatures` | Private signature bucket. Must match the provisioned bucket. |
| `AGREEMENT_PDF_BUCKET` | `agreement-pdfs` | Private final-PDF bucket. Must match the provisioned bucket. |
| `MAX_IMAGE_BYTES` | `6000000` | Maximum uploaded portfolio image size. |
| `MAX_SIGNATURE_BYTES` | `1500000` | Maximum decoded signature image size. |
| `LOGIN_RATE_LIMIT` | `8` | Login attempts allowed per local process window. |
| `LOGIN_RATE_WINDOW_SECONDS` | `900` | Login rate-limit window. |
| `SIGNING_RATE_LIMIT` | `12` | Signing attempts allowed per local process window. |
| `SIGNING_RATE_WINDOW_SECONDS` | `3600` | Signing rate-limit window. |

The in-process limiter is an application-level guard, not a distributed limiter. Supabase Auth's own rate limits remain important, especially if Render is scaled to multiple instances.

### Build and one-time values

| Variable | When used | Notes |
| --- | --- | --- |
| `VITE_API_BASE_URL` | Frontend build | Optional. Leave unset for same-origin `/api`; anything prefixed `VITE_` is public. |
| `ADMIN_BOOTSTRAP_EMAIL` | Bootstrap only | Must match an address in `ADMIN_EMAILS`; remove after use. |
| `ADMIN_BOOTSTRAP_PASSWORD` | Bootstrap only | Secret credential of at least 12 characters; remove after use. |
| `ADMIN_FULL_NAME` | Bootstrap only | Optional display name; defaults to `Administrator`. |
| `PORT` | Render runtime | Injected by Render. Do not hard-code it. |

`DATABASE_URL`, `SUPABASE_JWKS_URL`, `@supabase/server`, `@supabase/ssr`, and Prisma are not required by this Python backend. This frontend is Vite, not Next.js, so `NEXT_PUBLIC_*`, `page.tsx`, and Next middleware snippets do not apply.

## 5. Deploy one service on Render

The Blueprint at `render.yaml` uses Render's Python runtime. Render's native runtimes also include Node and npm, so the same build can compile React and install Python dependencies.

Its effective commands are:

```text
Build: pip install --upgrade pip && pip install -r backend/requirements.txt && npm ci --prefix frontend && npm run build --prefix frontend
Start: uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $PORT
Health: /api/health
```

Render requires the process to listen on `0.0.0.0` and the injected `$PORT`. The frontend build is served by FastAPI, including client-side route fallback, so no second Static Site or CORS bridge is required.

### Create the Blueprint

1. Apply the Supabase migration and bootstrap the administrator first.
2. Push the repository to a private GitHub, GitLab, or Bitbucket repository.
3. In Render, choose **New → Blueprint** and connect the repository containing `render.yaml`.
4. Review the single `hich-client-portal` web service.
5. Supply every variable marked `sync: false` in the Render dashboard:
   - `SUPABASE_SECRET_KEY`: the newly rotated secret key.
   - `PUBLIC_APP_URL`: initially `https://<service-name>.onrender.com`.
   - `FRONTEND_ORIGINS`: the same exact origin, without a trailing slash.
6. Verify `ADMIN_EMAILS`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY` point to the intended project. Never paste the secret key into a public Blueprint value.
7. Deploy and watch both build and runtime logs.
8. Open `https://<service-name>.onrender.com/api/health`; it must return a successful response before testing login. Then check `/api/health/ready`, which also verifies that the backend can query Supabase.

`TOKEN_HASH_PEPPER` is generated by the Blueprint on first creation. Render retains it for later deploys. Do not replace it casually: signing-link tokens are stored as hashes derived from this value.

[Free Render web services can sleep after inactivity](https://render.com/docs/your-first-deploy), so the first request can be slow. Use a paid instance when predictable client-facing signing latency is required.

### Add a custom domain

After the custom domain is verified in Render:

1. Change `PUBLIC_APP_URL` to the HTTPS custom origin.
2. Change `FRONTEND_ORIGINS` to the exact allowed origin or comma-separated origins during a controlled transition.
3. Update the Supabase Auth Site URL and allowed redirect URLs.
4. Redeploy and test cookies, login, a deep React route, and a newly generated signing link.

Avoid setting `COOKIE_DOMAIN` unless sessions must span trusted subdomains. Host-only cookies are the safer default.

## 6. Verification checklist

### Platform and security

- [ ] The previously exposed Supabase secret key has been deleted, not merely removed from the repository.
- [ ] The database password and affected administrator password have been reset.
- [ ] No secret appears in Git, `render.yaml`, frontend assets, browser network responses, or logs.
- [ ] `/api/health` returns `2xx` on the Render origin.
- [ ] `/api/health/ready` returns `2xx` and reports the service ready.
- [ ] A direct request to an administrator API without a session returns `401`.
- [ ] A valid Supabase user not present in `ADMIN_EMAILS` receives `403`.
- [ ] Login sets HTTP-only, Secure, SameSite cookies in production; logout clears them.
- [ ] Supabase RLS is enabled on exposed tables and the Security Advisor has no unexplained critical findings.
- [ ] `agreement-signatures` is private and does not return a permanent public URL.

### Functional workflow

- [ ] Administrator login and session restoration work after a full page refresh.
- [ ] A client can be created, edited, listed, and archived.
- [ ] An agreement can be drafted and its public signing link opened in a private browser window.
- [ ] Opening a link records the viewed state without exposing administrator-only data.
- [ ] Signing requires name, email, a typed or drawn signature, and explicit consent.
- [ ] A signed agreement stores its timestamp and SHA-256 evidence and cannot be signed a second time.
- [ ] The administrator can download the agreement PDF.
- [ ] An invoice with milestones/payments updates dashboard totals correctly.
- [ ] A portfolio project accepts the intended two or three sample images, preserves ordering/cover choice, and only appears publicly when published.
- [ ] Audit entries capture important create, update, share, view, sign, and delete actions without recording credentials.
- [ ] Refreshing a client-side route such as `/admin/agreements` serves the React application instead of a 404.

### Operational checks

- [ ] `npm run build` succeeds locally.
- [ ] `npm test` succeeds locally.
- [ ] Render's build, start, and health-check commands match `render.yaml`.
- [ ] A backup/restore policy exists for Supabase data, and restore steps are periodically tested.
- [ ] Key rotation, administrator offboarding, and signing-link revocation have named owners.

## 7. Official references

- [Supabase Python client](https://supabase.com/docs/reference/python/introduction)
- [Server-side user validation](https://supabase.com/docs/reference/python/auth-getuser)
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Storage security](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase dashboard-account MFA](https://supabase.com/docs/guides/platform/multi-factor-authentication)
- [Supabase application-user Auth MFA](https://supabase.com/docs/guides/auth/auth-mfa)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render environment variables and secrets](https://render.com/docs/configure-environment-variables)
- [Render native runtimes](https://render.com/docs/native-runtimes)
- [Render web-service port binding](https://render.com/docs/web-services)
- [Render health checks](https://render.com/docs/health-checks)
- [FastAPI frontend serving](https://fastapi.tiangolo.com/tutorial/frontend/)
