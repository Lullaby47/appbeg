import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requirePlayerApiUser } from '@/lib/firebase/apiAuth';
import { logPlayerApiAuthOk } from '@/lib/server/playerApiAuthLog';
import { logRouteSessionValidation, sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';
import {
  getCoadminMaintenanceBreak,
  maintenanceBreakApiResponse,
  rejectIfPlayerMaintenanceBreak,
  rejectIfPlayerMaintenanceBreakFromUser,
} from '@/lib/maintenance/admin';
import {
  authoritySqlWriteEnvLogFields,
  isAuthoritySqlWriteEnabled,
  logAuthorityFirestoreFallbackBlocked,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { isAppbegSqlOnlyMode } from '@/lib/server/appbegSqlOnlyMode';
import {
  getCashToCoinFee,
  parsePositiveInteger,
  parseTransferId,
} from '@/lib/server/playerTransferRules';
import { mapAuthorityTransferSqlError, transferCashToCoinInSql } from '@/lib/sql/authorityTransfer';
import { getPlayerMirrorPoolStats } from '@/lib/sql/playerMirrorCommon';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/transfer/cash-to-coin';
const CASH_TO_COIN_MAX_TRANSFER_AMOUNT = 25;
const CASH_TO_COIN_COOLDOWN_MINUTES = 10;
const CASH_TO_COIN_DAILY_LIMIT = 300;

function firestoreMillis(value: unknown) {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    const millis = (value as { toMillis?: () => number }).toMillis?.();
    return Number.isFinite(millis) ? Number(millis) : 0;
  }
  const parsed = new Date(String(value || '')).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

type Body = {
  amountNpr?: unknown;
  transferId?: unknown;
  idempotencyKey?: unknown;
};

export async function POST(request: Request) {
  const headerSessions = sessionIdsFromRequest(request);
  try {
    console.info('[TRANSFER_API_START]', {
      route: ROUTE,
      ...headerSessions,
      canonicalSessionId: headerSessions.player_session_id,
    });
    console.info('[TRANSFER_AUTH_BEGIN]', {
      route: ROUTE,
      ...headerSessions,
      canonicalSessionId: headerSessions.player_session_id,
    });
    const auth = await requirePlayerApiUser(request);
    if ('response' in auth) {
      console.info('[TRANSFER_AUTH_FAILED]', {
        route: ROUTE,
        uid: null,
        ...headerSessions,
        canonicalSessionId: headerSessions.player_session_id,
        activeSessionId: auth.timing.active_session_id ?? null,
        auth_path: auth.timing.auth_path,
        reason: 'requirePlayerApiUser_denied',
        status: auth.response.status,
      });
      logRouteSessionValidation(ROUTE, {
        ok: false,
        ...headerSessions,
        canonical_session_id: headerSessions.player_session_id,
        validates: 'player_session_sql',
        auth_path: auth.timing.auth_path,
        session_source: auth.timing.session_source,
      });
      return auth.response;
    }
    console.info('[TRANSFER_AUTH_OK]', {
      route: ROUTE,
      uid: auth.user.uid,
      ...headerSessions,
      canonicalSessionId: auth.timing.request_session_id ?? headerSessions.player_session_id,
      activeSessionId: auth.timing.active_session_id ?? null,
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
      status: 200,
    });
    logRouteSessionValidation(ROUTE, {
      ok: true,
      ...headerSessions,
      canonical_session_id: auth.timing.request_session_id ?? headerSessions.player_session_id,
      validates: 'player_session_sql',
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
      uid: auth.user.uid,
    });
    logPlayerApiAuthOk(request, {
      route: ROUTE,
      uid: auth.user.uid,
      role: auth.user.role,
      authPath: auth.authPath,
    });

    const body = (await request.json()) as Body;
    const amountNpr = parsePositiveInteger(body.amountNpr);
    const transferId = parseTransferId(body.transferId);
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() ||
      transferId ||
      null;

    if (!amountNpr) {
      return apiError('Amount must be a positive whole number.', 400);
    }
    if (!transferId) {
      return apiError('Transfer id is required.', 400);
    }
    if (amountNpr > CASH_TO_COIN_MAX_TRANSFER_AMOUNT) {
      return apiError('Maximum transfer amount is $25.', 400);
    }

    const feeAmount = getCashToCoinFee(amountNpr);
    const coinsReceived = amountNpr - feeAmount;
    if (coinsReceived <= 0) {
      return apiError('Transfer amount is too low after fee.', 400);
    }

    if (isAuthoritySqlWriteEnabled()) {
      await rejectIfPlayerMaintenanceBreakFromUser(auth.user, 'cash_to_coin');

      console.info('[TRANSFER_SQL_AUTHORITY_START]', {
        route: ROUTE,
        playerUid: auth.user.uid,
        transferId,
        amountNpr,
      });
      const result = await transferCashToCoinInSql({
        playerUid: auth.user.uid,
        amountNpr,
        transferId,
        idempotencyKey,
      });
      const poolStats = getPlayerMirrorPoolStats();

      logAuthoritySqlWrite(ROUTE, {
        ...authoritySqlWriteEnvLogFields(),
        playerUid: auth.user.uid,
        transferId,
        duplicate: result.duplicate,
        transferAmount: result.transferAmount,
        route: ROUTE,
        pool_totalCount: poolStats?.totalCount ?? null,
        pool_idleCount: poolStats?.idleCount ?? null,
        pool_waitingCount: poolStats?.waitingCount ?? null,
        pool_max: poolStats?.max ?? null,
      });
      console.info('[TRANSFER_SQL_AUTHORITY_SUCCESS]', {
        route: ROUTE,
        playerUid: auth.user.uid,
        transferId,
        duplicate: result.duplicate,
        cash: result.cash,
        coin: result.coin,
      });

      return NextResponse.json({
        success: true,
        cash: result.cash,
        coin: result.coin,
        transferAmount: result.transferAmount,
        feeAmount: result.feeAmount,
        tipAmount: result.tipAmount,
        coinsReceived: result.coinsReceived,
        transferId: result.transferId,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    if (isAppbegSqlOnlyMode()) {
      logAuthorityFirestoreFallbackBlocked(ROUTE, 'cash_to_coin_transfer', {
        playerUid: auth.user.uid,
        transferId,
      });
      console.info('[FIREBASE_RUNTIME_BLOCKED]', {
        route: ROUTE,
        operation: 'cash_to_coin_transfer',
        playerUid: auth.user.uid,
        reason: 'sql_only_authority_required',
      });
      return apiError('SQL transfer authority is not enabled. Set AUTHORITY_SQL_WRITE=1.', 503);
    }

    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'cash_to_coin');

    const playerUid = auth.user.uid;
    const playerRef = adminDb.collection('users').doc(playerUid);
    const eventRef = adminDb.collection('financialEvents').doc(`cashToCoin_${playerUid}_${transferId}`);
    let newCash = 0;
    let newCoin = 0;

    const nowMs = Date.now();
    const cooldownWindowStartMs = nowMs - CASH_TO_COIN_COOLDOWN_MINUTES * 60_000;
    const dailyWindowStartMs = nowMs - 24 * 60 * 60_000;
    const transferHistory = await adminDb
      .collection('financialEvents')
      .where('playerUid', '==', playerUid)
      .get();
    const cashToCoinHistory = transferHistory.docs
      .map((docSnap) => {
        const data = docSnap.data();
        return {
          type: String(data.type || ''),
          transferAmount: data.transferAmount,
          amountNpr: data.amountNpr,
          createdAtMs: firestoreMillis(data.createdAt || data.timestamp),
        };
      })
      .filter((event) => event.type === 'cash_to_coin_transfer');
    const recentTransfers = cashToCoinHistory
      .filter((event) => event.createdAtMs > cooldownWindowStartMs)
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
    if (recentTransfers.length) {
      const elapsedMs = nowMs - recentTransfers[0].createdAtMs;
      const remainingMs = CASH_TO_COIN_COOLDOWN_MINUTES * 60_000 - elapsedMs;
      const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
      return apiError(`Another transfer is available in ${minutes} minutes.`, 400);
    }

    const dailyTotal = cashToCoinHistory
      .filter((event) => event.createdAtMs > dailyWindowStartMs)
      .reduce(
      (sum, event) => sum + Math.max(0, Number(event.transferAmount || event.amountNpr || 0)),
      0
    );
    if (dailyTotal + amountNpr > CASH_TO_COIN_DAILY_LIMIT) {
      return apiError('Daily transfer limit reached.', 400);
    }

    await adminDb.runTransaction(async (transaction) => {
      const existingEventSnap = await transaction.get(eventRef);
      if (existingEventSnap.exists) {
        throw new Error('Duplicate transfer id.');
      }

      const playerSnap = await transaction.get(playerRef);
      if (!playerSnap.exists) {
        throw new Error('Player profile not found.');
      }

      const playerData = playerSnap.data() as {
        role?: string;
        status?: string;
        cash?: number;
        coin?: number;
        transferBlockedUntil?: { toMillis?: () => number } | null;
        coadminUid?: string | null;
        createdBy?: string | null;
      };

      if (String(playerData.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can transfer cash to coin.');
      }

      if (String(playerData.status || '').toLowerCase() === 'disabled') {
        throw new Error('Your account is blocked.');
      }

      const blockedUntilMs = playerData.transferBlockedUntil?.toMillis?.() || 0;
      if (blockedUntilMs > Date.now()) {
        throw new Error('Transfer is temporarily blocked. Contact staff.');
      }

      const currentCash = Math.max(0, Number(playerData.cash || 0));
      const currentCoin = Math.max(0, Number(playerData.coin || 0));
      if (currentCash < amountNpr) {
        throw new Error('Not enough cash available for transfer.');
      }

      const coadminUid = String(playerData.coadminUid || playerData.createdBy || '').trim() || null;
      const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid || '');
      if (maintenanceBreak.enabled) {
        console.info('[MAINTENANCE] blocked player action', {
          action: 'cash_to_coin',
          playerUid,
          coadminUid,
        });
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }

      newCash = currentCash - amountNpr;
      newCoin = currentCoin + coinsReceived;

      transaction.update(playerRef, {
        cash: newCash,
        coin: newCoin,
      });

      transaction.set(eventRef, {
        playerUid,
        playerId: playerUid,
        coadminUid,
        transferAmount: amountNpr,
        amountNpr,
        feeAmount,
        netCoinAmount: coinsReceived,
        tipAmount: 0,
        tipNpr: 0,
        coinsReceived,
        beforeCash: currentCash,
        afterCash: newCash,
        beforeCoins: currentCoin,
        afterCoins: newCoin,
        beforeCoin: currentCoin,
        afterCoin: newCoin,
        beforeBalances: {
          cash: currentCash,
          coin: currentCoin,
        },
        afterBalances: {
          cash: newCash,
          coin: newCoin,
        },
        transferId,
        type: 'cash_to_coin_transfer',
        timestamp: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    void mirrorFinancialEventById(eventRef.id, 'appbeg_cash_to_coin_transfer');
    void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_cash_to_coin_transfer');
    return NextResponse.json({
      success: true,
      cash: newCash,
      coin: newCoin,
      transferAmount: amountNpr,
      feeAmount,
      tipAmount: 0,
      coinsReceived,
      transferId,
      authority: 'firestore',
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Failed to transfer cash to coin.';
    console.info('[TRANSFER_SQL_AUTHORITY_ERROR]', {
      route: ROUTE,
      error: rawMessage,
    });
    const mappedSqlMessage = mapAuthorityTransferSqlError(error);
    const message = /not authenticated|authorization|token|session/i.test(rawMessage)
      ? 'Session expired. Please refresh or log in again.'
      : mappedSqlMessage !== rawMessage
        ? mappedSqlMessage
        : /not enough cash/i.test(rawMessage)
          ? 'Not enough cash balance.'
          : /could not determine data type|parameter \$\d+/i.test(rawMessage)
            ? 'Transfer fee could not be calculated. Please try again.'
            : rawMessage;
    if (message.startsWith('MAINTENANCE_BREAK:')) {
      return maintenanceBreakApiResponse(message.replace(/^MAINTENANCE_BREAK:/, ''));
    }
    const status = /not authenticated|authorization|token|session/i.test(rawMessage)
      ? 401
      : /forbidden|blocked/i.test(rawMessage)
        ? 403
        : /duplicate|already/i.test(rawMessage)
          ? 409
          : /required|valid|not found|only|amount|cash|transfer|limit|available/i.test(rawMessage)
            ? 400
            : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
