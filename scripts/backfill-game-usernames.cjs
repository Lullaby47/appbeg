const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');

const GAME_USERNAME_PATTERN = /^[A-Z][A-Za-z]*_?[0-9]+$/;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function clean(value, maxLength) {
  const text = String(value || '').trim();
  return maxLength ? text.slice(0, maxLength) : text;
}

function initFirebase() {
  const base64 = requiredEnv('FIREBASE_SERVICE_ACCOUNT_BASE64');
  const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  return getApps().length === 0
    ? initializeApp({ credential: cert(serviceAccount) })
    : getApps()[0];
}

function createPgPool() {
  return new Pool({
    host: clean(process.env.APPBEG_PG_HOST || '127.0.0.1'),
    port: Number(process.env.APPBEG_PG_PORT || '5433'),
    database: clean(process.env.APPBEG_PG_DATABASE || 'appbeg'),
    user: clean(process.env.APPBEG_PG_USER || 'appbeg_user'),
    password: requiredEnv('APPBEG_PG_PASSWORD'),
    max: 5,
    connectionTimeoutMillis: 10_000,
  });
}

async function ensurePg(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_usernames (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      game VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  const statements = [
    'ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS player_uid TEXT NULL',
    'ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS coadmin_uid TEXT NULL',
    'ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS source TEXT NULL',
    "ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'",
    'ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()',
    "ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS raw_json JSONB NOT NULL DEFAULT '{}'::jsonb",
    'ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ NULL',
    'ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS deactivate_reason TEXT NULL',
    'ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    'ALTER TABLE game_usernames DROP CONSTRAINT IF EXISTS game_usernames_username_key',
    'DROP INDEX IF EXISTS game_usernames_username_idx',
    'DROP INDEX IF EXISTS game_usernames_active_username_unique',
    "CREATE UNIQUE INDEX IF NOT EXISTS game_usernames_active_coadmin_username_unique ON game_usernames (coadmin_uid, lower(username)) WHERE status = 'active' AND coadmin_uid IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS game_usernames_active_global_username_unique ON game_usernames (lower(username)) WHERE status = 'active' AND coadmin_uid IS NULL",
    'CREATE INDEX IF NOT EXISTS game_usernames_game_idx ON game_usernames (game)',
    'CREATE INDEX IF NOT EXISTS game_usernames_coadmin_uid_idx ON game_usernames (coadmin_uid)',
  ];
  for (const statement of statements) {
    await pool.query(statement);
  }
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  await ensurePg(pool);

  const snapshot = await db.collection('playerGameLogins').get();
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const username = clean(data.gameUsername, 100);
    const game = clean(data.gameName || 'unknown', 50);
    if (!username || !game) {
      skipped += 1;
      continue;
    }
    if (!GAME_USERNAME_PATTERN.test(username)) {
      skipped += 1;
      console.warn('[BACKFILL_GAME_USERNAMES] skipped invalid username', {
        docId: doc.id,
        username,
      });
      continue;
    }

    try {
      const playerUid = clean(data.playerUid) || null;
      const coadminUid = clean(data.coadminUid || data.createdBy) || null;
      const updateResult = await pool.query(
        `
          UPDATE game_usernames
          SET game = $2,
              player_uid = COALESCE($3, player_uid),
              coadmin_uid = $4,
              source = COALESCE(source, 'firebase_backfill'),
              status = 'active',
              updated_at = NOW(),
              mirrored_at = NOW()
          WHERE lower(username) = lower($1)
            AND status = 'active'
            AND (
              (coadmin_uid = $4)
              OR (coadmin_uid IS NULL AND $4::text IS NULL)
            )
        `,
        [username, game, playerUid, coadminUid]
      );
      if (updateResult.rowCount > 0) {
        skipped += 1;
        continue;
      }

      const result = await pool.query(
        `
          INSERT INTO game_usernames (username, game, player_uid, coadmin_uid, source, status, updated_at)
          VALUES ($1, $2, $3, $4, 'firebase_backfill', 'active', NOW())
          RETURNING (xmax = 0) AS inserted
        `,
        [username, game, playerUid, coadminUid]
      );
      if (result.rows[0]?.inserted) inserted += 1;
      else skipped += 1;
    } catch (error) {
      errors += 1;
      console.error('[BACKFILL_GAME_USERNAMES] failed', {
        docId: doc.id,
        username,
        game,
        error,
      });
    }
  }

  await pool.end();
  console.log(`Backfill complete. inserted=${inserted} skipped=${skipped} errors=${errors}`);
}

main().catch((error) => {
  console.error('[BACKFILL_GAME_USERNAMES] fatal', error);
  process.exitCode = 1;
});
