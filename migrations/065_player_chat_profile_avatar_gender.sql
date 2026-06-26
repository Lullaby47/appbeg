ALTER TABLE public.player_chat_profiles
  ADD COLUMN IF NOT EXISTS avatar_emoji TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  ALTER TABLE public.player_chat_profiles
    ADD CONSTRAINT player_chat_profiles_gender_check
    CHECK (gender IN ('', 'male', 'female'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.player_chat_profiles
    ADD CONSTRAINT player_chat_profiles_active_avatar_emoji_check
    CHECK (is_active = FALSE OR char_length(btrim(avatar_emoji)) > 0) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.player_chat_profiles
    ADD CONSTRAINT player_chat_profiles_active_gender_check
    CHECK (is_active = FALSE OR gender IN ('male', 'female')) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
