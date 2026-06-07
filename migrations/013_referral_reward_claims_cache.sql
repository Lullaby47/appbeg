CREATE TABLE IF NOT EXISTS public.referral_reward_claims_cache (
  firebase_id TEXT PRIMARY KEY,

  referrer_uid TEXT NULL,
  referred_player_uid TEXT NULL,
  referred_player_name TEXT NULL,

  recharge_id TEXT NULL,

  recharge_amount NUMERIC NULL,
  reward_amount NUMERIC NULL,

  status TEXT NULL,

  qualified_at TIMESTAMPTZ NULL,
  claimed_at TIMESTAMPTZ NULL,

  source TEXT DEFAULT 'firestore',

  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,

  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS referral_reward_claims_cache_referrer_claimed_idx
  ON public.referral_reward_claims_cache (referrer_uid, claimed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS referral_reward_claims_cache_referred_player_idx
  ON public.referral_reward_claims_cache (referred_player_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS referral_reward_claims_cache_status_claimed_idx
  ON public.referral_reward_claims_cache (status, claimed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS referral_reward_claims_cache_recharge_id_idx
  ON public.referral_reward_claims_cache (recharge_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS referral_reward_claims_cache_raw_firestore_data_gin_idx
  ON public.referral_reward_claims_cache USING GIN (raw_firestore_data);
