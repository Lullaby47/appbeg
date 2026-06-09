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

  const [requests, financial, ledger, authorityOps, players, snapshots, tasks] = await Promise.all([
    pg.query(`
      SELECT firebase_id, player_uid, type, status, amount, base_amount,
             coin_deducted_on_request, coin_refunded_on_dismissal, source, created_at, completed_at
      FROM public.player_game_requests_cache
      WHERE deleted_at IS NULL
        AND source LIKE 'authority%'
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT firebase_id, player_uid, type, amount_npr, request_id, before_coin, after_coin,
             before_cash, after_cash, source
      FROM public.financial_events_cache
      WHERE deleted_at IS NULL
        AND type IN ('recharge_request_deduct', 'recharge_refund', 'redeem', 'deposit')
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT event_key, user_uid, event_type, balance_type, delta, source_id, source_fields
      FROM public.user_balance_events
      WHERE deleted_at IS NULL
        AND event_type IN (
          'recharge_request_coin_debit',
          'recharge_refund_coin_credit',
          'redeem_cash_credit',
          'recharge_redeem_handler_cashbox_credit'
        )
      ORDER BY source_created_at DESC NULLS LAST
      LIMIT 10000
    `),
    pg.query(`
      SELECT operation_key, operation_type, user_uid, source_id, payload
      FROM public.authority_operations
      WHERE operation_type IN (
        'game_request_create',
        'game_request_complete',
        'game_request_dismiss',
        'game_request_refund'
      )
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`SELECT uid, coin, cash FROM public.players_cache WHERE deleted_at IS NULL`),
    pg.query(`SELECT firebase_id, coin, cash FROM public.user_balance_snapshots_cache WHERE deleted_at IS NULL`),
    pg.query(`
      SELECT firebase_id, request_id, status, source, deleted_at
      FROM public.carer_tasks_cache
      WHERE request_id IS NOT NULL
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
  ]);

  const financialByRequest = new Map();
  for (const row of financial.rows) {
    const requestId = clean(row.request_id);
    if (!requestId) continue;
    if (!financialByRequest.has(requestId)) financialByRequest.set(requestId, []);
    financialByRequest.get(requestId).push(row);
  }

  const recharge_missing_deduct = [];
  const recharge_dismissed_missing_refund = [];
  const redeem_completed_missing_credit = [];
  const tasks_missing_for_pending = [];

  for (const request of requests.rows) {
    const id = clean(request.firebase_id);
    const events = financialByRequest.get(id) || [];
    const types = new Set(events.map((e) => clean(e.type)));
    const status = clean(request.status).toLowerCase();
    const type = clean(request.type).toLowerCase();
    const taskId = `request__${id}`;
    const task = tasks.rows.find((t) => clean(t.firebase_id) === taskId);

    if (
      type === 'recharge' &&
      request.coin_deducted_on_request === true &&
      !types.has('recharge_request_deduct') &&
      clean(request.source) === 'authority_recharge_create'
    ) {
      recharge_missing_deduct.push({ requestId: id, playerUid: request.player_uid });
    }
    if (
      type === 'recharge' &&
      status === 'dismissed' &&
      request.coin_deducted_on_request === true &&
      request.coin_refunded_on_dismissal === true &&
      !types.has('recharge_refund')
    ) {
      recharge_dismissed_missing_refund.push({ requestId: id, playerUid: request.player_uid });
    }
    if (type === 'redeem' && status === 'completed' && !types.has('redeem')) {
      redeem_completed_missing_credit.push({ requestId: id, playerUid: request.player_uid });
    }
    if (status === 'pending' && (!task || task.deleted_at)) {
      tasks_missing_for_pending.push({ requestId: id, taskId, taskDeleted: Boolean(task?.deleted_at) });
    }
  }

  const playerBalances = new Map(
    players.rows.map((r) => [clean(r.uid), { coin: Number(r.coin || 0), cash: Number(r.cash || 0) }])
  );
  const balance_mismatches = [];
  for (const snap of snapshots.rows) {
    const uid = clean(snap.firebase_id);
    const player = playerBalances.get(uid);
    if (!player) continue;
    if (Number(snap.coin) !== player.coin || Number(snap.cash) !== player.cash) {
      balance_mismatches.push({
        uid,
        players_cache: player,
        snapshot: { coin: Number(snap.coin || 0), cash: Number(snap.cash || 0) },
      });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        script: 'compare-player-game-requests-authority-ledger',
        counts: {
          authority_requests: requests.rows.length,
          financial_events: financial.rows.length,
          ledger_events: ledger.rows.length,
          authority_operations: authorityOps.rows.length,
        },
        recharge_missing_deduct,
        recharge_dismissed_missing_refund,
        redeem_completed_missing_credit,
        tasks_missing_for_pending,
        balance_mismatches,
        ok:
          recharge_missing_deduct.length === 0 &&
          recharge_dismissed_missing_refund.length === 0 &&
          redeem_completed_missing_credit.length === 0 &&
          balance_mismatches.length === 0,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[COMPARE_PLAYER_GAME_REQUESTS_AUTHORITY_LEDGER] fatal', e);
  process.exitCode = 1;
});
