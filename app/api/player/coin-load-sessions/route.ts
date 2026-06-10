import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { logCacheSqlRead } from '@/lib/server/cacheSqlRead';
import {
  createCoinLoadSessionInSql,
  deleteCoinLoadSessionInSql,
  readCoinLoadSessionById,
  tombstoneCoinLoadSessionsForPlayer,
} from '@/lib/sql/coinLoadSessionsCache';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';

const ROUTE = '/api/player/coin-load-sessions';
const COIN_LOAD_DURATION_MS = 10 * 60 * 1000;

async function readPaymentPhotoUrls(coadminUid: string) {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  if (!db || !cleanCoadminUid) {
    return [] as string[];
  }
  const result = await db.query(
    `
      SELECT raw_firestore_data
      FROM public.players_cache
      WHERE uid = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [cleanCoadminUid]
  );
  const raw = (result.rows[0]?.raw_firestore_data || {}) as Record<string, unknown>;
  const urls = Array.isArray(raw.paymentDetailPhotoUrls)
    ? raw.paymentDetailPhotoUrls.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (urls.length > 0) {
    return urls;
  }
  const photos = Array.isArray(raw.paymentDetailPhotos) ? raw.paymentDetailPhotos : [];
  return photos
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return '';
      }
      return String((entry as { imageUrl?: string }).imageUrl || '').trim();
    })
    .filter(Boolean);
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) {
    return auth.response;
  }

  const sessionId = cleanText(new URL(request.url).searchParams.get('sessionId'));
  if (!sessionId) {
    return apiError('sessionId query parameter is required.', 400);
  }

  const session = await readCoinLoadSessionById(sessionId, auth.user.uid);
  logCacheSqlRead(ROUTE, {
    sessionId,
    found: Boolean(session),
    durationMs: Date.now() - startedAt,
  });

  if (!session) {
    return NextResponse.json({ session: null, source: 'postgres' });
  }

  return NextResponse.json({ session, source: 'postgres', firestore_fallback: false });
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) {
    return auth.response;
  }

  if (!isDatabaseUrlConfigured()) {
    return apiError('Coin load is unavailable in SQL mode right now.', 503);
  }

  const body = (await request.json().catch(() => ({}))) as { coadminUid?: string };
  const coadminUid = cleanText(body.coadminUid);
  if (!coadminUid) {
    return apiError('coadminUid is required.', 400);
  }

  const photoUrls = await readPaymentPhotoUrls(coadminUid);
  if (!photoUrls.length) {
    return apiError(
      'No payment reference images yet. Your co-admin needs to upload photos in their panel (Payment details).',
      400
    );
  }

  const paymentPhotoUrl = photoUrls[Math.floor(Math.random() * photoUrls.length)]!;
  const session = await createCoinLoadSessionInSql({
    playerUid: auth.user.uid,
    coadminUid,
    paymentPhotoUrl,
  });

  if (!session) {
    return apiError('Failed to create coin load session.', 500);
  }

  return NextResponse.json({
    success: true,
    session: {
      ...session,
      durationMs: COIN_LOAD_DURATION_MS,
    },
    source: 'postgres',
    firestore_fallback: false,
  });
}

export async function DELETE(request: Request) {
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
  const sessionId = cleanText(body.sessionId);
  if (!sessionId) {
    return apiError('sessionId is required.', 400);
  }

  const deleted = await deleteCoinLoadSessionInSql(sessionId, auth.user.uid);
  if (!deleted) {
    await tombstoneCoinLoadSessionsForPlayer(auth.user.uid);
  }

  return NextResponse.json({ success: true, source: 'postgres', firestore_fallback: false });
}
