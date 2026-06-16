import type { NextConfig } from "next";

function cleanFlag(value: string | undefined) {
  return String(value || '').trim();
}

function isEnabled(value: string | undefined) {
  const raw = cleanFlag(value).toLowerCase();
  return raw === '1' || raw === 'true';
}

const sqlOnlyMode = isEnabled(process.env.APPBEG_SQL_ONLY_MODE);
const publicSqlReadMode =
  cleanFlag(process.env.NEXT_PUBLIC_SQL_READ_MODE) ||
  (sqlOnlyMode ? '1' : '');
const publicSqlLoginFirst =
  cleanFlag(process.env.NEXT_PUBLIC_SQL_LOGIN_FIRST) ||
  (sqlOnlyMode ? '1' : '');
const publicSqlPlayerLogin =
  cleanFlag(process.env.NEXT_PUBLIC_SQL_PLAYER_LOGIN) ||
  (sqlOnlyMode ? '1' : '');

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SQL_LOGIN_FIRST: publicSqlLoginFirst,
    NEXT_PUBLIC_SQL_PLAYER_LOGIN: publicSqlPlayerLogin,
    NEXT_PUBLIC_SQL_READ_MODE: publicSqlReadMode,
  },
};

export default nextConfig;
