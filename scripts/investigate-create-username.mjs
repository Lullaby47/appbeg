import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://appbeg_user:AppBeg2026Strong47@103.214.71.5:5432/appbeg',
});

const CARER_UID = 'ZJeDyfQU3UYEdE0rMoYbZ9pcFA33';
const AGENT_ID = 'car001';

const q1 = await pool.query(`
  SELECT firebase_id, type, status, coadmin_uid, player_uid, assigned_carer_uid,
    automation_job_id, game_name, retry_pending, returned_to_pending_at, created_at, updated_at,
    raw_firestore_data
  FROM carer_tasks_cache
  WHERE deleted_at IS NULL
  AND (
    type ILIKE '%CREATE%'
    OR type ILIKE '%USERNAME%'
    OR raw_firestore_data::text ILIKE '%CREATE_USERNAME%'
    OR raw_firestore_data::text ILIKE '%createUsername%'
  )
  ORDER BY created_at DESC
  LIMIT 10
`);

console.log('=== STEP 1: CREATE_USERNAME TASKS ===');
console.log(JSON.stringify(q1.rows, null, 2));

const latest = q1.rows[0];
if (!latest) {
  console.log('No CREATE_USERNAME tasks found.');
  await pool.end();
  process.exit(0);
}

const taskId = latest.firebase_id;
const coadminUid = latest.coadmin_uid;

console.log('\n=== STEP 2: AUTO-TICK PENDING SCAN (exact query) ===');
const scan = await pool.query(
  `
    SELECT firebase_id, type, status, retry_pending, returned_to_pending_at,
      assigned_carer_uid, claimed_by_uid, automation_job_id, game_name, player_uid
    FROM carer_tasks_cache
    WHERE coadmin_uid = $1
      AND status = 'pending'
      AND deleted_at IS NULL
      AND COALESCE(assigned_carer_uid, '') = ''
      AND COALESCE(claimed_by_uid, '') = ''
      AND COALESCE(automation_job_id, '') = ''
      AND COALESCE(retry_pending, false) = false
      AND (
        returned_to_pending_at IS NULL
        OR returned_to_pending_at < NOW() - (30 * INTERVAL '1 second')
      )
    ORDER BY created_at DESC NULLS LAST
    LIMIT 15
  `,
  [coadminUid]
);
console.log('Scan count:', scan.rows.length);
console.log(JSON.stringify(scan.rows, null, 2));
const inScan = scan.rows.some((r) => r.firebase_id === taskId);
console.log('Latest task included in scan?', inScan);

const why = await pool.query(
  `SELECT firebase_id, type, status, retry_pending, returned_to_pending_at,
    assigned_carer_uid, claimed_by_uid, automation_job_id, game_name, player_uid, deleted_at
   FROM carer_tasks_cache WHERE firebase_id = $1`,
  [taskId]
);
console.log('\n=== Latest task full blocking fields ===');
console.log(JSON.stringify(why.rows[0], null, 2));

console.log('\n=== STEP 4: automation_jobs_cache ===');
const jobs = await pool.query(
  `
    SELECT job_id, task_id, type, status, carer_uid, agent_id, coadmin_uid, created_at, started_at
    FROM automation_jobs_cache
    WHERE deleted_at IS NULL
    AND (
      task_id = $1
      OR type ILIKE '%CREATE%'
      OR raw_firestore_data::text ILIKE '%CREATE_USERNAME%'
    )
    ORDER BY created_at DESC
    LIMIT 20
  `,
  [taskId]
);
console.log(JSON.stringify(jobs.rows, null, 2));

console.log('\n=== STEP 5: queued jobs for carer/agent ===');
const queued = await pool.query(
  `
    SELECT job_id, task_id, type, status, carer_uid, agent_id, created_at
    FROM automation_jobs_cache
    WHERE deleted_at IS NULL
      AND carer_uid = $1
      AND agent_id = $2
      AND status = 'queued'
    ORDER BY created_at ASC
    LIMIT 20
  `,
  [CARER_UID, AGENT_ID]
);
console.log(JSON.stringify(queued.rows, null, 2));

console.log('\n=== automation auto state ===');
const state = await pool.query(
  `SELECT carer_uid, enabled, automation_agent_id, updated_at FROM automation_auto_state_cache WHERE carer_uid = $1`,
  [CARER_UID]
);
console.log(JSON.stringify(state.rows, null, 2));

console.log('\n=== carer profile automation_agent_id ===');
const carer = await pool.query(
  `SELECT uid, username, role, coadmin_uid, automation_agent_id FROM players_cache WHERE uid = $1 AND deleted_at IS NULL`,
  [CARER_UID]
);
console.log(JSON.stringify(carer.rows, null, 2));

await pool.end();
