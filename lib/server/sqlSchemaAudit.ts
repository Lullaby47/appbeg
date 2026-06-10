import 'server-only';

import { isDatabaseUrlConfigured, isProductionNodeEnv } from '@/lib/server/sqlRuntime';
import { getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export const REQUIRED_SQL_CACHE_TABLES = [
  'bonus_events_cache',
  'conversations_cache',
  'user_presence_cache',
] as const;

export type RequiredSqlCacheTable = (typeof REQUIRED_SQL_CACHE_TABLES)[number];

export type SqlSchemaAuditResult = {
  context: string;
  required_tables: RequiredSqlCacheTable[];
  missing_tables: string[];
  present_tables: string[];
  all_required_tables_present: boolean;
  skipped?: boolean;
  reason?: string;
};

export class SqlSchemaMissingError extends Error {
  readonly code = 'SQL_SCHEMA_MISSING';
  readonly missingTables: string[];

  constructor(missingTables: string[]) {
    super(
      `Missing required SQL tables: ${missingTables.join(', ')}. Apply migrations/038_runtime_missing_cache_tables.sql (or 030–032).`
    );
    this.name = 'SqlSchemaMissingError';
    this.missingTables = missingTables;
  }
}

export async function checkRequiredSqlTables(): Promise<SqlSchemaAuditResult> {
  const required_tables = [...REQUIRED_SQL_CACHE_TABLES];
  const base: SqlSchemaAuditResult = {
    context: 'check',
    required_tables,
    missing_tables: [],
    present_tables: [],
    all_required_tables_present: false,
  };

  if (!isDatabaseUrlConfigured()) {
    return {
      ...base,
      all_required_tables_present: true,
      skipped: true,
      reason: 'database_url_not_configured',
    };
  }

  const pool = getPlayerMirrorPool();
  if (!pool) {
    return {
      ...base,
      missing_tables: [...required_tables],
      all_required_tables_present: false,
      skipped: false,
      reason: 'postgres_pool_unavailable',
    };
  }

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
    present_tables,
    missing_tables,
    all_required_tables_present: missing_tables.length === 0,
  };
}

export async function assertRequiredSqlTables(context = 'runtime'): Promise<SqlSchemaAuditResult> {
  const result = await checkRequiredSqlTables();
  const audit = { ...result, context };

  console.info('[SQL_SCHEMA_AUDIT]', {
    context,
    required_tables: audit.required_tables,
    present_tables: audit.present_tables,
    missing_tables: audit.missing_tables,
    all_required_tables_present: audit.all_required_tables_present,
    skipped: audit.skipped ?? false,
    reason: audit.reason ?? null,
  });

  if (audit.skipped) {
    return audit;
  }

  if (!audit.all_required_tables_present && isProductionNodeEnv()) {
    console.error('[SQL_SCHEMA_AUDIT] production missing required runtime tables', {
      missing_tables: audit.missing_tables,
      migration: 'migrations/038_runtime_missing_cache_tables.sql',
      note: 'Routes return empty SQL results until migration is applied.',
    });
  }

  return audit;
}
