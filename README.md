# AppBeg

Next.js application with **PostgreSQL SQL authority** for app data. When SQL flags are enabled (default in production), Firestore app logic does not run. Firebase Auth remains for identity/token operations only.

## Getting started

1. Copy environment template:

```bash
cp .env.local.example .env.local
```

2. Fill in `DATABASE_URL`, Firebase Auth variables (identity only), and automation secrets.

3. Apply PostgreSQL migrations — see [docs/MIGRATIONS.md](docs/MIGRATIONS.md).

4. Run the development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## SQL-authoritative runtime

### Server flags (required)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_SQL_READ=1` | SQL cache reads for profiles, behaviours, history |
| `PLAYER_SESSION_SQL_READ=1` | Player session validation from SQL |
| `APP_SESSION_SQL_READ=1` | Staff/coadmin/carer app sessions from SQL |
| `AUTHORITY_SQL_WRITE=1` | All money/task/admin writes go to SQL |

In **production**, unset flags default to SQL-on. Missing `DATABASE_URL` fails startup.

### Client flags (NEXT_PUBLIC, set at build time)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SQL_LOGIN_FIRST=1` | Prefer SQL login path |
| `NEXT_PUBLIC_SQL_PLAYER_LOGIN=1` | Player SQL login |
| `NEXT_PUBLIC_AUTOMATION_JOBS_SQL_READ=1` | Carer automation jobs from SQL/live |
| `NEXT_PUBLIC_CARER_TASKS_SQL_READ=1` | Carer tasks from SQL/live |
| `NEXT_PUBLIC_PLAYER_REQUESTS_SQL_READ=1` | Player game requests from SQL/live |

### Firebase Auth only (not Firestore authority)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase client SDK (Auth) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase Auth domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase project ID |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase app ID |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | Admin SDK for Auth verify / password reset |

Legacy Firestore code paths exist only when `AUTHORITY_SQL_WRITE=0` (development rollback).

### Automation secrets

| Variable | Purpose |
|---|---|
| `CARER_AUTOMATION_BROWSER_TICK_TOKEN_SECRET` | Browser auto-tick token signing |
| `CARER_AUTOMATION_TICK_SECRET` | Server auto-tick route secret |

## Deploy on Vercel

Set all SQL flags and `DATABASE_URL` in the Vercel project environment. Set `NEXT_PUBLIC_*` flags for **Production** and redeploy so client bundles pick them up.

Production startup runs `assertSqlRuntimeReady()` and `assertRequiredSqlTables()`. Missing cache tables are logged via `[SQL_SCHEMA_AUDIT]`; apply `migrations/038_runtime_missing_cache_tables.sql` — routes return empty SQL results (no Firestore fallback) until tables exist.

See `.env.example` for the full variable list.

## Verification

```bash
npm run audit:firestore
npx tsc --noEmit
git diff --check
```

## Security notes

- Never commit service account keys or `.env.local`.
- Rotate Firebase service account keys if exposed.
- Admin bootstrap uses local Firebase Admin SDK tools, not the browser.

## Username registry

Set `USERNAME_REGISTRY_API_URL` and `USERNAME_REGISTRY_SECRET` for the external username-registry API. AppBeg records game usernames after player creation; the registry is a separate service.

## Local admin tool

Use `tools/admin_tool.py` for local-only administrator management via Firebase Admin SDK. See script docstring for `APPBEG_SERVICE_ACCOUNT_PATH` and `APPBEG_ADMIN_MASTER_SECRET`.
