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

function boolValue(value) {
  return typeof value === 'boolean' ? value : null;
}

function normalizeFirebase(doc) {
  const data = doc.data() || {};
  return {
    coadminUid: clean(data.coadminUid || data.createdBy),
    playerUid: clean(data.playerUid || data.playerId),
    playerUsername: clean(data.playerUsername || data.username),
    amountNpr: numberValue(data.amountNpr ?? data.amount),
    status: clean(data.status),
    assignedHandlerUid: clean(data.assignedHandlerUid),
    assignedHandlerUsername: clean(data.assignedHandlerUsername),
    cashDeductedOnRequest: boolValue(data.cashDeductedOnRequest),
    rewardNprApplied: numberValue(data.rewardNprApplied),
    rewardBlockedApplied: boolValue(data.rewardBlockedApplied),
    createdAt: toIso(data.createdAt),
    completedAt: toIso(data.completedAt),
    startedAt: toIso(data.startedAt),
    expiresAt: toIso(data.expiresAt),
  };
}

function normalizeSql(row) {
  return {
    coadminUid: clean(row.coadmin_uid),
    playerUid: clean(row.player_uid),
    playerUsername: clean(row.player_username),
    amountNpr: numberValue(row.amount_npr),
    status: clean(row.status),
    assignedHandlerUid: clean(row.assigned_handler_uid),
    assignedHandlerUsername: clean(row.assigned_handler_username),
    cashDeductedOnRequest: boolValue(row.cash_deducted_on_request),
    rewardNprApplied: numberValue(row.reward_npr_applied),
    rewardBlockedApplied: boolValue(row.reward_blocked_applied),
    createdAt: toIso(row.created_at),
    completedAt: toIso(row.completed_at),
    startedAt: toIso(row.started_at),
    expiresAt: toIso(row.expires_at),
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
    db.collection('playerCashoutTasks').get(),
    db.collection('playerCashoutTasks').orderBy('createdAt', 'desc').limit(50).get(),
    pool.query('SELECT * FROM public.player_cashout_tasks_cache WHERE deleted_at IS NULL'),
  ]);

  const firebaseRows = new Map(firebaseSnap.docs.map((doc) => [doc.id, normalizeFirebase(doc)]));
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

  const latest50 = latestSnap.docs.map((doc) => {
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
    collection: 'playerCashoutTasks',
    firebase_count: firebaseRows.size,
    postgres_count: sqlRows.size,
    missing_in_sql: missingInSql,
    extra_in_sql: extraInSql,
    mismatched_fields: mismatchedFields,
    latest_50_field_by_field: latest50,
  }, null, 2));
}

main().catch((error) => {
  console.error('[COMPARE_PLAYER_CASHOUT_TASKS_CACHE] fatal', error);
  process.exitCode = 1;
});
