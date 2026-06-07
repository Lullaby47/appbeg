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
  console.log(`\n[EXPLAIN_CARER_TASKS_SNAPSHOT] ${label}`);
  console.log(plan);
  console.log(`[EXPLAIN_CARER_TASKS_SNAPSHOT] ${label} elapsed_ms=${Date.now() - startedAt}`);
}

async function main() {
  loadEnvLocal();
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  const coadminUid = clean(process.argv[2]);
  const carerUid = clean(process.argv[3]);
  const channel = carerUid ? `carer:${carerUid}:tasks` : '';

  if (!coadminUid) {
    throw new Error(
      'Usage: node scripts/explain-carer-tasks-snapshot.cjs <coadminUid> [carerUid]'
    );
  }

  const pool = new Pool({ connectionString });
  const activeStatuses = ['pending', 'in_progress', 'urgent', 'pending_review'];

  try {
    await explainQuery(
      pool,
      'recent_tasks_limit_100',
      `
        SELECT firebase_id
        FROM public.carer_tasks_cache
        WHERE coadmin_uid = $1
          AND deleted_at IS NULL
        ORDER BY created_at DESC NULLS LAST
        LIMIT $2
      `,
      [coadminUid, 100]
    );

    await explainQuery(
      pool,
      'active_tasks_by_status',
      `
        SELECT firebase_id
        FROM public.carer_tasks_cache
        WHERE coadmin_uid = $1
          AND deleted_at IS NULL
          AND status = ANY($2::text[])
        ORDER BY created_at DESC NULLS LAST
      `,
      [coadminUid, activeStatuses]
    );

    await explainQuery(
      pool,
      'carer_profile_lookup',
      `
        SELECT role, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [carerUid || coadminUid]
    );

    if (channel) {
      await explainQuery(
        pool,
        'latest_outbox_for_carer_channel',
        `
          SELECT outbox_id
          FROM public.live_outbox
          WHERE channel = $1
            AND deleted_at IS NULL
          ORDER BY outbox_id DESC
          LIMIT 1
        `,
        [channel]
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[EXPLAIN_CARER_TASKS_SNAPSHOT] fatal', error.message);
  process.exit(1);
});
