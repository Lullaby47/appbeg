import 'server-only';

import { createHash } from 'crypto';

import { adminAuth } from '@/lib/firebase/admin';

const LIVE_TOKEN_CACHE_TTL_MS = 45_000;
const LIVE_TOKEN_CACHE_MAX_ENTRIES = 256;

type LiveTokenCacheEntry = {
  uid: string;
  verifiedAt: number;
};

const liveTokenCache = new Map<string, LiveTokenCacheEntry>();

function hashBearerToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function pruneLiveTokenCache(nowMs: number) {
  for (const [key, entry] of liveTokenCache.entries()) {
    if (nowMs - entry.verifiedAt >= LIVE_TOKEN_CACHE_TTL_MS) {
      liveTokenCache.delete(key);
    }
  }
  while (liveTokenCache.size > LIVE_TOKEN_CACHE_MAX_ENTRIES) {
    const oldestKey = liveTokenCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    liveTokenCache.delete(oldestKey);
  }
}

export async function verifyLiveCarerApiToken(
  token: string
): Promise<{ uid: string; cacheHit: boolean; cacheAgeMs: number | null }> {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) {
    throw new Error('missing_token');
  }

  const cacheKey = hashBearerToken(cleanToken);
  const nowMs = Date.now();
  const cached = liveTokenCache.get(cacheKey);
  if (cached && nowMs - cached.verifiedAt < LIVE_TOKEN_CACHE_TTL_MS) {
    const cacheAgeMs = nowMs - cached.verifiedAt;
    console.info('[LIVE_AUTH_TOKEN_CACHE] hit uid=%s ageMs=%s', cached.uid, cacheAgeMs);
    return { uid: cached.uid, cacheHit: true, cacheAgeMs };
  }

  console.info('[LIVE_AUTH_TOKEN_CACHE] miss uid=pending');
  const decoded = await adminAuth.verifyIdToken(cleanToken);
  liveTokenCache.set(cacheKey, { uid: decoded.uid, verifiedAt: nowMs });
  pruneLiveTokenCache(nowMs);
  return { uid: decoded.uid, cacheHit: false, cacheAgeMs: null };
}
