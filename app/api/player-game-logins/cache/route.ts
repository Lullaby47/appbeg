import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import {
  apiError,
  requireApiUser,
  scopedCoadminUid,
  type ApiUser,
} from '@/lib/firebase/apiAuth';
import {
  readPlayerGameLoginsCacheByCoadmin,
  type CachedPlayerGameLogin,
} from '@/lib/sql/playerGameLoginsCache';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function toIsoString(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number };
  if (typeof maybe.toDate === 'function') return maybe.toDate().toISOString();
  if (typeof maybe.toMillis === 'function') return new Date(maybe.toMillis()).toISOString();
  if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000).toISOString();
  return null;
}

function mapFirestorePlayerGameLogin(
  docSnap: QueryDocumentSnapshot,
  requestedCoadminUid: string
): CachedPlayerGameLogin | null {
  const data = docSnap.data() as Record<string, unknown>;
  const createdBy = cleanText(data.createdBy) || requestedCoadminUid;
  const coadminUid = cleanText(data.coadminUid) || createdBy;
  const playerUid = cleanText(data.playerUid);
  const gameName = cleanText(data.gameName);

  if (!playerUid || !gameName || !coadminUid || !createdBy) {
    return null;
  }

  return {
    id: docSnap.id,
    playerUid,
    playerUsername: cleanText(data.playerUsername),
    gameName,
    gameUsername: cleanText(data.gameUsername),
    gamePassword: String(data.gamePassword || ''),
    frontendUrl: cleanText(data.frontendUrl) || undefined,
    siteUrl: cleanText(data.siteUrl) || undefined,
    coadminUid,
    createdBy,
    createdAt: toIsoString(data.createdAt),
  };
}

async function getFirestorePlayerGameLoginsByField(
  field: 'coadminUid' | 'createdBy',
  value: string,
  requestedCoadminUid: string
): Promise<CachedPlayerGameLogin[]> {
  const snapshot = await adminDb.collection('playerGameLogins').where(field, '==', value).get();
  return snapshot.docs
    .map((docSnap) => mapFirestorePlayerGameLogin(docSnap, requestedCoadminUid))
    .filter((login): login is CachedPlayerGameLogin => Boolean(login));
}

async function getFirestorePlayerGameLoginsByCoadmin(
  coadminUid: string
): Promise<CachedPlayerGameLogin[]> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    getFirestorePlayerGameLoginsByField('coadminUid', coadminUid, coadminUid),
    getFirestorePlayerGameLoginsByField('createdBy', coadminUid, coadminUid),
  ]);

  return Array.from(
    new Map(
      [...coadminOwned, ...legacyOwned].map((login) => [login.id, login])
    ).values()
  );
}

function resolveExplicitCoadminUid(request: Request) {
  const url = new URL(request.url);
  return cleanText(url.searchParams.get('coadminUid'));
}

function canAccessCoadmin(authUser: ApiUser, requested: string, scoped: string | null) {
  if (authUser.role === 'admin') return true;
  if (authUser.role === 'coadmin') return requested === authUser.uid;
  return Boolean(scoped && requested === scoped);
}

export async function GET(request: Request) {
  const startedAt = Date.now();

  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) {
    return auth.response;
  }

  const scoped = scopedCoadminUid(auth.user);
  const coadminUid = resolveExplicitCoadminUid(request) || scoped;
  if (!coadminUid) {
    return NextResponse.json({ playerGameLogins: [], source: 'firestore' });
  }

  if (!canAccessCoadmin(auth.user, coadminUid, scoped)) {
    return apiError('Forbidden.', 403);
  }

  try {
    const cached = await readPlayerGameLoginsCacheByCoadmin(coadminUid);
    if (cached !== null) {
      const durationMs = Date.now() - startedAt;
      console.info(
        `[PLAYER_GAME_LOGINS_CACHE_READ] source=postgres coadminUid=${coadminUid} count=${cached.length} durationMs=${durationMs}`
      );
      return NextResponse.json({ playerGameLogins: cached, source: 'postgres' });
    }
  } catch (error) {
    console.warn('[PLAYER_GAME_LOGINS_CACHE] fallback firestore', {
      coadminUid,
      reason: 'postgres_read_failed',
      error,
    });
  }

  const playerGameLogins = await getFirestorePlayerGameLoginsByCoadmin(coadminUid);
  const durationMs = Date.now() - startedAt;
  console.info(
    `[PLAYER_GAME_LOGINS_CACHE_READ] source=firestore_fallback coadminUid=${coadminUid} count=${playerGameLogins.length} durationMs=${durationMs}`
  );
  return NextResponse.json({ playerGameLogins, source: 'firestore' });
}
