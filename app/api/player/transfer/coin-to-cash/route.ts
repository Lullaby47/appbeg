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
  getCoinToCashTip,
  parsePositiveInteger,
  parseTransferId,
} from '@/lib/server/playerTransferRules';
import { mapAuthorityTransferSqlError, transferCoinToCashInSql } from '@/lib/sql/authorityTransfer';
import { getPlayerMirrorPoolStats } from '@/lib/sql/playerMirrorCommon';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/transfer/coin-to-cash';
const COIN_TO_CASH_COOLDOWN_MS = 30 * 60_000;

type Body = {
  amountCoins?: unknown;
  transferId?: unknown;
  idempotencyKey?: unknown;
};

function firestoreMillis(value: unknown) {
  if (!value) return 0;
  if (typeof value === 'object' && 'toMillis' in value) {
    const millis = (value as { toMillis?: () => number }).toMillis?.();
    return Number.isFinite(millis) ? Number(millis) : 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string') {
    const millis = Date.parse(value);
    return Number.isNaN(millis) ? 0 : millis;
  }
  return 0;
}

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
    const amountCoins = parsePositiveInteger(body.amountCoins);
    const transferId = parseTransferId(body.transferId);
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() ||
      transferId ||
      null;

    if (!amountCoins) {
      return apiError('Amount must be a positive whole number.', 400);
    }
    if (amountCoins < 10) {
      return apiError('Minimum Coin to Cash amount is 10.', 400);
    }
    if (!transferId) {
      return apiError('Transfer id is required.', 400);
    }

    const tipAmount = getCoinToCashTip(amountCoins);
    const cashReceived = amountCoins - tipAmount;
    if (cashReceived <= 0) {
      return apiError('Transfer amount is too low after tip.', 400);
    }

    if (isAuthoritySqlWriteEnabled()) {
      await rejectIfPlayerMaintenanceBreakFromUser(auth.user, 'coin_to_cash');

      console.info('[TRANSFER_SQL_AUTHORITY_START]', {
        route: ROUTE,
        playerUid: auth.user.uid,
        transferId,
        amountCoins,
      });
      const result = await transferCoinToCashInSql({
        playerUid: auth.user.uid,
        amountCoins,
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
        cashReceived: result.cashReceived,
        transferId: result.transferId,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    if (isAppbegSqlOnlyMode()) {
      logAuthorityFirestoreFallbackBlocked(ROUTE, 'coin_to_cash_transfer', {
        playerUid: auth.user.uid,
        transferId,
      });
      console.info('[FIREBASE_RUNTIME_BLOCKED]', {
        route: ROUTE,
        operation: 'coin_to_cash_transfer',
        playerUid: auth.user.uid,
        reason: 'sql_only_authority_required',
      });
      return apiError('SQL transfer authority is not enabled. Set AUTHORITY_SQL_WRITE=1.', 503);
    }

    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'coin_to_cash');

    const playerUid = auth.user.uid;
    const playerRef = adminDb.collection('users').doc(playerUid);
    const eventRef = adminDb.collection('financialEvents').doc(`coinToCash_${playerUid}_${transferId}`);
    let newCash = 0;
    let newCoin = 0;

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
        throw new Error('Only players can transfer coin to cash.');
      }

      if (String(playerData.status || '').toLowerCase() === 'disabled') {
        throw new Error('Your account is blocked.');
      }

      const blockedUntilMs = playerData.transferBlockedUntil?.toMillis?.() || 0;
      if (blockedUntilMs > Date.now()) {
        throw new Error('Transfer is temporarily blocked. Contact staff.');
      }

      const transferHistorySnap = await transaction.get(
        adminDb.collection('financialEvents').where('playerUid', '==', playerUid)
      );
      let lastTransferAtMs = 0;
      transferHistorySnap.forEach((eventDoc) => {
        const event = eventDoc.data() as {
          type?: string;
          deletedAt?: unknown;
          deleted_at?: unknown;
          createdAt?: unknown;
          timestamp?: unknown;
        };
        if (
          event.type !== 'coin_to_cash_transfer' ||
          event.deletedAt ||
          event.deleted_at
        ) {
          return;
        }
        const createdAtMs =
          firestoreMillis(event.createdAt) || firestoreMillis(event.timestamp);
        if (createdAtMs > lastTransferAtMs) {
          lastTransferAtMs = createdAtMs;
        }
      });

      const remainingWaitMs = COIN_TO_CASH_COOLDOWN_MS - (Date.now() - lastTransferAtMs);
      if (lastTransferAtMs > 0 && remainingWaitMs > 0) {
        console.info('[COIN_TO_CASH_TRANSFER_BLOCKED]', {
          uid: playerUid,
          amount: amountCoins,
          lastTransferAt: new Date(lastTransferAtMs).toISOString(),
          remainingWaitMs,
        });
        throw new Error(
          'You can transfer again 30 minutes after your last coin-to-cash transfer.'
        );
      }

      const currentCash = Math.max(0, Number(playerData.cash || 0));
      const currentCoin = Math.max(0, Number(playerData.coin || 0));
      if (currentCoin < amountCoins) {
        throw new Error('Not enough coin available for transfer.');
      }

      const coadminUid = String(playerData.coadminUid || playerData.createdBy || '').trim() || null;
      const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid || '');
      if (maintenanceBreak.enabled) {
        console.info('[MAINTENANCE] blocked player action', {
          action: 'coin_to_cash',
          playerUid,
          coadminUid,
        });
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }

      newCoin = currentCoin - amountCoins;
      newCash = currentCash + cashReceived;

      transaction.update(playerRef, {
        cash: newCash,
        coin: newCoin,
      });

      transaction.set(eventRef, {
        playerUid,
        playerId: playerUid,
        coadminUid,
        transferAmount: amountCoins,
        amountCoins,
        feeAmount: tipAmount,
        tipAmount,
        tipNpr: tipAmount,
        cashReceived,
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
        type: 'coin_to_cash_transfer',
        timestamp: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    void mirrorFinancialEventById(eventRef.id, 'appbeg_coin_to_cash_transfer');
    void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_coin_to_cash_transfer');
    return NextResponse.json({
      success: true,
      cash: newCash,
      coin: newCoin,
      transferAmount: amountCoins,
      feeAmount: tipAmount,
      tipAmount,
      cashReceived,
      transferId,
      authority: 'firestore',
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Failed to transfer coin to cash.';
    console.info('[TRANSFER_SQL_AUTHORITY_ERROR]', {
      route: ROUTE,
      error: rawMessage,
    });
    const mappedSqlMessage = mapAuthorityTransferSqlError(error);
    const message = /not authenticated|authorization|token|session/i.test(rawMessage)
      ? 'Session expired. Please refresh or log in again.'
      : mappedSqlMessage !== rawMessage
        ? mappedSqlMessage
        : /not enough coin/i.test(rawMessage)
          ? 'Not enough coin balance.'
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
          : /required|valid|not found|only|amount|coin|transfer/i.test(rawMessage)
            ? 400
            : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
