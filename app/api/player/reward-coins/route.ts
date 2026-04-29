import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  computeRewardCoinsAfterFee,
  REWARD_TRANSFER_FEE_PERCENT,
} from '@/lib/rewardCoinTransferFee';

const MAX_REWARD_COINS_PER_TRANSFER = 50;

function parsePositiveWhole(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

async function verifyPlayerFromAuthHeader(request: Request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  const idToken = match?.[1];
  if (!idToken) {
    throw new Error('Missing or invalid authorization.');
  }

  const decoded = await adminAuth.verifyIdToken(idToken);
  const senderUid = decoded.uid;
  const senderRef = adminDb.collection('users').doc(senderUid);
  const senderSnap = await senderRef.get();
  if (!senderSnap.exists) {
    throw new Error('Player profile not found.');
  }
  const senderData = senderSnap.data() as { role?: string };
  if (String(senderData.role || '').toLowerCase() !== 'player') {
    throw new Error('Only players can reward coins.');
  }
  return { senderUid };
}

function httpStatusForRewardCoinsError(error: unknown): number {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof (error as { message: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '';

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';

  if (code.startsWith('auth/') || /id token|authorization|credential|jwt|token/i.test(message)) {
    return 401;
  }

  const badRequestMarkers = [
    'targetUid',
    'yourself',
    'at least 1 coin',
    'Maximum reward',
    'too low after',
    'must be a player',
    'Only players can reward',
    'Sender profile',
    'Player profile not found',
    'Target player not found',
    'Target user must be a player.',
    'Not enough coin balance',
  ];

  if (badRequestMarkers.some((m) => message.includes(m))) {
    return 400;
  }

  return 500;
}

export async function POST(request: Request) {
  try {
    const { senderUid } = await verifyPlayerFromAuthHeader(request);

    let body: { targetUid?: string; amountCoins?: unknown };
    try {
      body = (await request.json()) as { targetUid?: string; amountCoins?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    const targetUid = String(body.targetUid || '').trim();
    const amountCoins = parsePositiveWhole(body.amountCoins);

    if (!targetUid) {
      return NextResponse.json({ error: 'targetUid is required.' }, { status: 400 });
    }
    if (targetUid === senderUid) {
      return NextResponse.json({ error: 'You cannot reward yourself.' }, { status: 400 });
    }
    if (amountCoins <= 0) {
      return NextResponse.json({ error: 'Reward amount must be at least 1 coin.' }, { status: 400 });
    }
    if (amountCoins > MAX_REWARD_COINS_PER_TRANSFER) {
      return NextResponse.json(
        { error: `Maximum reward per transfer is ${MAX_REWARD_COINS_PER_TRANSFER} coins.` },
        { status: 400 }
      );
    }

    const { feeCoins, recipientCoins } = computeRewardCoinsAfterFee(amountCoins);
    if (recipientCoins < 1) {
      return NextResponse.json(
        { error: 'Reward amount is too low after the transfer fee.' },
        { status: 400 }
      );
    }

    const senderRef = adminDb.collection('users').doc(senderUid);
    const targetRef = adminDb.collection('users').doc(targetUid);
    const rewardRef = adminDb.collection('playerCoinRewards').doc();

    await adminDb.runTransaction(async (tx) => {
      const [senderSnap, targetSnap] = await Promise.all([tx.get(senderRef), tx.get(targetRef)]);
      if (!senderSnap.exists) {
        throw new Error('Sender profile not found.');
      }
      if (!targetSnap.exists) {
        throw new Error('Target player not found.');
      }

      const sender = senderSnap.data() as { role?: string; coin?: number; username?: string };
      const target = targetSnap.data() as { role?: string; coin?: number; username?: string };
      if (String(target.role || '').toLowerCase() !== 'player') {
        throw new Error('Target user must be a player.');
      }
      if (String(sender.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can reward coins.');
      }

      const senderCoin = Math.max(0, parsePositiveWhole(sender.coin));
      if (senderCoin < amountCoins) {
        throw new Error('Not enough coin balance to reward.');
      }

      tx.update(senderRef, {
        coin: senderCoin - amountCoins,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(targetRef, {
        coin: Math.max(0, parsePositiveWhole(target.coin)) + recipientCoins,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(rewardRef, {
        fromUid: senderUid,
        fromUsername: String(sender.username || '').trim() || 'Player',
        toUid: targetUid,
        toUsername: String(target.username || '').trim() || 'Player',
        amountCoins,
        feeCoins,
        receivedCoins: recipientCoins,
        feePercent: REWARD_TRANSFER_FEE_PERCENT,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return NextResponse.json({
      success: true,
      message: `Reward sent (${feeCoins}-coin fee, ${recipientCoins} credited to recipient).`,
      amountCoins,
      feeCoins,
      recipientCoins,
    });
  } catch (error) {
    console.error(
      '[api/player/reward-coins]',
      error instanceof Error ? error.stack ?? error.message : error
    );

    const rawMessage =
      error instanceof Error ? error.message : 'Failed to reward coins.';
    const status = httpStatusForRewardCoinsError(error);

    const clientMessage =
      status === 500 && process.env.NODE_ENV === 'production'
        ? 'Reward could not be completed. Try again or contact support.'
        : rawMessage;

    return NextResponse.json({ error: clientMessage }, { status });
  }
}
