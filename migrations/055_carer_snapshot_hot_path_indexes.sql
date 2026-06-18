-- Carer task/job snapshot hot-path indexes.
-- Run outside a transaction: CREATE INDEX CONCURRENTLY avoids blocking writes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS carer_tasks_cache_coadmin_status_created_active_idx
  ON public.carer_tasks_cache (coadmin_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS carer_tasks_cache_coadmin_status_completed_active_idx
  ON public.carer_tasks_cache (coadmin_uid, status, completed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS automation_jobs_cache_created_by_created_active_idx
  ON public.automation_jobs_cache (created_by_uid, created_at DESC)
  WHERE deleted_at IS NULL;
