import 'server-only';

import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { PoolClient } from 'pg';

import { adminDb } from '@/lib/firebase/admin';
import {
  firestoreErrorCode,
  isFirestoreQuotaExhausted,
  logCarerStartupFirestore,
} from '@/lib/firestore/quota';
import { type CachedGameLogin } from '@/lib/sql/gameLoginsCache';
import { readGameLoginsCacheByCoadminWithClient } from '@/lib/sql/gameLoginsCache';
import {
  type CachedPlayerGameLogin,
  readPlayerGameLoginsCacheByCoadminWithClient,
} from '@/lib/sql/playerGameLoginsCache';
import {
  acquirePlayerMirrorClient,
  cleanText,
  getPlayerMirrorPool,
  getPlayerMirrorPoolStats,
  type PlayerMirrorPoolStats,
} from '@/lib/sql/playerMirrorCommon';
import {
  type CachedPlayer,
  readPlayersCacheByCoadminWithClient,
} from '@/lib/sql/playersCache';

export type CarerBaseDataSqlTiming = {
  shared_client: boolean;
  parallel: boolean;
  client_acquire_ms: number;
  players_ms: number;
  game_logins_ms: number;
  player_game_logins_ms: number;
  total_sql_ms: number;
  pool_waiting_max: number;
  total_ms: number;
};

export type CarerBaseDataPayload = {
  players: CachedPlayer[];
  gameLogins: CachedGameLogin[];
  playerGameLogins: CachedPlayerGameLogin[];
  source: 'postgres' | 'fallback';
  snapshotAt: string;
  timing: CarerBaseDataSqlTiming;
};

type CarerBaseDataMode = 'parallel' | 'sequential';
type CarerBaseDataModeReason =
  | 'warm_pool'
  | 'cold_pool'
  | 'low_idle'
  | 'waiting'
  | 'env_always'
  | 'env_never';

type ParallelReadTiming = {
  ms: number;
  pool_acquire_ms: number;
};

type ParallelReadResult<T> =
  | { ok: true; value: T; timing: ParallelReadTiming }
  | { ok: false; error: unknown; timing: ParallelReadTiming };

type CarerBaseDataSqlResult = {
  sqlPlayers: CachedPlayer[];
  sqlGameLogins: CachedGameLogin[];
  sqlPlayerGameLogins: CachedPlayerGameLogin[];
  hardSqlFailure: boolean;
  timing: Pick<
    CarerBaseDataSqlTiming,
    | 'players_ms'
    | 'game_logins_ms'
    | 'player_game_logins_ms'
    | 'total_sql_ms'
    | 'client_acquire_ms'
    | 'pool_waiting_max'
    | 'shared_client'
    | 'parallel'
  >;
};

const CARER_BASE_DATA_ROUTE = '/api/carer/base-data';
const CARER_BASE_DATA_PARALLEL_MIN_IDLE = 4;
const CARER_BASE_DATA_PARALLEL_MIN_TOTAL = 4;

function resolveCarerBaseDataParallelMode(stats: PlayerMirrorPoolStats | null): {
  mode: CarerBaseDataMode;
  reason: CarerBaseDataModeReason;
} {
  const env = cleanText(process.env.CARER_BASE_DATA_PARALLEL || 'auto').toLowerCase();
  if (env === 'always') {
    return { mode: 'parallel', reason: 'env_always' };
  }
  if (env === 'never') {
    return { mode: 'sequential', reason: 'env_never' };
  }

  if (!stats) {
    return { mode: 'sequential', reason: 'cold_pool' };
  }
  if (stats.waitingCount > 0) {
    return { mode: 'sequential', reason: 'waiting' };
  }
  if (stats.idleCount < CARER_BASE_DATA_PARALLEL_MIN_IDLE) {
    return { mode: 'sequential', reason: 'low_idle' };
  }
  if (stats.totalCount < CARER_BASE_DATA_PARALLEL_MIN_TOTAL) {
    return { mode: 'sequential', reason: 'cold_pool' };
  }

  return { mode: 'parallel', reason: 'warm_pool' };
}

function logCarerBaseDataMode(
  mode: CarerBaseDataMode,
  reason: CarerBaseDataModeReason,
  stats: PlayerMirrorPoolStats | null
) {
  console.info('[CARER_BASE_DATA_MODE]', {
    mode,
    reason,
    totalCount: stats?.totalCount ?? 0,
    idleCount: stats?.idleCount ?? 0,
    waitingCount: stats?.waitingCount ?? 0,
    max: stats?.max ?? 0,
  });
}

