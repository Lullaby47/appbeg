import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { isCacheSqlAuthoritative, mirrorSqlSkipResponse } from '@/lib/server/cacheSqlRead';
import { routeFromRequest } from '@/lib/server/firestoreTouchAudit';
import {
  mirrorPlayerGameLoginSnapshot,
  tombstonePlayerGameLoginCache,
} from '@/lib/sql/playerGameLoginsCache';

type MirrorBody = {
  loginId?: unknown;
  loginIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readLoginIds(body: MirrorBody) {
  const ids = Array.isArray(body.loginIds) ? body.loginIds : [body.loginId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const loginIds = readLoginIds(body);
  if (!loginIds.length) {
    return apiError('loginId is required.', 400);
  }

  if (action === 'tombstone') {
    await Promise.all(
      loginIds.map((loginId) => tombstonePlayerGameLoginCache(loginId, 'appbeg_browser_delete'))
    );
    return NextResponse.json({ success: true, mirrored: loginIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  if (isCacheSqlAuthoritative()) {
    return mirrorSqlSkipResponse(
      routeFromRequest(request),
      'playerGameLogins',
      { count: loginIds.length }
    );
  }

  const snaps = await Promise.all(
    loginIds.map((loginId) => adminDb.collection('playerGameLogins').doc(loginId).get())
  );
  await Promise.all(
    snaps.map((snap) => mirrorPlayerGameLoginSnapshot(snap, 'appbeg_browser_write'))
  );

  return NextResponse.json({ success: true, mirrored: snaps.filter((snap) => snap.exists).length });
}
