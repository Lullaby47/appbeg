import 'server-only';

import { Pool, type PoolClient } from 'pg';

const SQL_CONNECTION_TIMEOUT_MS = resolvePositiveInt(
  process.env.PG_CONNECTION_TIMEOUT_MS,
  5_000
);
const SQL_STATEMENT_TIMEOUT_MS = resolvePositiveInt(process.env.PG_STATEMENT_TIMEOUT_MS, 15_000);
const PLAYER_MIRROR_IDLE_TIMEOUT_MS = resolvePositiveInt(process.env.PG_IDLE_TIMEOUT_MS, 30_000);

function resolvePositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function resolvePlayerMirrorPoolMax() {
  const fromEnv = Number(process.env.PG_POOL_MAX || process.env.PLAYER_MIRROR_POOL_MAX || 3);
  if (!Number.isFinite(fromEnv)) {
    return 3;
  }
  return Math.min(10, Math.max(1, Math.trunc(fromEnv)));
}

const PLAYER_MIRROR_POOL_MAX = resolvePlayerMirrorPoolMax();

function resolvePlayerMirrorPoolWarmMin() {
  const fromEnv = Number(process.env.PLAYER_MIRROR_POOL_WARM_MIN || 0);
  if (!Number.isFinite(fromEnv)) {
    return 0;
  }
  return Math.min(PLAYER_MIRROR_POOL_MAX, Math.max(0, Math.trunc(fromEnv)));
}

function isPlayerMirrorPoolWarmEnabled() {
  const env = cleanText(process.env.PLAYER_MIRROR_POOL_WARM_ENABLED).toLowerCase();
  if (env === '0' || env === 'false' || env === 'no') {
    return false;
  }
  if (env === '1' || env === 'true' || env === 'yes') {
    return true;
  }
  return process.env.NODE_ENV !== 'production';
}

type PlayerMirrorWarmState = {
  inflight: Promise<void> | null;
  completed: boolean;
};

const globalSqlPoolWarm = globalThis as typeof globalThis & {
  __appbegPlayerMirrorWarmState?: PlayerMirrorWarmState;
};

function playerMirrorWarmState(): PlayerMirrorWarmState {
  if (!globalSqlPoolWarm.__appbegPlayerMirrorWarmState) {
    globalSqlPoolWarm.__appbegPlayerMirrorWarmState = {
      inflight: null,
      completed: false,
    };
  }
  return globalSqlPoolWarm.__appbegPlayerMirrorWarmState;
}

