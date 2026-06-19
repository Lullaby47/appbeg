import { NextResponse } from 'next/server';

import {
  apiError,
  belongsToScope,
  requireApiUser,
  scopedCoadminUid,
  verifyApiTokenIdentity,
  type ApiUser,
} from '@/lib/firebase/apiAuth';
import {
  firestoreFallbackRemovedResponse,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import {

  CachedGameLogin,
  createGameLoginsSqlTiming,
  deleteGameLoginCache,
  mirrorGameLoginCache,
  readGameLoginsCacheByCoadmin,
  readGameLoginsCacheByField,
  type GameLoginsSqlTiming,
} from '@/lib/sql/gameLoginsCache';

export const runtime = 'nodejs';

const ROUTE = '/api/game-logins/cache';

type GameLoginField = 'coadminUid' | 'createdBy';

type AuthPath = 'token_only' | 'full';

type RouteTiming = {
  auth_ms: number;
  auth_path: AuthPath | null;
  token_only_eligible: boolean;
  scope_check_ms: number;
  sql_pool_ms: number;
  pg_connect_ms: number;
  pg_connect_error: string | null;
  each_query_ms: number[];
  fallback_check_ms: number;
  serialization_ms: number;
  total_ms: number;
  poolReused: boolean | null;
  firebaseFallback: boolean;
  firebaseScopeRead: boolean;
};

function createRouteTiming(): RouteTiming {
  return {
    auth_ms: 0,
    auth_path: null,
    token_only_eligible: false,
    scope_check_ms: 0,
    sql_pool_ms: 0,
    pg_connect_ms: 0,
    pg_connect_error: null,
    each_query_ms: [],
    fallback_check_ms: 0,
    serialization_ms: 0,
    total_ms: 0,
    poolReused: null,
    firebaseFallback: false,
    firebaseScopeRead: false,
  };
}

function mergeSqlTiming(routeTiming: RouteTiming, sqlTiming: GameLoginsSqlTiming) {
  routeTiming.sql_pool_ms += sqlTiming.sql_pool_ms;
  routeTiming.pg_connect_ms += sqlTiming.pg_connect_ms;
  routeTiming.each_query_ms.push(...sqlTiming.each_query_ms);
  if (sqlTiming.poolReused !== null) {
    routeTiming.poolReused = sqlTiming.poolReused;
  }
  if (sqlTiming.pg_connect_error) {
    routeTiming.pg_connect_error = sqlTiming.pg_connect_error;
  }
}

function logRouteTiming(
  routeTiming: RouteTiming,
  details: Record<string, unknown> = {},
  sqlTiming?: GameLoginsSqlTiming
) {
  console.info('[GAME_LOGINS_CACHE_TIMING]', {
    ...routeTiming,
    pool: sqlTiming?.pool || 'gameLoginsCache',
    ...details,
  });
}

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function resolveExplicitCoadminUid(request: Request) {
  const url = new URL(request.url);
  return cleanText(url.searchParams.get('coadminUid'));
}

function resolveTokenOnlyScope(request: Request) {
  const url = new URL(request.url);
  const field = resolveRequestedField(request);
  const fieldValue = cleanText(url.searchParams.get('value'));
  if (field && fieldValue) {
    return { scopeKey: fieldValue, field, mode: 'field' as const };
  }

  const explicitCoadminUid = resolveExplicitCoadminUid(request);
  if (explicitCoadminUid) {
    return { scopeKey: explicitCoadminUid, field: null, mode: 'coadminUid' as const };
  }

  return null;
}

async function resolveGetAuth(
  request: Request,
  routeTiming: RouteTiming
): Promise<
  | { ok: true; authPath: AuthPath; user: ApiUser | null }
  | { ok: false; response: Response }
> {
  const tokenOnlyScope = resolveTokenOnlyScope(request);
  routeTiming.token_only_eligible = Boolean(tokenOnlyScope);

  const authStartedAt = Date.now();
  const hasAppSession = Boolean(cleanText(request.headers.get('X-App-Session-Id')));

  // App session auth is local SQL (~0ms verify); token_only always hits Firebase verifyIdToken (~5s from VPS).
  if (!hasAppSession && tokenOnlyScope) {
    const identity = await verifyApiTokenIdentity(request);
    if ('uid' in identity && identity.uid === tokenOnlyScope.scopeKey) {
      routeTiming.auth_ms = Date.now() - authStartedAt;
      routeTiming.auth_path = 'token_only';
      return { ok: true, authPath: 'token_only', user: null };
    }
  }

  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  routeTiming.auth_ms = Date.now() - authStartedAt;
  routeTiming.auth_path = 'full';
  if ('response' in auth) {
    return { ok: false, response: auth.response };
  }

  return { ok: true, authPath: 'full', user: auth.user };
}

function resolveRequestedCoadminUid(request: Request, fallback: string | null) {
  return resolveExplicitCoadminUid(request) || fallback;
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

function timedJson(
  payload: unknown,
  totalStartedAt: number,
  routeTiming: RouteTiming,
  details: Record<string, unknown> = {},
  init?: ResponseInit,
  sqlTiming?: GameLoginsSqlTiming
) {
  const serializeStartedAt = Date.now();
  const response = NextResponse.json(payload, init);
  routeTiming.serialization_ms = Date.now() - serializeStartedAt;
  routeTiming.total_ms = Date.now() - totalStartedAt;
  logRouteTiming(routeTiming, details, sqlTiming);
  return response;
}

export async function GET(request: Request) {
  const totalStartedAt = Date.now();
  const routeTiming = createRouteTiming();

  const auth = await resolveGetAuth(request, routeTiming);
  if (!auth.ok) {
    routeTiming.total_ms = Date.now() - totalStartedAt;
    logRouteTiming(routeTiming, { reason: 'auth_response' });
    return auth.response;
  }

  const url = new URL(request.url);
  const field = resolveRequestedField(request);
  const fieldValue = cleanText(url.searchParams.get('value'));
  const tokenOnlyAuthorized = auth.authPath === 'token_only';
  const scoped = auth.user ? scopedCoadminUid(auth.user) : null;

  if (field && fieldValue) {
    if (!tokenOnlyAuthorized) {
      const scopeStartedAt = Date.now();
      const allowed = canAccessCoadmin(auth.user!, fieldValue, scoped);
      routeTiming.scope_check_ms = Date.now() - scopeStartedAt;
      if (!allowed) {
        const response = apiError('Forbidden.', 403);
        routeTiming.total_ms = Date.now() - totalStartedAt;
        logRouteTiming(routeTiming, { reason: 'forbidden_field' });
        return response;
      }
    }

    const sqlTiming = createGameLoginsSqlTiming();
    const fallbackStartedAt = Date.now();
    try {
      const cached = await readGameLoginsCacheByField(field, fieldValue, sqlTiming);
      mergeSqlTiming(routeTiming, sqlTiming);
      if (cached !== null) {
        logCacheSqlRead(ROUTE, { field, value: fieldValue, count: cached.length });
        return timedJson(
          { gameLogins: cached, source: 'postgres' },
          totalStartedAt,
          routeTiming,
          {
            field,
            value: fieldValue,
            source: 'postgres',
          },
          undefined,
          sqlTiming
        );
      }
    } catch (error) {
      console.warn('[GAME_LOGINS_CACHE] postgres read failed', { field, value: fieldValue, error });
    }

    routeTiming.fallback_check_ms = Date.now() - fallbackStartedAt;
    routeTiming.total_ms = Date.now() - totalStartedAt;
    logRouteTiming(routeTiming, {
      field,
      value: fieldValue,
      source: 'postgres',
      reason: 'sql_cache_unavailable',
    });
    return firestoreFallbackRemovedResponse(ROUTE, {
      field,
      value: fieldValue,
    });
  }

  const coadminUid = resolveRequestedCoadminUid(request, scoped);
  if (!coadminUid) {
    return timedJson({ gameLogins: [], source: 'postgres' }, totalStartedAt, routeTiming, {
      reason: 'missing_coadmin_uid',
      source: 'postgres',
    });
  }

  if (!tokenOnlyAuthorized) {
    const scopeStartedAt = Date.now();
    const allowed = canAccessCoadmin(auth.user!, coadminUid, scoped);
    routeTiming.scope_check_ms = Date.now() - scopeStartedAt;
    if (!allowed) {
      const response = apiError('Forbidden.', 403);
      routeTiming.total_ms = Date.now() - totalStartedAt;
      logRouteTiming(routeTiming, { reason: 'forbidden_coadmin' });
      return response;
    }
  }

  const sqlTiming = createGameLoginsSqlTiming();
  const fallbackStartedAt = Date.now();
  try {
    const cached = await readGameLoginsCacheByCoadmin(coadminUid, sqlTiming);
    mergeSqlTiming(routeTiming, sqlTiming);
    if (cached !== null) {
      logCacheSqlRead(ROUTE, { coadminUid, count: cached.length });
      return timedJson(
        { gameLogins: cached, source: 'postgres' },
        totalStartedAt,
        routeTiming,
        {
          coadminUid,
          source: 'postgres',
        },
        undefined,
        sqlTiming
      );
    }
  } catch (error) {
    console.warn('[GAME_LOGINS_CACHE] postgres read failed', { coadminUid, error });
  }

  routeTiming.fallback_check_ms = Date.now() - fallbackStartedAt;
  routeTiming.total_ms = Date.now() - totalStartedAt;
  logRouteTiming(routeTiming, {
    coadminUid,
    source: 'postgres',
    reason: 'sql_cache_unavailable',
  });
  return firestoreFallbackRemovedResponse(ROUTE, { coadminUid });
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
