import 'server-only';

import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export async function insertImpersonationLogInSql(input: {
  coadminUid: string;
  coadminUsername: string;
  staffUid: string;
  staffUsername: string;
  source?: string;
}) {
  const coadminUid = cleanText(input.coadminUid);
  const staffUid = cleanText(input.staffUid);
  if (!coadminUid || !staffUid) {
    return false;
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    return false;
  }

  const nowIso = new Date().toISOString();
  const raw = {
    coadminUid,
    coadminUsername: input.coadminUsername || 'Coadmin',
    staffUid,
    staffUsername: input.staffUsername || 'Staff',
    createdAt: nowIso,
    source: input.source || 'coadmin_behaviours',
  };

  try {
    await db.query(
      `
        INSERT INTO public.impersonation_logs_cache (
          coadmin_uid, coadmin_username, staff_uid, staff_username,
          source, created_at, raw_data
        )
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
      `,
      [
        coadminUid,
        input.coadminUsername || 'Coadmin',
        staffUid,
        input.staffUsername || 'Staff',
        input.source || 'authority_impersonation',
        nowIso,
        JSON.stringify(raw),
      ]
    );
    return true;
  } catch (error) {
    console.warn('[IMPERSONATION_LOG_SQL] insert failed', {
      coadminUid,
      staffUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
