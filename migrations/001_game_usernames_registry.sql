CREATE TABLE IF NOT EXISTS game_usernames (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  game VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS player_uid TEXT NULL;
ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS coadmin_uid TEXT NULL;
ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS source TEXT NULL;
ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE game_usernames ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS game_usernames_username_idx ON game_usernames (username);
CREATE INDEX IF NOT EXISTS game_usernames_game_idx ON game_usernames (game);
CREATE INDEX IF NOT EXISTS game_usernames_coadmin_uid_idx ON game_usernames (coadmin_uid);
