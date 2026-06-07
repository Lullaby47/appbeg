CREATE TABLE IF NOT EXISTS public.player_cashout_tasks_cache (
  firebase_id TEXT PRIMARY KEY,

  coadmin_uid TEXT NULL,
  player_uid TEXT NULL,
  player_username TEXT NULL,

  amount_npr NUMERIC NULL,

  payment_details TEXT NULL,
  payout_method TEXT NULL,
  qr_image_url TEXT NULL,
  payment_app_name TEXT NULL,
  payment_app_cash_tag TEXT NULL,
  payment_app_account_name TEXT NULL,

  cash_deducted_on_request BOOLEAN NULL,

  status TEXT NULL,

  assigned_handler_uid TEXT NULL,
  assigned_handler_username TEXT NULL,
  cashout_requested_by_staff_id TEXT NULL,

  reward_npr_applied NUMERIC NULL,
  reward_blocked_applied BOOLEAN NULL,

  declined_by_uids JSONB NULL,

  started_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,

  source TEXT DEFAULT 'firestore',

  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,

  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_coadmin_status_created_idx
  ON public.player_cashout_tasks_cache (coadmin_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_player_created_idx
  ON public.player_cashout_tasks_cache (player_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_assigned_handler_created_idx
  ON public.player_cashout_tasks_cache (assigned_handler_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_status_created_idx
  ON public.player_cashout_tasks_cache (status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_completed_at_idx
  ON public.player_cashout_tasks_cache (completed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_expires_at_idx
  ON public.player_cashout_tasks_cache (expires_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_cash_deducted_on_request_idx
  ON public.player_cashout_tasks_cache (cash_deducted_on_request)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_raw_firestore_data_gin_idx
  ON public.player_cashout_tasks_cache USING GIN (raw_firestore_data);

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_declined_by_uids_gin_idx
  ON public.player_cashout_tasks_cache USING GIN (declined_by_uids);
