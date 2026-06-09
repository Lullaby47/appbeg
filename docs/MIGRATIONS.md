# PostgreSQL migrations

AppBeg uses SQL as the runtime authority when `AUTHORITY_SQL_WRITE=1` and SQL read flags are enabled. Apply pending migrations before deploying.

## Required recent migrations

Run in order (replace `$DATABASE_URL` with your connection string):

```bash
psql "$DATABASE_URL" -f migrations/034_authority_operations.sql
psql "$DATABASE_URL" -f migrations/035_freeplay_gifts_cache.sql
psql "$DATABASE_URL" -f migrations/036_coadmin_maintenance_cache.sql
psql "$DATABASE_URL" -f migrations/037_impersonation_logs_cache.sql
```

PowerShell example:

```powershell
$env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/DATABASE"
psql $env:DATABASE_URL -f migrations/034_authority_operations.sql
psql $env:DATABASE_URL -f migrations/035_freeplay_gifts_cache.sql
psql $env:DATABASE_URL -f migrations/036_coadmin_maintenance_cache.sql
psql $env:DATABASE_URL -f migrations/037_impersonation_logs_cache.sql
```

## Full migration set

If bootstrapping a fresh database, apply all files in `migrations/` in numeric order (`001` through `037`).

## Verify deployment

```bash
npm run audit:firestore
npx tsc --noEmit
```

Expected audit result: all routes gated, `routes_still_ungated_writes: 0`.
