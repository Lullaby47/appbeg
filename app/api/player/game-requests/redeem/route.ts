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

const MIN_REDEEM_AMOUNT = 50;
const MAX_REDEEM_AMOUNT = 350;
const PLAYER_GAME_REDEEM_MAX_PER_24H = 350;
const PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

type RedeemBody = {
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

async function fetchRolling24hRedeemUsageForPlayerGame(
  playerUid: string,
  gameName: string
): Promise<number> {
  const normalizedGame = normalizeGameName(gameName);
  const sinceMillis = Date.now() - PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS;
  const snapshot = await adminDb
    .collection('playerGameRequests')
    .where('playerUid', '==', playerUid)
    .where('type', '==', 'redeem')
    .where('createdAt', '>=', new Date(sinceMillis))
    .get();

  let total = 0;
  snapshot.forEach((docSnap) => {
    const data = docSnap.data() as {
      gameName?: string;
      status?: string;
      amount?: number;
    };
    if (normalizeGameName(String(data.gameName || '')) !== normalizedGame) return;
    const status = String(data.status || '').toLowerCase();
    if (status === 'failed' || status === 'dismissed') return;
    total += Math.max(0, Number(data.amount || 0));
  });
  return total;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;
    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'redeem');

    const body = (await request.json()) as RedeemBody;
    const gameName = String(body.gameName || '').trim();
    const amount = parsePositiveNumber(body.amount);

    if (!gameName) {
      return apiError('Game is required.', 400);
    }
    if (!amount) {
      return apiError('Enter a valid amount.', 400);
    }
    if (amount < MIN_REDEEM_AMOUNT || amount > MAX_REDEEM_AMOUNT) {
      return apiError(`Redeem amount must be between ${MIN_REDEEM_AMOUNT} and ${MAX_REDEEM_AMOUNT}.`, 400);
    }

    const playerUid = auth.user.uid;
    const rollingRedeemUsed = await fetchRolling24hRedeemUsageForPlayerGame(playerUid, gameName);
    const redeemRemaining = Math.max(0, PLAYER_GAME_REDEEM_MAX_PER_24H - rollingRedeemUsed);
    if (redeemRemaining <= 0) {
      return apiError(
        `Redeem limit for ${gameName} is ${PLAYER_GAME_REDEEM_MAX_PER_24H} per rolling 24 hours. Wait until older redeems expire from this game window before redeeming again.`,
        400
      );
    }
    if (amount > redeemRemaining) {
      return apiError(
        `Only ${redeemRemaining} redeem is left for ${gameName} in this rolling 24-hour window.`,
        400
      );
    }

    const playerRef = adminDb.collection('users').doc(playerUid);
    const requestRef = adminDb.collection('playerGameRequests').doc();
    const taskRef = adminDb.collection('carerTasks').doc(requestLinkedCarerTaskId(requestRef.id));
    const normalizedGame = normalizeGameName(gameName);

    await adminDb.runTransaction(async (transaction) => {
      const [playerSnap, loginSnap, existingTaskSnap] = await Promise.all([
        transaction.get(playerRef),
        adminDb.collection('playerGameLogins').where('playerUid', '==', playerUid).get(),
        transaction.get(taskRef),
      ]);

      if (!playerSnap.exists) {
        throw new Error('Player profile not found.');
      }

      const playerData = playerSnap.data() as {
        role?: string;
        status?: string;
        username?: string | null;
        coadminUid?: string | null;
        createdBy?: string | null;
      };

      if (String(playerData.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can create redeem requests.');
      }
      if (String(playerData.status || '').toLowerCase() === 'disabled') {
        throw new Error('Your account is blocked. Recharge and redeem features are disabled.');
      }

      const coadminUid =
        String(playerData.coadminUid || '').trim() || String(playerData.createdBy || '').trim();
      if (!coadminUid) {
        throw new Error('Player coadmin scope not found.');
      }

      const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid);
      if (maintenanceBreak.enabled) {
        console.info('[MAINTENANCE] blocked redeem request', { playerUid, coadminUid });
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }

      const assignedLogin = loginSnap.docs
        .map((docSnap) => docSnap.data() as { gameName?: string; gameUsername?: string })
        .find(
          (row) =>
            normalizeGameName(String(row.gameName || '')) === normalizedGame &&
            String(row.gameUsername || '').trim().length > 0
        );
      const assignedGameUsername = String(assignedLogin?.gameUsername || '').trim();
      if (!assignedGameUsername) {
        throw new Error(
          'Game username is not assigned for this game yet. Please create username first.'
        );
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
        amount,
        baseAmount:
          body.baseAmount !== undefined && body.baseAmount !== null
            ? Number(body.baseAmount)
            : null,
        bonusPercentage:
          body.bonusPercentage !== undefined && body.bonusPercentage !== null
            ? Number(body.bonusPercentage)
            : null,
        bonusEventId: String(body.bonusEventId || '').trim() || null,
        type: 'redeem',
        status: 'pending',
        createdBy: coadminUid,
        coadminUid,
        createdAt,
        completedAt: null,
        pokedAt: null,
        pokeMessage: null,
      };

      transaction.set(requestRef, requestPayload);
      if (!existingTaskSnap.exists) {
        console.info('[GAME_REQUEST_API] creating linked carer task', {
          requestId: requestRef.id,
          taskId: taskRef.id,
          type: 'redeem',
        });
        transaction.set(
          taskRef,
          buildPendingRequestLinkedCarerTaskPayload({
            requestId: requestRef.id,
            coadminUid,
            type: 'redeem',
            playerUid,
            playerUsername: String(playerData.username || '').trim() || 'Player',
            gameName,
            amount,
            currentUsername: assignedGameUsername,
            createdAt,
            gameCredential,
          })
        );
        console.info('[GAME_REQUEST_API] linked carer task created', {
          requestId: requestRef.id,
          taskId: taskRef.id,
          type: 'redeem',
        });
      }
    });
    console.info('[GAME_REQUEST_API] request and task committed atomically', {
      requestId: requestRef.id,
      taskId: taskRef.id,
      type: 'redeem',
    });

    return NextResponse.json({ success: true, requestId: requestRef.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create redeem request.';
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
            : /required|valid|not found|blocked|only|limit|redeem/i.test(message)
              ? 400
              : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
