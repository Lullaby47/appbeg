/**
 * Compare carer_tasks_cache + automation_jobs_cache authority consistency.
 *
 * Usage:
 *   node scripts/compare-carer-tasks-automation-jobs-authority.cjs
 */
const { Pool } = require('pg');

const clean = (v) => String(v || '').trim();

async function main() {
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL),
  });
  if (!clean(process.env.DATABASE_URL || process.env.POSTGRES_URL)) {
    throw new Error('DATABASE_URL is required');
  }

  const [tasks, jobs, ops, outbox] = await Promise.all([
    pg.query(`
      SELECT firebase_id, coadmin_uid, status, automation_job_id, assigned_carer_uid,
             request_id, source, updated_at
      FROM public.carer_tasks_cache
      WHERE deleted_at IS NULL
        AND source LIKE 'authority%'
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT job_id, task_id, coadmin_uid, carer_uid, status, source, updated_at
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
        AND source LIKE 'authority%'
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT operation_key, operation_type, user_uid, source_id, payload, created_at
      FROM public.authority_operations
      WHERE operation_type IN (
        'task_claim', 'task_return', 'task_delete', 'task_complete_username'
      )
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
    pg.query(`
      SELECT channel, event_type, entity_type, entity_id, source, created_at
      FROM public.live_outbox
      WHERE deleted_at IS NULL
        AND source LIKE 'authority_carer%'
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5000
    `),
  ]);

  const jobsById = new Map(jobs.rows.map((row) => [clean(row.job_id), row]));
  const missing_jobs = [];
  const task_job_mismatch = [];
  const in_progress_without_assignee = [];
  const completed_with_active_job = [];

  for (const task of tasks.rows) {
    const taskId = clean(task.firebase_id);
    const jobId = clean(task.automation_job_id);
    const status = clean(task.status).toLowerCase();
    const assignee = clean(task.assigned_carer_uid);

    if (status === 'in_progress' && !assignee) {
      in_progress_without_assignee.push(taskId);
    }

    if (!jobId) continue;
    const job = jobsById.get(jobId);
    if (!job) {
      missing_jobs.push({ taskId, jobId, status });
      continue;
    }
    if (clean(job.task_id) && clean(job.task_id) !== taskId) {
      task_job_mismatch.push({
        taskId,
        jobId,
        task_status: status,
        job_task_id: clean(job.task_id),
      });
    }
    const jobStatus = clean(job.status).toLowerCase();
    if (status === 'completed' && ['queued', 'running', 'waiting', 'claimed'].includes(jobStatus)) {
      completed_with_active_job.push({ taskId, jobId, jobStatus });
    }
  }

  const orphan_authority_jobs = [];
  const taskJobIds = new Set(tasks.rows.map((row) => clean(row.automation_job_id)).filter(Boolean));
  for (const job of jobs.rows) {
    if (!taskJobIds.has(clean(job.job_id)) && ['queued', 'running', 'waiting'].includes(clean(job.status).toLowerCase())) {
      orphan_authority_jobs.push({
        jobId: clean(job.job_id),
        taskId: clean(job.task_id),
        status: clean(job.status),
      });
    }
  }

  const summary = {
    script: 'compare-carer-tasks-automation-jobs-authority',
    authority_tasks: tasks.rows.length,
    authority_jobs: jobs.rows.length,
    authority_operations: ops.rows.length,
    authority_outbox_events: outbox.rows.length,
    issues: {
      missing_jobs: missing_jobs.length,
      task_job_mismatch: task_job_mismatch.length,
      in_progress_without_assignee: in_progress_without_assignee.length,
      completed_with_active_job: completed_with_active_job.length,
      orphan_authority_jobs: orphan_authority_jobs.length,
    },
    samples: {
      missing_jobs: missing_jobs.slice(0, 10),
      task_job_mismatch: task_job_mismatch.slice(0, 10),
      in_progress_without_assignee: in_progress_without_assignee.slice(0, 10),
      completed_with_active_job: completed_with_active_job.slice(0, 10),
      orphan_authority_jobs: orphan_authority_jobs.slice(0, 10),
    },
  };

  const issueCount = Object.values(summary.issues).reduce((sum, n) => sum + Number(n || 0), 0);
  console.log(JSON.stringify(summary, null, 2));
  await pg.end();
  if (issueCount > 0) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
