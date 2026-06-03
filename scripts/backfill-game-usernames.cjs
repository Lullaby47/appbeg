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
      username VARCHAR(100) UNIQUE NOT NULL,
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
    'CREATE UNIQUE INDEX IF NOT EXISTS game_usernames_username_idx ON game_usernames (username)',
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
      const result = await pool.query(
        `
          INSERT INTO game_usernames (username, game, player_uid, coadmin_uid, source, status, updated_at)
          VALUES ($1, $2, $3, $4, 'firebase_backfill', 'active', NOW())
          ON CONFLICT (username) DO UPDATE SET
            game = EXCLUDED.game,
            player_uid = COALESCE(EXCLUDED.player_uid, game_usernames.player_uid),
            coadmin_uid = COALESCE(EXCLUDED.coadmin_uid, game_usernames.coadmin_uid),
            source = COALESCE(game_usernames.source, EXCLUDED.source),
            status = 'active',
            updated_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `,
        [
          username,
          game,
          clean(data.playerUid) || null,
          clean(data.coadminUid || data.createdBy) || null,
        ]
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
