ALTER TABLE public.players_cache
  ADD COLUMN IF NOT EXISTS active_session_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS active_device_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS active_session_last_seen_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS players_cache_active_session_id_idx
  ON public.players_cache (active_session_id)
  WHERE deleted_at IS NULL AND role = 'player';

-- Unique one-active-session-per-player index is applied separately after duplicate check.
-- See scripts/apply-migration-028.cjs or manual:
--   SELECT player_uid, COUNT(*) FROM player_sessions_cache
--   WHERE deleted_at IS NULL AND active = TRUE GROUP BY player_uid HAVING COUNT(*) > 1;
