'use client';

export function isPlayerDebugLogsEnabled() {
  return process.env.NEXT_PUBLIC_PLAYER_DEBUG_LOGS === '1';
}

export function playerDebugLog(message: string, details?: Record<string, unknown>) {
  if (!isPlayerDebugLogsEnabled()) {
    return;
  }
  if (details) {
    console.info(message, details);
    return;
  }
  console.info(message);
}
