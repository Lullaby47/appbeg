import 'server-only';

import { Pool, type PoolClient, type QueryResult } from 'pg';

import {
  getPlayerMirrorPool,
  runMirrorClientQuery,
  runMirrorPoolQuery,
} from '@/lib/sql/playerMirrorCommon';

export type CachedGameLogin = {
  id: string;
  gameName: string;
  username: string;
  password: string;
  backendUrl?: string;
  frontendUrl?: string;
  siteUrl?: string;
  createdBy: string;
  coadminUid?: string;
  createdAt?: string | null;
  status?: string;
};

export type MirrorGameLoginInput = CachedGameLogin & {
  raw?: Record<string, unknown>;
};

const GAME_LOGINS_CACHE_SQL_TIMEOUT_MS = 1_500;
const GAME_LOGINS_POOL_CONNECTION_TIMEOUT_MS = 3_000;
const GAME_LOGINS_POOL_IDLE_TIMEOUT_MS = 30_000;
const GAME_LOGINS_POOL_MAX = 4;
const GAME_LOGINS_MEMORY_CACHE_TTL_MS = 30_000;

type GameLoginsPoolCache = {
  connectionString: string;
  pool: Pool;
  unhealthy: boolean;
  errorHandlerAttached: boolean;
};

const globalSqlPool = globalThis as typeof globalThis & {
  __appbegGameLoginsCachePool?: GameLoginsPoolCache;
  __appbegGameLoginsMemoryCache?: Map<string, { expiresAt: number; rows: CachedGameLogin[] }>;
};

function getMemoryCache() {
  if (!globalSqlPool.__appbegGameLoginsMemoryCache) {
    globalSqlPool.__appbegGameLoginsMemoryCache = new Map();
  }
  return globalSqlPool.__appbegGameLoginsMemoryCache;
}

function databaseUrl() {
  return String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
}

export function hasGameLoginsCacheDatabase() {
  return Boolean(databaseUrl());
}

export type GameLoginsSqlTiming = {
  sql_pool_ms: number;
  pg_connect_ms: number;
  each_query_ms: number[];
  poolReused: boolean | null;
  pg_connect_error: string | null;
  pool?: 'playerMirror' | 'gameLoginsCache';
};

export function createGameLoginsSqlTiming(): GameLoginsSqlTiming {
  return {
    sql_pool_ms: 0,
    pg_connect_ms: 0,
    each_query_ms: [],
    poolReused: null,
    pg_connect_error: null,
  };
}

function getPool(sqlTiming?: Pick<GameLoginsSqlTiming, 'sql_pool_ms' | 'poolReused'>) {
  const poolStartedAt = Date.now();
  const connectionString = databaseUrl();
  if (!connectionString) {
    return null;
  }
  const cached = globalSqlPool.__appbegGameLoginsCachePool;
  if (cached?.connectionString === connectionString && !cached.unhealthy) {
    if (sqlTiming) {
      sqlTiming.sql_pool_ms = Date.now() - poolStartedAt;
      sqlTiming.poolReused = true;
    }
    console.info('[SQL_POOL] reused', { name: 'gameLoginsCache' });
    return cached.pool;
  }
  if (cached) {
    void cached.pool.end().catch((error) => {
      console.warn('[SQL_POOL] pool end failed', { name: 'gameLoginsCache', error });
    });
    globalSqlPool.__appbegGameLoginsCachePool = undefined;
  }

  const pool = new Pool({
    connectionString,
    max: GAME_LOGINS_POOL_MAX,
    connectionTimeoutMillis: GAME_LOGINS_POOL_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: GAME_LOGINS_POOL_IDLE_TIMEOUT_MS,
    query_timeout: GAME_LOGINS_CACHE_SQL_TIMEOUT_MS,
    statement_timeout: GAME_LOGINS_CACHE_SQL_TIMEOUT_MS,
  });
  const nextCache: GameLoginsPoolCache = {
    connectionString,
    pool,
    unhealthy: false,
    errorHandlerAttached: true,
  };
  pool.on('error', (error) => {
    nextCache.unhealthy = true;
    console.warn('[SQL_POOL] idle client error', { name: 'gameLoginsCache', error });
  });
  globalSqlPool.__appbegGameLoginsCachePool = nextCache;
  if (sqlTiming) {
    sqlTiming.sql_pool_ms = Date.now() - poolStartedAt;
    sqlTiming.poolReused = false;
  }
  console.info('[SQL_POOL] created', { name: 'gameLoginsCache' });
  return pool;
}

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const maybe = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number };
    if (typeof maybe.toDate === 'function') return maybe.toDate().toISOString();
    if (typeof maybe.toMillis === 'function') return new Date(maybe.toMillis()).toISOString();
    if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000).toISOString();
  }
  return null;
}

