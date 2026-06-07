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

function normalizeGameName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function numOrNull(value) {
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
    player_username: clean(data.playerUsername || data.username),
    coadmin_uid: clean(data.coadminUid || data.createdBy),
    created_by: clean(data.createdBy),
    game_name: clean(data.gameName || data.game),
    normalized_game_name: normalizeGameName(data.gameName || data.game),
    current_username: clean(data.currentUsername),
    game_account_username: clean(data.gameAccountUsername),
    type: clean(data.type || data.requestType),
    status: clean(data.status),
    amount: numOrNull(data.amount),
    base_amount: numOrNull(data.baseAmount),
    bonus_percentage: numOrNull(data.bonusPercentage),
    bonus_event_id: clean(data.bonusEventId),
    first_recharge_match_applied: boolOrNull(data.firstRechargeMatchApplied),
    coin_deducted_on_request: boolOrNull(data.coinDeductedOnRequest),
    coin_refunded_on_dismissal: boolOrNull(data.coinRefundedOnDismissal),
    coin_refunded_on_dismissal_at: toIso(data.coinRefundedOnDismissalAt),
    task_id: clean(data.taskId) || `request__${doc.id}`,
    automation_job_id: clean(data.automationJobId),
    linked_job_id: clean(data.linkedJobId),
    automation_status: clean(data.automationStatus),
    automation_error: clean(data.automationError),
    retry_pending: boolOrNull(data.retryPending),
    retryable_failure: boolOrNull(data.retryableFailure),
    fake_redeem: boolOrNull(data.fakeRedeem),
    fake_redeem_reason: clean(data.fakeRedeemReason),
    dismiss_type: clean(data.dismissType),
    dismissed_by_automation: boolOrNull(data.dismissedByAutomation),
    dismiss_reason_code: clean(data.dismissReasonCode),
    dismiss_reason_message: clean(data.dismissReasonMessage),
    dismiss_reason: clean(data.dismissReason),
    dismiss_meta: objectOrNull(data.dismissMeta),
    error_message: clean(data.error || data.errorMessage),
    failure_reason: clean(data.failureReason),
    last_failure_reason: clean(data.lastFailureReason),
    poke_message: clean(data.pokeMessage),
    created_at: toIso(data.createdAt),
    updated_at: toIso(data.updatedAt),
    completed_at: toIso(data.completedAt),
    poked_at: toIso(data.pokedAt),
    dismissed_at: toIso(data.dismissedAt),
    failed_at: toIso(data.failedAt),
    ttl_expires_at: toIso(data.ttlExpiresAt),
    reset_to_pending_at: toIso(data.resetToPendingAt),
    returned_to_pending_at: toIso(data.returnedToPendingAt),
    pending_since: toIso(data.pendingSince),
    raw_firestore_data: normalizeJson(data) || {},
  };
}

async function existingIds(pool) {
  const result = await pool.query('SELECT firebase_id FROM public.player_game_requests_cache WHERE deleted_at IS NULL');
  return new Set(result.rows.map((row) => String(row.firebase_id)));
}

