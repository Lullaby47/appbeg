import { getPlayerApiHeaders } from '@/features/auth/playerSession';

export async function fetchPendingFreeplayGift() {
  const response = await fetch('/api/player/freeplay/pending', {
    method: 'GET',
    headers: await getPlayerApiHeaders(),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    hasPendingGift?: boolean;
    giftId?: string | null;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load FreePlay gift.');
  }
  return {
    hasPendingGift: Boolean(payload.hasPendingGift),
    giftId: String(payload.giftId || '').trim(),
  };
}

export async function claimFreeplayGift(giftId: string) {
  const response = await fetch('/api/player/freeplay/claim', {
    method: 'POST',
    headers: await getPlayerApiHeaders(),
    body: JSON.stringify({ giftId }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    amount?: number;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to claim FreePlay gift.');
  }
  return {
    amount: Number(payload.amount || 0),
    message: String(payload.message || ''),
  };
}