export function warmPlayerMirrorPool(reason: string) {
  if (!isPlayerMirrorPoolWarmEnabled()) {
    return;
  }

  const pool = getPlayerMirrorPool();
  if (!pool) {
    return;
  }

  const warmState = playerMirrorWarmState();
  if (warmState.completed || warmState.inflight) {
    return;
  }

  const requested = resolvePlayerMirrorPoolWarmMin();
  if (requested <= 0) {
    return;
  }

  warmState.inflight = (async () => {
    const startedAt = Date.now();
    let ok = 0;
    let failed = 0;
    const warmCount = Math.min(requested, PLAYER_MIRROR_POOL_MAX);

    const warmOne = async () => {
      try {
        const client = await pool.connect();
        try {
          await client.query('SELECT 1');
          ok += 1;
        } finally {
          client.release();
        }
      } catch {
        failed += 1;
      }
    };

    await Promise.all(Array.from({ length: warmCount }, () => warmOne()));

    console.info('[SQL_POOL_WARMUP]', {
      name: 'playerMirror',
      reason,
      requested: warmCount,
      ok,
      failed,
      durationMs: Date.now() - startedAt,
    });
    warmState.completed = true;
  })()
    .catch((error) => {
      console.warn('[SQL_POOL_WARMUP] failed', {
        name: 'playerMirror',
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      warmState.inflight = null;
    });
}

export type PlayerMirrorAcquireContext = {
  context: string;
  route?: string;
  request_id?: string;
};

function shouldLogPoolAcquire(acquireMs: number, waitingBefore: number, idleBefore: number) {
  return (
    process.env.SQL_POOL_DEBUG === '1' ||
    acquireMs >= 50 ||
    waitingBefore > 0 ||
    idleBefore === 0
  );
}

function logSqlPoolAcquire(
  pool: Pool,
  acquireMs: number,
  statsBefore: { totalCount: number; idleCount: number; waitingCount: number },
  acquireContext?: PlayerMirrorAcquireContext
) {
  if (
    !shouldLogPoolAcquire(
      acquireMs,
      statsBefore.waitingCount,
      statsBefore.idleCount
    )
  ) {
    return;
  }
  const stats = {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    max: PLAYER_MIRROR_POOL_MAX,
  };
  console.info('[SQL_POOL_ACQUIRE]', {
    name: 'playerMirror',
    context: acquireContext?.context ?? 'unspecified',
    acquire_ms: acquireMs,
    ...stats,
    request_id: acquireContext?.request_id ?? null,
    route: acquireContext?.route ?? null,
    idle_before: statsBefore.idleCount,
    waiting_before: statsBefore.waitingCount,
    slow_acquire: acquireMs >= 50,
  });
  if (acquireMs >= 100 || statsBefore.waitingCount > 0 || stats.waitingCount > 0) {
    logPlayerMirrorPoolStats(`slow_acquire:${acquireContext?.context ?? 'unspecified'}`);
  }
}

export type PlayerMirrorSqlTiming = {
  pool_acquire_ms: number;
  query_exec_ms: number;
  total_ms: number;
};

export function createPlayerMirrorSqlTiming(
  partial: Partial<PlayerMirrorSqlTiming> = {}
): PlayerMirrorSqlTiming {
  return {
    pool_acquire_ms: partial.pool_acquire_ms ?? 0,
    query_exec_ms: partial.query_exec_ms ?? 0,
    total_ms: partial.total_ms ?? 0,
  };
}

export function isSqlMissingRelationError(error: unknown, tableName?: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const pg = error as { code?: string; message?: string };
  if (pg.code !== '42P01') {
    return false;
  }
  if (!tableName) {
    return true;
  }
  return String(pg.message || '').includes(tableName);
}

export function logSqlMissingRelation(tableName: string, context: string) {
  console.warn('[SQL_SCHEMA_AUDIT]', {
    missing_tables: [tableName],
    all_required_tables_present: false,
    context,
    reason: 'relation_does_not_exist',
    migration: 'migrations/038_runtime_missing_cache_tables.sql',
  });
}

export async function runMirrorClientQuery<T extends Record<string, unknown>>(
  client: PoolClient,
  sql: string,
  params: unknown[] = []
): Promise<{ rows: T[]; timing: PlayerMirrorSqlTiming }> {
  const totalStartedAt = Date.now();
  const queryStartedAt = Date.now();
  const result = await client.query(sql, params);
  const query_exec_ms = Date.now() - queryStartedAt;
  return {
    rows: result.rows as T[],
    timing: createPlayerMirrorSqlTiming({
      pool_acquire_ms: 0,
      query_exec_ms,
      total_ms: Date.now() - totalStartedAt,
    }),
  };
}

export async function runMirrorPoolQuery<T extends Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
  acquireContext?: PlayerMirrorAcquireContext
): Promise<{ rows: T[]; timing: PlayerMirrorSqlTiming }> {
  const totalStartedAt = Date.now();
  const acquired = await acquirePlayerMirrorClient(acquireContext);
  if (!acquired) {
    return {
      rows: [],
      timing: createPlayerMirrorSqlTiming({
        pool_acquire_ms: 0,
        query_exec_ms: 0,
        total_ms: Date.now() - totalStartedAt,
      }),
    };
  }
  const { client, timing: acquireTiming } = acquired;
  try {
    const queryStartedAt = Date.now();
    const result = await client.query(sql, params);
    const query_exec_ms = Date.now() - queryStartedAt;
    return {
      rows: result.rows as T[],
      timing: createPlayerMirrorSqlTiming({
        pool_acquire_ms: acquireTiming.pool_acquire_ms,
        query_exec_ms,
        total_ms: Date.now() - totalStartedAt,
      }),
    };
  } finally {
    client.release();
  }
}

export type SqlRoutePoolSummary = {
  route: string;
  context?: string;
  query_count: number;
  connection_reused: boolean;
  pool_acquire_ms: number;
  route_total_ms: number;
  pool_totalCount: number;
  pool_idleCount: number;
  pool_waitingCount: number;
  pool_max: number;
};

export function logSqlRoutePoolSummary(summary: SqlRoutePoolSummary) {
  const shouldLog =
    process.env.SQL_POOL_DEBUG === '1' ||
    summary.query_count > 1 ||
    summary.pool_acquire_ms >= 50 ||
    summary.pool_waitingCount > 0;
  if (!shouldLog) {
    return;
  }
  console.info('[SQL_ROUTE_POOL]', summary);
}

export type PlayerMirrorClientScope = {
  route: string;
  context?: string;
  request_id?: string;
};

export async function withPlayerMirrorClient<T>(
  scope: PlayerMirrorClientScope,
  run: (client: PoolClient, trackQuery: () => void) => Promise<T>
): Promise<{ result: T | null; summary: SqlRoutePoolSummary | null }> {
  const routeStartedAt = Date.now();
  const acquired = await acquirePlayerMirrorClient({
    context: scope.context || 'route_scope',
    route: scope.route,
    request_id: scope.request_id,
  });
  if (!acquired) {
    return { result: null, summary: null };
  }

  let queryCount = 0;
  const trackQuery = () => {
    queryCount += 1;
  };
  const { client, timing } = acquired;
  const pool = getPlayerMirrorPool();
  try {
    const result = await run(client, trackQuery);
    const summary: SqlRoutePoolSummary = {
      route: scope.route,
      context: scope.context,
      query_count: queryCount,
      connection_reused: queryCount > 1,
      pool_acquire_ms: timing.pool_acquire_ms,
      route_total_ms: Date.now() - routeStartedAt,
      pool_totalCount: pool?.totalCount ?? 0,
      pool_idleCount: pool?.idleCount ?? 0,
      pool_waitingCount: pool?.waitingCount ?? 0,
      pool_max: PLAYER_MIRROR_POOL_MAX,
    };
    logSqlRoutePoolSummary(summary);
    return { result, summary };
  } finally {
    client.release();
  }
}

export async function acquirePlayerMirrorClient(
  acquireContext?: PlayerMirrorAcquireContext
): Promise<{
  client: PoolClient;
  timing: PlayerMirrorSqlTiming;
} | null> {
  const pool = getPlayerMirrorPool();
  if (!pool) {
    return null;
  }
  const totalStartedAt = Date.now();
  const statsBefore = {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
  const acquireStartedAt = Date.now();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    console.warn('[SQL_POOL_CONNECT_FAILED]', {
      name: 'playerMirror',
      context: acquireContext?.context ?? 'unspecified',
      route: acquireContext?.route ?? null,
      request_id: acquireContext?.request_id ?? null,
      code: error && typeof error === 'object' ? (error as { code?: string }).code || null : null,
      message: error instanceof Error ? error.message : String(error),
      pool_exhausted: isPgPoolExhaustedError(error),
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      max: PLAYER_MIRROR_POOL_MAX,
      idle_before: statsBefore.idleCount,
      waiting_before: statsBefore.waitingCount,
    });
    if (isPgPoolExhaustedError(error)) {
      console.warn('[SQL_POOL_EXHAUSTED]', {
        name: 'playerMirror',
        context: acquireContext?.context ?? 'unspecified',
        route: acquireContext?.route ?? null,
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
        max: PLAYER_MIRROR_POOL_MAX,
      });
    }
    throw error;
  }
  const pool_acquire_ms = Date.now() - acquireStartedAt;
  logSqlPoolAcquire(pool, pool_acquire_ms, statsBefore, acquireContext);
  return {
    client,
    timing: createPlayerMirrorSqlTiming({
      pool_acquire_ms,
      query_exec_ms: 0,
      total_ms: Date.now() - totalStartedAt,
    }),
  };
}

export function logPlayerMirrorSqlTiming(label: string, timing: PlayerMirrorSqlTiming) {
  console.info('[SQL_MIRROR_TIMING] %s', label, timing);
}

type Cache = { connectionString: string; pool: Pool };
const globalSqlPool = globalThis as typeof globalThis & {
  __appbegPlayerRegistrationMirrorPool?: Cache;
};

export function isPgConnectionTimeoutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  const lower = message.toLowerCase();
  return (
    lower.includes('timeout exceeded when trying to connect') ||
    lower.includes('connection timeout') ||
    lower.includes('timeout expired') ||
    lower.includes('etimedout')
  );
}

