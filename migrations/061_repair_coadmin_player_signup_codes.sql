-- Production repair: safe to run on every environment, including databases
-- that missed migration 060. It creates the public coadmin signup-code store
-- required by the coadmin dashboard and player self-signup resolver.
CREATE TABLE IF NOT EXISTS public.coadmin_player_signup_codes (
  coadmin_uid text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS coadmin_player_signup_codes_code_unique
  ON public.coadmin_player_signup_codes (upper(code));

CREATE INDEX IF NOT EXISTS coadmin_player_signup_codes_updated_at_idx
  ON public.coadmin_player_signup_codes (updated_at DESC);

CREATE TABLE IF NOT EXISTS public.coadmin_player_signup_code_audit (
  id bigserial PRIMARY KEY,
  coadmin_uid text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  old_code_hash text NULL,
  new_code_hash text NOT NULL
);

CREATE INDEX IF NOT EXISTS coadmin_player_signup_code_audit_coadmin_changed_idx
  ON public.coadmin_player_signup_code_audit (coadmin_uid, changed_at DESC);
