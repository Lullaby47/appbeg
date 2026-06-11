import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  maintenanceBreakApiResponse,
  rejectIfPlayerMaintenanceBreakFromUser,
} from '@/lib/maintenance/admin';
import {
  buildPendingRequestLinkedCarerTaskPayload,
  requestLinkedCarerTaskId,
} from '@/lib/games/requestLinkedCarerTask';
import {
  loadRechargePreTransactionReads,
  type RechargePlayerAuthorityRead,
  type RechargeReadSource,
} from '@/lib/server/playerRechargeCreateRead';
import {
  logRechargeSqlSource,
  timedRechargeFirestoreRead,
} from '@/lib/server/rechargeFirestoreInstrumentation';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { createRechargeRequestInSql } from '@/lib/sql/authorityGameRequests';
import { mirrorCarerTaskById } from '@/lib/sql/carerTasksCache';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorPlayerGameRequestById } from '@/lib/sql/playerGameRequestsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

type RechargeBody = {
  gameName?: unknown;
  amount?: unknown;
  baseAmount?: unknown;
  bonusPercentage?: unknown;
  bonusEventId?: unknown;
  idempotencyKey?: unknown;
};

type RechargeCreateTiming = {
  auth_ms: number;
  body_parse_ms: number;
  player_profile_ms: number;
  balance_read_ms: number;
  game_login_read_ms: number;
  request_create_ms: number;
  financial_event_ms: number;
  carer_task_ms: number;
  mirror_ms: number;
  firestore_transaction_ms: number;
  sql_mirror_ms: number;
  maintenance_ms: number;
  sql_player_game_logins_ms: number;
  sql_game_logins_ms: number;
  sql_first_recharge_ms: number;
  firestore_fallback_player_game_logins_ms: number;
  firestore_fallback_game_logins_ms: number;
  firestore_fallback_first_recharge_ms: number;
  authority_transaction_ms: number;
  authority_reads_ms: number;
  authority_writes_ms: number;
  total_ms: number;
};

function emptyTiming(): RechargeCreateTiming {
  return {
    auth_ms: 0,
    body_parse_ms: 0,
    player_profile_ms: 0,
    balance_read_ms: 0,
    game_login_read_ms: 0,
    request_create_ms: 0,
    financial_event_ms: 0,
    carer_task_ms: 0,
    mirror_ms: 0,
    firestore_transaction_ms: 0,
    sql_mirror_ms: 0,
    maintenance_ms: 0,
    sql_player_game_logins_ms: 0,
    sql_game_logins_ms: 0,
    sql_first_recharge_ms: 0,
    firestore_fallback_player_game_logins_ms: 0,
    firestore_fallback_game_logins_ms: 0,
    firestore_fallback_first_recharge_ms: 0,
    authority_transaction_ms: 0,
    authority_reads_ms: 0,
    authority_writes_ms: 0,
    total_ms: 0,
  };
}

function logRechargeCreateTiming(
  input: RechargeCreateTiming & {
    ok: boolean;
    playerUid?: string;
    requestId?: string;
    error?: string;
    error_code?: string | number | null;
    firestore_code?: number | null;
    firestore_details?: string | null;
    failure_stage?: string;
    playerGameLoginsSource?: RechargeReadSource;
    gameLoginsSource?: RechargeReadSource;
    firstRechargeSource?: RechargeReadSource;
    shared_sql_client?: boolean;
  }
) {
  console.info('[PLAYER_RECHARGE_CREATE_TIMING]', input);
}

function extractFirestoreError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return {
      message: error instanceof Error ? error.message : String(error),
      firestore_code: null as number | null,
      firestore_details: null as string | null,
    };
  }
  const record = error as { code?: number; details?: string; message?: string };
  return {
    message: record.message || String(error),
    firestore_code: typeof record.code === 'number' ? record.code : null,
    firestore_details: record.details || null,
  };
}

