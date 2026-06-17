import 'server-only';

import {
  API_ROUTE_SLOW_MS,
  POOL_ACQUIRE_SLOW_MS,
  isLoadTestMode,
} from '@/lib/server/verboseLogs';

type RouteMetric = {
  count: number;
  totalMs: number;
  durations: number[];
  errors: number;
  slowCount: number;
  maxMs: number;
  lastFlushAt: number;
};

type AuthCacheMetric = {
  hits: number;
  misses: number;
  route: string;
  lastFlushAt: number;
};

type SqlPoolMetric = {
  max: number | null;
  totalCount: number | null;
  idleCount: number | null;
  waitingCount: number | null;
  slowAcquireCount: number;
  maxAcquireMs: number;
  lastFlushAt: number;
};

const routeMetrics = new Map<string, RouteMetric>();
const authCacheMetrics = new Map<string, AuthCacheMetric>();
const sqlPoolMetrics = new Map<string, SqlPoolMetric>();

function summaryIntervalMs() {
  return isLoadTestMode() ? 30_000 : 60_000;
}

function percentile(values: number[], p: number) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] || 0;
}

export function recordRouteMetric(input: {
  route: string;
  durationMs: number;
  ok?: boolean;
  slowThresholdMs?: number;
}) {
  const route = input.route || 'unknown';
  const now = Date.now();
  const metric =
    routeMetrics.get(route) ||
    ({
      count: 0,
      totalMs: 0,
      durations: [],
      errors: 0,
      slowCount: 0,
      maxMs: 0,
      lastFlushAt: now,
    } satisfies RouteMetric);
  const durationMs = Math.max(0, Math.trunc(input.durationMs || 0));
  const slowThresholdMs = input.slowThresholdMs ?? API_ROUTE_SLOW_MS;
  metric.count += 1;
  metric.totalMs += durationMs;
  metric.durations.push(durationMs);
  metric.maxMs = Math.max(metric.maxMs, durationMs);
  if (input.ok === false) {
    metric.errors += 1;
  }
  if (durationMs >= slowThresholdMs) {
    metric.slowCount += 1;
  }
  routeMetrics.set(route, metric);
  if (now - metric.lastFlushAt < summaryIntervalMs()) {
    return;
  }
  const count = metric.count;
  console.info('[ROUTE_METRICS_SUMMARY]', {
    route,
    count,
    avgMs: count ? Math.round(metric.totalMs / count) : 0,
    p95Ms: percentile(metric.durations, 95),
    maxMs: metric.maxMs,
    errors: metric.errors,
    slowCount: metric.slowCount,
  });
  routeMetrics.set(route, {
    count: 0,
    totalMs: 0,
    durations: [],
    errors: 0,
    slowCount: 0,
    maxMs: 0,
    lastFlushAt: now,
  });
}

export function recordAuthCacheMetric(input: {
  route: string;
  hit: boolean;
}) {
  const route = input.route || 'unknown';
  const now = Date.now();
  const metric =
    authCacheMetrics.get(route) ||
    ({
      hits: 0,
      misses: 0,
      route,
      lastFlushAt: now,
    } satisfies AuthCacheMetric);
  if (input.hit) {
    metric.hits += 1;
  } else {
    metric.misses += 1;
  }
  authCacheMetrics.set(route, metric);
  if (now - metric.lastFlushAt < summaryIntervalMs()) {
    return;
  }
  const total = metric.hits + metric.misses;
  console.info('[AUTH_CACHE_SUMMARY]', {
    hits: metric.hits,
    misses: metric.misses,
    hitRate: total ? Number((metric.hits / total).toFixed(3)) : 0,
    route,
  });
  authCacheMetrics.set(route, { hits: 0, misses: 0, route, lastFlushAt: now });
}

export function recordSqlPoolMetric(input: {
  name?: string;
  max?: number | null;
  totalCount?: number | null;
  idleCount?: number | null;
  waitingCount?: number | null;
  acquireMs?: number;
}) {
  const name = input.name || 'default';
  const now = Date.now();
  const metric =
    sqlPoolMetrics.get(name) ||
    ({
      max: null,
      totalCount: null,
      idleCount: null,
      waitingCount: null,
      slowAcquireCount: 0,
      maxAcquireMs: 0,
      lastFlushAt: now,
    } satisfies SqlPoolMetric);
  metric.max = input.max ?? metric.max;
  metric.totalCount = input.totalCount ?? metric.totalCount;
  metric.idleCount = input.idleCount ?? metric.idleCount;
  metric.waitingCount = input.waitingCount ?? metric.waitingCount;
  const acquireMs = Math.max(0, Math.trunc(input.acquireMs || 0));
  metric.maxAcquireMs = Math.max(metric.maxAcquireMs, acquireMs);
  if (acquireMs >= POOL_ACQUIRE_SLOW_MS || (input.waitingCount ?? 0) > 0) {
    metric.slowAcquireCount += 1;
  }
  sqlPoolMetrics.set(name, metric);
  if (now - metric.lastFlushAt < summaryIntervalMs()) {
    return;
  }
  console.info('[SQL_POOL_SUMMARY]', {
    name,
    max: metric.max,
    totalCount: metric.totalCount,
    idleCount: metric.idleCount,
    waitingCount: metric.waitingCount,
    slowAcquireCount: metric.slowAcquireCount,
    maxAcquireMs: metric.maxAcquireMs,
  });
  sqlPoolMetrics.set(name, {
    max: metric.max,
    totalCount: metric.totalCount,
    idleCount: metric.idleCount,
    waitingCount: metric.waitingCount,
    slowAcquireCount: 0,
    maxAcquireMs: 0,
    lastFlushAt: now,
  });
}

