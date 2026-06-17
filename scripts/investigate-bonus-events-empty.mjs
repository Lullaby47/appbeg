import { Pool } from 'pg';

const coadminUid = String(process.env.TEST_COADMIN_UID || '').trim();
const connectionString =
  String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
  'postgresql://appbeg_user:AppBeg2026Strong47@103.214.71.5:5432/appbeg';

const pool = new Pool({ connectionString });

async function countsFor(uid) {
  const total = await pool.query(
    `
      SELECT COUNT(*)::int AS count
      FROM public.bonus_events_cache
      WHERE deleted_at IS NULL
        AND trim(coalesce(coadmin_uid, '')) = $1
    `,
    [uid]
  );
  const active = await pool.query(
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
  const sample = await pool.query(
    `
      SELECT firebase_id, status, start_date, end_date, created_at
      FROM public.bonus_events_cache
      WHERE deleted_at IS NULL
        AND trim(coalesce(coadmin_uid, '')) = $1
      ORDER BY created_at DESC NULLS LAST
      LIMIT 3
    `,
    [uid]
  );
  const lease = await pool.query(
    `
      SELECT
        raw_firestore_data->>'bonusEnsureCapacityLastEnsuredAt' AS last_ensured_at,
        raw_firestore_data->>'bonusEnsureCapacityLastActiveCount' AS last_active_count,
        raw_firestore_data->>'bonusEnsureCapacityLastStateHash' AS last_state_hash,
        raw_firestore_data->>'bonusEnsureCapacityLeaseExpiresAt' AS lease_expires_at
      FROM public.players_cache
      WHERE uid = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [uid]
  );
  return {
    coadminUid: uid,
    totalRows: total.rows[0]?.count ?? 0,
    activeInWindow: active.rows[0]?.count ?? 0,
    sampleRows: sample.rows,
    ensureLease: lease.rows[0] ?? null,
    now: new Date().toISOString(),
  };
}

async function main() {
  if (coadminUid) {
    console.log(JSON.stringify({ mode: 'single', ...(await countsFor(coadminUid)) }, null, 2));
    return;
  }

  const grouped = await pool.query(`
    SELECT
      trim(coalesce(coadmin_uid, '')) AS coadmin_uid,
      COUNT(*)::int AS total_rows,
      COUNT(*) FILTER (
        WHERE lower(trim(coalesce(status, 'active'))) = 'active'
          AND (start_date IS NULL OR start_date <= now())
          AND (end_date IS NULL OR end_date >= now())
      )::int AS active_in_window
    FROM public.bonus_events_cache
    WHERE deleted_at IS NULL
    GROUP BY 1
    ORDER BY total_rows DESC
  `);

  const playerScope = await pool.query(
    `
      SELECT COUNT(*)::int AS player_count
      FROM public.players_cache
      WHERE deleted_at IS NULL
        AND lower(coalesce(raw_firestore_data->>'role', '')) = 'player'
        AND trim(coalesce(raw_firestore_data->>'coadminUid', '')) = $1
    `,
    [coadminUid || 'pNaCcFpMHccu5l3TgLSKvldtrOB2']
  );

  console.log(
    JSON.stringify(
      {
        mode: 'grouped',
        coadmins: grouped.rows,
        globalTotalRows: grouped.rows.reduce((sum, row) => sum + Number(row.total_rows || 0), 0),
        globalActiveInWindow: grouped.rows.reduce(
          (sum, row) => sum + Number(row.active_in_window || 0),
          0
        ),
        playersUnderCoadmin: playerScope.rows[0]?.player_count ?? 0,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error('[INVESTIGATE_BONUS_EVENTS_EMPTY] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
