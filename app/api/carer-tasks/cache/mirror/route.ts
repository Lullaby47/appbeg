import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
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

  if (taskIds.length === 1) {
    const snap = await adminDb.collection('carerTasks').doc(taskIds[0]).get();
    const mirrored = await mirrorCarerTaskSnapshotsBatch([snap], 'appbeg_browser_write');
    return NextResponse.json({ success: true, mirrored, requested: taskIds.length });
  }

  const mirrored = await mirrorCarerTaskIdsBatch(taskIds, 'appbeg_browser_write');
  return NextResponse.json({ success: true, mirrored, requested: taskIds.length });
}
