const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const args = new Map(
  process.argv.slice(2).map((a, i, arr) =>
    a.startsWith('--')
      ? [
          a.split('=')[0],
          a.includes('=')
            ? a.split('=').slice(1).join('=')
            : arr[i + 1]?.startsWith('--')
              ? 'true'
              : arr[i + 1] || 'true',
        ]
      : [a, 'true']
  )
);
const DRY_RUN = args.has('--dry-run');
const ONLY_MISSING = args.has('--only-missing');
const LIMIT = Number(args.get('--limit') || 0) || 0;

function clean(value) {
  return String(value || '').trim();
}

function loadEnvLocal() {
  for (const fileName of ['.env.local', '.env']) {
    const envPath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(envPath)) continue;
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
}

function required(name) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function initApp() {
  const serviceAccount = JSON.parse(
    Buffer.from(required('FIREBASE_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8')
  );
  return getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value.toMillis === 'function') return new Date(value.toMillis()).toISOString();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
  return null;
}

function normalizeJson(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const asDate = toIso(value);
    if (asDate) return asDate;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeJson(child)])
    );
  }
  return value;
}

function sessionStatus(active, endedAt) {
  if (endedAt) return 'ended';
  return active ? 'active' : 'inactive';
}

async function loadCoadminByPlayer(pg) {
  const result = await pg.query(
    `
      SELECT uid, COALESCE(NULLIF(coadmin_uid, ''), NULLIF(created_by, '')) AS coadmin_uid
      FROM public.players_cache
      WHERE deleted_at IS NULL
    `
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(String(row.uid), clean(row.coadmin_uid) || null);
  }
  return map;
}

async function existingSessionIds(pg) {
  const result = await pg.query(
    'SELECT session_id FROM public.player_sessions_cache WHERE deleted_at IS NULL'
  );
  return new Set(result.rows.map((row) => String(row.session_id)));
}

async function upsert(pg, doc, coadminUid) {
  const data = doc.data() || {};
  const active = typeof data.active === 'boolean' ? data.active : true;
  const endedAt = toIso(data.endedAt);
  await pg.query(
    `
      INSERT INTO public.player_sessions_cache (
        session_id, player_uid, coadmin_uid, device_id, active, status,
        started_at, last_seen_at, ended_at, ended_reason, expires_at,
        created_at, updated_at, raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, NULLIF($6, ''),
        $7::timestamptz, $8::timestamptz, $9::timestamptz, NULLIF($10, ''),
        $11::timestamptz, $12::timestamptz, $13::timestamptz,
        $14::jsonb, 'firebase_backfill', now(), NULL
      )
      ON CONFLICT (session_id) DO UPDATE SET
        player_uid = EXCLUDED.player_uid,
        coadmin_uid = EXCLUDED.coadmin_uid,
        device_id = EXCLUDED.device_id,
        active = EXCLUDED.active,
        status = EXCLUDED.status,
        started_at = COALESCE(public.player_sessions_cache.started_at, EXCLUDED.started_at),
        last_seen_at = EXCLUDED.last_seen_at,
        ended_at = EXCLUDED.ended_at,
        ended_reason = EXCLUDED.ended_reason,
        expires_at = EXCLUDED.expires_at,
        created_at = COALESCE(public.player_sessions_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      doc.id,
      clean(data.playerUid),
      clean(coadminUid),
      clean(data.deviceId),
      active,
      sessionStatus(active, endedAt),
      toIso(data.startedAt),
      toIso(data.lastSeenAt),
      endedAt,
      clean(data.endedReason),
      toIso(data.expiresAt),
      toIso(data.startedAt),
      toIso(data.lastSeenAt) || endedAt,
      JSON.stringify(normalizeJson(data) || {}),
    ]
  );
}

async function main() {
  loadEnvLocal();
  initApp();
  const db = getFirestore();
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || required('DATABASE_URL'),
    connectionTimeoutMillis: 10000,
  });

  let query = db.collection('playerSessions');
  if (LIMIT) {
    query = query.limit(LIMIT);
  }
  const snap = await query.get();
  const skip = ONLY_MISSING ? await existingSessionIds(pg) : new Set();
  const coadminByPlayer = await loadCoadminByPlayer(pg);

  let wouldUpsert = 0;
  let upserted = 0;
  let errors = 0;

  for (const doc of snap.docs) {
    if (skip.has(doc.id)) continue;
    wouldUpsert++;
    if (DRY_RUN) continue;
    try {
      const playerUid = clean((doc.data() || {}).playerUid);
      await upsert(pg, doc, coadminByPlayer.get(playerUid) || null);
      upserted++;
    } catch (error) {
      errors++;
      console.error('[BACKFILL_PLAYER_SESSIONS_CACHE] failed', { sessionId: doc.id, error });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        collection: 'playerSessions',
        firebase_count_seen: snap.size,
        would_upsert: wouldUpsert,
        upserted,
        errors,
        dry_run: DRY_RUN,
        only_missing: ONLY_MISSING,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[BACKFILL_PLAYER_SESSIONS_CACHE] fatal', error);
  process.exitCode = 1;
});
