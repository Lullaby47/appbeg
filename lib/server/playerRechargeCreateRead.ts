import 'server-only';

import { adminDb } from '@/lib/firebase/admin';
import {
  findRequestLinkedGameCredential,
  type RequestLinkedGameCredential,
} from '@/lib/games/requestLinkedCarerTask';
import {
  readGameLoginCacheForCoadminGame,
  readGameLoginsCacheByCoadmin,
  type CachedGameLogin,
} from '@/lib/sql/gameLoginsCache';
import {
  readPlayerGameLoginsCacheByPlayer,
  type PlayerGameLoginByPlayerRow,
} from '@/lib/sql/playerGameLoginsCache';
import {
  hasFirstRechargeMatchAppliedFromSql,
} from '@/lib/sql/playerGameRequestsCache';
import {
  cleanText,
  getPlayerMirrorPool,
  runMirrorPoolQuery,
} from '@/lib/sql/playerMirrorCommon';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import {
  isRechargeFirestoreQuotaError,
  logRechargeSqlSource,
  timedRechargeFirestoreRead,
} from '@/lib/server/rechargeFirestoreInstrumentation';

function blockRechargeFirestoreFallback() {
  return isAuthoritySqlWriteEnabled();
}

export type RechargeReadSource = 'postgres' | 'firestore';

export type RechargePlayerGameLoginsRead = {
  assignedGameUsername: string;
  source: RechargeReadSource;
  sqlMs: number;
  firestoreFallbackMs: number;
};

export type RechargeGameLoginsRead = {
  gameCredential: RequestLinkedGameCredential | null;
  source: RechargeReadSource;
  sqlMs: number;
  firestoreFallbackMs: number;
};

export type RechargeFirstRechargeRead = {
  hasAnyFirstRechargeAppliedRequest: boolean;
  source: RechargeReadSource;
  sqlMs: number;
  firestoreFallbackMs: number;
};

export type RechargePreTransactionReads = {
  playerGameLogins: RechargePlayerGameLoginsRead;
  gameLogins: RechargeGameLoginsRead;
  firstRecharge: RechargeFirstRechargeRead;
  playerAuthority: RechargePlayerAuthorityRead | null;
  sharedSqlClient: boolean;
};

export type RechargePlayerAuthorityRead = {
  source: 'postgres';
  coin: number;
  role: string;
  status: string;
  username: string;
  coadminUid: string;
  firstRechargeMatchUsed: boolean;
  sqlMs: number;
};

function fieldFromRawFirestore(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return cleanText((raw as Record<string, unknown>)[field]);
}

function boolFromRawFirestore(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const value = (raw as Record<string, unknown>)[field];
  return value === true;
}