async function withParallelCarerMirrorRead<T>(
  context: string,
  trackWaiting: () => void,
  read: (client: PoolClient) => Promise<T>
): Promise<ParallelReadResult<T>> {
  const startedAt = Date.now();
  trackWaiting();
  const acquired = await acquirePlayerMirrorClient({
    context,
    route: CARER_BASE_DATA_ROUTE,
  });
  trackWaiting();

  if (!acquired) {
    return {
      ok: false,
      error: new Error('postgres_unavailable'),
      timing: {
        ms: Date.now() - startedAt,
        pool_acquire_ms: 0,
      },
    };
  }

  try {
    const value = await read(acquired.client);
    return {
      ok: true,
      value,
      timing: {
        ms: Date.now() - startedAt,
        pool_acquire_ms: acquired.timing.pool_acquire_ms,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error,
      timing: {
        ms: Date.now() - startedAt,
        pool_acquire_ms: acquired.timing.pool_acquire_ms,
      },
    };
  } finally {
    acquired.client.release();
  }
}

function firestoreIsoString(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number };
  if (typeof maybe.toDate === 'function') return maybe.toDate().toISOString();
  if (typeof maybe.toMillis === 'function') return new Date(maybe.toMillis()).toISOString();
  if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000).toISOString();
  return null;
}

function mapFirestorePlayer(
  docSnap: QueryDocumentSnapshot,
  requestedCoadminUid: string
): CachedPlayer | null {
  const data = docSnap.data() as Record<string, unknown>;
  const role = cleanText(data.role);
  const status = (cleanText(data.status) || 'active') as 'active' | 'disabled';
  if (role !== 'player' || status === 'disabled') {
    return null;
  }

  const createdBy = cleanText(data.createdBy) || null;
  const storedCoadminUid = cleanText(data.coadminUid) || null;
  const coadminUid =
    storedCoadminUid ||
    (createdBy === requestedCoadminUid ? requestedCoadminUid : null) ||
    undefined;

  return {
    id: docSnap.id,
    uid: docSnap.id,
    username: cleanText(data.username),
    email: cleanText(data.email),
    role: 'player',
    status,
    createdBy,
    coadminUid,
    coin: typeof data.coin === 'number' ? data.coin : undefined,
    cash: typeof data.cash === 'number' ? data.cash : undefined,
    createdAt: firestoreIsoString(data.createdAt),
  };
}

async function readFirestorePlayersByCoadmin(coadminUid: string): Promise<CachedPlayer[]> {
  const [scopedSnapshot, legacySnapshot] = await Promise.all([
    adminDb
      .collection('users')
      .where('role', '==', 'player')
      .where('coadminUid', '==', coadminUid)
      .get(),
    adminDb
      .collection('users')
      .where('role', '==', 'player')
      .where('createdBy', '==', coadminUid)
      .get(),
  ]);

  return Array.from(
    new Map(
      [...scopedSnapshot.docs, ...legacySnapshot.docs]
        .map((docSnap) => mapFirestorePlayer(docSnap, coadminUid))
        .filter((player): player is CachedPlayer => Boolean(player))
        .map((player) => [player.id, player])
    ).values()
  );
}

function mapFirestoreGameLogin(docSnap: QueryDocumentSnapshot): CachedGameLogin {
  const data = docSnap.data() as Record<string, unknown>;
  return {
    id: docSnap.id,
    gameName: cleanText(data.gameName),
    username: cleanText(data.username),
    password: String(data.password || ''),
    backendUrl: cleanText(data.backendUrl),
    frontendUrl: cleanText(data.frontendUrl),
    siteUrl: cleanText(data.siteUrl || data.backendUrl),
    createdBy: cleanText(data.createdBy),
    coadminUid: cleanText(data.coadminUid) || undefined,
    createdAt: firestoreIsoString(data.createdAt),
    status: cleanText(data.status) || 'active',
  };
}

async function readFirestoreGameLoginsByField(
  field: 'coadminUid' | 'createdBy',
  value: string
): Promise<CachedGameLogin[]> {
  const snapshot = await adminDb.collection('gameLogins').where(field, '==', value).get();
  return snapshot.docs.map(mapFirestoreGameLogin);
}

async function readFirestoreGameLoginsByCoadmin(coadminUid: string): Promise<CachedGameLogin[]> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    readFirestoreGameLoginsByField('coadminUid', coadminUid),
    readFirestoreGameLoginsByField('createdBy', coadminUid),
  ]);

  return Array.from(
    new Map(
      [...coadminOwned, ...legacyOwned].map((gameLogin) => [gameLogin.id, gameLogin])
    ).values()
  );
}

