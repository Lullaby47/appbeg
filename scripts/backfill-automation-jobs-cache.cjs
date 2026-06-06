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
const SINCE = argValue('--since');

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
  if (connectionString) {
    return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  }
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

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function intOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function normalize(doc) {
  const data = doc.data() || {};
  const payload = object(data.payload);
  const originalTask = object(payload.originalTask);
  const type = clean(data.type || data.taskType || payload.type || originalTask.type);
  const game = clean(data.game || data.gameName || payload.game || payload.gameName || originalTask.gameName || originalTask.game);
  return {
    job_id: doc.id,
    task_id: clean(data.taskId || payload.taskId || originalTask.id),
    linked_task_id: clean(data.linkedTaskId || payload.linkedTaskId),
    coadmin_uid: clean(data.coadminUid || payload.coadminUid || originalTask.coadminUid),
    carer_uid: clean(data.carerUid || data.createdByUid),
    player_uid: clean(data.playerUid || payload.playerUid || originalTask.playerUid),
    agent_id: clean(data.agentId),
    created_by_uid: clean(data.createdByUid || data.carerUid),
    created_by_name: clean(data.createdByName || data.carerName || data.assignedCarerUsername),
    game_id: clean(data.gameId || payload.gameId || originalTask.gameId),
    game,
    type,
    request_type: clean(data.requestType || payload.requestType || payload.type || type),
    status: clean(data.status),
    claimed_status: clean(data.claimedStatus),
    payload: normalizeJson(data.payload),
    result: normalizeJson(data.result),
    error_message: clean(data.error || data.errorMessage),
    cancelled_reason: clean(data.cancelledReason),
    needs_manual_review: boolOrNull(data.needsManualReview),
    partial_success: boolOrNull(data.partial_success || data.partialSuccess),
    attempts: intOrNull(data.attempts),
    created_at: toIso(data.createdAt),
    updated_at: toIso(data.updatedAt),
    started_at: toIso(data.startedAt),
    completed_at: toIso(data.completedAt),
    failed_at: toIso(data.failedAt),
    last_heartbeat_at: toIso(data.lastHeartbeatAt),
    ttl_expires_at: toIso(data.ttlExpiresAt),
    raw_firestore_data: normalizeJson(data) || {},
  };
}

async function existingIds(pool) {
  const result = await pool.query('SELECT job_id FROM public.automation_jobs_cache WHERE deleted_at IS NULL');
  return new Set(result.rows.map((row) => String(row.job_id)));
}

