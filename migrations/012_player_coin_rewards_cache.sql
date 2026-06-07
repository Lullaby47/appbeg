CREATE TABLE IF NOT EXISTS public.player_coin_rewards_cache (
  firebase_id TEXT PRIMARY KEY,

  from_uid TEXT NULL,
  from_username TEXT NULL,
  to_uid TEXT NULL,
  to_username TEXT NULL,
  coadmin_uid TEXT NULL,

  amount_coins NUMERIC NULL,
  fee_coins NUMERIC NULL,
  received_coins NUMERIC NULL,
  fee_percent NUMERIC NULL,

  created_at TIMESTAMPTZ NULL,

  source TEXT DEFAULT 'firestore',

  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,

  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS player_coin_rewards_cache_from_created_idx
  ON public.player_coin_rewards_cache (from_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_coin_rewards_cache_to_created_idx
  ON public.player_coin_rewards_cache (to_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_coin_rewards_cache_coadmin_created_idx
  ON public.player_coin_rewards_cache (coadmin_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_coin_rewards_cache_created_at_idx
  ON public.player_coin_rewards_cache (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_coin_rewards_cache_raw_firestore_data_gin_idx
  ON public.player_coin_rewards_cache USING GIN (raw_firestore_data);
