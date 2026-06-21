-- Safe upgrade for environments that already applied the initial self-signup migration.
ALTER TABLE public.player_signup_requests
  ADD COLUMN IF NOT EXISTS coadmin_signup_code text NULL,
  ADD COLUMN IF NOT EXISTS owner_coadmin_uid text NULL;

CREATE TABLE IF NOT EXISTS public.coadmin_player_signup_codes (
  coadmin_uid text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS coadmin_player_signup_codes_code_unique
  ON public.coadmin_player_signup_codes (upper(code));

CREATE TABLE IF NOT EXISTS public.coadmin_player_signup_code_audit (
  id bigserial PRIMARY KEY,
  coadmin_uid text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  old_code_hash text NULL,
  new_code_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS coadmin_player_signup_code_audit_coadmin_changed_idx
  ON public.coadmin_player_signup_code_audit (coadmin_uid, changed_at DESC);
