import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheSqlRead,
  mirrorSqlSkipResponse,
} from '@/lib/server/cacheSqlRead';
import { logFirestoreTouch, routeFromRequest } from '@/lib/server/firestoreTouchAudit';
import { mirrorUserPresenceSnapshot } from '@/lib/sql/userPresenceCache';

export const runtime = 'nodejs';

type MirrorBody = {
  uid?: unknown;
  uids?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readUids(body: MirrorBody) {
  const ids = Array.isArray(body.uids) ? body.uids : [body.uid];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const route = routeFromRequest(request);
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff']);
  if ('response' in auth) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const uids = readUids(body);

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  if (!uids.length) {
    return apiError('uid is required.', 400);
  }

  if (isCacheSqlAuthoritative()) {
    return mirrorSqlSkipResponse(route, 'userPresence', { count: uids.length });
  }

  logFirestoreTouch({
    firestore_touch_type: 'mirror_write_can_disable',
    route,
    operation: 'read',
    collection: 'userPresence',
    details: { action: 'upsert', count: uids.length },
  });

  const snaps = await Promise.all(
    uids.map((uid) => adminDb.collection('userPresence').doc(uid).get())
  );
  const mirrored = await Promise.all(snaps.map((snap) => mirrorUserPresenceSnapshot(snap)));

  logCacheSqlRead(route, {
    count: mirrored.filter(Boolean).length,
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({
    success: true,
    mirrored: mirrored.filter(Boolean).length,
  });
}
