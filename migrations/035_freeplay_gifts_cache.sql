CREATE TABLE IF NOT EXISTS public.freeplay_gifts_cache (
  firebase_id TEXT PRIMARY KEY,

  player_uid TEXT NOT NULL,
  coadmin_uid TEXT NULL,

  type TEXT NOT NULL DEFAULT 'freeplay',
  status TEXT NOT NULL,
  amount NUMERIC NULL,

  created_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  claimed_at TIMESTAMPTZ NULL,

  source TEXT NOT NULL DEFAULT 'authority',
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS freeplay_gifts_cache_player_uid_idx
  ON public.freeplay_gifts_cache (player_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS freeplay_gifts_cache_status_idx
  ON public.freeplay_gifts_cache (status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS freeplay_gifts_cache_coadmin_uid_idx
  ON public.freeplay_gifts_cache (coadmin_uid)
  WHERE deleted_at IS NULL;
