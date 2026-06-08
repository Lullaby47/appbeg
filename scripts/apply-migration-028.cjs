const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const connectionString = String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  const sqlPath = path.join(__dirname, '..', 'migrations', '028_player_session_authority.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query(sql);
    console.log('migration 028 applied');

    const dup = await client.query(`
      SELECT player_uid, COUNT(*)::int AS active_count
      FROM public.player_sessions_cache
      WHERE deleted_at IS NULL AND active = TRUE
      GROUP BY player_uid
      HAVING COUNT(*) > 1
    `);

    if (dup.rows.length > 0) {
      console.log('duplicate_active_sessions', JSON.stringify(dup.rows, null, 2));
      console.log('skipped unique index player_sessions_cache_one_active_per_player_idx');
      return;
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS player_sessions_cache_one_active_per_player_idx
      ON public.player_sessions_cache (player_uid)
      WHERE deleted_at IS NULL AND active = TRUE
    `);
    console.log('unique index player_sessions_cache_one_active_per_player_idx applied');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
