ALTER TABLE public.game_usernames
  ADD COLUMN IF NOT EXISTS raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivate_reason text,
  ADD COLUMN IF NOT EXISTS mirrored_at timestamptz NOT NULL DEFAULT now();

DROP INDEX IF EXISTS game_usernames_active_username_unique;

CREATE UNIQUE INDEX IF NOT EXISTS game_usernames_active_coadmin_username_unique
  ON public.game_usernames (coadmin_uid, lower(username))
  WHERE status = 'active'
    AND coadmin_uid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS game_usernames_active_global_username_unique
  ON public.game_usernames (lower(username))
  WHERE status = 'active'
    AND coadmin_uid IS NULL;

CREATE INDEX IF NOT EXISTS idx_game_usernames_active_player_uid
  ON public.game_usernames (player_uid)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_game_usernames_active_coadmin_username
  ON public.game_usernames (coadmin_uid, lower(username))
  WHERE status = 'active';
