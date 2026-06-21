CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.payment_email_processing_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listener_id text NOT NULL,
  uidvalidity bigint NULL,
  uid bigint NOT NULL,
  message_id text NULL,
  status text NOT NULL DEFAULT 'RETRY_PENDING',
  failure_count integer NOT NULL DEFAULT 0,
  last_error text NULL,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_email_processing_failures_status_check
    CHECK (status IN ('RETRY_PENDING', 'FAILED_PERMANENTLY', 'SKIPPED_AFTER_MAX_RETRIES'))
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_email_processing_failures_uid_unique
  ON public.payment_email_processing_failures (
    listener_id,
    COALESCE(uidvalidity, -1),
    uid
  );

CREATE INDEX IF NOT EXISTS payment_email_processing_failures_status_idx
  ON public.payment_email_processing_failures (listener_id, status, updated_at DESC);
