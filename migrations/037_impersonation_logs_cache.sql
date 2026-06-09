CREATE TABLE IF NOT EXISTS public.impersonation_logs_cache (
  log_id BIGSERIAL PRIMARY KEY,
  coadmin_uid TEXT NOT NULL,
  coadmin_username TEXT NULL,
  staff_uid TEXT NOT NULL,
  staff_username TEXT NULL,
  source TEXT NOT NULL DEFAULT 'authority',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS impersonation_logs_cache_coadmin_created_idx
  ON public.impersonation_logs_cache (coadmin_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS impersonation_logs_cache_staff_created_idx
  ON public.impersonation_logs_cache (staff_uid, created_at DESC);
