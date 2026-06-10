import 'server-only';

import { resolveServerSqlFlag } from '@/lib/server/sqlRuntime';

export function isSqlPlayerLoginEnabled() {
  return (
    resolveServerSqlFlag('NEXT_PUBLIC_SQL_PLAYER_LOGIN') ||
    resolveServerSqlFlag('SQL_PLAYER_LOGIN')
  );
}
