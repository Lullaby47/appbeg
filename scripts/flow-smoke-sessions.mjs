import fs from 'fs';
import pg from 'pg';

function loadEnvLocal() {
  const env = { ...process.env };
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
  return env;
}

const pool = new pg.Pool({ connectionString: loadEnvLocal().DATABASE_URL });
const uid = 'X0lC6Vaq43YM130tuCLv6SDO9Yn2';
const r = await pool.query(
  `SELECT * FROM player_sessions_cache WHERE player_uid = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 5`,
  [uid]
);
console.log(JSON.stringify(r.rows, null, 2));
await pool.end();
