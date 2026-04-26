import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';

function isValidReferralCode(value: unknown) {
  return /^\d{6,10}$/.test(String(value || '').trim());
}

function randomInt(min: number, max: number) {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function generateCandidateReferralCode() {
  const length = randomInt(6, 10);
  let code = '';
  for (let index = 0; index < length; index += 1) {
    const digit = index === 0 ? randomInt(1, 9) : randomInt(0, 9);
    code += String(digit);
  }
  return code;
}

export async function POST() {
  try {
    const snapshot = await adminDb.collection('users').where('role', '==', 'player').get();
    const players = snapshot.docs;

    const usedCodes = new Set<string>();
    const invalidOrMissingRefs: FirebaseFirestore.DocumentReference[] = [];

    players.forEach((docSnap) => {
      const data = docSnap.data() as { referralCode?: string };
      const referralCode = String(data.referralCode || '').trim();
      if (isValidReferralCode(referralCode) && !usedCodes.has(referralCode)) {
        usedCodes.add(referralCode);
        return;
      }
      invalidOrMissingRefs.push(docSnap.ref);
    });

    const batch = adminDb.batch();
    let updatedCount = 0;

    invalidOrMissingRefs.forEach((ref) => {
      let code = '';
      do {
        code = generateCandidateReferralCode();
      } while (usedCodes.has(code));

      usedCodes.add(code);
      updatedCount += 1;
      batch.update(ref, { referralCode: code });
    });

    if (updatedCount > 0) {
      await batch.commit();
    }

    return NextResponse.json({ success: true, updatedCount });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to backfill player referral codes.' },
      { status: 500 }
    );
  }
}
