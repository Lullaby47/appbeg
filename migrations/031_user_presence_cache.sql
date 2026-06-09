CREATE TABLE IF NOT EXISTS public.user_presence_cache (
  uid TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS user_presence_cache_last_seen_at_idx
  ON public.user_presence_cache (last_seen_at DESC)
  WHERE deleted_at IS NULL;
