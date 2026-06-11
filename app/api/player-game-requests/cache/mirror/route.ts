import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { isCacheSqlAuthoritative, mirrorSqlSkipResponse } from '@/lib/server/cacheSqlRead';
import {

  mirrorPlayerGameRequestSnapshot,
  tombstonePlayerGameRequestCache,
} from '@/lib/sql/playerGameRequestsCache';

export const runtime = 'nodejs';

type MirrorBody = {
  requestId?: unknown;
  requestIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readRequestIds(body: MirrorBody) {
  const ids = Array.isArray(body.requestIds) ? body.requestIds : [body.requestId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const requestIds = readRequestIds(body);
  if (!requestIds.length) {
    return apiError('requestId is required.', 400);
  }

  if (action === 'tombstone') {
    await Promise.all(
      requestIds.map((requestId) =>
        tombstonePlayerGameRequestCache(requestId, 'appbeg_browser_delete')
      )
    );
    return NextResponse.json({ success: true, mirrored: requestIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  if (isCacheSqlAuthoritative()) {
    return mirrorSqlSkipResponse('/api/player-game-requests/cache/mirror', 'playerGameRequests', {
      count: requestIds.length,
    });
  }

  const snaps = await Promise.all(
    requestIds.map((requestId) => adminDb.collection('playerGameRequests').doc(requestId).get())
  );
  await Promise.all(
    snaps.map((snap) => mirrorPlayerGameRequestSnapshot(snap, 'appbeg_browser_write'))
  );

  return NextResponse.json({ success: true, mirrored: snaps.filter((snap) => snap.exists).length });
}
