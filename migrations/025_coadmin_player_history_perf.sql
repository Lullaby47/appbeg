-- Coadmin player history read-path indexes (idempotent).

CREATE INDEX IF NOT EXISTS player_game_requests_cache_player_created_idx
  ON public.player_game_requests_cache (player_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_cashout_tasks_cache_player_status_completed_idx
  ON public.player_cashout_tasks_cache (player_uid, status, completed_at DESC)
  WHERE deleted_at IS NULL;
