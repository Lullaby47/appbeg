const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const args = new Map(
  process.argv.slice(2).map((a, i, arr) =>
    a.startsWith('--')
      ? [
          a.split('=')[0],
          a.includes('=')
            ? a.split('=').slice(1).join('=')
            : arr[i + 1]?.startsWith('--')
              ? 'true'
              : arr[i + 1] || 'true',
        ]
      : [a, a]
  )
);
const DRY_RUN = args.has('--dry-run');
const ONLY_MISSING = args.has('--only-missing');
const LIMIT = Number(args.get('--limit') || 0) || 0;
const UID = String(args.get('--uid') || '').trim();

const clean = (v) => String(v || '').trim();
function required(name) {
  const v = clean(process.env[name]);
  if (!v) throw new Error(`${name} is required`);
  return v;
}
function loadEnvLocal() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0 && !process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
}
function app() {
  const svc = JSON.parse(
    Buffer.from(required('FIREBASE_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8')
  );
  return getApps()[0] || initializeApp({ credential: cert(svc) });
}
function pool() {
  return new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || required('DATABASE_URL'),
    connectionTimeoutMillis: 10000,
  });
}
function dt(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v.toMillis === 'function') return new Date(v.toMillis()).toISOString();
  if (typeof v.seconds === 'number') return new Date(v.seconds * 1000).toISOString();
  return null;
}
function json(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(json);
  if (typeof v === 'object') {
    const d = dt(v);
    if (d) return d;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, json(x)]));
  }
  return v;
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

async function missingIds(pg) {
  if (!ONLY_MISSING) return new Set();
  const r = await pg.query('SELECT uid FROM public.players_cache WHERE deleted_at IS NULL');
  return new Set(r.rows.map((x) => String(x.uid)));
}

async function upsert(pg, doc) {
  const d = doc.data() || {};
  await pg.query(
    `
      INSERT INTO public.players_cache (
        uid, username, email, role, status, created_by, coadmin_uid, created_by_staff_id,
        coin, cash, promo_locked_coins, referral_code, referred_by_uid, referred_by_code,
        referral_bonus_coins, referral_created_at, referral_reward_status, referral_qualified_at,
        referral_reward_claimed_at, password_updated_at, password_updated_by_uid,
        password_updated_by_role, transferred_by_uid, created_at, updated_at, restored_at,
        raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1,$2,NULLIF($3,''),$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),
        $9,$10,$11,NULLIF($12,''),NULLIF($13,''),NULLIF($14,''),$15,$16::timestamptz,
        NULLIF($17,''),$18::timestamptz,$19::timestamptz,$20::timestamptz,NULLIF($21,''),
        NULLIF($22,''),NULLIF($23,''),$24::timestamptz,$25::timestamptz,$26::timestamptz,
        $27::jsonb,'carer_profile_backfill',now(),NULL
      )
      ON CONFLICT (uid) DO UPDATE SET
        username = EXCLUDED.username,
        email = EXCLUDED.email,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        created_by = EXCLUDED.created_by,
        coadmin_uid = EXCLUDED.coadmin_uid,
        created_by_staff_id = EXCLUDED.created_by_staff_id,
        updated_at = EXCLUDED.updated_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      doc.id,
      clean(d.username),
      clean(d.email),
      clean(d.role) || 'carer',
      clean(d.status),
      clean(d.createdBy),
      clean(d.coadminUid),
      clean(d.createdByStaffId),
      num(d.coin),
      num(d.cash),
      num(d.promoLockedCoins),
      clean(d.referralCode),
      clean(d.referredByUid),
      clean(d.referredByCode),
      num(d.referralBonusCoins),
      dt(d.referralCreatedAt),
      clean(d.referralRewardStatus),
      dt(d.referralQualifiedAt),
      dt(d.referralRewardClaimedAt),
      dt(d.passwordUpdatedAt),
      clean(d.passwordUpdatedByUid),
      clean(d.passwordUpdatedByRole),
      clean(d.transferredByUid),
      dt(d.createdAt),
      dt(d.updatedAt),
      dt(d.restoredAt),
      JSON.stringify(json(d) || {}),
    ]
  );
}

async function main() {
  loadEnvLocal();
  app();
  const db = getFirestore();
  const pg = pool();
  const skip = await missingIds(pg);
  let docs = [];

  if (UID) {
    const snap = await db.collection('users').doc(UID).get();
    if (!snap.exists) {
      throw new Error(`users/${UID} not found`);
    }
    docs = [snap];
  } else {
    let q = db.collection('users').where('role', '==', 'carer');
    if (LIMIT) q = q.limit(LIMIT);
    const snap = await q.get();
    docs = snap.docs;
  }

  let wouldUpsert = 0;
  let upserted = 0;
  let errors = 0;

  for (const doc of docs) {
    if (skip.has(doc.id)) continue;
    wouldUpsert += 1;
    if (DRY_RUN) continue;
    try {
      await upsert(pg, doc);
      upserted += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_CARER_PROFILES_CACHE] failed', {
        uid: doc.id,
        error,
      });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        collection: 'users',
        role: 'carer',
        firebase_count_seen: docs.length,
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
  console.error('[BACKFILL_CARER_PROFILES_CACHE] fatal', error);
  process.exitCode = 1;
});
