import 'server-only';

import {
  normalizeMaintenanceBreak,
  type MaintenanceBreak,
} from '@/lib/maintenance/config';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export async function readCoadminMaintenanceBreakFromSql(
  coadminUid: string
): Promise<MaintenanceBreak> {
  const uid = cleanText(coadminUid);
  const db = getPlayerMirrorPool();
  if (!uid || !db) {
    return normalizeMaintenanceBreak(null);
  }

  try {
    const result = await db.query(
      `
        SELECT maintenance_break, enabled, title, message, raw_firestore_data
        FROM public.coadmin_maintenance_cache
        WHERE coadmin_uid = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [uid]
    );
    if (!result.rows.length) {
      return normalizeMaintenanceBreak(null);
    }
    const row = result.rows[0] as Record<string, unknown>;
    const rawBreak = row.maintenance_break;
    if (rawBreak && typeof rawBreak === 'object' && !Array.isArray(rawBreak)) {
      return normalizeMaintenanceBreak(rawBreak);
    }
    const rawDoc = row.raw_firestore_data;
    if (rawDoc && typeof rawDoc === 'object' && !Array.isArray(rawDoc)) {
      const maintenanceBreak = (rawDoc as Record<string, unknown>).maintenanceBreak;
      return normalizeMaintenanceBreak(maintenanceBreak);
    }
    return normalizeMaintenanceBreak({
      enabled: row.enabled === true,
      title: row.title,
      message: row.message,
    });
  } catch (error) {
    console.warn('[COADMIN_MAINTENANCE_CACHE] read failed', { coadminUid: uid, error });
    return normalizeMaintenanceBreak(null);
  }
}