function mapRow(row: Record<string, unknown>): CachedGameLogin {
  return {
    id: cleanText(row.id),
    gameName: cleanText(row.game_name),
    username: cleanText(row.username),
    password: cleanText(row.password),
    backendUrl: cleanText(row.backend_url),
    frontendUrl: cleanText(row.frontend_url),
    siteUrl: cleanText(row.site_url),
    createdBy: cleanText(row.created_by),
    coadminUid: cleanText(row.coadmin_uid) || undefined,
    createdAt: toIsoString(row.created_at),
    status: cleanText(row.status) || 'active',
  };
}

function cloneRows(rows: CachedGameLogin[]) {
  return rows.map((row) => ({ ...row }));
}

function readMemoryCache(key: string) {
  const cached = getMemoryCache().get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    getMemoryCache().delete(key);
    return null;
  }
  return cloneRows(cached.rows);
}

function writeMemoryCache(key: string, rows: CachedGameLogin[]) {
  getMemoryCache().set(key, {
    expiresAt: Date.now() + GAME_LOGINS_MEMORY_CACHE_TTL_MS,
    rows: cloneRows(rows),
  });
}

function resetPoolAfterError(error: unknown) {
  const cached = globalSqlPool.__appbegGameLoginsCachePool;
  if (!cached) return;
  cached.unhealthy = true;
  console.warn('[SQL_POOL] reset after error', { name: 'gameLoginsCache', error });
  void cached.pool.end().catch((endError) => {
    console.warn('[SQL_POOL] pool end failed', { name: 'gameLoginsCache', error: endError });
  });
  globalSqlPool.__appbegGameLoginsCachePool = undefined;
}

function releaseClientSafely(client: PoolClient | null, destroy = false) {
  if (!client) return;
  try {
    (client.release as (destroy?: boolean) => void)(destroy);
  } catch (error) {
    console.warn('[SQL_POOL] client release failed', { name: 'gameLoginsCache', destroy, error });
  }
}

function timeoutAfter(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`game_logins_cache_query_timeout_${ms}ms`)), ms);
  });
}

function queryWithTimeout<T extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  values: unknown[]
): Promise<QueryResult<T>> {
  return Promise.race([
    client.query<T>(text, values),
    timeoutAfter(GAME_LOGINS_CACHE_SQL_TIMEOUT_MS),
  ]);
}

function recordSqlConnectError(sqlTiming: GameLoginsSqlTiming | undefined, error: unknown) {
  if (!sqlTiming) return;
  sqlTiming.pg_connect_error =
    error instanceof Error ? error.message : cleanText(error) || 'postgres_connect_failed';
}

const GAME_LOGINS_BY_FIELD_SQL = {
  coadminUid: `
    SELECT
      id,
      game_name,
      username,
      password,
      backend_url,
      frontend_url,
      site_url,
      created_by,
      coadmin_uid,
      created_at,
      status
    FROM public.game_logins_cache
    WHERE coadmin_uid = $1
      AND status = 'active'
    ORDER BY COALESCE(created_at, updated_at, mirrored_at) DESC
  `,
  createdBy: `
    SELECT
      id,
      game_name,
      username,
      password,
      backend_url,
      frontend_url,
      site_url,
      created_by,
      coadmin_uid,
      created_at,
      status
    FROM public.game_logins_cache
    WHERE created_by = $1
      AND status = 'active'
    ORDER BY COALESCE(created_at, updated_at, mirrored_at) DESC
  `,
} as const;