async function loadRechargePlayerAuthorityFromSql(
  playerUid: string
): Promise<RechargePlayerAuthorityRead | null> {
  const startedAt = Date.now();
  const cleanUid = cleanText(playerUid);
  const pool = getPlayerMirrorPool();
  if (!cleanUid || !pool) {
    return null;
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      pool,
      `
        SELECT uid, username, role, status, coin, coadmin_uid, created_by, raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [cleanUid]
    );
    const row = rows[0];
    if (!row) {
      return null;
    }

    const raw = row.raw_firestore_data;
    return {
      source: 'postgres',
      coin: Number(row.coin || 0),
      role: cleanText(row.role).toLowerCase(),
      status: (cleanText(row.status) || 'active').toLowerCase(),
      username: cleanText(row.username) || 'Player',
      coadminUid:
        cleanText(row.coadmin_uid) ||
        cleanText(row.created_by) ||
        fieldFromRawFirestore(raw, 'coadminUid') ||
        '',
      firstRechargeMatchUsed: boolFromRawFirestore(raw, 'firstRechargeMatchUsed'),
      sqlMs: Date.now() - startedAt,
    };
  } catch (error) {
    console.warn('[PLAYER_RECHARGE_CREATE_READ] player authority sql failed', {
      playerUid: cleanUid,
      error,
    });
    return null;
  }
}

function normalizeGameName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function findAssignedGameUsername(
  rows: Array<{ gameName?: string; gameUsername?: string }>,
  normalizedGame: string
) {
  const assignedLogin = rows.find((row) => {
    return (
      normalizeGameName(String(row.gameName || '')) === normalizedGame &&
      String(row.gameUsername || '').trim().length > 0
    );
  });
  return String(assignedLogin?.gameUsername || '').trim();
}

function mapCachedGameLoginToCredential(row: CachedGameLogin): RequestLinkedGameCredential {
  return {
    id: row.id,
    gameName: row.gameName,
    username: row.username,
    password: row.password,
    backendUrl: row.backendUrl,
    frontendUrl: row.frontendUrl,
    siteUrl: row.siteUrl,
  };
}

async function loadPlayerGameLoginsFromFirestore(
  playerUid: string,
  normalizedGame: string,
  sqlMs: number
): Promise<RechargePlayerGameLoginsRead> {
  const firestoreStartedAt = Date.now();
  const loginSnap = await timedRechargeFirestoreRead(
    {
      stage: 'pre_transaction_player_game_logins',
      collection: 'playerGameLogins',
      document: `playerUid=${playerUid}`,
    },
    () => adminDb.collection('playerGameLogins').where('playerUid', '==', playerUid).get()
  );
  const rows = loginSnap.docs.map((docSnap) => docSnap.data() as PlayerGameLoginByPlayerRow);

  return {
    assignedGameUsername: findAssignedGameUsername(rows, normalizedGame),
    source: 'firestore',
    sqlMs,
    firestoreFallbackMs: Date.now() - firestoreStartedAt,
  };
}

async function loadGameLoginsFromFirestore(
  coadminUid: string,
  gameName: string,
  sqlMs: number
): Promise<RechargeGameLoginsRead> {
  const firestoreStartedAt = Date.now();
  const [coadminGameSnap, legacyGameSnap] = await timedRechargeFirestoreRead(
    {
      stage: 'pre_transaction_game_logins',
      collection: 'gameLogins',
      document: `coadminUid=${coadminUid}`,
    },
    () =>
      Promise.all([
        adminDb.collection('gameLogins').where('coadminUid', '==', coadminUid).get(),
        adminDb.collection('gameLogins').where('createdBy', '==', coadminUid).get(),
      ])
  );
  const gameCredential = findRequestLinkedGameCredential<RequestLinkedGameCredential>(
    [...coadminGameSnap.docs, ...legacyGameSnap.docs].map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    })),
    gameName
  );

  return {
    gameCredential,
    source: 'firestore',
    sqlMs,
    firestoreFallbackMs: Date.now() - firestoreStartedAt,
  };
}

async function loadFirstRechargeFromFirestore(
  playerUid: string,
  sqlMs: number
): Promise<RechargeFirstRechargeRead> {
  const firestoreStartedAt = Date.now();
  const firstRechargeAppliedSnap = await timedRechargeFirestoreRead(
    {
      stage: 'pre_transaction_first_recharge',
      collection: 'playerGameRequests',
      document: `playerUid=${playerUid}/firstRechargeMatchApplied`,
    },
    () =>
      adminDb
        .collection('playerGameRequests')
        .where('playerUid', '==', playerUid)
        .where('type', '==', 'recharge')
        .where('firstRechargeMatchApplied', '==', true)
        .get()
  );
  const hasAnyFirstRechargeAppliedRequest = firstRechargeAppliedSnap.docs.some((docSnap) => {
    const status = String((docSnap.data() as { status?: string }).status || '').toLowerCase();
    return status !== 'failed' && status !== 'dismissed';
  });

  return {
    hasAnyFirstRechargeAppliedRequest,
    source: 'firestore',
    sqlMs,
    firestoreFallbackMs: Date.now() - firestoreStartedAt,
  };
}

export async function loadRechargePlayerGameLogins(input: {
  playerUid: string;
  normalizedGame: string;
}): Promise<RechargePlayerGameLoginsRead> {
  const sqlStartedAt = Date.now();
  const sqlRows = await readPlayerGameLoginsCacheByPlayer(input.playerUid);
  const sqlMs = Date.now() - sqlStartedAt;

  if (sqlRows !== null) {
    return {
      assignedGameUsername: findAssignedGameUsername(sqlRows, input.normalizedGame),
      source: 'postgres',
      sqlMs,
      firestoreFallbackMs: 0,
    };
  }

  if (blockRechargeFirestoreFallback()) {
    return {
      assignedGameUsername: '',
      source: 'postgres',
      sqlMs,
      firestoreFallbackMs: 0,
    };
  }

  return loadPlayerGameLoginsFromFirestore(input.playerUid, input.normalizedGame, sqlMs);
}

export async function loadRechargeGameLogins(input: {
  coadminUid: string;
  gameName: string;
  normalizedGame?: string;
}): Promise<RechargeGameLoginsRead> {
  const cleanCoadminUid = cleanText(input.coadminUid);
  if (!cleanCoadminUid) {
    return {
      gameCredential: null,
      source: 'postgres',
      sqlMs: 0,
      firestoreFallbackMs: 0,
    };
  }

  const normalizedGame = cleanText(input.normalizedGame) || normalizeGameName(input.gameName);
  const sqlStartedAt = Date.now();
  const singleRow = await readGameLoginCacheForCoadminGame(cleanCoadminUid, normalizedGame);
  const sqlMs = Date.now() - sqlStartedAt;

  if (singleRow) {
    return {
      gameCredential: mapCachedGameLoginToCredential(singleRow),
      source: 'postgres',
      sqlMs,
      firestoreFallbackMs: 0,
    };
  }

  const fallbackStartedAt = Date.now();
  const sqlRows = await readGameLoginsCacheByCoadmin(cleanCoadminUid);
  const fallbackMs = Date.now() - fallbackStartedAt;
  const totalSqlMs = sqlMs + fallbackMs;

  if (sqlRows !== null) {
    const gameCredential = findRequestLinkedGameCredential<RequestLinkedGameCredential>(
      sqlRows.map(mapCachedGameLoginToCredential),
      input.gameName
    );
    return {
      gameCredential,
      source: 'postgres',
      sqlMs: totalSqlMs,
      firestoreFallbackMs: 0,
    };
  }

  if (blockRechargeFirestoreFallback()) {
    return {
      gameCredential: null,
      source: 'postgres',
      sqlMs: totalSqlMs,
      firestoreFallbackMs: 0,
    };
  }

  return loadGameLoginsFromFirestore(cleanCoadminUid, input.gameName, totalSqlMs);
}

export async function loadRechargeFirstRechargeCheck(
  playerUid: string
): Promise<RechargeFirstRechargeRead> {
  const sqlStartedAt = Date.now();
  const sqlResult = await hasFirstRechargeMatchAppliedFromSql(playerUid);
  const sqlMs = Date.now() - sqlStartedAt;

  if (sqlResult !== null) {
    return {
      hasAnyFirstRechargeAppliedRequest: sqlResult,
      source: 'postgres',
      sqlMs,
      firestoreFallbackMs: 0,
    };
  }

  if (blockRechargeFirestoreFallback()) {
    return {
      hasAnyFirstRechargeAppliedRequest: false,
      source: 'postgres',
      sqlMs,
      firestoreFallbackMs: 0,
    };
  }

  return loadFirstRechargeFromFirestore(playerUid, sqlMs);
}

export async function loadRechargePreTransactionReads(input: {
  playerUid: string;
  normalizedGame: string;
  gameName: string;
  coadminUid: string;
}): Promise<RechargePreTransactionReads> {
  const cleanCoadminUid = cleanText(input.coadminUid);
  const sqlBatchStartedAt = Date.now();

  const [playerGameLogins, firstRecharge, gameLogins, playerAuthority] = await Promise.all([
    loadRechargePlayerGameLogins({
      playerUid: input.playerUid,
      normalizedGame: input.normalizedGame,
    }),
    loadRechargeFirstRechargeCheck(input.playerUid),
    cleanCoadminUid
      ? loadRechargeGameLogins({
          coadminUid: cleanCoadminUid,
          gameName: input.gameName,
          normalizedGame: input.normalizedGame,
        })
      : Promise.resolve({
          gameCredential: null,
          source: 'postgres' as const,
          sqlMs: 0,
          firestoreFallbackMs: 0,
        }),
    loadRechargePlayerAuthorityFromSql(input.playerUid),
  ]);

  logRechargeSqlSource({
    playerGameLoginsSource: playerGameLogins.source,
    gameLoginsSource: gameLogins.source,
    firstRechargeSource: firstRecharge.source,
    authoritySource: playerAuthority ? 'postgres' : 'unavailable',
    maintenanceSource: 'pending',
  });

  console.info('[PLAYER_RECHARGE_CREATE_READ]', {
    shared_sql_client: false,
    sql_batch_ms: Date.now() - sqlBatchStartedAt,
    sql_batch_parallel: true,
    playerGameLoginsSource: playerGameLogins.source,
    gameLoginsSource: gameLogins.source,
    firstRechargeSource: firstRecharge.source,
    authoritySource: playerAuthority ? 'postgres' : 'unavailable',
  });

  return {
    playerGameLogins,
    gameLogins,
    firstRecharge,
    playerAuthority,
    sharedSqlClient: false,
  };
}
