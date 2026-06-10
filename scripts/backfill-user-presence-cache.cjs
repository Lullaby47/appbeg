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

async function existingIds(pool) {
  const result = await pool.query(
    'SELECT uid FROM public.user_presence_cache WHERE deleted_at IS NULL'
  );
  return new Set(result.rows.map((row) => String(row.uid)));
}

async function upsert(pool, row) {
  await pool.query(
    `
      INSERT INTO public.user_presence_cache (uid, last_seen_at, source, mirrored_at, deleted_at)
      VALUES ($1, $2::timestamptz, 'firebase_backfill', now(), NULL)
      ON CONFLICT (uid) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [row.uid, row.last_seen_at]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  let query = db.collection('userPresence');
  if (LIMIT > 0) query = query.limit(LIMIT);
  const snapshot = await query.get();
  let wouldUpsert = 0;
  let upserted = 0;
  let errors = 0;

  for (const doc of snapshot.docs) {
    if (ONLY_MISSING && sqlIds.has(doc.id)) continue;
    const lastSeenAt = toIso((doc.data() || {}).lastSeenAt);
    if (!lastSeenAt) continue;
    wouldUpsert += 1;
    if (DRY_RUN) continue;
    try {
      await upsert(pool, { uid: doc.id, last_seen_at: lastSeenAt });
      upserted += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_USER_PRESENCE_CACHE] failed', { uid: doc.id, error });
    }
  }

  await pool.end();
  console.log(
    JSON.stringify(
      {
        collection: 'userPresence',
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
  console.error('[BACKFILL_USER_PRESENCE_CACHE] fatal', error);
  process.exitCode = 1;
});
