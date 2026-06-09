/**
 * SQL authority freeplay idempotency / validation harness.
 *
 * Usage:
 *   TEST_COADMIN_UID=... TEST_PLAYER_UID=... node scripts/test-authority-freeplay.cjs
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

async function claimOperation(client, operationKey, payload) {
  const result = await client.query(
    `
      INSERT INTO public.authority_operations (operation_key, operation_type, user_uid, source_id, payload)
      VALUES ($1, 'freeplay_give', $2, $3, $4::jsonb)
      ON CONFLICT (operation_key) DO NOTHING
      RETURNING operation_key
    `,
    [operationKey, payload.playerUid, payload.giftId, JSON.stringify(payload)]
  );
  return (result.rowCount || 0) > 0;
}

async function testDoubleGiveIdempotency(pool, coadminUid, playerUid) {
  const operationKey = `freeplay_give:${coadminUid}:test-${randomUUID()}`;
  const payload = {
    playerUid,
    playerUsername: 'test-player',
    giftId: randomUUID(),
  };
  const results = await Promise.all([
    withClient(pool, (c) => claimOperation(c, operationKey, payload)),
    withClient(pool, (c) => claimOperation(c, operationKey, payload)),
  ]);
  return {
    test: 'double_freeplay_give_idempotency',
    operationKey,
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testDoubleClaimOperation(pool, playerUid, giftId) {
  const operationKey = `freeplay_claim:${playerUid}:${giftId}`;
  const insert = async () => {
    const result = await pool.query(
      `
        INSERT INTO public.authority_operations (operation_key, operation_type, user_uid, source_id, payload)
        VALUES ($1, 'freeplay_claim', $2, $3, '{"amount":2}'::jsonb)
        ON CONFLICT (operation_key) DO NOTHING
        RETURNING operation_key
      `,
      [operationKey, playerUid, giftId]
    );
    return (result.rowCount || 0) > 0;
  };
  const results = await Promise.all([insert(), insert()]);
  return {
    test: 'double_claim_same_gift',
    operationKey,
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testClaimMissingGift(pool, playerUid) {
  const result = await pool.query(
    `
      SELECT player_uid, gift_id, status, has_pending_gift
      FROM public.freeplay_pending_gifts_cache
      WHERE player_uid = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [playerUid]
  );
  const row = result.rows[0];
  const missing = !row || row.status !== 'pending';
  return {
    test: 'claim_missing_or_non_pending_gift',
    playerUid,
    row: row || null,
    ok: missing,
    note: 'Route should reject claim when no pending marker exists',
  };
}

async function testClaimWrongPlayer(pool, giftId, wrongPlayerUid) {
  const result = await pool.query(
    `
      SELECT firebase_id, player_uid, status
      FROM public.freeplay_gifts_cache
      WHERE firebase_id = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [giftId]
  );
  const row = result.rows[0];
  const wrong =
    Boolean(row) && clean(row.player_uid) !== clean(wrongPlayerUid) && row.status === 'pending';
  return {
    test: 'claim_wrong_player',
    giftId,
    wrongPlayerUid,
    actualPlayerUid: row ? clean(row.player_uid) : null,
    ok: wrong,
    note: 'Route should reject when gift.player_uid !== auth player',
  };
}

async function main() {
  const coadminUid = req('TEST_COADMIN_UID');
  const playerUid = req('TEST_PLAYER_UID');
  const pool = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const pendingGift = await pool.query(
    `
      SELECT gift_id
      FROM public.freeplay_pending_gifts_cache
      WHERE player_uid = $1
        AND deleted_at IS NULL
        AND status = 'pending'
      LIMIT 1
    `,
    [playerUid]
  );
  const giftId = clean(pendingGift.rows[0]?.gift_id) || randomUUID();

  const results = [
    await testDoubleGiveIdempotency(pool, coadminUid, playerUid),
    await testDoubleClaimOperation(pool, playerUid, giftId),
    await testClaimMissingGift(pool, `missing-${randomUUID()}`),
    await testClaimWrongPlayer(pool, giftId, `wrong-${randomUUID()}`),
  ];

  await pool.end();
  console.log(
    JSON.stringify(
      {
        script: 'test-authority-freeplay',
        results,
        ok: results.every((r) => r.ok),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[TEST_AUTHORITY_FREEPLAY] fatal', e);
  process.exitCode = 1;
});
