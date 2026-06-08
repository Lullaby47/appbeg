import 'server-only';

export function isSqlPlayerLoginEnabled() {
  return (
    process.env.NEXT_PUBLIC_SQL_PLAYER_LOGIN === '1' ||
    process.env.SQL_PLAYER_LOGIN === '1'
  );
}
