import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { logCacheSqlRead } from '@/lib/server/cacheSqlRead';
import {
  createCarerEscalationAlertInSql,
  readCarerEscalationAlertsByCoadmin,
} from '@/lib/sql/carerEscalationAlertsCache';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';

const ROUTE = '/api/carer/escalation-alerts';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return auth.response;
  }

  const url = new URL(request.url);
  const requestedCoadminUid = cleanText(url.searchParams.get('coadminUid'));
  const scoped = scopedCoadminUid(auth.user);
  const coadminUid =
    auth.user.role === 'coadmin' ? auth.user.uid : requestedCoadminUid || scoped || '';
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 24)));

  if (!coadminUid) {
    return NextResponse.json({ alerts: [], source: 'postgres' });
  }

  const alerts = await readCarerEscalationAlertsByCoadmin(coadminUid, limit);
  logCacheSqlRead(ROUTE, {
    coadminUid,
    count: alerts?.length || 0,
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({
    alerts: alerts || [],
    source: 'postgres',
    firestore_fallback: false,
  });
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) {
    return auth.response;
  }

  if (!isDatabaseUrlConfigured()) {
    return apiError('Escalation alerts are unavailable in SQL mode right now.', 503);
  }

  const body = (await request.json().catch(() => ({}))) as {
    coadminUid?: string;
    contextType?: string;
    escalationFrom?: string;
    taskId?: string | null;
    playerUid?: string | null;
    playerUsername?: string | null;
    gameName?: string | null;
    message?: string | null;
    createdByCarerUid?: string | null;
    createdByCarerUsername?: string | null;
  };

  const coadminUid = cleanText(body.coadminUid);
  if (!coadminUid) {
    return apiError('coadminUid is required.', 400);
  }

  const created = await createCarerEscalationAlertInSql({
    coadminUid,
    contextType: cleanText(body.contextType) || null,
    escalationFrom: cleanText(body.escalationFrom) || null,
    taskId: cleanText(body.taskId) || null,
    playerUid: cleanText(body.playerUid) || null,
    playerUsername: cleanText(body.playerUsername) || null,
    gameName: cleanText(body.gameName) || null,
    message: cleanText(body.message) || null,
    createdByCarerUid: cleanText(body.createdByCarerUid) || auth.user.uid,
    createdByCarerUsername: cleanText(body.createdByCarerUsername) || null,
  });

  if (!created) {
    return apiError('Failed to create escalation alert.', 500);
  }

  return NextResponse.json({
    success: true,
    alertId: created.id,
    createdAt: created.createdAt,
    source: 'postgres',
    firestore_fallback: false,
  });
}