export function isPgPoolExhaustedError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const pg = error as { code?: string; message?: string };
  const lower = String(pg.message || '').toLowerCase();
  return (
    pg.code === '53300' ||
    lower.includes('too many clients') ||
    lower.includes('remaining connection slots are reserved')
  );
}

export type PlayerMirrorPoolStats = {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  max: number;
};

export function getPlayerMirrorPoolStats(): PlayerMirrorPoolStats | null {
  const pool = globalSqlPool.__appbegPlayerRegistrationMirrorPool?.pool;
  if (!pool) {
    return null;
  }
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    max: PLAYER_MIRROR_POOL_MAX,
  };
}

export function logPlayerMirrorPoolStats(context: string) {
  const stats = getPlayerMirrorPoolStats();
  if (!stats) {
    console.info('[SQL_POOL] stats unavailable', { name: 'playerMirror', context });
    return;
  }
  console.info('[SQL_POOL] stats', {
    name: 'playerMirror',
    context,
    ...stats,
  });
}

function logSqlPoolAudit() {
  console.info('[SQL_POOL_AUDIT] known_pools', {
    playerMirror: {
      scope: 'carerTasksCache,liveOutbox,playerGameRequestsCache,playersCache,playerSessionsCache,...',
      shared: true,
      max: PLAYER_MIRROR_POOL_MAX,
      env: 'PG_POOL_MAX',
    },
    gameLoginsCache: {
      scope: 'game_logins_cache reads/writes',
      shared: true,
      uses: 'playerMirror',
    },
    automationJobsCache: { scope: 'automation_jobs_cache', shared: true, uses: 'playerMirror' },
    coadminBonusSettingsCache: {
      scope: 'coadmin_bonus_settings_cache',
      shared: true,
      uses: 'playerMirror',
    },
    note: 'carerTasksCache uses playerMirror; separate pools also hit DATABASE_URL under burst load',
    vercel_pgbouncer:
      'On Vercel/serverless prefer DATABASE_URL with ?pgbouncer=true and transaction pool mode; avoid holding clients across awaits/SSE; keep max pool modest per instance',
  });
}

