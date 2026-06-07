CREATE TABLE IF NOT EXISTS public.transfer_requests_cache (
  firebase_id TEXT PRIMARY KEY,

  player_uid TEXT NULL,
  player_username TEXT NULL,
  coadmin_uid TEXT NULL,

  amount_npr NUMERIC NULL,
  cash_balance_snapshot NUMERIC NULL,

  status TEXT NULL,

  requested_by_uid TEXT NULL,
  requested_by_username TEXT NULL,
  requested_at TIMESTAMPTZ NULL,

  approved_by_uid TEXT NULL,
  approved_by_username TEXT NULL,
  approved_at TIMESTAMPTZ NULL,

  rejected_by_uid TEXT NULL,
  rejected_by_username TEXT NULL,
  rejected_at TIMESTAMPTZ NULL,
  rejection_reason TEXT NULL,

  auto_approved BOOLEAN NULL,
  reviewed BOOLEAN NULL,

  processed_at TIMESTAMPTZ NULL,

  source TEXT DEFAULT 'firestore',

  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,

  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS transfer_requests_cache_coadmin_status_requested_idx
  ON public.transfer_requests_cache (coadmin_uid, status, requested_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS transfer_requests_cache_player_requested_idx
  ON public.transfer_requests_cache (player_uid, requested_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS transfer_requests_cache_status_requested_idx
  ON public.transfer_requests_cache (status, requested_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS transfer_requests_cache_approved_at_idx
  ON public.transfer_requests_cache (approved_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS transfer_requests_cache_rejected_at_idx
  ON public.transfer_requests_cache (rejected_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS transfer_requests_cache_processed_at_idx
  ON public.transfer_requests_cache (processed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS transfer_requests_cache_requested_by_requested_idx
  ON public.transfer_requests_cache (requested_by_uid, requested_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS transfer_requests_cache_approved_by_approved_idx
  ON public.transfer_requests_cache (approved_by_uid, approved_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS transfer_requests_cache_raw_firestore_data_gin_idx
  ON public.transfer_requests_cache USING GIN (raw_firestore_data);
