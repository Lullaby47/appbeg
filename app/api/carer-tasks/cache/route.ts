import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import {
  readCarerRechargeRedeemTotalsFromCache,
  type CachedCarerTotalsTask,
} from '@/lib/sql/carerTasksCache';

const ROUTE = '/api/carer-tasks/cache';
const CARER_TOTALS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CARER_TOTALS_HISTORY_LIMIT_PER_TYPE = 500;

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function resolveScope(request: Request) {
  return cleanText(new URL(request.url).searchParams.get('scope')).toLowerCase();
}

async function readFirestoreCarerTotals(
  coadminUid: string,
  windowStartMs: number
): Promise<CachedCarerTotalsTask[]> {
  const windowStart = new Date(windowStartMs);
  const collectionRef = adminDb.collection('carerTasks');
  const [rechargeSnap, redeemSnap] = await Promise.all([
    collectionRef
      .where('coadminUid', '==', coadminUid)
      .where('status', '==', 'completed')
      .where('type', '==', 'recharge')
      .where('completedAt', '>=', windowStart)
      .orderBy('completedAt', 'desc')
      .limit(CARER_TOTALS_HISTORY_LIMIT_PER_TYPE)
      .get(),
    collectionRef
      .where('coadminUid', '==', coadminUid)
      .where('status', '==', 'completed')
      .where('type', '==', 'redeem')
      .where('completedAt', '>=', windowStart)
      .orderBy('completedAt', 'desc')
      .limit(CARER_TOTALS_HISTORY_LIMIT_PER_TYPE)
      .get(),
  ]);

  const mapDoc = (docSnap: QueryDocumentSnapshot, type: 'recharge' | 'redeem') => {
    const data = docSnap.data() as Record<string, unknown>;
    return {
      id: docSnap.id,
      type,
      completedByCarerUid: cleanText(data.completedByCarerUid) || null,
      assignedCarerUid: cleanText(data.assignedCarerUid) || null,
      amount: Number(data.amount || 0),
    } satisfies CachedCarerTotalsTask;
  };

  return [
    ...rechargeSnap.docs.map((docSnap) => mapDoc(docSnap, 'recharge')),
    ...redeemSnap.docs.map((docSnap) => mapDoc(docSnap, 'redeem')),
  ];
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff']);
  if ('response' in auth) {
    return auth.response;
  }

  const scope = resolveScope(request);
  if (scope !== 'carer_totals') {
    return apiError('scope query parameter must be carer_totals.', 400);
  }

  const url = new URL(request.url);
  const requestedCoadminUid = cleanText(url.searchParams.get('coadminUid'));
  const scopedCoadmin = scopedCoadminUid(auth.user);
  const coadminUid =
    auth.user.role === 'coadmin'
      ? auth.user.uid
      : requestedCoadminUid || scopedCoadmin || '';

  if (!coadminUid) {
    return NextResponse.json({ tasks: [], source: 'postgres' });
  }

  if (
    auth.user.role !== 'admin' &&
    auth.user.role !== 'coadmin' &&
    scopedCoadmin &&
    coadminUid !== scopedCoadmin
  ) {
    return apiError('Forbidden.', 403);
  }

  const windowStartMs = Math.max(
    0,
    Number(url.searchParams.get('windowStartMs') || Date.now() - CARER_TOTALS_WINDOW_MS)
  );
  const windowStartIso = new Date(windowStartMs).toISOString();
  const sqlReadMode = isCacheSqlAuthoritative();

  const tasks = await readCarerRechargeRedeemTotalsFromCache(
    coadminUid,
    windowStartIso,
    CARER_TOTALS_HISTORY_LIMIT_PER_TYPE
  );

  if (tasks !== null) {
    if (sqlReadMode || tasks.length > 0) {
      logCacheSqlRead(ROUTE, {
        scope,
        coadminUid,
        count: tasks.length,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({ tasks, source: 'postgres' });
    }
  }

  if (sqlReadMode) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'carerTasks', { scope, coadminUid });
    return NextResponse.json({ tasks: [], source: 'postgres' });
  }

  const firestoreTasks = await readFirestoreCarerTotals(coadminUid, windowStartMs);
  return NextResponse.json({ tasks: firestoreTasks, source: 'firestore' });
}
