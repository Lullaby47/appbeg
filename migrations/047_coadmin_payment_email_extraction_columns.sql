-- Payment email extraction columns for coadmin-agent.
-- Safe to run if 046 was never applied (all ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.coadmin_payment_raw_emails
  ADD COLUMN IF NOT EXISTS from_name text NULL,
  ADD COLUMN IF NOT EXISTS reply_to text NULL,
  ADD COLUMN IF NOT EXISTS to_email text NULL,
  ADD COLUMN IF NOT EXISTS date_header text NULL,
  ADD COLUMN IF NOT EXISTS body_text_preview text NULL,
  ADD COLUMN IF NOT EXISTS body_html_preview text NULL,
  ADD COLUMN IF NOT EXISTS provider_guess text NULL,
  ADD COLUMN IF NOT EXISTS provider_confidence text NULL;

ALTER TABLE public.coadmin_payment_email_events
  ADD COLUMN IF NOT EXISTS listener_label text NULL,
  ADD COLUMN IF NOT EXISTS payment_sender_name text NULL,
  ADD COLUMN IF NOT EXISTS payment_sender_email text NULL,
  ADD COLUMN IF NOT EXISTS detected_currency text NULL,
  ADD COLUMN IF NOT EXISTS detected_note text NULL,
  ADD COLUMN IF NOT EXISTS provider_guess text NULL,
  ADD COLUMN IF NOT EXISTS provider_confidence text NULL,
  ADD COLUMN IF NOT EXISTS provider_confidence_reason text NULL,
  ADD COLUMN IF NOT EXISTS body_text_preview text NULL,
  ADD COLUMN IF NOT EXISTS body_html_preview text NULL,
  ADD COLUMN IF NOT EXISTS parse_reason text NULL,
  ADD COLUMN IF NOT EXISTS is_forwarded boolean NULL,
  ADD COLUMN IF NOT EXISTS original_from_name text NULL,
  ADD COLUMN IF NOT EXISTS original_from_email text NULL,
  ADD COLUMN IF NOT EXISTS original_subject text NULL,
  ADD COLUMN IF NOT EXISTS original_date text NULL,
  ADD COLUMN IF NOT EXISTS original_reply_to text NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_provider_guess_idx
  ON public.coadmin_payment_email_events (provider_guess, created_at DESC)
  WHERE provider_guess IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_parse_reason_idx
  ON public.coadmin_payment_email_events (parse_reason, created_at DESC)
  WHERE parse_reason IS NOT NULL;