export async function readGameLoginsCacheByField(
  field: 'coadminUid' | 'createdBy',
  value: string,
  sqlTiming?: GameLoginsSqlTiming
): Promise<CachedGameLogin[] | null> {
  const cacheKey = `field:${field}:${value}`;
  const memoryCached = readMemoryCache(cacheKey);
  if (memoryCached) {
    console.info('[GAME_LOGINS_CACHE] memory hit', {
      field,
      value,
      count: memoryCached.length,
    });
    return memoryCached;
  }

  const pool = getPlayerMirrorPool();
  if (!pool) {
    return null;
  }

  if (sqlTiming) {
    sqlTiming.pool = 'playerMirror';
  }

  const poolStartedAt = Date.now();
  try {
    const { rows, timing } = await runMirrorPoolQuery<Record<string, unknown>>(
      pool,
      GAME_LOGINS_BY_FIELD_SQL[field],
      [value]
    );
    if (sqlTiming) {
      sqlTiming.sql_pool_ms += Date.now() - poolStartedAt;
      sqlTiming.pg_connect_ms += timing.pool_acquire_ms;
      sqlTiming.each_query_ms.push(timing.query_exec_ms);
      sqlTiming.poolReused = timing.pool_acquire_ms < 50;
    }

    const mapped = rows.map(mapRow);
    writeMemoryCache(cacheKey, mapped);
    console.info('[GAME_LOGINS_CACHE] postgres read', {
      pool: 'playerMirror',
      field,
      value,
      count: mapped.length,
      pg_connect_ms: timing.pool_acquire_ms,
      poolReused: timing.pool_acquire_ms < 50,
    });
    return mapped;
  } catch (error) {
    recordSqlConnectError(sqlTiming, error);
    console.warn('[GAME_LOGINS_CACHE] fallback firestore', {
      field,
      value,
      reason: 'postgres_read_failed',
      error,
    });
    return null;
  }
}

const GAME_LOGINS_BY_COADMIN_SQL = `
  SELECT DISTINCT ON (id)
    id,
    game_name,
    username,
    password,
    backend_url,
    frontend_url,
    site_url,
    created_by,
    coadmin_uid,
    created_at,
    status,
    updated_at,
    mirrored_at
  FROM public.game_logins_cache
  WHERE status = 'active'
    AND deleted_at IS NULL
    AND (coadmin_uid = $1 OR created_by = $1)
  ORDER BY id, COALESCE(created_at, updated_at, mirrored_at) DESC
`;

function sortCachedGameLogins(rows: CachedGameLogin[]) {
  return rows.sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

export async function readGameLoginsCacheByCoadminWithClient(
  client: PoolClient,
  coadminUid: string
): Promise<CachedGameLogin[]> {
  const cleanCoadminUid = cleanText(coadminUid);
  const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    GAME_LOGINS_BY_COADMIN_SQL,
    [cleanCoadminUid]
  );
  return sortCachedGameLogins(rows.map(mapRow));
}

export async function readGameLoginsCacheByCoadmin(
  coadminUid: string,
  sqlTiming?: GameLoginsSqlTiming
): Promise<CachedGameLogin[] | null> {
  const cacheKey = `coadmin:${coadminUid}`;
  const memoryCached = readMemoryCache(cacheKey);
  if (memoryCached) {
    console.info('[GAME_LOGINS_CACHE] memory hit', {
      coadminUid,
      count: memoryCached.length,
    });
    return memoryCached;
  }

  const pool = getPlayerMirrorPool();
  if (!pool) {
    return null;
  }

  if (sqlTiming) {
    sqlTiming.pool = 'playerMirror';
  }

  const poolStartedAt = Date.now();
  const cleanCoadminUid = cleanText(coadminUid);
  try {
    const { rows, timing } = await runMirrorPoolQuery<Record<string, unknown>>(
      pool,
      GAME_LOGINS_BY_COADMIN_SQL,
      [cleanCoadminUid]
    );
    if (sqlTiming) {
      sqlTiming.sql_pool_ms += Date.now() - poolStartedAt;
      sqlTiming.pg_connect_ms += timing.pool_acquire_ms;
      sqlTiming.each_query_ms.push(timing.query_exec_ms);
      sqlTiming.poolReused = timing.pool_acquire_ms < 50;
    }

    const mapped = sortCachedGameLogins(rows.map(mapRow));
    writeMemoryCache(cacheKey, mapped);
    console.info('[GAME_LOGINS_CACHE] postgres read', {
      pool: 'playerMirror',
      coadminUid: cleanCoadminUid,
      count: mapped.length,
      pg_connect_ms: timing.pool_acquire_ms,
      poolReused: timing.pool_acquire_ms < 50,
    });
    return mapped;
  } catch (error) {
    recordSqlConnectError(sqlTiming, error);
    console.warn('[GAME_LOGINS_CACHE] fallback firestore', {
      coadminUid: cleanCoadminUid,
      reason: 'postgres_read_failed',
      error,
    });
    return null;
  }
}

