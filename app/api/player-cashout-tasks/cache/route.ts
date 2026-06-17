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
import { API_ROUTE_SLOW_MS, isSqlCacheVerboseLogs } from '@/lib/server/verboseLogs';
import { logPlayerApiAuthOk } from '@/lib/server/playerApiAuthLog';
import { extractPgErrorDetails } from '@/lib/server/sqlErrorDetails';
import {
  readCoadminActiveCashoutTasks,
  readCoadminCompletedCashoutTasks,
  readPlayerCashoutTasksCacheByAssignedHandler,
  readPlayerCashoutTasksCacheByCoadmin,
  readPlayerCashoutTasksCacheByPlayer,
  readPlayerCashoutTasksCacheAll,
  readStaffActiveCashoutTasks,
  readStaffCompletedCashoutTasks,
  readStaffPendingCashoutTasks,
  type CachedPlayerCashoutTask,
} from '@/lib/sql/playerCashoutTasksCache';
import { releaseExpiredPlayerCashoutTasksForCoadminInSql } from '@/lib/sql/authorityCashout';

export const runtime = 'nodejs';

const ROUTE = '/api/player-cashout-tasks/cache';

type Scope = 'player' | 'coadmin' | 'staff' | 'assigned_handler' | 'all';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function resolveScope(request: Request): Scope | null {
  const scope = cleanText(new URL(request.url).searchParams.get('scope')).toLowerCase();
  if (scope === 'player' || scope === 'coadmin' || scope === 'staff' || scope === 'assigned_handler' || scope === 'all') {
    return scope;
  }
  return null;
}

