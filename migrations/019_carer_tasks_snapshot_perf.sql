-- Carer live snapshot read-path indexes (idempotent).

CREATE INDEX IF NOT EXISTS carer_tasks_cache_coadmin_created_idx
  ON public.carer_tasks_cache (coadmin_uid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS carer_tasks_cache_assigned_status_created_idx
  ON public.carer_tasks_cache (assigned_carer_uid, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS live_outbox_channel_outbox_id_active_idx
  ON public.live_outbox (channel, outbox_id DESC)
  WHERE deleted_at IS NULL;
