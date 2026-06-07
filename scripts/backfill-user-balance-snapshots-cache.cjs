const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');

function argValue(name) {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  const hit = index >= 0 ? process.argv[index] : null;
  if (!hit) return null;
  if (hit === name) {
    const next = process.argv[index + 1];
    return next && !next.startsWith('--') ? next : 'true';
  }
  return hit.slice(prefix.length);
}

const DRY_RUN = argValue('--dry-run') !== null;
const ONLY_MISSING = argValue('--only-missing') !== null;
const LIMIT = Number(argValue('--limit') || '0') || 0;

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

function normalizeJson(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeJson(child)]));
  }
  return value;
}

function numOrNull(value) {
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

function normalize(doc) {
  const data = doc.data() || {};
  return {
    firebase_id: doc.id,
    username: clean(data.username),
    email: clean(data.email),
    role: clean(data.role),
    status: clean(data.status),
    coadmin_uid: clean(data.coadminUid),
    created_by: clean(data.createdBy),
    coin: numOrNull(data.coin),
    cash: numOrNull(data.cash),
    cash_box_npr: numOrNull(data.cashBoxNpr),
    promo_locked_coins: numOrNull(data.promoLockedCoins),
    referral_bonus_coins: numOrNull(data.referralBonusCoins),
    redeem_window_24h: numOrNull(data.redeemWindow24h),
    reward_blocked: boolOrNull(data.rewardBlocked),
    bonus_blocked_until: toIso(data.bonusBlockedUntil),
    transfer_blocked_until: toIso(data.transferBlockedUntil),
    created_at: toIso(data.createdAt),
    updated_at: toIso(data.updatedAt),
    raw_firestore_data: normalizeJson(data) || {},
  };
}

async function existingIds(pool) {
  const result = await pool.query(
    'SELECT firebase_id FROM public.user_balance_snapshots_cache WHERE deleted_at IS NULL'
  );
  return new Set(result.rows.map((row) => String(row.firebase_id)));
}

async function upsert(pool, row) {
  await pool.query(
    `
      INSERT INTO public.user_balance_snapshots_cache (
        firebase_id, username, email, role, status, coadmin_uid, created_by,
        coin, cash, cash_box_npr, promo_locked_coins, referral_bonus_coins,
        redeem_window_24h, reward_blocked, bonus_blocked_until,
        transfer_blocked_until, created_at, updated_at, raw_firestore_data,
        source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, $11, $12, $13, $14,
        $15::timestamptz, $16::timestamptz, $17::timestamptz,
        $18::timestamptz, $19::jsonb, 'firebase_backfill', now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        username=EXCLUDED.username,
        email=EXCLUDED.email,
        role=EXCLUDED.role,
        status=EXCLUDED.status,
        coadmin_uid=EXCLUDED.coadmin_uid,
        created_by=EXCLUDED.created_by,
        coin=EXCLUDED.coin,
        cash=EXCLUDED.cash,
        cash_box_npr=EXCLUDED.cash_box_npr,
        promo_locked_coins=EXCLUDED.promo_locked_coins,
        referral_bonus_coins=EXCLUDED.referral_bonus_coins,
        redeem_window_24h=EXCLUDED.redeem_window_24h,
        reward_blocked=EXCLUDED.reward_blocked,
        bonus_blocked_until=EXCLUDED.bonus_blocked_until,
        transfer_blocked_until=EXCLUDED.transfer_blocked_until,
        created_at=COALESCE(public.user_balance_snapshots_cache.created_at, EXCLUDED.created_at),
        updated_at=EXCLUDED.updated_at,
        raw_firestore_data=EXCLUDED.raw_firestore_data,
        source=EXCLUDED.source,
        mirrored_at=now(),
        deleted_at=NULL
    `,
    [
      row.firebase_id, row.username, row.email, row.role, row.status, row.coadmin_uid,
      row.created_by, row.coin, row.cash, row.cash_box_npr, row.promo_locked_coins,
      row.referral_bonus_coins, row.redeem_window_24h, row.reward_blocked,
      row.bonus_blocked_until, row.transfer_blocked_until, row.created_at, row.updated_at,
      JSON.stringify(row.raw_firestore_data),
    ]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  let query = db.collection('users');
  if (LIMIT > 0) query = query.limit(LIMIT);
  const snapshot = await query.get();
  let wouldUpsert = 0;
  let upserted = 0;
  let errors = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    if (!shouldInclude(data)) continue;
    if (ONLY_MISSING && sqlIds.has(doc.id)) continue;
    wouldUpsert += 1;
    if (DRY_RUN) continue;
    try {
      await upsert(pool, normalize(doc));
      upserted += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_USER_BALANCE_SNAPSHOTS_CACHE] failed', {
        firebaseId: doc.id,
        error,
      });
    }
  }

  await pool.end();
  console.log(JSON.stringify({
    collection: 'users',
    firebase_count_seen: snapshot.size,
    would_upsert: wouldUpsert,
    upserted,
    errors,
  }, null, 2));
}

main().catch((error) => {
  console.error('[BACKFILL_USER_BALANCE_SNAPSHOTS_CACHE] fatal', error);
  process.exitCode = 1;
});
