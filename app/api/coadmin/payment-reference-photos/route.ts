import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { tryDestroyCloudinaryAsset } from '@/lib/server/cloudinaryDestroy';
import { logCacheSqlRead } from '@/lib/server/cacheSqlRead';
import {
  logPaymentReferencePhotoAudit,
  logPaymentReferencePhotoSqlWrite,
} from '@/lib/paymentReferencePhotoAudit';
import {
  deletePaymentReferencePhoto,
  listPaymentReferencePhotos,
  upsertPaymentReferencePhoto,
} from '@/lib/sql/paymentReferencePhotos';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/payment-reference-photos';

function resolveCoadminUid(
  authUser: { role: string; uid: string },
  requestedCoadminUid: string,
  scoped: string | null
) {
  if (authUser.role === 'admin') {
    return requestedCoadminUid || scoped || authUser.uid;
  }
  if (authUser.role === 'coadmin') {
    return authUser.uid;
  }
  return '';
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return auth.response;
  }

  if (!isDatabaseUrlConfigured()) {
    return apiError('Payment reference photos are unavailable right now.', 503);
  }

  const requestedCoadminUid = cleanText(new URL(request.url).searchParams.get('coadminUid'));
  const scoped = scopedCoadminUid(auth.user);
  const coadminUid = resolveCoadminUid(auth.user, requestedCoadminUid, scoped);
  if (!coadminUid) {
    return apiError('Forbidden.', 403);
  }

  const photos = await listPaymentReferencePhotos(coadminUid);
  logCacheSqlRead(ROUTE, {
    coadminUid,
    count: photos.length,
    durationMs: Date.now() - startedAt,
  });
  logPaymentReferencePhotoAudit({
    routeOrPage: ROUTE,
    role: auth.user.role,
    coadminUid,
    source: 'payment_reference_photos_cache',
    cloudinaryUsed: photos.some((photo) => Boolean(photo.cloudinaryPublicId || photo.imageUrl)),
    tableOrCollection: 'payment_reference_photos_cache',
    photoCount: photos.length,
    samplePhotoIds: photos.map((photo) => photo.cloudinaryPublicId || photo.id).filter(Boolean).slice(0, 3),
    sampleUrlsPresent: photos.some((photo) => Boolean(photo.imageUrl)),
    reason: photos.length > 0 ? 'sql_list_ok' : 'sql_list_empty',
  });

  return NextResponse.json({
    photos: photos.map((photo) => ({
      id: photo.id,
      imageUrl: photo.imageUrl,
      imagePublicId: photo.cloudinaryPublicId || '',
      label: photo.label,
      sortOrder: photo.sortOrder,
      createdAt: photo.createdAt,
    })),
    source: 'postgres',
    firestore_fallback: false,
  });
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return auth.response;
  }

  if (!isDatabaseUrlConfigured()) {
    return apiError('Payment reference photos are unavailable right now.', 503);
  }

  const body = (await request.json().catch(() => ({}))) as {
    coadminUid?: string;
    imageUrl?: string;
    cloudinaryPublicId?: string;
    label?: string;
  };

  const requestedCoadminUid = cleanText(body.coadminUid);
  const scoped = scopedCoadminUid(auth.user);
  const coadminUid = resolveCoadminUid(auth.user, requestedCoadminUid, scoped);
  if (!coadminUid) {
    return apiError('Forbidden.', 403);
  }

  const imageUrl = cleanText(body.imageUrl);
  if (!imageUrl) {
    return apiError('imageUrl is required.', 400);
  }

  const saved = await upsertPaymentReferencePhoto({
    coadminUid,
    imageUrl,
    cloudinaryPublicId: cleanText(body.cloudinaryPublicId) || null,
    label: cleanText(body.label) || null,
    rawData: {
      source: 'coadmin_api',
      uploadedBy: auth.user.uid,
    },
  });

  if (!saved) {
    logPaymentReferencePhotoSqlWrite({
      action: 'create',
      coadminUid,
      photoId: '',
      hasImageUrl: true,
      hasCloudinaryPublicId: Boolean(cleanText(body.cloudinaryPublicId)),
      ok: false,
      reason: 'upsert_failed',
    });
    return apiError('Failed to save payment reference photo.', 500);
  }

  logPaymentReferencePhotoSqlWrite({
    action: 'create',
    coadminUid,
    photoId: saved.id,
    hasImageUrl: Boolean(saved.imageUrl),
    hasCloudinaryPublicId: Boolean(saved.cloudinaryPublicId),
    ok: true,
    reason: 'sql_upsert_ok',
  });
  logPaymentReferencePhotoAudit({
    routeOrPage: ROUTE,
    role: auth.user.role,
    coadminUid,
    source: 'payment_reference_photos_cache',
    cloudinaryUsed: true,
    tableOrCollection: 'payment_reference_photos_cache',
    photoCount: 1,
    samplePhotoIds: [saved.cloudinaryPublicId || saved.id].filter(Boolean),
    sampleUrlsPresent: Boolean(saved.imageUrl),
    reason: 'sql_create_ok',
  });

  return NextResponse.json({
    success: true,
    photo: {
      id: saved.id,
      imageUrl: saved.imageUrl,
      imagePublicId: saved.cloudinaryPublicId || '',
      label: saved.label,
      sortOrder: saved.sortOrder,
      createdAt: saved.createdAt,
    },
    source: 'postgres',
    firestore_fallback: false,
  });
}

