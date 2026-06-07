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

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? normalizeJson(value) : null;
}

function normalize(doc) {
  const data = doc.data() || {};
  return {
    firebase_id: doc.id,
    player_uid: clean(data.playerUid || data.playerId),
    player_id: clean(data.playerId),
    coadmin_uid: clean(data.coadminUid || data.createdBy),
    actor_uid: clean(data.actorUid || data.createdByUid || data.adminUid || data.staffUid),
    actor_username: clean(data.actorUsername || data.createdByUsername),
    actor_role: clean(data.actorRole || data.createdByRole),
    related_user_uid: clean(data.relatedUserUid || data.targetUid || data.userUid),
    related_user_role: clean(data.relatedUserRole || data.targetRole || data.userRole),
    type: clean(data.type || data.eventType),
    amount: numOrNull(data.amount ?? data.transferAmount),
    amount_npr: numOrNull(data.amountNpr ?? data.nprAmount ?? data.transferAmount),
    amount_coins: numOrNull(data.amountCoins ?? data.coinsAmount),
    currency: clean(data.currency),
    unit: clean(data.unit),
    request_id: clean(data.requestId || data.playerGameRequestId),
    cashout_task_id: clean(data.cashoutTaskId || data.playerCashoutTaskId),
    transfer_request_id: clean(data.transferRequestId),
    task_id: clean(data.taskId || data.carerTaskId),
    automation_job_id: clean(data.automationJobId || data.jobId),
    bonus_event_id: clean(data.bonusEventId),
    gift_id: clean(data.giftId || data.freeplayGiftId),
    transfer_id: clean(data.transferId),
    fee_amount: numOrNull(data.feeAmount ?? data.feeNpr),
    tip_amount: numOrNull(data.tipAmount ?? data.tipNpr),
    cash_received: numOrNull(data.cashReceived),
    coins_received: numOrNull(data.coinsReceived),
    before_cash: numOrNull(data.beforeCash),
    after_cash: numOrNull(data.afterCash),
    before_coin: numOrNull(data.beforeCoin ?? data.beforeCoins),
    after_coin: numOrNull(data.afterCoin ?? data.afterCoins),
    before_balances: objectOrNull(data.beforeBalances),
    after_balances: objectOrNull(data.afterBalances),
    reason: clean(data.reason || data.reasonCode),
    notes: clean(data.notes || data.note),
    meta: objectOrNull(data.meta || data.metadata),
    created_at: toIso(data.createdAt || data.timestamp),
    updated_at: toIso(data.updatedAt),
    ttl_expires_at: toIso(data.ttlExpiresAt),
    raw_firestore_data: normalizeJson(data) || {},
  };
}

async function existingIds(pool) {
  const result = await pool.query('SELECT firebase_id FROM public.financial_events_cache WHERE deleted_at IS NULL');
  return new Set(result.rows.map((row) => String(row.firebase_id)));
}

