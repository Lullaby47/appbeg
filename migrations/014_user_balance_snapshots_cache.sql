CREATE TABLE IF NOT EXISTS public.user_balance_snapshots_cache (
  firebase_id TEXT PRIMARY KEY,
  username TEXT NULL,
  email TEXT NULL,
  role TEXT NULL,
  status TEXT NULL,
  coadmin_uid TEXT NULL,
  created_by TEXT NULL,
  coin NUMERIC NULL,
  cash NUMERIC NULL,
  cash_box_npr NUMERIC NULL,
  promo_locked_coins NUMERIC NULL,
  referral_bonus_coins NUMERIC NULL,
  redeem_window_24h NUMERIC NULL,
  reward_blocked BOOLEAN NULL,
  bonus_blocked_until TIMESTAMPTZ NULL,
  transfer_blocked_until TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  source TEXT DEFAULT 'firestore',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS user_balance_snapshots_cache_role_status_idx
  ON public.user_balance_snapshots_cache (role, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS user_balance_snapshots_cache_coadmin_role_idx
  ON public.user_balance_snapshots_cache (coadmin_uid, role)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS user_balance_snapshots_cache_created_by_role_idx
  ON public.user_balance_snapshots_cache (created_by, role)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS user_balance_snapshots_cache_username_idx
  ON public.user_balance_snapshots_cache (username)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS user_balance_snapshots_cache_status_idx
  ON public.user_balance_snapshots_cache (status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS user_balance_snapshots_cache_mirrored_at_idx
  ON public.user_balance_snapshots_cache (mirrored_at DESC);

CREATE INDEX IF NOT EXISTS user_balance_snapshots_cache_raw_firestore_data_gin_idx
  ON public.user_balance_snapshots_cache USING GIN (raw_firestore_data);
