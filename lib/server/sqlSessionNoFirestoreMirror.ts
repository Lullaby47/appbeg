import 'server-only';

export function logSqlLoginNoFirestoreMirror(input: {
  route: string;
  uid: string;
  role: string;
  playerSessionIdPrefix?: string | null;
  appSessionIdPrefix?: string | null;
}) {
  console.info('[SQL_LOGIN_NO_FIRESTORE_MIRROR]', {
    route: input.route,
    uid: input.uid,
    role: input.role,
    playerSessionIdPrefix: input.playerSessionIdPrefix ?? null,
    appSessionIdPrefix: input.appSessionIdPrefix ?? null,
    firestoreMirrorSkipped: true,
    reason: 'sql_session_authority',
  });
}