async function upsert(pool, row) {
  await pool.query(
    `
      INSERT INTO public.financial_events_cache (
        firebase_id, player_uid, player_id, coadmin_uid, actor_uid,
        actor_username, actor_role, related_user_uid, related_user_role, type,
        amount, amount_npr, amount_coins, currency, unit, request_id,
        cashout_task_id, transfer_request_id, task_id, automation_job_id,
        bonus_event_id, gift_id, transfer_id, fee_amount, tip_amount,
        cash_received, coins_received, before_cash, after_cash, before_coin,
        after_coin, before_balances, after_balances, reason, notes, meta,
        created_at, updated_at, ttl_expires_at, raw_firestore_data,
        source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''),
        $11, $12, $13, NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''),
        NULLIF($17, ''), NULLIF($18, ''), NULLIF($19, ''), NULLIF($20, ''),
        NULLIF($21, ''), NULLIF($22, ''), NULLIF($23, ''), $24, $25,
        $26, $27, $28, $29, $30,
        $31, $32::jsonb, $33::jsonb, NULLIF($34, ''), NULLIF($35, ''), $36::jsonb,
        $37::timestamptz, $38::timestamptz, $39::timestamptz, $40::jsonb,
        'firebase_backfill', now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        player_uid=EXCLUDED.player_uid,
        player_id=EXCLUDED.player_id,
        coadmin_uid=EXCLUDED.coadmin_uid,
        actor_uid=EXCLUDED.actor_uid,
        actor_username=EXCLUDED.actor_username,
        actor_role=EXCLUDED.actor_role,
        related_user_uid=EXCLUDED.related_user_uid,
        related_user_role=EXCLUDED.related_user_role,
        type=EXCLUDED.type,
        amount=EXCLUDED.amount,
        amount_npr=EXCLUDED.amount_npr,
        amount_coins=EXCLUDED.amount_coins,
        currency=EXCLUDED.currency,
        unit=EXCLUDED.unit,
        request_id=EXCLUDED.request_id,
        cashout_task_id=EXCLUDED.cashout_task_id,
        transfer_request_id=EXCLUDED.transfer_request_id,
        task_id=EXCLUDED.task_id,
        automation_job_id=EXCLUDED.automation_job_id,
        bonus_event_id=EXCLUDED.bonus_event_id,
        gift_id=EXCLUDED.gift_id,
        transfer_id=EXCLUDED.transfer_id,
        fee_amount=EXCLUDED.fee_amount,
        tip_amount=EXCLUDED.tip_amount,
        cash_received=EXCLUDED.cash_received,
        coins_received=EXCLUDED.coins_received,
        before_cash=EXCLUDED.before_cash,
        after_cash=EXCLUDED.after_cash,
        before_coin=EXCLUDED.before_coin,
        after_coin=EXCLUDED.after_coin,
        before_balances=EXCLUDED.before_balances,
        after_balances=EXCLUDED.after_balances,
        reason=EXCLUDED.reason,
        notes=EXCLUDED.notes,
        meta=EXCLUDED.meta,
        created_at=COALESCE(public.financial_events_cache.created_at, EXCLUDED.created_at),
        updated_at=EXCLUDED.updated_at,
        ttl_expires_at=EXCLUDED.ttl_expires_at,
        raw_firestore_data=EXCLUDED.raw_firestore_data,
        source=EXCLUDED.source,
        mirrored_at=now(),
        deleted_at=NULL
    `,
    [
      row.firebase_id, row.player_uid, row.player_id, row.coadmin_uid, row.actor_uid,
      row.actor_username, row.actor_role, row.related_user_uid, row.related_user_role, row.type,
      row.amount, row.amount_npr, row.amount_coins, row.currency, row.unit, row.request_id,
      row.cashout_task_id, row.transfer_request_id, row.task_id, row.automation_job_id,
      row.bonus_event_id, row.gift_id, row.transfer_id, row.fee_amount, row.tip_amount,
      row.cash_received, row.coins_received, row.before_cash, row.after_cash, row.before_coin,
      row.after_coin, JSON.stringify(row.before_balances), JSON.stringify(row.after_balances),
      row.reason, row.notes, JSON.stringify(row.meta), row.created_at, row.updated_at,
      row.ttl_expires_at, JSON.stringify(row.raw_firestore_data),
    ]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  let query = db.collection('financialEvents');
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
      console.error('[BACKFILL_FINANCIAL_EVENTS_CACHE] failed', { firebaseId: doc.id, error });
    }
  }

  await pool.end();
  console.log(JSON.stringify({
    collection: 'financialEvents',
    firebase_count_seen: snapshot.size,
    would_upsert: wouldUpsert,
    upserted,
    errors,
  }, null, 2));
}

main().catch((error) => {
  console.error('[BACKFILL_FINANCIAL_EVENTS_CACHE] fatal', error);
  process.exitCode = 1;
});
