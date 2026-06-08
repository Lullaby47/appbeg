CREATE TABLE IF NOT EXISTS public.carer_creation_requests_cache (
  request_id TEXT PRIMARY KEY,

  coadmin_uid TEXT NOT NULL,
  coadmin_username TEXT NULL,
  username TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending',
  requested_role TEXT NOT NULL DEFAULT 'carer',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ NULL,
  reviewed_by_uid TEXT NULL,
  reviewed_by_username TEXT NULL,
  rejection_reason TEXT NULL,
  created_carer_uid TEXT NULL,

  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'sql',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS carer_creation_requests_cache_status_created_idx
  ON public.carer_creation_requests_cache (status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_creation_requests_cache_coadmin_status_created_idx
  ON public.carer_creation_requests_cache (coadmin_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS carer_creation_requests_cache_pending_coadmin_username_idx
  ON public.carer_creation_requests_cache (coadmin_uid, LOWER(username))
  WHERE deleted_at IS NULL AND status = 'pending';

CREATE INDEX IF NOT EXISTS carer_creation_requests_cache_raw_firestore_data_gin_idx
  ON public.carer_creation_requests_cache USING GIN (raw_firestore_data);
