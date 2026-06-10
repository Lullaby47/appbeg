import 'server-only';

import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { PoolClient } from 'pg';

import { adminDb } from '@/lib/firebase/admin';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import {
  isReferralRechargeEligible,
  REFERRAL_REWARD_COINS,
} from '@/lib/economy/policy';
import { readGameLoginsCacheByCoadminWithClient, type CachedGameLogin } from '@/lib/sql/gameLoginsCache';
import { readFreeplayPendingGiftCacheWithClient } from '@/lib/sql/freeplayPendingGiftsCache';
import {
  acquirePlayerMirrorClient,
  cleanText,
  getPlayerMirrorPool,
  getPlayerMirrorPoolStats,
  type PlayerMirrorPoolStats,
} from '@/lib/sql/playerMirrorCommon';
import { readCompletedRechargeRequestsForPlayerWithClient } from '@/lib/sql/playerGameRequestsCache';
import { readPlayersCacheByReferrerUidWithClient } from '@/lib/sql/playersCache';
import { getReferralRewardClaimCacheByIdWithClient } from '@/lib/sql/referralRewardClaimsCache';
import { loadFreeplayPendingGift } from '@/lib/server/playerFreeplayPendingRead';
import {
  buildReferralClaimDocId,
  loadReferralRewardGroups,
  type ReferralRewardGroup,
} from '@/lib/server/playerReferralRewardsRead';
import {
  readSafeStaffListForPlayerWithClient,
  resolvePlayerStaffList,
  type PlayerVisibleStaff,
} from '@/lib/server/playerStaffList';
import { extractPgErrorDetails } from '@/lib/server/sqlErrorDetails';

export type PlayerBaseDataSource = 'postgres' | 'mixed' | 'fallback';

export type PlayerBaseDataPendingGift = {
  hasPendingGift: boolean;
  giftId: string | null;
  source: 'postgres' | 'firestore' | 'none';
};

export type PlayerBaseDataReferralRewards = {
  groups: ReferralRewardGroup[];
  source: 'postgres' | 'firestore' | 'none';
};

export type PlayerBaseDataPayload = {
  staff: PlayerVisibleStaff[];
  gameLogins: CachedGameLogin[];
  pendingGift: PlayerBaseDataPendingGift;
  referralRewards: PlayerBaseDataReferralRewards;
  source: PlayerBaseDataSource;
  snapshotAt: string;
};

export type PlayerBaseDataTiming = {
  auth_ms: number;
  shared_client: boolean;
  parallel: boolean;
  client_acquire_ms: number;
  staff_ms: number;
  game_logins_ms: number;
  freeplay_ms: number;
  referral_rewards_ms: number;
  total_sql_ms: number;
  pool_waiting_max: number;
  total_ms: number;
};

type PlayerBaseDataSqlTiming = Pick<
  PlayerBaseDataTiming,
  | 'staff_ms'
  | 'game_logins_ms'
  | 'freeplay_ms'
  | 'referral_rewards_ms'
  | 'total_sql_ms'
  | 'client_acquire_ms'
  | 'pool_waiting_max'
>;

type PlayerBaseDataSqlResult = {
  staff: PlayerVisibleStaff[];
  gameLogins: CachedGameLogin[];
  freeplayLookup: Awaited<ReturnType<typeof readFreeplayPendingGiftCacheWithClient>> | null;
  referralRewards: PlayerBaseDataReferralRewards | null;
  referralSqlOk: boolean;
  hardSqlFailure: boolean;
  timing: PlayerBaseDataSqlTiming;
};

type PlayerBaseDataMode = 'parallel' | 'sequential';
type PlayerBaseDataModeReason =
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

const PLAYER_BASE_DATA_ROUTE = '/api/player/base-data';
const PLAYER_BASE_DATA_PARALLEL_MIN_IDLE = 4;
const PLAYER_BASE_DATA_PARALLEL_MIN_TOTAL = 4;

