-- Deep provider payment email analysis fields for coadmin-agent.

ALTER TABLE public.coadmin_payment_email_events
  ADD COLUMN IF NOT EXISTS provider_domain text NULL,
  ADD COLUMN IF NOT EXISTS provider_original_sender text NULL,
  ADD COLUMN IF NOT EXISTS provider_original_subject text NULL,
  ADD COLUMN IF NOT EXISTS transaction_id text NULL,
  ADD COLUMN IF NOT EXISTS reference_id text NULL,
  ADD COLUMN IF NOT EXISTS confirmation_number text NULL,
  ADD COLUMN IF NOT EXISTS payment_status text NULL,
  ADD COLUMN IF NOT EXISTS transfer_type text NULL,
  ADD COLUMN IF NOT EXISTS recipient_name text NULL,
  ADD COLUMN IF NOT EXISTS recipient_email text NULL,
  ADD COLUMN IF NOT EXISTS payment_note text NULL,
  ADD COLUMN IF NOT EXISTS memo text NULL,
  ADD COLUMN IF NOT EXISTS description text NULL,
  ADD COLUMN IF NOT EXISTS payment_date text NULL,
  ADD COLUMN IF NOT EXISTS payment_time text NULL,
  ADD COLUMN IF NOT EXISTS original_email_date text NULL,
  ADD COLUMN IF NOT EXISTS transaction_candidates_json text NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_transaction_id_idx
  ON public.coadmin_payment_email_events (transaction_id, created_at DESC)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_provider_domain_idx
  ON public.coadmin_payment_email_events (provider_domain, created_at DESC)
  WHERE provider_domain IS NOT NULL;
