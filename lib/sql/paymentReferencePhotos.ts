import 'server-only';

import { randomUUID } from 'crypto';

import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export type PaymentReferencePhoto = {
  id: string;
  coadminUid: string;
  imageUrl: string;
  cloudinaryPublicId: string | null;
  label: string | null;
  sortOrder: number;
  createdAt: string | null;
};

function mapRow(row: Record<string, unknown>): PaymentReferencePhoto | null {
  const id = cleanText(row.photo_id);
  const coadminUid = cleanText(row.coadmin_uid);
  const imageUrl = cleanText(row.image_url);
  if (!id || !coadminUid || !imageUrl) {
    return null;
  }
  return {
    id,
    coadminUid,
    imageUrl,
    cloudinaryPublicId: cleanText(row.cloudinary_public_id) || null,
    label: cleanText(row.label) || null,
    sortOrder: Number(row.sort_order) || 0,
    createdAt: toIsoString(row.created_at),
  };
}

export async function listPaymentReferencePhotos(
  coadminUid: string
): Promise<PaymentReferencePhoto[]> {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  if (!db || !cleanCoadminUid) {
    return [];
  }

  const result = await db.query(
    `
      SELECT photo_id, coadmin_uid, image_url, cloudinary_public_id, label, sort_order, created_at
      FROM public.payment_reference_photos_cache
      WHERE coadmin_uid = $1
        AND deleted_at IS NULL
        AND is_active = TRUE
      ORDER BY sort_order ASC, created_at ASC
    `,
    [cleanCoadminUid]
  );

  return result.rows
    .map((row) => mapRow(row as Record<string, unknown>))
    .filter((photo): photo is PaymentReferencePhoto => Boolean(photo));
}

export async function upsertPaymentReferencePhoto(input: {
  coadminUid: string;
  imageUrl: string;
  cloudinaryPublicId?: string | null;
  label?: string | null;
  sortOrder?: number;
  rawData?: Record<string, unknown>;
}) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  const imageUrl = cleanText(input.imageUrl);
  if (!db || !coadminUid || !imageUrl) {
    return null;
  }

  const existing = await db.query(
    `
      SELECT photo_id
      FROM public.payment_reference_photos_cache
      WHERE coadmin_uid = $1
        AND image_url = $2
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [coadminUid, imageUrl]
  );
  const existingId = cleanText(existing.rows[0]?.photo_id);
  const photoId = existingId || randomUUID();
  const nowIso = new Date().toISOString();
  const sortOrder = Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0;

  await db.query(
    `
      INSERT INTO public.payment_reference_photos_cache (
        photo_id, coadmin_uid, image_url, cloudinary_public_id, label,
        sort_order, is_active, created_at, updated_at, deleted_at, raw_data
      )
      VALUES (
        $1, $2, $3, NULLIF($4, ''), NULLIF($5, ''),
        $6, TRUE, $7::timestamptz, $7::timestamptz, NULL, $8::jsonb
      )
      ON CONFLICT (photo_id) DO UPDATE SET
        image_url = EXCLUDED.image_url,
        cloudinary_public_id = COALESCE(NULLIF(EXCLUDED.cloudinary_public_id, ''), payment_reference_photos_cache.cloudinary_public_id),
        label = COALESCE(NULLIF(EXCLUDED.label, ''), payment_reference_photos_cache.label),
        sort_order = EXCLUDED.sort_order,
        is_active = TRUE,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL,
        raw_data = EXCLUDED.raw_data
    `,
    [
      photoId,
      coadminUid,
      imageUrl,
      cleanText(input.cloudinaryPublicId),
      cleanText(input.label),
      sortOrder,
      nowIso,
      JSON.stringify(input.rawData || {}),
    ]
  );

  return {
    id: photoId,
    coadminUid,
    imageUrl,
    cloudinaryPublicId: cleanText(input.cloudinaryPublicId) || null,
    label: cleanText(input.label) || null,
    sortOrder,
    createdAt: nowIso,
  } satisfies PaymentReferencePhoto;
}

export async function deletePaymentReferencePhoto(input: {
  coadminUid: string;
  photoId: string;
}) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  const photoId = cleanText(input.photoId);
  if (!db || !coadminUid || !photoId) {
    return { ok: false, cloudinaryPublicId: null as string | null };
  }

  const lookup = await db.query(
    `
      SELECT cloudinary_public_id
      FROM public.payment_reference_photos_cache
      WHERE photo_id = $1
        AND coadmin_uid = $2
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [photoId, coadminUid]
  );
  const cloudinaryPublicId = cleanText(lookup.rows[0]?.cloudinary_public_id) || null;

  const result = await db.query(
    `
      UPDATE public.payment_reference_photos_cache
      SET deleted_at = now(), updated_at = now(), is_active = FALSE
      WHERE photo_id = $1
        AND coadmin_uid = $2
        AND deleted_at IS NULL
    `,
    [photoId, coadminUid]
  );

  return {
    ok: (result.rowCount || 0) > 0,
    cloudinaryPublicId,
  };
}

export async function getRandomPaymentReferencePhotoUrl(coadminUid: string) {
  const photos = await listPaymentReferencePhotos(coadminUid);
  if (!photos.length) {
    return { url: null as string | null, photoId: null as string | null, photoCount: 0 };
  }
  const picked = photos[Math.floor(Math.random() * photos.length)]!;
  return {
    url: picked.imageUrl,
    photoId: picked.id,
    photoCount: photos.length,
  };
}

export async function readLegacyPaymentPhotoUrlsFromPlayersCache(coadminUid: string) {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  if (!db || !cleanCoadminUid) {
    return [] as string[];
  }

  const result = await db.query(
    `
      SELECT raw_firestore_data
      FROM public.players_cache
      WHERE uid = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [cleanCoadminUid]
  );
  const raw = (result.rows[0]?.raw_firestore_data || {}) as Record<string, unknown>;
  const urls = Array.isArray(raw.paymentDetailPhotoUrls)
    ? raw.paymentDetailPhotoUrls.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (urls.length > 0) {
    return urls;
  }
  const photos = Array.isArray(raw.paymentDetailPhotos) ? raw.paymentDetailPhotos : [];
  return photos
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return '';
      }
      return String((entry as { imageUrl?: string }).imageUrl || '').trim();
    })
    .filter(Boolean);
}
