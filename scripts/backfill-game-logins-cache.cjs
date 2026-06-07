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
const LIMIT = Number(argValue('--limit') || '0') || 0;

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
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }
  return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.toMillis === 'function') return new Date(value.toMillis());
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
  return null;
}

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function normalizeJson(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeJson(child)])
    );
  }
  return value;
}

function normalize(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    game_name: clean(data.gameName),
    username: clean(data.username),
    password: String(data.password || ''),
    backend_url: clean(data.backendUrl),
    frontend_url: clean(data.frontendUrl),
    site_url: clean(data.siteUrl || data.backendUrl),
    created_by: clean(data.createdBy),
    coadmin_uid: clean(data.coadminUid),
    status: clean(data.status) || 'active',
    raw_json: normalizeJson(data) || {},
    created_at: toIso(data.createdAt),
  };
}

async function upsert(pool, row) {
  if (!row.id || !row.game_name || !row.username || !row.created_by) {
    throw new Error('Invalid game login cache row.');
  }

  await pool.query(
    `
      INSERT INTO public.game_logins_cache (
        id,
        game_name,
        username,
        password,
        backend_url,
        frontend_url,
        site_url,
        created_by,
        coadmin_uid,
        status,
        source,
        raw_json,
        created_at,
        updated_at,
        deleted_at,
        mirrored_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), $10, 'firebase_backfill',
        $11::jsonb, $12::timestamptz, now(), NULL, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        game_name = EXCLUDED.game_name,
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        backend_url = EXCLUDED.backend_url,
        frontend_url = EXCLUDED.frontend_url,
        site_url = EXCLUDED.site_url,
        created_by = EXCLUDED.created_by,
        coadmin_uid = EXCLUDED.coadmin_uid,
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        raw_json = EXCLUDED.raw_json,
        created_at = COALESCE(public.game_logins_cache.created_at, EXCLUDED.created_at),
        updated_at = now(),
        deleted_at = NULL,
        mirrored_at = now()
    `,
    [
      row.id,
      row.game_name,
      row.username,
      row.password,
      row.backend_url,
      row.frontend_url,
      row.site_url,
      row.created_by,
      row.coadmin_uid,
      row.status,
      JSON.stringify(row.raw_json),
      row.created_at,
    ]
  );
}

async function main() {
  console.log('[BACKFILL_GAME_LOGINS_CACHE] starting', {
    dryRun: DRY_RUN,
    limit: LIMIT || null,
  });
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  let query = db.collection('gameLogins');
  if (LIMIT > 0) query = query.limit(LIMIT);

  console.log('[BACKFILL_GAME_LOGINS_CACHE] starting firestore read', {
    collection: 'gameLogins',
    limit: LIMIT || null,
  });
  const snapshot = await query.get();
  console.log('[BACKFILL_GAME_LOGINS_CACHE] firestore read complete', {
    firebaseCountSeen: snapshot.size,
  });
  console.log('[BACKFILL_GAME_LOGINS_CACHE] starting postgres upsert', {
    dryRun: DRY_RUN,
  });

  let wouldUpsert = 0;
  let upserted = 0;
  let errors = 0;
  let processed = 0;

  for (const doc of snapshot.docs) {
    processed += 1;
    wouldUpsert += 1;
    if (!DRY_RUN) {
      try {
        await upsert(pool, normalize(doc));
        upserted += 1;
      } catch (error) {
        errors += 1;
        console.error('[BACKFILL_GAME_LOGINS_CACHE] failed', { id: doc.id, error });
      }
    }

    if (processed % 25 === 0 || processed === snapshot.docs.length) {
      console.log('[BACKFILL_GAME_LOGINS_CACHE] progress', {
        processed,
        total: snapshot.docs.length,
        wouldUpsert,
        upserted,
        errors,
      });
    }
  }

  await pool.end();
  console.log('[BACKFILL_GAME_LOGINS_CACHE] finished', {
    processed,
    wouldUpsert,
    upserted,
    errors,
  });
  console.log(JSON.stringify({
    collection: 'gameLogins',
    dry_run: DRY_RUN,
    limit: LIMIT || null,
    firebase_count_seen: snapshot.size,
    would_upsert: wouldUpsert,
    upserted,
    errors,
  }, null, 2));
}

main().catch((error) => {
  console.error('[BACKFILL_GAME_LOGINS_CACHE] fatal', error);
  process.exitCode = 1;
});
