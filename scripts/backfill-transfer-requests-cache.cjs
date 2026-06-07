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

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalize(doc) {
  const data = doc.data() || {};
  return {
    firebase_id: doc.id,
    player_uid: clean(data.playerUid || data.playerId),
    player_username: clean(data.playerUsername || data.username),
    coadmin_uid: clean(data.coadminUid || data.createdBy),
    amount_npr: numOrNull(data.amountNpr ?? data.amount),
    cash_balance_snapshot: numOrNull(data.cashBalanceSnapshot),
    status: clean(data.status),
    requested_by_uid: clean(data.requestedByUid),
    requested_by_username: clean(data.requestedByUsername),
    requested_at: toIso(data.requestedAt || data.createdAt),
    approved_by_uid: clean(data.approvedByUid),
    approved_by_username: clean(data.approvedByUsername),
    approved_at: toIso(data.approvedAt),
    rejected_by_uid: clean(data.rejectedByUid),
    rejected_by_username: clean(data.rejectedByUsername),
    rejected_at: toIso(data.rejectedAt),
    rejection_reason: clean(data.rejectionReason),
    auto_approved: boolOrNull(data.autoApproved),
    reviewed: boolOrNull(data.reviewed),
    processed_at: toIso(data.processedAt),
    raw_firestore_data: normalizeJson(data) || {},
  };
}

async function existingIds(pool) {
  const result = await pool.query('SELECT firebase_id FROM public.transfer_requests_cache WHERE deleted_at IS NULL');
  return new Set(result.rows.map((row) => String(row.firebase_id)));
}

async function upsert(pool, row) {
  await pool.query(
    `
      INSERT INTO public.transfer_requests_cache (
        firebase_id, player_uid, player_username, coadmin_uid, amount_npr,
        cash_balance_snapshot, status, requested_by_uid, requested_by_username,
        requested_at, approved_by_uid, approved_by_username, approved_at,
        rejected_by_uid, rejected_by_username, rejected_at, rejection_reason,
        auto_approved, reviewed, processed_at, raw_firestore_data,
        source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5,
        $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
        $10::timestamptz, NULLIF($11, ''), NULLIF($12, ''), $13::timestamptz,
        NULLIF($14, ''), NULLIF($15, ''), $16::timestamptz, NULLIF($17, ''),
        $18, $19, $20::timestamptz, $21::jsonb,
        'firebase_backfill', now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        player_uid=EXCLUDED.player_uid,
        player_username=EXCLUDED.player_username,
        coadmin_uid=EXCLUDED.coadmin_uid,
        amount_npr=EXCLUDED.amount_npr,
        cash_balance_snapshot=EXCLUDED.cash_balance_snapshot,
        status=EXCLUDED.status,
        requested_by_uid=EXCLUDED.requested_by_uid,
        requested_by_username=EXCLUDED.requested_by_username,
        requested_at=COALESCE(public.transfer_requests_cache.requested_at, EXCLUDED.requested_at),
        approved_by_uid=EXCLUDED.approved_by_uid,
        approved_by_username=EXCLUDED.approved_by_username,
        approved_at=EXCLUDED.approved_at,
        rejected_by_uid=EXCLUDED.rejected_by_uid,
        rejected_by_username=EXCLUDED.rejected_by_username,
        rejected_at=EXCLUDED.rejected_at,
        rejection_reason=EXCLUDED.rejection_reason,
        auto_approved=EXCLUDED.auto_approved,
        reviewed=EXCLUDED.reviewed,
        processed_at=EXCLUDED.processed_at,
        raw_firestore_data=EXCLUDED.raw_firestore_data,
        source=EXCLUDED.source,
        mirrored_at=now(),
        deleted_at=NULL
    `,
    [
      row.firebase_id, row.player_uid, row.player_username, row.coadmin_uid,
      row.amount_npr, row.cash_balance_snapshot, row.status, row.requested_by_uid,
      row.requested_by_username, row.requested_at, row.approved_by_uid,
      row.approved_by_username, row.approved_at, row.rejected_by_uid,
      row.rejected_by_username, row.rejected_at, row.rejection_reason,
      row.auto_approved, row.reviewed, row.processed_at,
      JSON.stringify(row.raw_firestore_data),
    ]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  let query = db.collection('transferRequests');
  if (LIMIT > 0) query = query.limit(LIMIT);
  const snapshot = await query.get();
  let wouldUpsert = 0;
  let upserted = 0;
  let errors = 0;

  for (const doc of snapshot.docs) {
    if (ONLY_MISSING && sqlIds.has(doc.id)) continue;
    wouldUpsert += 1;
    if (DRY_RUN) continue;
    try {
      await upsert(pool, normalize(doc));
      upserted += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_TRANSFER_REQUESTS_CACHE] failed', { requestId: doc.id, error });
    }
  }

  await pool.end();
  console.log(JSON.stringify({
    collection: 'transferRequests',
    firebase_count_seen: snapshot.size,
    would_upsert: wouldUpsert,
    upserted,
    errors,
  }, null, 2));
}

main().catch((error) => {
  console.error('[BACKFILL_TRANSFER_REQUESTS_CACHE] fatal', error);
  process.exitCode = 1;
});
