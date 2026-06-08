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

function rowFirestore(doc) {
  const data = doc.data() || {};
  return {
    session_id: doc.id,
    player_uid: clean(data.playerUid),
    active: data.active === true,
    device_id: clean(data.deviceId),
    ended_reason: clean(data.endedReason),
  };
}

function rowSql(row) {
  return {
    session_id: clean(row.session_id),
    player_uid: clean(row.player_uid),
    active: row.active === true,
    device_id: clean(row.device_id),
    ended_reason: clean(row.ended_reason),
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
    db.collection('playerSessions').get(),
    pg.query('SELECT * FROM public.player_sessions_cache WHERE deleted_at IS NULL'),
  ]);

  const firestoreById = new Map(firestoreSnap.docs.map((doc) => [doc.id, rowFirestore(doc)]));
  const sqlById = new Map(sqlResult.rows.map((row) => [String(row.session_id), rowSql(row)]));

  const missingInSql = [];
  const extraInSql = [];
  const mismatchedFields = [];

  for (const [sessionId, firestoreRow] of firestoreById) {
    const sqlRow = sqlById.get(sessionId);
    if (!sqlRow) {
      missingInSql.push(sessionId);
      continue;
    }
    const fields = diffFields(firestoreRow, sqlRow);
    if (Object.keys(fields).length) {
      mismatchedFields.push({ session_id: sessionId, fields });
    }
  }

  for (const sessionId of sqlById.keys()) {
    if (!firestoreById.has(sessionId)) {
      extraInSql.push(sessionId);
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        collection: 'playerSessions',
        firebase_count: firestoreById.size,
        postgres_count: sqlById.size,
        missing_in_sql: missingInSql,
        extra_in_sql: extraInSql,
        mismatched_fields: mismatchedFields,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[COMPARE_PLAYER_SESSIONS_CACHE] fatal', error);
  process.exitCode = 1;
});
