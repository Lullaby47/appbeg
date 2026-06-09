import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';
import { logFirestoreTouch, routeFromRequest } from '@/lib/server/firestoreTouchAudit';
import {
  mirrorCarerTaskIdsBatch,
  mirrorCarerTaskSnapshotsBatch,
  tombstoneCarerTaskIdsBatch,
} from '@/lib/sql/carerTasksCache';

type MirrorBody = {
  taskId?: unknown;
  taskIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readTaskIds(body: MirrorBody) {
  const ids = Array.isArray(body.taskIds) ? body.taskIds : [body.taskId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const taskIds = readTaskIds(body);
  if (!taskIds.length) {
    return apiError('taskId is required.', 400);
  }

  if (action === 'tombstone') {
    const mirrored = await tombstoneCarerTaskIdsBatch(taskIds, 'appbeg_browser_delete');
    return NextResponse.json({ success: true, mirrored, requested: taskIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  const route = routeFromRequest(request);
  if (isAuthSqlReadEnabled()) {
    logFirestoreTouch({
      firestore_touch_type: 'mirror_write_can_disable',
      route,
      operation: 'read',
      collection: 'carerTasks',
      skipped: true,
      sql_read_mode: true,
      details: { reason: 'sql_cache_authoritative', taskCount: taskIds.length },
    });
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'sql_cache_authoritative',
    });
  }

  if (taskIds.length === 1) {
    logFirestoreTouch({
      firestore_touch_type: 'mirror_write_can_disable',
      route,
      operation: 'read',
      collection: 'carerTasks',
      document_id: taskIds[0],
      details: { action: 'upsert_single', mirror_target: 'carer_tasks_cache' },
    });
    const snap = await adminDb.collection('carerTasks').doc(taskIds[0]).get();
    const mirrored = await mirrorCarerTaskSnapshotsBatch([snap], 'appbeg_browser_write');
    return NextResponse.json({ success: true, mirrored, requested: taskIds.length });
  }

  logFirestoreTouch({
    firestore_touch_type: 'mirror_write_can_disable',
    route,
    operation: 'read',
    collection: 'carerTasks',
    details: { action: 'upsert_batch', count: taskIds.length, mirror_target: 'carer_tasks_cache' },
  });
  const mirrored = await mirrorCarerTaskIdsBatch(taskIds, 'appbeg_browser_write');
  return NextResponse.json({ success: true, mirrored, requested: taskIds.length });
}
