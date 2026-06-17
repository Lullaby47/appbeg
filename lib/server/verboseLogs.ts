import 'server-only';

export function isSqlAuthVerboseLogs() {
  return process.env.SQL_AUTH_VERBOSE_LOGS === '1';
}

export function isSqlCacheVerboseLogs() {
  return process.env.SQL_CACHE_VERBOSE_LOGS === '1';
}

export function isLiveVerboseLogs() {
  return process.env.LIVE_VERBOSE_LOGS === '1';
}
