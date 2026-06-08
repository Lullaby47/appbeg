CREATE TABLE IF NOT EXISTS public.automation_auto_state_cache (
  carer_uid TEXT PRIMARY KEY,
  coadmin_uid TEXT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  automation_agent_id TEXT NULL,
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'mirror',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS automation_auto_state_cache_carer_uid_idx
  ON public.automation_auto_state_cache (carer_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS automation_auto_state_cache_coadmin_uid_idx
  ON public.automation_auto_state_cache (coadmin_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS automation_auto_state_cache_enabled_idx
  ON public.automation_auto_state_cache (enabled)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS automation_auto_state_cache_lease_expires_at_idx
  ON public.automation_auto_state_cache (lease_expires_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS automation_auto_state_cache_deleted_at_idx
  ON public.automation_auto_state_cache (deleted_at);
