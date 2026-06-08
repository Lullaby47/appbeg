-- AppBeg SQL password credentials (captured after Firebase login; hashes only).

CREATE TABLE IF NOT EXISTS public.user_credentials (
  uid TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_algo TEXT NOT NULL,
  password_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  migrated_from_firebase BOOLEAN NOT NULL DEFAULT TRUE,
  must_reset BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_credentials_password_updated_at_idx
  ON public.user_credentials (password_updated_at);

CREATE INDEX IF NOT EXISTS user_credentials_migrated_from_firebase_idx
  ON public.user_credentials (migrated_from_firebase);
