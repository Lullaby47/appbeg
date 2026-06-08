const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function clean(value) {
  return String(value || '').trim();
}

function loadEnvLocal() {
  for (const fileName of ['.env.local', '.env']) {
    const envPath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq);
      if (!process.env[key]) {
        process.env[key] = trimmed.slice(eq + 1);
      }
    }
  }
}

function required(name) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function initApp() {
  const serviceAccount = JSON.parse(
    Buffer.from(required('FIREBASE_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8')
  );
  return getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value.toMillis === 'function') return new Date(value.toMillis()).toISOString();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
  return null;
}

function rowFirestore(doc) {
  const data = doc.data() || {};
  return {
    carer_uid: doc.id,
    enabled: data.enabled === true,
    lease_owner: clean(data.tickLeaseHolderId),
    coadmin_uid: clean(data.coadminUid),
    automation_agent_id: clean(data.automationAgentId),
    lease_expires_at: toIso(data.tickLeaseExpiresAt),
  };
}

function rowSql(row) {
  return {
    carer_uid: clean(row.carer_uid),
    enabled: row.enabled === true,
    lease_owner: clean(row.lease_owner),
    coadmin_uid: clean(row.coadmin_uid),
    automation_agent_id: clean(row.automation_agent_id),
    lease_expires_at: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
  };
}

function diffFields(left, right) {
  const fields = {};
  for (const key of Object.keys(left)) {
    if (left[key] !== right[key]) {
      fields[key] = { firebase: left[key], sql: right[key] };
    }
  }
  return fields;
}

async function main() {
  loadEnvLocal();
  initApp();
  const db = getFirestore();
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || required('DATABASE_URL'),
  });

  const [firestoreSnap, sqlResult] = await Promise.all([
    db.collection('automation_auto_state').get(),
    pg.query(
      `
        SELECT carer_uid, coadmin_uid, enabled, automation_agent_id, lease_owner, lease_expires_at
        FROM public.automation_auto_state_cache
        WHERE deleted_at IS NULL
      `
    ),
  ]);

  const sqlByUid = new Map(sqlResult.rows.map((row) => [String(row.carer_uid), row]));
  const missingInSql = [];
  const mismatchedFields = [];

  for (const doc of firestoreSnap.docs) {
    const sqlRow = sqlByUid.get(doc.id);
    if (!sqlRow) {
      missingInSql.push(doc.id);
      continue;
    }
    const diff = diffFields(rowFirestore(doc), rowSql(sqlRow));
    if (Object.keys(diff).length) {
      mismatchedFields.push({ carer_uid: doc.id, fields: diff });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        firebase_count: firestoreSnap.size,
        postgres_count: sqlResult.rows.length,
        missing_in_sql: missingInSql,
        mismatched_fields: mismatchedFields,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[COMPARE_AUTOMATION_AUTO_STATE_CACHE] fatal', error);
  process.exitCode = 1;
});
