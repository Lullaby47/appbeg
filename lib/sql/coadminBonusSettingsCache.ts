import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { Pool } from 'pg';

type MirrorInput = {
  firebaseId: string;
  coadminUid: string;
  raw: Record<string, unknown>;
  createdAt?: unknown;
  updatedAt?: unknown;
};

const SQL_TIMEOUT_MS = 5_000;
const COADMIN_BONUS_SETTINGS_POOL_MAX = 2;
const COADMIN_BONUS_SETTINGS_POOL_IDLE_TIMEOUT_MS = 120_000;

type CoadminBonusSettingsPoolCache = {
  connectionString: string;
  pool: Pool;
};

const globalSqlPool = globalThis as typeof globalThis & {
  __appbegCoadminBonusSettingsCachePool?: CoadminBonusSettingsPoolCache;
};

function databaseUrl() {
  return String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
}

function getPool() {
  const connectionString = databaseUrl();
  if (!connectionString) return null;
  const cached = globalSqlPool.__appbegCoadminBonusSettingsCachePool;
  if (cached?.connectionString === connectionString) {
    console.info('[SQL_POOL] reused', { name: 'coadminBonusSettingsCache', global: true });
    return cached.pool;
  }
  const pool = new Pool({
    connectionString,
    max: COADMIN_BONUS_SETTINGS_POOL_MAX,
    connectionTimeoutMillis: SQL_TIMEOUT_MS,
    idleTimeoutMillis: COADMIN_BONUS_SETTINGS_POOL_IDLE_TIMEOUT_MS,
    query_timeout: SQL_TIMEOUT_MS,
    statement_timeout: SQL_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    console.warn('[SQL_POOL] idle client error', { name: 'coadminBonusSettingsCache', error });
  });
  globalSqlPool.__appbegCoadminBonusSettingsCachePool = { connectionString, pool };
  console.info('[SQL_POOL] created', {
    name: 'coadminBonusSettingsCache',
    max: COADMIN_BONUS_SETTINGS_POOL_MAX,
    global: true,
  });
  return pool;
}

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'object') {
    const maybe = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof maybe.toDate === 'function') return maybe.toDate();
    if (typeof maybe.toMillis === 'function') return new Date(maybe.toMillis());
    if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000);
    if (typeof maybe._seconds === 'number') return new Date(maybe._seconds * 1000);
  }
  return null;
}

function toIsoString(value: unknown): string | null {
  return toDate(value)?.toISOString() || null;
}

function normalizeJson(value: unknown): unknown {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        normalizeJson(child),
      ])
    );
  }
  return value;
}

export async function mirrorCoadminBonusSettingsCache(input: MirrorInput) {
  const db = getPool();
  if (!db) return false;

  const firebaseId = cleanText(input.firebaseId);
  const coadminUid = cleanText(input.coadminUid);
  if (!firebaseId || !coadminUid) {
    throw new Error('Invalid coadmin bonus settings cache mirror payload.');
  }

  await db.query(
    `
      INSERT INTO public.coadmin_bonus_settings_cache (
        firebase_id,
        coadmin_uid,
        raw_json,
        source,
        created_at,
        updated_at,
        mirrored_at,
        deleted_at
      )
      VALUES ($1, $2, $3::jsonb, 'appbeg', $4::timestamptz, $5::timestamptz, now(), NULL)
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        raw_json = EXCLUDED.raw_json,
        source = 'appbeg',
        created_at = COALESCE(public.coadmin_bonus_settings_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      firebaseId,
      coadminUid,
      JSON.stringify(normalizeJson(input.raw) || {}),
      toIsoString(input.createdAt),
      toIsoString(input.updatedAt),
    ]
  );

  return true;
}

export async function mirrorCoadminBonusSettingsSnapshot(
  snap: DocumentSnapshot
) {
  if (!snap.exists) return false;
  const data = snap.data() as Record<string, unknown>;
  await mirrorCoadminBonusSettingsCache({
    firebaseId: snap.id,
    coadminUid: cleanText(data.coadminUid) || snap.id,
    raw: data,
    createdAt: data.createdAt || data.created_at || null,
    updatedAt: data.updatedAt || data.updated_at || null,
  });
  return true;
}
