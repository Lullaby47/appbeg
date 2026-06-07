const fs = require('fs');
const { Pool } = require('pg');

function loadEnv() {
  if (!fs.existsSync('.env.local')) return;
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0 && !process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
}

async function main() {
  loadEnv();
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  const uid = process.argv[2] || 'ZJeDyfQU3UYEdE0rMoYbZ9pcFA33';
  const row = await pg.query(
    'SELECT uid, role, coadmin_uid, created_by FROM public.players_cache WHERE uid = $1',
    [uid]
  );
  const count = await pg.query(
    "SELECT COUNT(*)::int AS n FROM public.players_cache WHERE role = 'carer' AND deleted_at IS NULL"
  );
  console.log('profile', row.rows[0] || null);
  console.log('carer_count', count.rows[0]?.n || 0);
  await pg.end();
}

main().catch(console.error);
