import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  getCoadminMaintenanceBreak,
  maintenanceBreakApiResponse,
  rejectIfPlayerMaintenanceBreak,
} from '@/lib/maintenance/admin';
import {
  buildPendingRequestLinkedCarerTaskPayload,
  findRequestLinkedGameCredential,
  requestLinkedCarerTaskId,
} from '@/lib/games/requestLinkedCarerTask';

type RechargeBody = {
  gameName?: unknown;
  amount?: unknown;
  baseAmount?: unknown;
  bonusPercentage?: unknown;
  bonusEventId?: unknown;
};

function parsePositiveNumber(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed > 0 ? parsed : 0;
}

function normalizeGameName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function ttlAfterDays(days: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Date.now() + days * DAY_MS);
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;
    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'recharge');

    const body = (await request.json()) as RechargeBody;
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

    const playerUid = auth.user.uid;
    const normalizedGame = normalizeGameName(gameName);
    const playerRef = adminDb.collection('users').doc(playerUid);
    const requestRef = adminDb.collection('playerGameRequests').doc();
    const taskRef = adminDb.collection('carerTasks').doc(requestLinkedCarerTaskId(requestRef.id));

    await adminDb.runTransaction(async (transaction) => {
      const [playerSnap, loginSnap, firstRechargeAppliedSnap, existingTaskSnap] = await Promise.all([
        transaction.get(playerRef),
        adminDb
          .collection('playerGameLogins')
          .where('playerUid', '==', playerUid)
          .get(),
        adminDb
          .collection('playerGameRequests')
          .where('playerUid', '==', playerUid)
          .where('type', '==', 'recharge')
          .where('firstRechargeMatchApplied', '==', true)
          .get(),
        transaction.get(taskRef),
      ]);

      if (!playerSnap.exists) {
        throw new Error('Player profile not found.');
      }

      const playerData = playerSnap.data() as {
        role?: string;
        status?: string;
        username?: string | null;
        coin?: number;
        firstRechargeMatchUsed?: boolean | null;
        coadminUid?: string | null;
        createdBy?: string | null;
      };
      if (String(playerData.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can create recharge requests.');
      }
      if (String(playerData.status || '').toLowerCase() === 'disabled') {
        throw new Error('Your account is blocked. Recharge and redeem features are disabled.');
      }

      const assignedLogin = loginSnap.docs
        .map((docSnap) => docSnap.data() as { gameName?: string; gameUsername?: string })
        .find((row) => {
          return (
            normalizeGameName(String(row.gameName || '')) === normalizedGame &&
            String(row.gameUsername || '').trim().length > 0
          );
        });
      const assignedGameUsername = String(assignedLogin?.gameUsername || '').trim();
      if (!assignedGameUsername) {
        throw new Error(
          'Game username is not assigned for this game yet. Please create username first.'
        );
      }

      const currentCoin = Number(playerData.coin || 0);
      if (currentCoin < amount) {
        throw new Error(
          'Not enough coin to request this recharge. Use a lower amount or add coin first.'
        );
      }

      const hasAnyFirstRechargeAppliedRequest = firstRechargeAppliedSnap.docs.some((docSnap) => {
        const status = String((docSnap.data() as { status?: string }).status || '').toLowerCase();
        return status !== 'failed' && status !== 'dismissed';
      });
      const firstRechargeMatchPercent = 50;
      const firstRechargeMatchEligible =
        !bonusEventId &&
        !Boolean(playerData.firstRechargeMatchUsed) &&
        !hasAnyFirstRechargeAppliedRequest;
      const boostedAmount = firstRechargeMatchEligible
        ? Math.round(amount * (1 + firstRechargeMatchPercent / 100))
        : amount;

      const coadminUid =
        String(playerData.coadminUid || '').trim() || String(playerData.createdBy || '').trim();
      if (!coadminUid) {
        throw new Error('Player coadmin scope not found.');
      }
      const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid);
      if (maintenanceBreak.enabled) {
        console.info('[MAINTENANCE] blocked recharge request', { playerUid, coadminUid });
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }
      const [coadminGameSnap, legacyGameSnap] = await Promise.all([
        adminDb.collection('gameLogins').where('coadminUid', '==', coadminUid).get(),
        adminDb.collection('gameLogins').where('createdBy', '==', coadminUid).get(),
      ]);
      const gameCredential = findRequestLinkedGameCredential(
        [...coadminGameSnap.docs, ...legacyGameSnap.docs].map((docSnap) => docSnap.data()),
        gameName
      );
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
        coin: currentCoin - amount,
      });
      transaction.set(requestRef, requestPayload);
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
      transaction.set(adminDb.collection('financialEvents').doc(), {
        playerUid,
        coadminUid,
        amountNpr: amount,
        type: 'recharge_request_deduct',
        requestId: requestRef.id,
        createdAt: FieldValue.serverTimestamp(),
        ttlExpiresAt: ttlAfterDays(90),
      });
    });
    console.info('[GAME_REQUEST_API] request and task committed atomically', {
      requestId: requestRef.id,
      taskId: taskRef.id,
      type: 'recharge',
    });

    return NextResponse.json({
      success: true,
      requestId: requestRef.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create recharge request.';
    if (message.startsWith('MAINTENANCE_BREAK:')) {
      return maintenanceBreakApiResponse(message.replace(/^MAINTENANCE_BREAK:/, ''));
    }
    const status =
      /not authenticated|authorization|token/i.test(message)
        ? 401
        : /forbidden|outside your coadmin scope/i.test(message)
          ? 403
          : /already|conflict|not available|not pending/i.test(message)
            ? 409
            : /required|valid|not found|blocked|only/i.test(message)
              ? 400
              : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

