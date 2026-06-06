CREATE TABLE IF NOT EXISTS public.game_logins_cache (
  id text PRIMARY KEY,
  game_name text NOT NULL,
  username text NOT NULL,
  password text NOT NULL,
  backend_url text NOT NULL DEFAULT '',
  frontend_url text NOT NULL DEFAULT '',
  site_url text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  coadmin_uid text,
  status text NOT NULL DEFAULT 'active',
  source text NOT NULL DEFAULT 'appbeg',
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  mirrored_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_logins_cache_coadmin_uid
  ON public.game_logins_cache (coadmin_uid)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_game_logins_cache_created_by
  ON public.game_logins_cache (created_by)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_game_logins_cache_game_name
  ON public.game_logins_cache (game_name)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_game_logins_cache_status
  ON public.game_logins_cache (status);
