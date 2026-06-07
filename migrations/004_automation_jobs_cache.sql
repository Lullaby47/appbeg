CREATE TABLE IF NOT EXISTS public.automation_jobs_cache (
  job_id text PRIMARY KEY,
  task_id text,
  linked_task_id text,
  coadmin_uid text,
  carer_uid text,
  player_uid text,
  agent_id text,
  created_by_uid text,
  created_by_name text,
  game_id text,
  game text,
  type text,
  request_type text,
  status text,
  claimed_status text,
  payload jsonb,
  result jsonb,
  error_message text,
  cancelled_reason text,
  needs_manual_review boolean,
  partial_success boolean,
  attempts integer,
  created_at timestamptz,
  updated_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  last_heartbeat_at timestamptz,
  ttl_expires_at timestamptz,
  raw_firestore_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'firestore',
  mirrored_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_agent_queue
  ON public.automation_jobs_cache (carer_uid, agent_id, status, created_at ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_created_by_recent
  ON public.automation_jobs_cache (created_by_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_created_by_task_recent
  ON public.automation_jobs_cache (created_by_uid, task_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_task
  ON public.automation_jobs_cache (task_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_task_status
  ON public.automation_jobs_cache (task_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_coadmin_active
  ON public.automation_jobs_cache (coadmin_uid, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_cleanup_completed
  ON public.automation_jobs_cache (carer_uid, status, completed_at ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_cleanup_updated
  ON public.automation_jobs_cache (carer_uid, status, updated_at ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_ttl
  ON public.automation_jobs_cache (ttl_expires_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_payload_gin
  ON public.automation_jobs_cache USING gin (payload);

CREATE INDEX IF NOT EXISTS idx_automation_jobs_cache_raw_firestore_data_gin
  ON public.automation_jobs_cache USING gin (raw_firestore_data);
