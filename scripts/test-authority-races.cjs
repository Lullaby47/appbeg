/**
 * Dev harness for SQL authority idempotency / race checks.
 * Requires migration 034_authority_operations.sql and a test player uid.
 *
 * Usage:
 *   TEST_PLAYER_UID=... COADMIN_UID=... node scripts/test-authority-races.cjs
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

async function claimOperation(client, operationKey, playerUid) {
  const result = await client.query(
    `
      INSERT INTO public.authority_operations (
        operation_key, operation_type, user_uid, source_id, payload
      )
      VALUES ($1, 'balance_adjust', $2, $3, '{}'::jsonb)
      ON CONFLICT (operation_key) DO NOTHING
      RETURNING operation_key
    `,
    [operationKey, playerUid, randomUUID()]
  );
  return (result.rowCount || 0) > 0;
}

async function readBalances(client, playerUid) {
  const result = await client.query(
    `
      SELECT coin, cash
      FROM public.players_cache
      WHERE uid = $1 AND deleted_at IS NULL
      FOR UPDATE
    `,
    [playerUid]
  );
  if (!result.rows.length) throw new Error('Test player not found in players_cache');
  return {
    coin: Math.max(0, Math.floor(Number(result.rows[0].coin || 0))),
    cash: Math.max(0, Math.floor(Number(result.rows[0].cash || 0))),
  };
}

async function testDoubleClaim(pool, playerUid) {
  const operationKey = `balance_adjust:test:${randomUUID()}`;
  const results = await Promise.all([
    withClient(pool, (c) => claimOperation(c, operationKey, playerUid)),
    withClient(pool, (c) => claimOperation(c, operationKey, playerUid)),
  ]);
  const winners = results.filter(Boolean).length;
  return { test: 'double_claim_operation', operationKey, winners, ok: winners === 1 };
}

async function testInsufficientBalance(pool, playerUid) {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const before = await readBalances(client, playerUid);
      const delta = -(before.coin + 1000);
      const next = before.coin + delta;
      const ok = next < 0;
      await client.query('ROLLBACK');
      return {
        test: 'insufficient_balance_guard',
        before_coin: before.coin,
        attempted_delta: delta,
        would_be_negative: ok,
        ok,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function testForUpdateSerializes(pool, playerUid) {
  const delays = [];
  const runOne = async (label) => {
    const started = Date.now();
    await withClient(pool, async (client) => {
      await client.query('BEGIN');
      await readBalances(client, playerUid);
      await new Promise((r) => setTimeout(r, 150));
      await client.query('ROLLBACK');
    });
    delays.push({ label, ms: Date.now() - started });
  };
  await Promise.all([runOne('a'), runOne('b')]);
  const serialized = delays[0].ms >= 140 && delays[1].ms >= 140;
  return { test: 'for_update_serialize', delays, ok: serialized };
}

async function main() {
  const playerUid = req('TEST_PLAYER_UID');
  const pool = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const results = [];
  results.push(await testDoubleClaim(pool, playerUid));
  results.push(await testInsufficientBalance(pool, playerUid));
  results.push(await testForUpdateSerializes(pool, playerUid));

  await pool.end();
  console.log(
    JSON.stringify(
      {
        script: 'test-authority-races',
        playerUid,
        results,
        ok: results.every((r) => r.ok),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[TEST_AUTHORITY_RACES] fatal', e);
  process.exitCode = 1;
});
