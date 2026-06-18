import fs from 'fs';
import pg from 'pg';

function loadEnvLocal() {
  const env = { ...process.env };
  const path = '.env.local';
  if (!fs.existsSync(path)) return env;
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
  return env;
}

const env = loadEnvLocal();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const uid = process.env.SMOKE_PLAYER_UID || 'X0lC6Vaq43YM130tuCLv6SDO9Yn2';

const playerRes = await pool.query(
  `SELECT uid, username, coin, cash, coadmin_uid, status FROM players_cache WHERE uid = $1 AND deleted_at IS NULL`,
  [uid]
);
const player = playerRes.rows[0];
if (!player) {
  console.error('Player not found');
  process.exit(1);
}

const [sess, games, bonus, pending, carer, psess, outboxRecent] = await Promise.all([
  pool.query(
    `SELECT session_id, expires_at FROM app_sessions WHERE uid = $1 AND expires_at > now() ORDER BY expires_at DESC LIMIT 3`,
    [uid]
  ),
  pool.query(
    `SELECT game_name, firebase_id FROM player_game_logins_cache WHERE player_uid = $1 AND deleted_at IS NULL LIMIT 5`,
    [uid]
  ),
  pool.query(
    `SELECT firebase_id, game_name, amount_npr, status FROM bonus_events_cache WHERE coadmin_uid = $1 AND deleted_at IS NULL AND lower(status) = 'active' LIMIT 5`,
    [player.coadmin_uid]
  ),
  pool.query(
    `SELECT firebase_id, type, status, request_id FROM carer_tasks_cache WHERE coadmin_uid = $1 AND status = 'pending' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
    [player.coadmin_uid]
  ),
  pool.query(
    `SELECT uid, username, role FROM players_cache WHERE coadmin_uid = $1 AND lower(role) = 'carer' AND deleted_at IS NULL LIMIT 3`,
    [player.coadmin_uid]
  ),
  pool.query(
    `SELECT session_id, expires_at FROM player_sessions_cache WHERE player_uid = $1 AND expires_at > now() ORDER BY expires_at DESC LIMIT 3`,
    [uid]
  ),
  pool.query(
    `SELECT outbox_id, channel, event_type, entity_id, created_at FROM live_outbox WHERE channel LIKE $1 ORDER BY outbox_id DESC LIMIT 5`,
    [`player:${uid}:%`]
  ),
]);

console.log(
  JSON.stringify(
    {
      player,
      appSessions: sess.rows,
      playerSessions: psess.rows,
      games: games.rows,
      bonusEvents: bonus.rows,
      pendingTasks: pending.rows,
      carers: carer.rows,
      recentOutbox: outboxRecent.rows,
      smokeUsername: env.SMOKE_TEST_USERNAME || null,
      hasSmokePassword: Boolean(env.SMOKE_TEST_PASSWORD),
    },
    null,
    2
  )
);

await pool.end();
