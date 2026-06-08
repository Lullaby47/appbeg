CREATE TABLE IF NOT EXISTS public.player_sessions_cache (
  session_id TEXT PRIMARY KEY,
  player_uid TEXT NOT NULL,
  coadmin_uid TEXT NULL,
  device_id TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NULL,
  started_at TIMESTAMPTZ NULL,
  last_seen_at TIMESTAMPTZ NULL,
  ended_at TIMESTAMPTZ NULL,
  ended_reason TEXT NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'mirror',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS player_sessions_cache_player_uid_idx
  ON public.player_sessions_cache (player_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_sessions_cache_active_idx
  ON public.player_sessions_cache (active)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_sessions_cache_status_idx
  ON public.player_sessions_cache (status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_sessions_cache_expires_at_idx
  ON public.player_sessions_cache (expires_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_sessions_cache_deleted_at_idx
  ON public.player_sessions_cache (deleted_at);
