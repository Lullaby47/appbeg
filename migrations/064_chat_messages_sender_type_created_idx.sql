CREATE INDEX IF NOT EXISTS chat_messages_cache_sender_type_created_idx
  ON public.chat_messages_cache (sender_uid, type, created_at DESC)
  WHERE deleted_at IS NULL;
