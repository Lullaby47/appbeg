CREATE TABLE IF NOT EXISTS public.reward_cuts_cache (
  firebase_id TEXT PRIMARY KEY,
  coadmin_uid TEXT NULL,
  worker_uid TEXT NULL,
  worker_role TEXT NULL,
  worker_username TEXT NULL,
  amount_npr NUMERIC NULL,
  reason TEXT NULL,
  created_by_uid TEXT NULL,
  created_at TIMESTAMPTZ NULL,
  source TEXT DEFAULT 'firestore',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS reward_cuts_cache_coadmin_created_idx
  ON public.reward_cuts_cache (coadmin_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS reward_cuts_cache_worker_created_idx
  ON public.reward_cuts_cache (worker_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS reward_cuts_cache_worker_role_created_idx
  ON public.reward_cuts_cache (worker_uid, worker_role, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS reward_cuts_cache_created_by_created_idx
  ON public.reward_cuts_cache (created_by_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS reward_cuts_cache_mirrored_at_idx
  ON public.reward_cuts_cache (mirrored_at DESC);

CREATE INDEX IF NOT EXISTS reward_cuts_cache_raw_firestore_data_gin_idx
  ON public.reward_cuts_cache USING GIN (raw_firestore_data);
