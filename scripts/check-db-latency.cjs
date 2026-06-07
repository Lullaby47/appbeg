const { Client, Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function clean(value) {
  return String(value || '').trim();
}

function loadEnvLocal() {
  for (const fileName of ['.env.local', '.env']) {
    const envPath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(envPath)) continue;
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
}

function summarize(label, samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const avg = samples.length ? total / samples.length : 0;
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  console.log(
    `[DB_LATENCY] ${label} count=${samples.length} min=${sorted[0] || 0}ms avg=${Math.round(avg)}ms p50=${p50}ms p95=${p95}ms max=${sorted[sorted.length - 1] || 0}ms`
  );
}

async function main() {
  loadEnvLocal();
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  console.log('[DB_LATENCY] target=%s', connectionString.replace(/:[^:@/]+@/, ':***@'));

  const firstConnectStartedAt = Date.now();
  const client = new Client({ connectionString });
  await client.connect();
  const firstConnectMs = Date.now() - firstConnectStartedAt;
  console.log('[DB_LATENCY] first_connect_ms=%s', firstConnectMs);

  const sameClientSamples = [];
  for (let index = 0; index < 5; index += 1) {
    const startedAt = Date.now();
    await client.query('SELECT 1');
    sameClientSamples.push(Date.now() - startedAt);
  }
  summarize('same_client_select_1', sameClientSamples);
  await client.end();

  const pool = new Pool({
    connectionString,
    max: 4,
    min: 1,
    idleTimeoutMillis: 120_000,
  });

  const poolFirstAcquireStartedAt = Date.now();
  const pooledClient = await pool.connect();
  const poolFirstAcquireMs = Date.now() - poolFirstAcquireStartedAt;
  console.log('[DB_LATENCY] pool_first_acquire_ms=%s', poolFirstAcquireMs);

  const poolReuseSamples = [];
  for (let index = 0; index < 5; index += 1) {
    const startedAt = Date.now();
    await pooledClient.query('SELECT 1');
    poolReuseSamples.push(Date.now() - startedAt);
  }
  summarize('pool_same_client_select_1', poolReuseSamples);
  pooledClient.release();

  const sequentialAcquireSamples = [];
  const sequentialQuerySamples = [];
  for (let index = 0; index < 10; index += 1) {
    const acquireStartedAt = Date.now();
    const sequentialClient = await pool.connect();
    sequentialAcquireSamples.push(Date.now() - acquireStartedAt);

    const queryStartedAt = Date.now();
    await sequentialClient.query('SELECT 1');
    sequentialQuerySamples.push(Date.now() - queryStartedAt);
    sequentialClient.release();
  }
  summarize('sequential_pool_acquire', sequentialAcquireSamples);
  summarize('sequential_query_exec', sequentialQuerySamples);

  const parallelStartedAt = Date.now();
  const parallelResults = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const acquireStartedAt = Date.now();
      const parallelClient = await pool.connect();
      const pool_acquire_ms = Date.now() - acquireStartedAt;
      const queryStartedAt = Date.now();
      await parallelClient.query('SELECT 1');
      const query_exec_ms = Date.now() - queryStartedAt;
      parallelClient.release();
      return { pool_acquire_ms, query_exec_ms, total_ms: pool_acquire_ms + query_exec_ms };
    })
  );
  console.log('[DB_LATENCY] parallel_wall_ms=%s', Date.now() - parallelStartedAt);
  summarize(
    'parallel_pool_acquire',
    parallelResults.map((item) => item.pool_acquire_ms)
  );
  summarize(
    'parallel_query_exec',
    parallelResults.map((item) => item.query_exec_ms)
  );
  summarize(
    'parallel_total_per_query',
    parallelResults.map((item) => item.total_ms)
  );

  console.log('[DB_LATENCY] pool_stats', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });

  const sameClientAvg =
    sameClientSamples.reduce((sum, value) => sum + value, 0) / (sameClientSamples.length || 1);
  const sequentialAcquireAvg =
    sequentialAcquireSamples.reduce((sum, value) => sum + value, 0) /
    (sequentialAcquireSamples.length || 1);
  const sequentialQueryAvg =
    sequentialQuerySamples.reduce((sum, value) => sum + value, 0) /
    (sequentialQuerySamples.length || 1);

  console.log('[DB_LATENCY] diagnosis', {
    likely_vps_network_latency:
      firstConnectMs > 500 || sameClientAvg > 200 || sequentialQueryAvg > 200,
    likely_ssl_connection_setup:
      firstConnectMs > 800 && sameClientAvg < firstConnectMs * 0.4,
    likely_new_connection_per_query:
      sequentialAcquireAvg > 200 && sequentialQueryAvg < 100,
    likely_pool_reuse_working:
      sequentialAcquireAvg < 50 && poolReuseSamples.every((value) => value < sameClientAvg * 1.5),
    likely_database_overloaded:
      sameClientSamples.some((value) => value > sameClientAvg * 3) ||
      sequentialQuerySamples.some((value) => value > sequentialQueryAvg * 3),
    note:
      'If same_client and query_exec are both ~400ms+, each SQL round-trip pays VPS RTT even with a warm connection.',
  });

  await pool.end();
}

main().catch((error) => {
  console.error('[DB_LATENCY] failed', error);
  process.exitCode = 1;
});
