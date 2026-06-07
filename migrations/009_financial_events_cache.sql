CREATE TABLE IF NOT EXISTS public.financial_events_cache (
  firebase_id TEXT PRIMARY KEY,

  player_uid TEXT NULL,
  player_id TEXT NULL,

  coadmin_uid TEXT NULL,

  actor_uid TEXT NULL,
  actor_username TEXT NULL,
  actor_role TEXT NULL,

  related_user_uid TEXT NULL,
  related_user_role TEXT NULL,

  type TEXT NULL,

  amount NUMERIC NULL,
  amount_npr NUMERIC NULL,
  amount_coins NUMERIC NULL,

  currency TEXT NULL,
  unit TEXT NULL,

  request_id TEXT NULL,
  cashout_task_id TEXT NULL,
  transfer_request_id TEXT NULL,
  task_id TEXT NULL,
  automation_job_id TEXT NULL,
  bonus_event_id TEXT NULL,
  gift_id TEXT NULL,
  transfer_id TEXT NULL,

  fee_amount NUMERIC NULL,
  tip_amount NUMERIC NULL,
  cash_received NUMERIC NULL,
  coins_received NUMERIC NULL,

  before_cash NUMERIC NULL,
  after_cash NUMERIC NULL,
  before_coin NUMERIC NULL,
  after_coin NUMERIC NULL,

  before_balances JSONB NULL,
  after_balances JSONB NULL,

  reason TEXT NULL,
  notes TEXT NULL,
  meta JSONB NULL,

  created_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  ttl_expires_at TIMESTAMPTZ NULL,

  source TEXT DEFAULT 'firestore',

  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,

  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS financial_events_cache_player_created_idx
  ON public.financial_events_cache (player_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_coadmin_created_idx
  ON public.financial_events_cache (coadmin_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_type_created_idx
  ON public.financial_events_cache (type, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_request_id_idx
  ON public.financial_events_cache (request_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_cashout_task_id_idx
  ON public.financial_events_cache (cashout_task_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_transfer_request_id_idx
  ON public.financial_events_cache (transfer_request_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_task_id_idx
  ON public.financial_events_cache (task_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_automation_job_id_idx
  ON public.financial_events_cache (automation_job_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_transfer_id_idx
  ON public.financial_events_cache (transfer_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_related_user_uid_idx
  ON public.financial_events_cache (related_user_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_amount_npr_idx
  ON public.financial_events_cache (amount_npr)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_created_at_idx
  ON public.financial_events_cache (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS financial_events_cache_raw_firestore_data_gin_idx
  ON public.financial_events_cache USING GIN (raw_firestore_data);

CREATE INDEX IF NOT EXISTS financial_events_cache_meta_gin_idx
  ON public.financial_events_cache USING GIN (meta);

CREATE INDEX IF NOT EXISTS financial_events_cache_before_balances_gin_idx
  ON public.financial_events_cache USING GIN (before_balances);

CREATE INDEX IF NOT EXISTS financial_events_cache_after_balances_gin_idx
  ON public.financial_events_cache USING GIN (after_balances);