async function readFirestoreTasks(scope: Scope, uid: string, limit: number) {
  const collectionRef = adminDb.collection('playerCashoutTasks');
  const scopedQuery =
    scope === 'player'
      ? collectionRef.where('playerUid', '==', uid)
      : scope === 'coadmin' || scope === 'staff'
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

type CashoutTaskList = 'pending' | 'active' | 'completed' | 'lifecycle';

function resolveCashoutTaskList(request: Request): CashoutTaskList {
  const list = cleanText(new URL(request.url).searchParams.get('list')).toLowerCase();
  if (list === 'active' || list === 'completed' || list === 'lifecycle') {
    return list;
  }
  return 'pending';
}

function isPendingUnclaimedTask(task: CachedPlayerCashoutTask) {
  return cleanText(task.status).toLowerCase() === 'pending' && !cleanText(task.assignedHandlerUid);
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const scope = resolveScope(request);
  if (!scope) {
    return apiError('scope query parameter is required (player|coadmin|staff|assigned_handler|all).', 400);
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
      const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
      if ('response' in auth) {
        return auth.response;
      }
      user = auth.user;
    }

    const requestedUid = cleanText(url.searchParams.get('uid'));
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
    const scopedCoadmin = scopedCoadminUid(user);

    let targetUid = requestedUid;

    if (scope === 'all') {
      if (user.role !== 'admin') {
        return apiError('Forbidden.', 403);
      }
      targetUid = '';
    } else if (scope === 'player') {
      targetUid = user.role === 'admin' ? requestedUid || user.uid : user.uid;
      if (!targetUid) {
        return apiError('uid is required for player scope.', 400);
      }
      if (user.role === 'player' && targetUid !== user.uid) {
        return apiError('Forbidden.', 403);
      }
    } else if (scope === 'coadmin') {
      targetUid =
        user.role === 'coadmin'
          ? user.uid
          : user.role === 'admin'
            ? requestedUid || scopedCoadmin || ''
            : requestedUid || scopedCoadmin || '';
      if (!targetUid) {
        return NextResponse.json({ tasks: [], source: 'postgres' });
      }
      if (
        user.role !== 'admin' &&
        user.role !== 'coadmin' &&
        user.role !== 'staff' &&
        (!scopedCoadmin || targetUid !== scopedCoadmin)
      ) {
        return apiError('Forbidden.', 403);
      }
    } else if (scope === 'staff') {
      if (user.role !== 'staff' && user.role !== 'admin') {
        return apiError('Forbidden.', 403);
      }
      targetUid =
        user.role === 'staff'
          ? scopedCoadmin || ''
          : requestedUid || scopedCoadmin || '';
      if (!targetUid) {
        return NextResponse.json({ tasks: [], source: 'postgres' });
      }
      if (user.role === 'staff' && scopedCoadmin && targetUid !== scopedCoadmin) {
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

    if (!targetUid && scope !== 'all') {
      return apiError('uid is required for this scope.', 400);
    }

    let tasks: CachedPlayerCashoutTask[] | null = null;

    if (scope === 'all') {
      tasks = await readPlayerCashoutTasksCacheAll(limit);
    } else if (scope === 'player') {
      tasks = await readPlayerCashoutTasksCacheByPlayer(targetUid, limit);
    } else if (scope === 'coadmin' || scope === 'staff') {
      const taskList = resolveCashoutTaskList(request);
      if (scope === 'staff') {
        await releaseExpiredPlayerCashoutTasksForCoadminInSql(targetUid);
      }
      if (taskList === 'lifecycle') {
        const [pending, active, completed] = await Promise.all([
          readStaffPendingCashoutTasks(targetUid, limit),
          scope === 'staff'
            ? readStaffActiveCashoutTasks(targetUid, user.uid, limit)
            : readCoadminActiveCashoutTasks(targetUid, limit),
          scope === 'staff'
            ? readStaffCompletedCashoutTasks(targetUid, user.uid, limit)
            : readCoadminCompletedCashoutTasks(targetUid, limit),
        ]);

        if (pending !== null && active !== null && completed !== null) {
          const lifecycle = {
            pending,
            active,
            completed,
          };
          const durationMs = Date.now() - startedAt;
          if (isSqlCacheVerboseLogs() || durationMs >= API_ROUTE_SLOW_MS) {
            console.info('[CASHOUT_LIFECYCLE_QUERY]', {
              scope,
              uid: targetUid,
              pendingCount: pending.length,
              activeCount: active.length,
              completedCount: completed.length,
              sqlMode: sqlReadMode,
              durationMs,
            });
          }
          if (sqlReadMode) {
            logCacheSqlRead(ROUTE, {
              scope,
              uid: targetUid,
              list: taskList,
              count: pending.length + active.length + completed.length,
              durationMs,
            });
          }
          return NextResponse.json({
            tasks: pending,
            lifecycle,
            source: 'postgres',
          });
        }

        if (sqlReadMode) {
          logCacheFirestoreFallbackBlocked(ROUTE, 'playerCashoutTasks', {
            scope,
            uid: targetUid,
            list: taskList,
          });
          return NextResponse.json({
            tasks: [],
            lifecycle: { pending: [], active: [], completed: [] },
            source: 'postgres',
          });
        }
      } else if (taskList === 'active') {
        tasks =
          scope === 'staff'
            ? await readStaffActiveCashoutTasks(targetUid, user.uid, limit)
            : await readCoadminActiveCashoutTasks(targetUid, limit);
      } else if (taskList === 'completed') {
        tasks =
          scope === 'staff'
            ? await readStaffCompletedCashoutTasks(targetUid, user.uid, limit)
            : await readCoadminCompletedCashoutTasks(targetUid, limit);
        if (isSqlCacheVerboseLogs()) {
          console.info('[CASHOUT_COMPLETED_TASKS_CACHE]', scope === 'staff' ? 'staffScope' : 'coadminScope', {
            coadminUid: targetUid,
            staffUid: scope === 'staff' ? user.uid : null,
            count: tasks?.length ?? 0,
          });
        }
      } else {
        tasks = await readStaffPendingCashoutTasks(targetUid, limit);
      }
      if (scope === 'staff' && user.role === 'staff') {
        if (isSqlCacheVerboseLogs()) {
          console.info('[PLAYER_CASHOUT_TASKS_CACHE] staffScope', {
            staffUid: user.uid,
            coadminUid: targetUid,
            list: taskList,
            count: tasks?.length ?? 0,
          });
        }
      }
      if (scope === 'coadmin' && (user.role === 'coadmin' || user.role === 'admin')) {
        if (isSqlCacheVerboseLogs()) {
          console.info('[PLAYER_CASHOUT_TASKS_CACHE] coadminScope', {
            coadminUid: targetUid,
            list: taskList,
            count: tasks?.length ?? 0,
          });
        }
      }
    } else {
      tasks = await readPlayerCashoutTasksCacheByAssignedHandler(targetUid, limit);
    }

    if (tasks !== null) {
      const durationMs = Date.now() - startedAt;
      if (isSqlCacheVerboseLogs() || durationMs >= API_ROUTE_SLOW_MS) {
        console.info('[CASHOUT_LIST_QUERY]', {
          scope,
          uid: scope === 'all' ? null : targetUid,
          count: tasks.length,
          sqlMode: sqlReadMode,
          durationMs,
        });
      }
      if (sqlReadMode) {
        logCacheSqlRead(ROUTE, {
          scope,
          uid: scope === 'all' ? 'all' : targetUid,
          count: tasks.length,
          durationMs,
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

    let firestoreTasks = await readFirestoreTasks(scope, targetUid, limit);
    if (scope === 'coadmin' || scope === 'staff') {
      firestoreTasks = firestoreTasks.filter(isPendingUnclaimedTask);
    }
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
