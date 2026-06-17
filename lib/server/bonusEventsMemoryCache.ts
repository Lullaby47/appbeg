import 'server-only';

export type BonusEventsMemoryCacheValue<T> = {
  events: T[];
  rawCount: number;
  activeCount: number;
  filterReason: string;
};

type BonusEventsMemoryCacheEntry<T> = {
  cachedAt: number;
  expiresAt: number;
  value: BonusEventsMemoryCacheValue<T>;
};

const BONUS_EVENTS_MEMORY_CACHE_TTL_MS = (() => {
  const fromEnv = Number(process.env.BONUS_EVENTS_MEMORY_CACHE_TTL_MS || 45_000);
  if (!Number.isFinite(fromEnv)) {
    return 45_000;
  }
  return Math.min(60_000, Math.max(5_000, Math.trunc(fromEnv)));
})();

const globalBonusEventsMemoryCache = globalThis as typeof globalThis & {
  __appbegBonusEventsListMemoryCache?: Map<string, BonusEventsMemoryCacheEntry<unknown>>;
};

function cache() {
  if (!globalBonusEventsMemoryCache.__appbegBonusEventsListMemoryCache) {
    globalBonusEventsMemoryCache.__appbegBonusEventsListMemoryCache = new Map();
  }
  return globalBonusEventsMemoryCache.__appbegBonusEventsListMemoryCache;
}

export function bonusEventsMemoryCacheKey(input: {
  coadminUid: string;
  includeInactive: boolean;
  skipTimeWindowFilter: boolean;
}) {
  return [
    String(input.coadminUid || '').trim(),
    input.includeInactive ? 'includeInactive=1' : 'includeInactive=0',
    input.skipTimeWindowFilter ? 'skipTimeWindowFilter=1' : 'skipTimeWindowFilter=0',
  ].join('|');
}

export function readBonusEventsMemoryCache<T>(key: string) {
  const entry = cache().get(key) as BonusEventsMemoryCacheEntry<T> | undefined;
  if (!entry) {
    console.info('[BONUS_EVENTS_CACHE_MISS_MEMORY]', { key, reason: 'empty' });
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache().delete(key);
    console.info('[BONUS_EVENTS_CACHE_MISS_MEMORY]', {
      key,
      reason: 'expired',
      ageMs: Date.now() - entry.cachedAt,
    });
    return null;
  }
  console.info('[BONUS_EVENTS_CACHE_HIT_MEMORY]', {
    key,
    ageMs: Date.now() - entry.cachedAt,
    expiresInMs: entry.expiresAt - Date.now(),
  });
  return entry.value;
}

export function writeBonusEventsMemoryCache<T>(
  key: string,
  value: BonusEventsMemoryCacheValue<T>
) {
  const now = Date.now();
  cache().set(key, {
    cachedAt: now,
    expiresAt: now + BONUS_EVENTS_MEMORY_CACHE_TTL_MS,
    value,
  });
}

export function invalidateBonusEventsMemoryCache(coadminUid?: string | null) {
  const cleanCoadminUid = String(coadminUid || '').trim();
  let invalidated = 0;
  for (const key of cache().keys()) {
    if (!cleanCoadminUid || key.startsWith(`${cleanCoadminUid}|`)) {
      cache().delete(key);
      invalidated += 1;
    }
  }
  console.info('[BONUS_EVENTS_CACHE_INVALIDATED]', {
    coadminUid: cleanCoadminUid || null,
    invalidated,
  });
}
