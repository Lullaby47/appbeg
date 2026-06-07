import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  mirrorUserBalanceSnapshotSnapshot,
  tombstoneUserBalanceSnapshotCache,
} from '@/lib/sql/userBalanceSnapshotsCache';

type MirrorBody = {
  uid?: unknown;
  uids?: unknown;
  userId?: unknown;
  userIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readUserIds(body: MirrorBody) {
  const ids = Array.isArray(body.uids)
    ? body.uids
    : Array.isArray(body.userIds)
      ? body.userIds
      : [body.uid || body.userId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const userIds = readUserIds(body);
  if (!userIds.length) {
    return apiError('uid is required.', 400);
  }

  if (action === 'tombstone') {
    await Promise.all(
      userIds.map((uid) => tombstoneUserBalanceSnapshotCache(uid, 'appbeg_browser_delete'))
    );
    return NextResponse.json({ success: true, mirrored: userIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  const snaps = await Promise.all(userIds.map((uid) => adminDb.collection('users').doc(uid).get()));
  await Promise.all(
    snaps.map((snap) => mirrorUserBalanceSnapshotSnapshot(snap, 'appbeg_browser_write'))
  );

  return NextResponse.json({ success: true, mirrored: snaps.filter((snap) => snap.exists).length });
}
