ALTER TABLE public.coadmin_payment_email_events
  ADD COLUMN IF NOT EXISTS loaded_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS loaded_player_uid text NULL,
  ADD COLUMN IF NOT EXISTS loaded_username text NULL,
  ADD COLUMN IF NOT EXISTS loaded_amount numeric NULL,
  ADD COLUMN IF NOT EXISTS load_method text NULL,
  ADD COLUMN IF NOT EXISTS load_status text NULL,
  ADD COLUMN IF NOT EXISTS load_error text NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_loaded_at_idx
  ON public.coadmin_payment_email_events (loaded_at DESC)
  WHERE loaded_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_load_status_idx
  ON public.coadmin_payment_email_events (load_status, created_at DESC)
  WHERE load_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_loaded_player_idx
  ON public.coadmin_payment_email_events (loaded_player_uid, loaded_at DESC)
  WHERE loaded_player_uid IS NOT NULL;
