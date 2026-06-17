import 'server-only';

import { isAppbegSqlOnlyMode } from '@/lib/server/appbegSqlOnlyMode';
import { isProductionNodeEnv } from '@/lib/server/sqlRuntime';

function envEnabled(name: string) {
  return String(process.env[name] || '').trim() === '1';
}

export function isBrowserLiveOutboxFanoutEnabled() {
  return envEnabled('LIVE_OUTBOX_FANOUT_ENABLED') && envEnabled('LIVE_OUTBOX_FANOUT_BROWSER_ENABLED');
}

export function isAgentLiveOutboxFanoutEnabled() {
  return envEnabled('LIVE_OUTBOX_FANOUT_ENABLED') && envEnabled('LIVE_OUTBOX_FANOUT_AGENT_ENABLED');
}

const warnedRoutes = new Set<string>();

export function warnIfFanoutRequiredButDisabled(route: 'browser_live_stream' | 'agent_stream') {
  if (warnedRoutes.has(route)) {
    return;
  }

  const productionLike = isProductionNodeEnv() || isAppbegSqlOnlyMode();
  if (!productionLike) {
    return;
  }

  const fanoutEnabled =
    route === 'agent_stream' ? isAgentLiveOutboxFanoutEnabled() : isBrowserLiveOutboxFanoutEnabled();

  if (fanoutEnabled) {
    return;
  }

  warnedRoutes.add(route);
  console.warn('[FANOUT_REQUIRED_WARNING]', {
    route,
    productionLike,
    appbegSqlOnlyMode: isAppbegSqlOnlyMode(),
    liveOutboxFanoutEnabled: envEnabled('LIVE_OUTBOX_FANOUT_ENABLED'),
    liveOutboxFanoutBrowserEnabled: envEnabled('LIVE_OUTBOX_FANOUT_BROWSER_ENABLED'),
    liveOutboxFanoutAgentEnabled: envEnabled('LIVE_OUTBOX_FANOUT_AGENT_ENABLED'),
    message:
      'Production-like SQL mode should keep live outbox fanout enabled to avoid per-connection polling.',
  });
}