function mapFirestorePlayerGameLogin(
  docSnap: QueryDocumentSnapshot,
  requestedCoadminUid: string
): CachedPlayerGameLogin | null {
  const data = docSnap.data() as Record<string, unknown>;
  const createdBy = cleanText(data.createdBy) || requestedCoadminUid;
  const coadminUid = cleanText(data.coadminUid) || createdBy;
  const playerUid = cleanText(data.playerUid);
  const gameName = cleanText(data.gameName);

  if (!playerUid || !gameName || !coadminUid || !createdBy) {
    return null;
  }

  return {
    id: docSnap.id,
    playerUid,
    playerUsername: cleanText(data.playerUsername),
    gameName,
    gameUsername: cleanText(data.gameUsername),
    gamePassword: String(data.gamePassword || ''),
    frontendUrl: cleanText(data.frontendUrl) || undefined,
    siteUrl: cleanText(data.siteUrl) || undefined,
    coadminUid,
    createdBy,
    createdAt: firestoreIsoString(data.createdAt),
  };
}

async function readFirestorePlayerGameLoginsByField(
  field: 'coadminUid' | 'createdBy',
  value: string,
  requestedCoadminUid: string
): Promise<CachedPlayerGameLogin[]> {
  const snapshot = await adminDb.collection('playerGameLogins').where(field, '==', value).get();
  return snapshot.docs
    .map((docSnap) => mapFirestorePlayerGameLogin(docSnap, requestedCoadminUid))
    .filter((login): login is CachedPlayerGameLogin => Boolean(login));
}

async function readFirestorePlayerGameLoginsByCoadmin(
  coadminUid: string
): Promise<CachedPlayerGameLogin[]> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    readFirestorePlayerGameLoginsByField('coadminUid', coadminUid, coadminUid),
    readFirestorePlayerGameLoginsByField('createdBy', coadminUid, coadminUid),
  ]);

  return Array.from(
    new Map(
      [...coadminOwned, ...legacyOwned].map((login) => [login.id, login])
    ).values()
  );
}

async function readCarerBaseDataFirestoreFallback(coadminUid: string) {
  const [players, gameLogins, playerGameLogins] = await Promise.all([
    readFirestorePlayersByCoadmin(coadminUid),
    readFirestoreGameLoginsByCoadmin(coadminUid),
    readFirestorePlayerGameLoginsByCoadmin(coadminUid),
  ]);
  return { players, gameLogins, playerGameLogins };
}

async function readCarerBaseDataFirestoreFallbackSafe(coadminUid: string, reason: string) {
  const startedAt = Date.now();
  const path = `coadmin/${coadminUid}/base-data`;
  try {
    const fallback = await readCarerBaseDataFirestoreFallback(coadminUid);
    logCarerStartupFirestore({
      collection: 'users,gameLogins,playerGameLogins',
      path,
      reason,
      durationMs: Date.now() - startedAt,
      ok: true,
    });
    return { ...fallback, usedFallback: true as const, quotaExhausted: false as const };
  } catch (error) {
    logCarerStartupFirestore({
      collection: 'users,gameLogins,playerGameLogins',
      path,
      reason,
      durationMs: Date.now() - startedAt,
      ok: false,
      error_code: firestoreErrorCode(error) || 'firestore_fallback_failed',
    });
    if (isFirestoreQuotaExhausted(error)) {
      return {
        players: [] as CachedPlayer[],
        gameLogins: [] as CachedGameLogin[],
        playerGameLogins: [] as CachedPlayerGameLogin[],
        usedFallback: false as const,
        quotaExhausted: true as const,
      };
    }
    throw error;
  }
}

async function resolveCarerBaseDataFromSql(
  _coadminUid: string,
  sqlResult: CarerBaseDataSqlResult
): Promise<{
  players: CachedPlayer[];
  gameLogins: CachedGameLogin[];
  playerGameLogins: CachedPlayerGameLogin[];
  usedFallback: boolean;
}> {
  return {
    players: sqlResult.sqlPlayers,
    gameLogins: sqlResult.sqlGameLogins,
    playerGameLogins: sqlResult.sqlPlayerGameLogins,
    usedFallback: false,
  };
}

