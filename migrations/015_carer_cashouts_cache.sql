CREATE TABLE IF NOT EXISTS public.carer_cashouts_cache (
  firebase_id TEXT PRIMARY KEY,
  coadmin_uid TEXT NULL,
  carer_uid TEXT NULL,
  carer_username TEXT NULL,
  worker_uid TEXT NULL,
  worker_role TEXT NULL,
  amount_npr NUMERIC NULL,
  completed_amount_npr NUMERIC NULL,
  remaining_amount_npr NUMERIC NULL,
  payment_qr_url TEXT NULL,
  payment_qr_public_id TEXT NULL,
  payment_details TEXT NULL,
  status TEXT NULL,
  created_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  source TEXT DEFAULT 'firestore',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS carer_cashouts_cache_coadmin_status_created_idx
  ON public.carer_cashouts_cache (coadmin_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_cashouts_cache_carer_created_idx
  ON public.carer_cashouts_cache (carer_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_cashouts_cache_carer_status_created_idx
  ON public.carer_cashouts_cache (carer_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_cashouts_cache_status_created_idx
  ON public.carer_cashouts_cache (status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_cashouts_cache_completed_at_idx
  ON public.carer_cashouts_cache (completed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_cashouts_cache_mirrored_at_idx
  ON public.carer_cashouts_cache (mirrored_at DESC);

CREATE INDEX IF NOT EXISTS carer_cashouts_cache_raw_firestore_data_gin_idx
  ON public.carer_cashouts_cache USING GIN (raw_firestore_data);
