CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.coadmin_payment_listeners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coadmin_uid text NOT NULL,
  label text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  email text NOT NULL,
  imap_host text NOT NULL,
  imap_port integer NOT NULL DEFAULT 993,
  use_ssl boolean NOT NULL DEFAULT true,
  encrypted_password text NOT NULL,
  auto_load boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  last_checked_at timestamptz NULL,
  last_success_at timestamptz NULL,
  last_error text NULL,
  deleted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coadmin_payment_listeners_coadmin_active_idx
  ON public.coadmin_payment_listeners (coadmin_uid, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_listeners_enabled_active_idx
  ON public.coadmin_payment_listeners (enabled, updated_at DESC)
  WHERE deleted_at IS NULL;
