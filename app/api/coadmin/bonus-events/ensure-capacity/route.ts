import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

const MAX_ACTIVE_BONUS_EVENTS = 20;
const COADMIN_MIN_PERCENT = 5;
const COADMIN_MAX_PERCENT = 10;
const COADMIN_AUTO_BONUS_PERCENT_MIN = 5;
const COADMIN_AUTO_BONUS_PERCENT_MAX = 30;
const COADMIN_MIN_AMOUNT = 10;
const COADMIN_MAX_AMOUNT = 50;
const FUNNY_BONUS_NAMES = [
  'Freak Friday',
  'Hello Honee',
  'Mafia Boss',
  'Saduleeee',
  'Lucky Lassi',
  'Drama Dollar',
  'Paisa Pani',
  'Jhakaas Jackpot',
  'Bingo Bhoot',
  'Crazy Chiya',
  'Pocket Rocket',
  'No Tension Bonus',
  'Balle Balle',
  'Dhamaka Drop',
  'Laughter Loot',
  'Chill Pill Reward',
  'Pagal Paisa',
  'Momo Money',
  'Fatafat Fortune',
  'Boss Baby Bonus',
];

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeAutoBonusPercentRange(values: {
  minPercent?: number | null;
  maxPercent?: number | null;
}) {
  const rawMin = Number(values.minPercent);
  const rawMax = Number(values.maxPercent);
  const fallbackMin = COADMIN_MIN_PERCENT;
  const fallbackMax = COADMIN_MAX_PERCENT;

  const minPercent = Number.isFinite(rawMin) ? Math.round(rawMin) : fallbackMin;
  const maxPercent = Number.isFinite(rawMax) ? Math.round(rawMax) : fallbackMax;

  const boundedMin = Math.min(
    COADMIN_AUTO_BONUS_PERCENT_MAX,
    Math.max(COADMIN_AUTO_BONUS_PERCENT_MIN, minPercent)
  );
  const boundedMax = Math.min(
    COADMIN_AUTO_BONUS_PERCENT_MAX,
    Math.max(COADMIN_AUTO_BONUS_PERCENT_MIN, maxPercent)
  );

  return {
    minPercent: Math.min(boundedMin, boundedMax),
    maxPercent: Math.max(boundedMin, boundedMax),
  };
}

function toMs(value: unknown) {
  if (!value || typeof value !== 'object') return 0;
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') return maybe.toMillis();
  if (typeof maybe.toDate === 'function') return maybe.toDate().getTime();
  if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  return 0;
}

function isActiveEvent(docData: Record<string, unknown>) {
  const now = Date.now();
  const status = String(docData.status || 'active').toLowerCase();
  if (status !== 'active') return false;
  const startMs = toMs(docData.startDate || docData.start_date || null);
  const endMs = toMs(docData.endDate || docData.end_date || null);
  if (startMs > 0 && now < startMs) return false;
  if (endMs > 0 && now > endMs) return false;
  return true;
}

function duplicateKey(values: {
  bonusName: string;
  gameName: string;
  amountNpr: number;
  bonusPercentage: number;
}) {
  return [
    values.bonusName.trim().toLowerCase(),
    values.gameName.trim().toLowerCase(),
    Math.round(values.amountNpr),
    Math.round(values.bonusPercentage),
  ].join('__');
}

function isLegacyAutoBonusName(name: string) {
  const clean = String(name || '').trim().toLowerCase();
  return clean.startsWith('auto bonus') || clean.includes('2026-') || clean.includes('#');
}

function pickFunnyBonusName(usedNames: Set<string>, fallbackIndex: number) {
  const shuffled = [...FUNNY_BONUS_NAMES].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    const key = candidate.trim().toLowerCase();
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
  }
  const fallback = `${FUNNY_BONUS_NAMES[fallbackIndex % FUNNY_BONUS_NAMES.length]} ${fallbackIndex}`;
  usedNames.add(fallback.toLowerCase());
  return fallback;
}

async function getCoadminGameNames(coadminUid: string): Promise<string[]> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    adminDb.collection('gameLogins').where('coadminUid', '==', coadminUid).get(),
    adminDb.collection('gameLogins').where('createdBy', '==', coadminUid).get(),
  ]);
  const names = new Set<string>();
  [...coadminOwned.docs, ...legacyOwned.docs].forEach((d) => {
    const data = d.data() as { gameName?: string };
    const name = String(data.gameName || '').trim();
    if (name) names.add(name);
  });
  return [...names];
}

async function getCoadminAutoBonusPercentRange(coadminUid: string) {
  const userSnap = await adminDb.collection('users').doc(coadminUid).get();
  if (!userSnap.exists) {
    return normalizeAutoBonusPercentRange({});
  }

  const userData = userSnap.data() as {
    autoBonusEventMinPercent?: number;
    autoBonusEventMaxPercent?: number;
  };

  return normalizeAutoBonusPercentRange({
    minPercent: userData.autoBonusEventMinPercent,
    maxPercent: userData.autoBonusEventMaxPercent,
  });
}

async function verifyCoadmin(request: Request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  const idToken = match?.[1];
  if (!idToken) {
    throw new Error('Missing or invalid authorization.');
  }
  const decoded = await adminAuth.verifyIdToken(idToken);
  const uid = decoded.uid;
  const userRef = adminDb.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new Error('Current user profile not found.');
  }
  const userData = userSnap.data() as {
    role?: string;
    username?: string;
    createdBy?: string;
    coadminUid?: string;
  };
  const role = String(userData.role || '').toLowerCase();
  if (role !== 'coadmin') {
    throw new Error('Only coadmin can run bonus auto-fill.');
  }
  // For coadmin accounts, scope must always be the coadmin's own uid.
  const coadminUid = uid;
  return {
    uid,
    coadminUid,
    username: String(userData.username || '').trim() || 'Coadmin',
  };
}

