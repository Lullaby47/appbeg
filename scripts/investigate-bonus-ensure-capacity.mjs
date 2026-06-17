import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const coadminUid = String(process.env.TEST_COADMIN_UID || 'pNaCcFpMHccu5l3TgLSKvldtrOB2').trim();
const connectionString =
  String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
  'postgresql://appbeg_user:AppBeg2026Strong47@103.214.71.5:5432/appbeg';

async function activeCount(pool, uid) {
  const { rows } = await pool.query(
    `
      SELECT COUNT(*)::int AS count
      FROM public.bonus_events_cache
      WHERE deleted_at IS NULL
        AND trim(coalesce(coadmin_uid, '')) = $1
        AND lower(trim(coalesce(status, 'active'))) = 'active'
        AND (start_date IS NULL OR start_date <= now())
        AND (end_date IS NULL OR end_date >= now())
    `,
    [uid]
  );
  return rows[0]?.count ?? 0;
}

async function main() {
  process.env.AUTHORITY_SQL_WRITE = process.env.AUTHORITY_SQL_WRITE || '1';
  const { ensureBonusCapacityInSql } = await import('../lib/sql/authorityBonus.ts');
  const pool = new Pool({ connectionString });

  const before = await activeCount(pool, coadminUid);
  const result = await ensureBonusCapacityInSql({
    coadminUid,
    callerUid: coadminUid,
    callerUsername: 'investigation',
    activeCountHint: before,
  });
  const after = await activeCount(pool, coadminUid);

  console.log(
    JSON.stringify(
      {
        coadminUid,
        activeCountBefore: before,
        ensureResult: result,
        activeCountAfter: after,
      },
      null,
      2
    )
  );

  await pool.end();
}

main().catch((error) => {
  console.error('[INVESTIGATE_ENSURE_CAPACITY] fatal', error);
  process.exitCode = 1;
});
