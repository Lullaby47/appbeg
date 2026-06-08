#!/usr/bin/env node

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

function normalizeRole(value) {
  return clean(value).toLowerCase() || 'player';
}

function countByRole(rows, roleField = 'role') {
  const counts = Object.fromEntries(ALL_ROLES.map((role) => [role, 0]));
  counts.other = 0;
  for (const row of rows) {
    const role = normalizeRole(row[roleField]);
    if (counts[role] !== undefined) counts[role] += 1;
    else counts.other += 1;
  }
  return counts;
}

async function tableExists(pg, tableName) {
  const result = await pg.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS table_exists
    `,
    [tableName]
  );
  return result.rows[0]?.table_exists === true;
}

async function main() {
  loadEnvLocal();
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || required('DATABASE_URL'),
    connectionTimeoutMillis: 10_000,
  });

  const credentialsTableExists = await tableExists(pg, 'user_credentials');

  const usersResult = await pg.query(`
    SELECT uid, role, username, status
    FROM public.players_cache
    WHERE deleted_at IS NULL
    ORDER BY role, username
  `);
  const users = usersResult.rows.map((row) => ({
    uid: clean(row.uid),
    role: normalizeRole(row.role),
    username: clean(row.username),
    status: clean(row.status),
  }));

  let credentials = [];
  if (credentialsTableExists) {
    const credentialsResult = await pg.query(`
      SELECT
        c.uid,
        c.password_algo,
        c.password_updated_at,
        c.migrated_from_firebase,
        c.must_reset,
        p.role,
        p.username
      FROM public.user_credentials c
      LEFT JOIN public.players_cache p ON p.uid = c.uid
      WHERE p.deleted_at IS NULL OR p.uid IS NULL
      ORDER BY p.role, p.username
    `);
    credentials = credentialsResult.rows.map((row) => ({
      uid: clean(row.uid),
      role: normalizeRole(row.role),
      username: clean(row.username),
      password_algo: clean(row.password_algo),
      password_updated_at: row.password_updated_at,
      migrated_from_firebase: row.migrated_from_firebase === true,
      must_reset: row.must_reset === true,
    }));
  }

  const credentialUidSet = new Set(credentials.map((row) => row.uid));
  const missingCredentials = users
    .filter((user) => !credentialUidSet.has(user.uid))
    .map((user) => ({
      uid: user.uid,
      role: user.role,
      username: user.username,
      status: user.status,
    }));

  const migratedFromFirebaseCount = credentials.filter((row) => row.migrated_from_firebase).length;

  await pg.end();

  console.log(
    JSON.stringify(
      {
        table_exists: credentialsTableExists,
        users_count: users.length,
        users_count_by_role: countByRole(users),
        credentials_count: credentials.length,
        credentials_count_by_role: countByRole(credentials),
        missing_credentials_count: missingCredentials.length,
        missing_credentials: missingCredentials,
        migrated_from_firebase_count: migratedFromFirebaseCount,
        summary: {
          users_total: users.length,
          credentials_total: credentials.length,
          coverage_percent:
            users.length > 0 ? Number(((credentials.length / users.length) * 100).toFixed(2)) : 0,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[COMPARE_USER_CREDENTIALS] fatal', error);
  process.exitCode = 1;
});
