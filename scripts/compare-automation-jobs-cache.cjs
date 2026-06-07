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

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeFirebase(doc) {
  const data = doc.data() || {};
  const payload = object(data.payload);
  const originalTask = object(payload.originalTask);
  const type = clean(data.type || data.taskType || payload.type || originalTask.type);
  return {
    jobId: doc.id,
    taskId: clean(data.taskId || payload.taskId || originalTask.id),
    linkedTaskId: clean(data.linkedTaskId || payload.linkedTaskId),
    coadminUid: clean(data.coadminUid || payload.coadminUid || originalTask.coadminUid),
    carerUid: clean(data.carerUid || data.createdByUid),
    playerUid: clean(data.playerUid || payload.playerUid || originalTask.playerUid),
    agentId: clean(data.agentId),
    createdByUid: clean(data.createdByUid || data.carerUid),
    game: clean(data.game || data.gameName || payload.game || payload.gameName || originalTask.gameName || originalTask.game),
    type,
    requestType: clean(data.requestType || payload.requestType || payload.type || type),
    status: clean(data.status),
    claimedStatus: clean(data.claimedStatus),
    errorMessage: clean(data.error || data.errorMessage),
    cancelledReason: clean(data.cancelledReason),
    attempts: Number.isFinite(Number(data.attempts)) ? Math.trunc(Number(data.attempts)) : null,
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    startedAt: toIso(data.startedAt),
    completedAt: toIso(data.completedAt),
    failedAt: toIso(data.failedAt),
    lastHeartbeatAt: toIso(data.lastHeartbeatAt),
    ttlExpiresAt: toIso(data.ttlExpiresAt),
  };
}

function normalizeSql(row) {
  return {
    jobId: clean(row.job_id),
    taskId: clean(row.task_id),
    linkedTaskId: clean(row.linked_task_id),
    coadminUid: clean(row.coadmin_uid),
    carerUid: clean(row.carer_uid),
    playerUid: clean(row.player_uid),
    agentId: clean(row.agent_id),
    createdByUid: clean(row.created_by_uid),
    game: clean(row.game),
    type: clean(row.type),
    requestType: clean(row.request_type),
    status: clean(row.status),
    claimedStatus: clean(row.claimed_status),
    errorMessage: clean(row.error_message),
    cancelledReason: clean(row.cancelled_reason),
    attempts: row.attempts === null || row.attempts === undefined ? null : Number(row.attempts),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    failedAt: toIso(row.failed_at),
    lastHeartbeatAt: toIso(row.last_heartbeat_at),
    ttlExpiresAt: toIso(row.ttl_expires_at),
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
    db.collection('automation_jobs').get(),
    db.collection('automation_jobs').orderBy('createdAt', 'desc').limit(50).get(),
    pool.query(`
      SELECT *
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
    `),
  ]);

  const firebaseRows = new Map(firebaseSnap.docs.map((doc) => [doc.id, normalizeFirebase(doc)]));
  const sqlRows = new Map(sqlResult.rows.map((row) => [String(row.job_id), normalizeSql(row)]));
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
    if (Object.keys(mismatch).length > 0) {
      mismatchedFields.push({ job_id: id, fields: mismatch });
    }
  }

  for (const id of sqlRows.keys()) {
    if (!firebaseRows.has(id)) extraInSql.push(id);
  }

  const latest50 = [];
  for (const doc of latestSnap.docs) {
    const firebaseRow = normalizeFirebase(doc);
    const sqlRow = sqlRows.get(doc.id) || null;
    latest50.push({
      job_id: doc.id,
      matched: Boolean(sqlRow) && Object.keys(diffFields(firebaseRow, sqlRow)).length === 0,
      mismatched_fields: sqlRow ? diffFields(firebaseRow, sqlRow) : { missing_in_sql: true },
    });
  }

  await pool.end();
  console.log(JSON.stringify({
    collection: 'automation_jobs',
    firebase_count: firebaseRows.size,
    postgres_count: sqlRows.size,
    missing_in_sql: missingInSql,
    extra_in_sql: extraInSql,
    mismatched_fields: mismatchedFields,
    latest_50_field_by_field: latest50,
  }, null, 2));
}

main().catch((error) => {
  console.error('[COMPARE_AUTOMATION_JOBS_CACHE] fatal', error);
  process.exitCode = 1;
});