async function upsert(pool, row) {
  await pool.query(
    `
      INSERT INTO public.player_game_requests_cache (
        firebase_id, player_uid, player_username, coadmin_uid, created_by,
        game_name, normalized_game_name, current_username, game_account_username,
        type, status, amount, base_amount, bonus_percentage, bonus_event_id,
        first_recharge_match_applied, coin_deducted_on_request,
        coin_refunded_on_dismissal, coin_refunded_on_dismissal_at, task_id,
        automation_job_id, linked_job_id, automation_status, automation_error,
        retry_pending, retryable_failure, fake_redeem, fake_redeem_reason,
        dismiss_type, dismissed_by_automation, dismiss_reason_code,
        dismiss_reason_message, dismiss_reason, dismiss_meta, error_message,
        failure_reason, last_failure_reason, poke_message, created_at, updated_at,
        completed_at, poked_at, dismissed_at, failed_at, ttl_expires_at,
        reset_to_pending_at, returned_to_pending_at, pending_since,
        raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
        NULLIF($10, ''), NULLIF($11, ''), $12, $13, $14, NULLIF($15, ''),
        $16, $17, $18, $19::timestamptz, NULLIF($20, ''), NULLIF($21, ''),
        NULLIF($22, ''), NULLIF($23, ''), NULLIF($24, ''), $25, $26, $27,
        NULLIF($28, ''), NULLIF($29, ''), $30, NULLIF($31, ''), NULLIF($32, ''),
        NULLIF($33, ''), $34::jsonb, NULLIF($35, ''), NULLIF($36, ''),
        NULLIF($37, ''), NULLIF($38, ''), $39::timestamptz, $40::timestamptz,
        $41::timestamptz, $42::timestamptz, $43::timestamptz, $44::timestamptz,
        $45::timestamptz, $46::timestamptz, $47::timestamptz, $48::timestamptz,
        $49::jsonb, 'firebase_backfill', now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        player_uid = EXCLUDED.player_uid,
        player_username = EXCLUDED.player_username,
        coadmin_uid = EXCLUDED.coadmin_uid,
        created_by = EXCLUDED.created_by,
        game_name = EXCLUDED.game_name,
        normalized_game_name = EXCLUDED.normalized_game_name,
        current_username = EXCLUDED.current_username,
        game_account_username = EXCLUDED.game_account_username,
        type = EXCLUDED.type,
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        base_amount = EXCLUDED.base_amount,
        bonus_percentage = EXCLUDED.bonus_percentage,
        bonus_event_id = EXCLUDED.bonus_event_id,
        first_recharge_match_applied = EXCLUDED.first_recharge_match_applied,
        coin_deducted_on_request = EXCLUDED.coin_deducted_on_request,
        coin_refunded_on_dismissal = EXCLUDED.coin_refunded_on_dismissal,
        coin_refunded_on_dismissal_at = EXCLUDED.coin_refunded_on_dismissal_at,
        task_id = EXCLUDED.task_id,
        automation_job_id = EXCLUDED.automation_job_id,
        linked_job_id = EXCLUDED.linked_job_id,
        automation_status = EXCLUDED.automation_status,
        automation_error = EXCLUDED.automation_error,
        retry_pending = EXCLUDED.retry_pending,
        retryable_failure = EXCLUDED.retryable_failure,
        fake_redeem = EXCLUDED.fake_redeem,
        fake_redeem_reason = EXCLUDED.fake_redeem_reason,
        dismiss_type = EXCLUDED.dismiss_type,
        dismissed_by_automation = EXCLUDED.dismissed_by_automation,
        dismiss_reason_code = EXCLUDED.dismiss_reason_code,
        dismiss_reason_message = EXCLUDED.dismiss_reason_message,
        dismiss_reason = EXCLUDED.dismiss_reason,
        dismiss_meta = EXCLUDED.dismiss_meta,
        error_message = EXCLUDED.error_message,
        failure_reason = EXCLUDED.failure_reason,
        last_failure_reason = EXCLUDED.last_failure_reason,
        poke_message = EXCLUDED.poke_message,
        created_at = COALESCE(public.player_game_requests_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        completed_at = EXCLUDED.completed_at,
        poked_at = EXCLUDED.poked_at,
        dismissed_at = EXCLUDED.dismissed_at,
        failed_at = EXCLUDED.failed_at,
        ttl_expires_at = EXCLUDED.ttl_expires_at,
        reset_to_pending_at = EXCLUDED.reset_to_pending_at,
        returned_to_pending_at = EXCLUDED.returned_to_pending_at,
        pending_since = EXCLUDED.pending_since,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      row.firebase_id, row.player_uid, row.player_username, row.coadmin_uid, row.created_by,
      row.game_name, row.normalized_game_name, row.current_username, row.game_account_username,
      row.type, row.status, row.amount, row.base_amount, row.bonus_percentage, row.bonus_event_id,
      row.first_recharge_match_applied, row.coin_deducted_on_request,
      row.coin_refunded_on_dismissal, row.coin_refunded_on_dismissal_at, row.task_id,
      row.automation_job_id, row.linked_job_id, row.automation_status, row.automation_error,
      row.retry_pending, row.retryable_failure, row.fake_redeem, row.fake_redeem_reason,
      row.dismiss_type, row.dismissed_by_automation, row.dismiss_reason_code,
      row.dismiss_reason_message, row.dismiss_reason, JSON.stringify(row.dismiss_meta),
      row.error_message, row.failure_reason, row.last_failure_reason, row.poke_message,
      row.created_at, row.updated_at, row.completed_at, row.poked_at, row.dismissed_at,
      row.failed_at, row.ttl_expires_at, row.reset_to_pending_at, row.returned_to_pending_at,
      row.pending_since, JSON.stringify(row.raw_firestore_data),
    ]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  let query = db.collection('playerGameRequests');
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
      console.error('[BACKFILL_PLAYER_GAME_REQUESTS_CACHE] failed', { requestId: doc.id, error });
    }
  }

  await pool.end();
  console.log(JSON.stringify({
    collection: 'playerGameRequests',
    firebase_count_seen: snapshot.size,
    would_upsert: wouldUpsert,
    upserted,
    errors,
  }, null, 2));
}

main().catch((error) => {
  console.error('[BACKFILL_PLAYER_GAME_REQUESTS_CACHE] fatal', error);
  process.exitCode = 1;
});
