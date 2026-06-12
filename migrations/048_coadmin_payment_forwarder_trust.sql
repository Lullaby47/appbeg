-- Trusted forwarder fields for coadmin payment email events.

ALTER TABLE public.coadmin_payment_email_events
  ADD COLUMN IF NOT EXISTS forwarder_email text NULL,
  ADD COLUMN IF NOT EXISTS is_trusted_forwarder boolean NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_forwarder_email_idx
  ON public.coadmin_payment_email_events (forwarder_email, created_at DESC)
  WHERE forwarder_email IS NOT NULL;
