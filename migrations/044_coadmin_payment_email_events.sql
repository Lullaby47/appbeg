CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.coadmin_payment_email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_email_id uuid NOT NULL REFERENCES public.coadmin_payment_raw_emails(id),
  listener_id uuid NOT NULL REFERENCES public.coadmin_payment_listeners(id),
  coadmin_uid text NOT NULL,
  detected_amount numeric NULL,
  detected_username text NULL,
  detected_provider text NULL,
  status text NOT NULL,
  parse_notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT coadmin_payment_email_events_status_check
    CHECK (status IN ('parsed', 'manual_review', 'duplicate', 'failed'))
);

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_raw_email_id_idx
  ON public.coadmin_payment_email_events (raw_email_id);

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_listener_status_idx
  ON public.coadmin_payment_email_events (listener_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_coadmin_created_idx
  ON public.coadmin_payment_email_events (coadmin_uid, created_at DESC);
