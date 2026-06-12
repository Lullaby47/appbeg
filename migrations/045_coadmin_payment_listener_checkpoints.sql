CREATE TABLE IF NOT EXISTS public.coadmin_payment_listener_checkpoints (
  listener_id uuid PRIMARY KEY REFERENCES public.coadmin_payment_listeners(id),
  uidvalidity bigint NULL,
  last_uid bigint NULL,
  last_seen_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
