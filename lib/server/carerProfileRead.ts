import 'server-only';

import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

function fieldFromRawFirestore(raw: unknown, field: string): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '';
  }
  return cleanText((raw as Record<string, unknown>)[field]);
}

export type CarerDashboardProfile = {
  uid: string;
  username: string;
  role: string;
  coadminUid: string | null;
  automationAgentId: string | null;
  paymentQrUrl: string;
  paymentQrPublicId: string;
  paymentDetails: string;
  cashBoxNpr: number;
  source: 'postgres' | 'fallback';
};

function numberFromRawFirestore(raw: unknown, field: string): number {
  if (!raw || typeof raw !== 'object') {
    return 0;
  }
  const value = (raw as Record<string, unknown>)[field];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadCarerDashboardProfileFromSql(
  carerUid: string
): Promise<{ profile: CarerDashboardProfile | null; missReason: string | null }> {
  const cleanUid = cleanText(carerUid);
  if (!cleanUid) {
    return { profile: null, missReason: 'missing_uid' };
  }

  const lookup = await lookupApiUserProfileFromSqlCache(cleanUid);
  if (!lookup.profile || lookup.missReason) {
    return { profile: null, missReason: lookup.missReason || 'profile_missing' };
  }

  const profile = lookup.profile;
  if (profile.role !== 'carer') {
    return { profile: null, missReason: 'role_mismatch' };
  }

  const db = await import('@/lib/sql/playerMirrorCommon').then((mod) => mod.getPlayerMirrorPool());
  let raw: unknown = null;
  if (db) {
    try {
      const result = await db.query<{ raw_firestore_data: unknown }>(
        `
          SELECT raw_firestore_data
          FROM public.players_cache
          WHERE uid = $1
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [cleanUid]
      );
      raw = result.rows[0]?.raw_firestore_data ?? null;
    } catch {
      raw = null;
    }
  }

  return {
    profile: {
      uid: profile.uid,
      username: profile.username || 'Carer',
      role: profile.role,
      coadminUid: profile.coadminUid,
      automationAgentId: profile.automationAgentId,
      paymentQrUrl: cleanText(fieldFromRawFirestore(raw, 'paymentQrUrl')),
      paymentQrPublicId: cleanText(fieldFromRawFirestore(raw, 'paymentQrPublicId')),
      paymentDetails: cleanText(fieldFromRawFirestore(raw, 'paymentDetails')),
      cashBoxNpr: numberFromRawFirestore(raw, 'cashBoxNpr'),
      source: 'postgres',
    },
    missReason: null,
  };
}
