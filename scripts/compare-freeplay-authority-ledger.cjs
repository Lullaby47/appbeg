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

  const [pendingRows, giftRows, financialRows, ledgerRows, authorityOps] = await Promise.all([
    pg.query(`
      SELECT player_uid, gift_id, status, amount, has_pending_gift
      FROM public.freeplay_pending_gifts_cache
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT firebase_id, player_uid, status, amount
      FROM public.freeplay_gifts_cache
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT firebase_id, player_uid, gift_id, type, amount_npr, source
      FROM public.financial_events_cache
      WHERE deleted_at IS NULL
        AND type = 'freeplay'
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT event_key, user_uid, event_type, delta, source_id, source_fields
      FROM public.user_balance_events
      WHERE deleted_at IS NULL
        AND event_type = 'freeplay'
      ORDER BY source_created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT operation_key, operation_type, user_uid, source_id, payload
      FROM public.authority_operations
      WHERE operation_type IN ('freeplay_give', 'freeplay_claim')
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
  ]);

  const giftsById = new Map(giftRows.rows.map((r) => [clean(r.firebase_id), r]));
  const pendingByPlayer = new Map(pendingRows.rows.map((r) => [clean(r.player_uid), r]));
  const ledgerGiftIds = new Set(
    ledgerRows.rows
      .map((r) => {
        const fields = r.source_fields || {};
        return clean(fields.giftId);
      })
      .filter(Boolean)
  );

  const pending_without_gift = [];
  const gift_without_pending = [];
  const claimed_pending_mismatch = [];
  const financial_without_ledger = [];

  for (const pending of pendingRows.rows) {
    const giftId = clean(pending.gift_id);
    const gift = giftId ? giftsById.get(giftId) : null;
    if (giftId && !gift) {
      pending_without_gift.push({ player_uid: pending.player_uid, gift_id: giftId });
    }
    if (
      clean(pending.status) === 'claimed' &&
      gift &&
      clean(gift.status) !== 'claimed'
    ) {
      claimed_pending_mismatch.push({
        player_uid: pending.player_uid,
        gift_id: giftId,
        pending_status: pending.status,
        gift_status: gift.status,
      });
    }
  }

  for (const gift of giftRows.rows) {
    const pending = pendingByPlayer.get(clean(gift.player_uid));
    if (!pending || clean(pending.gift_id) !== clean(gift.firebase_id)) {
      gift_without_pending.push({
        gift_id: gift.firebase_id,
        player_uid: gift.player_uid,
      });
    }
  }

  for (const fin of financialRows.rows) {
    const giftId = clean(fin.gift_id);
    if (giftId && !ledgerGiftIds.has(giftId) && clean(fin.source) === 'authority_freeplay_claim') {
      financial_without_ledger.push({
        firebase_id: fin.firebase_id,
        gift_id: giftId,
        player_uid: fin.player_uid,
      });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        script: 'compare-freeplay-authority-ledger',
        pending_count: pendingRows.rowCount,
        gifts_count: giftRows.rowCount,
        financial_freeplay_count: financialRows.rowCount,
        ledger_freeplay_count: ledgerRows.rowCount,
        authority_ops_count: authorityOps.rowCount,
        pending_without_gift,
        gift_without_pending,
        claimed_pending_mismatch,
        financial_without_ledger,
        ok:
          pending_without_gift.length === 0 &&
          claimed_pending_mismatch.length === 0 &&
          financial_without_ledger.length === 0,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[COMPARE_FREEPLAY_AUTHORITY_LEDGER] fatal', e);
  process.exitCode = 1;
});
