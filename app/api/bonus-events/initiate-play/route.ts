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

function getStaffBonusMultiplier(bonusPercent: number) {
  if (bonusPercent <= 8) return 1.0;
  if (bonusPercent <= 20) return 0.5;
  if (bonusPercent <= 30) return 0.2;
  return 0;
}

type Body = { bonusEventId?: unknown };

function normalizeGameName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;
    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'bonus_event');
    const body = (await request.json()) as Body;
    const bonusEventId = String(body.bonusEventId || '').trim();
    if (!bonusEventId) return apiError('bonusEventId is required.', 400);

    const playerUid = auth.user.uid;
    const playerRef = adminDb.collection('users').doc(playerUid);
    const bonusRef = adminDb.collection('bonusEvents').doc(bonusEventId);
    const requestRef = adminDb.collection('playerGameRequests').doc();
    const taskRef = adminDb.collection('carerTasks').doc(requestLinkedCarerTaskId(requestRef.id));

    await adminDb.runTransaction(async (transaction) => {
      const [playerSnap, bonusSnap, loginSnap, existingTaskSnap] = await Promise.all([
        transaction.get(playerRef),
        transaction.get(bonusRef),
        adminDb.collection('playerGameLogins').where('playerUid', '==', playerUid).get(),
        transaction.get(taskRef),
      ]);
      if (!playerSnap.exists) throw new Error('Player profile not found.');
      if (!bonusSnap.exists) {
        throw new Error(
          'This bonus was already claimed by another player or is no longer available.'
        );
      }

      const player = playerSnap.data() as {
        role?: string;
        username?: string | null;
        coin?: number;
        coadminUid?: string | null;
        createdBy?: string | null;
        bonusBlockedUntil?: FirebaseFirestore.Timestamp | null;
      };
      if (String(player.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can start bonus event play.');
      }
      const playerCoadminUid =
        String(player.coadminUid || '').trim() || String(player.createdBy || '').trim();
      if (!playerCoadminUid) {
        throw new Error('Player coadmin scope not found.');
      }
      if ((player.bonusBlockedUntil?.toMillis?.() || 0) > Date.now()) {
        throw new Error('Bonus play is temporarily blocked for this account.');
      }

      const bonus = bonusSnap.data() as {
        coadminUid?: string;
        gameName?: string;
        bonusName?: string;
        amountNpr?: number;
        bonusPercentage?: number;
        createdByRole?: string;
        createdByUid?: string;
      };
      const baseAmount = Number(bonus.amountNpr || 0);
      const bonusPercent = Number(bonus.bonusPercentage || 0);
      if (baseAmount <= 0) throw new Error('Bonus event amount is invalid.');
      if (bonusPercent <= 0 || bonusPercent > 50) {
        throw new Error('Bonus event percentage is invalid.');
      }
      const currentCoins = Number(player.coin || 0);
      if (currentCoins < baseAmount) {
        throw new Error('Low coins: cannot initiate this bonus event.');
      }

      const bonusAddAmount = Math.max(1, Math.round((baseAmount * bonusPercent) / 100));
      const boostedAmount = baseAmount + bonusAddAmount;
      const coadminUid = String(bonus.coadminUid || '').trim();
      const gameName = String(bonus.gameName || '').trim();
      if (!coadminUid) throw new Error('Bonus event coadmin scope missing.');
      if (coadminUid !== playerCoadminUid) {
        throw new Error('Forbidden: bonus event is outside your coadmin scope.');
      }
      const maintenanceBreak = await getCoadminMaintenanceBreak(playerCoadminUid);
      if (maintenanceBreak.enabled) {
        console.info('[MAINTENANCE] blocked player action', {
          action: 'bonus_event',
          playerUid,
          coadminUid: playerCoadminUid,
        });
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }
      const assignedLogin = loginSnap.docs
        .map((docSnap) => docSnap.data() as { gameName?: string; gameUsername?: string })
        .find(
          (row) =>
            normalizeGameName(String(row.gameName || '')) === normalizeGameName(gameName) &&
            String(row.gameUsername || '').trim().length > 0
        );
      const assignedGameUsername = String(assignedLogin?.gameUsername || '').trim();
      const [coadminGameSnap, legacyGameSnap] = await Promise.all([
        adminDb.collection('gameLogins').where('coadminUid', '==', coadminUid).get(),
        adminDb.collection('gameLogins').where('createdBy', '==', coadminUid).get(),
      ]);
      const gameCredential = findRequestLinkedGameCredential(
        [...coadminGameSnap.docs, ...legacyGameSnap.docs].map((docSnap) => docSnap.data()),
        gameName
      );
      const createdAt = FieldValue.serverTimestamp();

      if (String(bonus.createdByRole || '').toLowerCase() === 'staff') {
        const staffRef = adminDb.collection('users').doc(String(bonus.createdByUid || '').trim());
        const staffSnap = await transaction.get(staffRef);
        const staffData = staffSnap.exists
          ? (staffSnap.data() as { cashBoxNpr?: number })
          : { cashBoxNpr: 0 };
        const normalizedAmount = Math.max(1, baseAmount) / 1000;
        const amountFactor = Math.min(3.5, 0.6 + Math.log10(normalizedAmount + 1) * 2.2);
        const percentPenalty = Math.max(0.25, 1.2 - bonusPercent / 60);
        const randomVariance = 0.9 + Math.random() * 0.3;
        const rawReward = amountFactor * percentPenalty * randomVariance;
        const multiplier = getStaffBonusMultiplier(bonusPercent);
        const minReward = bonusPercent <= 8 ? 0.2 : 0;
        const reward = multiplier === 0 ? 0 : Number(Math.max(minReward, rawReward * multiplier).toFixed(2));
        transaction.set(
          staffRef,
          { cashBoxNpr: Number(staffData.cashBoxNpr || 0) + reward },
          { merge: true }
        );
      }

      transaction.update(playerRef, {
        coin: currentCoins - baseAmount,
        activeBonusEventId: bonusEventId,
        activeBonusStaffUid:
          String(bonus.createdByRole || '').toLowerCase() === 'staff'
            ? String(bonus.createdByUid || '').trim()
            : null,
        activeBonusEventName: String(bonus.bonusName || '').trim() || null,
        activeBonusGameName: String(bonus.gameName || '').trim() || null,
        activeBonusAmountNpr: baseAmount,
        activeBonusPercentage: bonusPercent,
      });
      transaction.set(requestRef, {
        playerUid,
        gameName,
        amount: boostedAmount,
        baseAmount,
        bonusPercentage: bonusPercent,
        bonusEventId,
        type: 'recharge',
        status: 'pending',
        createdBy: coadminUid,
        coadminUid,
        createdAt,
        completedAt: null,
        pokedAt: null,
        pokeMessage: null,
        coinDeductedOnRequest: true,
      });
      if (!existingTaskSnap.exists) {
        console.info('[GAME_REQUEST_API][BONUS] creating linked carer task', {
          requestId: requestRef.id,
          taskId: taskRef.id,
          type: 'recharge',
          bonusEventId,
        });
        transaction.set(
          taskRef,
          buildPendingRequestLinkedCarerTaskPayload({
            requestId: requestRef.id,
            coadminUid,
            type: 'recharge',
            playerUid,
            playerUsername: String(player.username || '').trim() || 'Player',
            gameName,
            amount: boostedAmount,
            currentUsername: assignedGameUsername,
            createdAt,
            gameCredential,
          })
        );
        console.info('[GAME_REQUEST_API][BONUS] linked carer task created', {
          requestId: requestRef.id,
          taskId: taskRef.id,
          type: 'recharge',
          bonusEventId,
        });
      } else {
        console.info('[GAME_REQUEST_API][BONUS] linked carer task already exists, skipped', {
          requestId: requestRef.id,
          taskId: taskRef.id,
          type: 'recharge',
          bonusEventId,
        });
      }
      transaction.set(adminDb.collection('financialEvents').doc(), {
        playerUid,
        coadminUid,
        amountNpr: bonusAddAmount,
        type: 'bonus',
        bonusEventId,
        requestId: requestRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.delete(bonusRef);
    });
    console.info('[GAME_REQUEST_API][BONUS] request/task/financial event committed atomically', {
      requestId: requestRef.id,
      taskId: taskRef.id,
      type: 'recharge',
      bonusEventId,
    });

    return NextResponse.json({ success: true, requestId: requestRef.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initiate bonus play.';
    if (message.startsWith('MAINTENANCE_BREAK:')) {
      return maintenanceBreakApiResponse(message.replace(/^MAINTENANCE_BREAK:/, ''));
    }
    const status = /not authenticated|authorization|token/i.test(message) ? 401 : /forbidden/i.test(message) ? 403 : /required|not found|invalid|low coins|only|blocked/i.test(message) ? 400 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

