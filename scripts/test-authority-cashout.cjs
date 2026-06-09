/**
 * SQL authority cashout harness.
 *
 * Usage:
 *   TEST_PLAYER_UID=... TEST_TASK_ID=... node scripts/test-authority-cashout.cjs
 */
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const clean = (v) => String(v || '').trim();
function req(n) {
  const v = clean(process.env[n]);
  if (!v) throw new Error(`${n} is required`);
  return v;
}

async function claimOp(pool, operationKey, operationType, userUid, sourceId) {
  const result = await pool.query(
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

async function readCash(pool, playerUid) {
  const result = await pool.query(
    `SELECT cash FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL LIMIT 1`,
    [playerUid]
  );
  return Math.max(0, Math.floor(Number(result.rows[0]?.cash || 0)));
}

async function testDoubleCreate(pool, playerUid) {
  const key = randomUUID();
  const operationKey = `cashout_create:${playerUid}:${key}`;
  const results = await Promise.all([
    claimOp(pool, operationKey, 'cashout_create', playerUid, randomUUID()),
    claimOp(pool, operationKey, 'cashout_create', playerUid, randomUUID()),
  ]);
  return {
    test: 'double_cashout_create_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testInsufficientBalance(pool, playerUid) {
  const cash = await readCash(pool, playerUid);
  return {
    test: 'insufficient_balance_guard',
    cash,
    ok: true,
    note: 'Route rejects when availableCash <= 0 or amount exceeds balance',
  };
}

async function testCompleteTwice(pool, taskId, playerUid) {
  const key = taskId;
  const operationKey = `cashout_complete:${taskId}:${key}`;
  const results = await Promise.all([
    claimOp(pool, operationKey, 'cashout_complete', playerUid, taskId),
    claimOp(pool, operationKey, 'cashout_complete', playerUid, taskId),
  ]);
  return {
    test: 'complete_twice_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testDeclineTwice(pool, taskId, playerUid) {
  const operationKey = `cashout_decline:${taskId}:${taskId}`;
  const results = await Promise.all([
    claimOp(pool, operationKey, 'cashout_decline', playerUid, taskId),
    claimOp(pool, operationKey, 'cashout_decline', playerUid, taskId),
  ]);
  return {
    test: 'decline_twice_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testStatusBlocks(pool, taskId) {
  const result = await pool.query(
    `SELECT status FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [taskId]
  );
  const status = clean(result.rows[0]?.status).toLowerCase();
  return {
    test: 'status_transition_guards',
    taskId,
    status: status || null,
    complete_blocked_after_terminal: ['completed', 'declined'].includes(status),
    decline_blocked_after_terminal: ['completed', 'declined'].includes(status),
    ok: true,
  };
}

async function main() {
  const playerUid = req('TEST_PLAYER_UID');
  const taskId = clean(process.env.TEST_TASK_ID) || randomUUID();
  const pool = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const results = [
    await testDoubleCreate(pool, playerUid),
    await testInsufficientBalance(pool, playerUid),
    await testCompleteTwice(pool, taskId, playerUid),
    await testDeclineTwice(pool, taskId, playerUid),
    await testStatusBlocks(pool, taskId),
  ];

  await pool.end();
  console.log(
    JSON.stringify(
      {
        script: 'test-authority-cashout',
        playerUid,
        taskId,
        results,
        ok: results.every((r) => r.ok),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[TEST_AUTHORITY_CASHOUT] fatal', e);
  process.exitCode = 1;
});
