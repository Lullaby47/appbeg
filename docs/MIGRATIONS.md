# PostgreSQL migrations

AppBeg uses SQL as the runtime authority when `AUTHORITY_SQL_WRITE=1` and SQL read flags are enabled. Apply pending migrations before deploying.

## Player signup-code repair (VPS / production)

If the coadmin dashboard reports that `coadmin_player_signup_codes` does not exist, deploy the current code and run this idempotent repair against the same production `DATABASE_URL`:

```bash
node scripts/run-sql-file.cjs migrations/061_repair_coadmin_player_signup_codes.sql
```

Or with `psql`:

```bash
psql "$DATABASE_URL" -f migrations/061_repair_coadmin_player_signup_codes.sql
```

Verify it on the VPS:

```bash
psql "$DATABASE_URL" -c "SELECT to_regclass('public.coadmin_player_signup_codes') AS signup_code_table;"
```

The expected value is `coadmin_player_signup_codes`. Once present, opening the coadmin dashboard creates that coadmin's first code; **Copy** reads it and **Generate New Code** replaces it while recording only hashes in the audit table.

## Required production order (034–038)

When `AUTHORITY_SQL_WRITE=1`, production startup requires **all** authority tables below. Apply migrations in this exact order on the **same `DATABASE_URL` Vercel uses**:

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

| Migration | Creates / requires |
|-----------|-------------------|
| `034_authority_operations.sql` | `authority_operations` (idempotency ledger for all SQL authority writes) |
| `035_freeplay_gifts_cache.sql` | `freeplay_gifts_cache` |
| `036_coadmin_maintenance_cache.sql` | `coadmin_maintenance_cache` |
| `037_impersonation_logs_cache.sql` | `impersonation_logs_cache` |
| `038_runtime_missing_cache_tables.sql` | `bonus_events_cache`, `conversations_cache`, `user_presence_cache` |

Earlier migrations (`001`–`033`) must also be applied on a fresh database (players cache, carer tasks, balance events, etc.). See **Full migration set** below.

## Authority schema audit

With `AUTHORITY_SQL_WRITE=1`, startup checks these tables:

- `authority_operations`
- `user_balance_events`
- `financial_events_cache`
- `user_balance_snapshots_cache`
- `players_cache`
- `player_game_requests_cache`
- `carer_tasks_cache`
- `automation_jobs_cache`
- `player_cashout_tasks_cache`
- `transfer_requests_cache`
- `referral_reward_claims_cache`
- `player_coin_rewards_cache`
- `freeplay_pending_gifts_cache`
- `freeplay_gifts_cache`
- `coadmin_maintenance_cache`
- `impersonation_logs_cache`
- `bonus_events_cache`
- `conversations_cache`
- `user_presence_cache`

If any are missing in **production**, startup fails with:

`SQL authority schema incomplete. Run migrations 034-038 on this DATABASE_URL.`

Verify before deploy:

```bash
DATABASE_URL=... npm run audit:authority-schema
```

Compare `database_url_hash` in the audit output with Vercel `[AUTHORITY_SCHEMA_AUDIT]` logs to confirm the same database.

## Migration 038 — runtime cache tables

Creates the three cache tables required by live routes (fixes `42P01 relation does not exist`):

| Table | Routes |
|---|---|
| `bonus_events_cache` | `/api/bonus-events/list` |
| `conversations_cache` | `/api/chat/unread-counts` |
| `user_presence_cache` | `/api/presence/batch`, `/api/presence/heartbeat` |

All statements use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` — safe to re-run.

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
DATABASE_URL=... npm run audit:authority-schema
DATABASE_URL=... npm run audit:sql-schema
npm run audit:firestore
npx tsc --noEmit
```

Expected:

- `[AUTHORITY_SCHEMA_AUDIT] missing_tables=[] all_required_tables_present=true`
- Firestore audit: `routes_still_ungated_writes: 0`

There is no Firestore fallback when SQL authority mode is enabled.
