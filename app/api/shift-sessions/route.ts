import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { logCacheSqlRead } from '@/lib/server/cacheSqlRead';
import {
  endShiftSessionInSql,
  heartbeatShiftSessionInSql,
  readShiftSessionsByCoadmin,
  startShiftSessionInSql,
} from '@/lib/sql/shiftSessionsCache';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';

const ROUTE = '/api/shift-sessions';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) {
    return auth.response;
  }

  const url = new URL(request.url);
  const requestedCoadminUid = cleanText(url.searchParams.get('coadminUid'));
  const scoped = scopedCoadminUid(auth.user);
  const coadminUid =
    auth.user.role === 'coadmin' ? auth.user.uid : requestedCoadminUid || scoped || '';

  if (!coadminUid) {
    return NextResponse.json({ sessions: [], source: 'postgres' });
  }

  if (
    auth.user.role !== 'admin' &&
    auth.user.role !== 'coadmin' &&
    scoped &&
    coadminUid !== scoped
  ) {
    return apiError('Forbidden.', 403);
  }

  const sessions = await readShiftSessionsByCoadmin(coadminUid);
  logCacheSqlRead(ROUTE, {
    coadminUid,
    count: sessions?.length || 0,
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({
    sessions: sessions || [],
    source: 'postgres',
    firestore_fallback: false,
  });
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) {
    return auth.response;
  }

  if (!isDatabaseUrlConfigured()) {
    return apiError('Shift sessions are unavailable in SQL mode right now.', 503);
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    sessionId?: string;
    coadminUid?: string;
    userUid?: string;
    userRole?: string;
    userUsername?: string;
  };

  const action = cleanText(body.action).toLowerCase();
  const userUid = cleanText(body.userUid) || auth.user.uid;

  if (auth.user.role !== 'admin' && auth.user.role !== 'coadmin' && userUid !== auth.user.uid) {
    return apiError('Forbidden.', 403);
  }

  if (action === 'start') {
    const coadminUid = cleanText(body.coadminUid);
    const userRole = cleanText(body.userRole) as 'staff' | 'carer';
    const userUsername = cleanText(body.userUsername) || 'User';
    if (!coadminUid || (userRole !== 'staff' && userRole !== 'carer')) {
      return apiError('coadminUid and userRole are required.', 400);
    }
    const sessionId = await startShiftSessionInSql({
      coadminUid,
      userUid,
      userRole,
      userUsername,
    });
    if (!sessionId) {
      return apiError('Failed to start shift session.', 500);
    }
    return NextResponse.json({
      success: true,
      sessionId,
      source: 'postgres',
      firestore_fallback: false,
    });
  }

  if (action === 'heartbeat') {
    const sessionId = cleanText(body.sessionId);
    if (!sessionId) {
      return apiError('sessionId is required.', 400);
    }
    await heartbeatShiftSessionInSql(sessionId, userUid);
    return NextResponse.json({ success: true, source: 'postgres', firestore_fallback: false });
  }

  if (action === 'end') {
    const sessionId = cleanText(body.sessionId);
    if (!sessionId) {
      return apiError('sessionId is required.', 400);
    }
    await endShiftSessionInSql(sessionId, userUid);
    return NextResponse.json({ success: true, source: 'postgres', firestore_fallback: false });
  }

  return apiError('Invalid shift session action.', 400);
}
