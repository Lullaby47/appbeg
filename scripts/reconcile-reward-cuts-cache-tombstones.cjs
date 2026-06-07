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
  if (connectionString) return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
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
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  let tombstoned = 0;
  let errors = 0;

  try {
    const [firebaseSnap, sqlResult] = await Promise.all([
      db.collection('rewardCuts').get(),
      pool.query(`
        SELECT firebase_id
        FROM public.reward_cuts_cache
        WHERE deleted_at IS NULL
        ORDER BY firebase_id
      `),
    ]);

    const firebaseIds = new Set(firebaseSnap.docs.map((doc) => doc.id));
    const activeSqlIds = sqlResult.rows.map((row) => clean(row.firebase_id)).filter(Boolean);
    const missingInFirebase = activeSqlIds.filter((id) => !firebaseIds.has(id));

    if (!DRY_RUN) {
      for (const firebaseId of missingInFirebase) {
        try {
          await pool.query(
            `
              UPDATE public.reward_cuts_cache
              SET deleted_at = now(),
                  mirrored_at = now()
              WHERE firebase_id = $1
                AND deleted_at IS NULL
            `,
            [firebaseId]
          );
          tombstoned += 1;
        } catch (error) {
          errors += 1;
          console.error('[RECONCILE_REWARD_CUTS_CACHE_TOMBSTONES] failed', {
            firebaseId,
            error,
          });
        }
      }
    }

    console.log(JSON.stringify({
      collection: 'rewardCuts',
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
  console.error('[RECONCILE_REWARD_CUTS_CACHE_TOMBSTONES] fatal', error);
  process.exitCode = 1;
});
