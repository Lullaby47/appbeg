CREATE TABLE IF NOT EXISTS public.freeplay_pending_gifts_cache (
  player_uid TEXT PRIMARY KEY,

  coadmin_uid TEXT NULL,
  gift_id TEXT NULL,

  has_pending_gift BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NULL,
  amount NUMERIC NULL,

  created_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  claimed_at TIMESTAMPTZ NULL,

  source TEXT NOT NULL DEFAULT 'firestore',
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS freeplay_pending_gifts_cache_coadmin_uid_idx
  ON public.freeplay_pending_gifts_cache (coadmin_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS freeplay_pending_gifts_cache_has_pending_gift_idx
  ON public.freeplay_pending_gifts_cache (has_pending_gift)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS freeplay_pending_gifts_cache_updated_at_idx
  ON public.freeplay_pending_gifts_cache (updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS freeplay_pending_gifts_cache_raw_firestore_data_gin_idx
  ON public.freeplay_pending_gifts_cache USING GIN (raw_firestore_data);
