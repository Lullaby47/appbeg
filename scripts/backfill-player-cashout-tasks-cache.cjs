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

function arrayOrNull(value) {
  return Array.isArray(value) ? normalizeJson(value) : null;
}

function normalize(doc) {
  const data = doc.data() || {};
  return {
    firebase_id: doc.id,
    coadmin_uid: clean(data.coadminUid || data.createdBy),
    player_uid: clean(data.playerUid || data.playerId),
    player_username: clean(data.playerUsername || data.username),
    amount_npr: numOrNull(data.amountNpr ?? data.amount),
    payment_details: clean(data.paymentDetails),
    payout_method: clean(data.payoutMethod),
    qr_image_url: clean(data.qrImageUrl),
    payment_app_name: clean(data.paymentAppName),
    payment_app_cash_tag: clean(data.paymentAppCashTag),
    payment_app_account_name: clean(data.paymentAppAccountName),
    cash_deducted_on_request: boolOrNull(data.cashDeductedOnRequest),
    status: clean(data.status),
    assigned_handler_uid: clean(data.assignedHandlerUid),
    assigned_handler_username: clean(data.assignedHandlerUsername),
    cashout_requested_by_staff_id: clean(data.cashoutRequestedByStaffId),
    reward_npr_applied: numOrNull(data.rewardNprApplied),
    reward_blocked_applied: boolOrNull(data.rewardBlockedApplied),
    declined_by_uids: arrayOrNull(data.declinedByUids),
    started_at: toIso(data.startedAt),
    expires_at: toIso(data.expiresAt),
    created_at: toIso(data.createdAt),
    completed_at: toIso(data.completedAt),
    raw_firestore_data: normalizeJson(data) || {},
  };
}

async function existingIds(pool) {
  const result = await pool.query('SELECT firebase_id FROM public.player_cashout_tasks_cache WHERE deleted_at IS NULL');
  return new Set(result.rows.map((row) => String(row.firebase_id)));
}

async function upsert(pool, row) {
  await pool.query(
    `
      INSERT INTO public.player_cashout_tasks_cache (
        firebase_id, coadmin_uid, player_uid, player_username, amount_npr,
        payment_details, payout_method, qr_image_url, payment_app_name,
        payment_app_cash_tag, payment_app_account_name, cash_deducted_on_request,
        status, assigned_handler_uid, assigned_handler_username,
        cashout_requested_by_staff_id, reward_npr_applied,
        reward_blocked_applied, declined_by_uids, started_at, expires_at,
        created_at, completed_at, raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5,
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
        NULLIF($10, ''), NULLIF($11, ''), $12, NULLIF($13, ''),
        NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''), $17,
        $18, $19::jsonb, $20::timestamptz, $21::timestamptz,
        $22::timestamptz, $23::timestamptz, $24::jsonb,
        'firebase_backfill', now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid=EXCLUDED.coadmin_uid,
        player_uid=EXCLUDED.player_uid,
        player_username=EXCLUDED.player_username,
        amount_npr=EXCLUDED.amount_npr,
        payment_details=EXCLUDED.payment_details,
        payout_method=EXCLUDED.payout_method,
        qr_image_url=EXCLUDED.qr_image_url,
        payment_app_name=EXCLUDED.payment_app_name,
        payment_app_cash_tag=EXCLUDED.payment_app_cash_tag,
        payment_app_account_name=EXCLUDED.payment_app_account_name,
        cash_deducted_on_request=EXCLUDED.cash_deducted_on_request,
        status=EXCLUDED.status,
        assigned_handler_uid=EXCLUDED.assigned_handler_uid,
        assigned_handler_username=EXCLUDED.assigned_handler_username,
        cashout_requested_by_staff_id=EXCLUDED.cashout_requested_by_staff_id,
        reward_npr_applied=EXCLUDED.reward_npr_applied,
        reward_blocked_applied=EXCLUDED.reward_blocked_applied,
        declined_by_uids=EXCLUDED.declined_by_uids,
        started_at=EXCLUDED.started_at,
        expires_at=EXCLUDED.expires_at,
        created_at=COALESCE(public.player_cashout_tasks_cache.created_at, EXCLUDED.created_at),
        completed_at=EXCLUDED.completed_at,
        raw_firestore_data=EXCLUDED.raw_firestore_data,
        source=EXCLUDED.source,
        mirrored_at=now(),
        deleted_at=NULL
    `,
    [
      row.firebase_id, row.coadmin_uid, row.player_uid, row.player_username, row.amount_npr,
      row.payment_details, row.payout_method, row.qr_image_url, row.payment_app_name,
      row.payment_app_cash_tag, row.payment_app_account_name, row.cash_deducted_on_request,
      row.status, row.assigned_handler_uid, row.assigned_handler_username,
      row.cashout_requested_by_staff_id, row.reward_npr_applied,
      row.reward_blocked_applied, JSON.stringify(row.declined_by_uids),
      row.started_at, row.expires_at, row.created_at, row.completed_at,
      JSON.stringify(row.raw_firestore_data),
    ]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  let query = db.collection('playerCashoutTasks');
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
      console.error('[BACKFILL_PLAYER_CASHOUT_TASKS_CACHE] failed', { taskId: doc.id, error });
    }
  }

  await pool.end();
  console.log(JSON.stringify({
    collection: 'playerCashoutTasks',
    firebase_count_seen: snapshot.size,
    would_upsert: wouldUpsert,
    upserted,
    errors,
  }, null, 2));
}

main().catch((error) => {
  console.error('[BACKFILL_PLAYER_CASHOUT_TASKS_CACHE] fatal', error);
  process.exitCode = 1;
});
