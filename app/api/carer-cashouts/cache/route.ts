import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import {

  readCarerCashoutsByCarerUid,
  readPendingCarerCashoutsByCoadmin,
  type CachedCarerCashout,
} from '@/lib/sql/carerCashoutsCache';

export const runtime = 'nodejs';

const ROUTE = '/api/carer-cashouts/cache';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function resolveScope(request: Request) {
  return cleanText(new URL(request.url).searchParams.get('scope')).toLowerCase();
}

async function readFirestorePendingCashouts(
  coadminUid: string,
  limit: number
): Promise<CachedCarerCashout[]> {
  const snap = await adminDb
    .collection('carerCashouts')
    .where('coadminUid', '==', coadminUid)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  return snap.docs.map((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    return {
      id: docSnap.id,
      coadminUid: cleanText(data.coadminUid),
      carerUid: cleanText(data.carerUid),
      carerUsername: cleanText(data.carerUsername),
      amountNpr: Number(data.amountNpr || 0),
      paymentQrUrl: cleanText(data.paymentQrUrl) || null,
      paymentQrPublicId: cleanText(data.paymentQrPublicId) || null,
      paymentDetails: cleanText(data.paymentDetails) || null,
      status: cleanText(data.status) || 'pending',
      completedAmountNpr:
        typeof data.completedAmountNpr === 'number' ? data.completedAmountNpr : null,
      remainingAmountNpr:
        typeof data.remainingAmountNpr === 'number' ? data.remainingAmountNpr : null,
      createdAt: null,
      completedAt: null,
    } satisfies CachedCarerCashout;
  });
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff']);
  if ('response' in auth) {
    return auth.response;
  }

  const scope = resolveScope(request);
  if (scope !== 'pending' && scope !== 'carer') {
    return apiError('scope query parameter must be pending or carer.', 400);
  }

  const url = new URL(request.url);
  const requestedCoadminUid = cleanText(url.searchParams.get('coadminUid'));
  const requestedCarerUid = cleanText(url.searchParams.get('carerUid'));
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)));
  const scopedCoadmin = scopedCoadminUid(auth.user);
  const coadminUid =
    auth.user.role === 'coadmin'
      ? auth.user.uid
      : requestedCoadminUid || scopedCoadmin || '';

  if (scope === 'carer') {
    const carerUid =
      requestedCarerUid ||
      (auth.user.role === 'carer' || auth.user.role === 'staff' ? auth.user.uid : '');
    if (!carerUid) {
      return NextResponse.json({ cashouts: [], source: 'postgres' });
    }
    if (
      auth.user.role !== 'admin' &&
      auth.user.role !== 'coadmin' &&
      auth.user.uid !== carerUid
    ) {
      return apiError('Forbidden.', 403);
    }

    const sqlReadMode = isCacheSqlAuthoritative();
    const cashouts = await readCarerCashoutsByCarerUid(carerUid, limit);
    if (cashouts !== null) {
      logCacheSqlRead(ROUTE, {
        scope,
        carerUid,
        count: cashouts.length,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({ cashouts, source: 'postgres' });
    }
    if (sqlReadMode) {
      logCacheFirestoreFallbackBlocked(ROUTE, 'carerCashouts', { scope, carerUid });
      return NextResponse.json({ cashouts: [], source: 'postgres' });
    }
    return NextResponse.json({ cashouts: [], source: 'postgres' });
  }

  if (!coadminUid) {
    return NextResponse.json({ cashouts: [], source: 'postgres' });
  }

  if (
    auth.user.role !== 'admin' &&
    auth.user.role !== 'coadmin' &&
    scopedCoadmin &&
    coadminUid !== scopedCoadmin
  ) {
    return apiError('Forbidden.', 403);
  }

  const sqlReadMode = isCacheSqlAuthoritative();
  const cashouts = await readPendingCarerCashoutsByCoadmin(coadminUid, limit);

  if (cashouts !== null) {
    if (sqlReadMode || cashouts.length > 0) {
      logCacheSqlRead(ROUTE, {
        scope,
        coadminUid,
        count: cashouts.length,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({ cashouts, source: 'postgres' });
    }
  }

  if (sqlReadMode) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'carerCashouts', { scope, coadminUid });
    return NextResponse.json({ cashouts: [], source: 'postgres' });
  }

  const firestoreCashouts = await readFirestorePendingCashouts(coadminUid, limit);
  return NextResponse.json({ cashouts: firestoreCashouts, source: 'firestore' });
}