export function cleanText(value: unknown) {
  return String(value || '').trim();
}

export function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'object') {
    const maybe = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof maybe.toDate === 'function') return maybe.toDate();
    if (typeof maybe.toMillis === 'function') return new Date(maybe.toMillis());
    if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000);
    if (typeof maybe._seconds === 'number') return new Date(maybe._seconds * 1000);
  }
  return null;
}

export function toIsoString(value: unknown): string | null {
  return toDate(value)?.toISOString() || null;
}

export function normalizeJson(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        normalizeJson(child),
      ])
    );
  }
  return value;
}

export type PlayerMirrorPoolTiming = {
  sql_pool_ms: number;
  poolReused: boolean | null;
};

export function getPlayerMirrorPool(poolTiming?: PlayerMirrorPoolTiming) {
  const poolStartedAt = Date.now();
  const connectionString = cleanText(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (!connectionString) return null;
  if (globalSqlPool.__appbegPlayerRegistrationMirrorPool?.connectionString === connectionString) {
    if (poolTiming) {
      poolTiming.sql_pool_ms = Date.now() - poolStartedAt;
      poolTiming.poolReused = true;
    }
    if (process.env.SQL_POOL_DEBUG === '1') {
      console.info('[SQL_POOL] reused', { name: 'playerMirror' });
    }
    return globalSqlPool.__appbegPlayerRegistrationMirrorPool.pool;
  }
  const pool = new Pool({
    connectionString,
    max: PLAYER_MIRROR_POOL_MAX,
    min: 0,
    connectionTimeoutMillis: SQL_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: PLAYER_MIRROR_IDLE_TIMEOUT_MS,
    query_timeout: SQL_STATEMENT_TIMEOUT_MS,
    statement_timeout: SQL_STATEMENT_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    console.warn('[SQL_POOL] idle client error', { name: 'playerMirror', error });
    if (isPgConnectionTimeoutError(error) || isPgPoolExhaustedError(error)) {
      logPlayerMirrorPoolStats('playerMirror_idle_client_error');
    }
  });
  globalSqlPool.__appbegPlayerRegistrationMirrorPool = { connectionString, pool };
  if (poolTiming) {
    poolTiming.sql_pool_ms = Date.now() - poolStartedAt;
    poolTiming.poolReused = false;
  }
  console.info('[SQL_POOL] created', {
    name: 'playerMirror',
    max: PLAYER_MIRROR_POOL_MAX,
    idleTimeoutMillis: PLAYER_MIRROR_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: SQL_CONNECTION_TIMEOUT_MS,
    statementTimeoutMillis: SQL_STATEMENT_TIMEOUT_MS,
  });
  logSqlPoolAudit();
  void warmPlayerMirrorPool('pool_created');
  return pool;
}
