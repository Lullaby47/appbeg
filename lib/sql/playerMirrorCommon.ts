import 'server-only';

import { Pool, type PoolClient } from 'pg';

const SQL_TIMEOUT_MS = 5_000;
/** Keep idle connections longer so remote VPS snapshots avoid repeated TLS handshakes. */
const PLAYER_MIRROR_IDLE_TIMEOUT_MS = 120_000;

function resolvePlayerMirrorPoolMax() {
  const fromEnv = Number(process.env.PLAYER_MIRROR_POOL_MAX || 12);
  if (!Number.isFinite(fromEnv)) {
    return 12;
  }
  return Math.min(32, Math.max(4, Math.trunc(fromEnv)));
}

const PLAYER_MIRROR_POOL_MAX = resolvePlayerMirrorPoolMax();

function resolvePlayerMirrorPoolWarmMin() {
  const fromEnv = Number(process.env.PLAYER_MIRROR_POOL_WARM_MIN || 2);
  if (!Number.isFinite(fromEnv)) {
    return 2;
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
    acquireMs >= 10 ||
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
  console.info('[SQL_POOL_ACQUIRE]', {
    name: 'playerMirror',
    context: acquireContext?.context ?? 'unspecified',
    acquire_ms: acquireMs,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    max: PLAYER_MIRROR_POOL_MAX,
    request_id: acquireContext?.request_id ?? null,
    route: acquireContext?.route ?? null,
    idle_before: statsBefore.idleCount,
    waiting_before: statsBefore.waitingCount,
  });
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
  const client = await pool.connect();
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
    },
    gameLoginsCache: { scope: 'game_logins_cache reads/writes', shared: false, max: 4 },
    automationJobsCache: { scope: 'automation_jobs_cache', shared: false, defaultMax: 10 },
    coadminBonusSettingsCache: { scope: 'coadmin_bonus_settings_cache', shared: false, defaultMax: 10 },
    note: 'carerTasksCache uses playerMirror; separate pools also hit DATABASE_URL under burst load',
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
    min: 1,
    connectionTimeoutMillis: SQL_TIMEOUT_MS,
    idleTimeoutMillis: PLAYER_MIRROR_IDLE_TIMEOUT_MS,
    query_timeout: SQL_TIMEOUT_MS,
    statement_timeout: SQL_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    console.warn('[SQL_POOL] idle client error', { name: 'playerMirror', error });
    if (isPgConnectionTimeoutError(error)) {
      logPlayerMirrorPoolStats('playerMirror_idle_client_error');
    }
  });
  globalSqlPool.__appbegPlayerRegistrationMirrorPool = { connectionString, pool };
  if (poolTiming) {
    poolTiming.sql_pool_ms = Date.now() - poolStartedAt;
    poolTiming.poolReused = false;
  }
  console.info('[SQL_POOL] created', { name: 'playerMirror', max: PLAYER_MIRROR_POOL_MAX });
  logSqlPoolAudit();
  void warmPlayerMirrorPool('pool_created');
  return pool;
}
