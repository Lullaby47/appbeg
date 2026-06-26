import { createHash } from 'crypto';
import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];

function safeFolderSegment(value: string) {
  return cleanText(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function signCloudinaryParams(params: Record<string, string>, apiSecret: string) {
  const signatureBase = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1').update(`${signatureBase}${apiSecret}`).digest('hex');
}

async function readActivePlayerChatProfile(playerUid: string) {
  const db = getPlayerMirrorPool();
  const uid = cleanText(playerUid);
  if (!db) {
    throw new Error('cloudinary_signature_postgres_unavailable');
  }
  if (!uid) {
    throw new Error('cloudinary_signature_missing_player');
  }

  const result = await db.query<{
    uid?: unknown;
    role?: unknown;
    coadmin_uid?: unknown;
    created_by?: unknown;
    profile_active?: unknown;
  }>(
    `
      SELECT
        player.uid,
        player.role,
        player.coadmin_uid,
        player.created_by,
        (
          profile.is_active = TRUE
          AND profile.review_status = 'approved'
          AND (profile.suspended_until IS NULL OR profile.suspended_until < now())
        ) AS profile_active
      FROM public.players_cache player
      LEFT JOIN public.player_chat_profiles profile
        ON profile.player_uid = player.uid
      WHERE player.uid = $1
        AND player.deleted_at IS NULL
      LIMIT 1
    `,
    [uid]
  );

  const row = result.rows[0];
  if (!row || cleanText(row.role).toLowerCase() !== 'player') {
    throw new Error('invalid_player');
  }
  if (row.profile_active !== true) {
    throw new Error('sender_chat_profile_inactive');
  }

  const coadminUid = cleanText(row.coadmin_uid) || cleanText(row.created_by);
  if (!coadminUid) {
    throw new Error('player_scope_not_found');
  }

  return {
    playerUid: uid,
    coadminUid,
  };
}

function statusForSignatureError(reason: string) {
  if (reason === 'sender_chat_profile_inactive') return 409;
  if (reason === 'invalid_player' || reason === 'player_scope_not_found') return 403;
  if (reason === 'cloudinary_signature_postgres_unavailable') return 503;
  if (/Cloudinary/.test(reason)) return 503;
  return 400;
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as {
    fileName?: unknown;
    fileSize?: unknown;
    mimeType?: unknown;
  };

  const mimeType = cleanText(body.mimeType).toLowerCase();
  const fileSize = Number(body.fileSize);
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return apiError('unsupported_chat_photo_type', 400);
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_PHOTO_BYTES) {
    return apiError('chat_photo_too_large', 400);
  }

  try {
    const cloudName = cleanText(process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME);
    const apiKey = cleanText(process.env.CLOUDINARY_API_KEY);
    const apiSecret = cleanText(process.env.CLOUDINARY_API_SECRET);
    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error('Cloudinary signed upload is not configured.');
    }

    const player = await readActivePlayerChatProfile(auth.user.uid);
    const folder = `player-chat/${safeFolderSegment(player.coadminUid)}/${safeFolderSegment(
      player.playerUid
    )}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedParams = {
      folder,
      timestamp,
    };
    const signature = signCloudinaryParams(signedParams, apiSecret);

    return NextResponse.json({
      ok: true,
      cloudName,
      apiKey,
      timestamp,
      signature,
      folder,
      resourceType: 'image',
      allowedFormats: ALLOWED_FORMATS,
      maxBytes: MAX_PHOTO_BYTES,
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Failed to create photo upload signature.';
    return apiError(reason, statusForSignatureError(reason));
  }
}
