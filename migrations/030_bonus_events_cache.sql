CREATE TABLE IF NOT EXISTS public.bonus_events_cache (
  firebase_id TEXT PRIMARY KEY,

  coadmin_uid TEXT NULL,
  bonus_name TEXT NULL,
  game_name TEXT NULL,
  amount_npr NUMERIC NULL,
  bonus_percentage NUMERIC NULL,
  description TEXT NULL,

  created_by_uid TEXT NULL,
  created_by_username TEXT NULL,
  created_by_role TEXT NULL,

  status TEXT NULL,
  start_date TIMESTAMPTZ NULL,
  end_date TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,

  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'mirror',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_bonus_events_cache_coadmin_uid
  ON public.bonus_events_cache (coadmin_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bonus_events_cache_status
  ON public.bonus_events_cache (status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bonus_events_cache_coadmin_status_created
  ON public.bonus_events_cache (coadmin_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bonus_events_cache_deleted_at
  ON public.bonus_events_cache (deleted_at);
