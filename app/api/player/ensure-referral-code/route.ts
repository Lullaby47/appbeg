import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { ensureReferralCodeInSql } from '@/lib/sql/authorityAdminPlayer';
import {
  buildUniqueReferralCodeCandidates,
  findFreeReferralCodeInTransaction,
  isValidReferralCodeString,
  REFERRAL_CODE_INDEX,
  setReferralCodeIndexInTransaction,
} from '@/lib/referral/referralCodeAdmin';
import { mirrorPlayerById } from '@/lib/sql/playersCache';
import { mirrorReferralCodeByCode, tombstoneReferralCodeCache } from '@/lib/sql/referralsCache';

export const runtime = 'nodejs';

/**
 * Returns a globally unique `referralCode` for the signed-in player and keeps
 * `referralCodes/{code}` in sync. Uses Admin SDK to avoid client-side assignment races.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;
    const uid = auth.user.uid;

    if (isAuthoritySqlWriteEnabled()) {
      const result = await ensureReferralCodeInSql(uid);
      logAuthoritySqlWrite('/api/player/ensure-referral-code', {
        uid,
        duplicate: result.duplicate,
        referralCode: result.referralCode,
      });
      return NextResponse.json({ authority: 'sql', ...result });
    }

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
          void mirrorReferralCodeByCode(current, 'appbeg_ensure_referral_code');
        }
        return NextResponse.json({ success: true, referralCode: current });
      }
    }

    const candidates = buildUniqueReferralCodeCandidates(40);
    let assigned = '';
    let deletedOldCode = '';

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
          deletedOldCode = oldRaw;
        }
      }

      setReferralCodeIndexInTransaction(adminDb, t, free, uid);
      t.update(userRef, { referralCode: free });
    });
    void mirrorPlayerById(uid, 'appbeg_ensure_referral_code');
    void mirrorReferralCodeByCode(assigned, 'appbeg_ensure_referral_code');
    if (deletedOldCode) {
      void tombstoneReferralCodeCache(deletedOldCode, 'appbeg_ensure_referral_code');
    }

    return NextResponse.json({ success: true, referralCode: assigned });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to ensure referral code.';
    return NextResponse.json(
      { error: message },
      { status: /authorization|token|logged out/i.test(message) ? 401 : 500 }
    );
  }
}
