CREATE TABLE IF NOT EXISTS public.player_game_requests_cache (
  firebase_id TEXT PRIMARY KEY,

  player_uid TEXT NULL,
  player_username TEXT NULL,

  coadmin_uid TEXT NULL,
  created_by TEXT NULL,

  game_name TEXT NULL,
  normalized_game_name TEXT NULL,

  current_username TEXT NULL,
  game_account_username TEXT NULL,

  type TEXT NULL,
  status TEXT NULL,

  amount NUMERIC NULL,
  base_amount NUMERIC NULL,
  bonus_percentage NUMERIC NULL,

  bonus_event_id TEXT NULL,
  first_recharge_match_applied BOOLEAN NULL,

  coin_deducted_on_request BOOLEAN NULL,
  coin_refunded_on_dismissal BOOLEAN NULL,
  coin_refunded_on_dismissal_at TIMESTAMPTZ NULL,

  task_id TEXT NULL,
  automation_job_id TEXT NULL,
  linked_job_id TEXT NULL,

  automation_status TEXT NULL,
  automation_error TEXT NULL,

  retry_pending BOOLEAN NULL,
  retryable_failure BOOLEAN NULL,

  fake_redeem BOOLEAN NULL,
  fake_redeem_reason TEXT NULL,

  dismiss_type TEXT NULL,
  dismissed_by_automation BOOLEAN NULL,

  dismiss_reason_code TEXT NULL,
  dismiss_reason_message TEXT NULL,
  dismiss_reason TEXT NULL,

  dismiss_meta JSONB NULL,

  error_message TEXT NULL,
  failure_reason TEXT NULL,
  last_failure_reason TEXT NULL,

  poke_message TEXT NULL,

  created_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  poked_at TIMESTAMPTZ NULL,
  dismissed_at TIMESTAMPTZ NULL,
  failed_at TIMESTAMPTZ NULL,

  ttl_expires_at TIMESTAMPTZ NULL,

  reset_to_pending_at TIMESTAMPTZ NULL,
  returned_to_pending_at TIMESTAMPTZ NULL,
  pending_since TIMESTAMPTZ NULL,

  source TEXT DEFAULT 'firestore',

  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,

  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS player_game_requests_cache_coadmin_status_created_idx
  ON public.player_game_requests_cache (coadmin_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_coadmin_type_status_created_idx
  ON public.player_game_requests_cache (coadmin_uid, type, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_player_status_created_idx
  ON public.player_game_requests_cache (player_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_player_type_created_idx
  ON public.player_game_requests_cache (player_uid, type, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_status_type_created_idx
  ON public.player_game_requests_cache (status, type, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_game_status_idx
  ON public.player_game_requests_cache (normalized_game_name, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_task_id_idx
  ON public.player_game_requests_cache (task_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_automation_job_id_idx
  ON public.player_game_requests_cache (automation_job_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_linked_job_id_idx
  ON public.player_game_requests_cache (linked_job_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_bonus_event_id_idx
  ON public.player_game_requests_cache (bonus_event_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_updated_at_idx
  ON public.player_game_requests_cache (updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_completed_at_idx
  ON public.player_game_requests_cache (completed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_ttl_expires_at_idx
  ON public.player_game_requests_cache (ttl_expires_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_requests_cache_raw_firestore_data_gin_idx
  ON public.player_game_requests_cache USING GIN (raw_firestore_data);

CREATE INDEX IF NOT EXISTS player_game_requests_cache_dismiss_meta_gin_idx
  ON public.player_game_requests_cache USING GIN (dismiss_meta);
