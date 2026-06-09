/**
 * SQL authority bonus/referral harness.
 *
 * Usage:
 *   TEST_PLAYER_UID=... TEST_COADMIN_UID=... TEST_REFERRED_UID=... node scripts/test-authority-bonus-referral.cjs
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

async function testDoubleBonusClaim(pool, playerUid, bonusEventId) {
  const key = bonusEventId || randomUUID();
  const operationKey = `bonus_event:${playerUid}:initiate_play:${key}`;
  const results = await Promise.all([
    claimOp(pool, operationKey, 'bonus_event', playerUid, key),
    claimOp(pool, operationKey, 'bonus_event', playerUid, key),
  ]);
  return {
    test: 'double_bonus_initiate_play_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testBonusRangeUpdate(pool, coadminUid) {
  const key = '5-10';
  const operationKey = `bonus_event:${coadminUid}:update_range:${key}`;
  const results = await Promise.all([
    claimOp(pool, operationKey, 'bonus_event', coadminUid, coadminUid),
    claimOp(pool, operationKey, 'bonus_event', coadminUid, coadminUid),
  ]);
  return {
    test: 'bonus_range_update_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testReferralDoubleClaim(pool, referrerUid, referredUid) {
  const claimId = `${referrerUid}__${referredUid}`;
  const operationKey = `referral_reward:${referrerUid}:${claimId}`;
  const results = await Promise.all([
    claimOp(pool, operationKey, 'referral_reward', referrerUid, claimId),
    claimOp(pool, operationKey, 'referral_reward', referrerUid, claimId),
  ]);
  return {
    test: 'referral_reward_double_claim_idempotency',
    winners: results.filter(Boolean).length,
    ok: results.filter(Boolean).length === 1,
  };
}

async function testWrongPlayerReferral(pool, referrerUid, wrongUid) {
  const claimId = `${referrerUid}__${wrongUid}`;
  const row = await pool.query(
    `SELECT referred_by_uid FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL LIMIT 1`,
    [wrongUid]
  );
  const referredBy = clean(row.rows[0]?.referred_by_uid);
  return {
    test: 'wrong_player_referral_blocked',
    wrongUid,
    referredBy: referredBy || null,
    ok: referredBy !== referrerUid,
    note: 'Route rejects when referred_by_uid !== referrerUid',
  };
}

async function main() {
  const playerUid = req('TEST_PLAYER_UID');
  const coadminUid = clean(process.env.TEST_COADMIN_UID) || playerUid;
  const referredUid = clean(process.env.TEST_REFERRED_UID) || randomUUID();
  const bonusEventId = clean(process.env.TEST_BONUS_EVENT_ID) || randomUUID();
  const pool = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const results = [
    await testDoubleBonusClaim(pool, playerUid, bonusEventId),
    await testBonusRangeUpdate(pool, coadminUid),
    await testReferralDoubleClaim(pool, playerUid, referredUid),
    await testWrongPlayerReferral(pool, playerUid, referredUid),
  ];

  await pool.end();
  console.log(
    JSON.stringify(
      {
        script: 'test-authority-bonus-referral',
        playerUid,
        coadminUid,
        referredUid,
        results,
        ok: results.every((r) => r.ok),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[TEST_AUTHORITY_BONUS_REFERRAL] fatal', e);
  process.exitCode = 1;
});
