/**
 * SQL schema + Firestore runtime touchpoint audit.
 *
 * Usage:
 *   node scripts/audit-sql-schema.cjs
 *   DATABASE_URL=... node scripts/audit-sql-schema.cjs
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');

const REQUIRED_CACHE_TABLES = [
  'bonus_events_cache',
  'conversations_cache',
  'user_presence_cache',
];

const RELATED_CACHE_TABLES = ['chat_messages_cache'];

const FIRESTORE_RUNTIME_TOUCHPOINTS = [
  {
    collection: 'conversations',
    touch: 'client_write',
    sql_cache: 'conversations_cache',
    blocked_when_sql_read: 'read_only',
    notes: 'Send still has legacy Firestore branch; mark-read skips Firestore mirror in SQL authority mode',
  },
  {
    collection: 'conversations/messages',
    touch: 'client_write',
    sql_cache: 'chat_messages_cache',
    blocked_when_sql_read: 'read_only',
    notes: 'Message bodies mirrored to SQL on send when client SQL read mode is on',
  },
  {
    collection: 'userPresence',
    touch: 'none_when_sql_read',
    sql_cache: 'user_presence_cache',
    blocked_when_sql_read: 'read_and_write',
    notes: 'Heartbeat uses /api/presence/heartbeat; batch read uses SQL',
  },
  {
    collection: 'bonusEvents',
    touch: 'authority_write_only',
    sql_cache: 'bonus_events_cache',
    blocked_when_sql_read: 'read',
    notes: '/api/bonus-events/list reads SQL only when SQL flags on',
  },
  {
    collection: 'users',
    touch: 'read_write',
    sql_cache: 'players_cache / users_cache',
    blocked_when_sql_read: 'partial',
    notes: 'Authority routes SQL-gated; client profile listeners may still use Firestore',
  },
  {
    collection: 'carerTasks',
    touch: 'read_write',
    sql_cache: 'carer_tasks_cache',
    blocked_when_sql_read: 'partial',
  },
  {
    collection: 'playerGameRequests',
    touch: 'read_write',
    sql_cache: 'player_game_requests_cache',
    blocked_when_sql_read: 'partial',
  },
  {
    collection: 'automation_jobs',
    touch: 'read_write',
    sql_cache: 'automation_jobs_cache',
    blocked_when_sql_read: 'partial',
  },
  {
    collection: 'playerGameLogins',
    touch: 'read_write',
    sql_cache: 'player_game_logins_cache',
    blocked_when_sql_read: 'partial',
  },
  {
    collection: 'gameLogins',
    touch: 'read_write',
    sql_cache: 'game_logins_cache',
    blocked_when_sql_read: 'partial',
  },
  {
    collection: 'playerCashoutTasks',
    touch: 'read_write',
    sql_cache: 'player_cashout_tasks_cache',
    blocked_when_sql_read: 'partial',
  },
  {
    collection: 'financialEvents',
    touch: 'write',
    sql_cache: 'financial_events_cache',
    blocked_when_sql_read: 'partial',
  },
  {
    collection: 'transferRequests',
    touch: 'read_write',
    sql_cache: 'transfer_requests_cache',
    blocked_when_sql_read: 'partial',
  },
  {
    collection: 'impersonationLogs',
    touch: 'write',
    sql_cache: 'impersonation_logs_cache',
    blocked_when_sql_read: 'partial',
  },
];

function clean(value) {
  return String(value || '').trim();
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

async function checkTablePrivileges(pool, tableName) {
  const { rows } = await pool.query(
    `
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name = $1
        AND grantee = current_user
    `,
    [tableName]
  );
  return rows.map((row) => String(row.privilege_type));
}

async function main() {
  const required = [...REQUIRED_CACHE_TABLES];
  const related = [...RELATED_CACHE_TABLES];
  const allTables = [...required, ...related];

  let present_tables = [];
  let missing_tables = [...required];
  let related_present_tables = [];
  let related_missing_tables = [...related];
  let database_checked = false;

  const pool = createPgPool();
  if (pool) {
    database_checked = true;
    try {
      const requiredCheck = await checkTables(pool, required);
      present_tables = requiredCheck.present_tables;
      missing_tables = requiredCheck.missing_tables;
      const relatedCheck = await checkTables(pool, related);
      related_present_tables = relatedCheck.present_tables;
      related_missing_tables = relatedCheck.missing_tables;
    } finally {
      await pool.end();
    }
  }

  let bonus_events_cache_privileges = [];
  const poolForPrivileges = createPgPool();
  if (poolForPrivileges) {
    try {
      bonus_events_cache_privileges = await checkTablePrivileges(
        poolForPrivileges,
        'bonus_events_cache'
      );
    } finally {
      await poolForPrivileges.end();
    }
  }

  const audit = {
    script: 'audit-sql-schema',
    database_checked,
    required_cache_tables: required,
    present_tables,
    missing_tables,
    all_required_tables_present: missing_tables.length === 0,
    bonus_events_cache_privileges,
    bonus_events_cache_privileges_ok: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((priv) =>
      bonus_events_cache_privileges.includes(priv)
    ),
    related_cache_tables: related,
    related_present_tables,
    related_missing_tables,
    migration_bundle: 'migrations/038_runtime_missing_cache_tables.sql',
    backfill_scripts: {
      bonus_events_cache: 'node scripts/backfill-bonus-events-cache.cjs --only-missing',
      conversations_cache:
        'node scripts/backfill-conversations-cache.cjs --only-missing --include-messages',
      user_presence_cache: 'node scripts/backfill-user-presence-cache.cjs --only-missing',
    },
    firestore_runtime_touchpoints: FIRESTORE_RUNTIME_TOUCHPOINTS,
    cache_tables_sql_only_reads: [
      'user_presence_cache',
      'conversations_cache (unread counts)',
      'bonus_events_cache (/api/bonus-events/list)',
    ],
  };

  console.info('[SQL_SCHEMA_AUDIT]', {
    missing_tables,
    all_required_tables_present: audit.all_required_tables_present,
  });
  console.log(JSON.stringify(audit, null, 2));

  if (process.env.FAIL_ON_MISSING_TABLES === '1' && missing_tables.length) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error('[audit-sql-schema] fatal', error);
  process.exitCode = 1;
});