async function loadCarerBaseDataSequentialSql(
  coadminUid: string
): Promise<CarerBaseDataSqlResult> {
  const sqlStartedAt = Date.now();
  const acquired = await acquirePlayerMirrorClient({
    context: 'carer_base_data',
    route: CARER_BASE_DATA_ROUTE,
  });

  if (!acquired) {
    return {
      sqlPlayers: [],
      sqlGameLogins: [],
      sqlPlayerGameLogins: [],
      hardSqlFailure: true,
      timing: {
        shared_client: false,
        parallel: false,
        players_ms: 0,
        game_logins_ms: 0,
        player_game_logins_ms: 0,
        total_sql_ms: Date.now() - sqlStartedAt,
        client_acquire_ms: 0,
        pool_waiting_max: 0,
      },
    };
  }

  const { client } = acquired;
  let sqlPlayers: CachedPlayer[] = [];
  let sqlGameLogins: CachedGameLogin[] = [];
  let sqlPlayerGameLogins: CachedPlayerGameLogin[] = [];
  let playersMs = 0;
  let gameLoginsMs = 0;
  let playerGameLoginsMs = 0;

  try {
    const playersStartedAt = Date.now();
    sqlPlayers = await readPlayersCacheByCoadminWithClient(client, coadminUid);
    playersMs = Date.now() - playersStartedAt;

    const gameLoginsStartedAt = Date.now();
    sqlGameLogins = await readGameLoginsCacheByCoadminWithClient(client, coadminUid);
    gameLoginsMs = Date.now() - gameLoginsStartedAt;

    const playerGameLoginsStartedAt = Date.now();
    sqlPlayerGameLogins = await readPlayerGameLoginsCacheByCoadminWithClient(client, coadminUid);
    playerGameLoginsMs = Date.now() - playerGameLoginsStartedAt;
  } catch (error) {
    console.warn('[CARER_BASE_DATA] sequential postgres read failed', {
      coadminUid,
      error,
    });
    return {
      sqlPlayers: [],
      sqlGameLogins: [],
      sqlPlayerGameLogins: [],
      hardSqlFailure: true,
      timing: {
        shared_client: true,
        parallel: false,
        players_ms: playersMs,
        game_logins_ms: gameLoginsMs,
        player_game_logins_ms: playerGameLoginsMs,
        total_sql_ms: Date.now() - sqlStartedAt,
        client_acquire_ms: acquired.timing.pool_acquire_ms,
        pool_waiting_max: 0,
      },
    };
  } finally {
    client.release();
  }

  return {
    sqlPlayers,
    sqlGameLogins,
    sqlPlayerGameLogins,
    hardSqlFailure: false,
    timing: {
      shared_client: true,
      parallel: false,
      players_ms: playersMs,
      game_logins_ms: gameLoginsMs,
      player_game_logins_ms: playerGameLoginsMs,
      total_sql_ms: Date.now() - sqlStartedAt,
      client_acquire_ms: acquired.timing.pool_acquire_ms,
      pool_waiting_max: 0,
    },
  };
}

async function loadCarerBaseDataParallelSql(coadminUid: string): Promise<CarerBaseDataSqlResult> {
  const sqlStartedAt = Date.now();
  const waitingTracker = { max: 0 };
  const trackWaiting = () => {
    const pool = getPlayerMirrorPool();
    if (pool) {
      waitingTracker.max = Math.max(waitingTracker.max, pool.waitingCount);
    }
  };

  const parallelReads: [
    Promise<ParallelReadResult<CachedPlayer[]>>,
    Promise<ParallelReadResult<CachedGameLogin[]>>,
    Promise<ParallelReadResult<CachedPlayerGameLogin[]>>,
  ] = [
    withParallelCarerMirrorRead('carer_base_data_players', trackWaiting, (client) =>
      readPlayersCacheByCoadminWithClient(client, coadminUid)
    ),
    withParallelCarerMirrorRead('carer_base_data_game_logins', trackWaiting, (client) =>
      readGameLoginsCacheByCoadminWithClient(client, coadminUid)
    ),
    withParallelCarerMirrorRead('carer_base_data_player_game_logins', trackWaiting, (client) =>
      readPlayerGameLoginsCacheByCoadminWithClient(client, coadminUid)
    ),
  ];

  const [playersPack, gameLoginsPack, playerGameLoginsPack] = await Promise.all(parallelReads);

  return {
    sqlPlayers: playersPack.ok ? playersPack.value : [],
    sqlGameLogins: gameLoginsPack.ok ? gameLoginsPack.value : [],
    sqlPlayerGameLogins: playerGameLoginsPack.ok ? playerGameLoginsPack.value : [],
    hardSqlFailure: !playersPack.ok || !gameLoginsPack.ok || !playerGameLoginsPack.ok,
    timing: {
      shared_client: false,
      parallel: true,
      players_ms: playersPack.timing.ms,
      game_logins_ms: gameLoginsPack.timing.ms,
      player_game_logins_ms: playerGameLoginsPack.timing.ms,
      total_sql_ms: Date.now() - sqlStartedAt,
      client_acquire_ms: Math.max(
        playersPack.timing.pool_acquire_ms,
        gameLoginsPack.timing.pool_acquire_ms,
        playerGameLoginsPack.timing.pool_acquire_ms
      ),
      pool_waiting_max: waitingTracker.max,
    },
  };
}

