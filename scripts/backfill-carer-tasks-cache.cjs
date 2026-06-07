#!/usr/bin/env node

const admin = require('firebase-admin');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY_MISSING = args.includes('--only-missing');

function readArgNumber(name) {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return Number(eq.slice(name.length + 1)) || 0;
  const idx = args.indexOf(name);
  if (idx >= 0) return Number(args[idx + 1]) || 0;
  return 0;
}

const LIMIT = readArgNumber('--limit');

function clean(value) {
  return String(value || '').trim();
}

function normalizeGameName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.toMillis === 'function') return new Date(value.toMillis());
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
  }
  return null;
}

function toIso(value) {
  return toDate(value)?.toISOString() || null;
}

function jsonSafe(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function numOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredEnv(name) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function initFirebase() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(
    Buffer.from(requiredEnv('FIREBASE_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

async function upsertRow(pg, doc) {
  const data = doc.data() || {};
  await pg.query(
    `
      INSERT INTO public.carer_tasks_cache (
        firebase_id, coadmin_uid, type, player_uid, player_username, game_name,
        normalized_game_name, amount, request_id, status, assigned_carer_uid,
        assigned_carer_username, assigned_carer, claimed_status, claimed_by_uid,
        claimed_by_username, completed_by_carer_uid, completed_by_carer_username,
        current_username, game_account_username, login_url, game_login_url, lobby_url,
        site_url, base_url, game_credential_username, game_credential_password,
        is_poked, poke_message, automation_status, automation_job_id, linked_job_id,
        current_job_id, active_job_id, assigned_job_status, automation_error, error_message,
        failure_reason, last_failure_reason, retry_pending, fake_redeem, dismiss_type,
        dismissed_by_automation, completion_issue_code, completion_issue, created_at,
        updated_at, started_at, running_at, expires_at, completed_at, cancelled_at,
        failed_at, ttl_expires_at, claimed_at, last_heartbeat_at, automation_updated_at,
        reset_to_pending_at, returned_to_pending_at, pending_since, queued_at,
        deleted_from_pending_at, source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''),
        NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''),
        NULLIF($15, ''), NULLIF($16, ''), NULLIF($17, ''), NULLIF($18, ''),
        NULLIF($19, ''), NULLIF($20, ''), NULLIF($21, ''), NULLIF($22, ''),
        NULLIF($23, ''), NULLIF($24, ''), NULLIF($25, ''), NULLIF($26, ''),
        NULLIF($27, ''), $28, NULLIF($29, ''), NULLIF($30, ''), NULLIF($31, ''),
        NULLIF($32, ''), NULLIF($33, ''), NULLIF($34, ''), NULLIF($35, ''),
        NULLIF($36, ''), NULLIF($37, ''), NULLIF($38, ''), NULLIF($39, ''),
        $40, $41, NULLIF($42, ''), $43, NULLIF($44, ''), NULLIF($45, ''),
        $46::timestamptz, $47::timestamptz, $48::timestamptz, $49::timestamptz,
        $50::timestamptz, $51::timestamptz, $52::timestamptz, $53::timestamptz,
        $54::timestamptz, $55::timestamptz, $56::timestamptz, $57::timestamptz,
        $58::timestamptz, $59::timestamptz, $60::timestamptz, $61::timestamptz,
        $62::timestamptz, 'firebase_backfill', now(), NULL, $63::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        type = EXCLUDED.type,
        player_uid = EXCLUDED.player_uid,
        player_username = EXCLUDED.player_username,
        game_name = EXCLUDED.game_name,
        normalized_game_name = EXCLUDED.normalized_game_name,
        amount = EXCLUDED.amount,
        request_id = EXCLUDED.request_id,
        status = EXCLUDED.status,
        assigned_carer_uid = EXCLUDED.assigned_carer_uid,
        assigned_carer_username = EXCLUDED.assigned_carer_username,
        assigned_carer = EXCLUDED.assigned_carer,
        claimed_status = EXCLUDED.claimed_status,
        claimed_by_uid = EXCLUDED.claimed_by_uid,
        claimed_by_username = EXCLUDED.claimed_by_username,
        completed_by_carer_uid = EXCLUDED.completed_by_carer_uid,
        completed_by_carer_username = EXCLUDED.completed_by_carer_username,
        current_username = EXCLUDED.current_username,
        game_account_username = EXCLUDED.game_account_username,
        login_url = EXCLUDED.login_url,
        game_login_url = EXCLUDED.game_login_url,
        lobby_url = EXCLUDED.lobby_url,
        site_url = EXCLUDED.site_url,
        base_url = EXCLUDED.base_url,
        game_credential_username = EXCLUDED.game_credential_username,
        game_credential_password = EXCLUDED.game_credential_password,
        is_poked = EXCLUDED.is_poked,
        poke_message = EXCLUDED.poke_message,
        automation_status = EXCLUDED.automation_status,
        automation_job_id = EXCLUDED.automation_job_id,
        linked_job_id = EXCLUDED.linked_job_id,
        current_job_id = EXCLUDED.current_job_id,
        active_job_id = EXCLUDED.active_job_id,
        assigned_job_status = EXCLUDED.assigned_job_status,
        automation_error = EXCLUDED.automation_error,
        error_message = EXCLUDED.error_message,
        failure_reason = EXCLUDED.failure_reason,
        last_failure_reason = EXCLUDED.last_failure_reason,
        retry_pending = EXCLUDED.retry_pending,
        fake_redeem = EXCLUDED.fake_redeem,
        dismiss_type = EXCLUDED.dismiss_type,
        dismissed_by_automation = EXCLUDED.dismissed_by_automation,
        completion_issue_code = EXCLUDED.completion_issue_code,
        completion_issue = EXCLUDED.completion_issue,
        created_at = COALESCE(public.carer_tasks_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        started_at = EXCLUDED.started_at,
        running_at = EXCLUDED.running_at,
        expires_at = EXCLUDED.expires_at,
        completed_at = EXCLUDED.completed_at,
        cancelled_at = EXCLUDED.cancelled_at,
        failed_at = EXCLUDED.failed_at,
        ttl_expires_at = EXCLUDED.ttl_expires_at,
        claimed_at = EXCLUDED.claimed_at,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        automation_updated_at = EXCLUDED.automation_updated_at,
        reset_to_pending_at = EXCLUDED.reset_to_pending_at,
        returned_to_pending_at = EXCLUDED.returned_to_pending_at,
        pending_since = EXCLUDED.pending_since,
        queued_at = EXCLUDED.queued_at,
        deleted_from_pending_at = EXCLUDED.deleted_from_pending_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      doc.id,
      clean(data.coadminUid || data.createdBy),
      clean(data.type || data.kind || data.action || data.taskAction),
      clean(data.playerUid || data.playerId),
      clean(data.playerUsername || data.username),
      clean(data.gameName || data.game),
      normalizeGameName(data.gameName || data.game),
      numOrNull(data.amount),
      clean(data.requestId),
      clean(data.status),
      clean(data.assignedCarerUid),
      clean(data.assignedCarerUsername),
      clean(data.assignedCarer),
      clean(data.claimedStatus),
      clean(data.claimedByUid),
      clean(data.claimedByUsername),
      clean(data.completedByCarerUid),
      clean(data.completedByCarerUsername),
      clean(data.currentUsername),
      clean(data.gameAccountUsername),
      clean(data.loginUrl),
      clean(data.gameLoginUrl),
      clean(data.lobbyUrl),
      clean(data.siteUrl),
      clean(data.baseUrl),
      clean(data.gameCredentialUsername),
      clean(data.gameCredentialPassword),
      boolOrNull(data.isPoked),
      clean(data.pokeMessage),
      clean(data.automationStatus),
      clean(data.automationJobId),
      clean(data.linkedJobId),
      clean(data.currentJobId),
      clean(data.activeJobId),
      clean(data.assignedJobStatus),
      clean(data.automationError),
      clean(data.error || data.errorMessage),
      clean(data.failureReason),
      clean(data.lastFailureReason),
      boolOrNull(data.retryPending),
      boolOrNull(data.fakeRedeem),
      clean(data.dismissType),
      boolOrNull(data.dismissedByAutomation),
      clean(data.completionIssueCode),
      clean(data.completionIssue),
      toIso(data.createdAt),
      toIso(data.updatedAt),
      toIso(data.startedAt),
      toIso(data.runningAt),
      toIso(data.expiresAt),
      toIso(data.completedAt),
      toIso(data.cancelledAt),
      toIso(data.failedAt),
      toIso(data.ttlExpiresAt),
      toIso(data.claimedAt),
      toIso(data.lastHeartbeatAt),
      toIso(data.automationUpdatedAt),
      toIso(data.resetToPendingAt),
      toIso(data.returnedToPendingAt),
      toIso(data.pendingSince),
      toIso(data.queuedAt),
      toIso(data.deletedFromPendingAt),
      JSON.stringify(jsonSafe(data) || {}),
    ]
  );
}

async function main() {
  initFirebase();
  const db = admin.firestore();
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || requiredEnv('DATABASE_URL'),
  });

  const existing = ONLY_MISSING
    ? new Set((await pg.query('SELECT firebase_id FROM public.carer_tasks_cache WHERE deleted_at IS NULL')).rows.map((row) => String(row.firebase_id)))
    : new Set();

  let query = db.collection('carerTasks');
  if (LIMIT) query = query.limit(LIMIT);
  console.log('[BACKFILL_CARER_TASKS_CACHE] starting Firestore read', { dryRun: DRY_RUN, limit: LIMIT || null, onlyMissing: ONLY_MISSING });
  const snapshot = await query.get();
  console.log('[BACKFILL_CARER_TASKS_CACHE] Firestore read complete', { count: snapshot.size });

  let firebase_count_seen = 0;
  let would_upsert = 0;
  let upserted = 0;
  let errors = 0;

  for (const doc of snapshot.docs) {
    firebase_count_seen += 1;
    if (firebase_count_seen % 25 === 0) {
      console.log('[BACKFILL_CARER_TASKS_CACHE] progress', { seen: firebase_count_seen, upserted, errors });
    }
    if (existing.has(doc.id)) continue;
    would_upsert += 1;
    if (DRY_RUN) continue;
    try {
      await upsertRow(pg, doc);
      upserted += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_CARER_TASKS_CACHE] failed', { firebaseId: doc.id, error });
    }
  }

  await pg.end();
  console.log(JSON.stringify({ collection: 'carerTasks', firebase_count_seen, would_upsert, upserted, errors }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
