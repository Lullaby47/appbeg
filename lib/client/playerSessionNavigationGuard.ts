'use client';

const ROUTE_NAV_GRACE_MS = 2_000;

let routeNavigationUntilMs = 0;
let lastTrackedPath = '';

export function markPlayerClientRouteNavigation(pathname: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = String(pathname || window.location.pathname || '').trim();
  if (lastTrackedPath && lastTrackedPath !== nextPath) {
    routeNavigationUntilMs = Date.now() + ROUTE_NAV_GRACE_MS;
  }
  lastTrackedPath = nextPath;
}

export function isPlayerRouteNavigationActive() {
  return Date.now() < routeNavigationUntilMs;
}

export function isRealAppUnloadEvent(event: Event) {
  if (event.type === 'pagehide') {
    const pageEvent = event as PageTransitionEvent;
    // Page entered bfcache — user may return; not a browser close.
    if (pageEvent.persisted) {
      return false;
    }
    return true;
  }

  if (event.type === 'beforeunload') {
    return true;
  }

  return false;
}
