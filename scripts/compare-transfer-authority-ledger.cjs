const { Pool } = require('pg');

const clean = (v) => String(v || '').trim();
function req(n) {
  const v = clean(process.env[n]);
  if (!v) throw new Error(`${n} is required`);
  return v;
}

const TRANSFER_TYPES = ['cash_to_coin_transfer', 'coin_to_cash_transfer'];

async function main() {
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const [financialRows, ledgerRows, authorityOps, players] = await Promise.all([
    pg.query(
      `
        SELECT firebase_id, player_uid, type, transfer_id, before_cash, after_cash, before_coin, after_coin, source
        FROM public.financial_events_cache
        WHERE deleted_at IS NULL
          AND type = ANY($1::text[])
        ORDER BY created_at DESC NULLS LAST
        LIMIT 5000
      `,
      [TRANSFER_TYPES]
    ),
    pg.query(
      `
        SELECT event_key, user_uid, event_type, balance_type, delta, absolute_after, source_id
        FROM public.user_balance_events
        WHERE deleted_at IS NULL
          AND event_type = ANY($1::text[])
        ORDER BY source_created_at DESC NULLS LAST
        LIMIT 10000
      `,
      [
        [
          'cash_to_coin_cash_debit',
          'cash_to_coin_coin_credit',
          'coin_to_cash_coin_debit',
          'coin_to_cash_cash_credit',
        ],
      ]
    ),
    pg.query(
      `
        SELECT operation_key, operation_type, user_uid, source_id, payload
        FROM public.authority_operations
        WHERE operation_type IN ('transfer_cash_to_coin', 'transfer_coin_to_cash')
        ORDER BY created_at DESC NULLS LAST
        LIMIT 5000
      `
    ),
    pg.query(
      `
        SELECT uid, coin, cash
        FROM public.players_cache
        WHERE deleted_at IS NULL
      `
    ),
  ]);

  const ledgerBySource = new Map();
  for (const row of ledgerRows.rows) {
    const sourceId = clean(row.source_id);
    if (!sourceId) continue;
    if (!ledgerBySource.has(sourceId)) ledgerBySource.set(sourceId, []);
    ledgerBySource.get(sourceId).push(row);
  }

  const financial_without_ledger = [];
  const ledger_balance_mismatch = [];
  const authority_without_financial = [];

  for (const fin of financialRows.rows) {
    const sourceId = clean(fin.firebase_id);
    const legs = ledgerBySource.get(sourceId) || [];
    if (clean(fin.source) === 'authority_transfer' && legs.length < 2) {
      financial_without_ledger.push({
        firebase_id: sourceId,
        player_uid: fin.player_uid,
        type: fin.type,
        ledger_legs: legs.length,
      });
    }

    const cashDelta = Number(fin.after_cash ?? 0) - Number(fin.before_cash ?? 0);
    const coinDelta = Number(fin.after_coin ?? 0) - Number(fin.before_coin ?? 0);
    const cashLeg = legs.find((l) => l.balance_type === 'cash');
    const coinLeg = legs.find((l) => l.balance_type === 'coin');
    if (
      cashLeg &&
      coinLeg &&
      (Number(cashLeg.delta) !== cashDelta || Number(coinLeg.delta) !== coinDelta)
    ) {
      ledger_balance_mismatch.push({
        firebase_id: sourceId,
        expected: { cashDelta, coinDelta },
        actual: { cashDelta: Number(cashLeg.delta), coinDelta: Number(coinLeg.delta) },
      });
    }
  }

  const financialIds = new Set(financialRows.rows.map((r) => clean(r.firebase_id)));
  for (const op of authorityOps.rows) {
    const sourceId = clean(op.source_id);
    if (sourceId && !financialIds.has(sourceId)) {
      authority_without_financial.push({
        operation_key: op.operation_key,
        source_id: sourceId,
        user_uid: op.user_uid,
      });
    }
  }

  const playerBalances = new Map(
    players.rows.map((r) => [clean(r.uid), { coin: Number(r.coin || 0), cash: Number(r.cash || 0) }])
  );
  const snapshotRows = await pg.query(
    `
      SELECT firebase_id, coin, cash
      FROM public.user_balance_snapshots_cache
      WHERE deleted_at IS NULL
    `
  );
  const balance_mismatches = [];
  for (const snap of snapshotRows.rows) {
    const uid = clean(snap.firebase_id);
    const player = playerBalances.get(uid);
    if (!player) continue;
    if (Number(snap.coin) !== player.coin || Number(snap.cash) !== player.cash) {
      balance_mismatches.push({
        uid,
        players_cache: player,
        snapshot: { coin: Number(snap.coin), cash: Number(snap.cash) },
      });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        script: 'compare-transfer-authority-ledger',
        financial_transfer_count: financialRows.rowCount,
        ledger_transfer_leg_count: ledgerRows.rowCount,
        authority_transfer_ops_count: authorityOps.rowCount,
        financial_without_ledger,
        ledger_balance_mismatch,
        authority_without_financial,
        players_snapshot_mismatches: balance_mismatches.slice(0, 50),
        ok:
          financial_without_ledger.length === 0 &&
          ledger_balance_mismatch.length === 0 &&
          authority_without_financial.length === 0,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[COMPARE_TRANSFER_AUTHORITY_LEDGER] fatal', e);
  process.exitCode = 1;
});
