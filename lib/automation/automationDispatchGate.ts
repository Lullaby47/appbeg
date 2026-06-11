import 'server-only';

import { lookupAutomationAutoStateFromSqlCache } from '@/lib/sql/automationAutoStateCache';

export type AutomationDispatchGateContext = {
  route: string;
  carerUid: string;
  coadminUid?: string | null;
  taskId?: string | null;
  gameName?: string | null;
  source?: string | null;
};

export type AutomationDispatchGateResult = {
  allowed: boolean;
  enabled: boolean;
  reason: 'automation_disabled' | 'state_missing' | 'postgres_unavailable' | null;
};

export async function checkCarerAutomationDispatchEnabled(
  carerUid: string,
  context: AutomationDispatchGateContext
): Promise<AutomationDispatchGateResult> {
  const lookup = await lookupAutomationAutoStateFromSqlCache(carerUid);
  const enabled = lookup.state?.enabled === true;
  if (enabled) {
    return { allowed: true, enabled: true, reason: null };
  }

  const reason =
    lookup.missReason === 'row_missing'
      ? 'state_missing'
      : lookup.missReason === 'postgres_unavailable'
        ? 'postgres_unavailable'
        : 'automation_disabled';

  console.info('[AUTO_DISPATCH_SKIPPED_AUTOMATION_OFF]', {
    route: context.route,
    carerUid: context.carerUid,
    coadminUid: context.coadminUid ?? null,
    taskId: context.taskId ?? null,
    gameName: context.gameName ?? null,
    source: context.source ?? null,
    enabled: false,
    missReason: lookup.missReason,
    reason,
  });

  return { allowed: false, enabled: false, reason };
}

export async function assertCarerAutomationDispatchEnabled(
  carerUid: string,
  context: AutomationDispatchGateContext
): Promise<void> {
  const gate = await checkCarerAutomationDispatchEnabled(carerUid, context);
  if (!gate.allowed) {
    throw new Error('Start Automation is off.');
  }
}
