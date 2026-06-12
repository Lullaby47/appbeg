CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.coadmin_payment_raw_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listener_id uuid NOT NULL REFERENCES public.coadmin_payment_listeners(id),
  coadmin_uid text NOT NULL,
  mailbox text NOT NULL,
  uidvalidity bigint NULL,
  uid bigint NULL,
  message_id text NULL,
  subject text NULL,
  from_email text NULL,
  received_at timestamptz NULL,
  raw_rfc822 text NULL,
  raw_size_bytes bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT coadmin_payment_raw_emails_listener_uid_unique
    UNIQUE (listener_id, uidvalidity, uid)
);

CREATE INDEX IF NOT EXISTS coadmin_payment_raw_emails_listener_id_idx
  ON public.coadmin_payment_raw_emails (listener_id);

CREATE INDEX IF NOT EXISTS coadmin_payment_raw_emails_message_id_idx
  ON public.coadmin_payment_raw_emails (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_raw_emails_listener_uid_idx
  ON public.coadmin_payment_raw_emails (listener_id, uidvalidity, uid);
