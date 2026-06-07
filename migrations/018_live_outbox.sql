CREATE TABLE IF NOT EXISTS public.live_outbox (
  outbox_id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash TEXT NULL,
  source TEXT NOT NULL DEFAULT 'mirror',
  mirrored_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notify_sent_at TIMESTAMPTZ NULL,
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS live_outbox_channel_outbox_id_idx
  ON public.live_outbox (channel, outbox_id);

CREATE INDEX IF NOT EXISTS live_outbox_entity_type_entity_id_outbox_id_idx
  ON public.live_outbox (entity_type, entity_id, outbox_id DESC);

CREATE INDEX IF NOT EXISTS live_outbox_created_at_idx
  ON public.live_outbox (created_at);

CREATE INDEX IF NOT EXISTS live_outbox_payload_hash_idx
  ON public.live_outbox (payload_hash);

CREATE INDEX IF NOT EXISTS live_outbox_deleted_at_idx
  ON public.live_outbox (deleted_at);

CREATE OR REPLACE FUNCTION public.live_outbox_notify_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('live_outbox', NEW.outbox_id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS live_outbox_after_insert_notify ON public.live_outbox;

CREATE TRIGGER live_outbox_after_insert_notify
  AFTER INSERT ON public.live_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.live_outbox_notify_insert();
