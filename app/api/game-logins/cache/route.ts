import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, belongsToScope, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  CachedGameLogin,
  deleteGameLoginCache,
  mirrorGameLoginCache,
  readGameLoginsCacheByCoadmin,
  readGameLoginsCacheByField,
} from '@/lib/sql/gameLoginsCache';

type GameLoginField = 'coadminUid' | 'createdBy';

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

function mapFirestoreDoc(docSnap: QueryDocumentSnapshot): CachedGameLogin {
  const data = docSnap.data() as Record<string, unknown>;
  return {
    id: docSnap.id,
    gameName: cleanText(data.gameName),
    username: cleanText(data.username),
    password: String(data.password || ''),
    backendUrl: cleanText(data.backendUrl),
    frontendUrl: cleanText(data.frontendUrl),
    siteUrl: cleanText(data.siteUrl || data.backendUrl),
    createdBy: cleanText(data.createdBy),
    coadminUid: cleanText(data.coadminUid) || undefined,
    createdAt: toIsoString(data.createdAt),
    status: cleanText(data.status) || 'active',
  };
}

async function getFirestoreGameLoginsByField(
  field: GameLoginField,
  value: string
): Promise<CachedGameLogin[]> {
  const snapshot = await adminDb.collection('gameLogins').where(field, '==', value).get();
  return snapshot.docs.map(mapFirestoreDoc);
}

async function getFirestoreGameLoginsByCoadmin(coadminUid: string): Promise<CachedGameLogin[]> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    getFirestoreGameLoginsByField('coadminUid', coadminUid),
    getFirestoreGameLoginsByField('createdBy', coadminUid),
  ]);

  return Array.from(
    new Map(
      [...coadminOwned, ...legacyOwned].map((gameLogin) => [gameLogin.id, gameLogin])
    ).values()
  );
}

function resolveRequestedCoadminUid(request: Request, fallback: string | null) {
  const url = new URL(request.url);
  return cleanText(url.searchParams.get('coadminUid')) || fallback;
}

function resolveRequestedField(request: Request): GameLoginField | null {
  const url = new URL(request.url);
  const field = cleanText(url.searchParams.get('field'));
  return field === 'coadminUid' || field === 'createdBy' ? field : null;
}

function canAccessCoadmin(authUser: { uid: string; role: string }, requested: string, scoped: string | null) {
  if (authUser.role === 'admin') return true;
  if (authUser.role === 'coadmin') return requested === authUser.uid;
  return Boolean(scoped && requested === scoped);
}

export async function GET(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) return auth.response;

  const scoped = scopedCoadminUid(auth.user);
  const url = new URL(request.url);
  const field = resolveRequestedField(request);
  const fieldValue = cleanText(url.searchParams.get('value'));
  if (field && fieldValue) {
    if (!canAccessCoadmin(auth.user, fieldValue, scoped)) {
      return apiError('Forbidden.', 403);
    }

    try {
      const cached = await readGameLoginsCacheByField(field, fieldValue);
      if (cached && cached.length > 0) {
        console.info('[GAME_LOGINS_CACHE] postgres hit', {
          field,
          value: fieldValue,
          count: cached.length,
        });
        return NextResponse.json({ gameLogins: cached, source: 'postgres' });
      }
    } catch (error) {
      console.warn('[GAME_LOGINS_CACHE] fallback firestore', {
        field,
        value: fieldValue,
        reason: 'postgres_read_failed',
        error,
      });
    }

    console.info('[GAME_LOGINS_CACHE] fallback firestore', {
      field,
      value: fieldValue,
      reason: 'cache_miss_or_unavailable',
    });
    const gameLogins = await getFirestoreGameLoginsByField(field, fieldValue);
    return NextResponse.json({ gameLogins, source: 'firestore' });
  }

  const coadminUid = resolveRequestedCoadminUid(request, scoped);
  if (!coadminUid) {
    return NextResponse.json({ gameLogins: [], source: 'firestore' });
  }
  if (!canAccessCoadmin(auth.user, coadminUid, scoped)) {
    return apiError('Forbidden.', 403);
  }

  try {
    const cached = await readGameLoginsCacheByCoadmin(coadminUid);
    if (cached && cached.length > 0) {
      console.info('[GAME_LOGINS_CACHE] postgres hit', {
        coadminUid,
        count: cached.length,
      });
      return NextResponse.json({ gameLogins: cached, source: 'postgres' });
    }
  } catch (error) {
    console.warn('[GAME_LOGINS_CACHE] fallback firestore', {
      coadminUid,
      reason: 'postgres_read_failed',
      error,
    });
  }

  console.info('[GAME_LOGINS_CACHE] fallback firestore', {
    coadminUid,
    reason: 'cache_miss_or_unavailable',
  });
  const gameLogins = await getFirestoreGameLoginsByCoadmin(coadminUid);
  return NextResponse.json({ gameLogins, source: 'firestore' });
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) return auth.response;

  const body = (await request.json()) as {
    action?: unknown;
    gameLogin?: CachedGameLogin;
    id?: unknown;
  };
  const action = cleanText(body.action);
  const scoped = scopedCoadminUid(auth.user);

  if (action === 'upsert') {
    const gameLogin = body.gameLogin;
    if (!gameLogin?.id) return apiError('Game login id is required.', 400);
    const gameLoginScope = cleanText(gameLogin.coadminUid || gameLogin.createdBy);
    if (
      auth.user.role !== 'admin' &&
      !belongsToScope(gameLogin, scoped || '') &&
      (!scoped || gameLoginScope !== scoped)
    ) {
      return apiError('Forbidden.', 403);
    }

    try {
      const mirrored = await mirrorGameLoginCache({
        ...gameLogin,
        raw: gameLogin as unknown as Record<string, unknown>,
      });
      if (!mirrored) {
        console.warn('[GAME_LOGINS_CACHE] mirror failed', {
          action,
          id: gameLogin.id,
          reason: 'database_url_missing',
        });
        return NextResponse.json({ success: true, mirrored: false });
      }
      return NextResponse.json({ success: true });
    } catch (error) {
      console.warn('[GAME_LOGINS_CACHE] mirror failed', {
        action,
        id: gameLogin.id,
        error,
      });
      return NextResponse.json({ success: true, mirrored: false });
    }
  }

  if (action === 'delete') {
    const id = cleanText(body.id);
    if (!id) return apiError('Game login id is required.', 400);

    try {
      const mirrored = await deleteGameLoginCache(id);
      if (!mirrored) {
        console.warn('[GAME_LOGINS_CACHE] mirror failed', {
          action,
          id,
          reason: 'database_url_missing',
        });
        return NextResponse.json({ success: true, mirrored: false });
      }
      return NextResponse.json({ success: true });
    } catch (error) {
      console.warn('[GAME_LOGINS_CACHE] mirror failed', {
        action,
        id,
        error,
      });
      return NextResponse.json({ success: true, mirrored: false });
    }
  }

  return apiError('Invalid game login cache action.', 400);
}
