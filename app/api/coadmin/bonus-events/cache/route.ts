import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  firestoreFallbackRemovedResponse,
  isCacheSqlAuthoritative,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import {

  readActiveBonusEventsByCoadmin,
  readCoadminAutoBonusPercentRangeFromSql,
  type CachedBonusEvent,
} from '@/lib/sql/bonusEventsCache';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/bonus-events/cache';

const COADMIN_AUTO_BONUS_PERCENT_MIN = 5;
const COADMIN_AUTO_BONUS_PERCENT_MAX = 30;

function normalizeAutoBonusPercentRange(values: {
  minPercent?: number | null;
  maxPercent?: number | null;
}) {
  const rawMin = Number(values.minPercent);
  const rawMax = Number(values.maxPercent);
  const fallbackMin = 5;
  const fallbackMax = 10;

  const minPercent = Number.isFinite(rawMin) ? Math.round(rawMin) : fallbackMin;
  const maxPercent = Number.isFinite(rawMax) ? Math.round(rawMax) : fallbackMax;

  const boundedMin = Math.min(
    COADMIN_AUTO_BONUS_PERCENT_MAX,
    Math.max(COADMIN_AUTO_BONUS_PERCENT_MIN, minPercent)
  );
  const boundedMax = Math.min(
    COADMIN_AUTO_BONUS_PERCENT_MAX,
    Math.max(COADMIN_AUTO_BONUS_PERCENT_MIN, maxPercent)
  );

  return {
    minPercent: Math.min(boundedMin, boundedMax),
    maxPercent: Math.max(boundedMin, boundedMax),
  };
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff']);
  if ('response' in auth) {
    return auth.response;
  }

  const url = new URL(request.url);
  const requestedCoadminUid = String(url.searchParams.get('coadminUid') || '').trim();
  const includeInactive = url.searchParams.get('includeInactive') === '1';
  const scoped = scopedCoadminUid(auth.user);
  const coadminUid =
    auth.user.role === 'coadmin'
      ? auth.user.uid
      : requestedCoadminUid || scoped || '';

  if (!coadminUid) {
    return apiError('coadminUid is required.', 400);
  }

  if (auth.user.role !== 'admin' && scoped && coadminUid !== scoped) {
    return apiError('Forbidden.', 403);
  }

  const sqlReadMode = isCacheSqlAuthoritative();
  let events: CachedBonusEvent[] = [];
  const source = 'postgres';

  const cached = await readActiveBonusEventsByCoadmin(coadminUid, {
    includeInactive,
    maxResults: 50,
    route: ROUTE,
  });
  if (cached !== null) {
    events = cached;
  } else {
    return firestoreFallbackRemovedResponse(ROUTE, {
      coadminUid,
      sqlReadMode,
    });
  }

  if (sqlReadMode) {
    logCacheSqlRead(ROUTE, {
      coadminUid,
      count: events.length,
      durationMs: Date.now() - startedAt,
    });
  }

  const autoRangeRaw = await readCoadminAutoBonusPercentRangeFromSql(coadminUid);
  const autoBonusPercentRange = normalizeAutoBonusPercentRange(autoRangeRaw || {});

  return NextResponse.json({
    events,
    autoBonusPercentRange,
    source,
    firestore_fallback: false,
    snapshotAt: new Date().toISOString(),
  });
}
