CREATE TABLE IF NOT EXISTS public.coadmin_bonus_settings_cache (
  firebase_id text PRIMARY KEY,
  coadmin_uid text NOT NULL,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'appbeg',
  created_at timestamptz,
  updated_at timestamptz,
  mirrored_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_coadmin_bonus_settings_cache_coadmin_uid
  ON public.coadmin_bonus_settings_cache (coadmin_uid);

CREATE INDEX IF NOT EXISTS idx_coadmin_bonus_settings_cache_updated_at
  ON public.coadmin_bonus_settings_cache (updated_at);
