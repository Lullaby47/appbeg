import 'server-only';

import {
  getDatabaseUrl,
  isAppSessionSqlReadEnabled,
  isAuthSqlReadEnabled,
  isAuthoritySqlWriteEnabled,
  isPlayerSessionSqlReadEnabled,
  isProductionNodeEnv,
} from '@/lib/server/sqlRuntime';
import { hashDatabaseUrl } from '@/lib/server/databaseUrlHash';
import { getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export const REQUIRED_AUTHORITY_SQL_TABLES = [
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
] as const;

export type RequiredAuthoritySqlTable = (typeof REQUIRED_AUTHORITY_SQL_TABLES)[number];

export const AUTHORITY_TABLE_MIGRATION_HINTS: Record<RequiredAuthoritySqlTable, string> = {
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

export type AuthoritySchemaAuditResult = {
  context: string;
  database_name: string | null;
  current_schema: string | null;
  current_user: string | null;
  database_url_hash: string | null;
  authority_sql_write: boolean;
  required_tables: RequiredAuthoritySqlTable[];
  present_tables: string[];
  missing_tables: string[];
  all_required_tables_present: boolean;
  skipped?: boolean;
  reason?: string | null;
};

export class AuthoritySchemaMissingError extends Error {
  readonly code = 'AUTHORITY_SCHEMA_MISSING';
  readonly missingTables: string[];

  constructor(missingTables: string[]) {
    super('SQL authority schema incomplete. Run migrations 034-038 on this DATABASE_URL.');
    this.name = 'AuthoritySchemaMissingError';
    this.missingTables = missingTables;
  }
}

async function readDatabaseIdentity(pool: ReturnType<typeof getPlayerMirrorPool>) {
  if (!pool) {
    return {
      database_name: null,
      current_schema: null,
      current_user: null,
    };
  }

  const [dbName, schema, currentUser] = await Promise.all([
    pool.query<{ database_name: string }>('SELECT current_database() AS database_name'),
    pool.query<{ current_schema: string }>('SELECT current_schema() AS current_schema'),
    pool.query<{ current_user: string }>('SELECT current_user AS current_user'),
  ]);

  return {
    database_name: dbName.rows[0]?.database_name ?? null,
    current_schema: schema.rows[0]?.current_schema ?? null,
    current_user: currentUser.rows[0]?.current_user ?? null,
  };
}

export async function checkAuthoritySqlTables(): Promise<AuthoritySchemaAuditResult> {
  const required_tables = [...REQUIRED_AUTHORITY_SQL_TABLES];
  const base: AuthoritySchemaAuditResult = {
    context: 'check',
    database_name: null,
    current_schema: null,
    current_user: null,
    database_url_hash: hashDatabaseUrl(),
    authority_sql_write: isAuthoritySqlWriteEnabled(),
    required_tables,
    present_tables: [],
    missing_tables: [...required_tables],
    all_required_tables_present: false,
  };

  if (!isAuthoritySqlWriteEnabled()) {
    return {
      ...base,
      all_required_tables_present: true,
      missing_tables: [],
      skipped: true,
      reason: 'authority_sql_write_disabled',
    };
  }

  if (!getDatabaseUrl()) {
    return {
      ...base,
      all_required_tables_present: false,
      skipped: true,
      reason: 'database_url_not_configured',
    };
  }

  const pool = getPlayerMirrorPool();
  if (!pool) {
    return {
      ...base,
      skipped: false,
      reason: 'postgres_pool_unavailable',
    };
  }

  const identity = await readDatabaseIdentity(pool);
  const { rows } = await pool.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [required_tables]
  );

  const presentSet = new Set(rows.map((row) => String(row.table_name)));
  const present_tables = required_tables.filter((table) => presentSet.has(table));
  const missing_tables = required_tables.filter((table) => !presentSet.has(table));

  return {
    ...base,
    ...identity,
    present_tables,
    missing_tables,
    all_required_tables_present: missing_tables.length === 0,
  };
}

export function migrationHintsForMissingTables(missingTables: string[]) {
  return missingTables.map((table) => ({
    table,
    migration: AUTHORITY_TABLE_MIGRATION_HINTS[table as RequiredAuthoritySqlTable] ?? 'migrations/001-033',
  }));
}

export async function assertAuthoritySqlSchema(context = 'runtime'): Promise<AuthoritySchemaAuditResult> {
  const result = await checkAuthoritySqlTables();
  const audit = { ...result, context };

  console.info('[AUTHORITY_SCHEMA_AUDIT]', {
    database_name: audit.database_name,
    current_schema: audit.current_schema,
    database_url_hash: audit.database_url_hash,
    authority_sql_write: audit.authority_sql_write,
    missing_tables: audit.missing_tables,
    present_tables: audit.present_tables,
    all_required_tables_present: audit.all_required_tables_present,
    context,
    skipped: audit.skipped ?? false,
    reason: audit.reason ?? null,
  });

  if (audit.skipped || !audit.authority_sql_write) {
    return audit;
  }

  if (!audit.all_required_tables_present) {
    console.error('[AUTHORITY_SCHEMA_AUDIT] missing required authority tables', {
      missing_tables: audit.missing_tables,
      migration_hints: migrationHintsForMissingTables(audit.missing_tables),
      database_url_hash: audit.database_url_hash,
      database_name: audit.database_name,
    });

    if (isProductionNodeEnv()) {
      throw new AuthoritySchemaMissingError(audit.missing_tables);
    }
  }

  return audit;
}

export async function readAuthoritySchemaAuditSnapshot() {
  const audit = await checkAuthoritySqlTables();
  return {
    database_name: audit.database_name,
    current_schema: audit.current_schema,
    current_user: audit.current_user,
    authority_operations_exists: audit.present_tables.includes('authority_operations'),
    authority_operations_row_count: null as number | null,
    authority_sql_write: audit.authority_sql_write,
    database_url_hash: audit.database_url_hash,
    environment: process.env.NODE_ENV || 'development',
    missing_tables: audit.missing_tables,
    present_tables: audit.present_tables,
    all_required_tables_present: audit.all_required_tables_present,
    skipped: audit.skipped,
    reason: audit.reason,
  };
}

export async function logAuthoritySchemaAudit(context = 'startup') {
  return assertAuthoritySqlSchema(context);
}

export async function logAuthorityAutoTickDb(input: {
  route: string;
  taskId: string;
}) {
  const audit = await checkAuthoritySqlTables();
  console.info('[AUTHORITY_AUTO_TICK_DB]', {
    route: input.route,
    taskId: input.taskId,
    database_name: audit.database_name,
    current_schema: audit.current_schema,
    authority_operations_exists: audit.present_tables.includes('authority_operations'),
    authority_sql_write: audit.authority_sql_write,
    database_url_hash: audit.database_url_hash,
    missing_tables: audit.missing_tables,
  });
  return audit;
}

export async function logSqlRuntimeDbAuditWithDatabase(context = 'runtime') {
  const audit = await checkAuthoritySqlTables();
  console.info('[SQL_RUNTIME_DB_AUDIT]', {
    context,
    database_url_hash: audit.database_url_hash,
    database_name: audit.database_name,
    authority_sql_write: audit.authority_sql_write,
    auth_sql_read: isAuthSqlReadEnabled(),
    player_session_sql_read: isPlayerSessionSqlReadEnabled(),
    app_session_sql_read: isAppSessionSqlReadEnabled(),
    environment: process.env.NODE_ENV || 'development',
    authority_operations_exists: audit.present_tables.includes('authority_operations'),
    missing_authority_tables: audit.missing_tables,
  });
  return audit;
}
