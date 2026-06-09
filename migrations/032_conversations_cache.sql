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
