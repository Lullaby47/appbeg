import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import {
  readActiveBonusEventsByCoadmin,
  readCoadminAutoBonusPercentRangeFromSql,
  type CachedBonusEvent,
} from '@/lib/sql/bonusEventsCache';

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

function toMs(value: unknown) {
  if (!value) return 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === 'object') {
    const maybe = value as { toMillis?: () => number; seconds?: number };
    if (typeof maybe.toMillis === 'function') return maybe.toMillis();
    if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  }
  return 0;
}

function isActive(event: CachedBonusEvent) {
  const status = String(event.status || 'active').toLowerCase();
  if (status !== 'active') return false;
  const now = Date.now();
  const startMs = toMs(event.startDate || event.start_date);
  const endMs = toMs(event.endDate || event.end_date);
  if (startMs > 0 && now < startMs) return false;
  if (endMs > 0 && now > endMs) return false;
  return true;
}

async function readFirestoreBonusEvents(coadminUid: string): Promise<CachedBonusEvent[]> {
  const snap = await adminDb
    .collection('bonusEvents')
    .where('coadminUid', '==', coadminUid)
    .where('status', '==', 'active')
    .get();

  return snap.docs
    .map((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      return {
        id: docSnap.id,
        eventId: docSnap.id,
        event_id: docSnap.id,
        coadminUid,
        bonusName: String(data.bonusName || ''),
        gameName: String(data.gameName || ''),
        amountNpr: Number(data.amountNpr ?? data.amount ?? 0),
        amount: Number(data.amountNpr ?? data.amount ?? 0),
        description: String(data.description || ''),
        bonusPercentage: Number(data.bonusPercentage ?? data.bonus_percentage ?? 0),
        bonus_percentage: Number(data.bonusPercentage ?? data.bonus_percentage ?? 0),
        createdByUid: String(data.createdByUid ?? data.created_by ?? ''),
        created_by: String(data.createdByUid ?? data.created_by ?? ''),
        createdByUsername: String(data.createdByUsername || 'User'),
        createdByRole: String(data.createdByRole ?? data.creator_role ?? ''),
        creator_role: String(data.createdByRole ?? data.creator_role ?? ''),
        status: String(data.status || 'active'),
        startDate: null,
        endDate: null,
        createdAt: null,
        created_at: null,
        updatedAt: null,
        updated_at: null,
      } satisfies CachedBonusEvent;
    })
    .filter(isActive)
    .sort((left, right) => toMs(right.createdAt || right.created_at) - toMs(left.createdAt || left.created_at));
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
  let source: 'postgres' | 'firestore' = 'postgres';

  if (sqlReadMode) {
    const cached = await readActiveBonusEventsByCoadmin(coadminUid, {
      includeInactive,
      maxResults: 50,
    });
    if (cached === null) {
      logCacheFirestoreFallbackBlocked(ROUTE, 'bonus_events_cache', {
        coadminUid,
        reason: 'postgres_unavailable',
      });
      events = [];
    } else {
      events = cached;
    }
    logCacheSqlRead(ROUTE, {
      coadminUid,
      count: events.length,
      durationMs: Date.now() - startedAt,
    });
  } else {
    const cached = await readActiveBonusEventsByCoadmin(coadminUid, {
      includeInactive,
      maxResults: 50,
    });
    if (cached !== null && cached.length > 0) {
      events = cached;
      source = 'postgres';
    } else {
      events = await readFirestoreBonusEvents(coadminUid);
      source = 'firestore';
    }
  }

  const autoRangeRaw = await readCoadminAutoBonusPercentRangeFromSql(coadminUid);
  const autoBonusPercentRange = normalizeAutoBonusPercentRange(autoRangeRaw || {});

  return NextResponse.json({
    events,
    autoBonusPercentRange,
    source,
    snapshotAt: new Date().toISOString(),
  });
}
