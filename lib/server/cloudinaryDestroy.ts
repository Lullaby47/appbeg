import 'server-only';

import { createHash } from 'crypto';

import { cleanText } from '@/lib/sql/playerMirrorCommon';

export async function tryDestroyCloudinaryAsset(publicId: string) {
  const cleanPublicId = cleanText(publicId);
  const cloudName = cleanText(process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME);
  const apiKey = cleanText(process.env.CLOUDINARY_API_KEY);
  const apiSecret = cleanText(process.env.CLOUDINARY_API_SECRET);

  if (!cleanPublicId || !cloudName || !apiKey || !apiSecret) {
    return {
      attempted: false,
      ok: false,
      reason: 'cloudinary_destroy_not_configured',
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signatureBase = `public_id=${cleanPublicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = createHash('sha1').update(signatureBase).digest('hex');

  try {
    const body = new URLSearchParams({
      public_id: cleanPublicId,
      api_key: apiKey,
      timestamp: String(timestamp),
      signature,
    });
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }
    );
    const payload = (await response.json().catch(() => ({}))) as {
      result?: string;
      error?: { message?: string };
    };
    const ok = response.ok && payload.result === 'ok';
    return {
      attempted: true,
      ok,
      reason: ok ? 'cloudinary_destroy_ok' : payload.error?.message || 'cloudinary_destroy_failed',
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
