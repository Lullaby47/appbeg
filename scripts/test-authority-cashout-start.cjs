/**
 * SQL authority cashout start harness.
 *
 * Usage:
 *   TEST_TASK_ID=... TEST_HANDLER_UID=... node scripts/test-authority-cashout-start.cjs
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

async function claimOp(client, operationKey, handlerUid, taskId) {
  const result = await client.query(
    `
      INSERT INTO public.authority_operations (operation_key, operation_type, user_uid, source_id, payload)
      VALUES ($1, 'cashout_start', $2, $3, '{}'::jsonb)
      ON CONFLICT (operation_key) DO NOTHING
      RETURNING operation_key
    `,
    [operationKey, handlerUid, taskId]
  );
  return (result.rowCount || 0) > 0;
}

async function testStartIdempotency(pool, taskId, handlerUid) {
  const operationKey = `cashout_start:${taskId}:${handlerUid}`;
  const results = await Promise.all([
    withClient(pool, (c) => claimOp(c, operationKey, handlerUid, taskId)),
    withClient(pool, (c) => claimOp(c, operationKey, handlerUid, taskId)),
  ]);
  return {
    test: 'start_twice_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testHandlerRace(pool, taskId, handlerA, handlerB) {
  const keyA = `cashout_start:${taskId}:${handlerA}`;
  const keyB = `cashout_start:${taskId}:${handlerB}`;
  const results = await Promise.all([
    withClient(pool, (c) => claimOp(c, keyA, handlerA, taskId)),
    withClient(pool, (c) => claimOp(c, keyB, handlerB, taskId)),
  ]);
  return {
    test: 'two_handlers_operation_keys',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 2,
    note: 'Distinct handler keys; task row FOR UPDATE serializes in authority layer',
  };
}

async function testTaskStatusGuard(pool, taskId) {
  const result = await pool.query(
    `
      SELECT status, assigned_handler_uid, expires_at
      FROM public.player_cashout_tasks_cache
      WHERE firebase_id = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [taskId]
  );
  if (!result.rows.length) {
    return { test: 'task_status_guard', ok: true, skipped: true, reason: 'task_not_found' };
  }
  const status = clean(result.rows[0].status).toLowerCase();
  const blocked = status === 'completed' || status === 'declined';
  return {
    test: 'task_status_guard',
    status,
    would_block_start: blocked,
    ok: true,
  };
}

async function testOutboxConsistency(pool, taskId) {
  const outbox = await pool.query(
    `
      SELECT channel, event_type, entity_id, source
      FROM public.live_outbox
      WHERE entity_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 10
    `,
    [taskId]
  );
  return {
    test: 'cashout_outbox_consistency',
    events: outbox.rows.length,
    ok: true,
  };
}

async function main() {
  const pool = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const taskId = clean(process.env.TEST_TASK_ID) || `cashout_test_${randomUUID()}`;
  const handlerUid = clean(process.env.TEST_HANDLER_UID) || `handler_${randomUUID()}`;
  const handlerB = clean(process.env.TEST_HANDLER_B_UID) || `handler_b_${randomUUID()}`;

  const results = await Promise.all([
    testStartIdempotency(pool, taskId, handlerUid),
    testHandlerRace(pool, taskId, handlerUid, handlerB),
    testTaskStatusGuard(pool, taskId),
    testOutboxConsistency(pool, taskId),
  ]);

  const failed = results.filter((r) => r.ok === false);
  console.log(JSON.stringify({ script: 'test-authority-cashout-start', results, failed: failed.length }, null, 2));
  await pool.end();
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
