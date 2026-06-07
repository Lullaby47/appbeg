CREATE TABLE IF NOT EXISTS public.user_balance_events (
  event_key TEXT PRIMARY KEY,

  user_uid TEXT NOT NULL,
  username TEXT NULL,
  role TEXT NULL,
  coadmin_uid TEXT NULL,

  balance_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  delta NUMERIC NULL,
  absolute_after NUMERIC NULL,

  event_type TEXT NOT NULL,
  reason_type TEXT NULL,

  source_collection TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_type TEXT NULL,

  related_player_uid TEXT NULL,
  related_request_id TEXT NULL,
  related_task_id TEXT NULL,
  related_cashout_task_id TEXT NULL,
  related_transfer_request_id TEXT NULL,
  related_reward_id TEXT NULL,
  related_claim_id TEXT NULL,
  related_job_id TEXT NULL,

  actor_uid TEXT NULL,
  actor_role TEXT NULL,

  confidence TEXT NOT NULL,
  confidence_reason TEXT NULL,

  source_created_at TIMESTAMPTZ NULL,
  derived_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  is_baseline BOOLEAN NOT NULL DEFAULT false,
  is_residual_adjustment BOOLEAN NOT NULL DEFAULT false,

  created_by_backfill BOOLEAN NOT NULL DEFAULT false,

  raw_source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_fields JSONB NOT NULL DEFAULT '{}'::jsonb,

  deleted_at TIMESTAMPTZ NULL,

  CONSTRAINT user_balance_events_balance_type_check
    CHECK (balance_type IN ('coin', 'cash', 'cashBoxNpr', 'promoLockedCoins', 'referralBonusCoins')),
  CONSTRAINT user_balance_events_direction_check
    CHECK (direction IN ('credit', 'debit', 'set', 'baseline', 'residual')),
  CONSTRAINT user_balance_events_confidence_check
    CHECK (confidence IN ('high', 'medium', 'low', 'baseline', 'residual'))
);

CREATE INDEX IF NOT EXISTS user_balance_events_user_balance_created_idx
  ON public.user_balance_events (user_uid, balance_type, source_created_at);

CREATE INDEX IF NOT EXISTS user_balance_events_coadmin_created_idx
  ON public.user_balance_events (coadmin_uid, source_created_at);

CREATE INDEX IF NOT EXISTS user_balance_events_type_created_idx
  ON public.user_balance_events (event_type, source_created_at);

CREATE INDEX IF NOT EXISTS user_balance_events_confidence_created_idx
  ON public.user_balance_events (confidence, source_created_at);

CREATE INDEX IF NOT EXISTS user_balance_events_source_idx
  ON public.user_balance_events (source_collection, source_id);

CREATE INDEX IF NOT EXISTS user_balance_events_is_baseline_idx
  ON public.user_balance_events (is_baseline);

CREATE INDEX IF NOT EXISTS user_balance_events_is_residual_adjustment_idx
  ON public.user_balance_events (is_residual_adjustment);

CREATE INDEX IF NOT EXISTS user_balance_events_deleted_at_idx
  ON public.user_balance_events (deleted_at);

CREATE INDEX IF NOT EXISTS user_balance_events_raw_source_data_gin_idx
  ON public.user_balance_events USING GIN (raw_source_data);

CREATE INDEX IF NOT EXISTS user_balance_events_source_fields_gin_idx
  ON public.user_balance_events USING GIN (source_fields);
