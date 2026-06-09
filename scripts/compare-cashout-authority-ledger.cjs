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

  const [tasks, financial, ledger, authorityOps, players, snapshots] = await Promise.all([
    pg.query(`
      SELECT firebase_id, player_uid, status, amount_npr, cash_deducted_on_request, source, created_at, completed_at
      FROM public.player_cashout_tasks_cache
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT firebase_id, player_uid, type, amount_npr, cashout_task_id, before_cash, after_cash, source
      FROM public.financial_events_cache
      WHERE deleted_at IS NULL
        AND type IN ('cashout_request_deduct', 'cashout_decline_refund', 'cashout')
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT event_key, user_uid, event_type, balance_type, delta, source_id, source_fields
      FROM public.user_balance_events
      WHERE deleted_at IS NULL
        AND event_type IN (
          'cashout_request_cash_debit',
          'cashout_decline_cash_refund',
          'cashout_handler_cashbox_credit',
          'cashout_complete_cash_debit_legacy'
        )
      ORDER BY source_created_at DESC NULLS LAST
      LIMIT 10000
    `),
    pg.query(`
      SELECT operation_key, operation_type, user_uid, source_id, payload
      FROM public.authority_operations
      WHERE operation_type IN ('cashout_create', 'cashout_complete', 'cashout_decline')
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`SELECT uid, cash FROM public.players_cache WHERE deleted_at IS NULL`),
    pg.query(`SELECT firebase_id, cash FROM public.user_balance_snapshots_cache WHERE deleted_at IS NULL`),
  ]);

  const financialByTask = new Map();
  for (const row of financial.rows) {
    const taskId = clean(row.cashout_task_id);
    if (!taskId) continue;
    if (!financialByTask.has(taskId)) financialByTask.set(taskId, []);
    financialByTask.get(taskId).push(row);
  }

  const tasks_missing_deduct_event = [];
  const declined_missing_refund = [];
  const completed_missing_cashout_event = [];

  for (const task of tasks.rows) {
    const id = clean(task.firebase_id);
    const events = financialByTask.get(id) || [];
    const status = clean(task.status).toLowerCase();
    const types = new Set(events.map((e) => clean(e.type)));

    if (
      task.cash_deducted_on_request === true &&
      !types.has('cashout_request_deduct') &&
      clean(task.source) === 'authority_cashout_create'
    ) {
      tasks_missing_deduct_event.push({ taskId: id, playerUid: task.player_uid });
    }
    if (status === 'declined' && task.cash_deducted_on_request === true && !types.has('cashout_decline_refund')) {
      declined_missing_refund.push({ taskId: id, playerUid: task.player_uid });
    }
    if (status === 'completed' && !types.has('cashout')) {
      completed_missing_cashout_event.push({ taskId: id, playerUid: task.player_uid });
    }
  }

  const playerCash = new Map(players.rows.map((r) => [clean(r.uid), Number(r.cash || 0)]));
  const balance_mismatches = [];
  for (const snap of snapshots.rows) {
    const uid = clean(snap.firebase_id);
    if (!playerCash.has(uid)) continue;
    if (Number(snap.cash) !== playerCash.get(uid)) {
      balance_mismatches.push({ uid, players_cache: playerCash.get(uid), snapshot: Number(snap.cash) });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        script: 'compare-cashout-authority-ledger',
        task_count: tasks.rowCount,
        financial_count: financial.rowCount,
        ledger_count: ledger.rowCount,
        authority_ops_count: authorityOps.rowCount,
        tasks_missing_deduct_event,
        declined_missing_refund,
        completed_missing_cashout_event,
        balance_mismatches: balance_mismatches.slice(0, 50),
        ok:
          tasks_missing_deduct_event.length === 0 &&
          declined_missing_refund.length === 0 &&
          completed_missing_cashout_event.length === 0,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[COMPARE_CASHOUT_AUTHORITY_LEDGER] fatal', e);
  process.exitCode = 1;
});
