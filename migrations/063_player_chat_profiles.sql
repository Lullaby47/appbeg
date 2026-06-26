CREATE TABLE IF NOT EXISTS public.player_chat_profiles (
  player_uid TEXT PRIMARY KEY,
  coadmin_uid TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  avatar_image_url TEXT NULL,
  avatar_image_public_id TEXT NULL,
  review_status TEXT NOT NULL DEFAULT 'approved',
  suspended_until TIMESTAMPTZ NULL,
  suspension_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ NULL,
  deactivated_at TIMESTAMPTZ NULL,
  CONSTRAINT player_chat_profiles_review_status_check
    CHECK (review_status IN ('approved', 'pending', 'rejected', 'suspended')),
  CONSTRAINT player_chat_profiles_bio_length_check
    CHECK (char_length(bio) <= 120),
  CONSTRAINT player_chat_profiles_active_avatar_name_check
    CHECK (
      is_active = FALSE
      OR char_length(btrim(avatar_name)) BETWEEN 3 AND 32
    ),
  CONSTRAINT player_chat_profiles_active_bio_check
    CHECK (
      is_active = FALSE
      OR char_length(btrim(bio)) BETWEEN 1 AND 120
    )
);

CREATE INDEX IF NOT EXISTS player_chat_profiles_active_directory_idx
  ON public.player_chat_profiles (coadmin_uid, is_active, updated_at DESC)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS player_chat_profiles_avatar_name_lower_idx
  ON public.player_chat_profiles (lower(avatar_name))
  WHERE is_active = TRUE;
