ALTER TABLE public.chat_messages_cache
  ADD COLUMN IF NOT EXISTS deleted_for_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_for_everyone_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS chat_messages_cache_deleted_for_everyone_idx
  ON public.chat_messages_cache (deleted_for_everyone)
  WHERE deleted_at IS NULL;
