import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

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

function toMs(value: unknown) {
  if (!value || typeof value !== 'object') return 0;
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') return maybe.toMillis();
  if (typeof maybe.toDate === 'function') return maybe.toDate().getTime();
  if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  return 0;
}

function isActive(docData: Record<string, unknown>) {
  const status = String(docData.status || 'active').toLowerCase();
  if (status !== 'active') return false;
  const now = Date.now();
  const startMs = toMs(docData.startDate || docData.start_date || null);
  const endMs = toMs(docData.endDate || docData.end_date || null);
  if (startMs > 0 && now < startMs) return false;
  if (endMs > 0 && now > endMs) return false;
  return true;
}

function isLegacyAutoBonusName(name: string) {
  const clean = String(name || '').trim().toLowerCase();
  return clean.startsWith('auto bonus') || clean.includes('2026-') || clean.includes('#');
}

function isLegacyAutoGameName(name: string) {
  return String(name || '').trim().toLowerCase().startsWith('auto game');
}

function hashText(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function resolveCoadminUidForRole(userDoc: {
  uid?: string;
  role?: string;
  createdBy?: string;
  coadminUid?: string;
}) {
  const role = String(userDoc.role || '').toLowerCase();
  const uid = String(userDoc.uid || '').trim();
  if (role === 'coadmin') return uid;
  return String(userDoc.coadminUid || userDoc.createdBy || '').trim();
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedCoadminUid = String(url.searchParams.get('coadminUid') || '').trim();
    const header = request.headers.get('Authorization') || '';
    const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) {
      return NextResponse.json({ error: 'Missing or invalid authorization.' }, { status: 401 });
    }

    const decoded = await adminAuth.verifyIdToken(token);
    const userRef = adminDb.collection('users').doc(decoded.uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return NextResponse.json({ error: 'User profile not found.' }, { status: 404 });
    }
    const userData = userSnap.data() as {
      uid?: string;
      role?: string;
      createdBy?: string;
      coadminUid?: string;
    };

    const derivedCoadminUid = resolveCoadminUidForRole({
      uid: decoded.uid,
      ...userData,
    });
    const role = String(userData.role || '').toLowerCase();
    const coadminUid =
      role === 'coadmin'
        ? derivedCoadminUid
        : requestedCoadminUid || derivedCoadminUid;
    if (!coadminUid) {
      return NextResponse.json({ events: [] });
    }

    const gameSnap = await adminDb
      .collection('gameLogins')
      .where('coadminUid', '==', coadminUid)
      .get();
    const gameNames = Array.from(
      new Set(
        gameSnap.docs
          .map((d) => String((d.data() as { gameName?: string }).gameName || '').trim())
          .filter(Boolean)
      )
    );

    const snap = await adminDb
      .collection('bonusEvents')
      .where('coadminUid', '==', coadminUid)
      .get();

    const events = snap.docs
      .map((d) => {
        const data = d.data() as Record<string, unknown>;
        const id = d.id;
        const currentBonusName = String(data.bonusName || '');
        const currentGameName = String(data.gameName || '');

        const funnyName =
          FUNNY_BONUS_NAMES[hashText(`${id}:bonus`) % FUNNY_BONUS_NAMES.length];
        const randomGameFromList =
          gameNames.length > 0
            ? gameNames[hashText(`${id}:game`) % gameNames.length]
            : currentGameName || 'Bonus Table';

        return {
          id,
          ...data,
          bonusName: isLegacyAutoBonusName(currentBonusName) ? funnyName : currentBonusName,
          gameName: isLegacyAutoGameName(currentGameName) ? randomGameFromList : currentGameName,
        };
      })
      .filter((event) => isActive(event))
      .sort((a, b) => toMs(b.createdAt || b.created_at) - toMs(a.createdAt || a.created_at));

    return NextResponse.json({ events });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load bonus events.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
