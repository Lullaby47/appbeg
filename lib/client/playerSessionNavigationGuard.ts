'use client';

const ROUTE_NAV_GRACE_MS = 5_000;
const SESSION_CONTINUATION_TTL_MS = 60_000;
const SESSION_CONTINUATION_STORAGE_KEY = 'appbeg_player_session_continuation';

let routeNavigationUntilMs = 0;
let lastTrackedPath = '';

function cleanSessionId(value: unknown) {
  return String(value || '').trim();
}

export function isPlayerShellPath(pathname: string) {
  const path = String(pathname || '').trim();
  return path === '/player' || path.startsWith('/player/');
}

export function markPlayerClientRouteNavigation(pathname: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = String(pathname || window.location.pathname || '').trim();
  if (lastTrackedPath && lastTrackedPath !== nextPath) {
    routeNavigationUntilMs = Date.now() + ROUTE_NAV_GRACE_MS;
  }
  if (
    lastTrackedPath &&
    isPlayerShellPath(lastTrackedPath) &&
    isPlayerShellPath(nextPath)
  ) {
    routeNavigationUntilMs = Date.now() + ROUTE_NAV_GRACE_MS;
  }
  lastTrackedPath = nextPath;
}

export function isPlayerRouteNavigationActive() {
  return Date.now() < routeNavigationUntilMs;
}

export function isRealAppUnloadEvent(_event: Event) {
  // Refresh, in-app navigation, and bfcache restores must not end the SQL player session.
  // Session expiry is handled server-side via touch heartbeats and explicit logout.
  return false;
}

export function markPlayerSessionClientContinuation(sessionId: string) {
  const cleanId = cleanSessionId(sessionId);
  if (!cleanId || typeof window === 'undefined') {
    return;
  }
  try {
    sessionStorage.setItem(
      SESSION_CONTINUATION_STORAGE_KEY,
      JSON.stringify({
        sessionId: cleanId,
        at: Date.now(),
      })
    );
  } catch {
    // Ignore storage failures.
  }
}

export function consumePlayerSessionClientContinuation(sessionId: string) {
  const cleanId = cleanSessionId(sessionId);
  if (!cleanId || typeof window === 'undefined') {
    return false;
  }
  try {
    const raw = sessionStorage.getItem(SESSION_CONTINUATION_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_CONTINUATION_STORAGE_KEY);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw) as { sessionId?: string; at?: number };
    if (cleanSessionId(parsed.sessionId) !== cleanId) {
      return false;
    }
    return Date.now() - Number(parsed.at || 0) < SESSION_CONTINUATION_TTL_MS;
  } catch {
    return false;
  }
}

export function isClientNavigationReload() {
  if (typeof window === 'undefined' || typeof performance === 'undefined') {
    return false;
  }
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return entry?.type === 'reload';
}
