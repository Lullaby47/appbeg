import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { logCacheSqlRead } from '@/lib/server/cacheSqlRead';
import {
  createCoinLoadSessionInSql,
  deleteCoinLoadSessionInSql,
  readCoinLoadSessionById,
  tombstoneCoinLoadSessionsForPlayer,
} from '@/lib/sql/coinLoadSessionsCache';
import {
  logPaymentReferencePhotoAudit,
  logPaymentReferencePhotoRandomPick,
} from '@/lib/paymentReferencePhotoAudit';
import {
  getRandomPaymentReferencePhotoUrl,
  readLegacyPaymentPhotoUrlsFromPlayersCache,
} from '@/lib/sql/paymentReferencePhotos';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';

export const runtime = 'nodejs';

const ROUTE = '/api/player/coin-load-sessions';
const COIN_LOAD_DURATION_MS = 10 * 60 * 1000;

async function resolvePaymentPhotoForCoinLoad(coadminUid: string) {
  const cleanCoadminUid = cleanText(coadminUid);
  if (!cleanCoadminUid) {
    return { url: null as string | null, source: 'missing_coadmin_uid' };
  }

  const picked = await getRandomPaymentReferencePhotoUrl(cleanCoadminUid);
  if (picked.url) {
    logPaymentReferencePhotoRandomPick({
      coadminUid: cleanCoadminUid,
      source: 'payment_reference_photos_cache',
      photoCount: picked.photoCount,
      selectedPhotoId: picked.photoId,
      selectedUrlPresent: true,
    });
    logPaymentReferencePhotoAudit({
      routeOrPage: '/api/player/coin-load-sessions',
      role: 'player',
      coadminUid: cleanCoadminUid,
      source: 'payment_reference_photos_cache',
      cloudinaryUsed: true,
      tableOrCollection: 'payment_reference_photos_cache',
      photoCount: picked.photoCount,
      samplePhotoIds: picked.photoId ? [picked.photoId] : [],
      sampleUrlsPresent: true,
      reason: 'sql_random_pick',
    });
    return { url: picked.url, source: 'payment_reference_photos_cache' };
  }

  const legacyUrls = await readLegacyPaymentPhotoUrlsFromPlayersCache(cleanCoadminUid);
  const legacyUrl =
    legacyUrls.length > 0
      ? legacyUrls[Math.floor(Math.random() * legacyUrls.length)]!
      : null;
  logPaymentReferencePhotoAudit({
    routeOrPage: '/api/player/coin-load-sessions',
    role: 'player',
    coadminUid: cleanCoadminUid,
    source: 'players_cache.raw_firestore_data',
    cloudinaryUsed: Boolean(legacyUrl),
    tableOrCollection: 'players_cache',
    photoCount: legacyUrls.length,
    samplePhotoIds: [],
    sampleUrlsPresent: Boolean(legacyUrl),
    reason: legacyUrl ? 'legacy_mirror_fallback_before_backfill' : 'no_photos_available',
  });
  if (legacyUrl) {
    logPaymentReferencePhotoRandomPick({
      coadminUid: cleanCoadminUid,
      source: 'players_cache.raw_firestore_data',
      photoCount: legacyUrls.length,
      selectedPhotoId: null,
      selectedUrlPresent: true,
    });
  }
  return { url: legacyUrl, source: legacyUrl ? 'players_cache_mirror' : 'none' };
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

  const paymentPick = await resolvePaymentPhotoForCoinLoad(coadminUid);
  if (!paymentPick.url) {
    return apiError(
      'No payment reference images yet. Your co-admin needs to upload photos in their panel (Payment details).',
      400
    );
  }

  const paymentPhotoUrl = paymentPick.url;
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
