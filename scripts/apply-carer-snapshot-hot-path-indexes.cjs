const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function clean(value) {
  return String(value || '').trim();
}

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
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

async function main() {
  loadEnvLocal();
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  const sqlPath = path.join(process.cwd(), 'migrations', '055_carer_snapshot_hot_path_indexes.sql');
  const sql = fs
    .readFileSync(sqlPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = sql
    .split(/;\s*/)
    .map((statement) => statement.trim())
    .filter(Boolean);

  const pool = new Pool({ connectionString });
  try {
    for (const statement of statements) {
      await pool.query(statement);
      console.log('[CARER_SNAPSHOT_INDEX_APPLIED]', statement.split(/\s+/).slice(0, 8).join(' '));
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[CARER_SNAPSHOT_INDEX_APPLY_FAILED]', error.message);
  process.exit(1);
});
