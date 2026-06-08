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

async function loadCoadminByCarer(pg) {
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

async function existingCarerUids(pg) {
  const result = await pg.query(
    'SELECT carer_uid FROM public.automation_auto_state_cache WHERE deleted_at IS NULL'
  );
  return new Set(result.rows.map((row) => String(row.carer_uid)));
}

async function upsert(pg, doc, coadminUid) {
  const data = doc.data() || {};
  const enabled = data.enabled === true;
  await pg.query(
    `
      INSERT INTO public.automation_auto_state_cache (
        carer_uid, coadmin_uid, enabled, automation_agent_id, lease_owner,
        lease_expires_at, updated_at, raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), $3, NULLIF($4, ''), NULLIF($5, ''),
        $6::timestamptz, $7::timestamptz, $8::jsonb, 'firebase_backfill', now(), NULL
      )
      ON CONFLICT (carer_uid) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        enabled = EXCLUDED.enabled,
        automation_agent_id = EXCLUDED.automation_agent_id,
        lease_owner = EXCLUDED.lease_owner,
        lease_expires_at = EXCLUDED.lease_expires_at,
        updated_at = EXCLUDED.updated_at,
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      doc.id,
      clean(coadminUid) || clean(data.coadminUid),
      enabled,
      clean(data.automationAgentId),
      clean(data.tickLeaseHolderId),
      toIso(data.tickLeaseExpiresAt),
      toIso(data.updatedAt),
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

  let query = db.collection('automation_auto_state');
  if (LIMIT) {
    query = query.limit(LIMIT);
  }
  const snap = await query.get();
  const skip = ONLY_MISSING ? await existingCarerUids(pg) : new Set();
  const coadminByCarer = await loadCoadminByCarer(pg);

  let wouldUpsert = 0;
  let upserted = 0;
  let errors = 0;

  for (const doc of snap.docs) {
    if (skip.has(doc.id)) continue;
    wouldUpsert++;
    if (DRY_RUN) continue;
    try {
      await upsert(pg, doc, coadminByCarer.get(doc.id) || null);
      upserted++;
    } catch (error) {
      errors++;
      console.error('[BACKFILL_AUTOMATION_AUTO_STATE_CACHE] failed', { carerUid: doc.id, error });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        collection: 'automation_auto_state',
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
  console.error('[BACKFILL_AUTOMATION_AUTO_STATE_CACHE] fatal', error);
  process.exitCode = 1;
});