export async function readCarerBaseDataForCoadmin(
  coadminUid: string
): Promise<CarerBaseDataPayload> {
  const totalStartedAt = Date.now();
  const cleanCoadminUid = cleanText(coadminUid);
  const snapshotAt = new Date().toISOString();
  const pool = getPlayerMirrorPool();
  const poolStats = getPlayerMirrorPoolStats();
  const modeSelection = resolveCarerBaseDataParallelMode(poolStats);
  logCarerBaseDataMode(modeSelection.mode, modeSelection.reason, poolStats);

  const timing: CarerBaseDataSqlTiming = {
    shared_client: modeSelection.mode === 'sequential',
    parallel: modeSelection.mode === 'parallel',
    client_acquire_ms: 0,
    players_ms: 0,
    game_logins_ms: 0,
    player_game_logins_ms: 0,
    total_sql_ms: 0,
    pool_waiting_max: 0,
    total_ms: 0,
  };

  if (!pool) {
    const fallback = await readCarerBaseDataFirestoreFallbackSafe(
      cleanCoadminUid,
      'postgres_pool_unavailable'
    );
    timing.total_ms = Date.now() - totalStartedAt;
    return {
      players: fallback.players,
      gameLogins: fallback.gameLogins,
      playerGameLogins: fallback.playerGameLogins,
      source: fallback.quotaExhausted ? 'postgres' : fallback.usedFallback ? 'fallback' : 'postgres',
      snapshotAt,
      timing,
    };
  }

  const sqlResult =
    modeSelection.mode === 'parallel'
      ? await loadCarerBaseDataParallelSql(cleanCoadminUid)
      : await loadCarerBaseDataSequentialSql(cleanCoadminUid);

  timing.shared_client = sqlResult.timing.shared_client;
  timing.parallel = sqlResult.timing.parallel;
  timing.client_acquire_ms = sqlResult.timing.client_acquire_ms;
  timing.players_ms = sqlResult.timing.players_ms;
  timing.game_logins_ms = sqlResult.timing.game_logins_ms;
  timing.player_game_logins_ms = sqlResult.timing.player_game_logins_ms;
  timing.total_sql_ms = sqlResult.timing.total_sql_ms;
  timing.pool_waiting_max = sqlResult.timing.pool_waiting_max;

  let players: CachedPlayer[] = [];
  let gameLogins: CachedGameLogin[] = [];
  let playerGameLogins: CachedPlayerGameLogin[] = [];
  let usedFallback = false;

  if (sqlResult.hardSqlFailure) {
    console.warn('[CARER_BASE_DATA] sql read failed, using firestore fallback', {
      coadminUid: cleanCoadminUid,
      mode: modeSelection.mode,
      reason: modeSelection.reason,
    });
    const fallback = await readCarerBaseDataFirestoreFallbackSafe(
      cleanCoadminUid,
      'hard_sql_failure'
    );
    players = fallback.players;
    gameLogins = fallback.gameLogins;
    playerGameLogins = fallback.playerGameLogins;
    usedFallback = fallback.usedFallback;
  } else {
    const resolved = await resolveCarerBaseDataFromSql(cleanCoadminUid, sqlResult);
    players = resolved.players;
    gameLogins = resolved.gameLogins;
    playerGameLogins = resolved.playerGameLogins;
    usedFallback = resolved.usedFallback;
  }

  timing.total_ms = Date.now() - totalStartedAt;
  const source = usedFallback ? 'fallback' : 'postgres';

  if (modeSelection.mode === 'parallel') {
    console.info('[CARER_BASE_DATA_PARALLEL]', {
      parallel: true,
      players_ms: timing.players_ms,
      game_logins_ms: timing.game_logins_ms,
      player_game_logins_ms: timing.player_game_logins_ms,
      total_sql_ms: timing.total_sql_ms,
      total_ms: timing.total_ms,
      pool_waiting_max: timing.pool_waiting_max,
      source,
    });
  }

  return {
    players,
    gameLogins,
    playerGameLogins,
    source,
    snapshotAt,
    timing,
  };
}