export async function POST(request: Request) {
  try {
    const caller = await verifyCoadmin(request);

    // Repair previously auto-created docs that may have been written with mismatched coadminUid.
    const byCreatorSnap = await adminDb
      .collection('bonusEvents')
      .where('createdByUid', '==', caller.uid)
      .get();
    if (!byCreatorSnap.empty) {
      const repairBatch = adminDb.batch();
      let repairCount = 0;
      byCreatorSnap.docs.forEach((d) => {
        const data = d.data() as { coadminUid?: string; autoGenerated?: boolean };
        const existingCoadminUid = String(data.coadminUid || '').trim();
        if (data.autoGenerated && existingCoadminUid !== caller.coadminUid) {
          repairBatch.update(d.ref, {
            coadminUid: caller.coadminUid,
            updatedAt: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
          });
          repairCount += 1;
        }
      });
      if (repairCount > 0) {
        await repairBatch.commit();
      }
    }

    const snap = await adminDb
      .collection('bonusEvents')
      .where('coadminUid', '==', caller.coadminUid)
      .get();
    const autoBonusPercentRange = await getCoadminAutoBonusPercentRange(caller.coadminUid);

    const activeDocs = snap.docs.filter((d) => isActiveEvent(d.data() as Record<string, unknown>));
    const gameNames = await getCoadminGameNames(caller.coadminUid);
    const validGameNames = new Set(gameNames.map((name) => name.toLowerCase()));
    const pickGameName = () =>
      gameNames.length > 0 ? gameNames[randomInt(0, gameNames.length - 1)] : 'Bonus Table';
    const allDocsForNames = snap.docs;
    const usedNames = new Set(
      allDocsForNames.map((d) =>
        String((d.data() as { bonusName?: string }).bonusName || '')
          .trim()
          .toLowerCase()
      )
    );

    // Rename legacy auto names for ALL existing docs (active + inactive),
    // so old events visibly get fixed immediately.
    const renameBatch = adminDb.batch();
    let renameCount = 0;
    allDocsForNames.forEach((d, i) => {
      const data = d.data() as { bonusName?: string; gameName?: string };
      const currentName = String(data.bonusName || '').trim();
      const currentGameName = String(data.gameName || '').trim();
      const needsFunnyName = isLegacyAutoBonusName(currentName);
      const needsGameNameRepair =
        validGameNames.size > 0 && !validGameNames.has(currentGameName.toLowerCase());
      if (!needsFunnyName && !needsGameNameRepair) return;
      const nextName = pickFunnyBonusName(usedNames, i + 1);
      renameBatch.update(d.ref, {
        bonusName: needsFunnyName ? nextName : currentName,
        gameName: needsGameNameRepair ? pickGameName() : currentGameName,
        updatedAt: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
      renameCount += 1;
    });
    if (renameCount > 0) {
      await renameBatch.commit();
    }

    if (activeDocs.length >= MAX_ACTIVE_BONUS_EVENTS) {
      return NextResponse.json({ autoCreatedCount: 0, totalActive: activeDocs.length });
    }

    const existing = new Set(
      activeDocs.map((d) => {
        const data = d.data() as {
          bonusName?: string;
          gameName?: string;
          amountNpr?: number;
          amount?: number;
          bonusPercentage?: number;
          bonus_percentage?: number;
        };
        return duplicateKey({
          bonusName: String(data.bonusName || ''),
          gameName: String(data.gameName || ''),
          amountNpr: Number(data.amountNpr || data.amount || 0),
          bonusPercentage: Number(data.bonusPercentage || data.bonus_percentage || 0),
        });
      })
    );

    const now = Timestamp.now();
    const end = Timestamp.fromMillis(now.toMillis() + 7 * 24 * 60 * 60 * 1000);
    const missing = MAX_ACTIVE_BONUS_EVENTS - activeDocs.length;
    let autoCreatedCount = 0;
    let attempts = 0;
    const batch = adminDb.batch();

    while (autoCreatedCount < missing && attempts < missing * 25) {
      attempts += 1;
      const amount = randomInt(COADMIN_MIN_AMOUNT, COADMIN_MAX_AMOUNT);
      const percent = randomInt(
        autoBonusPercentRange.minPercent,
        autoBonusPercentRange.maxPercent
      );
      const gameName = pickGameName();
      const bonusName = pickFunnyBonusName(usedNames, attempts);
      const key = duplicateKey({
        bonusName,
        gameName,
        amountNpr: amount,
        bonusPercentage: percent,
      });
      if (existing.has(key)) continue;

      const ref = adminDb.collection('bonusEvents').doc();
      batch.set(ref, {
        eventId: ref.id,
        event_id: ref.id,
        coadminUid: caller.coadminUid,
        bonusName,
        gameName,
        amountNpr: amount,
        amount,
        bonusPercentage: percent,
        bonus_percentage: percent,
        description: 'Auto-generated co-admin bonus event to maintain active event capacity.',
        createdByUid: caller.uid,
        created_by: caller.uid,
        createdByUsername: caller.username,
        createdByRole: 'coadmin',
        creator_role: 'system',
        status: 'active',
        startDate: now,
        endDate: end,
        start_date: now,
        end_date: end,
        createdAt: FieldValue.serverTimestamp(),
        created_at: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
        autoGenerated: true,
      });

      existing.add(key);
      autoCreatedCount += 1;
    }

    if (autoCreatedCount > 0) {
      await batch.commit();
    }

    return NextResponse.json({
      autoCreatedCount,
      totalActive: activeDocs.length + autoCreatedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to ensure bonus capacity.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
