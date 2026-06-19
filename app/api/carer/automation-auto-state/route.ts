import { apiError, requireCarerApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';
import { firestoreFallbackRemovedResponse } from '@/lib/server/cacheSqlRead';

import { getAutomationAutoStateSql, postAutomationAutoStateSql } from './sqlRoute';
import { logAutomationAutoStateRouteVersion } from './routeVersion';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const startedAt = Date.now();
  const sqlMode = isAuthSqlReadEnabled();

  logAutomationAutoStateRouteVersion({
    method: 'GET',
    sqlMode,
    carerUid: null,
    branch: 'entry',
  });

  const auth = await requireCarerApiUser(request);
  if ('response' in auth) {
    logAutomationAutoStateRouteVersion({
      method: 'GET',
      sqlMode,
      carerUid: null,
      branch: 'auth_failure',
    });
    return auth.response;
  }

  const coadminUid = scopedCoadminUid(auth.user);

  if (sqlMode) {
    return getAutomationAutoStateSql({
      carerUid: auth.user.uid,
      coadminUid,
      startedAt,
    });
  }

  return firestoreFallbackRemovedResponse('/api/carer/automation-auto-state', {
    method: 'GET',
    carerUid: auth.user.uid,
    sqlMode,
  });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const sqlMode = isAuthSqlReadEnabled();

  logAutomationAutoStateRouteVersion({
    method: 'POST',
    sqlMode,
    carerUid: null,
    branch: 'entry',
  });

  const auth = await requireCarerApiUser(request);
  if ('response' in auth) {
    logAutomationAutoStateRouteVersion({
      method: 'POST',
      sqlMode,
      carerUid: null,
      branch: 'auth_failure',
    });
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
  const enabled = body.enabled === true;
  const coadminUid = scopedCoadminUid(auth.user);
  if (!coadminUid) {
    logAutomationAutoStateRouteVersion({
      method: 'POST',
      sqlMode,
      carerUid: auth.user.uid,
      branch: 'missing_coadmin',
    });
    return apiError('Coadmin scope is required.', 400);
  }

  if (sqlMode) {
    return postAutomationAutoStateSql({
      carerUid: auth.user.uid,
      coadminUid,
      enabled,
      startedAt,
    });
  }

  return firestoreFallbackRemovedResponse('/api/carer/automation-auto-state', {
    method: 'POST',
    carerUid: auth.user.uid,
    sqlMode,
  });
}
