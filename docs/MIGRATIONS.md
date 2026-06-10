# PostgreSQL migrations

AppBeg uses SQL as the runtime authority when `AUTHORITY_SQL_WRITE=1` and SQL read flags are enabled. Apply pending migrations before deploying.

## Required recent migrations

Run in order (replace `$DATABASE_URL` with your connection string):

```bash
psql "$DATABASE_URL" -f migrations/034_authority_operations.sql
psql "$DATABASE_URL" -f migrations/035_freeplay_gifts_cache.sql
psql "$DATABASE_URL" -f migrations/036_coadmin_maintenance_cache.sql
psql "$DATABASE_URL" -f migrations/037_impersonation_logs_cache.sql
psql "$DATABASE_URL" -f migrations/038_runtime_missing_cache_tables.sql
```

PowerShell example:

```powershell
$env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/DATABASE"
psql $env:DATABASE_URL -f migrations/034_authority_operations.sql
psql $env:DATABASE_URL -f migrations/035_freeplay_gifts_cache.sql
psql $env:DATABASE_URL -f migrations/036_coadmin_maintenance_cache.sql
psql $env:DATABASE_URL -f migrations/037_impersonation_logs_cache.sql
psql $env:DATABASE_URL -f migrations/038_runtime_missing_cache_tables.sql
```

## Migration 038 — runtime cache tables (production fix)

Creates the three cache tables required by live routes (fixes `42P01 relation does not exist`):

| Table | Routes |
|---|---|
| `bonus_events_cache` | `/api/bonus-events/list` |
| `conversations_cache` | `/api/chat/unread-counts` |
| `user_presence_cache` | `/api/presence/batch`, `/api/presence/heartbeat` |

All statements use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` — safe to re-run.

```bash
psql "$DATABASE_URL" -f migrations/038_runtime_missing_cache_tables.sql
```

Optional chat message bodies (separate from unread counts):

```bash
psql "$DATABASE_URL" -f migrations/033_chat_messages_cache.sql
```

## Backfill from Firestore

After applying migration 038, populate cache tables from existing Firestore data:

```bash
node scripts/backfill-bonus-events-cache.cjs --only-missing
node scripts/backfill-user-presence-cache.cjs --only-missing
node scripts/backfill-conversations-cache.cjs --only-missing --include-messages
```

Or run all backfills:

```bash
npm run backfill:cache-tables
```

Flags: `--dry-run`, `--only-missing`, `--limit=N`

## Full migration set

If bootstrapping a fresh database, apply all files in `migrations/` in numeric order (`001` through `038`).

## Verify deployment

```bash
DATABASE_URL=... npm run audit:sql-schema
npm run audit:firestore
npx tsc --noEmit
```

Expected:

- `[SQL_SCHEMA_AUDIT] missing_tables=[] all_required_tables_present=true`
- Firestore audit: `routes_still_ungated_writes: 0`

Until migration 038 is applied, affected routes return empty SQL results (no Firestore fallback).
