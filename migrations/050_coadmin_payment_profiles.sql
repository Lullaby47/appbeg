CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.coadmin_payment_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coadmin_uid text NOT NULL,
  player_uid text NOT NULL,
  canonical_username text NOT NULL,
  provider text NOT NULL,
  payment_sender_name text NULL,
  payment_sender_email text NULL,
  recipient_name text NULL,
  recipient_email text NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_from_event_id uuid NULL REFERENCES public.coadmin_payment_email_events(id),
  confidence text NOT NULL DEFAULT 'manual',
  enabled boolean NOT NULL DEFAULT true,
  deleted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coadmin_payment_profiles_coadmin_uid_idx
  ON public.coadmin_payment_profiles (coadmin_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_profiles_player_uid_idx
  ON public.coadmin_payment_profiles (player_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_profiles_sender_email_idx
  ON public.coadmin_payment_profiles (lower(payment_sender_email))
  WHERE deleted_at IS NULL AND payment_sender_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_profiles_sender_name_idx
  ON public.coadmin_payment_profiles (lower(payment_sender_name))
  WHERE deleted_at IS NULL AND payment_sender_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_profiles_provider_idx
  ON public.coadmin_payment_profiles (provider)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS coadmin_payment_profiles_active_sender_email_unique
  ON public.coadmin_payment_profiles (coadmin_uid, lower(provider), lower(payment_sender_email))
  WHERE deleted_at IS NULL
    AND enabled = TRUE
    AND payment_sender_email IS NOT NULL
    AND payment_sender_email <> '';