export async function mirrorGameLoginCache(input: MirrorGameLoginInput) {
  const db = getPool();
  if (!db) return false;

  const gameName = cleanText(input.gameName);
  const username = cleanText(input.username);
  const password = String(input.password || '');
  const createdBy = cleanText(input.createdBy);
  if (!input.id || !gameName || !username || !createdBy) {
    throw new Error('Invalid game login cache mirror payload.');
  }

  await db.query(
    `
      INSERT INTO public.game_logins_cache (
        id,
        game_name,
        username,
        password,
        backend_url,
        frontend_url,
        site_url,
        created_by,
        coadmin_uid,
        status,
        source,
        raw_json,
        created_at,
        updated_at,
        deleted_at,
        mirrored_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), 'active', 'appbeg', $10::jsonb,
        $11::timestamptz, now(), NULL, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        game_name = EXCLUDED.game_name,
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        backend_url = EXCLUDED.backend_url,
        frontend_url = EXCLUDED.frontend_url,
        site_url = EXCLUDED.site_url,
        created_by = EXCLUDED.created_by,
        coadmin_uid = EXCLUDED.coadmin_uid,
        status = 'active',
        source = 'appbeg',
        raw_json = EXCLUDED.raw_json,
        created_at = COALESCE(public.game_logins_cache.created_at, EXCLUDED.created_at),
        updated_at = now(),
        deleted_at = NULL,
        mirrored_at = now()
    `,
    [
      input.id,
      gameName,
      username,
      password,
      cleanText(input.backendUrl),
      cleanText(input.frontendUrl),
      cleanText(input.siteUrl || input.backendUrl),
      createdBy,
      cleanText(input.coadminUid),
      JSON.stringify(input.raw || {}),
      toIsoString(input.createdAt),
    ]
  );

  return true;
}

export async function deleteGameLoginCache(id: string) {
  const db = getPool();
  if (!db) return false;

  await db.query('DELETE FROM public.game_logins_cache WHERE id = $1', [id]);
  return true;
}

export type GameLoginDetailsSqlLookup = {
  username: string | null;
  password: string | null;
  backendUrl: string | null;
  frontendUrl: string | null;
  siteUrl: string | null;
};

export type GameLoginDetailsSqlLookupResult = {
  details: GameLoginDetailsSqlLookup | null;
  hit: boolean;
  missReason: 'postgres_unavailable' | 'lookup_failed' | 'row_missing' | 'missing_field' | null;
  durationMs: number;
};

function normalizeGameNameForAutomation(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function mapCachedGameLoginToDetails(row: CachedGameLogin): GameLoginDetailsSqlLookup {
  return {
    username: row.username || null,
    password: row.password || null,
    backendUrl: row.backendUrl || null,
    frontendUrl: row.frontendUrl || null,
    siteUrl: row.siteUrl || null,
  };
}

export async function lookupGameLoginDetailsForCoadminGameFromSql(
  coadminUid: string,
  gameName: string
): Promise<GameLoginDetailsSqlLookupResult> {
  const startedAt = Date.now();
  const cleanCoadminUid = cleanText(coadminUid);
  const target = normalizeGameNameForAutomation(String(gameName || ''));
  if (!cleanCoadminUid || !target) {
    return {
      details: null,
      hit: false,
      missReason: 'missing_field',
      durationMs: Date.now() - startedAt,
    };
  }

  const rows = await readGameLoginsCacheByCoadmin(cleanCoadminUid);
  const durationMs = Date.now() - startedAt;

  if (rows === null) {
    return {
      details: null,
      hit: false,
      missReason: 'postgres_unavailable',
      durationMs,
    };
  }

  for (const row of rows) {
    if (normalizeGameNameForAutomation(String(row.gameName || '')) !== target) {
      continue;
    }
    return {
      details: mapCachedGameLoginToDetails(row),
      hit: true,
      missReason: null,
      durationMs,
    };
  }

  return {
    details: null,
    hit: false,
    missReason: rows.length === 0 ? 'row_missing' : 'row_missing',
    durationMs,
  };
}
