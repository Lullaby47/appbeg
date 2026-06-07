#!/usr/bin/env node

const admin = require('firebase-admin');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY_MISSING = args.includes('--only-missing');

function readArgNumber(name) {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return Number(eq.slice(name.length + 1)) || 0;
  const idx = args.indexOf(name);
  if (idx >= 0) return Number(args[idx + 1]) || 0;
  return 0;
}

const LIMIT = readArgNumber('--limit');

function clean(value) {
  return String(value || '').trim();
}

function normalizeGameName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.toMillis === 'function') return new Date(value.toMillis());
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
  }
  return null;
}

function toIso(value) {
  return toDate(value)?.toISOString() || null;
}

function jsonSafe(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

function requiredEnv(name) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function initFirebase() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(
    Buffer.from(requiredEnv('FIREBASE_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

async function upsertRow(pg, doc) {
  const data = doc.data() || {};
  const gameName = clean(data.gameName);
  const playerUid = clean(data.playerUid);
  const normalizedGameName = normalizeGameName(gameName);
  if (!playerUid || !gameName || !normalizedGameName) {
    throw new Error(`Missing required playerUid/gameName for ${doc.id}`);
  }

  await pg.query(
    `
      INSERT INTO public.player_game_logins_cache (
        firebase_id, player_uid, player_username, game_name, normalized_game_name,
        game_username, game_password, game_account_username, game_account_password,
        current_username, current_password, frontend_url, site_url, coadmin_uid, created_by,
        updated_by_automation_job_id, updated_by_carer_uid, created_at, updated_at,
        source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, $2, NULLIF($3, ''), $4, $5, NULLIF($6, ''), NULLIF($7, ''),
        NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''),
        NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''), NULLIF($15, ''),
        NULLIF($16, ''), NULLIF($17, ''), $18::timestamptz, $19::timestamptz,
        'firebase_backfill', now(), NULL, $20::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        player_uid = EXCLUDED.player_uid,
        player_username = EXCLUDED.player_username,
        game_name = EXCLUDED.game_name,
        normalized_game_name = EXCLUDED.normalized_game_name,
        game_username = EXCLUDED.game_username,
        game_password = EXCLUDED.game_password,
        game_account_username = EXCLUDED.game_account_username,
        game_account_password = EXCLUDED.game_account_password,
        current_username = EXCLUDED.current_username,
        current_password = EXCLUDED.current_password,
        frontend_url = EXCLUDED.frontend_url,
        site_url = EXCLUDED.site_url,
        coadmin_uid = EXCLUDED.coadmin_uid,
        created_by = EXCLUDED.created_by,
        updated_by_automation_job_id = EXCLUDED.updated_by_automation_job_id,
        updated_by_carer_uid = EXCLUDED.updated_by_carer_uid,
        created_at = COALESCE(public.player_game_logins_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      doc.id,
      playerUid,
      clean(data.playerUsername),
      gameName,
      normalizedGameName,
      clean(data.gameUsername),
      clean(data.gamePassword),
      clean(data.gameAccountUsername),
      clean(data.gameAccountPassword),
      clean(data.currentUsername),
      clean(data.currentPassword),
      clean(data.frontendUrl),
      clean(data.siteUrl),
      clean(data.coadminUid),
      clean(data.createdBy),
      clean(data.updatedByAutomationJobId),
      clean(data.updatedByCarerUid),
      toIso(data.createdAt),
      toIso(data.updatedAt),
      JSON.stringify(jsonSafe(data) || {}),
    ]
  );
}

async function main() {
  initFirebase();
  const db = admin.firestore();
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || requiredEnv('DATABASE_URL'),
  });

  const existing = ONLY_MISSING
    ? new Set(
        (await pg.query('SELECT firebase_id FROM public.player_game_logins_cache WHERE deleted_at IS NULL')).rows.map(
          (row) => String(row.firebase_id)
        )
      )
    : new Set();

  let query = db.collection('playerGameLogins');
  if (LIMIT) query = query.limit(LIMIT);
  console.log('[BACKFILL_PLAYER_GAME_LOGINS_CACHE] starting Firestore read', { dryRun: DRY_RUN, limit: LIMIT || null, onlyMissing: ONLY_MISSING });
  const snapshot = await query.get();
  console.log('[BACKFILL_PLAYER_GAME_LOGINS_CACHE] Firestore read complete', { count: snapshot.size });

  let firebase_count_seen = 0;
  let would_upsert = 0;
  let upserted = 0;
  let errors = 0;

  for (const doc of snapshot.docs) {
    firebase_count_seen += 1;
    if (firebase_count_seen % 25 === 0) {
      console.log('[BACKFILL_PLAYER_GAME_LOGINS_CACHE] progress', { seen: firebase_count_seen, upserted, errors });
    }
    if (existing.has(doc.id)) continue;
    would_upsert += 1;
    if (DRY_RUN) continue;
    try {
      await upsertRow(pg, doc);
      upserted += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_PLAYER_GAME_LOGINS_CACHE] failed', { firebaseId: doc.id, error });
    }
  }

  await pg.end();
  console.log(
    JSON.stringify(
      { collection: 'playerGameLogins', firebase_count_seen, would_upsert, upserted, errors },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
