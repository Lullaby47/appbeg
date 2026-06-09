const { Pool } = require('pg');

const clean = (v) => String(v || '').trim();
function req(n) {
  const v = clean(process.env[n]);
  if (!v) throw new Error(`${n} is required`);
  return v;
}

async function main() {
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const [bonusEvents, claims, financial, ledger, players, snapshots] = await Promise.all([
    pg.query(`
      SELECT firebase_id, coadmin_uid, status, amount_npr, bonus_percentage, source, deleted_at
      FROM public.bonus_events_cache
      WHERE source LIKE 'authority%'
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT firebase_id, referrer_uid, referred_player_uid, reward_amount, status, recharge_id, source
      FROM public.referral_reward_claims_cache
      WHERE deleted_at IS NULL
        AND source LIKE 'authority%'
      ORDER BY claimed_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT firebase_id, player_uid, type, amount_npr, request_id, source
      FROM public.financial_events_cache
      WHERE deleted_at IS NULL
        AND type IN ('bonus', 'deposit')
        AND source LIKE 'authority%'
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT event_key, user_uid, event_type, balance_type, delta, source_id
      FROM public.user_balance_events
      WHERE deleted_at IS NULL
        AND event_type IN (
          'bonus_play_coin_debit',
          'bonus_staff_cashbox_credit',
          'referral_reward_coin_credit',
          'referral_reward_promo_locked_credit'
        )
      ORDER BY source_created_at DESC NULLS LAST
      LIMIT 10000
    `),
    pg.query(`SELECT uid, coin, promo_locked_coins FROM public.players_cache WHERE deleted_at IS NULL`),
    pg.query(`SELECT firebase_id, coin, promo_locked_coins FROM public.user_balance_snapshots_cache WHERE deleted_at IS NULL`),
  ]);

  const claims_missing_ledger = [];
  for (const claim of claims.rows) {
    const id = clean(claim.firebase_id);
    const referrerUid = clean(claim.referrer_uid);
    const coinKey = `referralRewardClaims:${id}:${referrerUid}:coin:referral_reward_coin_credit`;
    const lockedKey = `referralRewardClaims:${id}:${referrerUid}:promoLockedCoins:referral_reward_promo_locked_credit`;
    const keys = new Set(ledger.rows.map((r) => clean(r.event_key)));
    if (clean(claim.status).toLowerCase() === 'claimed') {
      if (!keys.has(coinKey) || !keys.has(lockedKey)) {
        claims_missing_ledger.push({ claimId: id, referrerUid });
      }
    }
  }

  const playerBalances = new Map(
    players.rows.map((r) => [
      clean(r.uid),
      { coin: Number(r.coin || 0), promoLockedCoins: Number(r.promo_locked_coins || 0) },
    ])
  );
  const balance_mismatches = [];
  for (const snap of snapshots.rows) {
    const uid = clean(snap.firebase_id);
    const player = playerBalances.get(uid);
    if (!player) continue;
    if (
      Number(snap.coin) !== player.coin ||
      Number(snap.promo_locked_coins || 0) !== player.promoLockedCoins
    ) {
      balance_mismatches.push({
        uid,
        players_cache: player,
        snapshot: {
          coin: Number(snap.coin || 0),
          promoLockedCoins: Number(snap.promo_locked_coins || 0),
        },
      });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        script: 'compare-bonus-referral-authority-ledger',
        counts: {
          authority_bonus_events: bonusEvents.rows.length,
          authority_referral_claims: claims.rows.length,
          financial_events: financial.rows.length,
          ledger_events: ledger.rows.length,
        },
        claims_missing_ledger,
        balance_mismatches,
        ok: claims_missing_ledger.length === 0 && balance_mismatches.length === 0,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[COMPARE_BONUS_REFERRAL_AUTHORITY_LEDGER] fatal', e);
  process.exitCode = 1;
});
