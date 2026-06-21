-- Pending self-signups deliberately live outside the player directory. A player
-- record is created only after the email code has been successfully verified.
CREATE TABLE IF NOT EXISTS public.player_signup_requests (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  username text NOT NULL,
  password_hash text NOT NULL,
  password_algo text NOT NULL,
  coadmin_signup_code text NULL,
  owner_coadmin_uid text NULL,
  referral_code text NULL,
  verification_code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  verified_at timestamptz NULL,
  player_uid text NULL,
  account_created_at timestamptz NULL,
  setup_source text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS player_signup_requests_email_pending_unique
  ON public.player_signup_requests (lower(email)) WHERE verified_at IS NULL;
CREATE INDEX IF NOT EXISTS player_signup_requests_expires_at_idx
  ON public.player_signup_requests (expires_at);

-- Staff-created players retain their generated @app.local addresses; real and
-- verified player emails must still be globally unique, case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS players_cache_player_email_unique
  ON public.players_cache (lower(email))
  WHERE deleted_at IS NULL AND role = 'player' AND email IS NOT NULL AND email <> '';

CREATE TABLE IF NOT EXISTS public.player_signup_events (
  id bigserial PRIMARY KEY,
  signup_id uuid NULL,
  event_type text NOT NULL,
  email text NULL,
  username text NULL,
  ip_hash text NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_signup_events_rate_idx
  ON public.player_signup_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.coadmin_player_signup_codes (
  coadmin_uid text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS coadmin_player_signup_codes_code_unique
  ON public.coadmin_player_signup_codes (upper(code));
