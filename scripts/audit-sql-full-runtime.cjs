/**
 * Full SQL runtime readiness audit: tables, indexes, permissions.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/audit-sql-full-runtime.cjs
 *   FAIL_ON_MISSING=1 DATABASE_URL=... node scripts/audit-sql-full-runtime.cjs
 */
const { createHash } = require('crypto');
const { Pool } = require('pg');

const REQUIRED_TABLES = [
  'app_sessions',
  'user_credentials',
  'player_sessions_cache',
  'players_cache',
  'authority_operations',
  'user_balance_events',
  'live_outbox',
  'bonus_events_cache',
  'conversations_cache',
  'chat_messages_cache',
  'user_presence_cache',
  'player_game_requests_cache',
  'player_game_logins_cache',
  'player_cashout_tasks_cache',
  'carer_tasks_cache',
  'automation_jobs_cache',
  'automation_auto_state_cache',
  'financial_events_cache',
  'transfer_requests_cache',
  'referral_reward_claims_cache',
  'player_coin_rewards_cache',
  'freeplay_pending_gifts_cache',
  'freeplay_gifts_cache',
  'coadmin_maintenance_cache',
  'impersonation_logs_cache',
  'carer_cashouts_cache',
  'carer_creation_requests_cache',
];

const REQUIRED_INDEXES = [
  { table: 'app_sessions', index: 'app_sessions_uid_active_idx' },
  { table: 'app_sessions', index: 'app_sessions_expires_at_idx' },
  { table: 'player_sessions_cache', index: 'player_sessions_cache_player_uid_idx' },
  { table: 'live_outbox', index: 'live_outbox_channel_outbox_id_idx' },
  { table: 'chat_messages_cache', index: 'chat_messages_cache_conversation_created_idx' },
  { table: 'conversations_cache', index: 'conversations_cache_participants_gin_idx' },
  { table: 'user_presence_cache', index: 'user_presence_cache_last_seen_at_idx' },
  { table: 'bonus_events_cache', index: 'idx_bonus_events_cache_coadmin_uid' },
  { table: 'player_game_requests_cache', index: 'player_game_requests_cache_player_status_created_idx' },
];

const REQUIRED_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

function clean(v) {
  return String(v || '').trim();
}

function hashDatabaseUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url.replace(/^postgresql:/, 'postgres:'));
    const host = parsed.hostname || '';
    const port = parsed.port || '5432';
    const database = parsed.pathname.replace(/^\//, '') || '';
    const user = parsed.username || '';
    return createHash('sha256')
      .update(`${user}@${host}:${port}/${database}`)
      .digest('hex')
      .slice(0, 12);
  } catch {
    return createHash('sha256').update(url).digest('hex').slice(0, 12);
  }
}

function isProductionSqlMode() {
  if (process.env.NODE_ENV !== 'production') return false;
  const flag = (name) => {
    const raw = clean(process.env[name]);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return true;
  };
  return flag('AUTHORITY_SQL_WRITE') || flag('AUTH_SQL_READ');
}

async function main() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  const database_url_hash = hashDatabaseUrl(connectionString);
  const firebaseFirestoreBlocked = isProductionSqlMode();

  if (!connectionString) {
    const payload = {
      database_url_hash,
      missingTables: [...REQUIRED_TABLES],
      missingIndexes: REQUIRED_INDEXES.map((i) => i.index),
      missingPermissions: [],
      firebaseFirestoreBlocked,
      runtimeSource: 'postgres',
      database_checked: false,
      reason: 'DATABASE_URL not configured',
    };
    console.info('[SQL_RUNTIME_READY]', payload);
    if (process.env.FAIL_ON_MISSING === '1') process.exit(2);
    return;
  }

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });

  try {
    const { rows: tableRows } = await pool.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
      `,
      [REQUIRED_TABLES]
    );
    const presentTables = new Set(tableRows.map((r) => String(r.table_name)));
    const missingTables = REQUIRED_TABLES.filter((t) => !presentTables.has(t));

    const indexNames = REQUIRED_INDEXES.map((i) => i.index);
    const { rows: indexRows } = await pool.query(
      `
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
      `,
      [indexNames]
    );
    const presentIndexes = new Set(indexRows.map((r) => String(r.indexname)));
    const missingIndexes = REQUIRED_INDEXES.filter((i) => !presentIndexes.has(i.index)).map(
      (i) => i.index
    );

    const missingPermissions = [];
    for (const table of REQUIRED_TABLES.filter((t) => presentTables.has(t))) {
      const { rows: privRows } = await pool.query(
        `
          SELECT privilege_type
          FROM information_schema.role_table_grants
          WHERE table_schema = 'public'
            AND table_name = $1
            AND grantee = current_user
        `,
        [table]
      );
      const granted = new Set(privRows.map((r) => String(r.privilege_type)));
      const missing = REQUIRED_PRIVILEGES.filter((p) => !granted.has(p));
      if (missing.length) {
        missingPermissions.push({ table, missing });
      }
    }

    const ready =
      missingTables.length === 0 &&
      missingIndexes.length === 0 &&
      missingPermissions.length === 0;

    const payload = {
      database_url_hash,
      missingTables,
      missingIndexes,
      missingPermissions,
      firebaseFirestoreBlocked,
      runtimeSource: 'postgres',
      database_checked: true,
      ready,
      present_table_count: presentTables.size,
      required_table_count: REQUIRED_TABLES.length,
    };

    console.info('[SQL_RUNTIME_READY]', payload);

    if (process.env.FAIL_ON_MISSING === '1' && !ready) {
      process.exit(2);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[audit-sql-full-runtime] fatal', error);
  process.exit(1);
});
