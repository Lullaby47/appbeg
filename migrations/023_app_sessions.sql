-- AppBeg SQL sessions (authoritative session store for future SQL auth).

CREATE TABLE IF NOT EXISTS public.app_sessions (
  session_id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  role TEXT NOT NULL,
  coadmin_uid TEXT NULL,
  username TEXT NULL,
  device_id TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NULL,
  ended_at TIMESTAMPTZ NULL,
  ended_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  raw_context JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS app_sessions_uid_active_idx
  ON public.app_sessions (uid, active)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx
  ON public.app_sessions (expires_at);

CREATE INDEX IF NOT EXISTS app_sessions_role_idx
  ON public.app_sessions (role);

CREATE INDEX IF NOT EXISTS app_sessions_coadmin_uid_idx
  ON public.app_sessions (coadmin_uid);
