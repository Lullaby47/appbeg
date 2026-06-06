const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function clean(value) {
  return String(value || '').trim();
}

async function main() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  const fileArg = process.argv[2];

  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  if (!fileArg) {
    throw new Error('Usage: node scripts/run-sql-file.cjs <sql-file>');
  }

  const sqlPath = path.resolve(process.cwd(), fileArg);
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(sql);
    console.log(`[RUN_SQL_FILE] success ${sqlPath}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[RUN_SQL_FILE] fatal', error.message);
  process.exit(1);
});
