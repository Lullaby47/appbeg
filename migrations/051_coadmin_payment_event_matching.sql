ALTER TABLE public.coadmin_payment_email_events
  ADD COLUMN IF NOT EXISTS matched_player_uid text NULL,
  ADD COLUMN IF NOT EXISTS matched_username text NULL,
  ADD COLUMN IF NOT EXISTS match_method text NULL,
  ADD COLUMN IF NOT EXISTS match_confidence text NULL,
  ADD COLUMN IF NOT EXISTS match_reason text NULL,
  ADD COLUMN IF NOT EXISTS discarded_at timestamptz NULL;

ALTER TABLE public.coadmin_payment_email_events
  DROP CONSTRAINT IF EXISTS coadmin_payment_email_events_status_check;

ALTER TABLE public.coadmin_payment_email_events
  ADD CONSTRAINT coadmin_payment_email_events_status_check
  CHECK (status IN ('parsed', 'matched', 'manual_review', 'discarded', 'duplicate', 'failed'));

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_matched_player_idx
  ON public.coadmin_payment_email_events (matched_player_uid, created_at DESC)
  WHERE matched_player_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_match_method_idx
  ON public.coadmin_payment_email_events (match_method, created_at DESC)
  WHERE match_method IS NOT NULL;

CREATE INDEX IF NOT EXISTS coadmin_payment_email_events_match_reason_idx
  ON public.coadmin_payment_email_events (match_reason, created_at DESC)
  WHERE match_reason IS NOT NULL;
