'use client';

import { getStaffAppSessionApiHeaders } from '@/lib/client/staffApiHeaders';

const STAFF_WALLET_ROUTE = '/api/staff/wallet';
const COADMIN_STAFF_WALLETS_ROUTE = '/api/coadmin/staff-wallets';
const STAFF_WALLET_ALLOCATE_ROUTE = '/api/coadmin/staff-wallets/allocate';
const STAFF_WALLET_LOAD_PLAYER_ROUTE = '/api/staff/wallet/load-player';

export type StaffWalletBalance = {
  staffUid: string;
  coadminUid: string;
  balanceCoin: number;
  totalAllocatedCoin: number;
  totalLoadedCoin: number;
};

export type CoadminStaffWalletRow = StaffWalletBalance & {
  username: string | null;
  status: string | null;
  walletUpdatedAt: string | null;
};

export type StaffWalletAllocationResult = {
  staffUid: string;
  balanceCoin: number;
  totalAllocatedCoin: number;
  allocatedAmount: number;
  duplicate: boolean;
};

export type StaffWalletPlayerLoadResult = {
  staffUid: string;
  playerUid: string;
  loadedAmount: number;
  staffWalletBalanceCoin: number;
  playerBalanceCoin: number;
  duplicate: boolean;
};

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

function normalizeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requirePositiveIntegerAmount(amount: number) {
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw new Error('Amount must be a positive whole number.');
  }
}

function requireNonEmpty(value: string, message: string) {
  if (!value.trim()) {
    throw new Error(message);
  }
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(readApiError(fallback, payload));
  }
  return payload;
}

export async function getMyStaffWallet(): Promise<StaffWalletBalance> {
  const headers = await getStaffAppSessionApiHeaders(false);
  const response = await fetch(STAFF_WALLET_ROUTE, {
    method: 'GET',
    headers,
    credentials: 'include',
  });
  const payload = await readJsonResponse<Partial<StaffWalletBalance> & { ok?: boolean }>(
    response,
    'Failed to load staff wallet.'
  );

  return {
    staffUid: String(payload.staffUid || ''),
    coadminUid: String(payload.coadminUid || ''),
    balanceCoin: normalizeNumber(payload.balanceCoin),
    totalAllocatedCoin: normalizeNumber(payload.totalAllocatedCoin),
    totalLoadedCoin: normalizeNumber(payload.totalLoadedCoin),
  };
}

export async function listCoadminStaffWallets(options?: {
  coadminUid?: string | null;
}): Promise<CoadminStaffWalletRow[]> {
  const headers = await getStaffAppSessionApiHeaders(false);
  const params = new URLSearchParams();
  const coadminUid = String(options?.coadminUid || '').trim();
  if (coadminUid) {
    params.set('coadminUid', coadminUid);
  }
  const url = params.size
    ? `${COADMIN_STAFF_WALLETS_ROUTE}?${params.toString()}`
    : COADMIN_STAFF_WALLETS_ROUTE;
  const response = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'include',
  });
  const payload = await readJsonResponse<{
    ok?: boolean;
    staff?: Array<Partial<CoadminStaffWalletRow>>;
  }>(response, 'Failed to load staff wallets.');

  return Array.isArray(payload.staff)
    ? payload.staff.map((row) => ({
        staffUid: String(row.staffUid || ''),
        username: row.username == null ? null : String(row.username),
        status: row.status == null ? null : String(row.status),
        coadminUid: String(row.coadminUid || ''),
        balanceCoin: normalizeNumber(row.balanceCoin),
        totalAllocatedCoin: normalizeNumber(row.totalAllocatedCoin),
        totalLoadedCoin: normalizeNumber(row.totalLoadedCoin),
        walletUpdatedAt: row.walletUpdatedAt == null ? null : String(row.walletUpdatedAt),
      }))
    : [];
}

export async function allocateStaffWalletCoins(input: {
  staffUid: string;
  amount: number;
  idempotencyKey: string;
  note?: string | null;
}): Promise<StaffWalletAllocationResult> {
  const staffUid = String(input.staffUid || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  requireNonEmpty(staffUid, 'staffUid is required.');
  requireNonEmpty(idempotencyKey, 'idempotencyKey is required.');
  requirePositiveIntegerAmount(input.amount);

  const headers = await getStaffAppSessionApiHeaders(true);
  const response = await fetch(STAFF_WALLET_ALLOCATE_ROUTE, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': idempotencyKey,
    },
    credentials: 'include',
    body: JSON.stringify({
      staffUid,
      amount: input.amount,
      idempotencyKey,
      note: String(input.note || '').trim() || null,
    }),
  });
  const payload = await readJsonResponse<Partial<StaffWalletAllocationResult> & { ok?: boolean }>(
    response,
    'Failed to allocate staff wallet coins.'
  );

  return {
    staffUid: String(payload.staffUid || staffUid),
    balanceCoin: normalizeNumber(payload.balanceCoin),
    totalAllocatedCoin: normalizeNumber(payload.totalAllocatedCoin),
    allocatedAmount: normalizeNumber(payload.allocatedAmount),
    duplicate: Boolean(payload.duplicate),
  };
}

export async function loadPlayerCoinsFromStaffWallet(input: {
  playerUid: string;
  amount: number;
  idempotencyKey: string;
}): Promise<StaffWalletPlayerLoadResult> {
  const playerUid = String(input.playerUid || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  requireNonEmpty(playerUid, 'playerUid is required.');
  requireNonEmpty(idempotencyKey, 'idempotencyKey is required.');
  requirePositiveIntegerAmount(input.amount);

  const headers = await getStaffAppSessionApiHeaders(true);
  const response = await fetch(STAFF_WALLET_LOAD_PLAYER_ROUTE, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': idempotencyKey,
    },
    credentials: 'include',
    body: JSON.stringify({
      playerUid,
      amount: input.amount,
      idempotencyKey,
    }),
  });
  const payload = await readJsonResponse<Partial<StaffWalletPlayerLoadResult> & { ok?: boolean }>(
    response,
    'Failed to load player coins from staff wallet.'
  );

  return {
    staffUid: String(payload.staffUid || ''),
    playerUid: String(payload.playerUid || playerUid),
    loadedAmount: normalizeNumber(payload.loadedAmount),
    staffWalletBalanceCoin: normalizeNumber(payload.staffWalletBalanceCoin),
    playerBalanceCoin: normalizeNumber(payload.playerBalanceCoin),
    duplicate: Boolean(payload.duplicate),
  };
}
