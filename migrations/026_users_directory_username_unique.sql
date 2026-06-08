-- Active username uniqueness for SQL user directory authority (idempotent).

CREATE UNIQUE INDEX IF NOT EXISTS players_cache_username_active_unique
  ON public.players_cache (LOWER(username))
  WHERE deleted_at IS NULL AND username IS NOT NULL AND BTRIM(username) <> '';
