CREATE TABLE IF NOT EXISTS public.players_cache (
  uid text PRIMARY KEY,
  username text NOT NULL,
  email text,
  role text NOT NULL DEFAULT 'player',
  status text,
  created_by text,
  coadmin_uid text,
  created_by_staff_id text,
  coin numeric,
  cash numeric,
  promo_locked_coins numeric,
  referral_code text,
  referred_by_uid text,
  referred_by_code text,
  referral_bonus_coins numeric,
  referral_created_at timestamptz,
  referral_reward_status text,
  referral_qualified_at timestamptz,
  referral_reward_claimed_at timestamptz,
  password_updated_at timestamptz,
  password_updated_by_uid text,
  password_updated_by_role text,
  transferred_by_uid text,
  created_at timestamptz,
  updated_at timestamptz,
  restored_at timestamptz,
  raw_firestore_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'firestore',
  mirrored_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_players_cache_role
  ON public.players_cache (role)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_players_cache_role_coadmin
  ON public.players_cache (role, coadmin_uid)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_players_cache_role_created_by
  ON public.players_cache (role, created_by)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_cache_referral_code
  ON public.players_cache (referral_code)
  WHERE deleted_at IS NULL AND referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_players_cache_referred_by
  ON public.players_cache (referred_by_uid)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_players_cache_status
  ON public.players_cache (status)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.referral_codes_cache (
  code text PRIMARY KEY,
  player_uid text,
  created_at timestamptz,
  raw_firestore_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'firestore',
  mirrored_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_cache_player_uid
  ON public.referral_codes_cache (player_uid)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.referrals_cache (
  firebase_id text PRIMARY KEY,
  referrer_uid text,
  referrer_username text,
  referred_player_uid text,
  referred_player_username text,
  referral_code text,
  reward_coins numeric,
  status text,
  created_at timestamptz,
  qualified_at timestamptz,
  claimed_at timestamptz,
  raw_firestore_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'firestore',
  mirrored_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_referrals_cache_referrer
  ON public.referrals_cache (referrer_uid, status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_cache_referred
  ON public.referrals_cache (referred_player_uid)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_cache_code
  ON public.referrals_cache (referral_code)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.deleted_players_cache (
  uid text PRIMARY KEY,
  username text,
  email text,
  role text,
  status text,
  created_by text,
  coadmin_uid text,
  coin numeric,
  cash numeric,
  referral_code text,
  referred_by_uid text,
  referred_by_code text,
  referral_bonus_coins numeric,
  referral_created_at timestamptz,
  deleted_at_source timestamptz,
  deleted_by_uid text,
  raw_firestore_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'firestore',
  mirrored_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_deleted_players_cache_role_deleted
  ON public.deleted_players_cache (role, deleted_at_source DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE public.game_usernames
  ADD COLUMN IF NOT EXISTS raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivate_reason text,
  ADD COLUMN IF NOT EXISTS mirrored_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_game_usernames_player_game
  ON public.game_usernames (player_uid, game);
CREATE INDEX IF NOT EXISTS idx_game_usernames_status
  ON public.game_usernames (status);
