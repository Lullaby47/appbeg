ALTER TABLE public.coadmin_payment_email_events
  ADD COLUMN IF NOT EXISTS classification text NULL,
  ADD COLUMN IF NOT EXISTS direction text NULL,
  ADD COLUMN IF NOT EXISTS classification_confidence numeric NULL,
  ADD COLUMN IF NOT EXISTS classification_reason text NULL,
  ADD COLUMN IF NOT EXISTS auto_recharge_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provider_transaction_id text NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_classification_idx
  ON public.coadmin_payment_email_events (classification, created_at DESC)
  WHERE classification IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_auto_recharge_idx
  ON public.coadmin_payment_email_events (auto_recharge_allowed, created_at DESC)
  WHERE auto_recharge_allowed = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS coadmin_payment_email_events_listener_provider_tx_unique
  ON public.coadmin_payment_email_events (listener_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL
    AND provider_transaction_id <> '';
