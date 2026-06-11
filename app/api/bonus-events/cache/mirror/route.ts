import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheSqlRead,
  mirrorSqlSkipResponse,
} from '@/lib/server/cacheSqlRead';
import { logFirestoreTouch, routeFromRequest } from '@/lib/server/firestoreTouchAudit';
import { mirrorBonusEventSnapshot, upsertBonusEventCache } from '@/lib/sql/bonusEventsCache';

export const runtime = 'nodejs';

type MirrorBody = {
  bonusEventId?: unknown;
  bonusEventIds?: unknown;
  eventId?: unknown;
  eventIds?: unknown;
  action?: unknown;
  raw?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readEventIds(body: MirrorBody) {
  const ids = Array.isArray(body.bonusEventIds)
    ? body.bonusEventIds
    : Array.isArray(body.eventIds)
      ? body.eventIds
      : [body.bonusEventId || body.eventId];
  return ids.map(cleanText).filter(Boolean).slice(0, 200);
}

function readRawRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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
  const eventIds = readEventIds(body);
  const raw = readRawRecord(body.raw);

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  if (raw && eventIds.length === 1) {
    const mirrored = await upsertBonusEventCache({
      firebaseId: eventIds[0],
      raw,
      source: 'appbeg_browser_write',
    });
    logCacheSqlRead(route, {
      action: 'upsert_raw',
      bonusEventId: eventIds[0],
      mirrored,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ success: mirrored, mirroredCount: mirrored ? 1 : 0 });
  }

  if (!eventIds.length) {
    return apiError('bonusEventId is required.', 400);
  }

  if (isCacheSqlAuthoritative()) {
    return mirrorSqlSkipResponse(route, 'bonusEvents', { count: eventIds.length });
  }

  logFirestoreTouch({
    firestore_touch_type: 'mirror_write_can_disable',
    route,
    operation: 'read',
    collection: 'bonusEvents',
    details: { action: 'upsert', count: eventIds.length },
  });

  const snaps = await Promise.all(
    eventIds.map((eventId) => adminDb.collection('bonusEvents').doc(eventId).get())
  );
  const mirrored = await Promise.all(snaps.map((snap) => mirrorBonusEventSnapshot(snap)));

  return NextResponse.json({
    success: true,
    mirrored: mirrored.filter(Boolean).length,
  });
}
