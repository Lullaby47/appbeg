import 'server-only';

import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { isSqlAuthVerboseLogs } from '@/lib/server/verboseLogs';

export type SessionIdsFromRequest = {
  app_session_id: string | null;
  player_session_id: string | null;
};

export function sessionIdsFromRequest(request: Request): SessionIdsFromRequest {
  return {
    app_session_id: cleanText(request.headers.get('X-App-Session-Id')) || null,
    player_session_id: cleanText(request.headers.get('X-Player-Session-Id')) || null,
  };
}

export function logRouteSessionValidation(
  route: string,
  details: Record<string, unknown> & {
    canonical_session_id?: string | null;
    validates?: string;
  }
) {
  if (details.ok === true && !isSqlAuthVerboseLogs()) {
    return;
  }
  console.info('[SESSION_AUTH]', {
    route,
    ...details,
  });
}