function resolvePlayerBaseDataParallelMode(stats: PlayerMirrorPoolStats | null): {
  mode: PlayerBaseDataMode;
  reason: PlayerBaseDataModeReason;
} {
  const env = cleanText(process.env.PLAYER_BASE_DATA_PARALLEL || 'auto').toLowerCase();
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
  if (stats.idleCount < PLAYER_BASE_DATA_PARALLEL_MIN_IDLE) {
    return { mode: 'sequential', reason: 'low_idle' };
  }
  if (stats.totalCount < PLAYER_BASE_DATA_PARALLEL_MIN_TOTAL) {
    return { mode: 'sequential', reason: 'cold_pool' };
  }

  return { mode: 'parallel', reason: 'warm_pool' };
}

function logPlayerBaseDataMode(
  mode: PlayerBaseDataMode,
  reason: PlayerBaseDataModeReason,
  stats: PlayerMirrorPoolStats | null
) {
  console.info('[PLAYER_BASE_DATA_MODE]', {
    mode,
    reason,
    totalCount: stats?.totalCount ?? 0,
    idleCount: stats?.idleCount ?? 0,
    waitingCount: stats?.waitingCount ?? 0,
    max: stats?.max ?? 0,
  });
}

async function withParallelPlayerMirrorRead<T>(
  context: string,
  trackWaiting: () => void,
  read: (client: PoolClient) => Promise<T>
): Promise<ParallelReadResult<T>> {
  const startedAt = Date.now();
  trackWaiting();
  const acquired = await acquirePlayerMirrorClient({
    context,
    route: PLAYER_BASE_DATA_ROUTE,
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

function pendingGiftFromSqlLookup(
  lookup: Awaited<ReturnType<typeof readFreeplayPendingGiftCacheWithClient>>
): PlayerBaseDataPendingGift {
  if (lookup.missReason === null && lookup.row) {
    return {
      hasPendingGift: lookup.row.hasPendingGift,
      giftId: lookup.row.hasPendingGift ? lookup.row.giftId : null,
      source: 'postgres',
    };
  }
  if (lookup.missReason === 'row_missing') {
    return {
      hasPendingGift: false,
      giftId: null,
      source: 'postgres',
    };
  }
  return {
    hasPendingGift: false,
    giftId: null,
    source: 'none',
  };
}

async function loadQualifiedRechargeForReferredPlayerWithClient(
  client: PoolClient,
  referredPlayerUid: string
) {
  const cachedRecharges = await readCompletedRechargeRequestsForPlayerWithClient(
    client,
    referredPlayerUid
  );
  const eligible = cachedRecharges
    .filter(
      (recharge) =>
        recharge.amount > 0 &&
        isReferralRechargeEligible({
          bonusEventId: recharge.bonusEventId,
          bonusPercentage: recharge.bonusPercentage,
        })
    )
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
  return eligible[0] || null;
}

async function readClaimStatusWithClient(
  client: PoolClient,
  referrerUid: string,
  referredPlayerUid: string
): Promise<boolean> {
  const claimId = buildReferralClaimDocId(referrerUid, referredPlayerUid);
  const cachedClaim = await getReferralRewardClaimCacheByIdWithClient(client, claimId);
  if (!cachedClaim) {
    return false;
  }
  return String(cachedClaim.status || '').toLowerCase() === 'claimed';
}

async function loadReferralRewardGroupsWithClient(
  client: PoolClient,
  referrerUid: string
): Promise<PlayerBaseDataReferralRewards> {
  const referredPlayers = await readPlayersCacheByReferrerUidWithClient(client, referrerUid);
  if (!referredPlayers.length) {
    return { groups: [], source: 'postgres' };
  }

  const groups = await Promise.all(
    referredPlayers.map(async (referredPlayer) => {
      const referredPlayerUid = referredPlayer.uid;
      const referredPlayerName =
        String(referredPlayer.username || '').trim() || 'Unnamed Player';

      const [alreadyClaimed, qualifiedRecharge] = await Promise.all([
        readClaimStatusWithClient(client, referrerUid, referredPlayerUid),
        loadQualifiedRechargeForReferredPlayerWithClient(client, referredPlayerUid),
      ]);

      const isPending = Boolean(qualifiedRecharge) && !alreadyClaimed;

      return {
        referredPlayerUid,
        referredPlayerName,
        pendingRewardCoins: isPending ? REFERRAL_REWARD_COINS : 0,
        hasClaimableReward: isPending,
      } satisfies ReferralRewardGroup;
    })
  );

  return {
    groups: groups.filter((group) => group.pendingRewardCoins > 0),
    source: 'postgres',
  };
}

function mergeTopLevelSource(
  parts: Array<'postgres' | 'firestore' | 'none' | 'mixed'>
): PlayerBaseDataSource {
  const normalized = parts.filter((part) => part !== 'none');
  if (!normalized.length || normalized.every((part) => part === 'postgres')) {
    return 'postgres';
  }
  if (normalized.every((part) => part === 'firestore')) {
    return 'fallback';
  }
  return 'mixed';
}

function emptyPlayerBaseDataPayload(snapshotAt: string): PlayerBaseDataPayload {
  return {
    staff: [],
    gameLogins: [],
    pendingGift: { hasPendingGift: false, giftId: null, source: 'postgres' },
    referralRewards: { groups: [], source: 'postgres' },
    source: 'postgres',
    snapshotAt,
  };
}

export function emptyPlayerBaseDataPayloadExport(snapshotAt: string): PlayerBaseDataPayload {
  return emptyPlayerBaseDataPayload(snapshotAt);
}

function logPlayerBaseDataSqlStage(
  stage: string,
  input: { ok: boolean; count?: number; durationMs: number }
) {
  console.info('[PLAYER_BASE_DATA_SQL_STAGE]', {
    stage,
    ok: input.ok,
    count: input.count ?? null,
    durationMs: input.durationMs,
  });
}

function logPlayerBaseDataError(input: {
  uid: string;
  role?: string;
  authPath?: string;
  stage: string;
  sqlQuery?: string;
  error: unknown;
  durationMs: number;
}) {
  const pg = extractPgErrorDetails(input.error);
  console.error('[PLAYER_BASE_DATA_ERROR]', {
    uid: input.uid,
    role: input.role || 'player',
    authPath: input.authPath || null,
    stage: input.stage,
    sqlQuery: input.sqlQuery || null,
    durationMs: input.durationMs,
    ...pg,
  });
}

async function loadPlayerBaseDataFallback(
  playerUid: string,
  coadminUid: string
): Promise<PlayerBaseDataPayload> {
  const snapshotAt = new Date().toISOString();
  if (isAuthSqlReadEnabled()) {
    logFirestoreTouch({
      firestore_touch_type: 'legacy_read_remove_now',
      route: PLAYER_BASE_DATA_ROUTE,
      operation: 'read',
      collection: 'users,gameLogins,freeplayPendingGifts,referralRewardClaims',
      skipped: true,
      sql_read_mode: true,
      details: { playerUid, coadminUid, context: 'full_fallback_blocked' },
    });
    return emptyPlayerBaseDataPayload(snapshotAt);
  }
  const [staffResult, freeplayResult, referralResult, gameLogins] = await Promise.all([
    resolvePlayerStaffList(coadminUid),
    loadFreeplayPendingGift(playerUid),
    loadReferralRewardGroups(playerUid),
    readFirestoreGameLoginsByCoadmin(coadminUid),
  ]);

  const referralSource: PlayerBaseDataReferralRewards['source'] =
    referralResult.trace.sqlMs > 0 && referralResult.trace.firestoreMs === 0
      ? 'postgres'
      : referralResult.trace.firestoreMs > 0 && referralResult.trace.sqlMs === 0
        ? 'firestore'
        : referralResult.trace.firestoreMs > 0
          ? 'firestore'
          : 'postgres';

  return {
    staff: staffResult.staff,
    gameLogins,
    pendingGift: {
      hasPendingGift: freeplayResult.hasPendingGift,
      giftId: freeplayResult.giftId,
      source: freeplayResult.dataSource,
    },
    referralRewards: {
      groups: referralResult.groups,
      source: referralSource,
    },
    source: mergeTopLevelSource([
      staffResult.source === 'firestore' ? 'firestore' : 'postgres',
      'firestore',
      freeplayResult.dataSource,
      referralSource,
    ]),
    snapshotAt,
  };
}

async function loadPlayerBaseDataSequentialSql(input: {
  playerUid: string;
  coadminUid: string;
  role?: string;
  authPath?: string;
}): Promise<PlayerBaseDataSqlResult> {
  const sqlStartedAt = Date.now();
  const acquired = await acquirePlayerMirrorClient({
    context: 'player_base_data',
    route: PLAYER_BASE_DATA_ROUTE,
  });

  if (!acquired) {
    return {
      staff: [],
      gameLogins: [],
      freeplayLookup: null,
      referralRewards: null,
      referralSqlOk: false,
      hardSqlFailure: true,
      timing: {
        staff_ms: 0,
        game_logins_ms: 0,
        freeplay_ms: 0,
        referral_rewards_ms: 0,
        total_sql_ms: Date.now() - sqlStartedAt,
        client_acquire_ms: 0,
        pool_waiting_max: 0,
      },
    };
  }

  const { client } = acquired;
  let staff: PlayerVisibleStaff[] = [];
  let gameLogins: CachedGameLogin[] = [];
  let freeplayLookup: Awaited<ReturnType<typeof readFreeplayPendingGiftCacheWithClient>> | null =
    null;
  let referralRewards: PlayerBaseDataReferralRewards | null = null;
  let referralSqlOk = false;
  let staffMs = 0;
  let gameLoginsMs = 0;
  let freeplayMs = 0;
  let referralRewardsMs = 0;

  try {
    const staffStartedAt = Date.now();
    staff = await readSafeStaffListForPlayerWithClient(client, input.coadminUid);
    staffMs = Date.now() - staffStartedAt;
    logPlayerBaseDataSqlStage('staff', { ok: true, count: staff.length, durationMs: staffMs });

    const gameLoginsStartedAt = Date.now();
    gameLogins = await readGameLoginsCacheByCoadminWithClient(client, input.coadminUid);
    gameLoginsMs = Date.now() - gameLoginsStartedAt;
    logPlayerBaseDataSqlStage('game_logins', {
      ok: true,
      count: gameLogins.length,
      durationMs: gameLoginsMs,
    });

    const freeplayStartedAt = Date.now();
    freeplayLookup = await readFreeplayPendingGiftCacheWithClient(client, input.playerUid);
    freeplayMs = Date.now() - freeplayStartedAt;
    logPlayerBaseDataSqlStage('freeplay', {
      ok: freeplayLookup.missReason !== 'postgres_unavailable',
      count: freeplayLookup.row?.hasPendingGift ? 1 : 0,
      durationMs: freeplayMs,
    });

    const referralStartedAt = Date.now();
    try {
      referralRewards = await loadReferralRewardGroupsWithClient(client, input.playerUid);
      referralSqlOk = true;
      logPlayerBaseDataSqlStage('referral_rewards', {
        ok: true,
        count: referralRewards.groups.length,
        durationMs: Date.now() - referralStartedAt,
      });
    } catch (error) {
      logPlayerBaseDataError({
        uid: input.playerUid,
        role: input.role,
        authPath: input.authPath,
        stage: 'referral_rewards',
        sqlQuery: 'players_cache.referred_by + referral_reward_claims + player_game_requests',
        error,
        durationMs: Date.now() - referralStartedAt,
      });
      logPlayerBaseDataSqlStage('referral_rewards', {
        ok: false,
        count: 0,
        durationMs: Date.now() - referralStartedAt,
      });
    }
    referralRewardsMs = Date.now() - referralStartedAt;
  } catch (error) {
    const failedStage =
      staffMs === 0
        ? 'staff'
        : gameLoginsMs === 0
          ? 'game_logins'
          : 'freeplay';
    logPlayerBaseDataError({
      uid: input.playerUid,
      role: input.role,
      authPath: input.authPath,
      stage: failedStage,
      sqlQuery: `player_base_data.${failedStage}`,
      error,
      durationMs: Date.now() - sqlStartedAt,
    });
    logPlayerBaseDataSqlStage(failedStage, {
      ok: false,
      count: 0,
      durationMs:
        failedStage === 'staff'
          ? staffMs
          : failedStage === 'game_logins'
            ? gameLoginsMs
            : freeplayMs,
    });
    return {
      staff: [],
      gameLogins: [],
      freeplayLookup: null,
      referralRewards: null,
      referralSqlOk: false,
      hardSqlFailure: true,
      timing: {
        staff_ms: staffMs,
        game_logins_ms: gameLoginsMs,
        freeplay_ms: freeplayMs,
        referral_rewards_ms: referralRewardsMs,
        total_sql_ms: Date.now() - sqlStartedAt,
        client_acquire_ms: acquired.timing.pool_acquire_ms,
        pool_waiting_max: 0,
      },
    };
  } finally {
    client.release();
  }

  return {
    staff,
    gameLogins,
    freeplayLookup,
    referralRewards,
    referralSqlOk,
    hardSqlFailure: false,
    timing: {
      staff_ms: staffMs,
      game_logins_ms: gameLoginsMs,
      freeplay_ms: freeplayMs,
      referral_rewards_ms: referralRewardsMs,
      total_sql_ms: Date.now() - sqlStartedAt,
      client_acquire_ms: acquired.timing.pool_acquire_ms,
      pool_waiting_max: 0,
    },
  };
}

async function loadPlayerBaseDataParallelSql(input: {
  playerUid: string;
  coadminUid: string;
  role?: string;
  authPath?: string;
}): Promise<PlayerBaseDataSqlResult> {
  const sqlStartedAt = Date.now();
  const waitingTracker = { max: 0 };
  const trackWaiting = () => {
    const pool = getPlayerMirrorPool();
    if (pool) {
      waitingTracker.max = Math.max(waitingTracker.max, pool.waitingCount);
    }
  };

  const parallelReads: [
    Promise<ParallelReadResult<PlayerVisibleStaff[]>>,
    Promise<ParallelReadResult<CachedGameLogin[]>>,
    Promise<ParallelReadResult<Awaited<ReturnType<typeof readFreeplayPendingGiftCacheWithClient>>>>,
    Promise<ParallelReadResult<PlayerBaseDataReferralRewards>>,
  ] = [
    withParallelPlayerMirrorRead('player_base_data_staff', trackWaiting, (client) =>
      readSafeStaffListForPlayerWithClient(client, input.coadminUid)
    ),
    withParallelPlayerMirrorRead('player_base_data_game_logins', trackWaiting, (client) =>
      readGameLoginsCacheByCoadminWithClient(client, input.coadminUid)
    ),
    withParallelPlayerMirrorRead('player_base_data_freeplay', trackWaiting, (client) =>
      readFreeplayPendingGiftCacheWithClient(client, input.playerUid)
    ),
    withParallelPlayerMirrorRead('player_base_data_referral_rewards', trackWaiting, (client) =>
      loadReferralRewardGroupsWithClient(client, input.playerUid)
    ),
  ];

  const [staffPack, gameLoginsPack, freeplayPack, referralPack] = await Promise.all(parallelReads);

  const stageResults: Array<{
    stage: string;
    pack: ParallelReadResult<unknown>;
    sqlQuery: string;
  }> = [
    { stage: 'staff', pack: staffPack, sqlQuery: 'players_cache.staff_by_coadmin' },
    { stage: 'game_logins', pack: gameLoginsPack, sqlQuery: 'game_logins_cache.by_coadmin' },
    { stage: 'freeplay', pack: freeplayPack, sqlQuery: 'freeplay_pending_gifts_cache.by_player' },
    {
      stage: 'referral_rewards',
      pack: referralPack,
      sqlQuery: 'players_cache.referred_by + referral_reward_claims',
    },
  ];

  for (const { stage, pack, sqlQuery } of stageResults) {
    if (pack.ok) {
      const count =
        stage === 'staff'
          ? (pack.value as PlayerVisibleStaff[]).length
          : stage === 'game_logins'
            ? (pack.value as CachedGameLogin[]).length
            : stage === 'freeplay'
              ? (
                  pack.value as Awaited<ReturnType<typeof readFreeplayPendingGiftCacheWithClient>>
                ).row?.hasPendingGift
                ? 1
                : 0
              : (pack.value as PlayerBaseDataReferralRewards).groups.length;
      logPlayerBaseDataSqlStage(stage, { ok: true, count, durationMs: pack.timing.ms });
    } else {
      logPlayerBaseDataError({
        uid: input.playerUid,
        role: input.role,
        authPath: input.authPath,
        stage,
        sqlQuery,
        error: pack.error,
        durationMs: pack.timing.ms,
      });
      logPlayerBaseDataSqlStage(stage, { ok: false, count: 0, durationMs: pack.timing.ms });
    }
  }

  return {
    staff: staffPack.ok ? staffPack.value : [],
    gameLogins: gameLoginsPack.ok ? gameLoginsPack.value : [],
    freeplayLookup: freeplayPack.ok ? freeplayPack.value : null,
    referralRewards: referralPack.ok ? referralPack.value : null,
    referralSqlOk: referralPack.ok,
    hardSqlFailure: !staffPack.ok || !gameLoginsPack.ok,
    timing: {
      staff_ms: staffPack.timing.ms,
      game_logins_ms: gameLoginsPack.timing.ms,
      freeplay_ms: freeplayPack.timing.ms,
      referral_rewards_ms: referralPack.timing.ms,
      total_sql_ms: Date.now() - sqlStartedAt,
      client_acquire_ms: Math.max(
        staffPack.timing.pool_acquire_ms,
        gameLoginsPack.timing.pool_acquire_ms,
        freeplayPack.timing.pool_acquire_ms,
        referralPack.timing.pool_acquire_ms
      ),
      pool_waiting_max: waitingTracker.max,
    },
  };
}

async function buildPlayerBaseDataPayloadFromSql(
  playerUid: string,
  sqlResult: PlayerBaseDataSqlResult,
  snapshotAt: string
): Promise<PlayerBaseDataPayload> {
  let pendingGift: PlayerBaseDataPendingGift = {
    hasPendingGift: false,
    giftId: null,
    source: 'postgres',
  };
  let referralRewards: PlayerBaseDataReferralRewards = sqlResult.referralRewards ?? {
    groups: [],
    source: 'postgres',
  };
  const sourceParts: Array<'postgres' | 'firestore' | 'none'> = ['postgres', 'postgres'];

  if (sqlResult.freeplayLookup) {
    if (sqlResult.freeplayLookup.missReason === 'postgres_unavailable') {
      if (isAuthSqlReadEnabled()) {
        logFirestoreTouch({
          firestore_touch_type: 'legacy_read_remove_now',
          route: PLAYER_BASE_DATA_ROUTE,
          operation: 'read',
          collection: 'freeplayPendingGifts',
          skipped: true,
          sql_read_mode: true,
          details: { playerUid, context: 'freeplay_fallback_blocked' },
        });
        pendingGift = { hasPendingGift: false, giftId: null, source: 'postgres' };
        sourceParts.push('postgres');
      } else {
        const freeplayResult = await loadFreeplayPendingGift(playerUid);
        pendingGift = {
          hasPendingGift: freeplayResult.hasPendingGift,
          giftId: freeplayResult.giftId,
          source: freeplayResult.dataSource,
        };
        sourceParts.push(freeplayResult.dataSource);
      }
    } else {
      pendingGift = pendingGiftFromSqlLookup(sqlResult.freeplayLookup);
      sourceParts.push('postgres');
    }
  }

  if (!sqlResult.referralSqlOk) {
    if (isAuthSqlReadEnabled()) {
      logFirestoreTouch({
        firestore_touch_type: 'legacy_read_remove_now',
        route: PLAYER_BASE_DATA_ROUTE,
        operation: 'read',
        collection: 'referralRewardClaims,playerGameRequests',
        skipped: true,
        sql_read_mode: true,
        details: { playerUid, context: 'referral_fallback_blocked' },
      });
      referralRewards = { groups: [], source: 'postgres' };
      sourceParts.push('postgres');
    } else {
      const referralResult = await loadReferralRewardGroups(playerUid);
      referralRewards = {
        groups: referralResult.groups,
        source: 'firestore',
      };
      sourceParts.push('firestore');
    }
  } else {
    sourceParts.push('postgres');
  }

  return {
    staff: sqlResult.staff,
    gameLogins: sqlResult.gameLogins,
    pendingGift,
    referralRewards,
    source: mergeTopLevelSource(sourceParts),
    snapshotAt,
  };
}

export async function loadPlayerBaseData(input: {
  playerUid: string;
  coadminUid: string;
  authMs?: number;
  role?: string;
  authPath?: string;
}): Promise<{ payload: PlayerBaseDataPayload; timing: PlayerBaseDataTiming }> {
  const totalStartedAt = Date.now();
  const cleanPlayerUid = cleanText(input.playerUid);
  const cleanCoadminUid = cleanText(input.coadminUid);
  const snapshotAt = new Date().toISOString();

  try {
  return await loadPlayerBaseDataInner({
    ...input,
    playerUid: cleanPlayerUid,
    coadminUid: cleanCoadminUid,
    snapshotAt,
    totalStartedAt,
  });
  } catch (error) {
    logPlayerBaseDataError({
      uid: cleanPlayerUid,
      role: input.role,
      authPath: input.authPath,
      stage: 'load',
      error,
      durationMs: Date.now() - totalStartedAt,
    });
    return {
      payload: emptyPlayerBaseDataPayload(snapshotAt),
      timing: {
        auth_ms: input.authMs ?? 0,
        shared_client: false,
        parallel: false,
        client_acquire_ms: 0,
        staff_ms: 0,
        game_logins_ms: 0,
        freeplay_ms: 0,
        referral_rewards_ms: 0,
        total_sql_ms: 0,
        pool_waiting_max: 0,
        total_ms: Date.now() - totalStartedAt,
      },
    };
  }
}

async function loadPlayerBaseDataInner(input: {
  playerUid: string;
  coadminUid: string;
  authMs?: number;
  role?: string;
  authPath?: string;
  snapshotAt: string;
  totalStartedAt: number;
}): Promise<{ payload: PlayerBaseDataPayload; timing: PlayerBaseDataTiming }> {
  const cleanPlayerUid = input.playerUid;
  const cleanCoadminUid = input.coadminUid;
  const snapshotAt = input.snapshotAt;
  const totalStartedAt = input.totalStartedAt;
  const pool = getPlayerMirrorPool();
  const poolStats = getPlayerMirrorPoolStats();
  const modeSelection = resolvePlayerBaseDataParallelMode(poolStats);
  logPlayerBaseDataMode(modeSelection.mode, modeSelection.reason, poolStats);

  const timing: PlayerBaseDataTiming = {
    auth_ms: input.authMs ?? 0,
    shared_client: modeSelection.mode === 'sequential',
    parallel: modeSelection.mode === 'parallel',
    client_acquire_ms: 0,
    staff_ms: 0,
    game_logins_ms: 0,
    freeplay_ms: 0,
    referral_rewards_ms: 0,
    total_sql_ms: 0,
    pool_waiting_max: 0,
    total_ms: 0,
  };

  if (!cleanPlayerUid || !cleanCoadminUid) {
    timing.total_ms = Date.now() - totalStartedAt;
    return {
      payload: {
        staff: [],
        gameLogins: [],
        pendingGift: { hasPendingGift: false, giftId: null, source: 'postgres' },
        referralRewards: { groups: [], source: 'postgres' },
        source: 'postgres',
        snapshotAt,
      },
      timing,
    };
  }

  if (!pool) {
    timing.total_ms = Date.now() - totalStartedAt;
    if (isAuthSqlReadEnabled()) {
      logFirestoreTouch({
        firestore_touch_type: 'legacy_read_remove_now',
        route: PLAYER_BASE_DATA_ROUTE,
        operation: 'read',
        collection: 'users,gameLogins',
        skipped: true,
        sql_read_mode: true,
        details: { playerUid: cleanPlayerUid, reason: 'postgres_unavailable' },
      });
      return {
        payload: emptyPlayerBaseDataPayload(snapshotAt),
        timing: { ...timing, total_ms: Date.now() - totalStartedAt },
      };
    }
    return {
      payload: await loadPlayerBaseDataFallback(cleanPlayerUid, cleanCoadminUid),
      timing: { ...timing, total_ms: Date.now() - totalStartedAt },
    };
  }

  const sqlResult =
    modeSelection.mode === 'parallel'
      ? await loadPlayerBaseDataParallelSql({
          playerUid: cleanPlayerUid,
          coadminUid: cleanCoadminUid,
          role: input.role,
          authPath: input.authPath,
        })
      : await loadPlayerBaseDataSequentialSql({
          playerUid: cleanPlayerUid,
          coadminUid: cleanCoadminUid,
          role: input.role,
          authPath: input.authPath,
        });

  timing.staff_ms = sqlResult.timing.staff_ms;
  timing.game_logins_ms = sqlResult.timing.game_logins_ms;
  timing.freeplay_ms = sqlResult.timing.freeplay_ms;
  timing.referral_rewards_ms = sqlResult.timing.referral_rewards_ms;
  timing.total_sql_ms = sqlResult.timing.total_sql_ms;
  timing.client_acquire_ms = sqlResult.timing.client_acquire_ms;
  timing.pool_waiting_max = sqlResult.timing.pool_waiting_max;

  if (sqlResult.hardSqlFailure) {
    if (isAuthSqlReadEnabled()) {
      logFirestoreTouch({
        firestore_touch_type: 'legacy_read_remove_now',
        route: PLAYER_BASE_DATA_ROUTE,
        operation: 'read',
        collection: 'users,gameLogins',
        skipped: true,
        sql_read_mode: true,
        details: {
          playerUid: cleanPlayerUid,
          coadminUid: cleanCoadminUid,
          reason: 'sql_hard_failure',
        },
      });
      console.warn('[PLAYER_BASE_DATA] sql read failed, firestore fallback blocked', {
        playerUid: cleanPlayerUid,
        coadminUid: cleanCoadminUid,
        mode: modeSelection.mode,
        reason: modeSelection.reason,
      });
      timing.total_ms = Date.now() - totalStartedAt;
      return {
        payload: emptyPlayerBaseDataPayload(snapshotAt),
        timing: { ...timing, total_ms: Date.now() - totalStartedAt },
      };
    }
    console.warn('[PLAYER_BASE_DATA] sql read failed, using firestore fallback', {
      playerUid: cleanPlayerUid,
      coadminUid: cleanCoadminUid,
      mode: modeSelection.mode,
      reason: modeSelection.reason,
    });
    timing.total_ms = Date.now() - totalStartedAt;
    return {
      payload: await loadPlayerBaseDataFallback(cleanPlayerUid, cleanCoadminUid),
      timing: { ...timing, total_ms: Date.now() - totalStartedAt },
    };
  }

  const payload = await buildPlayerBaseDataPayloadFromSql(
    cleanPlayerUid,
    sqlResult,
    snapshotAt
  );
  timing.total_ms = Date.now() - totalStartedAt;

  if (modeSelection.mode === 'parallel') {
    console.info('[PLAYER_BASE_DATA_PARALLEL]', {
      parallel: true,
      staff_ms: timing.staff_ms,
      game_logins_ms: timing.game_logins_ms,
      freeplay_ms: timing.freeplay_ms,
      referral_rewards_ms: timing.referral_rewards_ms,
      total_sql_ms: timing.total_sql_ms,
      total_ms: timing.total_ms,
      pool_waiting_max: timing.pool_waiting_max,
      source: payload.source,
    });
  }

  return { payload, timing };
}
