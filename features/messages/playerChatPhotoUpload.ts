'use client';

import { getPlayerApiHeaders } from '@/features/auth/playerSession';

const MAX_PLAYER_CHAT_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PLAYER_CHAT_PHOTO_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export type SignedPlayerChatImageUpload = {
  secureUrl: string;
  publicId: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  format: string | null;
};

type PhotoUploadSignatureResponse = {
  cloudName?: string;
  apiKey?: string;
  timestamp?: string | number;
  signature?: string;
  folder?: string;
  resourceType?: string;
  error?: string;
};

type CloudinaryUploadResponse = {
  secure_url?: string;
  public_id?: string;
  width?: number;
  height?: number;
  bytes?: number;
  format?: string;
  error?: { message?: string };
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function mapPlayerChatPhotoUploadError(code: string) {
  if (code === 'sender_chat_profile_inactive') {
    return 'Activate your chat profile before sending photos.';
  }
  if (
    code === 'invalid_photo_type' ||
    code === 'unsupported_chat_photo_type' ||
    code === 'invalid_chat_photo_type'
  ) {
    return 'Only JPG, PNG, or WEBP images are allowed.';
  }
  if (code === 'photo_too_large' || code === 'chat_photo_too_large') {
    return 'Photo must be 5MB or smaller.';
  }
  if (
    code === 'missing_cloudinary_config' ||
    code === 'cloudinary_destroy_not_configured' ||
    /cloudinary.*not configured/i.test(code)
  ) {
    return 'Photo upload is not configured yet.';
  }
  return 'Could not upload photo. Please try again.';
}

function validatePlayerChatPhoto(file: File) {
  if (!file) {
    throw new Error('Could not upload photo. Please try again.');
  }
  if (!ALLOWED_PLAYER_CHAT_PHOTO_TYPES.has(file.type)) {
    throw new Error('Only JPG, PNG, or WEBP images are allowed.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_PLAYER_CHAT_PHOTO_BYTES) {
    throw new Error('Photo must be 5MB or smaller.');
  }
}

async function requestPlayerChatPhotoSignature(file: File) {
  const headers = await getPlayerApiHeaders(true, {
    route: '/api/player/chat/photo-upload-signature',
  });
  const response = await fetch('/api/player/chat/photo-upload-signature', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fileName: file.name || '',
      fileSize: file.size,
      mimeType: file.type,
    }),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as PhotoUploadSignatureResponse;
  if (!response.ok) {
    throw new Error(mapPlayerChatPhotoUploadError(cleanText(payload.error)));
  }

  const cloudName = cleanText(payload.cloudName);
  const apiKey = cleanText(payload.apiKey);
  const timestamp = cleanText(payload.timestamp);
  const signature = cleanText(payload.signature);
  const folder = cleanText(payload.folder);
  const resourceType = cleanText(payload.resourceType) || 'image';
  if (!cloudName || !apiKey || !timestamp || !signature || !folder || resourceType !== 'image') {
    throw new Error('Photo upload is not configured yet.');
  }

  return {
    cloudName,
    apiKey,
    timestamp,
    signature,
    folder,
  };
}

export async function uploadSignedPlayerChatImage(
  file: File
): Promise<SignedPlayerChatImageUpload> {
  validatePlayerChatPhoto(file);
  const signature = await requestPlayerChatPhotoSignature(file);

  const formData = new FormData();
  formData.append('file', file);
  formData.append('api_key', signature.apiKey);
  formData.append('timestamp', signature.timestamp);
  formData.append('signature', signature.signature);
  formData.append('folder', signature.folder);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(signature.cloudName)}/image/upload`,
    {
      method: 'POST',
      body: formData,
    }
  );
  const payload = (await response.json().catch(() => ({}))) as CloudinaryUploadResponse;
  if (!response.ok || !payload.secure_url || !payload.public_id) {
    throw new Error(mapPlayerChatPhotoUploadError(cleanText(payload.error?.message)));
  }

  return {
    secureUrl: payload.secure_url,
    publicId: payload.public_id,
    width: Number.isFinite(payload.width) ? Number(payload.width) : null,
    height: Number.isFinite(payload.height) ? Number(payload.height) : null,
    bytes: Number.isFinite(payload.bytes) ? Number(payload.bytes) : null,
    format: cleanText(payload.format) || null,
  };
}
