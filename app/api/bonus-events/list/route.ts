import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import {
  bonusEventsRequestHeaderFlags,
  logBonusEventsBlocked,
  logBonusEventsListAuth,
  logBonusEventsListSql,
} from '@/lib/server/bonusEventsAudit';
import {
  readActiveBonusEventsByCoadmin,
  type CachedBonusEvent,
} from '@/lib/sql/bonusEventsCache';
import { readGameLoginsCacheByCoadmin } from '@/lib/sql/gameLoginsCache';

const ROUTE = '/api/bonus-events/list';

type BonusEvent = {
  id: string;
  bonusName: string;
  gameName: string;
  createdAt?: unknown;
  created_at?: unknown;
  status?: unknown;
  startDate?: unknown;
  start_date?: unknown;
  endDate?: unknown;
  end_date?: unknown;
  [key: string]: unknown;
};

const AUTO_BONUS_NAMES = [
  'Friday Fever',
  'Lucky Streak',
  'High Roller Rush',
  'Hotshot Bonus',
  'Dollar Dash',
  'Jackpot Sprint',
  'Neon Nights Bonus',
  'Power Play Bonus',
  'Golden Ticket Drop',
  'Vegas Vibes',
  'Pocket Payday',
  'Prime Time Bonus',
  'Rocket Reward',
  'Cashwave Bonus',
  'Flash Fortune',
  'Rapid Reward',
  'Double Up Drop',
  'Crown Club Bonus',
  'Big Win Boost',
  'Main Event Bonus',
];
const LEGACY_AUTO_BONUS_NAMES = new Set([
  'freak friday',
  'hello honee',
  'mafia boss',
  'saduleeee',
  'lucky lassi',
  'drama dollar',
  'paisa pani',
  'jhakaas jackpot',
  'bingo bhoot',
  'crazy chiya',
  'pocket rocket',
  'no tension bonus',
  'balle balle',
  'dhamaka drop',
  'laughter loot',
  'chill pill reward',
  'pagal paisa',
  'momo money',
  'fatafat fortune',
  'boss baby bonus',
]);

function toMs(value: unknown) {
  if (!value || typeof value !== 'object') return 0;
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') return maybe.toMillis();
  if (typeof maybe.toDate === 'function') return maybe.toDate().getTime();
  if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  return 0;
}

function isActive(docData: BonusEvent) {
  const status = String(docData.status || 'active').toLowerCase();
  if (status !== 'active') return false;
  const now = Date.now();
  const startMs = toMs(docData.startDate || docData.start_date || null);
  const endMs = toMs(docData.endDate || docData.end_date || null);
  if (startMs > 0 && now < startMs) return false;
  if (endMs > 0 && now > endMs) return false;
  return true;
}

function isLegacyAutoBonusName(name: string) {
  const clean = String(name || '').trim().toLowerCase();
  return (
    clean.startsWith('auto bonus') ||
    clean.includes('2026-') ||
    clean.includes('#') ||
    LEGACY_AUTO_BONUS_NAMES.has(clean)
  );
}

function isLegacyAutoGameName(name: string) {
  return String(name || '').trim().toLowerCase().startsWith('auto game');
}

function hashText(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function resolveVisibleCoadminUid(values: {
  role: string;
  requestedCoadminUid: string;
  derivedCoadminUid: string;
}) {
  if (values.role === 'admin') {
    return values.requestedCoadminUid || values.derivedCoadminUid;
  }
  return values.derivedCoadminUid;
}

function decorateLegacyBonusEvents(events: CachedBonusEvent[], gameNames: string[]): BonusEvent[] {
  return events
    .map((event): BonusEvent => {
      const currentBonusName = String(event.bonusName || '');
      const currentGameName = String(event.gameName || '');
      const funnyName =
        AUTO_BONUS_NAMES[hashText(`${event.id}:bonus`) % AUTO_BONUS_NAMES.length];
      const randomGameFromList =
        gameNames.length > 0
          ? gameNames[hashText(`${event.id}:game`) % gameNames.length]
          : currentGameName || 'Bonus Table';

      return {
        ...event,
        bonusName: isLegacyAutoBonusName(currentBonusName) ? funnyName : currentBonusName,
        gameName: isLegacyAutoGameName(currentGameName) ? randomGameFromList : currentGameName,
        createdAt: event.createdAt ?? null,
        created_at: event.created_at ?? null,
      };
    })
    .filter((event) => isActive(event))
    .sort((a, b) => toMs(b.createdAt || b.created_at) - toMs(a.createdAt || a.created_at));
}

async function loadGameNames(coadminUid: string, sqlReadMode: boolean) {
  const cached = await readGameLoginsCacheByCoadmin(coadminUid);
  if (cached) {
    return Array.from(
      new Set(cached.map((entry) => String(entry.gameName || '').trim()).filter(Boolean))
    );
  }
  if (sqlReadMode) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'gameLogins', {
      coadminUid,
      reason: 'game_logins_cache_miss',
    });
    return [];
  }

  const gameSnap = await adminDb
    .collection('gameLogins')
    .where('coadminUid', '==', coadminUid)
    .get();
  return Array.from(
    new Set(
      gameSnap.docs
        .map((d) => String((d.data() as { gameName?: string }).gameName || '').trim())
        .filter(Boolean)
    )
  );
}

