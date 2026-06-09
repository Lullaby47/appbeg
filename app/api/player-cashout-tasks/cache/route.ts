import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import {
  readPlayerCashoutTasksCacheByAssignedHandler,
  readPlayerCashoutTasksCacheByCoadmin,
  readPlayerCashoutTasksCacheByPlayer,
  type CachedPlayerCashoutTask,
} from '@/lib/sql/playerCashoutTasksCache';

const ROUTE = '/api/player-cashout-tasks/cache';

type Scope = 'player' | 'coadmin' | 'assigned_handler';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function resolveScope(request: Request): Scope | null {
  const scope = cleanText(new URL(request.url).searchParams.get('scope')).toLowerCase();
  if (scope === 'player' || scope === 'coadmin' || scope === 'assigned_handler') {
    return scope;
  }
  return null;
}

async function readFirestoreTasks(scope: Scope, uid: string, limit: number) {
  const collectionRef = adminDb.collection('playerCashoutTasks');
  const scopedQuery =
    scope === 'player'
      ? collectionRef.where('playerUid', '==', uid)
      : scope === 'coadmin'
        ? collectionRef.where('coadminUid', '==', uid)
        : collectionRef.where('assignedHandlerUid', '==', uid);
  const snap = await scopedQuery.orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    return {
      id: docSnap.id,
      coadminUid: cleanText(data.coadminUid),
      playerUid: cleanText(data.playerUid),
      playerUsername: cleanText(data.playerUsername),
      amountNpr: Number(data.amountNpr || 0),
      paymentDetails: cleanText(data.paymentDetails),
      payoutMethod: cleanText(data.payoutMethod) || null,
      qrImageUrl: cleanText(data.qrImageUrl) || null,
      paymentAppName: cleanText(data.paymentAppName) || null,
      paymentAppCashTag: cleanText(data.paymentAppCashTag) || null,
      paymentAppAccountName: cleanText(data.paymentAppAccountName) || null,
      cashDeductedOnRequest:
        typeof data.cashDeductedOnRequest === 'boolean' ? data.cashDeductedOnRequest : null,
      declinedByUids: Array.isArray(data.declinedByUids)
        ? data.declinedByUids.map((entry) => String(entry))
        : [],
      status: cleanText(data.status) || 'pending',
      assignedHandlerUid: cleanText(data.assignedHandlerUid) || null,
      assignedHandlerUsername: cleanText(data.assignedHandlerUsername) || null,
      startedAt: null,
      expiresAt: null,
      createdAt: null,
      completedAt: null,
    } satisfies CachedPlayerCashoutTask;
  });
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) {
    return auth.response;
  }

  const scope = resolveScope(request);
  if (!scope) {
    return apiError('scope query parameter is required (player|coadmin|assigned_handler).', 400);
  }

  const url = new URL(request.url);
  const requestedUid = cleanText(url.searchParams.get('uid'));
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
  const scopedCoadmin = scopedCoadminUid(auth.user);

  let targetUid = requestedUid;
  if (scope === 'player') {
    targetUid = auth.user.role === 'admin' ? requestedUid || auth.user.uid : auth.user.uid;
    if (!targetUid) {
      return apiError('uid is required for player scope.', 400);
    }
    if (auth.user.role === 'player' && targetUid !== auth.user.uid) {
      return apiError('Forbidden.', 403);
    }
  } else if (scope === 'coadmin') {
    targetUid =
      auth.user.role === 'coadmin'
        ? auth.user.uid
        : requestedUid || scopedCoadmin || '';
    if (!targetUid) {
      return NextResponse.json({ tasks: [], source: 'postgres' });
    }
    if (
      auth.user.role !== 'admin' &&
      auth.user.role !== 'coadmin' &&
      scopedCoadmin &&
      targetUid !== scopedCoadmin
    ) {
      return apiError('Forbidden.', 403);
    }
  } else {
    targetUid = auth.user.role === 'admin' ? requestedUid || auth.user.uid : auth.user.uid;
    if (
      auth.user.role !== 'admin' &&
      auth.user.role !== 'staff' &&
      auth.user.role !== 'carer' &&
      targetUid !== auth.user.uid
    ) {
      return apiError('Forbidden.', 403);
    }
  }

  if (!targetUid) {
    return apiError('uid is required for this scope.', 400);
  }

  const sqlReadMode = isCacheSqlAuthoritative();
  let tasks: CachedPlayerCashoutTask[] | null = null;

  if (scope === 'player') {
    tasks = await readPlayerCashoutTasksCacheByPlayer(targetUid, limit);
  } else if (scope === 'coadmin') {
    tasks = await readPlayerCashoutTasksCacheByCoadmin(targetUid, limit);
  } else {
    tasks = await readPlayerCashoutTasksCacheByAssignedHandler(targetUid, limit);
  }

  if (tasks !== null) {
    if (sqlReadMode) {
      logCacheSqlRead(ROUTE, {
        scope,
        uid: targetUid,
        count: tasks.length,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({ tasks, source: 'postgres' });
    }
    if (tasks.length > 0) {
      return NextResponse.json({ tasks, source: 'postgres' });
    }
  }

  if (sqlReadMode) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'playerCashoutTasks', { scope, uid: targetUid });
    return NextResponse.json({ tasks: [], source: 'postgres' });
  }

  const firestoreTasks = await readFirestoreTasks(scope, targetUid, limit);
  return NextResponse.json({ tasks: firestoreTasks, source: 'firestore' });
}
