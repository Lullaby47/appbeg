import 'server-only';

import type { PoolClient } from 'pg';

import { adminDb } from '@/lib/firebase/admin';
import {
  findRequestLinkedGameCredential,
  type RequestLinkedGameCredential,
} from '@/lib/games/requestLinkedCarerTask';
import {
  readGameLoginsCacheByCoadmin,
  readGameLoginsCacheByCoadminWithClient,
  type CachedGameLogin,
} from '@/lib/sql/gameLoginsCache';
import {
  readPlayerGameLoginsCacheByPlayer,
  readPlayerGameLoginsCacheByPlayerWithClient,
  type PlayerGameLoginByPlayerRow,
} from '@/lib/sql/playerGameLoginsCache';
import {
  hasFirstRechargeMatchAppliedFromSql,
  hasFirstRechargeMatchAppliedFromSqlWithClient,
} from '@/lib/sql/playerGameRequestsCache';
import {
  acquirePlayerMirrorClient,
  cleanText,
  runMirrorClientQuery,
} from '@/lib/sql/playerMirrorCommon';
import {
  isRechargeFirestoreQuotaError,
  logRechargeSqlSource,
  timedRechargeFirestoreRead,
} from '@/lib/server/rechargeFirestoreInstrumentation';

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

async function loadRechargePlayerAuthorityFromSqlWithClient(
  client: PoolClient,
  playerUid: string
): Promise<RechargePlayerAuthorityRead | null> {
  const startedAt = Date.now();
  const cleanUid = cleanText(playerUid);
  if (!cleanUid) {
    return null;
  }

  const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
    client,
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
      cleanText(row.coadmin_uid) || cleanText(row.created_by) || fieldFromRawFirestore(raw, 'coadminUid') || '',
    firstRechargeMatchUsed: boolFromRawFirestore(raw, 'firstRechargeMatchUsed'),
    sqlMs: Date.now() - startedAt,
  };
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

  return loadPlayerGameLoginsFromFirestore(input.playerUid, input.normalizedGame, sqlMs);
}

