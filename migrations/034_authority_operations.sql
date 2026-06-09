CREATE TABLE IF NOT EXISTS public.authority_operations (
  operation_key TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  user_uid TEXT NULL,
  source_id TEXT NULL,
  actor_uid TEXT NULL,
  actor_role TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS authority_operations_user_created_idx
  ON public.authority_operations (user_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS authority_operations_type_created_idx
  ON public.authority_operations (operation_type, created_at DESC);
