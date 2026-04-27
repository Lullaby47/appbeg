import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

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

export async function POST(request: Request) {
  try {
    const { senderUid } = await verifyPlayerFromAuthHeader(request);
    const body = (await request.json()) as {
      targetUid?: string;
      amountCoins?: unknown;
    };
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
        coin: Math.max(0, parsePositiveWhole(target.coin)) + amountCoins,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(rewardRef, {
        fromUid: senderUid,
        fromUsername: String(sender.username || '').trim() || 'Player',
        toUid: targetUid,
        toUsername: String(target.username || '').trim() || 'Player',
        amountCoins,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return NextResponse.json({
      success: true,
      message: `Rewarded ${amountCoins} coin successfully.`,
      amountCoins,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reward coins.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
