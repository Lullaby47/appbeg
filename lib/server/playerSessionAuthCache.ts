import 'server-only';

import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const PLAYER_SESSION_AUTH_CACHE_TTL_MS = 8_000;

export type PlayerSessionStatusReason =
  | 'session_replaced'
  | 'session_inactive'
  | 'missing_session_header'
  | 'unauthorized'
  | 'forbidden';

export type PlayerSessionStatusResult = {
  ok: boolean;
  active?: boolean;
  uid?: string;
  activeSessionId?: string | null;
  sessionId?: string | null;
  replaced?: boolean;
  reason?: PlayerSessionStatusReason | string;
  source?: 'sql' | 'firestore_fallback';
};

export type PlayerSessionAuthValidation = {
  ok: boolean;
  sessionSource: 'sql' | 'firestore';
  reason?: string;
  activeSessionId?: string | null;
  sessionId?: string | null;
  uid?: string;
};

export type PlayerSessionAuthCacheEntry = {
  expiresAt: number;
  cachedAt: number;
  cacheKey: string;
  result: PlayerSessionStatusResult;
};

const globalPlayerSessionAuthCache = globalThis as typeof globalThis & {
  __appbegPlayerSessionAuthCache?: Map<string, PlayerSessionAuthCacheEntry>;
};

function getPlayerSessionAuthCacheMap() {
  if (!globalPlayerSessionAuthCache.__appbegPlayerSessionAuthCache) {
    globalPlayerSessionAuthCache.__appbegPlayerSessionAuthCache = new Map();
  }
  return globalPlayerSessionAuthCache.__appbegPlayerSessionAuthCache;
}

function buildCanonicalPlayerSessionAuthCacheKey(playerSessionId: string, uid: string) {
  return `${cleanText(playerSessionId)}:${cleanText(uid)}`;
}

/** Canonical key: player session + uid (app session is validated separately). */
export function buildPlayerSessionAuthCacheKey(
  _appSessionId: string,
  playerSessionId: string,
  uid: string
) {
  return buildCanonicalPlayerSessionAuthCacheKey(playerSessionId, uid);
}

function buildLegacyPlayerSessionAuthCacheKey(
  appSessionId: string,
  playerSessionId: string,
  uid: string
) {
  return `${cleanText(appSessionId)}:${cleanText(playerSessionId)}:${cleanText(uid)}`;
}

function readCacheEntry(cacheKey: string): PlayerSessionAuthCacheEntry | null {
  const cached = getPlayerSessionAuthCacheMap().get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    getPlayerSessionAuthCacheMap().delete(cacheKey);
    return null;
  }
  return cached;
}

function statusResultToAuthValidation(
  result: PlayerSessionStatusResult
): PlayerSessionAuthValidation {
  return {
    ok: result.ok,
    sessionSource: result.source === 'firestore_fallback' ? 'firestore' : 'sql',
    reason: result.reason,
    activeSessionId: result.activeSessionId,
    sessionId: result.sessionId,
    uid: result.uid,
  };
}

function lookupCachedEntry(input: {
  appSessionId?: string;
  playerSessionId: string;
  uid: string;
}): PlayerSessionAuthCacheEntry | null {
  const playerSessionId = cleanText(input.playerSessionId);
  const uid = cleanText(input.uid);
  const appSessionId = cleanText(input.appSessionId || '');

  const canonicalKey = buildCanonicalPlayerSessionAuthCacheKey(playerSessionId, uid);
  const canonical = readCacheEntry(canonicalKey);
  if (canonical) {
    return canonical;
  }

  if (appSessionId) {
    const legacy = readCacheEntry(
      buildLegacyPlayerSessionAuthCacheKey(appSessionId, playerSessionId, uid)
    );
    if (legacy) {
      return legacy;
    }
  }

  const emptyAppSessionLegacy = readCacheEntry(
    buildLegacyPlayerSessionAuthCacheKey('', playerSessionId, uid)
  );
  if (emptyAppSessionLegacy) {
    return emptyAppSessionLegacy;
  }

  return null;
}

export function getCachedPlayerSessionStatus(input: {
  appSessionId?: string;
  playerSessionId: string;
  uid: string;
}): PlayerSessionStatusResult | null {
  return lookupCachedEntry(input)?.result || null;
}

