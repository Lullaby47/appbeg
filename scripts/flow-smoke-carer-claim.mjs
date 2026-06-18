import fs from 'fs';
import { randomUUID } from 'crypto';
import pg from 'pg';

const env = {};
for (const l of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const CARER_UID = 'ZJeDyfQU3UYEdE0rMoYbZ9pcFA33';
const COADMIN_UID = 'pNaCcFpMHccu5l3TgLSKvldtrOB2';
const BASE = 'http://localhost:3000';

await pool.query(
  `INSERT INTO automation_auto_state_cache (carer_uid, coadmin_uid, enabled, automation_agent_id, updated_at, raw_firestore_data, source, mirrored_at, deleted_at)
   VALUES ($1,$2,true,'car001',now(),'{}'::jsonb,'smoke_test',now(),NULL)
   ON CONFLICT (carer_uid) DO UPDATE SET enabled=true, coadmin_uid=EXCLUDED.coadmin_uid, automation_agent_id=EXCLUDED.automation_agent_id, updated_at=now(), mirrored_at=now(), deleted_at=NULL`,
  [CARER_UID, COADMIN_UID]
);

const appSessionId = randomUUID();
const nowIso = new Date().toISOString();
const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
await pool.query(`UPDATE app_sessions SET active=false, ended_at=now(), ended_reason='smoke_claim', updated_at=now() WHERE uid=$1 AND active=true`, [CARER_UID]);
await pool.query(
  `INSERT INTO app_sessions (session_id, uid, role, coadmin_uid, username, device_id, active, expires_at, last_seen_at, created_at, updated_at, raw_context)
   VALUES ($1,$2,'carer',$3,'charliecarer',$4,true,$5::timestamptz,$6::timestamptz,$6::timestamptz,$6::timestamptz,'{}'::jsonb)`,
  [appSessionId, CARER_UID, COADMIN_UID, `smoke-claim-${randomUUID()}`, expiresAt, nowIso]
);

const task = await pool.query(
  `SELECT firebase_id FROM carer_tasks_cache WHERE coadmin_uid=$1 AND status='pending' AND type='recharge' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  [COADMIN_UID]
);
const taskId = task.rows[0]?.firebase_id;
if (!taskId) {
  console.log(JSON.stringify({ error: 'no pending recharge task' }));
  await pool.end();
  process.exit(0);
}

const outboxBefore = await pool.query(`SELECT max(outbox_id)::bigint AS m FROM live_outbox WHERE channel LIKE 'carer:%'`);
const started = Date.now();
const res = await fetch(`${BASE}/api/carer/tasks/claim`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Session-Id': appSessionId },
  body: JSON.stringify({ taskId, carerName: 'charliecarer' }),
});
const json = await res.json();
const job = json.jobId
  ? (await pool.query(`SELECT job_id, status FROM automation_jobs_cache WHERE job_id=$1`, [json.jobId])).rows[0]
  : null;
const agentOutbox = await pool.query(
  `SELECT outbox_id, channel, event_type, entity_id FROM live_outbox WHERE outbox_id > $1 AND (channel LIKE 'carer:%' OR event_type ILIKE '%job%') ORDER BY outbox_id DESC LIMIT 5`,
  [outboxBefore.rows[0].m || 0]
);

console.log(
  JSON.stringify(
    {
      flowName: 'carer_task_claim',
      route: '/api/carer/tasks/claim',
      statusCode: res.status,
      totalMs: Date.now() - started,
      taskId,
      response: json,
      job,
      agentOutbox: agentOutbox.rows,
      jobAvailableEvent: agentOutbox.rows.some((r) => /job_available|agent_job/i.test(r.event_type)),
    },
    null,
    2
  )
);
await pool.end();
