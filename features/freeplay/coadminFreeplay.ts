import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

export type GiveFreeplayGiftInput = {
  targetPlayerUid?: string;
  reason?: string;
};

export async function giveFreeplayGift(input?: GiveFreeplayGiftInput) {
  const targetPlayerUid = String(input?.targetPlayerUid || '').trim();
  const body = targetPlayerUid
    ? {
        targetPlayerUid,
        reason: String(input?.reason || 'manual_specific_player').trim(),
      }
    : {};

  const response = await fetch('/api/coadmin/freeplay/give', {
    method: 'POST',
    headers: await getFirebaseApiHeaders(true),
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    playerUsername?: string;
    playerUid?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to give FreePlay gift.');
  }
  return {
    playerUsername: String(payload.playerUsername || 'Player'),
    playerUid: String(payload.playerUid || targetPlayerUid || '').trim(),
  };
}
