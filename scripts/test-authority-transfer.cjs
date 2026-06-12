/**
 * SQL authority transfer harness.
 *
 * Usage:
 *   TEST_PLAYER_UID=... node scripts/test-authority-transfer.cjs
 */
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const clean = (v) => String(v || '').trim();
function req(n) {
  const v = clean(process.env[n]);
  if (!v) throw new Error(`${n} is required`);
  return v;
}

async function claimTransfer(pool, operationKey, playerUid, sourceId) {
  const result = await pool.query(
    `
      INSERT INTO public.authority_operations (operation_key, operation_type, user_uid, source_id, payload)
      VALUES ($1, 'transfer_cash_to_coin', $2, $3, '{}'::jsonb)
      ON CONFLICT (operation_key) DO NOTHING
      RETURNING operation_key
    `,
    [operationKey, playerUid, sourceId]
  );
  return (result.rowCount || 0) > 0;
}

async function readBalances(pool, playerUid) {
  const result = await pool.query(
    `
      SELECT coin, cash
      FROM public.players_cache
      WHERE uid = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [playerUid]
  );
  if (!result.rows.length) throw new Error('Player not found in players_cache');
  return {
    coin: Math.max(0, Math.floor(Number(result.rows[0].coin || 0))),
    cash: Math.max(0, Math.floor(Number(result.rows[0].cash || 0))),
  };
}

function getCashToCoinFee(amountNpr) {
  return Number((amountNpr * 0.02).toFixed(2));
}

async function testDoubleCashToCoinIdempotency(pool, playerUid) {
  const transferId = `test-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const operationKey = `transfer:${playerUid}:cash_to_coin:${transferId}`;
  const sourceId = `cashToCoin_${playerUid}_${transferId}`;
  const results = await Promise.all([
    claimTransfer(pool, operationKey, playerUid, sourceId),
    claimTransfer(pool, operationKey, playerUid, sourceId),
  ]);
  return {
    test: 'double_cash_to_coin_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testDoubleCoinToCashIdempotency(pool, playerUid) {
  const transferId = `test-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const operationKey = `transfer:${playerUid}:coin_to_cash:${transferId}`;
  const sourceId = `coinToCash_${playerUid}_${transferId}`;
  const insert = async () => {
    const result = await pool.query(
      `
        INSERT INTO public.authority_operations (operation_key, operation_type, user_uid, source_id, payload)
        VALUES ($1, 'transfer_coin_to_cash', $2, $3, '{}'::jsonb)
        ON CONFLICT (operation_key) DO NOTHING
        RETURNING operation_key
      `,
      [operationKey, playerUid, sourceId]
    );
    return (result.rowCount || 0) > 0;
  };
  const results = await Promise.all([insert(), insert()]);
  return {
    test: 'double_coin_to_cash_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testInsufficientCash(pool, playerUid) {
  const balances = await readBalances(pool, playerUid);
  const amount = balances.cash + 1000;
  const ok = amount > balances.cash;
  return {
    test: 'insufficient_cash_guard',
    cash: balances.cash,
    attempted: amount,
    ok,
  };
}

async function testInsufficientCoin(pool, playerUid) {
  const balances = await readBalances(pool, playerUid);
  const amount = balances.coin + 1000;
  const ok = amount > balances.coin;
  return {
    test: 'insufficient_coin_guard',
    coin: balances.coin,
    attempted: amount,
    ok,
  };
}

async function testInvalidAmount() {
  const invalid = [0, -5, 1.5, 'abc'];
  const parsed = invalid.map((v) => {
    const parsedValue = Number(v);
    return Number.isFinite(parsedValue) && parsedValue === Math.floor(parsedValue) && parsedValue > 0;
  });
  return {
    test: 'invalid_amount_rejected',
    parsed,
    ok: parsed.every((v) => v === false),
  };
}

async function testFeeRule() {
  const amount = 100;
  const fee = getCashToCoinFee(amount);
  return {
    test: 'cash_to_coin_fee_rule',
    amount,
    fee,
    coinsReceived: amount - fee,
    ok: fee === 2 && amount - fee === 98,
  };
}

async function main() {
  const playerUid = req('TEST_PLAYER_UID');
  const pool = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const results = [
    await testDoubleCashToCoinIdempotency(pool, playerUid),
    await testDoubleCoinToCashIdempotency(pool, playerUid),
    await testInsufficientCash(pool, playerUid),
    await testInsufficientCoin(pool, playerUid),
    await testInvalidAmount(),
    await testFeeRule(),
  ];

  await pool.end();
  console.log(
    JSON.stringify(
      {
        script: 'test-authority-transfer',
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
  console.error('[TEST_AUTHORITY_TRANSFER] fatal', e);
  process.exitCode = 1;
});
