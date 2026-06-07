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

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function shouldInclude(data) {
  return Boolean(
    clean(data.role) ||
      data.coin !== undefined ||
      data.cash !== undefined ||
      data.cashBoxNpr !== undefined ||
      data.promoLockedCoins !== undefined ||
      data.referralBonusCoins !== undefined
  );
}

function normalizeFirebase(doc) {
  const data = doc.data() || {};
  return {
    username: clean(data.username),
    role: clean(data.role),
    status: clean(data.status),
    coadminUid: clean(data.coadminUid),
    createdBy: clean(data.createdBy),
    coin: numberValue(data.coin),
    cash: numberValue(data.cash),
    cashBoxNpr: numberValue(data.cashBoxNpr),
    promoLockedCoins: numberValue(data.promoLockedCoins),
    referralBonusCoins: numberValue(data.referralBonusCoins),
    redeemWindow24h: numberValue(data.redeemWindow24h),
    rewardBlocked: boolOrNull(data.rewardBlocked),
    bonusBlockedUntil: toIso(data.bonusBlockedUntil),
    transferBlockedUntil: toIso(data.transferBlockedUntil),
  };
}

function normalizeSql(row) {
  return {
    username: clean(row.username),
    role: clean(row.role),
    status: clean(row.status),
    coadminUid: clean(row.coadmin_uid),
    createdBy: clean(row.created_by),
    coin: numberValue(row.coin),
    cash: numberValue(row.cash),
    cashBoxNpr: numberValue(row.cash_box_npr),
    promoLockedCoins: numberValue(row.promo_locked_coins),
    referralBonusCoins: numberValue(row.referral_bonus_coins),
    redeemWindow24h: numberValue(row.redeem_window_24h),
    rewardBlocked: boolOrNull(row.reward_blocked),
    bonusBlockedUntil: toIso(row.bonus_blocked_until),
    transferBlockedUntil: toIso(row.transfer_blocked_until),
  };
}

function diffFields(firebaseRow, sqlRow) {
  const mismatch = {};
  for (const key of Object.keys(firebaseRow)) {
    if (firebaseRow[key] !== sqlRow[key]) {
      mismatch[key] = { firebase: firebaseRow[key], sql: sqlRow[key] };
    }
  }
  return mismatch;
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const [firebaseSnap, latestSnap, sqlResult] = await Promise.all([
    db.collection('users').get(),
    db.collection('users').orderBy('createdAt', 'desc').limit(50).get(),
    pool.query('SELECT * FROM public.user_balance_snapshots_cache WHERE deleted_at IS NULL'),
  ]);

  const firebaseRows = new Map(
    firebaseSnap.docs
      .filter((doc) => shouldInclude(doc.data() || {}))
      .map((doc) => [doc.id, normalizeFirebase(doc)])
  );
  const sqlRows = new Map(sqlResult.rows.map((row) => [String(row.firebase_id), normalizeSql(row)]));
  const missingInSql = [];
  const extraInSql = [];
  const mismatchedFields = [];

  for (const [id, firebaseRow] of firebaseRows.entries()) {
    const sqlRow = sqlRows.get(id);
    if (!sqlRow) {
      missingInSql.push(id);
      continue;
    }
    const mismatch = diffFields(firebaseRow, sqlRow);
    if (Object.keys(mismatch).length > 0) mismatchedFields.push({ firebase_id: id, fields: mismatch });
  }

  for (const id of sqlRows.keys()) {
    if (!firebaseRows.has(id)) extraInSql.push(id);
  }

  const latest50 = latestSnap.docs
    .filter((doc) => shouldInclude(doc.data() || {}))
    .map((doc) => {
      const firebaseRow = normalizeFirebase(doc);
      const sqlRow = sqlRows.get(doc.id) || null;
      const mismatch = sqlRow ? diffFields(firebaseRow, sqlRow) : { missing_in_sql: true };
      return {
        firebase_id: doc.id,
        matched: Boolean(sqlRow) && Object.keys(mismatch).length === 0,
        firebase: firebaseRow,
        sql: sqlRow,
        mismatched_fields: mismatch,
      };
    });

  await pool.end();
  console.log(JSON.stringify({
    collection: 'users',
    firebase_count: firebaseRows.size,
    postgres_count: sqlRows.size,
    missing_in_sql: missingInSql,
    extra_in_sql: extraInSql,
    mismatched_fields: mismatchedFields,
    latest_50_field_by_field: latest50,
  }, null, 2));
}

main().catch((error) => {
  console.error('[COMPARE_USER_BALANCE_SNAPSHOTS_CACHE] fatal', error);
  process.exitCode = 1;
});
