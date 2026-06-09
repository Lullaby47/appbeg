const { Pool } = require('pg');

const clean = (v) => String(v || '').trim();
function req(n) {
  const v = clean(process.env[n]);
  if (!v) throw new Error(`${n} is required`);
  return v;
}

function isActive(row, nowMs = Date.now()) {
  const status = clean(row.status).toLowerCase() || 'active';
  if (status !== 'active') return false;
  const startMs = row.start_date ? Date.parse(row.start_date) : 0;
  const endMs = row.end_date ? Date.parse(row.end_date) : 0;
  if (startMs > 0 && nowMs < startMs) return false;
  if (endMs > 0 && nowMs > endMs) return false;
  return true;
}

async function main() {
  const coadminUid = clean(process.env.TEST_COADMIN_UID) || null;
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const params = [];
  let where = `deleted_at IS NULL`;
  if (coadminUid) {
    params.push(coadminUid);
    where += ` AND coadmin_uid = $1`;
  }

  const result = await pg.query(
    `
      SELECT firebase_id, coadmin_uid, bonus_name, game_name, amount_npr, bonus_percentage,
             status, start_date, end_date, source, created_at
      FROM public.bonus_events_cache
      WHERE ${where}
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `,
    params
  );

  const active = result.rows.filter((row) => isActive(row));
  const byCoadmin = new Map();
  for (const row of active) {
    const uid = clean(row.coadmin_uid);
    if (!byCoadmin.has(uid)) byCoadmin.set(uid, []);
    byCoadmin.get(uid).push(row);
  }

  const over_capacity = [];
  for (const [uid, rows] of byCoadmin.entries()) {
    if (rows.length > 20) {
      over_capacity.push({ coadminUid: uid, activeCount: rows.length });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        script: 'compare-bonus-events-cache',
        coadminUid,
        totalRows: result.rows.length,
        activeRows: active.length,
        over_capacity,
        ok: over_capacity.length === 0,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[COMPARE_BONUS_EVENTS_CACHE] fatal', e);
  process.exitCode = 1;
});
