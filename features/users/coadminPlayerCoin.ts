import { getApiAuthHeaders } from '@/lib/firebase/apiClient';

const BALANCE_ADJUST_ROUTE = '/api/coadmin/player-balance/adjust';

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

async function postPlayerBalanceAdjust({
  playerUid,
  delta,
  balanceType,
}: {
  playerUid: string;
  delta: number;
  balanceType: 'coin' | 'cash';
}) {
  let headers: Record<string, string>;
  try {
    headers = await getApiAuthHeaders(true, { action: 'update' });
  } catch (error) {
    console.info('[COADMIN_VIEW_PLAYERS_BALANCE_ADJUST_FAIL]', {
      route: BALANCE_ADJUST_ROUTE,
      status: 0,
      playerUid,
      balanceType,
      message: error instanceof Error ? error.message : String(error),
      phase: 'auth_headers',
    });
    throw error;
  }

  const response = await fetch(BALANCE_ADJUST_ROUTE, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({
      playerUid,
      delta,
      balanceType,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    console.info('[COADMIN_VIEW_PLAYERS_BALANCE_ADJUST_FAIL]', {
      route: BALANCE_ADJUST_ROUTE,
      status: response.status,
      playerUid,
      balanceType,
      message: payload.error || `api_status_${response.status}`,
    });
    throw new Error(
      readApiError(
        balanceType === 'coin' ? 'Failed to adjust coin.' : 'Failed to adjust cash.',
        payload
      )
    );
  }
}

/**
 * Add or remove whole-number coin for a player in the current user’s coadmin scope.
 * Callers must be a **coadmin** or **admin**. Staff coin loads must go through the
 * staff wallet flow so the staff wallet is debited before a player is credited.
 * Deductions cannot make coin negative.
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

  await postPlayerBalanceAdjust({ playerUid, delta, balanceType: 'coin' });
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

  await postPlayerBalanceAdjust({ playerUid, delta, balanceType: 'cash' });
}

/** @deprecated Use `adjustPlayerCoin` — same behavior, kept for older imports. */
export const adjustPlayerCoinByCoadmin = adjustPlayerCoin;
