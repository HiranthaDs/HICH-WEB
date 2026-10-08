<<<<<<< HEAD
# Hich Client Portal

Hich Client Portal is a full-stack operations workspace for managing clients, agreements, invoices, and published project work. It includes a private administrator portal and a public, token-based agreement-signing experience.

The application is designed to run as one Render web service: FastAPI serves the API and the production React build, while Supabase provides Auth, Postgres, and Storage.

## Features

- Dashboard metrics for clients, agreement status, invoiced value, collections, and recent activity.
- Explainable Hich Intelligence health scoring, risk detection, cash forecasting, renewal opportunities, and prioritized next actions.
- Client records with contact details, lifecycle status, notes, and related work.
- Versioned agreement snapshots with expiring signing links, view tracking, explicit consent, typed or drawn signatures, immutable signed records, SHA-256 evidence, and final PDF export.
- Invoice, milestone, and payment tracking with outstanding-balance summaries.
- Portfolio management with a project ID/code, title, external link, category, main and secondary descriptions, publishing controls, ordering, and multiple sample images.
- Public portfolio pages that expose only published work.
- Administrator audit history with request, actor, IP, user-agent, action, and entity context.
- Supabase Auth sessions held in secure HTTP-only cookies; privileged Supabase credentials remain backend-only.
- File type, size, and signature-image validation plus rate limiting on authentication and public signing routes.

## Technology

| Layer | Implementation |
| --- | --- |
| Frontend | React 18, TypeScript, Vite, React Router, Recharts |
| Backend | Python, FastAPI, Pydantic |
| Auth and data | Supabase Auth and Postgres through `supabase-py` |
| Files | Supabase Storage |
| PDF generation | ReportLab |
| Hosting | One Render Python web service |

In production, the browser calls same-origin `/api` endpoints. FastAPI performs authorization and all privileged Supabase operations; no secret key or database password is bundled into the React application.

## Repository layout

```text
.
├── backend/
│   ├── app/                 # FastAPI application and domain routes
│   ├── migrations/          # Supabase SQL, applied in filename order
│   ├── scripts/             # One-time administrator bootstrap
│   ├── tests/               # Backend tests
│   └── requirements.txt
├── frontend/
│   ├── src/                 # React application
│   └── package.json
├── docs/DEPLOYMENT.md       # Supabase and Render runbook
├── .env.example             # Safe configuration template
├── package.json             # Combined development commands
└── render.yaml              # Single-service Render Blueprint
```

## Local development

### Prerequisites

- Python 3.12
- Node.js 22 and npm
- A Supabase project you control

### 1. Install dependencies

PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
npm install
npm --prefix frontend install
```

### 2. Configure the environment

```powershell
Copy-Item .env.example .env
```

Edit `.env` and replace every placeholder. At minimum, provide the Supabase URL, publishable key, a newly generated secret key, the administrator allowlist, and a random signing-token pepper. Never commit `.env`.

Do not reuse an administrator login password as a database password. Do not prefix backend secrets with `VITE_`; Vite variables are compiled into browser assets.

### 3. Provision Supabase

Apply `supabase/migrations/20261007190000_initial_schema.sql` with `npx supabase db push --linked`, or use the Supabase SQL Editor. It creates the application tables, indexes, triggers, authorization policies, and Storage buckets.

Next, bootstrap the administrator account using the one-time environment variables described in [the deployment guide](docs/DEPLOYMENT.md#bootstrap-the-first-administrator). Remove the bootstrap password immediately after the command succeeds.

For existing Auth users, synchronize the configured administrator allowlist after migrating:

```powershell
npm run supabase:sync-admins
```

### 4. Start both applications

```powershell
npm run dev
```

- React development server: `http://localhost:5173`
- FastAPI server and health check: `http://localhost:8000/api/health`

Vite proxies `/api` to FastAPI. The root command watches both applications and stops them together.

### Useful commands

```powershell
# Production frontend build
npm run build

# Run the configured test suites
npm test

# Run only the API
uvicorn app.main:app --app-dir backend --reload --port 8000
```

## Deployment

The checked-in `render.yaml` builds `frontend/dist`, installs the Python dependencies, and starts FastAPI on Render's assigned `$PORT`. FastAPI then serves both the API and React client-side routes.

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for:

- credential rotation before first deployment;
- database migrations and Storage setup;
- one-time administrator bootstrap;
- the full environment-variable reference;
- Render Blueprint deployment; and
- post-deployment verification.

## Security notice

Configuration values previously pasted into chat, tickets, logs, screenshots, or source control must be considered exposed. Rotate the Supabase secret key, reset the database password, and reset any affected user password before using this portal. A Supabase publishable key is designed to be public, but its access must still be constrained by Row Level Security.

This repository intentionally contains no production secret or password. Store secrets in the Supabase and Render dashboards, not in Git.

Electronic-signature requirements vary by jurisdiction. The portal records consent and technical evidence, but that does not by itself guarantee that every agreement or workflow is legally sufficient. Have the agreement text, identity checks, retention policy, and signing process reviewed for the countries in which it will be used.

## Documentation

- [Agreement, invoice, renewal and project-sharing workflows](docs/WORKFLOWS.md)
- [Interface design and browser review](docs/UI-DESIGN.md)
- [Deployment and operations](docs/DEPLOYMENT.md)
- [Supabase API key security](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Render FastAPI deployment](https://render.com/docs/deploy-fastapi)
=======
# HICH-WEB
>>>>>>> ae8d5bf0f51fbdcc02b30f5a18e79a83374d2a0e