function resolveHttpStatus(message: string, firestoreCode: number | null) {
  if (
    firestoreCode === 8 ||
    /quota exceeded|resource_exhausted|resource exhausted/i.test(message)
  ) {
    return 503;
  }
  if (/not authenticated|authorization|token/i.test(message)) {
    return 401;
  }
  if (/forbidden|outside your coadmin scope/i.test(message)) {
    return 403;
  }
  if (/already|conflict|not available|not pending/i.test(message)) {
    return 409;
  }
  if (/required|valid|not found|blocked|only|enough coin|username|scope/i.test(message)) {
    return 400;
  }
  return 500;
}

function parsePositiveNumber(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed > 0 ? parsed : 0;
}

function normalizeGameName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function passwordDebug(value: unknown) {
  const password = String(value ?? '');
  return {
    passwordPresent: Boolean(password),
    passwordLength: password.length,
    passwordHashPrefix: password
      ? createHash('sha256').update(password, 'utf8').digest('hex').slice(0, 8)
      : '-',
  };
}

function ttlAfterDays(days: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Date.now() + days * DAY_MS);
}

function logPlayerRechargeCreateRequestHeaders(
  request: Request,
  authPath: string | null
) {
  console.info('[PLAYER_RECHARGE_CREATE_REQUEST]', {
    hasAppSessionHeader: Boolean(String(request.headers.get('X-App-Session-Id') || '').trim()),
    hasPlayerSessionHeader: Boolean(
      String(request.headers.get('X-Player-Session-Id') || '').trim()
    ),
    hasAuthorization: Boolean(String(request.headers.get('Authorization') || '').trim()),
    auth_path: authPath,
  });
}

