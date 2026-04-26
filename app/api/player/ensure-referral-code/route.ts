import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  buildUniqueReferralCodeCandidates,
  findFreeReferralCodeInTransaction,
  isValidReferralCodeString,
  REFERRAL_CODE_INDEX,
  setReferralCodeIndexInTransaction,
} from '@/lib/referral/referralCodeAdmin';

/**
 * Returns a globally unique `referralCode` for the signed-in player and keeps
 * `referralCodes/{code}` in sync. Uses Admin SDK to avoid client-side assignment races.
 */
export async function POST(request: Request) {
  try {
    const header = request.headers.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const idToken = match?.[1];
    if (!idToken) {
      return NextResponse.json({ error: 'Missing or invalid authorization.' }, { status: 401 });
    }

    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const userRef = adminDb.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return NextResponse.json({ error: 'User profile not found.' }, { status: 404 });
    }

    const userData = userSnap.data() as { role?: string; referralCode?: string };
    if (String(userData.role || '').toLowerCase() !== 'player') {
      return NextResponse.json({ error: 'Only players have referral codes.' }, { status: 403 });
    }

    const current = String(userData.referralCode || '').trim();

    if (isValidReferralCodeString(current)) {
      const [usersWithCode, indexSnap] = await Promise.all([
        adminDb.collection('users').where('referralCode', '==', current).get(),
        adminDb.collection(REFERRAL_CODE_INDEX).doc(current).get(),
      ]);

      const onlySelf =
        usersWithCode.size === 1 && usersWithCode.docs[0].id === uid;
      const indexHolder = indexSnap.exists
        ? String((indexSnap.data() as { playerUid?: string })?.playerUid || '')
        : '';
      const indexOk = !indexSnap.exists || !indexHolder || indexHolder === uid;

      if (onlySelf && indexOk) {
        if (!indexSnap.exists) {
          await adminDb
            .collection(REFERRAL_CODE_INDEX)
            .doc(current)
            .set(
              { playerUid: uid, createdAt: FieldValue.serverTimestamp() },
              { merge: true }
            );
        }
        return NextResponse.json({ success: true, referralCode: current });
      }
    }

    const candidates = buildUniqueReferralCodeCandidates(40);
    let assigned = '';

    await adminDb.runTransaction(async (t) => {
      const uSnap = await t.get(userRef);
      if (!uSnap.exists) {
        throw new Error('User profile not found.');
      }

      const oldRaw = String((uSnap.data() as { referralCode?: string })?.referralCode || '').trim();
      const free = await findFreeReferralCodeInTransaction(adminDb, t, candidates);
      if (!free) {
        throw new Error('Failed to assign a unique referral code. Please try again.');
      }
      assigned = free;

      if (isValidReferralCodeString(oldRaw)) {
        const oldIndexRef = adminDb.collection(REFERRAL_CODE_INDEX).doc(oldRaw);
        const oldIndexSnap = await t.get(oldIndexRef);
        if (
          oldIndexSnap.exists &&
          String((oldIndexSnap.data() as { playerUid?: string })?.playerUid || '') === uid
        ) {
          t.delete(oldIndexRef);
        }
      }

      setReferralCodeIndexInTransaction(adminDb, t, free, uid);
      t.update(userRef, { referralCode: free });
    });

    return NextResponse.json({ success: true, referralCode: assigned });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to ensure referral code.' },
      { status: 500 }
    );
  }
}
