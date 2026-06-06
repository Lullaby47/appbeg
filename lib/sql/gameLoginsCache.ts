import 'server-only';

import { Pool } from 'pg';

export type CachedGameLogin = {
  id: string;
  gameName: string;
  username: string;
  password: string;
  backendUrl?: string;
  frontendUrl?: string;
  siteUrl?: string;
  createdBy: string;
  coadminUid?: string;
  createdAt?: string | null;
  status?: string;
};

export type MirrorGameLoginInput = CachedGameLogin & {
  raw?: Record<string, unknown>;
};

let pool: Pool | null = null;
const GAME_LOGINS_CACHE_SQL_TIMEOUT_MS = 5_000;

function databaseUrl() {
  return String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
}

export function hasGameLoginsCacheDatabase() {
  return Boolean(databaseUrl());
}

function getPool() {
  const connectionString = databaseUrl();
  if (!connectionString) {
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: GAME_LOGINS_CACHE_SQL_TIMEOUT_MS,
      idleTimeoutMillis: 10_000,
      query_timeout: GAME_LOGINS_CACHE_SQL_TIMEOUT_MS,
      statement_timeout: GAME_LOGINS_CACHE_SQL_TIMEOUT_MS,
    });
  }
  return pool;
}

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const maybe = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number };
    if (typeof maybe.toDate === 'function') return maybe.toDate().toISOString();
    if (typeof maybe.toMillis === 'function') return new Date(maybe.toMillis()).toISOString();
    if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000).toISOString();
  }
  return null;
}

function mapRow(row: Record<string, unknown>): CachedGameLogin {
  return {
    id: cleanText(row.id),
    gameName: cleanText(row.game_name),
    username: cleanText(row.username),
    password: cleanText(row.password),
    backendUrl: cleanText(row.backend_url),
    frontendUrl: cleanText(row.frontend_url),
    siteUrl: cleanText(row.site_url),
    createdBy: cleanText(row.created_by),
    coadminUid: cleanText(row.coadmin_uid) || undefined,
    createdAt: toIsoString(row.created_at),
    status: cleanText(row.status) || 'active',
  };
}

export async function readGameLoginsCacheByField(
  field: 'coadminUid' | 'createdBy',
  value: string
): Promise<CachedGameLogin[] | null> {
  const db = getPool();
  if (!db) return null;

  const column = field === 'coadminUid' ? 'coadmin_uid' : 'created_by';
  const result = await db.query(
    `
      SELECT
        id,
        game_name,
        username,
        password,
        backend_url,
        frontend_url,
        site_url,
        created_by,
        coadmin_uid,
        created_at,
        status
      FROM public.game_logins_cache
      WHERE ${column} = $1
        AND status = 'active'
      ORDER BY COALESCE(created_at, updated_at, mirrored_at) DESC
    `,
    [value]
  );

  return result.rows.map(mapRow);
}

export async function readGameLoginsCacheByCoadmin(
  coadminUid: string
): Promise<CachedGameLogin[] | null> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    readGameLoginsCacheByField('coadminUid', coadminUid),
    readGameLoginsCacheByField('createdBy', coadminUid),
  ]);

  if (!coadminOwned || !legacyOwned) {
    return null;
  }

  return Array.from(
    new Map(
      [...coadminOwned, ...legacyOwned].map((gameLogin) => [gameLogin.id, gameLogin])
    ).values()
  );
}

export async function mirrorGameLoginCache(input: MirrorGameLoginInput) {
  const db = getPool();
  if (!db) return false;

  const gameName = cleanText(input.gameName);
  const username = cleanText(input.username);
  const password = String(input.password || '');
  const createdBy = cleanText(input.createdBy);
  if (!input.id || !gameName || !username || !createdBy) {
    throw new Error('Invalid game login cache mirror payload.');
  }

  await db.query(
    `
      INSERT INTO public.game_logins_cache (
        id,
        game_name,
        username,
        password,
        backend_url,
        frontend_url,
        site_url,
        created_by,
        coadmin_uid,
        status,
        source,
        raw_json,
        created_at,
        updated_at,
        deleted_at,
        mirrored_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), 'active', 'appbeg', $10::jsonb,
        $11::timestamptz, now(), NULL, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        game_name = EXCLUDED.game_name,
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        backend_url = EXCLUDED.backend_url,
        frontend_url = EXCLUDED.frontend_url,
        site_url = EXCLUDED.site_url,
        created_by = EXCLUDED.created_by,
        coadmin_uid = EXCLUDED.coadmin_uid,
        status = 'active',
        source = 'appbeg',
        raw_json = EXCLUDED.raw_json,
        created_at = COALESCE(public.game_logins_cache.created_at, EXCLUDED.created_at),
        updated_at = now(),
        deleted_at = NULL,
        mirrored_at = now()
    `,
    [
      input.id,
      gameName,
      username,
      password,
      cleanText(input.backendUrl),
      cleanText(input.frontendUrl),
      cleanText(input.siteUrl || input.backendUrl),
      createdBy,
      cleanText(input.coadminUid),
      JSON.stringify(input.raw || {}),
      toIsoString(input.createdAt),
    ]
  );

  return true;
}

export async function deleteGameLoginCache(id: string) {
  const db = getPool();
  if (!db) return false;

  await db.query('DELETE FROM public.game_logins_cache WHERE id = $1', [id]);
  return true;
}
