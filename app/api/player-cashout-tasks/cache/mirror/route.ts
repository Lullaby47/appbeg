import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  mirrorPlayerCashoutTaskSnapshot,
  tombstonePlayerCashoutTaskCache,
} from '@/lib/sql/playerCashoutTasksCache';

type MirrorBody = {
  taskId?: unknown;
  taskIds?: unknown;
  cashoutTaskId?: unknown;
  cashoutTaskIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readTaskIds(body: MirrorBody) {
  const ids = Array.isArray(body.taskIds)
    ? body.taskIds
    : Array.isArray(body.cashoutTaskIds)
      ? body.cashoutTaskIds
      : [body.taskId || body.cashoutTaskId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const taskIds = readTaskIds(body);
  if (!taskIds.length) {
    return apiError('taskId is required.', 400);
  }

  if (action === 'tombstone') {
    await Promise.all(
      taskIds.map((taskId) =>
        tombstonePlayerCashoutTaskCache(taskId, 'appbeg_browser_delete')
      )
    );
    return NextResponse.json({ success: true, mirrored: taskIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  const snaps = await Promise.all(
    taskIds.map((taskId) => adminDb.collection('playerCashoutTasks').doc(taskId).get())
  );
  await Promise.all(
    snaps.map((snap) => mirrorPlayerCashoutTaskSnapshot(snap, 'appbeg_browser_write'))
  );

  return NextResponse.json({ success: true, mirrored: snaps.filter((snap) => snap.exists).length });
}
