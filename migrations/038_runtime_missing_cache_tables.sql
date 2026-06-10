-- Production runtime cache tables (idempotent).
-- Fixes 42P01 on /api/bonus-events/list, /api/chat/unread-counts,
-- /api/presence/batch, and /api/presence/heartbeat.
-- Safe to re-run: all statements use IF NOT EXISTS.

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

CREATE TABLE IF NOT EXISTS public.user_presence_cache (
  uid TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS user_presence_cache_last_seen_at_idx
  ON public.user_presence_cache (last_seen_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS user_presence_cache_uid_active_idx
  ON public.user_presence_cache (uid)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.conversations_cache (
  firebase_id TEXT PRIMARY KEY,
  participant_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_message TEXT NULL,
  last_message_sender_uid TEXT NULL,
  unread_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'mirror',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS conversations_cache_updated_at_idx
  ON public.conversations_cache (updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS conversations_cache_participants_gin_idx
  ON public.conversations_cache USING GIN (participant_uids)
  WHERE deleted_at IS NULL;
