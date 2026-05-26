import { auth } from '@/lib/firebase/client';

export async function giveFreeplayGift() {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const response = await fetch('/api/coadmin/freeplay/give', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await currentUser.getIdToken()}`,
    },
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