export async function DELETE(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return auth.response;
  }

  if (!isDatabaseUrlConfigured()) {
    return apiError('Payment reference photos are unavailable right now.', 503);
  }

  const body = (await request.json().catch(() => ({}))) as {
    coadminUid?: string;
    photoId?: string;
  };

  const requestedCoadminUid = cleanText(body.coadminUid);
  const scoped = scopedCoadminUid(auth.user);
  const coadminUid = resolveCoadminUid(auth.user, requestedCoadminUid, scoped);
  const photoId = cleanText(body.photoId);
  if (!coadminUid || !photoId) {
    return apiError('photoId is required.', 400);
  }

  const deleted = await deletePaymentReferencePhoto({ coadminUid, photoId });
  let cloudinaryCleanup = { attempted: false, ok: false, reason: 'no_public_id' };
  if (deleted.cloudinaryPublicId) {
    cloudinaryCleanup = await tryDestroyCloudinaryAsset(deleted.cloudinaryPublicId);
    console.info('[PAYMENT_REFERENCE_PHOTO_CLOUDINARY_DELETE]', {
      coadminUid,
      photoId,
      publicId: deleted.cloudinaryPublicId,
      ...cloudinaryCleanup,
    });
  }

  logPaymentReferencePhotoSqlWrite({
    action: 'delete',
    coadminUid,
    photoId,
    hasImageUrl: false,
    hasCloudinaryPublicId: Boolean(deleted.cloudinaryPublicId),
    ok: deleted.ok,
    reason: deleted.ok ? 'sql_soft_delete_ok' : 'sql_soft_delete_miss',
  });
  logPaymentReferencePhotoAudit({
    routeOrPage: ROUTE,
    role: auth.user.role,
    coadminUid,
    source: 'payment_reference_photos_cache',
    cloudinaryUsed: Boolean(deleted.cloudinaryPublicId),
    tableOrCollection: 'payment_reference_photos_cache',
    photoCount: 0,
    samplePhotoIds: [photoId],
    sampleUrlsPresent: false,
    reason: deleted.ok ? 'sql_delete_ok' : 'sql_delete_miss',
  });

  if (!deleted.ok) {
    return apiError('Photo not found.', 404);
  }

  return NextResponse.json({
    success: true,
    photoId,
    cloudinaryCleanup,
    source: 'postgres',
    firestore_fallback: false,
  });
}
