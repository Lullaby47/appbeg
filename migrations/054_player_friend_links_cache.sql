CREATE TABLE IF NOT EXISTS public.player_friend_links_cache (
  link_id text PRIMARY KEY,
  participant_a_uid text NOT NULL,
  participant_b_uid text NOT NULL,
  participants text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_by_uid text NOT NULL,
  accepted_by_uid text,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  raw_firestore_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_system text NOT NULL DEFAULT 'sql',
  mirrored_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT player_friend_links_distinct_players
    CHECK (participant_a_uid <> participant_b_uid),
  CONSTRAINT player_friend_links_sorted_pair
    CHECK (participant_a_uid < participant_b_uid),
  CONSTRAINT player_friend_links_participants_pair
    CHECK (
      cardinality(participants) = 2
      AND participant_a_uid = participants[1]
      AND participant_b_uid = participants[2]
    ),
  CONSTRAINT player_friend_links_status_check
    CHECK (status IN ('pending', 'accepted', 'blocked', 'declined')),
  CONSTRAINT player_friend_links_requested_by_participant
    CHECK (requested_by_uid IN (participant_a_uid, participant_b_uid)),
  CONSTRAINT player_friend_links_accepted_by_participant
    CHECK (accepted_by_uid IS NULL OR accepted_by_uid IN (participant_a_uid, participant_b_uid))
);

CREATE UNIQUE INDEX IF NOT EXISTS player_friend_links_active_pair_unique
  ON public.player_friend_links_cache (participant_a_uid, participant_b_uid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_friend_links_participant_a_idx
  ON public.player_friend_links_cache (participant_a_uid, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_friend_links_participant_b_idx
  ON public.player_friend_links_cache (participant_b_uid, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS player_friend_links_status_idx
  ON public.player_friend_links_cache (status, updated_at DESC)
  WHERE deleted_at IS NULL;
