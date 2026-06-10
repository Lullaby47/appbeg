const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');

function argValue(name) {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  const hit = index >= 0 ? process.argv[index] : null;
  if (!hit) return null;
  if (hit === name) {
    const next = process.argv[index + 1];
    return next && !next.startsWith('--') ? next : 'true';
  }
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
  if (connectionString) return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
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

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function normalizeJson(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeJson(child)]));
  }
  return value;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalize(doc) {
  const data = doc.data() || {};
  return {
    firebase_id: doc.id,
    coadmin_uid: clean(data.coadminUid),
    bonus_name: clean(data.bonusName),
    game_name: clean(data.gameName),
    amount_npr: numOrNull(data.amountNpr ?? data.amount),
    bonus_percentage: numOrNull(data.bonusPercentage ?? data.bonus_percentage),
    description: clean(data.description),
    created_by_uid: clean(data.createdByUid ?? data.created_by),
    created_by_username: clean(data.createdByUsername),
    created_by_role: clean(data.createdByRole ?? data.creator_role),
    status: clean(data.status) || 'active',
    start_date: toIso(data.startDate ?? data.start_date),
    end_date: toIso(data.endDate ?? data.end_date),
    created_at: toIso(data.createdAt ?? data.created_at),
    updated_at: toIso(data.updatedAt ?? data.updated_at),
    raw_firestore_data: normalizeJson(data) || {},
  };
}

async function existingIds(pool) {
  const result = await pool.query(
    'SELECT firebase_id FROM public.bonus_events_cache WHERE deleted_at IS NULL'
  );
  return new Set(result.rows.map((row) => String(row.firebase_id)));
}

async function upsert(pool, row) {
  await pool.query(
    `
      INSERT INTO public.bonus_events_cache (
        firebase_id, coadmin_uid, bonus_name, game_name, amount_npr, bonus_percentage,
        description, created_by_uid, created_by_username, created_by_role, status,
        start_date, end_date, created_at, updated_at, raw_firestore_data,
        source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5, $6,
        NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''),
        $12::timestamptz, $13::timestamptz, $14::timestamptz, $15::timestamptz, $16::jsonb,
        'firebase_backfill', now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        bonus_name = EXCLUDED.bonus_name,
        game_name = EXCLUDED.game_name,
        amount_npr = EXCLUDED.amount_npr,
        bonus_percentage = EXCLUDED.bonus_percentage,
        description = EXCLUDED.description,
        created_by_uid = EXCLUDED.created_by_uid,
        created_by_username = EXCLUDED.created_by_username,
        created_by_role = EXCLUDED.created_by_role,
        status = EXCLUDED.status,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        created_at = COALESCE(public.bonus_events_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      row.firebase_id,
      row.coadmin_uid,
      row.bonus_name,
      row.game_name,
      row.amount_npr,
      row.bonus_percentage,
      row.description,
      row.created_by_uid,
      row.created_by_username,
      row.created_by_role,
      row.status,
      row.start_date,
      row.end_date,
      row.created_at,
      row.updated_at,
      JSON.stringify(row.raw_firestore_data),
    ]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  let query = db.collection('bonusEvents');
  if (LIMIT > 0) query = query.limit(LIMIT);
  const snapshot = await query.get();
  let wouldUpsert = 0;
  let upserted = 0;
  let errors = 0;

  for (const doc of snapshot.docs) {
    if (ONLY_MISSING && sqlIds.has(doc.id)) continue;
    wouldUpsert += 1;
    if (DRY_RUN) continue;
    try {
      await upsert(pool, normalize(doc));
      upserted += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_BONUS_EVENTS_CACHE] failed', { firebaseId: doc.id, error });
    }
  }

  await pool.end();
  console.log(
    JSON.stringify(
      {
        collection: 'bonusEvents',
        firebase_count_seen: snapshot.size,
        would_upsert: wouldUpsert,
        upserted,
        errors,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[BACKFILL_BONUS_EVENTS_CACHE] fatal', error);
  process.exitCode = 1;
});
