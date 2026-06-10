-- Payment reference photos metadata (Cloudinary URLs; SQL authority in SQL mode).

CREATE TABLE IF NOT EXISTS public.payment_reference_photos_cache (
  photo_id TEXT PRIMARY KEY,
  coadmin_uid TEXT NOT NULL,
  image_url TEXT NOT NULL,
  cloudinary_public_id TEXT NULL,
  label TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS payment_reference_photos_cache_coadmin_active_idx
  ON public.payment_reference_photos_cache (coadmin_uid, sort_order, created_at)
  WHERE deleted_at IS NULL AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS payment_reference_photos_cache_deleted_at_idx
  ON public.payment_reference_photos_cache (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_reference_photos_cache_coadmin_url_uidx
  ON public.payment_reference_photos_cache (coadmin_uid, image_url)
  WHERE deleted_at IS NULL;
