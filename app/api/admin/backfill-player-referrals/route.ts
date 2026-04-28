import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentReference } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import {
  findUniqueReferralCodeWithQueries,
  generateCandidateReferralCode,
  isReferralCodeGloballyFree,
  isValidReferralCodeString,
  REFERRAL_CODE_INDEX,
} from '@/lib/referral/referralCodeAdmin';

type Row = {
  ref: DocumentReference;
  uid: string;
  codeRaw: string;
};

const BACKFILL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BACKFILL_META_DOC = adminDb.collection('system_meta').doc('backfill_player_referrals');

function toMillis(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') return maybe.toMillis();
  if (typeof maybe.toDate === 'function') return maybe.toDate().getTime();
  if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  return 0;
}

export async function POST() {
  try {
    const nowMs = Date.now();
    const metaSnap = await BACKFILL_META_DOC.get();
    if (metaSnap.exists) {
      const meta = metaSnap.data() as { lastRunAt?: unknown; lastResultCount?: number };
      const lastRunAtMs = toMillis(meta.lastRunAt);
      if (lastRunAtMs > 0 && nowMs - lastRunAtMs < BACKFILL_COOLDOWN_MS) {
        console.info('[player-referral-backfill] backfill skipped server cooldown', {
          retryAfterMs: BACKFILL_COOLDOWN_MS - (nowMs - lastRunAtMs),
          lastResultCount: Number(meta.lastResultCount || 0),
        });
        return NextResponse.json({
          success: true,
          skipped: 'server-cooldown',
          retryAfterMs: Math.max(1_000, BACKFILL_COOLDOWN_MS - (nowMs - lastRunAtMs)),
          totalPlayers: null,
          finalAssignments: Number(meta.lastResultCount || 0),
        });
      }
    }
    console.info('[player-referral-backfill] backfill started');

    const snapshot = await adminDb.collection('users').where('role', '==', 'player').get();
    const rows: Row[] = snapshot.docs.map((docSnap) => ({
      ref: docSnap.ref,
      uid: docSnap.id,
      codeRaw: String((docSnap.data() as { referralCode?: string }).referralCode || '').trim(),
    }));

    const byCode = new Map<string, Row[]>();
    for (const row of rows) {
      if (!isValidReferralCodeString(row.codeRaw)) {
        continue;
      }
      if (!byCode.has(row.codeRaw)) {
        byCode.set(row.codeRaw, []);
      }
      byCode.get(row.codeRaw)!.push(row);
    }

    const assigned = new Map<string, { ref: DocumentReference; code: string }>();
    const toReassign: Row[] = [];

    for (const list of byCode.values()) {
      if (list.length === 1) {
        assigned.set(list[0].uid, { ref: list[0].ref, code: list[0].codeRaw });
      } else {
        const sorted = [...list].sort((a, b) => a.uid.localeCompare(b.uid));
        assigned.set(sorted[0].uid, { ref: sorted[0].ref, code: sorted[0].codeRaw });
        for (let i = 1; i < sorted.length; i += 1) {
          toReassign.push(sorted[i]);
        }
      }
    }

    for (const row of rows) {
      if (assigned.has(row.uid)) {
        continue;
      }
      if (!isValidReferralCodeString(row.codeRaw)) {
        toReassign.push(row);
      }
    }

    const reservedCodes = new Set(
      Array.from(assigned.values())
        .map((entry) => entry.code)
        .filter(Boolean)
    );

    for (const row of toReassign) {
      let nextCode = '';
      for (let attempt = 0; attempt < 200 && !nextCode; attempt += 1) {
        const candidate = generateCandidateReferralCode();
        if (reservedCodes.has(candidate)) {
          continue;
        }
        if (await isReferralCodeGloballyFree(adminDb, candidate)) {
          nextCode = candidate;
        }
      }
      if (!nextCode) {
        nextCode = await findUniqueReferralCodeWithQueries(adminDb);
      }
      reservedCodes.add(nextCode);
      assigned.set(row.uid, { ref: row.ref, code: nextCode });
    }

    let batch = adminDb.batch();
    let ops = 0;

    const commitIfNeeded = async () => {
      if (ops >= 450) {
        await batch.commit();
        batch = adminDb.batch();
        ops = 0;
      }
    };

    const rowByUid = new Map(rows.map((r) => [r.uid, r]));

    for (const { ref, code } of assigned.values()) {
      const row = rowByUid.get(ref.id);
      if (!row || row.codeRaw !== code) {
        batch.update(ref, { referralCode: code });
        ops += 1;
        await commitIfNeeded();
      }
      batch.set(
        adminDb.collection(REFERRAL_CODE_INDEX).doc(code),
        { playerUid: ref.id, createdAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      ops += 1;
      await commitIfNeeded();
    }

    if (ops > 0) {
      await batch.commit();
    }

    await BACKFILL_META_DOC.set(
      {
        lastRunAt: FieldValue.serverTimestamp(),
        lastResultCount: assigned.size,
        totalPlayers: rows.length,
      },
      { merge: true }
    );
    console.info('[player-referral-backfill] backfill completed count', {
      totalPlayers: rows.length,
      finalAssignments: assigned.size,
      writesCommitted: ops > 0,
    });

    return NextResponse.json({
      success: true,
      totalPlayers: rows.length,
      finalAssignments: assigned.size,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Failed to backfill player referral codes.' },
      { status: 500 }
    );
  }
}
