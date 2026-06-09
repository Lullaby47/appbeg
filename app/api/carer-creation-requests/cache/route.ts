import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';

const ROUTE = '/api/carer-creation-requests/cache';
import {
  listFirestorePendingCarerCreationRequestsForCoadmin,
  listPendingCarerCreationRequestsForCoadminSql,
  listPendingCarerCreationRequestsSql,
  mapFirestoreCarerCreationRequest,
} from '@/lib/sql/carerCreationRequestsCache';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function resolveScope(request: Request) {
  const url = new URL(request.url);
  const scope = cleanText(url.searchParams.get('scope')).toLowerCase();
  return scope === 'all' ? 'all' : 'mine';
}

function sortPendingRequests<T extends { requestedAt?: string | null }>(requests: T[]) {
  return requests.sort((a, b) => {
    const aMs = a.requestedAt ? new Date(a.requestedAt).getTime() : 0;
    const bMs = b.requestedAt ? new Date(b.requestedAt).getTime() : 0;
    return bMs - aMs;
  });
}

async function getFirestorePendingAll() {
  const snapshot = await adminDb
    .collection('carerCreationRequests')
    .where('status', '==', 'pending')
    .get();

  return sortPendingRequests(
    snapshot.docs.map((docSnap) =>
      mapFirestoreCarerCreationRequest(
        docSnap.id,
        (docSnap.data() || {}) as Record<string, unknown>
      )
    )
  );
}

export async function GET(request: Request) {
  const startedAt = Date.now();

  const auth = await requireApiUser(request, ['coadmin', 'admin']);
  if ('response' in auth) {
    return auth.response;
  }

  const scope = resolveScope(request);
  if (auth.user.role === 'coadmin' && scope === 'all') {
    return apiError('Forbidden.', 403);
  }

  const coadminUid = scope === 'mine' ? auth.user.uid : '';
  const logAction = scope === 'mine' ? 'list_mine' : 'list_pending';

  if (scope === 'mine' && !coadminUid) {
    return NextResponse.json({ requests: [], source: 'postgres' });
  }

  try {
    const cached =
      scope === 'all'
        ? await listPendingCarerCreationRequestsSql()
        : await listPendingCarerCreationRequestsForCoadminSql(coadminUid);

    if (cached !== null) {
      const durationMs = Date.now() - startedAt;
      logCacheSqlRead(ROUTE, {
        action: logAction,
        coadminUid: coadminUid || '*',
        count: cached.length,
        durationMs,
      });
      return NextResponse.json({ requests: cached, source: 'postgres' });
    }
  } catch (error) {
    console.warn('[CARER_CREATION_REQUEST_SQL] postgres read failed', {
      action: logAction,
      coadminUid: coadminUid || '*',
      error,
    });
  }

  if (isCacheSqlAuthoritative()) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'carerCreationRequests', {
      action: logAction,
      coadminUid: coadminUid || '*',
    });
    return NextResponse.json({ requests: [], source: 'postgres' });
  }

  const requests =
    scope === 'all'
      ? await getFirestorePendingAll()
      : await listFirestorePendingCarerCreationRequestsForCoadmin(coadminUid);

  const durationMs = Date.now() - startedAt;
  console.info('[CARER_CREATION_REQUEST_SQL]', {
    action: logAction,
    coadminUid: coadminUid || '*',
    source: 'firestore_fallback',
    count: requests.length,
    durationMs,
  });

  return NextResponse.json({ requests, source: 'firestore' });
}
