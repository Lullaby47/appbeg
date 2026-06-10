const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function clean(value) {
  return String(value || '').trim();
}

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) {
    return;
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (!process.env[key]) {
      process.env[key] = trimmed.slice(eq + 1);
    }
  }
}

async function explainQuery(pool, label, sql, params) {
  const startedAt = Date.now();
  const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
  const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
  const hasSeqScan = /Seq Scan/i.test(plan);
  const execMatch = plan.match(/Execution Time: ([0-9.]+) ms/);
  const execMs = execMatch ? Number(execMatch[1]) : null;
  console.log(`\n[EXPLAIN_CARER_SQL_AUDIT] ${label}`);
  console.log(plan);
  console.log(
    `[EXPLAIN_CARER_SQL_AUDIT] ${label} elapsed_ms=${Date.now() - startedAt} seq_scan=${hasSeqScan} execution_ms=${execMs}`
  );
  return { label, hasSeqScan, execMs };
}

async function main() {
  loadEnvLocal();
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  const pool = new Pool({ connectionString });
  const activeStatuses = ['pending', 'in_progress', 'urgent', 'pending_review'];
  const jobActiveStatuses = [
    'pending',
    'claimed',
    'in_progress',
    'running',
    'retrying',
    'pending_review',
    'queued',
    'cancelled_requested',
    'processing',
    'waiting',
  ];
  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const sample = await pool.query(
      `
        SELECT coadmin_uid, assigned_carer_uid
        FROM public.carer_tasks_cache
        WHERE deleted_at IS NULL
          AND coadmin_uid IS NOT NULL
        LIMIT 1
      `
    );
    const coadminUid = clean(sample.rows[0]?.coadmin_uid) || 'sample_coadmin';
    const carerUid = clean(sample.rows[0]?.assigned_carer_uid) || 'sample_carer';

    const results = [];

    results.push(
      await explainQuery(
        pool,
        '1_carer_totals',
        `
          SELECT firebase_id, type, completed_by_carer_uid, assigned_carer_uid, amount
          FROM public.carer_tasks_cache
          WHERE coadmin_uid = $1
            AND status = 'completed'
            AND type IN ('recharge', 'redeem')
            AND completed_at >= $2::timestamptz
            AND deleted_at IS NULL
          ORDER BY completed_at DESC NULLS LAST
          LIMIT $3
        `,
        [coadminUid, windowStart, 1000]
      )
    );

    results.push(
      await explainQuery(
        pool,
        '2_player_game_logins_by_coadmin',
        `
          SELECT DISTINCT ON (firebase_id)
            firebase_id, player_uid, game_name
          FROM public.player_game_logins_cache
          WHERE deleted_at IS NULL
            AND (coadmin_uid = $1 OR created_by = $1)
          ORDER BY firebase_id, COALESCE(updated_at, created_at, mirrored_at) DESC
        `,
        [coadminUid]
      )
    );

    results.push(
      await explainQuery(
        pool,
        '3_automation_auto_state',
        `
          SELECT carer_uid, coadmin_uid, enabled, automation_agent_id, lease_owner, lease_expires_at
          FROM public.automation_auto_state_cache
          WHERE carer_uid = $1
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [carerUid]
      )
    );

    results.push(
      await explainQuery(
        pool,
        '4_tasks_snapshot_recent',
        `
          SELECT firebase_id
          FROM public.carer_tasks_cache
          WHERE coadmin_uid = $1
            AND deleted_at IS NULL
          ORDER BY created_at DESC NULLS LAST
          LIMIT $2
        `,
        [coadminUid, 100]
      )
    );

    results.push(
      await explainQuery(
        pool,
        '5_tasks_snapshot_active',
        `
          SELECT firebase_id
          FROM public.carer_tasks_cache
          WHERE coadmin_uid = $1
            AND deleted_at IS NULL
            AND status = ANY($2::text[])
          ORDER BY created_at DESC NULLS LAST
        `,
        [coadminUid, activeStatuses]
      )
    );

    results.push(
      await explainQuery(
        pool,
        '6_jobs_snapshot_recent_created_by',
        `
          SELECT job_id
          FROM public.automation_jobs_cache
          WHERE deleted_at IS NULL
            AND created_by_uid = $1
          ORDER BY created_at DESC NULLS LAST
          LIMIT $2
        `,
        [carerUid, 100]
      )
    );

    results.push(
      await explainQuery(
        pool,
        '7_jobs_snapshot_recent_carer',
        `
          SELECT job_id
          FROM public.automation_jobs_cache
          WHERE deleted_at IS NULL
            AND carer_uid = $1
          ORDER BY created_at DESC NULLS LAST
          LIMIT $2
        `,
        [carerUid, 100]
      )
    );

    results.push(
      await explainQuery(
        pool,
        '8_jobs_snapshot_active_created_by',
        `
          SELECT job_id
          FROM public.automation_jobs_cache
          WHERE deleted_at IS NULL
            AND created_by_uid = $1
            AND status = ANY($2::text[])
          ORDER BY updated_at DESC NULLS LAST
        `,
        [carerUid, jobActiveStatuses]
      )
    );

    results.push(
      await explainQuery(
        pool,
        '9_latest_outbox_carer_tasks',
        `
          SELECT outbox_id
          FROM public.live_outbox
          WHERE channel = $1
            AND deleted_at IS NULL
          ORDER BY outbox_id DESC
          LIMIT 1
        `,
        [`carer:${carerUid}:tasks`]
      )
    );

    console.log('\n[EXPLAIN_CARER_SQL_AUDIT] summary', {
      coadminUid,
      carerUid,
      over150ms: results.filter((row) => (row.execMs || 0) > 150).map((row) => row.label),
      seqScans: results.filter((row) => row.hasSeqScan).map((row) => row.label),
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[EXPLAIN_CARER_SQL_AUDIT] fatal', error.message);
  process.exit(1);
});
