/**
 * Authority SQL schema audit (migrations 034-038 + authority cache tables).
 *
 * Usage:
 *   npm run audit:authority-schema
 *   DATABASE_URL=... npm run audit:authority-schema
 *   FAIL_ON_MISSING_TABLES=1 npm run audit:authority-schema
 */
const crypto = require('crypto');
const { Pool } = require('pg');

const REQUIRED_AUTHORITY_TABLES = [
  'authority_operations',
  'user_balance_events',
  'financial_events_cache',
  'user_balance_snapshots_cache',
  'players_cache',
  'player_game_requests_cache',
  'carer_tasks_cache',
  'automation_jobs_cache',
  'player_cashout_tasks_cache',
  'transfer_requests_cache',
  'referral_reward_claims_cache',
  'player_coin_rewards_cache',
  'freeplay_pending_gifts_cache',
  'freeplay_gifts_cache',
  'coadmin_maintenance_cache',
  'impersonation_logs_cache',
  'bonus_events_cache',
  'conversations_cache',
  'user_presence_cache',
];

const TABLE_MIGRATION_HINTS = {
  authority_operations: 'migrations/034_authority_operations.sql',
  freeplay_gifts_cache: 'migrations/035_freeplay_gifts_cache.sql',
  coadmin_maintenance_cache: 'migrations/036_coadmin_maintenance_cache.sql',
  impersonation_logs_cache: 'migrations/037_impersonation_logs_cache.sql',
  bonus_events_cache: 'migrations/038_runtime_missing_cache_tables.sql',
  conversations_cache: 'migrations/038_runtime_missing_cache_tables.sql',
  user_presence_cache: 'migrations/038_runtime_missing_cache_tables.sql',
  user_balance_events: 'migrations/017_user_balance_events.sql',
  financial_events_cache: 'migrations/009_financial_events_cache.sql',
  user_balance_snapshots_cache: 'migrations/014_user_balance_snapshots_cache.sql',
  players_cache: 'migrations/005_player_registration_profile_mirror.sql',
  player_game_requests_cache: 'migrations/008_player_game_requests_cache.sql',
  carer_tasks_cache: 'migrations/007_carer_tasks_cache.sql',
  automation_jobs_cache: 'migrations/004_automation_jobs_cache.sql',
  player_cashout_tasks_cache: 'migrations/010_player_cashout_tasks_cache.sql',
  transfer_requests_cache: 'migrations/011_transfer_requests_cache.sql',
  referral_reward_claims_cache: 'migrations/013_referral_reward_claims_cache.sql',
  player_coin_rewards_cache: 'migrations/012_player_coin_rewards_cache.sql',
  freeplay_pending_gifts_cache: 'migrations/029_freeplay_pending_gifts_cache.sql',
};

function clean(value) {
  return String(value || '').trim();
}

function hashDatabaseUrl(connectionString) {
  const url = clean(connectionString);
  if (!url) return null;
  try {
    const parsed = new URL(url.replace(/^postgresql:/, 'postgres:'));
    const host = parsed.hostname || '';
    const port = parsed.port || '5432';
    const database = parsed.pathname.replace(/^\//, '') || '';
    const user = parsed.username || '';
    return crypto
      .createHash('sha256')
      .update(`${user}@${host}:${port}/${database}`)
      .digest('hex')
      .slice(0, 12);
  } catch {
    return crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
  }
}

function createPgPool() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (!connectionString) return null;
  return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
}

async function checkTables(pool, tableNames) {
  const { rows } = await pool.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [tableNames]
  );
  const present = new Set(rows.map((row) => String(row.table_name)));
  return {
    present_tables: tableNames.filter((name) => present.has(name)),
    missing_tables: tableNames.filter((name) => !present.has(name)),
  };
}

async function main() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  const pool = createPgPool();

  let database_name = null;
  let current_user = null;
  let present_tables = [];
  let missing_tables = [...REQUIRED_AUTHORITY_TABLES];
  let database_checked = false;

  if (pool) {
    database_checked = true;
    try {
      const [dbName, user, tableCheck] = await Promise.all([
        pool.query('SELECT current_database() AS database_name'),
        pool.query('SELECT current_user AS current_user'),
        checkTables(pool, REQUIRED_AUTHORITY_TABLES),
      ]);
      database_name = dbName.rows[0]?.database_name ?? null;
      current_user = user.rows[0]?.current_user ?? null;
      present_tables = tableCheck.present_tables;
      missing_tables = tableCheck.missing_tables;
    } finally {
      await pool.end();
    }
  }

  const migration_hints = missing_tables.map((table) => ({
    table,
    migration: TABLE_MIGRATION_HINTS[table] || 'migrations/001-033',
  }));

  const audit = {
    script: 'audit-authority-schema',
    database_checked,
    database_url_hash: hashDatabaseUrl(connectionString),
    database_name,
    current_user,
    authority_sql_write: clean(process.env.AUTHORITY_SQL_WRITE) === '1',
    required_tables: REQUIRED_AUTHORITY_TABLES,
    present_tables,
    missing_tables,
    all_required_tables_present: missing_tables.length === 0,
    migration_hints,
    production_bundle_order: [
      'migrations/034_authority_operations.sql',
      'migrations/035_freeplay_gifts_cache.sql',
      'migrations/036_coadmin_maintenance_cache.sql',
      'migrations/037_impersonation_logs_cache.sql',
      'migrations/038_runtime_missing_cache_tables.sql',
    ],
  };

  console.info('[AUTHORITY_SCHEMA_AUDIT]', {
    database_name: audit.database_name,
    current_schema: 'public',
    database_url_hash: audit.database_url_hash,
    authority_sql_write: audit.authority_sql_write,
    missing_tables: audit.missing_tables,
    present_tables: audit.present_tables,
    all_required_tables_present: audit.all_required_tables_present,
  });
  console.log(JSON.stringify(audit, null, 2));

  if (process.env.FAIL_ON_MISSING_TABLES === '1' && missing_tables.length) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error('[audit-authority-schema] fatal', error);
  process.exitCode = 1;
});
