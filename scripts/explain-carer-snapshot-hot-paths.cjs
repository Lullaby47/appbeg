const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function clean(value) {
  return String(value || '').trim();
}

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
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
  const execMatch = plan.match(/Execution Time: ([0-9.]+) ms/);
  const executionMs = execMatch ? Number(execMatch[1]) : null;
  const hasSeqScan = /Seq Scan/i.test(plan);
  const indexes = Array.from(plan.matchAll(/(?:Index Scan|Index Only Scan).*? using ([^\s]+)/gi)).map(
    (match) => match[1]
  );
  console.log(`\n[SQL_EXPLAIN_SUMMARY] ${label}`);
  console.log(plan);
  console.log(
    `[SQL_EXPLAIN_SUMMARY] ${label} elapsedMs=${Date.now() - startedAt} executionMs=${executionMs} seqScan=${hasSeqScan} indexes=${indexes.join(',') || 'none'}`
  );
  return { label, executionMs, elapsedMs: Date.now() - startedAt, hasSeqScan, indexes };
}

async function main() {
  loadEnvLocal();
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  const pool = new Pool({ connectionString });
  const activeTaskStatuses = ['pending', 'in_progress', 'urgent', 'pending_review'];
  const activeJobStatuses = [
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
  const terminalJobStatuses = ['completed', 'failed'];

  try {
    const sampleTask = await pool.query(`
      SELECT coadmin_uid, assigned_carer_uid
      FROM public.carer_tasks_cache
      WHERE deleted_at IS NULL
        AND coadmin_uid IS NOT NULL
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1
    `);
    const sampleJob = await pool.query(`
      SELECT COALESCE(NULLIF(carer_uid, ''), NULLIF(created_by_uid, '')) AS carer_uid
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
        AND COALESCE(NULLIF(carer_uid, ''), NULLIF(created_by_uid, '')) IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `);
    const coadminUid = clean(process.argv[2]) || clean(sampleTask.rows[0]?.coadmin_uid);
    const carerUid =
      clean(process.argv[3]) ||
      clean(sampleTask.rows[0]?.assigned_carer_uid) ||
      clean(sampleJob.rows[0]?.carer_uid);
    if (!coadminUid) {
      throw new Error('No coadmin uid sample found; pass one as argv[2].');
    }
    if (!carerUid) {
      throw new Error('No carer uid sample found; pass one as argv[3].');
    }

    const taskColumns = `
      firebase_id, coadmin_uid, player_uid, type, status, automation_status, game_name, amount,
      request_id, assigned_carer_uid, assigned_carer_username, claimed_by_uid,
      claimed_by_username, created_at, claimed_at, started_at, updated_at, completed_at,
      completed_by_carer_uid, completed_by_carer_username
    `;
    const jobColumns = `
      job_id, task_id, coadmin_uid, carer_uid, created_by_uid, agent_id, type, request_type,
      status, game, created_at, updated_at, started_at, last_heartbeat_at,
      needs_manual_review, error_message
    `;

    const results = [];
    results.push(
      await explainQuery(
        pool,
        'carer_tasks_snapshot_combined',
        `
          WITH active_rows AS (
            SELECT ${taskColumns}, 'active'::text AS snapshot_bucket
            FROM public.carer_tasks_cache
            WHERE coadmin_uid = $1
              AND deleted_at IS NULL
              AND status = ANY($2::text[])
            ORDER BY created_at DESC
          ),
          completed_rows AS (
            SELECT ${taskColumns}, 'completed'::text AS snapshot_bucket
            FROM public.carer_tasks_cache
            WHERE coadmin_uid = $1
              AND deleted_at IS NULL
              AND status = 'completed'
            ORDER BY completed_at DESC
            LIMIT $3
          )
          SELECT * FROM active_rows
          UNION ALL
          SELECT * FROM completed_rows
        `,
        [coadminUid, activeTaskStatuses, 30]
      )
    );

    results.push(
      await explainQuery(
        pool,
        'automation_jobs_snapshot_combined',
        `
          WITH active_created_by AS (
            SELECT ${jobColumns}, 'active_created_by'::text AS snapshot_bucket
            FROM public.automation_jobs_cache
            WHERE deleted_at IS NULL
              AND created_by_uid = $1
              AND status = ANY($2::text[])
            ORDER BY updated_at DESC
          ),
          active_carer AS (
            SELECT ${jobColumns}, 'active_carer'::text AS snapshot_bucket
            FROM public.automation_jobs_cache
            WHERE deleted_at IS NULL
              AND carer_uid = $1
              AND status = ANY($2::text[])
            ORDER BY updated_at DESC
          ),
          recent_created_by AS (
            SELECT ${jobColumns}, 'recent_created_by'::text AS snapshot_bucket
            FROM public.automation_jobs_cache
            WHERE deleted_at IS NULL
              AND created_by_uid = $1
              AND status = ANY($3::text[])
            ORDER BY updated_at DESC
            LIMIT $4
          ),
          recent_carer AS (
            SELECT ${jobColumns}, 'recent_carer'::text AS snapshot_bucket
            FROM public.automation_jobs_cache
            WHERE deleted_at IS NULL
              AND carer_uid = $1
              AND status = ANY($3::text[])
            ORDER BY updated_at DESC
            LIMIT $4
          )
          SELECT * FROM active_created_by
          UNION ALL
          SELECT * FROM active_carer
          UNION ALL
          SELECT * FROM recent_created_by
          UNION ALL
          SELECT * FROM recent_carer
        `,
        [carerUid, activeJobStatuses, terminalJobStatuses, 30]
      )
    );

    results.push(
      await explainQuery(
        pool,
        'live_outbox_latest_cursor',
        `
          SELECT COALESCE(MAX(outbox_id), 0)::bigint AS outbox_id
          FROM public.live_outbox
          WHERE channel = ANY($1::text[])
            AND deleted_at IS NULL
        `,
        [[`carer:${carerUid}:tasks`, `coadmin:${coadminUid}:tasks`]]
      )
    );

    console.log('\n[SQL_EXPLAIN_SUMMARY] hot_path_summary', {
      coadminUid,
      carerUid,
      over150ms: results.filter((row) => (row.elapsedMs || 0) > 150).map((row) => row.label),
      seqScans: results.filter((row) => row.hasSeqScan).map((row) => row.label),
      indexes: Object.fromEntries(results.map((row) => [row.label, row.indexes])),
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[SQL_EXPLAIN_SUMMARY] fatal', error.message);
  process.exit(1);
});
