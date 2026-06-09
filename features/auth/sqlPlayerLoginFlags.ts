import { isPublicSqlPlayerLoginEnabled } from '@/lib/client/sqlPublicFlags';

export function isSqlPlayerLoginEnabled() {
  return isPublicSqlPlayerLoginEnabled();
}
