import 'server-only';

import { sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';
import { isSqlAuthVerboseLogs } from '@/lib/server/verboseLogs';

export function logPlayerApiAuthOk(
  request: Request,
  input: {
    route: string;
    uid: string;
    role: string;
    authPath: string;
  }
) {
  if (!isSqlAuthVerboseLogs()) {
    return;
  }
  const sessions = sessionIdsFromRequest(request);
  console.info('[PLAYER_API_AUTH_OK]', {
    route: input.route,
    uid: input.uid,
    role: input.role,
    hasAppSessionId: Boolean(sessions.app_session_id),
    hasPlayerSessionId: Boolean(sessions.player_session_id),
    authPath: input.authPath,
  });
}
