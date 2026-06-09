const { Pool } = require('pg');

const clean = (v) => String(v || '').trim();
function req(n) {
  const v = clean(process.env[n]);
  if (!v) throw new Error(`${n} is required`);
  return v;
}

const ADJUST_TYPES = [
  'coadmin_coin_add',
  'coadmin_coin_deduct',
  'coadmin_cash_add',
  'coadmin_cash_deduct',
];

async function main() {
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const [cacheRows, ledgerRows, authorityOps] = await Promise.all([
    pg.query(
      `
        SELECT firebase_id, player_uid, type, amount_npr, created_at, source
        FROM public.financial_events_cache
        WHERE deleted_at IS NULL
          AND type = ANY($1::text[])
        ORDER BY created_at DESC NULLS LAST
        LIMIT 5000
      `,
      [ADJUST_TYPES]
    ),
    pg.query(
      `
        SELECT event_key, user_uid, event_type, delta, absolute_after, source_id, source_created_at
        FROM public.user_balance_events
        WHERE deleted_at IS NULL
          AND event_type = ANY($1::text[])
        ORDER BY source_created_at DESC NULLS LAST
        LIMIT 5000
      `,
      [ADJUST_TYPES]
    ),
    pg.query(
      `
        SELECT operation_key, operation_type, user_uid, source_id, created_at
        FROM public.authority_operations
        WHERE operation_type = 'balance_adjust'
        ORDER BY created_at DESC NULLS LAST
        LIMIT 5000
      `
    ),
  ]);

  const cacheById = new Map(cacheRows.rows.map((r) => [clean(r.firebase_id), r]));
  const ledgerBySourceId = new Map(ledgerRows.rows.map((r) => [clean(r.source_id), r]));
  const authorityBySourceId = new Map(authorityOps.rows.map((r) => [clean(r.source_id), r]));

  const cache_without_ledger = [];
  const ledger_without_cache = [];
  const authority_without_ledger = [];

  for (const [id, row] of cacheById) {
    if (!ledgerBySourceId.has(id)) {
      cache_without_ledger.push({ firebase_id: id, type: row.type, player_uid: row.player_uid });
    }
  }

  for (const [sourceId, row] of ledgerBySourceId) {
    if (!cacheById.has(sourceId)) {
      ledger_without_cache.push({
        source_id: sourceId,
        event_type: row.event_type,
        user_uid: row.user_uid,
      });
    }
  }

  for (const [sourceId, row] of authorityBySourceId) {
    if (!ledgerBySourceId.has(sourceId)) {
      authority_without_ledger.push({
        source_id: sourceId,
        user_uid: row.user_uid,
        operation_key: row.operation_key,
      });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        script: 'compare-authority-ledger',
        financial_events_cache_count: cacheRows.rowCount,
        user_balance_events_count: ledgerRows.rowCount,
        authority_operations_count: authorityOps.rowCount,
        cache_without_ledger,
        ledger_without_cache,
        authority_without_ledger,
        ok:
          cache_without_ledger.length === 0 &&
          ledger_without_cache.length === 0 &&
          authority_without_ledger.length === 0,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[COMPARE_AUTHORITY_LEDGER] fatal', e);
  process.exitCode = 1;
});
