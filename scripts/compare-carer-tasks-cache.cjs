#!/usr/bin/env node

const admin = require('firebase-admin');
const { Pool } = require('pg');

function clean(value) {
  return String(value || '').trim();
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.toMillis === 'function') return new Date(value.toMillis());
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
  }
  return null;
}

function toIso(value) {
  return toDate(value)?.toISOString() || null;
}

function requiredEnv(name) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function initFirebase() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(
    Buffer.from(requiredEnv('FIREBASE_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function fsRow(doc) {
  const data = doc.data() || {};
  return {
    firebase_id: doc.id,
    type: clean(data.type || data.kind || data.action || data.taskAction),
    status: clean(data.status),
    player_uid: clean(data.playerUid || data.playerId),
    coadmin_uid: clean(data.coadminUid || data.createdBy),
    request_id: clean(data.requestId),
    automation_job_id: clean(data.automationJobId),
    assigned_carer_uid: clean(data.assignedCarerUid),
    completed_at: toIso(data.completedAt),
    updated_at: toIso(data.updatedAt),
  };
}

function sqlRow(row) {
  return {
    firebase_id: clean(row.firebase_id),
    type: clean(row.type),
    status: clean(row.status),
    player_uid: clean(row.player_uid),
    coadmin_uid: clean(row.coadmin_uid),
    request_id: clean(row.request_id),
    automation_job_id: clean(row.automation_job_id),
    assigned_carer_uid: clean(row.assigned_carer_uid),
    completed_at: toIso(row.completed_at),
    updated_at: toIso(row.updated_at),
  };
}

function diff(left, right) {
  const fields = [
    'type',
    'status',
    'player_uid',
    'coadmin_uid',
    'request_id',
    'automation_job_id',
    'assigned_carer_uid',
    'completed_at',
    'updated_at',
  ];
  const out = {};
  for (const field of fields) {
    if ((left[field] || '') !== (right[field] || '')) {
      out[field] = { firebase: left[field] || null, postgres: right[field] || null };
    }
  }
  return out;
}

async function main() {
  initFirebase();
  const db = admin.firestore();
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || requiredEnv('DATABASE_URL'),
  });

  const [firebaseSnap, sqlResult] = await Promise.all([
    db.collection('carerTasks').get(),
    pg.query('SELECT * FROM public.carer_tasks_cache WHERE deleted_at IS NULL'),
  ]);

  const firebaseRows = new Map(firebaseSnap.docs.map((doc) => [doc.id, fsRow(doc)]));
  const sqlRows = new Map(sqlResult.rows.map((row) => [String(row.firebase_id), sqlRow(row)]));
  const missing_in_sql = [];
  const extra_in_sql = [];
  const mismatched_fields = [];

  for (const [id, row] of firebaseRows) {
    const cached = sqlRows.get(id);
    if (!cached) {
      missing_in_sql.push(id);
      continue;
    }
    const fields = diff(row, cached);
    if (Object.keys(fields).length) mismatched_fields.push({ firebase_id: id, fields });
  }
  for (const id of sqlRows.keys()) {
    if (!firebaseRows.has(id)) extra_in_sql.push(id);
  }

  await pg.end();
  console.log(JSON.stringify({
    collection: 'carerTasks',
    firebase_count: firebaseRows.size,
    postgres_count: sqlRows.size,
    missing_in_sql,
    extra_in_sql,
    mismatched_fields,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
