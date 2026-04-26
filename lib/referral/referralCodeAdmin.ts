import { FieldValue } from 'firebase-admin/firestore';
import type {
  DocumentSnapshot,
  Firestore,
  QuerySnapshot,
  Transaction,
} from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';

const REFERRAL_CODE_INDEX = 'referralCodes';

function randomInt(min: number, max: number) {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

/** Public pattern for 6–10 digit codes (matches client + other routes). */
export function isValidReferralCodeString(value: string) {
  return /^\d{6,10}$/.test(String(value || '').trim());
}

export function generateCandidateReferralCode() {
  const length = randomInt(6, 10);
  let code = '';
  for (let index = 0; index < length; index += 1) {
    const digit = index === 0 ? randomInt(1, 9) : randomInt(0, 9);
    code += String(digit);
  }
  return code;
}

/**
 * A batch of unique candidate strings for transactional claiming (avoids
 * clashing with itself before writes).
 */
export function buildUniqueReferralCodeCandidates(needed: number) {
  const out: string[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (out.length < needed && guard < 2000) {
    guard += 1;
    const c = generateCandidateReferralCode();
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  if (out.length < needed) {
    throw new Error('Failed to build referral code candidates.');
  }
  return out;
}

function isIndexUnclaimed(indexSnap: DocumentSnapshot, playerUidToIgnore?: string) {
  if (!indexSnap.exists) {
    return true;
  }
  const holder = String((indexSnap.data() as { playerUid?: string })?.playerUid || '');
  if (!holder) {
    return true;
  }
  if (playerUidToIgnore && holder === playerUidToIgnore) {
    return true;
  }
  return false;
}

/**
 * "Free" if no *other* user is holding this code in `users` (or only `playerUidToIgnore` holds it).
 * Uses limit(2) to spot accidental duplicates in `users` quickly.
 */
function isUsersHoldingUnclaimed(usersSnap: QuerySnapshot, playerUidToIgnore?: string) {
  if (usersSnap.empty) {
    return true;
  }
  if (!playerUidToIgnore) {
    return false;
  }
  if (usersSnap.size > 1) {
    return false;
  }
  const [first] = usersSnap.docs;
  return first.id === playerUidToIgnore;
}

/**
 * All reads, no writes. Call only during the read phase of a transaction.
 * For **new** players, omit `playerUidToIgnore`.
 * For **repair/override**, pass the uid to allow reclaiming a row that already belongs to them in `users`.
 */
export async function findFreeReferralCodeInTransaction(
  db: Firestore,
  t: Transaction,
  candidates: string[],
  playerUidToIgnore?: string
): Promise<string | null> {
  for (const code of candidates) {
    const indexRef = db.collection(REFERRAL_CODE_INDEX).doc(code);
    const usersQ = db.collection('users').where('referralCode', '==', code).limit(2);
    const [indexSnap, usersSnap] = await Promise.all([t.get(indexRef), t.get(usersQ)]);

    if (isIndexUnclaimed(indexSnap, playerUidToIgnore) && isUsersHoldingUnclaimed(usersSnap, playerUidToIgnore)) {
      return code;
    }
  }
  return null;
}

export function setReferralCodeIndexInTransaction(
  db: Firestore,
  t: Transaction,
  code: string,
  playerUid: string
) {
  t.set(
    db.collection(REFERRAL_CODE_INDEX).doc(code),
    { playerUid, createdAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

/**
 * For low-concurrency server paths (restore, backfill pre-check) where a transaction
 * is not used yet.
 */
export async function isReferralCodeGloballyFree(db: Firestore, code: string) {
  const [indexSnap, usersSnap] = await Promise.all([
    db.collection(REFERRAL_CODE_INDEX).doc(code).get(),
    db.collection('users').where('referralCode', '==', code).limit(1).get(),
  ]);
  if (indexSnap.exists) {
    return false;
  }
  if (!usersSnap.empty) {
    return false;
  }
  return true;
}

export async function findUniqueReferralCodeWithQueries(db: Firestore) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const code = generateCandidateReferralCode();
    if (await isReferralCodeGloballyFree(db, code)) {
      return code;
    }
  }
  throw new Error('Failed to assign a unique referral code. Please try again.');
}

/**
 * When restoring an archived account with the same uid, the old `referralCodes` doc
 * may still list this uid; no active `users` row should be using the code.
 */
export async function isReferralCodeReusableByPlayer(
  db: Firestore,
  code: string,
  playerUid: string
) {
  const usersSnap = await db.collection('users').where('referralCode', '==', code).limit(1).get();
  if (!usersSnap.empty) {
    return false;
  }
  const indexSnap = await db.collection(REFERRAL_CODE_INDEX).doc(code).get();
  if (!indexSnap.exists) {
    return true;
  }
  return String((indexSnap.data() as { playerUid?: string })?.playerUid || '') === playerUid;
}

export { REFERRAL_CODE_INDEX };
