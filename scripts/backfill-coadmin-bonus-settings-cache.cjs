const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');

function argValue(name) {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!hit) return null;
  if (hit === name) return 'true';
  return hit.slice(prefix.length);
}

const DRY_RUN = argValue('--dry-run') !== null;
const ONLY_MISSING = argValue('--only-missing') !== null;
const LIMIT = Number(argValue('--limit') || '0') || 0;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function clean(value) {
  return String(value || '').trim();
}

function initFirebase() {
  const base64 = requiredEnv('FIREBASE_SERVICE_ACCOUNT_BASE64');
  const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  return getApps().length === 0
    ? initializeApp({ credential: cert(serviceAccount) })
    : getApps()[0];
}

function createPgPool() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (connectionString) {
    return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  }
  return new Pool({
    host: clean(process.env.APPBEG_PG_HOST || '127.0.0.1'),
    port: Number(process.env.APPBEG_PG_PORT || '5433'),
    database: clean(process.env.APPBEG_PG_DATABASE || 'appbeg'),
    user: clean(process.env.APPBEG_PG_USER || 'appbeg_user'),
    password: requiredEnv('APPBEG_PG_PASSWORD'),
    connectionTimeoutMillis: 10_000,
  });
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.toMillis === 'function') return new Date(value.toMillis());
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
  return null;
}

function toIsoString(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function normalizeJson(value) {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeJson(child)]));
  }
  return value;
}

async function existingIds(pool) {
  const result = await pool.query('SELECT firebase_id FROM public.coadmin_bonus_settings_cache');
  return new Set(result.rows.map((row) => String(row.firebase_id)));
}

async function upsert(pool, doc) {
  const data = doc.data() || {};
  const coadminUid = clean(data.coadminUid) || doc.id;
  await pool.query(
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
      VALUES ($1, $2, $3::jsonb, 'firebase_backfill', $4::timestamptz, $5::timestamptz, now(), NULL)
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        raw_json = EXCLUDED.raw_json,
        source = COALESCE(public.coadmin_bonus_settings_cache.source, 'firebase_backfill'),
        created_at = COALESCE(public.coadmin_bonus_settings_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      doc.id,
      coadminUid,
      JSON.stringify(normalizeJson(data) || {}),
      toIsoString(data.createdAt || data.created_at),
      toIsoString(data.updatedAt || data.updated_at),
    ]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  const snapshot = await db.collection('coadminBonusSettings').get();
  const docs = LIMIT > 0 ? snapshot.docs.slice(0, LIMIT) : snapshot.docs;
  let wouldUpsert = 0;
  let upserted = 0;
  let skippedExisting = 0;
  let errors = 0;

  for (const doc of docs) {
    if (ONLY_MISSING && sqlIds.has(doc.id)) {
      skippedExisting += 1;
      continue;
    }
    wouldUpsert += 1;
    if (DRY_RUN) continue;
    try {
      await upsert(pool, doc);
      upserted += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_COADMIN_BONUS_SETTINGS_CACHE] failed', {
        firebaseId: doc.id,
        error,
      });
    }
  }

  await pool.end();
  console.log(JSON.stringify({
    collection: 'coadminBonusSettings',
    dry_run: DRY_RUN,
    only_missing: ONLY_MISSING,
    limit: LIMIT || null,
    firebase_count_seen: snapshot.size,
    processed_count: docs.length,
    would_upsert: wouldUpsert,
    upserted,
    skipped_existing: skippedExisting,
    errors,
  }, null, 2));
}

main().catch((error) => {
  console.error('[BACKFILL_COADMIN_BONUS_SETTINGS_CACHE] fatal', error);
  process.exitCode = 1;
});
