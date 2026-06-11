import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import {
  apiError,
  requireApiUser,
  requirePlayerApiUser,
  scopedCoadminUid,
} from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import { logPlayerApiAuthOk } from '@/lib/server/playerApiAuthLog';
import { extractPgErrorDetails } from '@/lib/server/sqlErrorDetails';
import {

  readPlayerCashoutTasksCacheByAssignedHandler,
  readPlayerCashoutTasksCacheByCoadmin,
  readPlayerCashoutTasksCacheByPlayer,
  type CachedPlayerCashoutTask,
} from '@/lib/sql/playerCashoutTasksCache';

export const runtime = 'nodejs';

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
  const url = new URL(request.url);
  const scope = resolveScope(request);
  if (!scope) {
    return apiError('scope query parameter is required (player|coadmin|assigned_handler).', 400);
  }

  const sqlReadMode = isCacheSqlAuthoritative();

  try {
    let user;
    if (scope === 'player') {
      const playerAuth = await requirePlayerApiUser(request);
      if ('response' in playerAuth) {
        return playerAuth.response;
      }
      user = playerAuth.user;
      logPlayerApiAuthOk(request, {
        route: ROUTE,
        uid: playerAuth.user.uid,
        role: playerAuth.user.role,
        authPath: playerAuth.authPath,
      });
    } else {
      const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
      if ('response' in auth) {
        return auth.response;
      }
      user = auth.user;
    }

    const requestedUid = cleanText(url.searchParams.get('uid'));
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
    const scopedCoadmin = scopedCoadminUid(user);

    let targetUid = requestedUid;
    if (scope === 'player') {
      targetUid = user.role === 'admin' ? requestedUid || user.uid : user.uid;
      if (!targetUid) {
        return apiError('uid is required for player scope.', 400);
      }
      if (user.role === 'player' && targetUid !== user.uid) {
        return apiError('Forbidden.', 403);
      }
    } else if (scope === 'coadmin') {
      targetUid =
        user.role === 'coadmin' ? user.uid : requestedUid || scopedCoadmin || '';
      if (!targetUid) {
        return NextResponse.json({ tasks: [], source: 'postgres' });
      }
      if (
        user.role !== 'admin' &&
        user.role !== 'coadmin' &&
        scopedCoadmin &&
        targetUid !== scopedCoadmin
      ) {
        return apiError('Forbidden.', 403);
      }
    } else {
      targetUid = user.role === 'admin' ? requestedUid || user.uid : user.uid;
      if (
        user.role !== 'admin' &&
        user.role !== 'staff' &&
        user.role !== 'carer' &&
        targetUid !== user.uid
      ) {
        return apiError('Forbidden.', 403);
      }
    }

    if (!targetUid) {
      return apiError('uid is required for this scope.', 400);
    }

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
  } catch (error) {
    const pg = extractPgErrorDetails(error);
    console.error('[PLAYER_CASHOUT_TASKS_CACHE_ERROR]', {
      uid: cleanText(url.searchParams.get('uid')) || null,
      scope,
      sqlMode: sqlReadMode,
      query: `player_cashout_tasks_cache.${scope}`,
      durationMs: Date.now() - startedAt,
      ...pg,
    });
    if (sqlReadMode) {
      return NextResponse.json({ tasks: [], source: 'postgres' });
    }
    return apiError('Failed to load cashout tasks.', 500);
  }
}
