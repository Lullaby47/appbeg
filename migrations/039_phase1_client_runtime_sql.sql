-- Phase 1 client runtime SQL tables (coin load, shift sessions, carer escalation alerts).

CREATE TABLE IF NOT EXISTS public.coin_load_sessions_cache (
  session_id TEXT PRIMARY KEY,
  player_uid TEXT NOT NULL,
  coadmin_uid TEXT NOT NULL,
  payment_photo_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'authority',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS coin_load_sessions_cache_player_uid_idx
  ON public.coin_load_sessions_cache (player_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS coin_load_sessions_cache_expires_at_idx
  ON public.coin_load_sessions_cache (expires_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.shift_sessions_cache (
  session_id TEXT PRIMARY KEY,
  coadmin_uid TEXT NOT NULL,
  user_uid TEXT NOT NULL,
  user_role TEXT NOT NULL,
  user_username TEXT NOT NULL DEFAULT '',
  login_at TIMESTAMPTZ NULL,
  logout_at TIMESTAMPTZ NULL,
  last_seen_at TIMESTAMPTZ NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'authority',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS shift_sessions_cache_coadmin_uid_idx
  ON public.shift_sessions_cache (coadmin_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS shift_sessions_cache_user_uid_active_idx
  ON public.shift_sessions_cache (user_uid, is_active)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.carer_escalation_alerts_cache (
  alert_id TEXT PRIMARY KEY,
  coadmin_uid TEXT NOT NULL,
  context_type TEXT NULL,
  escalation_from TEXT NULL,
  task_id TEXT NULL,
  player_uid TEXT NULL,
  player_username TEXT NULL,
  game_name TEXT NULL,
  message TEXT NULL,
  created_by_carer_uid TEXT NULL,
  created_by_carer_username TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at TIMESTAMPTZ NULL,
  source TEXT NOT NULL DEFAULT 'authority',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS carer_escalation_alerts_cache_coadmin_idx
  ON public.carer_escalation_alerts_cache (coadmin_uid, created_at DESC)
  WHERE deleted_at IS NULL;
