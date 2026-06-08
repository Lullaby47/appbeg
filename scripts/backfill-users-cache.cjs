#!/usr/bin/env node

const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const args = new Map(
  process.argv.slice(2).map((arg, index, argv) =>
    arg.startsWith('--')
      ? [
          arg.split('=')[0],
          arg.includes('=')
            ? arg.split('=').slice(1).join('=')
            : argv[index + 1]?.startsWith('--')
              ? 'true'
              : argv[index + 1] || 'true',
        ]
      : [arg, arg]
  )
);

const DRY_RUN = args.has('--dry-run');
const ONLY_MISSING = args.has('--only-missing');
const LIMIT = Number(args.get('--limit') || 0) || 0;
const UID = clean(args.get('--uid'));
const ROLE_FILTER = clean(args.get('--role')).toLowerCase();

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

function createPool() {
  return new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || required('DATABASE_URL'),
    connectionTimeoutMillis: 10_000,
  });
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value.toMillis === 'function') return new Date(value.toMillis()).toISOString();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
  if (typeof value._seconds === 'number') return new Date(value._seconds * 1000).toISOString();
  return null;
}

function normalizeJson(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const asDate = toIso(value);
    if (asDate && (typeof value.toDate === 'function' || typeof value.seconds === 'number')) {
      return asDate;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeJson(child)]));
  }
  return value;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRole(value) {
  const role = clean(value).toLowerCase() || 'player';
  return ALL_ROLES.includes(role) ? role : role;
}

async function existingUidSet(pg) {
  if (!ONLY_MISSING) return new Set();
  const result = await pg.query('SELECT uid FROM public.players_cache WHERE deleted_at IS NULL');
  return new Set(result.rows.map((row) => String(row.uid)));
}

async function upsertUser(pg, doc) {
  const data = doc.data() || {};
  const role = normalizeRole(data.role);
  await pg.query(
    `
      INSERT INTO public.players_cache (
        uid, username, email, role, status, created_by, coadmin_uid, created_by_staff_id,
        coin, cash, promo_locked_coins, referral_code, referred_by_uid, referred_by_code,
        referral_bonus_coins, referral_created_at, referral_reward_status,
        referral_qualified_at, referral_reward_claimed_at, password_updated_at,
        password_updated_by_uid, password_updated_by_role, transferred_by_uid,
        created_at, updated_at, restored_at, raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''),
        $9, $10, $11, NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''), $15, $16::timestamptz,
        NULLIF($17, ''), $18::timestamptz, $19::timestamptz, $20::timestamptz, NULLIF($21, ''),
        NULLIF($22, ''), NULLIF($23, ''), $24::timestamptz, $25::timestamptz, $26::timestamptz,
        $27::jsonb, $28, now(), NULL
      )
      ON CONFLICT (uid) DO UPDATE SET
        username = EXCLUDED.username,
        email = EXCLUDED.email,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        created_by = EXCLUDED.created_by,
        coadmin_uid = EXCLUDED.coadmin_uid,
        created_by_staff_id = EXCLUDED.created_by_staff_id,
        coin = EXCLUDED.coin,
        cash = EXCLUDED.cash,
        promo_locked_coins = EXCLUDED.promo_locked_coins,
        referral_code = EXCLUDED.referral_code,
        referred_by_uid = EXCLUDED.referred_by_uid,
        referred_by_code = EXCLUDED.referred_by_code,
        referral_bonus_coins = EXCLUDED.referral_bonus_coins,
        referral_created_at = EXCLUDED.referral_created_at,
        referral_reward_status = EXCLUDED.referral_reward_status,
        referral_qualified_at = EXCLUDED.referral_qualified_at,
        referral_reward_claimed_at = EXCLUDED.referral_reward_claimed_at,
        password_updated_at = EXCLUDED.password_updated_at,
        password_updated_by_uid = EXCLUDED.password_updated_by_uid,
        password_updated_by_role = EXCLUDED.password_updated_by_role,
        transferred_by_uid = EXCLUDED.transferred_by_uid,
        created_at = COALESCE(public.players_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        restored_at = EXCLUDED.restored_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      doc.id,
      clean(data.username) || doc.id,
      clean(data.email),
      role,
      clean(data.status),
      clean(data.createdBy),
      clean(data.coadminUid),
      clean(data.createdByStaffId),
      numberOrNull(data.coin),
      numberOrNull(data.cash),
      numberOrNull(data.promoLockedCoins),
      clean(data.referralCode),
      clean(data.referredByUid),
      clean(data.referredByCode),
      numberOrNull(data.referralBonusCoins),
      toIso(data.referralCreatedAt),
      clean(data.referralRewardStatus),
      toIso(data.referralQualifiedAt),
      toIso(data.referralRewardClaimedAt),
      toIso(data.passwordUpdatedAt),
      clean(data.passwordUpdatedByUid),
      clean(data.passwordUpdatedByRole),
      clean(data.transferredByUid),
      toIso(data.createdAt),
      toIso(data.updatedAt),
      toIso(data.restoredAt),
      JSON.stringify(normalizeJson(data) || {}),
      'users_backfill',
    ]
  );
}

function countByRole(docs) {
  const counts = Object.fromEntries(ALL_ROLES.map((role) => [role, 0]));
  counts.other = 0;
  for (const doc of docs) {
    const role = normalizeRole((doc.data() || {}).role);
    if (counts[role] !== undefined) counts[role] += 1;
    else counts.other += 1;
  }
  return counts;
}

async function loadFirestoreUsers(db) {
  if (UID) {
    const snap = await db.collection('users').doc(UID).get();
    if (!snap.exists) {
      throw new Error(`users/${UID} not found`);
    }
    return [snap];
  }

  const snap = await db.collection('users').get();
  let docs = snap.docs;
  if (ROLE_FILTER) {
    docs = docs.filter((doc) => normalizeRole((doc.data() || {}).role) === ROLE_FILTER);
  }
  if (LIMIT > 0) {
    docs = docs.slice(0, LIMIT);
  }
  return docs;
}

async function main() {
  loadEnvLocal();
  initFirebase();
  const db = getFirestore();
  const pg = createPool();
  const skip = await existingUidSet(pg);
  const docs = await loadFirestoreUsers(db);

  let wouldUpsert = 0;
  let upserted = 0;
  let skippedExisting = 0;
  let errors = 0;

  for (const doc of docs) {
    if (skip.has(doc.id)) {
      skippedExisting += 1;
      continue;
    }
    wouldUpsert += 1;
    if (DRY_RUN) continue;
    try {
      await upsertUser(pg, doc);
      upserted += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_USERS_CACHE] failed', {
        uid: doc.id,
        role: normalizeRole((doc.data() || {}).role),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        collection: 'users',
        dry_run: DRY_RUN,
        only_missing: ONLY_MISSING,
        role_filter: ROLE_FILTER || null,
        uid_filter: UID || null,
        firebase_count_seen: docs.length,
        firebase_count_by_role: countByRole(docs),
        skipped_existing: skippedExisting,
        would_upsert: wouldUpsert,
        upserted,
        errors,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[BACKFILL_USERS_CACHE] fatal', error);
  process.exitCode = 1;
});
