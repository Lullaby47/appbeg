import fs from 'fs';
import pg from 'pg';

const env = {};
for (const l of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const uid = 'X0lC6Vaq43YM130tuCLv6SDO9Yn2';
const [r, t, o, fe] = await Promise.all([
  pool.query(
    `SELECT firebase_id,type,status,created_at FROM player_game_requests_cache WHERE player_uid=$1 AND created_at > now()-interval '15 minutes' ORDER BY created_at DESC`,
    [uid]
  ),
  pool.query(
    `SELECT firebase_id,type,status FROM carer_tasks_cache WHERE player_uid=$1 AND created_at > now()-interval '15 minutes' AND deleted_at IS NULL`,
    [uid]
  ),
  pool.query(
    `SELECT outbox_id,event_type,entity_id FROM live_outbox WHERE channel LIKE $1 AND outbox_id > 4635 ORDER BY outbox_id`,
    [`player:${uid}:%`]
  ),
  pool.query(
    `SELECT firebase_id,type,amount_npr,created_at FROM financial_events_cache WHERE player_uid=$1 AND created_at > now()-interval '15 minutes'`,
    [uid]
  ),
]);
console.log(JSON.stringify({ requests: r.rows, tasks: t.rows, outbox: o.rows, financial: fe.rows }, null, 2));
await pool.end();
