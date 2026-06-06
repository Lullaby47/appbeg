const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');

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

function sameIso(left, right) {
  return (left || null) === (right || null);
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const [firebaseSnap, sqlResult] = await Promise.all([
    db.collection('coadminBonusSettings').get(),
    pool.query(`
      SELECT firebase_id, coadmin_uid, updated_at
      FROM public.coadmin_bonus_settings_cache
      WHERE deleted_at IS NULL
    `),
  ]);

  const firebaseRows = new Map();
  for (const doc of firebaseSnap.docs) {
    const data = doc.data() || {};
    firebaseRows.set(doc.id, {
      coadmin_uid: clean(data.coadminUid) || doc.id,
      updated_at: toIsoString(data.updatedAt || data.updated_at),
    });
  }

  const sqlRows = new Map();
  for (const row of sqlResult.rows) {
    sqlRows.set(String(row.firebase_id), {
      coadmin_uid: clean(row.coadmin_uid),
      updated_at: toIsoString(row.updated_at),
    });
  }

  const missingInSql = [];
  const extraInSql = [];
  const mismatched = [];

  for (const [id, firebaseRow] of firebaseRows.entries()) {
    const sqlRow = sqlRows.get(id);
    if (!sqlRow) {
      missingInSql.push(id);
      continue;
    }
    const mismatch = {};
    if (firebaseRow.coadmin_uid !== sqlRow.coadmin_uid) {
      mismatch.coadmin_uid = { firebase: firebaseRow.coadmin_uid, sql: sqlRow.coadmin_uid };
    }
    if (!sameIso(firebaseRow.updated_at, sqlRow.updated_at)) {
      mismatch.updated_at = { firebase: firebaseRow.updated_at, sql: sqlRow.updated_at };
    }
    if (Object.keys(mismatch).length > 0) {
      mismatched.push({ firebase_id: id, ...mismatch });
    }
  }

  for (const id of sqlRows.keys()) {
    if (!firebaseRows.has(id)) {
      extraInSql.push(id);
    }
  }

  await pool.end();
  console.log(JSON.stringify({
    collection: 'coadminBonusSettings',
    firebase_count: firebaseRows.size,
    postgres_count: sqlRows.size,
    missing_in_sql: missingInSql,
    extra_in_sql: extraInSql,
    mismatched_coadmin_uid_updated_at: mismatched,
  }, null, 2));
}

main().catch((error) => {
  console.error('[COMPARE_COADMIN_BONUS_SETTINGS_CACHE] fatal', error);
  process.exitCode = 1;
});
