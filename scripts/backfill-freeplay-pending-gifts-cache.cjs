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

function computeHasPendingGift(data) {
  return (
    clean(data.type).toLowerCase() === 'freeplay' &&
    clean(data.status).toLowerCase() === 'pending' &&
    Boolean(clean(data.giftId))
  );
}

function normalize(doc) {
  const data = doc.data() || {};
  const createdAt = toIso(data.createdAt);
  const claimedAt = toIso(data.claimedAt);
  const updatedAt = toIso(data.updatedAt) || claimedAt || createdAt;
  return {
    player_uid: doc.id,
    coadmin_uid: clean(data.coadminUid),
    gift_id: clean(data.giftId),
    has_pending_gift: computeHasPendingGift(data),
    status: clean(data.status),
    amount: numOrNull(data.amount),
    created_at: createdAt,
    updated_at: updatedAt,
    claimed_at: claimedAt,
    raw_firestore_data: normalizeJson(data) || {},
  };
}

async function existingIds(pool) {
  const result = await pool.query(
    'SELECT player_uid FROM public.freeplay_pending_gifts_cache WHERE deleted_at IS NULL'
  );
  return new Set(result.rows.map((row) => String(row.player_uid)));
}

async function upsert(pool, row) {
  await pool.query(
    `
      INSERT INTO public.freeplay_pending_gifts_cache (
        player_uid, coadmin_uid, gift_id, has_pending_gift, status, amount,
        created_at, updated_at, claimed_at, raw_firestore_data,
        source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), $4, NULLIF($5, ''), $6,
        $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::jsonb,
        'firebase_backfill', now(), NULL
      )
      ON CONFLICT (player_uid) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        gift_id = EXCLUDED.gift_id,
        has_pending_gift = EXCLUDED.has_pending_gift,
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        created_at = COALESCE(EXCLUDED.created_at, public.freeplay_pending_gifts_cache.created_at),
        updated_at = EXCLUDED.updated_at,
        claimed_at = EXCLUDED.claimed_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      row.player_uid,
      row.coadmin_uid,
      row.gift_id,
      row.has_pending_gift,
      row.status,
      row.amount,
      row.created_at,
      row.updated_at,
      row.claimed_at,
      JSON.stringify(row.raw_firestore_data),
    ]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  let query = db.collection('freeplayPendingGifts');
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
      console.error('[BACKFILL_FREEPLAY_PENDING_GIFTS_CACHE] failed', {
        playerUid: doc.id,
        error,
      });
    }
  }

  await pool.end();
  console.log(
    JSON.stringify(
      {
        collection: 'freeplayPendingGifts',
        firebase_count_seen: snapshot.size,
        would_upsert: wouldUpsert,
        upserted,
        errors,
        dry_run: DRY_RUN,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[BACKFILL_FREEPLAY_PENDING_GIFTS_CACHE] fatal', error);
  process.exitCode = 1;
});
