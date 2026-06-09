CREATE TABLE IF NOT EXISTS public.chat_messages_cache (
  firebase_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_uid TEXT NULL,
  receiver_uid TEXT NULL,
  type TEXT NULL,
  text TEXT NULL,
  image_url TEXT NULL,
  image_public_id TEXT NULL,
  created_at TIMESTAMPTZ NULL,
  raw_firestore_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'mirror',
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS chat_messages_cache_conversation_created_idx
  ON public.chat_messages_cache (conversation_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_messages_cache_sender_idx
  ON public.chat_messages_cache (sender_uid)
  WHERE deleted_at IS NULL;
