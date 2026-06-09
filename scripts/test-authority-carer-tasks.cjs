/**
 * SQL authority carer task / automation job harness.
 *
 * Usage:
 *   TEST_TASK_ID=... TEST_CARER_UID=... TEST_CARER_B_UID=... node scripts/test-authority-carer-tasks.cjs
 */
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const clean = (v) => String(v || '').trim();
function req(n) {
  const v = clean(process.env[n]);
  if (!v) throw new Error(`${n} is required`);
  return v;
}

async function withClient(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function claimOp(client, operationKey, operationType, userUid, sourceId) {
  const result = await client.query(
    `
      INSERT INTO public.authority_operations (operation_key, operation_type, user_uid, source_id, payload)
      VALUES ($1, $2, $3, $4, '{}'::jsonb)
      ON CONFLICT (operation_key) DO NOTHING
      RETURNING operation_key
    `,
    [operationKey, operationType, userUid, sourceId]
  );
  return (result.rowCount || 0) > 0;
}

async function lockTask(client, taskId, holdMs = 120) {
  await client.query('BEGIN');
  const result = await client.query(
    `
      SELECT firebase_id, status, assigned_carer_uid
      FROM public.carer_tasks_cache
      WHERE firebase_id = $1 AND deleted_at IS NULL
      FOR UPDATE
    `,
    [taskId]
  );
  if (!result.rows.length) {
    await client.query('ROLLBACK');
    return { locked: false, reason: 'task_not_found' };
  }
  await new Promise((r) => setTimeout(r, holdMs));
  await client.query('ROLLBACK');
  return { locked: true, row: result.rows[0] };
}

async function trySkipLockedClaim(client, taskId) {
  const result = await client.query(
    `
      SELECT firebase_id, status, assigned_carer_uid
      FROM public.carer_tasks_cache
      WHERE firebase_id = $1 AND deleted_at IS NULL
      FOR UPDATE SKIP LOCKED
    `,
    [taskId]
  );
  return (result.rowCount || 0) > 0;
}

async function testClaimIdempotency(pool, taskId, carerUid) {
  const operationKey = `task_claim:${taskId}:${carerUid}`;
  const results = await Promise.all([
    withClient(pool, (c) => claimOp(c, operationKey, 'task_claim', carerUid, taskId)),
    withClient(pool, (c) => claimOp(c, operationKey, 'task_claim', carerUid, taskId)),
  ]);
  return {
    test: 'claim_idempotency_same_carer',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testClaimRaceDifferentCarers(pool, taskId, carerA, carerB) {
  const keyA = `task_claim:${taskId}:${carerA}`;
  const keyB = `task_claim:${taskId}:${carerB}`;
  const results = await Promise.all([
    withClient(pool, (c) => claimOp(c, keyA, 'task_claim', carerA, taskId)),
    withClient(pool, (c) => claimOp(c, keyB, 'task_claim', carerB, taskId)),
  ]);
  return {
    test: 'claim_race_different_carers_operation_keys',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 2,
    note: 'Distinct idempotency keys allow both ops; task row FOR UPDATE serializes writes in authority layer',
  };
}

async function testReturnIdempotency(pool, taskId, actorUid) {
  const operationKey = `task_return:${taskId}:${taskId}`;
  const results = await Promise.all([
    withClient(pool, (c) => claimOp(c, operationKey, 'task_return', actorUid, taskId)),
    withClient(pool, (c) => claimOp(c, operationKey, 'task_return', actorUid, taskId)),
  ]);
  return {
    test: 'return_twice_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testCompleteIdempotency(pool, batchKey, actorUid) {
  const operationKey = `task_complete:${batchKey}:${actorUid}`;
  const results = await Promise.all([
    withClient(pool, (c) => claimOp(c, operationKey, 'task_complete_username', actorUid, batchKey)),
    withClient(pool, (c) => claimOp(c, operationKey, 'task_complete_username', actorUid, batchKey)),
  ]);
  return {
    test: 'complete_twice_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testDeleteIdempotency(pool, taskId, actorUid) {
  const operationKey = `task_delete:${taskId}:${taskId}`;
  const results = await Promise.all([
    withClient(pool, (c) => claimOp(c, operationKey, 'task_delete', actorUid, taskId)),
    withClient(pool, (c) => claimOp(c, operationKey, 'task_delete', actorUid, taskId)),
  ]);
  return {
    test: 'delete_twice_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testForUpdateRace(pool, taskId) {
  const [a, b] = await Promise.all([
    withClient(pool, (c) => lockTask(c, taskId, 180)),
    (async () => {
      await new Promise((r) => setTimeout(r, 40));
      return withClient(pool, (c) => trySkipLockedClaim(c, taskId));
    })(),
  ]);
  return {
    test: 'for_update_skip_locked_race',
    holder: a.locked,
    skipLockedHit: Boolean(b),
    ok: a.locked === true,
  };
}

async function testTaskJobConsistency(pool, taskId) {
  const taskResult = await pool.query(
    `
      SELECT firebase_id, status, automation_job_id, assigned_carer_uid, source
      FROM public.carer_tasks_cache
      WHERE firebase_id = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [taskId]
  );
  if (!taskResult.rows.length) {
    return { test: 'task_job_outbox_consistency', ok: true, skipped: true, reason: 'task_not_found' };
  }
  const task = taskResult.rows[0];
  const jobId = clean(task.automation_job_id);
  if (!jobId) {
    return { test: 'task_job_outbox_consistency', ok: true, note: 'no_linked_job' };
  }
  const jobResult = await pool.query(
    `
      SELECT job_id, task_id, status, carer_uid, source
      FROM public.automation_jobs_cache
      WHERE job_id = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [jobId]
  );
  const job = jobResult.rows[0];
  const outbox = await pool.query(
    `
      SELECT channel, event_type, entity_id
      FROM public.live_outbox
      WHERE entity_id IN ($1, $2) AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 20
    `,
    [taskId, jobId]
  );
  return {
    test: 'task_job_outbox_consistency',
    task_status: clean(task.status),
    job_status: clean(job?.status),
    job_task_id_matches: clean(job?.task_id) === taskId,
    outbox_events: outbox.rows.length,
    ok: Boolean(job) && clean(job.task_id) === taskId,
  };
}

async function main() {
  const pool = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const taskId = clean(process.env.TEST_TASK_ID) || `test_task_${randomUUID()}`;
  const carerUid = clean(process.env.TEST_CARER_UID) || `test_carer_${randomUUID()}`;
  const carerBUid = clean(process.env.TEST_CARER_B_UID) || `test_carer_b_${randomUUID()}`;
  const batchKey = clean(process.env.TEST_COMPLETE_BATCH_KEY) || `username:test:${randomUUID()}`;

  const results = await Promise.all([
    testClaimIdempotency(pool, taskId, carerUid),
    testClaimRaceDifferentCarers(pool, taskId, carerUid, carerBUid),
    testReturnIdempotency(pool, taskId, carerUid),
    testCompleteIdempotency(pool, batchKey, carerUid),
    testDeleteIdempotency(pool, taskId, carerUid),
    testForUpdateRace(pool, taskId),
    testTaskJobConsistency(pool, taskId),
  ]);

  const failed = results.filter((r) => r.ok === false);
  console.log(JSON.stringify({ script: 'test-authority-carer-tasks', results, failed: failed.length }, null, 2));
  await pool.end();
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
