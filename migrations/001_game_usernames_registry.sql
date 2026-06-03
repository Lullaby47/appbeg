CREATE TABLE IF NOT EXISTS game_usernames (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  game VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS player_uid TEXT NULL;
ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS coadmin_uid TEXT NULL;
ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS source TEXT NULL;
ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

ALTER TABLE game_usernames DROP CONSTRAINT IF EXISTS game_usernames_username_key;
DROP INDEX IF EXISTS game_usernames_username_idx;
CREATE UNIQUE INDEX IF NOT EXISTS game_usernames_active_username_unique
ON game_usernames (lower(username))
WHERE status = 'active';
CREATE INDEX IF NOT EXISTS game_usernames_game_idx ON game_usernames (game);
CREATE INDEX IF NOT EXISTS game_usernames_coadmin_uid_idx ON game_usernames (coadmin_uid);