async function upsert(pool, row) {
  await pool.query(
    `
      INSERT INTO public.automation_jobs_cache (
        job_id, task_id, linked_task_id, coadmin_uid, carer_uid, player_uid, agent_id,
        created_by_uid, created_by_name, game_id, game, type, request_type, status,
        claimed_status, payload, result, error_message, cancelled_reason,
        needs_manual_review, partial_success, attempts, created_at, updated_at,
        started_at, completed_at, failed_at, last_heartbeat_at, ttl_expires_at,
        raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
        NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''),
        NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''), NULLIF($15, ''), $16::jsonb,
        $17::jsonb, NULLIF($18, ''), NULLIF($19, ''), $20, $21, $22,
        $23::timestamptz, $24::timestamptz, $25::timestamptz, $26::timestamptz,
        $27::timestamptz, $28::timestamptz, $29::timestamptz, $30::jsonb,
        'firebase_backfill', now(), NULL
      )
      ON CONFLICT (job_id) DO UPDATE SET
        task_id = EXCLUDED.task_id,
        linked_task_id = EXCLUDED.linked_task_id,
        coadmin_uid = EXCLUDED.coadmin_uid,
        carer_uid = EXCLUDED.carer_uid,
        player_uid = EXCLUDED.player_uid,
        agent_id = EXCLUDED.agent_id,
        created_by_uid = EXCLUDED.created_by_uid,
        created_by_name = EXCLUDED.created_by_name,
        game_id = EXCLUDED.game_id,
        game = EXCLUDED.game,
        type = EXCLUDED.type,
        request_type = EXCLUDED.request_type,
        status = EXCLUDED.status,
        claimed_status = EXCLUDED.claimed_status,
        payload = EXCLUDED.payload,
        result = EXCLUDED.result,
        error_message = EXCLUDED.error_message,
        cancelled_reason = EXCLUDED.cancelled_reason,
        needs_manual_review = EXCLUDED.needs_manual_review,
        partial_success = EXCLUDED.partial_success,
        attempts = EXCLUDED.attempts,
        created_at = COALESCE(public.automation_jobs_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        failed_at = EXCLUDED.failed_at,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        ttl_expires_at = EXCLUDED.ttl_expires_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      row.job_id, row.task_id, row.linked_task_id, row.coadmin_uid, row.carer_uid, row.player_uid,
      row.agent_id, row.created_by_uid, row.created_by_name, row.game_id, row.game, row.type,
      row.request_type, row.status, row.claimed_status, JSON.stringify(row.payload),
      JSON.stringify(row.result), row.error_message, row.cancelled_reason, row.needs_manual_review,
      row.partial_success, row.attempts, row.created_at, row.updated_at, row.started_at,
      row.completed_at, row.failed_at, row.last_heartbeat_at, row.ttl_expires_at,
      JSON.stringify(row.raw_firestore_data),
    ]
  );
}

async function main() {
  const startedAt = Date.now();
  console.log('[BACKFILL_AUTOMATION_JOBS_CACHE] starting', {
    dryRun: DRY_RUN,
    onlyMissing: ONLY_MISSING,
    limit: LIMIT || null,
    since: SINCE || null,
  });
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const sqlIds = ONLY_MISSING ? await existingIds(pool) : new Set();
  let query = db.collection('automation_jobs');
  if (SINCE) {
    const sinceDate = new Date(SINCE);
    if (Number.isNaN(sinceDate.getTime())) throw new Error('--since must be a valid date');
    query = query.where('updatedAt', '>=', sinceDate);
  }
  if (LIMIT > 0) query = query.limit(LIMIT);
  console.log('[BACKFILL_AUTOMATION_JOBS_CACHE] starting firestore read', {
    limit: LIMIT || null,
    since: SINCE || null,
  });
  const snapshot = await query.get();
  console.log('[BACKFILL_AUTOMATION_JOBS_CACHE] firestore read complete', {
    firebaseCountSeen: snapshot.size,
  });
  console.log('[BACKFILL_AUTOMATION_JOBS_CACHE] starting postgres upsert', {
    dryRun: DRY_RUN,
    onlyMissing: ONLY_MISSING,
  });
  let wouldUpsert = 0;
  let upserted = 0;
  let skippedExisting = 0;
  let errors = 0;
  let processed = 0;

  for (const doc of snapshot.docs) {
    processed += 1;
    if (ONLY_MISSING && sqlIds.has(doc.id)) {
      skippedExisting += 1;
      if (processed % 25 === 0 || processed === snapshot.docs.length) {
        console.log('[BACKFILL_AUTOMATION_JOBS_CACHE] progress', {
          processed,
          total: snapshot.docs.length,
          wouldUpsert,
          upserted,
          skippedExisting,
          errors,
        });
      }
      continue;
    }
    wouldUpsert += 1;
    if (!DRY_RUN) {
      try {
        await upsert(pool, normalize(doc));
        upserted += 1;
      } catch (error) {
        errors += 1;
        console.error('[BACKFILL_AUTOMATION_JOBS_CACHE] failed', { jobId: doc.id, error });
      }
    }
    if (processed % 25 === 0 || processed === snapshot.docs.length) {
      console.log('[BACKFILL_AUTOMATION_JOBS_CACHE] progress', {
        processed,
        total: snapshot.docs.length,
        wouldUpsert,
        upserted,
        skippedExisting,
        errors,
      });
    }
  }

  await pool.end();
  console.log('[BACKFILL_AUTOMATION_JOBS_CACHE] finished', {
    durationMs: Date.now() - startedAt,
    processed,
    wouldUpsert,
    upserted,
    skippedExisting,
    errors,
  });
  console.log(JSON.stringify({
    collection: 'automation_jobs',
    dry_run: DRY_RUN,
    only_missing: ONLY_MISSING,
    limit: LIMIT || null,
    since: SINCE || null,
    firebase_count_seen: snapshot.size,
    would_upsert: wouldUpsert,
    upserted,
    skipped_existing: skippedExisting,
    errors,
  }, null, 2));
}

main().catch((error) => {
  console.error('[BACKFILL_AUTOMATION_JOBS_CACHE] fatal', error);
  process.exitCode = 1;
});
