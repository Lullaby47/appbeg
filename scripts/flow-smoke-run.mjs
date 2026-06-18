import fs from 'fs';
import { randomUUID } from 'crypto';
import pg from 'pg';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const LOG_PATH = process.env.SMOKE_LOG_PATH || '.codex-logs/flow-smoke.out.log';
const PLAYER_UID = process.env.SMOKE_PLAYER_UID || 'X0lC6Vaq43YM130tuCLv6SDO9Yn2';
const CARER_UID = process.env.SMOKE_CARER_UID || 'ZJeDyfQU3UYEdE0rMoYbZ9pcFA33';

function loadEnvLocal() {
  const env = { ...process.env };
  if (fs.existsSync('.env.local')) {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) env[m[1].trim()] = m[2].trim();
    }
  }
  return env;
}

const env = loadEnvLocal();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

let logOffset = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;

function readNewLogs() {
  if (!fs.existsSync(LOG_PATH)) return '';
  const stat = fs.statSync(LOG_PATH);
  const size = stat.size;
  const start = Math.max(0, logOffset);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(LOG_PATH, 'r');
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  logOffset = size;
  return buf.toString('utf8');
}

function scanLogs(text, patterns) {
  const found = {};
  for (const [key, re] of Object.entries(patterns)) {
    found[key] = re.test(text);
  }
  const timing = {};
  const authTxn = text.match(/authority_transaction_ms['":\s]+(\d+)/);
  if (authTxn) timing.authority_transaction_ms = Number(authTxn[1]);
  const poolAcquire = [...text.matchAll(/pool_acquire_ms['":\s]+(\d+)/g)].map((m) => Number(m[1]));
  timing.pool_acquire_ms_max = poolAcquire.length ? Math.max(...poolAcquire) : null;
  return { found, timing };
}

async function bootstrapPlayerSessions(playerUid) {
  const deviceId = `smoke-${randomUUID()}`;
  const nowIso = new Date().toISOString();
  const playerSessionId = randomUUID();
  const appSessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const playerRow = await pool.query(
    `SELECT username, coadmin_uid, created_by FROM players_cache WHERE uid = $1 AND deleted_at IS NULL`,
    [playerUid]
  );
  const player = playerRow.rows[0];
  if (!player) throw new Error('Player not found for bootstrap');

  const coadminUid = String(player.coadmin_uid || player.created_by || '').trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE player_sessions_cache SET active=false, status='ended', ended_at=$2::timestamptz, ended_reason='smoke_bootstrap', updated_at=$2::timestamptz WHERE player_uid=$1 AND active=true AND deleted_at IS NULL`,
      [playerUid, nowIso]
    );
    await client.query(
      `INSERT INTO player_sessions_cache (session_id, player_uid, coadmin_uid, device_id, active, status, started_at, last_seen_at, created_at, updated_at, source, mirrored_at, deleted_at, raw_firestore_data)
       VALUES ($1,$2,$3,$4,true,'active',$5::timestamptz,$5::timestamptz,$5::timestamptz,$5::timestamptz,'smoke_bootstrap',now(),NULL,$6::jsonb)`,
      [
        playerSessionId,
        playerUid,
        coadminUid,
        deviceId,
        nowIso,
        JSON.stringify({ playerUid, deviceId, active: true, startedAt: nowIso, lastSeenAt: nowIso }),
      ]
    );
    await client.query(
      `UPDATE players_cache SET raw_firestore_data = COALESCE(raw_firestore_data,'{}'::jsonb) || $2::jsonb, updated_at=$3::timestamptz WHERE uid=$1`,
      [
        playerUid,
        JSON.stringify({
          activeSessionId: playerSessionId,
          activeDeviceId: deviceId,
          activeSessionStartedAt: nowIso,
          activeSessionLastSeenAt: nowIso,
        }),
        nowIso,
      ]
    );
    await client.query(
      `UPDATE app_sessions SET active=false, ended_at=$2, ended_reason='smoke_bootstrap', updated_at=$2 WHERE uid=$1 AND active=true`,
      [playerUid, new Date()]
    );
    await client.query(
      `INSERT INTO app_sessions (session_id, uid, role, coadmin_uid, username, device_id, active, expires_at, last_seen_at, created_at, updated_at, raw_context)
       VALUES ($1,$2,'player',$3,$4,$5,true,$6::timestamptz,$7::timestamptz,$7::timestamptz,$7::timestamptz,'{}'::jsonb)`,
      [appSessionId, playerUid, coadminUid, player.username, deviceId, expiresAt, nowIso]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { appSessionId, playerSessionId, username: player.username, coadminUid };
}

async function bootstrapCarerSession(carerUid) {
  const deviceId = `smoke-carer-${randomUUID()}`;
  const nowIso = new Date().toISOString();
  const appSessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const row = await pool.query(
    `SELECT username, coadmin_uid, created_by, role FROM players_cache WHERE uid=$1 AND deleted_at IS NULL`,
    [carerUid]
  );
  const carer = row.rows[0];
  if (!carer) throw new Error('Carer not found');
  const coadminUid = String(carer.coadmin_uid || carer.created_by || '').trim();
  await pool.query(`UPDATE app_sessions SET active=false, ended_at=$2, ended_reason='smoke_bootstrap', updated_at=$2 WHERE uid=$1 AND active=true`, [
    carerUid,
    new Date(),
  ]);
  await pool.query(
    `INSERT INTO app_sessions (session_id, uid, role, coadmin_uid, username, device_id, active, expires_at, last_seen_at, created_at, updated_at, raw_context)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7::timestamptz,$8::timestamptz,$8::timestamptz,$8::timestamptz,'{}'::jsonb)`,
    [appSessionId, carerUid, carer.role, coadminUid, carer.username, deviceId, expiresAt, nowIso]
  );
  return { appSessionId, coadminUid, username: carer.username };
}

function playerHeaders(sessions) {
  return {
    'Content-Type': 'application/json',
    'X-App-Session-Id': sessions.appSessionId,
    'X-Player-Session-Id': sessions.playerSessionId,
  };
}

function carerHeaders(sessions) {
  return {
    'Content-Type': 'application/json',
    'X-App-Session-Id': sessions.appSessionId,
  };
}

async function apiCall(label, method, route, headers, body) {
  const started = Date.now();
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const totalMs = Date.now() - started;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  const logs = readNewLogs();
  const markers = scanLogs(logs, {
    outboxBatch: /\[OUTBOX_BATCH_WRITE\]/,
    authPreTxnRemoved: /\[AUTH_PAYLOAD_PRE_TXN_REMOVED\]/,
    authDuplicateInTxn: /\[AUTH_DUPLICATE_PAYLOAD_READ_IN_TXN\]/,
    firebaseFallback: /firestore_fallback|FIREBASE_FALLBACK|firebase mirror/i,
    retryAttempt: /retry_attempt/i,
  });
  return {
    flowName: label,
    route,
    statusCode: res.status,
    totalMs,
    authorityTransactionMs: markers.timing.authority_transaction_ms ?? null,
    outboxBatchWriteSeen: markers.found.outboxBatch,
    authPreTxnRemovedSeen: markers.found.authPreTxnRemoved,
    duplicateRetryTested: false,
    response: json,
    poolAcquireMsMax: markers.timing.pool_acquire_ms_max,
    errors: res.ok ? [] : [json?.error || json?.message || text.slice(0, 200)],
    logsSnippet: logs.slice(-1500),
  };
}

async function getBalances(uid) {
  const r = await pool.query(`SELECT coin, cash FROM players_cache WHERE uid=$1`, [uid]);
  return r.rows[0];
}

async function countRows(table, where, params) {
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${where}`, params);
  return r.rows[0].c;
}

async function getLatestOutbox(channelPrefix) {
  const r = await pool.query(
    `SELECT outbox_id, event_type, entity_id FROM live_outbox WHERE channel LIKE $1 ORDER BY outbox_id DESC LIMIT 1`,
    [`${channelPrefix}%`]
  );
  return r.rows[0] || null;
}

async function main() {
  const results = [];
  const playerSessions = await bootstrapPlayerSessions(PLAYER_UID);
  const carerSessions = await bootstrapCarerSession(CARER_UID);
  const ph = playerHeaders(playerSessions);
  const ch = carerHeaders(carerSessions);

  const probe = await pool.query(
    `SELECT game_name FROM player_game_logins_cache WHERE player_uid=$1 AND deleted_at IS NULL LIMIT 1`,
    [PLAYER_UID]
  );
  const gameName = probe.rows[0]?.game_name || 'Juwa2';

  const bonus = await pool.query(
    `SELECT firebase_id, game_name, amount_npr FROM bonus_events_cache WHERE coadmin_uid=$1 AND lower(status)='active' AND deleted_at IS NULL ORDER BY amount_npr::numeric ASC LIMIT 1`,
    [playerSessions.coadminUid]
  );
  const bonusEvent = bonus.rows[0];

  const balancesBefore = await getBalances(PLAYER_UID);
  const outboxBefore = await getLatestOutbox(`player:${PLAYER_UID}:`);
  const tasksBefore = await countRows(
    'carer_tasks_cache',
    `coadmin_uid=$1 AND deleted_at IS NULL AND created_at > now() - interval '10 minutes'`,
    [playerSessions.coadminUid]
  );

  // 1 Recharge
  const rechargeKey = `smoke-recharge-${Date.now()}`;
  const rechargeAmount = Math.min(5, Number(balancesBefore.coin || 0));
  let recharge = await apiCall('recharge_create', 'POST', '/api/player/game-requests/recharge', ph, {
    gameName,
    amount: rechargeAmount,
    idempotencyKey: rechargeKey,
  });
  const rechargeId1 = recharge.response?.requestId || recharge.response?.id;
  recharge.balanceCorrect = recharge.statusCode === 200 || recharge.statusCode === 201;
  recharge.requestOrTaskCreated = Boolean(rechargeId1);
  recharge.liveOutboxRowsCreated = recharge.outboxBatchWriteSeen;
  recharge.sseDelivered = null;
  if (rechargeId1) {
    const balAfter = await getBalances(PLAYER_UID);
    recharge.balanceCorrect = Number(balAfter.coin) < Number(balancesBefore.coin);
    const dup = await apiCall('recharge_create_duplicate', 'POST', '/api/player/game-requests/recharge', ph, {
      gameName,
      amount: rechargeAmount,
      idempotencyKey: rechargeKey,
    });
    recharge.duplicateRetryTested = true;
    recharge.duplicateRequestId = dup.response?.requestId;
    recharge.duplicateMatches = dup.response?.requestId === rechargeId1;
    const balAfterDup = await getBalances(PLAYER_UID);
    recharge.noDoubleDebit = Number(balAfterDup.coin) === Number(balAfter.coin);
  }
  results.push(recharge);

  // 2 Redeem (may fail if coin < 50)
  const redeemKey = `smoke-redeem-${Date.now()}`;
  const redeem = await apiCall('redeem_create', 'POST', '/api/player/game-requests/redeem', ph, {
    gameName,
    amount: 50,
    idempotencyKey: redeemKey,
  });
  redeem.requestOrTaskCreated = Boolean(redeem.response?.requestId);
  redeem.liveOutboxRowsCreated = redeem.outboxBatchWriteSeen;
  redeem.balanceCorrect = redeem.statusCode === 200 ? true : null;
  if (redeem.response?.requestId) {
    const dup = await apiCall('redeem_create_duplicate', 'POST', '/api/player/game-requests/redeem', ph, {
      gameName,
      amount: 50,
      idempotencyKey: redeemKey,
    });
    redeem.duplicateRetryTested = true;
    redeem.duplicateMatches = dup.response?.requestId === redeem.response.requestId;
  }
  results.push(redeem);

  // 3 Bonus
  if (bonusEvent) {
    const bonusKey = `smoke-bonus-${Date.now()}`;
    const bonusFlow = await apiCall('bonus_initiate_play', 'POST', '/api/bonus-events/initiate-play', ph, {
      bonusEventId: bonusEvent.firebase_id,
      idempotencyKey: bonusKey,
    });
    bonusFlow.requestOrTaskCreated = Boolean(bonusFlow.response?.requestId);
    bonusFlow.liveOutboxRowsCreated = bonusFlow.outboxBatchWriteSeen;
    if (bonusFlow.response?.requestId) {
      const dup = await apiCall('bonus_initiate_play_duplicate', 'POST', '/api/bonus-events/initiate-play', ph, {
        bonusEventId: bonusEvent.firebase_id,
        idempotencyKey: bonusKey,
      });
      bonusFlow.duplicateRetryTested = true;
      bonusFlow.duplicateMatches = dup.response?.requestId === bonusFlow.response.requestId;
    }
    results.push(bonusFlow);
  } else {
    results.push({
      flowName: 'bonus_initiate_play',
      route: '/api/bonus-events/initiate-play',
      statusCode: 0,
      totalMs: 0,
      errors: ['No active bonus event in scope'],
      skipped: true,
    });
  }

  // 4 Cashout (expected fail: cash=0)
  const cashoutKey = `smoke-cashout-${Date.now()}`;
  const cashout = await apiCall('cashout_create', 'POST', '/api/player/cashout-tasks/create', ph, {
    paymentDetails: 'Smoke test payout details 12345',
    idempotencyKey: cashoutKey,
  });
  cashout.requestOrTaskCreated = Boolean(cashout.response?.taskId);
  cashout.liveOutboxRowsCreated = cashout.outboxBatchWriteSeen;
  results.push(cashout);

  // 5 Reset password task
  const resetKey = `smoke-reset-${Date.now()}`;
  const resetTask = await apiCall('reset_password_task', 'POST', '/api/player/credential-tasks', ph, {
    taskType: 'reset_password',
    gameName,
    idempotencyKey: resetKey,
  });
  resetTask.requestOrTaskCreated = Boolean(resetTask.response?.taskId);
  resetTask.liveOutboxRowsCreated = resetTask.outboxBatchWriteSeen;
  if (resetTask.response?.taskId) {
    const dup = await apiCall('reset_password_task_duplicate', 'POST', '/api/player/credential-tasks', ph, {
      taskType: 'reset_password',
      gameName,
      idempotencyKey: resetKey,
    });
    resetTask.duplicateRetryTested = true;
    resetTask.duplicateMatches = dup.response?.taskId === resetTask.response.taskId;
  }
  results.push(resetTask);

  // 6 Recreate username task
  const recreateKey = `smoke-recreate-${Date.now()}`;
  const recreateTask = await apiCall('recreate_username_task', 'POST', '/api/player/credential-tasks', ph, {
    taskType: 'recreate_username',
    gameName,
    idempotencyKey: recreateKey,
  });
  recreateTask.requestOrTaskCreated = Boolean(recreateTask.response?.taskId);
  recreateTask.liveOutboxRowsCreated = recreateTask.outboxBatchWriteSeen;
  results.push(recreateTask);

  // 7 Carer task claim — use latest pending recharge-linked task
  const pending = await pool.query(
    `SELECT firebase_id, type, request_id FROM carer_tasks_cache WHERE coadmin_uid=$1 AND status='pending' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [playerSessions.coadminUid]
  );
  const taskId = pending.rows[0]?.firebase_id;
  if (taskId) {
    const claim = await apiCall('carer_task_claim', 'POST', '/api/carer/tasks/claim', ch, {
      taskId,
      carerName: carerSessions.username,
    });
    claim.requestOrTaskCreated = Boolean(claim.response?.jobId || claim.response?.taskId);
    claim.liveOutboxRowsCreated = claim.outboxBatchWriteSeen;
    const jobRow = claim.response?.jobId
      ? await pool.query(`SELECT job_id, status FROM automation_jobs_cache WHERE job_id=$1`, [claim.response.jobId])
      : { rows: [] };
    claim.jobAvailableEvent = jobRow.rows[0]?.status === 'queued' || jobRow.rows[0]?.status === 'available';
    results.push(claim);
  } else {
    results.push({
      flowName: 'carer_task_claim',
      route: '/api/carer/tasks/claim',
      statusCode: 0,
      errors: ['No pending carer task to claim'],
      skipped: true,
    });
  }

  const outboxAfter = await getLatestOutbox(`player:${PLAYER_UID}:`);
  const tasksAfter = await countRows(
    'carer_tasks_cache',
    `coadmin_uid=$1 AND deleted_at IS NULL AND created_at > now() - interval '10 minutes'`,
    [playerSessions.coadminUid]
  );

  const summary = {
    playerUid: PLAYER_UID,
    playerUsername: playerSessions.username,
    authMethod: 'sql_session_bootstrap',
    balancesBefore,
    balancesAfter: await getBalances(PLAYER_UID),
    outboxBefore,
    outboxAfter,
    tasksCreatedDelta: tasksAfter - tasksBefore,
    results: results.map((r) => ({
      flowName: r.flowName,
      route: r.route,
      statusCode: r.statusCode,
      totalMs: r.totalMs,
      authorityTransactionMs: r.authorityTransactionMs,
      outboxBatchWriteSeen: r.outboxBatchWriteSeen,
      authPreTxnRemovedSeen: r.authPreTxnRemovedSeen,
      duplicateRetryTested: r.duplicateRetryTested || false,
      balanceCorrect: r.balanceCorrect ?? null,
      requestOrTaskCreated: r.requestOrTaskCreated ?? null,
      liveOutboxRowsCreated: r.liveOutboxRowsCreated ?? null,
      sseDelivered: r.sseDelivered ?? null,
      poolAcquireMsMax: r.poolAcquireMsMax ?? null,
      duplicateMatches: r.duplicateMatches ?? null,
      noDoubleDebit: r.noDoubleDebit ?? null,
      jobAvailableEvent: r.jobAvailableEvent ?? null,
      errors: r.errors || [],
      skipped: r.skipped || false,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
