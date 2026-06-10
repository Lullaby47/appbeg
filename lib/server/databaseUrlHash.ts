import 'server-only';

import { createHash } from 'crypto';

import { getDatabaseUrl } from '@/lib/server/sqlRuntime';

export function hashDatabaseUrl(connectionString?: string | null) {
  const url = String(connectionString || getDatabaseUrl() || '').trim();
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url.replace(/^postgresql:/, 'postgres:'));
    const host = parsed.hostname || '';
    const port = parsed.port || '5432';
    const database = parsed.pathname.replace(/^\//, '') || '';
    const user = parsed.username || '';
    return createHash('sha256')
      .update(`${user}@${host}:${port}/${database}`)
      .digest('hex')
      .slice(0, 12);
  } catch {
    return createHash('sha256').update(url).digest('hex').slice(0, 12);
  }
}
