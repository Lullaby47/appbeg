import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  mirrorFinancialEventSnapshot,
  tombstoneFinancialEventCache,
} from '@/lib/sql/financialEventsCache';

type MirrorBody = {
  financialEventId?: unknown;
  financialEventIds?: unknown;
  eventId?: unknown;
  eventIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readEventIds(body: MirrorBody) {
  const ids = Array.isArray(body.financialEventIds)
    ? body.financialEventIds
    : Array.isArray(body.eventIds)
      ? body.eventIds
      : [body.financialEventId || body.eventId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const eventIds = readEventIds(body);
  if (!eventIds.length) {
    return apiError('financialEventId is required.', 400);
  }

  if (action === 'tombstone') {
    await Promise.all(
      eventIds.map((eventId) =>
        tombstoneFinancialEventCache(eventId, 'appbeg_browser_delete')
      )
    );
    return NextResponse.json({ success: true, mirrored: eventIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  const snaps = await Promise.all(
    eventIds.map((eventId) => adminDb.collection('financialEvents').doc(eventId).get())
  );
  await Promise.all(
    snaps.map((snap) => mirrorFinancialEventSnapshot(snap, 'appbeg_browser_write'))
  );

  return NextResponse.json({ success: true, mirrored: snaps.filter((snap) => snap.exists).length });
}