export function getCachedPlayerSessionStatusEntry(input: {
  appSessionId?: string;
  playerSessionId: string;
  uid: string;
}): PlayerSessionAuthCacheEntry | null {
  return lookupCachedEntry(input);
}

export function getCachedPlayerSessionValidation(input: {
  appSessionId?: string;
  playerSessionId: string;
  uid: string;
}):
  | { hit: true; validation: PlayerSessionAuthValidation; entry: PlayerSessionAuthCacheEntry }
  | { hit: false; validation: null } {
  const entry = lookupCachedEntry(input);
  if (!entry) {
    console.info('[PLAYER_SESSION_AUTH_CACHE]', {
      hit: false,
      uid: input.uid,
      sessionId: input.playerSessionId,
      cacheKey: buildCanonicalPlayerSessionAuthCacheKey(
        cleanText(input.playerSessionId),
        cleanText(input.uid)
      ),
    });
    return { hit: false, validation: null };
  }

  const now = Date.now();
  console.info('[PLAYER_SESSION_AUTH_CACHE]', {
    hit: true,
    uid: input.uid,
    sessionId: input.playerSessionId,
    ok: entry.result.ok,
    reason: entry.result.reason || null,
    source: entry.result.source || 'sql',
    ageMs: now - entry.cachedAt,
    expiresInMs: entry.expiresAt - now,
  });
  return { hit: true, validation: statusResultToAuthValidation(entry.result), entry };
}

export function writePlayerSessionAuthCache(
  input: {
    appSessionId?: string;
    playerSessionId: string;
    uid: string;
  },
  result: PlayerSessionStatusResult,
  options?: { reason?: string }
) {
  const playerSessionId = cleanText(input.playerSessionId);
  const uid = cleanText(input.uid);
  const cacheKey = buildCanonicalPlayerSessionAuthCacheKey(playerSessionId, uid);
  const now = Date.now();
  const expiresAt = now + PLAYER_SESSION_AUTH_CACHE_TTL_MS;
  getPlayerSessionAuthCacheMap().set(cacheKey, {
    cacheKey,
    cachedAt: now,
    expiresAt,
    result,
  });
  console.info('[PLAYER_SESSION_STATUS_CACHE]', {
    cache_set: true,
    reason: options?.reason || 'status_sql_success',
    cacheKey,
    uid,
    sessionId: playerSessionId,
    expiresInMs: PLAYER_SESSION_AUTH_CACHE_TTL_MS,
  });
}

export function invalidatePlayerSessionAuthCache(input?: {
  playerSessionId?: string;
  uid?: string;
  appSessionId?: string;
  reason?: string;
}) {
  const playerSessionId = cleanText(input?.playerSessionId);
  const uid = cleanText(input?.uid);
  const appSessionId = cleanText(input?.appSessionId);
  const reason = cleanText(input?.reason) || 'manual';
  const cache = getPlayerSessionAuthCacheMap();

  if (!playerSessionId && !uid && !appSessionId) {
    const deletedKeys = [...cache.keys()];
    cache.clear();
    for (const cacheKey of deletedKeys) {
      console.info('[PLAYER_SESSION_STATUS_CACHE]', {
        cache_delete: true,
        reason,
        cacheKey,
      });
    }
    return;
  }

  for (const [key] of cache.entries()) {
    const parts = key.split(':');
    const isCanonical = parts.length === 2;
    const keyPlayerSessionId = isCanonical ? parts[0] || '' : parts[1] || '';
    const keyUid = isCanonical ? parts[1] || '' : parts.slice(2).join(':');
    const keyAppSessionId = isCanonical ? '' : parts[0] || '';
    const shouldDelete =
      (playerSessionId && keyPlayerSessionId === playerSessionId) ||
      (uid && keyUid === uid) ||
      (appSessionId && keyAppSessionId === appSessionId);
    if (shouldDelete) {
      cache.delete(key);
      console.info('[PLAYER_SESSION_STATUS_CACHE]', {
        cache_delete: true,
        reason,
        cacheKey: key,
        uid: keyUid || null,
        sessionId: keyPlayerSessionId || null,
      });
    }
  }
}

/** @deprecated Use invalidatePlayerSessionAuthCache */
export const invalidatePlayerSessionStatusCache = invalidatePlayerSessionAuthCache;
