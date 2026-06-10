'use client';

import { Timestamp } from 'firebase/firestore';

import type { PlayerCashoutTask } from '@/features/cashouts/playerCashoutTasks';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { createPlayerScopedPoll } from '@/lib/client/playerPollGuard';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

const POLL_MS = 10_000;

type CashoutScope = 'player' | 'coadmin' | 'assigned_handler';

function isoToTimestamp(iso: string | null | undefined): Timestamp | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Timestamp.fromMillis(ms) : null;
}

function mapCachedTask(row: Record<string, unknown>): PlayerCashoutTask {
  return {
    id: String(row.id || ''),
    coadminUid: String(row.coadminUid || ''),
    playerUid: String(row.playerUid || ''),
    playerUsername: String(row.playerUsername || ''),
    amountNpr: Number(row.amountNpr || 0),
    paymentDetails: String(row.paymentDetails || ''),
    payoutMethod: (row.payoutMethod as PlayerCashoutTask['payoutMethod']) || null,
    qrImageUrl: String(row.qrImageUrl || '').trim() || null,
    paymentAppName: String(row.paymentAppName || '').trim() || null,
    paymentAppCashTag: String(row.paymentAppCashTag || '').trim() || null,
    paymentAppAccountName: String(row.paymentAppAccountName || '').trim() || null,
    cashDeductedOnRequest:
      typeof row.cashDeductedOnRequest === 'boolean' ? row.cashDeductedOnRequest : undefined,
    declinedByUids: Array.isArray(row.declinedByUids)
      ? row.declinedByUids.map((entry) => String(entry))
      : [],
    status: (String(row.status || 'pending') as PlayerCashoutTask['status']) || 'pending',
    assignedHandlerUid: String(row.assignedHandlerUid || '').trim() || null,
    assignedHandlerUsername: String(row.assignedHandlerUsername || '').trim() || null,
    startedAt: isoToTimestamp(String(row.startedAt || '') || null),
    expiresAt: isoToTimestamp(String(row.expiresAt || '') || null),
    createdAt: isoToTimestamp(String(row.createdAt || '') || null),
    completedAt: isoToTimestamp(String(row.completedAt || '') || null),
  };
}

async function fetchCashoutTasks(scope: CashoutScope, uid: string, limit: number) {
  const response = await fetch(
    `/api/player-cashout-tasks/cache?scope=${encodeURIComponent(scope)}&uid=${encodeURIComponent(uid)}&limit=${limit}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    tasks?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load cashout tasks.');
  }
  return (payload.tasks || []).map(mapCachedTask);
}

export function attachPlayerCashoutTasksSqlPoll(input: {
  scope: CashoutScope;
  uid: string;
  limit?: number;
  onChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
}) {
  logClientFirestoreSkipped('player_cashout_tasks_listener', {
    scope: input.scope,
    uid: input.uid,
  });

  const runPoll = async () => {
    const tasks = await fetchCashoutTasks(input.scope, input.uid, input.limit || 50);
    input.onChange(tasks);
  };

  if (input.scope === 'player') {
    return createPlayerScopedPoll({
      pollName: 'player_cashout_tasks',
      intervalMs: POLL_MS,
      onTick: runPoll,
      onError: input.onError,
    });
  }

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      await runPoll();
    } catch (error) {
      if (!cancelled) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (!cancelled) {
        timer = setTimeout(() => {
          void tick();
        }, POLL_MS);
      }
    }
  };

  void tick();

  return () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function isPlayerCashoutSqlReadEnabled() {
  return isClientSqlReadMode();
}
