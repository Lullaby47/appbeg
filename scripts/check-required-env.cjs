/**
 * Verify required AppBeg SQL-runtime environment variables.
 *
 * Loads (first wins for duplicates): .env.local, .env
 * For Vercel: run `vercel env pull .env.local` before this script.
 *
 * Usage:
 *   npm run check:env
 *   FAIL_ON_OPTIONAL=1 npm run check:env
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const REQUIRED_SERVER = [
  'APPBEG_SQL_ONLY_MODE',
  'ALLOW_FIREBASE_FALLBACK',
  'AUTHORITY_SQL_WRITE',
  'AUTH_SQL_READ',
  'APP_SESSION_SQL_READ',
  'PLAYER_SESSION_SQL_READ',
  'DATABASE_URL',
  'CARER_AUTOMATION_TICK_SECRET',
];

const REQUIRED_PUBLIC_SQL = [
  'NEXT_PUBLIC_SQL_LOGIN_FIRST',
  'NEXT_PUBLIC_SQL_PLAYER_LOGIN',
  'NEXT_PUBLIC_AUTOMATION_JOBS_SQL_READ',
  'NEXT_PUBLIC_CARER_TASKS_SQL_READ',
  'NEXT_PUBLIC_PLAYER_REQUESTS_SQL_READ',
];

const OPTIONAL_SERVER = [
  'CARER_AUTOMATION_BROWSER_TICK_TOKEN_SECRET',
  'FIREBASE_SERVICE_ACCOUNT_BASE64',
  'USERNAME_REGISTRY_API_URL',
  'USERNAME_REGISTRY_SECRET',
];

const OPTIONAL_PUBLIC = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
  'NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME',
  'NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET',
];

/** Documented elsewhere but not referenced in current code — reported as unused. */
const UNUSED_LEGACY_PUBLIC = [
  'NEXT_PUBLIC_SQL_CHAT_READ',
  'NEXT_PUBLIC_SQL_PRESENCE_READ',
  'NEXT_PUBLIC_SQL_BONUS_EVENTS_READ',
  'NEXT_PUBLIC_SQL_CARER_CASHOUTS_READ',
  'NEXT_PUBLIC_SQL_GAME_LOGINS_READ',
  'NEXT_PUBLIC_SQL_USERS_READ',
  'NEXT_PUBLIC_PLAYER_GAME_LOGINS_SQL_READ',
  'NEXT_PUBLIC_CASHOUT_TASKS_SQL_READ',
];

const SECRET_KEYS = new Set([
  'DATABASE_URL',
  'CARER_AUTOMATION_TICK_SECRET',
  'CARER_AUTOMATION_BROWSER_TICK_TOKEN_SECRET',
  'FIREBASE_SERVICE_ACCOUNT_BASE64',
  'USERNAME_REGISTRY_SECRET',
]);

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadMergedEnv() {
  const merged = {};
  for (const name of ['.env', '.env.local']) {
    Object.assign(merged, parseEnvFile(path.join(ROOT, name)));
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

function isTruthyOne(value) {
  const raw = String(value || '').trim();
  return raw === '1' || raw.toLowerCase() === 'true';
}

function prefixFor(key, env) {
  const value = String(env[key] || '').trim();
  if (!value) return null;
  return SECRET_KEYS.has(key) ? value.slice(0, 4) : value;
}

const MUST_BE_ONE = new Set([
  'APPBEG_SQL_ONLY_MODE',
  'AUTHORITY_SQL_WRITE',
  'AUTH_SQL_READ',
  'APP_SESSION_SQL_READ',
  'PLAYER_SESSION_SQL_READ',
  ...REQUIRED_PUBLIC_SQL,
]);

function checkRequired(keys, env, label) {
  const missing = [];
  const wrong = [];
  for (const key of keys) {
    const value = String(env[key] || '').trim();
    if (!value) {
      missing.push(key);
      continue;
    }
    if (MUST_BE_ONE.has(key) && !isTruthyOne(value)) {
      wrong.push(`${key}=${value} (expected 1)`);
    }
    if (key === 'ALLOW_FIREBASE_FALLBACK' && value !== '0') {
      wrong.push(`${key}=${value} (expected 0 for SQL-only)`);
    }
  }
  return { label, missing, wrong };
}

function main() {
  const env = loadMergedEnv();
  const checks = [
    checkRequired(REQUIRED_SERVER, env, 'server'),
    checkRequired(REQUIRED_PUBLIC_SQL, env, 'public_sql'),
  ];

  const missingAll = [];
  const wrongAll = [];
  for (const check of checks) {
    missingAll.push(...check.missing);
    wrongAll.push(...check.wrong);
  }

  console.info('[ENV_CHECK] root=%s', ROOT);
  for (const key of REQUIRED_SERVER) {
    if (SECRET_KEYS.has(key)) {
      const prefix = prefixFor(key, env);
      console.info('[ENV_CHECK] %s prefix=%s', key, prefix || '(missing)');
    } else {
      console.info('[ENV_CHECK] %s=%s', key, env[key] || '(missing)');
    }
  }
  for (const key of REQUIRED_PUBLIC_SQL) {
    console.info('[ENV_CHECK] %s=%s', key, env[key] || '(missing)');
  }

  const optionalMissing = [...OPTIONAL_SERVER, ...OPTIONAL_PUBLIC].filter((k) => !String(env[k] || '').trim());
  if (optionalMissing.length) {
    console.info('[ENV_CHECK] optional_missing=%s', optionalMissing.join(','));
  }

  const setUnused = UNUSED_LEGACY_PUBLIC.filter((k) => String(env[k] || '').trim());
  if (setUnused.length) {
    console.info('[ENV_CHECK] unused_legacy_public_set=%s', setUnused.join(','));
  }
  console.info('[ENV_CHECK] unused_legacy_public_names=%s', UNUSED_LEGACY_PUBLIC.join(','));

  if (missingAll.length) {
    console.error('[ENV_CHECK_FAILED] missing=%s', missingAll.join(','));
  }
  if (wrongAll.length) {
    console.error('[ENV_CHECK_FAILED] invalid=%s', wrongAll.join('; '));
  }

  if (missingAll.length || wrongAll.length) {
    process.exit(1);
  }

  console.info('[ENV_CHECK_OK] required server and public SQL env keys present');
}

main();
