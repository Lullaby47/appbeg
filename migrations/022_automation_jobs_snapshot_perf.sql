-- Automation jobs carer live snapshot read-path indexes (idempotent).

CREATE INDEX IF NOT EXISTS automation_jobs_cache_carer_created_idx
  ON public.automation_jobs_cache (carer_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS automation_jobs_cache_created_by_status_updated_idx
  ON public.automation_jobs_cache (created_by_uid, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS automation_jobs_cache_carer_status_updated_idx
  ON public.automation_jobs_cache (carer_uid, status, updated_at DESC)
  WHERE deleted_at IS NULL;
