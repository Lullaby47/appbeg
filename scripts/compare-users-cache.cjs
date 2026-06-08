#!/usr/bin/env node

const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const ALL_ROLES = ['admin', 'coadmin', 'staff', 'carer', 'player'];

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

function initFirebase() {
  const serviceAccount = JSON.parse(
    Buffer.from(required('FIREBASE_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8')
  );
  return getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
}

function normalizeRole(value) {
  return clean(value).toLowerCase() || 'player';
}

function disabledFlagFromStatus(status) {
  return normalizeRole(status) === 'disabled' ? 'disabled' : 'active';
}

function rowFirestore(doc) {
  const data = doc.data() || {};
  const status = clean(data.status);
  return {
    uid: doc.id,
    username: clean(data.username) || doc.id,
    email: clean(data.email),
    role: normalizeRole(data.role),
    status,
    disabled: disabledFlagFromStatus(status),
    created_by: clean(data.createdBy),
    coadmin_uid: clean(data.coadminUid),
    automation_agent_id: clean(data.automationAgentId),
    active_session_id: clean(data.activeSessionId),
    deleted: data.deleted === true ? 'true' : '',
  };
}

function rowSql(row) {
  const raw =
    row.raw_firestore_data && typeof row.raw_firestore_data === 'object'
      ? row.raw_firestore_data
      : {};
  const status = clean(row.status);
  return {
    uid: clean(row.uid),
    username: clean(row.username),
    email: clean(row.email),
    role: normalizeRole(row.role),
    status,
    disabled: disabledFlagFromStatus(status),
    created_by: clean(row.created_by),
    coadmin_uid: clean(row.coadmin_uid),
    automation_agent_id: clean(raw.automationAgentId),
    active_session_id: clean(raw.activeSessionId),
    deleted: raw.deleted === true ? 'true' : '',
  };
}

function countByRole(rows) {
  const counts = Object.fromEntries(ALL_ROLES.map((role) => [role, 0]));
  counts.other = 0;
  for (const row of rows) {
    const role = normalizeRole(row.role);
    if (counts[role] !== undefined) counts[role] += 1;
    else counts.other += 1;
  }
  return counts;
}

function diffFields(left, right, fields) {
  const out = {};
  for (const field of fields) {
    if ((left[field] || '') !== (right[field] || '')) {
      out[field] = { firebase: left[field] || null, sql: right[field] || null };
    }
  }
  return out;
}

async function main() {
  loadEnvLocal();
  initFirebase();
  const db = getFirestore();
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || required('DATABASE_URL'),
    connectionTimeoutMillis: 10_000,
  });

  const [firestoreSnap, sqlResult] = await Promise.all([
    db.collection('users').get(),
    pg.query('SELECT * FROM public.players_cache WHERE deleted_at IS NULL'),
  ]);

  const firestoreRows = firestoreSnap.docs.map((doc) => rowFirestore(doc));
  const sqlRows = sqlResult.rows.map((row) => rowSql(row));
  const firestoreByUid = new Map(firestoreRows.map((row) => [row.uid, row]));
  const sqlByUid = new Map(sqlRows.map((row) => [row.uid, row]));

  const missingInSql = [];
  const extraInSql = [];
  const roleMismatches = [];
  const coadminUidMismatches = [];
  const statusMismatches = [];
  const disabledMismatches = [];
  const deletedMismatches = [];
  const otherMismatches = [];

  for (const [uid, firestoreRow] of firestoreByUid) {
    const sqlRow = sqlByUid.get(uid);
    if (!sqlRow) {
      missingInSql.push({ uid, role: firestoreRow.role });
      continue;
    }

    const roleDiff = diffFields(firestoreRow, sqlRow, ['role']);
    if (Object.keys(roleDiff).length) {
      roleMismatches.push({ uid, fields: roleDiff });
    }

    const coadminDiff = diffFields(firestoreRow, sqlRow, ['coadmin_uid']);
    if (Object.keys(coadminDiff).length) {
      coadminUidMismatches.push({ uid, fields: coadminDiff });
    }

    const statusDiff = diffFields(firestoreRow, sqlRow, ['status']);
    if (Object.keys(statusDiff).length) {
      statusMismatches.push({ uid, fields: statusDiff });
    }

    const disabledDiff = diffFields(firestoreRow, sqlRow, ['disabled']);
    if (Object.keys(disabledDiff).length) {
      disabledMismatches.push({ uid, fields: disabledDiff });
    }

    const deletedDiff = diffFields(firestoreRow, sqlRow, ['deleted']);
    if (Object.keys(deletedDiff).length) {
      deletedMismatches.push({ uid, fields: deletedDiff });
    }

    const otherDiff = diffFields(firestoreRow, sqlRow, [
      'username',
      'email',
      'created_by',
      'automation_agent_id',
      'active_session_id',
    ]);
    if (Object.keys(otherDiff).length) {
      otherMismatches.push({ uid, fields: otherDiff });
    }
  }

  for (const uid of sqlByUid.keys()) {
    if (!firestoreByUid.has(uid)) {
      extraInSql.push({ uid, role: sqlByUid.get(uid).role });
    }
  }

  await pg.end();

  console.log(
    JSON.stringify(
      {
        collection: 'users',
        firebase_count: firestoreByUid.size,
        postgres_count: sqlByUid.size,
        firebase_count_by_role: countByRole(firestoreRows),
        postgres_count_by_role: countByRole(sqlRows),
        missing_in_sql: missingInSql,
        extra_in_sql: extraInSql,
        role_mismatches: roleMismatches,
        coadmin_uid_mismatches: coadminUidMismatches,
        status_mismatches: statusMismatches,
        disabled_mismatches: disabledMismatches,
        deleted_mismatches: deletedMismatches,
        other_mismatches: otherMismatches,
        summary: {
          missing_in_sql_count: missingInSql.length,
          extra_in_sql_count: extraInSql.length,
          role_mismatch_count: roleMismatches.length,
          coadmin_uid_mismatch_count: coadminUidMismatches.length,
          status_mismatch_count: statusMismatches.length,
          disabled_mismatch_count: disabledMismatches.length,
          deleted_mismatch_count: deletedMismatches.length,
          other_mismatch_count: otherMismatches.length,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[COMPARE_USERS_CACHE] fatal', error);
  process.exitCode = 1;
});
