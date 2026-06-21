CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.payment_email_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  listener_id text NULL,
  coadmin_uid text NULL,
  provider text NULL,
  message_id text NULL,
  subject text NULL,
  from_header text NULL,
  to_header text NULL,
  reply_to_header text NULL,
  return_path_header text NULL,
  delivered_to_header text NULL,
  date_header text NULL,
  received_at timestamptz NULL,
  received_headers jsonb NOT NULL DEFAULT '[]'::jsonb,
  authentication_results text NULL,
  spf_result text NULL,
  dkim_result text NULL,
  dmarc_result text NULL,
  message_id_domain text NULL,
  from_domain text NULL,
  return_path_domain text NULL,
  reply_to_domain text NULL,
  parsed_username text NULL,
  parsed_amount numeric NULL,
  parsed_transaction_id text NULL,
  parsed_payment_time timestamptz NULL,
  has_forwarded_indicators boolean NULL,
  raw_text_hash text NULL,
  raw_html_hash text NULL,
  raw_source_hash text NULL,
  header_preview text NULL,
  parser_result text NULL,
  load_result text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS payment_email_audit_logs_listener_created_idx
  ON public.payment_email_audit_logs (listener_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_email_audit_logs_message_id_idx
  ON public.payment_email_audit_logs (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_email_audit_logs_domains_idx
  ON public.payment_email_audit_logs (from_domain, return_path_domain, message_id_domain);

CREATE INDEX IF NOT EXISTS payment_email_audit_logs_metadata_gin_idx
  ON public.payment_email_audit_logs USING gin (metadata);
