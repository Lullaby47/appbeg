const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');

function argValue(name) {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  const hit = index >= 0 ? process.argv[index] : null;
  if (!hit) return null;
  if (hit === name) {
    const next = process.argv[index + 1];
    return next && !next.startsWith('--') ? next : 'true';
  }
  return hit.slice(prefix.length);
}

const DRY_RUN = argValue('--dry-run') !== null;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function clean(value) {
  return String(value || '').trim();
}

function initFirebase() {
  const base64 = requiredEnv('FIREBASE_SERVICE_ACCOUNT_BASE64');
  const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  return getApps().length === 0
    ? initializeApp({ credential: cert(serviceAccount) })
    : getApps()[0];
}

function createPgPool() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (connectionString) {
    return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  }
  return new Pool({
    host: clean(process.env.APPBEG_PG_HOST || '127.0.0.1'),
    port: Number(process.env.APPBEG_PG_PORT || '5433'),
    database: clean(process.env.APPBEG_PG_DATABASE || 'appbeg'),
    user: clean(process.env.APPBEG_PG_USER || 'appbeg_user'),
    password: requiredEnv('APPBEG_PG_PASSWORD'),
    connectionTimeoutMillis: 10_000,
  });
}

async function main() {
  console.log('[RECONCILE_AUTOMATION_JOBS_CACHE_TOMBSTONES] starting', {
    dryRun: DRY_RUN,
  });

  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();

  let tombstoned = 0;
  let errors = 0;

  try {
    const [firebaseSnap, sqlResult] = await Promise.all([
      db.collection('automation_jobs').get(),
      pool.query(`
        SELECT job_id
        FROM public.automation_jobs_cache
        WHERE deleted_at IS NULL
        ORDER BY job_id
      `),
    ]);

    const firebaseIds = new Set(firebaseSnap.docs.map((doc) => doc.id));
    const activeSqlIds = sqlResult.rows
      .map((row) => clean(row.job_id))
      .filter(Boolean);
    const missingInFirebase = activeSqlIds.filter((jobId) => !firebaseIds.has(jobId));

    console.log('[RECONCILE_AUTOMATION_JOBS_CACHE_TOMBSTONES] diff complete', {
      firebaseCount: firebaseIds.size,
      postgresActiveCountBefore: activeSqlIds.length,
      wouldTombstone: missingInFirebase.length,
      sampleIds: missingInFirebase.slice(0, 20),
    });

    if (!DRY_RUN) {
      for (const jobId of missingInFirebase) {
        try {
          await pool.query(
            `
              UPDATE public.automation_jobs_cache
              SET deleted_at = now(),
                  mirrored_at = now()
              WHERE job_id = $1
                AND deleted_at IS NULL
            `,
            [jobId]
          );
          tombstoned += 1;
          if (tombstoned % 25 === 0 || tombstoned === missingInFirebase.length) {
            console.log('[RECONCILE_AUTOMATION_JOBS_CACHE_TOMBSTONES] progress', {
              tombstoned,
              total: missingInFirebase.length,
              errors,
            });
          }
        } catch (error) {
          errors += 1;
          console.error('[RECONCILE_AUTOMATION_JOBS_CACHE_TOMBSTONES] failed', {
            jobId,
            error,
          });
        }
      }
    }

    console.log(JSON.stringify({
      collection: 'automation_jobs',
      dry_run: DRY_RUN,
      firebase_count: firebaseIds.size,
      postgres_active_count_before: activeSqlIds.length,
      would_tombstone: missingInFirebase.length,
      tombstoned,
      errors,
      sample_ids: missingInFirebase.slice(0, 20),
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[RECONCILE_AUTOMATION_JOBS_CACHE_TOMBSTONES] fatal', error);
  process.exitCode = 1;
});
