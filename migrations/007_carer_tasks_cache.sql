CREATE TABLE IF NOT EXISTS public.carer_tasks_cache (
  firebase_id TEXT PRIMARY KEY,
  coadmin_uid TEXT NULL,
  type TEXT NULL,
  player_uid TEXT NULL,
  player_username TEXT NULL,
  game_name TEXT NULL,
  normalized_game_name TEXT NULL,
  amount NUMERIC NULL,
  request_id TEXT NULL,
  status TEXT NULL,

  assigned_carer_uid TEXT NULL,
  assigned_carer_username TEXT NULL,
  assigned_carer TEXT NULL,
  claimed_status TEXT NULL,
  claimed_by_uid TEXT NULL,
  claimed_by_username TEXT NULL,
  completed_by_carer_uid TEXT NULL,
  completed_by_carer_username TEXT NULL,

  current_username TEXT NULL,
  game_account_username TEXT NULL,
  login_url TEXT NULL,
  game_login_url TEXT NULL,
  lobby_url TEXT NULL,
  site_url TEXT NULL,
  base_url TEXT NULL,
  game_credential_username TEXT NULL,
  game_credential_password TEXT NULL,

  is_poked BOOLEAN NULL,
  poke_message TEXT NULL,
  automation_status TEXT NULL,
  automation_job_id TEXT NULL,
  linked_job_id TEXT NULL,
  current_job_id TEXT NULL,
  active_job_id TEXT NULL,
  assigned_job_status TEXT NULL,
  automation_error TEXT NULL,
  error_message TEXT NULL,
  failure_reason TEXT NULL,
  last_failure_reason TEXT NULL,
  retry_pending BOOLEAN NULL,
  fake_redeem BOOLEAN NULL,
  dismiss_type TEXT NULL,
  dismissed_by_automation BOOLEAN NULL,
  completion_issue_code TEXT NULL,
  completion_issue TEXT NULL,

  created_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  started_at TIMESTAMPTZ NULL,
  running_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  failed_at TIMESTAMPTZ NULL,
  ttl_expires_at TIMESTAMPTZ NULL,
  claimed_at TIMESTAMPTZ NULL,
  last_heartbeat_at TIMESTAMPTZ NULL,
  automation_updated_at TIMESTAMPTZ NULL,
  reset_to_pending_at TIMESTAMPTZ NULL,
  returned_to_pending_at TIMESTAMPTZ NULL,
  pending_since TIMESTAMPTZ NULL,
  queued_at TIMESTAMPTZ NULL,
  deleted_from_pending_at TIMESTAMPTZ NULL,

  source TEXT NULL,
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS carer_tasks_cache_coadmin_status_created_idx
  ON public.carer_tasks_cache (coadmin_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_coadmin_status_completed_idx
  ON public.carer_tasks_cache (coadmin_uid, status, completed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_coadmin_status_type_idx
  ON public.carer_tasks_cache (coadmin_uid, status, type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_player_status_type_idx
  ON public.carer_tasks_cache (player_uid, status, type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_request_id_idx
  ON public.carer_tasks_cache (request_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_automation_job_id_idx
  ON public.carer_tasks_cache (automation_job_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_assigned_status_idx
  ON public.carer_tasks_cache (assigned_carer_uid, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_ttl_expires_at_idx
  ON public.carer_tasks_cache (ttl_expires_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_updated_at_idx
  ON public.carer_tasks_cache (updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_raw_firestore_data_gin_idx
  ON public.carer_tasks_cache USING GIN (raw_firestore_data);