async function loadBonusEvents(coadminUid: string, sqlReadMode: boolean) {
  const cached = await readActiveBonusEventsByCoadmin(coadminUid, {
    includeInactive: false,
    maxResults: 100,
    route: ROUTE,
  });
  if (cached !== null) {
    return cached;
  }
  if (sqlReadMode) {
    logCacheFirestoreFallbackBlocked(ROUTE, 'bonus_events_cache', {
      coadminUid,
      reason: 'postgres_unavailable',
    });
    return [];
  }

  const snap = await adminDb
    .collection('bonusEvents')
    .where('coadminUid', '==', coadminUid)
    .get();

  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      coadminUid,
      bonusName: String(data.bonusName || ''),
      gameName: String(data.gameName || ''),
      amountNpr: Number(data.amountNpr ?? data.amount ?? 0),
      description: String(data.description || ''),
      bonusPercentage: Number(data.bonusPercentage ?? data.bonus_percentage ?? 0),
      createdByUid: String(data.createdByUid ?? data.created_by ?? ''),
      createdByUsername: String(data.createdByUsername || 'User'),
      createdByRole: String(data.createdByRole ?? data.creator_role ?? ''),
      status: String(data.status || 'active'),
      startDate: null,
      endDate: null,
      createdAt: null,
      created_at: null,
      updatedAt: null,
      updated_at: null,
    } satisfies CachedBonusEvent;
  });
}

export async function GET(request: Request) {
  try {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const requestedCoadminUid = String(url.searchParams.get('coadminUid') || '').trim();
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
    if ('response' in auth) {
      const headerFlags = bonusEventsRequestHeaderFlags(request);
      logBonusEventsBlocked({
        route: ROUTE,
        reason: 'auth_failed',
        requiredAuth: 'admin|coadmin|staff|carer|player',
        receivedAuth: auth.timing?.auth_path || null,
        hasAppSessionId: headerFlags.has_app_session_header,
        hasPlayerSessionId: headerFlags.has_player_session_header,
      });
      return auth.response;
    }

    const derivedCoadminUid =
      auth.user.role === 'coadmin'
        ? auth.user.uid
        : String(auth.user.coadminUid || auth.user.createdBy || '').trim();
    const coadminUid = resolveVisibleCoadminUid({
      role: auth.user.role,
      requestedCoadminUid,
      derivedCoadminUid,
    });

    logBonusEventsListAuth(request, {
      route: ROUTE,
      uid: auth.user.uid,
      role: auth.user.role,
      coadminUid: coadminUid || '',
      auth_path: auth.authPath,
      source: 'postgres',
    });

    if (!coadminUid) {
      logBonusEventsListSql({
        route: ROUTE,
        coadminUid: '',
        count: 0,
        activeCount: 0,
        sql_ms: Date.now() - startedAt,
        firestore_fallback: false,
        reason: 'missing_coadmin_scope',
      });
      return NextResponse.json({ events: [], source: 'postgres', firestore_fallback: false });
    }

    const sqlReadMode = isCacheSqlAuthoritative();
    const sqlStartedAt = Date.now();
    const [gameNames, rawEvents] = await Promise.all([
      loadGameNames(coadminUid, sqlReadMode),
      loadBonusEvents(coadminUid, sqlReadMode),
    ]);
    const events = decorateLegacyBonusEvents(rawEvents, gameNames);
    const sql_ms = Date.now() - sqlStartedAt;

    logBonusEventsListSql({
      route: ROUTE,
      coadminUid,
      count: rawEvents.length,
      activeCount: events.length,
      sql_ms,
      firestore_fallback: false,
      reason: sqlReadMode ? 'bonus_events_cache_read' : 'legacy_firestore_branch',
    });

    if (sqlReadMode) {
      logCacheSqlRead(ROUTE, {
        coadminUid,
        count: events.length,
        durationMs: Date.now() - startedAt,
      });
    }

    return NextResponse.json({
      events,
      source: 'postgres',
      firestore_fallback: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load bonus events.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
