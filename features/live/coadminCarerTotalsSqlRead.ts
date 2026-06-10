'use client';

import type { CarerRechargeRedeemTotals } from '@/features/games/carerTasks';
import { logCarerApiForbiddenAudit } from '@/lib/client/carerActionAudit';
import { logCarerPageRequestAudit } from '@/lib/client/carerPageRequestAudit';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

const POLL_MS = 10_000;
const CARER_TOTALS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type CachedCarerTotalsTask = {
  type: 'recharge' | 'redeem';
  completedByCarerUid: string | null;
  assignedCarerUid: string | null;
  amount: number;
};

function aggregateTotals(tasks: CachedCarerTotalsTask[]): Record<string, CarerRechargeRedeemTotals> {
  const totals: Record<string, CarerRechargeRedeemTotals> = {};

  for (const task of tasks) {
    const carerUid = String(task.completedByCarerUid || task.assignedCarerUid || '').trim();
    if (!carerUid) {
      continue;
    }
    if (!totals[carerUid]) {
      totals[carerUid] = {
        totalRechargeAmount: 0,
        totalRedeemAmount: 0,
      };
    }
    const amount = Number(task.amount || 0);
    if (task.type === 'recharge') {
      totals[carerUid].totalRechargeAmount += amount;
    } else {
      totals[carerUid].totalRedeemAmount += amount;
    }
  }

  return totals;
}

async function fetchCarerTotals(coadminUid: string) {
  const windowStartMs = Date.now() - CARER_TOTALS_WINDOW_MS;
  const response = await fetch(
    `/api/carer-tasks/cache?scope=carer_totals&coadminUid=${encodeURIComponent(coadminUid)}&windowStartMs=${windowStartMs}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    tasks?: CachedCarerTotalsTask[];
    error?: string;
  };
  logCarerPageRequestAudit({
    route: `/api/carer-tasks/cache?scope=carer_totals&coadminUid=${encodeURIComponent(coadminUid)}`,
    method: 'GET',
    status: response.status,
    coadminUid,
    role: 'carer',
    authPath: 'sql_api_poll',
    reason: response.ok
      ? 'carer_totals_ok'
      : String(payload.error || `http_${response.status}`),
  });
  if (!response.ok) {
    if (response.status === 403) {
      logCarerApiForbiddenAudit({
        action: 'carer_recharge_redeem_totals',
        route: `/api/carer-tasks/cache?scope=carer_totals&coadminUid=${encodeURIComponent(coadminUid)}`,
        method: 'GET',
        status: 403,
        responseBody: payload,
        role: 'carer',
        coadminUid,
        requestedCoadminUid: coadminUid,
        allowedRoles: ['admin', 'coadmin', 'staff', 'carer'],
        authPath: 'sql_api_poll',
        reason: String(payload.error || 'forbidden'),
        userVisible: true,
      });
    }
    throw new Error(payload.error || 'Failed to load carer totals.');
  }
  return aggregateTotals(payload.tasks || []);
}

export function attachCarerRechargeRedeemTotalsSqlPoll(input: {
  coadminUid: string;
  onChange: (totalsByCarerUid: Record<string, CarerRechargeRedeemTotals>) => void;
  onError?: (error: Error) => void;
}) {
  logClientFirestoreSkipped('carer_recharge_redeem_totals_listener', {
    coadminUid: input.coadminUid,
  });

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      const totals = await fetchCarerTotals(input.coadminUid);
      if (!cancelled) {
        input.onChange(totals);
      }
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
