CREATE TABLE IF NOT EXISTS public.coadmin_maintenance_cache (
  coadmin_uid TEXT PRIMARY KEY,
  maintenance_break JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  title TEXT NULL,
  message TEXT NULL,
  source TEXT NOT NULL DEFAULT 'firestore',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS coadmin_maintenance_cache_enabled_idx
  ON public.coadmin_maintenance_cache (enabled)
  WHERE deleted_at IS NULL;