export async function loadRechargeGameLogins(input: {
  coadminUid: string;
  gameName: string;
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

  const sqlStartedAt = Date.now();
  const sqlRows = await readGameLoginsCacheByCoadmin(cleanCoadminUid);
  const sqlMs = Date.now() - sqlStartedAt;

  if (sqlRows !== null) {
    const gameCredential = findRequestLinkedGameCredential<RequestLinkedGameCredential>(
      sqlRows.map(mapCachedGameLoginToCredential),
      input.gameName
    );
    return {
      gameCredential,
      source: 'postgres',
      sqlMs,
      firestoreFallbackMs: 0,
    };
  }

  return loadGameLoginsFromFirestore(cleanCoadminUid, input.gameName, sqlMs);
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

  return loadFirstRechargeFromFirestore(playerUid, sqlMs);
}

export async function loadRechargePreTransactionReads(input: {
  playerUid: string;
  normalizedGame: string;
  gameName: string;
  coadminUid: string;
}): Promise<RechargePreTransactionReads> {
  const cleanCoadminUid = cleanText(input.coadminUid);
  const acquired = await acquirePlayerMirrorClient({
    context: 'player_recharge_create_read',
    route: '/api/player/game-requests/recharge',
  });

  if (!acquired) {
    const [playerGameLogins, gameLogins, firstRecharge] = await Promise.all([
      loadRechargePlayerGameLogins({
        playerUid: input.playerUid,
        normalizedGame: input.normalizedGame,
      }),
      cleanCoadminUid
        ? loadRechargeGameLogins({
            coadminUid: cleanCoadminUid,
            gameName: input.gameName,
          })
        : Promise.resolve({
            gameCredential: null,
            source: 'postgres' as const,
            sqlMs: 0,
            firestoreFallbackMs: 0,
          }),
      loadRechargeFirstRechargeCheck(input.playerUid),
    ]);

    logRechargeSqlSource({
      playerGameLoginsSource: playerGameLogins.source,
      gameLoginsSource: gameLogins.source,
      firstRechargeSource: firstRecharge.source,
      authoritySource: 'unavailable',
      maintenanceSource: 'pending',
    });

    return {
      playerGameLogins,
      gameLogins,
      firstRecharge,
      playerAuthority: null,
      sharedSqlClient: false,
    };
  }

  const { client } = acquired;
  const sqlBatchStartedAt = Date.now();

  try {
    const playerGameLoginsStartedAt = Date.now();
    let playerGameLogins: RechargePlayerGameLoginsRead;
    try {
      const sqlRows = await readPlayerGameLoginsCacheByPlayerWithClient(client, input.playerUid);
      playerGameLogins = {
        assignedGameUsername: findAssignedGameUsername(sqlRows, input.normalizedGame),
        source: 'postgres',
        sqlMs: Date.now() - playerGameLoginsStartedAt,
        firestoreFallbackMs: 0,
      };
    } catch (error) {
      console.warn('[PLAYER_RECHARGE_CREATE_READ] player game logins sql failed', {
        playerUid: input.playerUid,
        error,
      });
      playerGameLogins = await loadPlayerGameLoginsFromFirestore(
        input.playerUid,
        input.normalizedGame,
        Date.now() - playerGameLoginsStartedAt
      );
    }

    const firstRechargeStartedAt = Date.now();
    let firstRecharge: RechargeFirstRechargeRead;
    try {
      const hasApplied = await hasFirstRechargeMatchAppliedFromSqlWithClient(
        client,
        input.playerUid
      );
      firstRecharge = {
        hasAnyFirstRechargeAppliedRequest: hasApplied,
        source: 'postgres',
        sqlMs: Date.now() - firstRechargeStartedAt,
        firestoreFallbackMs: 0,
      };
    } catch (error) {
      console.warn('[PLAYER_RECHARGE_CREATE_READ] first recharge sql failed', {
        playerUid: input.playerUid,
        error,
      });
      firstRecharge = await loadFirstRechargeFromFirestore(
        input.playerUid,
        Date.now() - firstRechargeStartedAt
      );
    }

    const gameLoginsStartedAt = Date.now();
    let gameLogins: RechargeGameLoginsRead;
    if (!cleanCoadminUid) {
      gameLogins = {
        gameCredential: null,
        source: 'postgres',
        sqlMs: 0,
        firestoreFallbackMs: 0,
      };
    } else {
      try {
        const sqlRows = await readGameLoginsCacheByCoadminWithClient(client, cleanCoadminUid);
        const gameCredential = findRequestLinkedGameCredential<RequestLinkedGameCredential>(
          sqlRows.map(mapCachedGameLoginToCredential),
          input.gameName
        );
        gameLogins = {
          gameCredential,
          source: 'postgres',
          sqlMs: Date.now() - gameLoginsStartedAt,
          firestoreFallbackMs: 0,
        };
      } catch (error) {
        console.warn('[PLAYER_RECHARGE_CREATE_READ] game logins sql failed', {
          coadminUid: cleanCoadminUid,
          error,
        });
        gameLogins = await loadGameLoginsFromFirestore(
          cleanCoadminUid,
          input.gameName,
          Date.now() - gameLoginsStartedAt
        );
      }
    }

    const playerAuthorityStartedAt = Date.now();
    let playerAuthority: RechargePlayerAuthorityRead | null = null;
    try {
      playerAuthority = await loadRechargePlayerAuthorityFromSqlWithClient(client, input.playerUid);
    } catch (error) {
      console.warn('[PLAYER_RECHARGE_CREATE_READ] player authority sql failed', {
        playerUid: input.playerUid,
        durationMs: Date.now() - playerAuthorityStartedAt,
        error,
      });
    }

    logRechargeSqlSource({
      playerGameLoginsSource: playerGameLogins.source,
      gameLoginsSource: gameLogins.source,
      firstRechargeSource: firstRecharge.source,
      authoritySource: playerAuthority ? 'postgres' : 'unavailable',
      maintenanceSource: 'pending',
    });

    console.info('[PLAYER_RECHARGE_CREATE_READ]', {
      shared_sql_client: true,
      sql_batch_ms: Date.now() - sqlBatchStartedAt,
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
      sharedSqlClient: true,
    };
  } finally {
    client.release();
  }
}
