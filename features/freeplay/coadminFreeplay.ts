import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

export async function giveFreeplayGift() {
  const response = await fetch('/api/coadmin/freeplay/give', {
    method: 'POST',
    headers: await getFirebaseApiHeaders(false),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    playerUsername?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to give FreePlay gift.');
  }
  return String(payload.playerUsername || 'Player');
}
