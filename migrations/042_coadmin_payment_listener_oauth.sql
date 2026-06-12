ALTER TABLE public.coadmin_payment_listeners
  ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'password',
  ADD COLUMN IF NOT EXISTS encrypted_refresh_token text NULL,
  ADD COLUMN IF NOT EXISTS microsoft_user_id text NULL,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz NULL;

ALTER TABLE public.coadmin_payment_listeners
  ALTER COLUMN encrypted_password DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'coadmin_payment_listeners_auth_type_check'
  ) THEN
    ALTER TABLE public.coadmin_payment_listeners
      ADD CONSTRAINT coadmin_payment_listeners_auth_type_check
      CHECK (auth_type IN ('password', 'oauth'));
  END IF;
END $$;