export async function POST(request: Request) {
  const routeStartedAt = Date.now();
  const timing = emptyTiming();
  let playerUid = '';
  let playerGameLoginsSource: RechargeReadSource = 'postgres';
  let gameLoginsSource: RechargeReadSource = 'postgres';
  let firstRechargeSource: RechargeReadSource = 'postgres';
  let authoritySource = 'firestore';
  let maintenanceSource = 'postgres';
  let sharedSqlClient = false;
  let failureStage = 'auth';
  let playerAuthority: RechargePlayerAuthorityRead | null = null;

  logPlayerRechargeCreateRequestHeaders(request, null);

  try {
    failureStage = 'auth';
    const authStartedAt = Date.now();
    const auth = await requireApiUser(request, ['player'], {
      rechargeFirestoreInstrumentation: true,
    });
    timing.auth_ms = Date.now() - authStartedAt;
    if ('response' in auth) {
      logPlayerRechargeCreateRequestHeaders(request, 'denied');
      timing.total_ms = Date.now() - routeStartedAt;
      logRechargeCreateTiming({
        ...timing,
        ok: false,
        error: 'auth_denied',
        error_code: 'auth_denied',
        failure_stage: failureStage,
        firestore_code: null,
        firestore_details: null,
      });
      return auth.response;
    }

    logPlayerRechargeCreateRequestHeaders(request, auth.authPath);
    playerUid = auth.user.uid;

    failureStage = 'maintenance';
    const maintenanceStartedAt = Date.now();
    await rejectIfPlayerMaintenanceBreakFromUser(auth.user, 'recharge');
    timing.maintenance_ms = Date.now() - maintenanceStartedAt;
    maintenanceSource = 'firestore_instrumented_quota_fail_open';

    failureStage = 'body_parse';
    const bodyParseStartedAt = Date.now();
    const body = (await request.json()) as RechargeBody;
    timing.body_parse_ms = Date.now() - bodyParseStartedAt;

    const gameName = String(body.gameName || '').trim();
    const amount = parsePositiveNumber(body.amount);
    const requestedBaseAmount = parsePositiveNumber(body.baseAmount);
    const requestedBonusPercentage = Number(body.bonusPercentage);
    const bonusEventId = String(body.bonusEventId || '').trim() || null;

    if (!gameName) {
      return apiError('Game is required.', 400);
    }
    if (!amount) {
      return apiError('Enter a valid amount.', 400);
    }

    const normalizedGame = normalizeGameName(gameName);
    const previewCoadminUid =
      String(auth.user.coadminUid || '').trim() || String(auth.user.createdBy || '').trim();

    failureStage = 'pre_transaction';
    const preTransactionReads = await loadRechargePreTransactionReads({
      playerUid,
      normalizedGame,
      gameName,
      coadminUid: previewCoadminUid,
    });
    sharedSqlClient = preTransactionReads.sharedSqlClient;
    playerAuthority = preTransactionReads.playerAuthority;

    const playerGameLoginsRead = preTransactionReads.playerGameLogins;
    const firstRechargeRead = preTransactionReads.firstRecharge;
    const gameLoginsRead = preTransactionReads.gameLogins;

    playerGameLoginsSource = playerGameLoginsRead.source;
    firstRechargeSource = firstRechargeRead.source;
    gameLoginsSource = gameLoginsRead.source;
    authoritySource = playerAuthority ? 'postgres' : 'firestore';

    logRechargeSqlSource({
      playerGameLoginsSource,
      gameLoginsSource,
      firstRechargeSource,
      authoritySource,
      maintenanceSource,
      playerSessionSource: auth.authPath,
    });

    timing.sql_player_game_logins_ms = playerGameLoginsRead.sqlMs;
    timing.sql_first_recharge_ms = firstRechargeRead.sqlMs;
    timing.sql_game_logins_ms = gameLoginsRead.sqlMs;
    timing.firestore_fallback_player_game_logins_ms =
      playerGameLoginsRead.firestoreFallbackMs;
    timing.firestore_fallback_first_recharge_ms = firstRechargeRead.firestoreFallbackMs;
    timing.firestore_fallback_game_logins_ms = gameLoginsRead.firestoreFallbackMs;
    timing.game_login_read_ms =
      playerGameLoginsRead.sqlMs +
      playerGameLoginsRead.firestoreFallbackMs +
      gameLoginsRead.sqlMs +
      gameLoginsRead.firestoreFallbackMs;

    const assignedGameUsername = playerGameLoginsRead.assignedGameUsername;
    if (!assignedGameUsername) {
      throw new Error(
        'Game username is not assigned for this game yet. Please create username first.'
      );
    }

    const gameCredential = gameLoginsRead.gameCredential;
    if (normalizeGameName(gameName) === 'vegas_sweeps') {
      console.info('[VEGAS_CREDS_TASK_CREATE]', {
        game: gameName,
        credentialDocId: String(gameCredential?.id || '') || null,
        credentialUsername: String(gameCredential?.username || '').trim() || null,
        ...passwordDebug(gameCredential?.password),
      });
    }

    if (playerAuthority) {
      if (playerAuthority.role !== 'player') {
        throw new Error('Only players can create recharge requests.');
      }
      if (playerAuthority.status === 'disabled') {
        throw new Error('Your account is blocked. Recharge and redeem features are disabled.');
      }
      if (playerAuthority.coin < amount) {
        throw new Error(
          'Not enough coin to request this recharge. Use a lower amount or add coin first.'
        );
      }
    }

    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    if (isAuthoritySqlWriteEnabled()) {
      failureStage = 'authority_transaction';
      const authorityStartedAt = Date.now();
      const result = await createRechargeRequestInSql({
        playerUid,
        gameName,
        amount,
        baseAmount: requestedBaseAmount > 0 ? requestedBaseAmount : null,
        bonusPercentage:
          Number.isFinite(requestedBonusPercentage) && requestedBonusPercentage > 0
            ? requestedBonusPercentage
            : null,
        bonusEventId,
        assignedGameUsername,
        gameCredential,
        previewCoadminUid,
        hasAnyFirstRechargeAppliedRequest: firstRechargeRead.hasAnyFirstRechargeAppliedRequest,
        idempotencyKey,
      });
      timing.authority_transaction_ms = Date.now() - authorityStartedAt;
      timing.total_ms = Date.now() - routeStartedAt;
      logAuthoritySqlWrite('/api/player/game-requests/recharge', {
        playerUid,
        requestId: result.requestId,
        duplicate: result.duplicate,
      });
      logRechargeCreateTiming({
        ...timing,
        ok: true,
        playerUid,
        requestId: result.requestId,
        firestore_code: null,
        firestore_details: null,
        playerGameLoginsSource,
        gameLoginsSource,
        firstRechargeSource,
        shared_sql_client: sharedSqlClient,
      });
      return NextResponse.json({
        success: true,
        requestId: result.requestId,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    const playerRef = adminDb.collection('users').doc(playerUid);
    const requestRef = adminDb.collection('playerGameRequests').doc();
    const taskRef = adminDb.collection('carerTasks').doc(requestLinkedCarerTaskId(requestRef.id));
    const eventRef = adminDb.collection('financialEvents').doc();

    const transactionStartedAt = Date.now();
    failureStage = 'authority_transaction';
    try {
      await adminDb.runTransaction(async (transaction) => {
        const authorityReadsStartedAt = Date.now();
        const firstRechargeMatchPercent = 50;
        const sqlFirstRechargeMatchUsed = playerAuthority?.firstRechargeMatchUsed ?? null;
        const firstRechargeMatchEligible =
          !bonusEventId &&
          !(sqlFirstRechargeMatchUsed ?? false) &&
          !firstRechargeRead.hasAnyFirstRechargeAppliedRequest;

        if (playerAuthority) {
          const existingTaskSnap = await timedRechargeFirestoreRead(
            {
              stage: 'authority_transaction_linked_task',
              collection: 'carerTasks',
              document: requestLinkedCarerTaskId(requestRef.id),
            },
            () => transaction.get(taskRef)
          );
          timing.authority_reads_ms = Date.now() - authorityReadsStartedAt;
          timing.player_profile_ms = playerAuthority.sqlMs;
          timing.balance_read_ms = 0;

          const coadminUid =
            playerAuthority.coadminUid || previewCoadminUid;
          if (!coadminUid) {
            throw new Error('Player coadmin scope not found.');
          }

          const boostedAmount = firstRechargeMatchEligible
            ? Math.round(amount * (1 + firstRechargeMatchPercent / 100))
            : amount;

          const writeStartedAt = Date.now();
          const createdAt = FieldValue.serverTimestamp();
          const requestPayload = {
            playerUid,
            gameName,
            currentUsername: assignedGameUsername,
            gameAccountUsername: assignedGameUsername,
            amount: boostedAmount,
            baseAmount: firstRechargeMatchEligible
              ? amount
              : requestedBaseAmount > 0
                ? requestedBaseAmount
                : null,
            bonusPercentage: firstRechargeMatchEligible
              ? firstRechargeMatchPercent
              : Number.isFinite(requestedBonusPercentage) && requestedBonusPercentage > 0
                ? requestedBonusPercentage
                : null,
            bonusEventId,
            firstRechargeMatchApplied: firstRechargeMatchEligible,
            type: 'recharge',
            status: 'pending',
            createdBy: coadminUid,
            coadminUid,
            createdAt,
            completedAt: null,
            pokedAt: null,
            pokeMessage: null,
            coinDeductedOnRequest: true,
          };

          transaction.update(playerRef, {
            coin: FieldValue.increment(-amount),
          });
          transaction.set(requestRef, requestPayload);

          const carerTaskStartedAt = Date.now();
          if (!existingTaskSnap.exists) {
            console.info('[GAME_REQUEST_API] creating linked carer task', {
              requestId: requestRef.id,
              taskId: taskRef.id,
              type: 'recharge',
            });
            transaction.set(
              taskRef,
              buildPendingRequestLinkedCarerTaskPayload({
                requestId: requestRef.id,
                coadminUid,
                type: 'recharge',
                playerUid,
                playerUsername: playerAuthority.username || 'Player',
                gameName,
                amount: boostedAmount,
                currentUsername: assignedGameUsername,
                createdAt,
                gameCredential,
              })
            );
            console.info('[GAME_REQUEST_API] linked carer task created', {
              requestId: requestRef.id,
              taskId: taskRef.id,
              type: 'recharge',
            });
          }
          timing.carer_task_ms = Date.now() - carerTaskStartedAt;

          const financialEventStartedAt = Date.now();
          transaction.set(eventRef, {
            playerUid,
            coadminUid,
            amountNpr: amount,
            type: 'recharge_request_deduct',
            requestId: requestRef.id,
            createdAt: FieldValue.serverTimestamp(),
            ttlExpiresAt: ttlAfterDays(90),
          });
          timing.financial_event_ms = Date.now() - financialEventStartedAt;
          timing.authority_writes_ms = Date.now() - writeStartedAt;
          timing.request_create_ms = timing.authority_writes_ms;
          return;
        }

        const [playerSnap, existingTaskSnap] = await Promise.all([
          timedRechargeFirestoreRead(
            {
              stage: 'authority_transaction_player_profile',
              collection: 'users',
              document: playerUid,
            },
            () => transaction.get(playerRef)
          ),
          timedRechargeFirestoreRead(
            {
              stage: 'authority_transaction_linked_task',
              collection: 'carerTasks',
              document: requestLinkedCarerTaskId(requestRef.id),
            },
            () => transaction.get(taskRef)
          ),
        ]);
        timing.authority_reads_ms = Date.now() - authorityReadsStartedAt;
        timing.player_profile_ms = timing.authority_reads_ms;

        if (!playerSnap.exists) {
          throw new Error('Player profile not found.');
        }

        const balanceReadStartedAt = Date.now();
        const playerData = playerSnap.data() as {
          role?: string;
          status?: string;
          username?: string | null;
          coin?: number;
          firstRechargeMatchUsed?: boolean | null;
          coadminUid?: string | null;
          createdBy?: string | null;
        };
        timing.balance_read_ms = Date.now() - balanceReadStartedAt;

        if (String(playerData.role || '').toLowerCase() !== 'player') {
          throw new Error('Only players can create recharge requests.');
        }
        if (String(playerData.status || '').toLowerCase() === 'disabled') {
          throw new Error('Your account is blocked. Recharge and redeem features are disabled.');
        }

        const currentCoin = Number(playerData.coin || 0);
        if (currentCoin < amount) {
          throw new Error(
            'Not enough coin to request this recharge. Use a lower amount or add coin first.'
          );
        }

        const firestoreFirstRechargeMatchEligible =
          !bonusEventId &&
          !Boolean(playerData.firstRechargeMatchUsed) &&
          !firstRechargeRead.hasAnyFirstRechargeAppliedRequest;
        const boostedAmount = firestoreFirstRechargeMatchEligible
          ? Math.round(amount * (1 + firstRechargeMatchPercent / 100))
          : amount;

        const coadminUid =
          String(playerData.coadminUid || '').trim() || String(playerData.createdBy || '').trim();
        if (!coadminUid) {
          throw new Error('Player coadmin scope not found.');
        }

        const writeStartedAt = Date.now();
        const createdAt = FieldValue.serverTimestamp();
        const requestPayload = {
          playerUid,
          gameName,
          currentUsername: assignedGameUsername,
          gameAccountUsername: assignedGameUsername,
          amount: boostedAmount,
          baseAmount: firestoreFirstRechargeMatchEligible
            ? amount
            : requestedBaseAmount > 0
              ? requestedBaseAmount
              : null,
          bonusPercentage: firestoreFirstRechargeMatchEligible
            ? firstRechargeMatchPercent
            : Number.isFinite(requestedBonusPercentage) && requestedBonusPercentage > 0
              ? requestedBonusPercentage
              : null,
          bonusEventId,
          firstRechargeMatchApplied: firestoreFirstRechargeMatchEligible,
          type: 'recharge',
          status: 'pending',
          createdBy: coadminUid,
          coadminUid,
          createdAt,
          completedAt: null,
          pokedAt: null,
          pokeMessage: null,
          coinDeductedOnRequest: true,
        };

        transaction.update(playerRef, {
          coin: currentCoin - amount,
        });
        transaction.set(requestRef, requestPayload);

        const carerTaskStartedAt = Date.now();
        if (!existingTaskSnap.exists) {
          console.info('[GAME_REQUEST_API] creating linked carer task', {
            requestId: requestRef.id,
            taskId: taskRef.id,
            type: 'recharge',
          });
          transaction.set(
            taskRef,
            buildPendingRequestLinkedCarerTaskPayload({
              requestId: requestRef.id,
              coadminUid,
              type: 'recharge',
              playerUid,
              playerUsername: String(playerData.username || '').trim() || 'Player',
              gameName,
              amount: boostedAmount,
              currentUsername: assignedGameUsername,
              createdAt,
              gameCredential,
            })
          );
          console.info('[GAME_REQUEST_API] linked carer task created', {
            requestId: requestRef.id,
            taskId: taskRef.id,
            type: 'recharge',
          });
        }
        timing.carer_task_ms = Date.now() - carerTaskStartedAt;

        const financialEventStartedAt = Date.now();
        transaction.set(eventRef, {
          playerUid,
          coadminUid,
          amountNpr: amount,
          type: 'recharge_request_deduct',
          requestId: requestRef.id,
          createdAt: FieldValue.serverTimestamp(),
          ttlExpiresAt: ttlAfterDays(90),
        });
        timing.financial_event_ms = Date.now() - financialEventStartedAt;
        timing.authority_writes_ms = Date.now() - writeStartedAt;
        timing.request_create_ms = timing.authority_writes_ms;
      });
    } finally {
      timing.authority_transaction_ms = Date.now() - transactionStartedAt;
      timing.firestore_transaction_ms = timing.authority_transaction_ms;
    }

    console.info('[GAME_REQUEST_API] request and task committed atomically', {
      requestId: requestRef.id,
      taskId: taskRef.id,
      type: 'recharge',
    });
    const mirrorStartedAt = Date.now();
    void mirrorCarerTaskById(taskRef.id, 'appbeg_recharge_request');
    void mirrorPlayerGameRequestById(requestRef.id, 'appbeg_recharge_request');
    void mirrorFinancialEventById(eventRef.id, 'appbeg_recharge_request');
    void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_recharge_request');
    timing.mirror_ms = Date.now() - mirrorStartedAt;
    timing.sql_mirror_ms = 0;

    timing.total_ms = Date.now() - routeStartedAt;
    logRechargeCreateTiming({
      ...timing,
      ok: true,
      playerUid,
      requestId: requestRef.id,
      firestore_code: null,
      firestore_details: null,
      playerGameLoginsSource,
      gameLoginsSource,
      firstRechargeSource,
      shared_sql_client: sharedSqlClient,
    });

    return NextResponse.json({
      success: true,
      requestId: requestRef.id,
    });
  } catch (error) {
    const { message, firestore_code, firestore_details } = extractFirestoreError(error);
    timing.total_ms = Date.now() - routeStartedAt;

    if (message.startsWith('MAINTENANCE_BREAK:')) {
      logRechargeCreateTiming({
        ...timing,
        ok: false,
        playerUid: playerUid || undefined,
        error: message,
        error_code: 'maintenance_break',
        failure_stage: 'maintenance',
        firestore_code,
        firestore_details,
        playerGameLoginsSource,
        gameLoginsSource,
        firstRechargeSource,
        shared_sql_client: sharedSqlClient,
      });
      return maintenanceBreakApiResponse(message.replace(/^MAINTENANCE_BREAK:/, ''));
    }

    logRechargeCreateTiming({
      ...timing,
      ok: false,
      playerUid: playerUid || undefined,
      error: message,
      error_code:
        firestore_code === 8
          ? 'RESOURCE_EXHAUSTED'
          : message.includes('Player profile not found')
            ? 'firestore_user_missing'
            : 'recharge_create_failed',
      failure_stage: failureStage,
      firestore_code,
      firestore_details,
      playerGameLoginsSource,
      gameLoginsSource,
      firstRechargeSource,
      shared_sql_client: sharedSqlClient,
    });

    const status = resolveHttpStatus(message, firestore_code);
    return NextResponse.json({ error: message }, { status });
  }
}

