import { auth } from '@/lib/firebase/client';

async function getAuthHeaders() {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const token = await currentUser.getIdToken();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function readApiError(messageFallback: string, payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof (payload as { error?: unknown }).error === 'string'
  ) {
    return String((payload as { error: string }).error || messageFallback);
  }
  return messageFallback;
}

/**
 * Add or remove whole-number coin for a player in the current user’s coadmin scope.
 * Callers may be a **coadmin** or **staff**; scope is resolved the same way as other
 * player tools (parent coadmin). Deductions cannot make coin negative.
 */
export async function adjustPlayerCoin({
  playerUid,
  delta,
}: {
  playerUid: string;
  delta: number;
}) {
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('Amount must be a non-zero number.');
  }

  if (!Number.isInteger(delta)) {
    throw new Error('Use whole numbers only (no decimals).');
  }

  const response = await fetch('/api/coadmin/player-balance/adjust', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      playerUid,
      delta,
      balanceType: 'coin',
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to adjust coin.', payload));
  }
}

/**
 * Add or remove whole-number cash for a player in the current user's coadmin scope.
 * Same rules as {@link adjustPlayerCoin}; deductions cannot make cash negative.
 */
export async function adjustPlayerCash({
  playerUid,
  delta,
}: {
  playerUid: string;
  delta: number;
}) {
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('Amount must be a non-zero number.');
  }

  if (!Number.isInteger(delta)) {
    throw new Error('Use whole numbers only (no decimals).');
  }

  const response = await fetch('/api/coadmin/player-balance/adjust', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      playerUid,
      delta,
      balanceType: 'cash',
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to adjust cash.', payload));
  }
}

/** @deprecated Use `adjustPlayerCoin` — same behavior, kept for older imports. */
export const adjustPlayerCoinByCoadmin = adjustPlayerCoin;
