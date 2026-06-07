CREATE TABLE IF NOT EXISTS public.player_game_logins_cache (
  firebase_id TEXT PRIMARY KEY,
  player_uid TEXT NOT NULL,
  player_username TEXT NULL,
  game_name TEXT NOT NULL,
  normalized_game_name TEXT NOT NULL,
  game_username TEXT NULL,
  game_password TEXT NULL,
  game_account_username TEXT NULL,
  game_account_password TEXT NULL,
  current_username TEXT NULL,
  current_password TEXT NULL,
  frontend_url TEXT NULL,
  site_url TEXT NULL,
  coadmin_uid TEXT NULL,
  created_by TEXT NULL,
  updated_by_automation_job_id TEXT NULL,
  updated_by_carer_uid TEXT NULL,
  created_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  source TEXT NULL,
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS player_game_logins_cache_player_uid_idx
  ON public.player_game_logins_cache (player_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_logins_cache_coadmin_uid_idx
  ON public.player_game_logins_cache (coadmin_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_logins_cache_created_by_idx
  ON public.player_game_logins_cache (created_by)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_logins_cache_player_game_idx
  ON public.player_game_logins_cache (player_uid, normalized_game_name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_logins_cache_coadmin_game_idx
  ON public.player_game_logins_cache (coadmin_uid, normalized_game_name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_logins_cache_created_by_game_idx
  ON public.player_game_logins_cache (created_by, normalized_game_name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_logins_cache_updated_at_desc_idx
  ON public.player_game_logins_cache (updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_game_logins_cache_raw_firestore_data_gin_idx
  ON public.player_game_logins_cache USING GIN (raw_firestore_data);
