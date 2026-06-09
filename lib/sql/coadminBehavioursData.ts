import 'server-only';

import {
  cleanText,
  getPlayerMirrorPool,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

function parseRawFirestoreData(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
}

export type BehavioursDataDoc = { id: string } & Record<string, unknown>;

function mapStaffRow(row: Record<string, unknown>): BehavioursDataDoc {
  const raw = parseRawFirestoreData(row.raw_firestore_data);
  return {
    id: cleanText(row.uid),
    username: cleanText(row.username) || rawString(raw, 'username'),
    role: cleanText(row.role) || 'staff',
    createdAt: toIsoString(row.created_at) || raw.createdAt || null,
    rewardBlocked: raw.rewardBlocked === true,
  };
}

function mapPlayerRow(row: Record<string, unknown>): BehavioursDataDoc {
  const raw = parseRawFirestoreData(row.raw_firestore_data);
  return {
    id: cleanText(row.uid),
    username: cleanText(row.username) || rawString(raw, 'username'),
    createdAt: toIsoString(row.created_at) || raw.createdAt || null,
    createdByStaffId:
      cleanText(row.created_by_staff_id) || rawString(raw, 'createdByStaffId') || '',
    bonusBlocked: raw.bonusBlocked === true,
    bonusBlockedUntil: raw.bonusBlockedUntil ?? null,
    redeemWindow24h: raw.redeemWindow24h ?? null,
  };
}

function mapCashoutRow(row: Record<string, unknown>): BehavioursDataDoc {
  const raw = parseRawFirestoreData(row.raw_firestore_data);
  return {
    id: cleanText(row.firebase_id),
    playerUid: cleanText(row.player_uid) || rawString(raw, 'playerUid'),
    amountNpr: row.amount_npr ?? raw.amountNpr ?? 0,
    status: cleanText(row.status) || rawString(raw, 'status'),
    assignedHandlerUid:
      cleanText(row.assigned_handler_uid) || rawString(raw, 'assignedHandlerUid'),
    createdAt: toIsoString(row.created_at) || raw.createdAt || null,
    completedAt: toIsoString(row.completed_at) || raw.completedAt || null,
  };
}

function mapRedeemRequestRow(row: Record<string, unknown>): BehavioursDataDoc {
  const raw = parseRawFirestoreData(row.raw_firestore_data);
  return {
    id: cleanText(row.firebase_id),
    playerUid: cleanText(row.player_uid) || rawString(raw, 'playerUid'),
    amount: row.amount ?? raw.amount ?? 0,
    status: cleanText(row.status) || rawString(raw, 'status'),
    pokeMessage: rawString(raw, 'pokeMessage'),
    reason: rawString(raw, 'reason'),
    createdAt: toIsoString(row.created_at) || raw.createdAt || null,
  };
}

function rawString(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  return value == null ? '' : String(value);
}

export async function loadCoadminBehavioursDataFromSql(coadminUid: string): Promise<{
  staffDocs: BehavioursDataDoc[];
  playerDocs: BehavioursDataDoc[];
  cashoutDocs: BehavioursDataDoc[];
  redeemRequestDocs: BehavioursDataDoc[];
} | null> {
  const cleanCoadminUid = cleanText(coadminUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanCoadminUid) {
    return null;
  }

  const scopeSql = `(coadmin_uid = $1 OR created_by = $1)`;

  try {
    const [staffResult, playerResult, cashoutResult, redeemResult] = await Promise.all([
      runMirrorPoolQuery<Record<string, unknown>>(
        db,
        `
          SELECT uid, username, role, created_at, raw_firestore_data
          FROM public.players_cache
          WHERE deleted_at IS NULL
            AND role = 'staff'
            AND ${scopeSql}
        `,
        [cleanCoadminUid]
      ),
      runMirrorPoolQuery<Record<string, unknown>>(
        db,
        `
          SELECT uid, username, created_at, created_by_staff_id, raw_firestore_data
          FROM public.players_cache
          WHERE deleted_at IS NULL
            AND role = 'player'
            AND ${scopeSql}
        `,
        [cleanCoadminUid]
      ),
      runMirrorPoolQuery<Record<string, unknown>>(
        db,
        `
          SELECT firebase_id, player_uid, amount_npr, status, assigned_handler_uid,
                 created_at, completed_at, raw_firestore_data
          FROM public.player_cashout_tasks_cache
          WHERE deleted_at IS NULL
            AND coadmin_uid = $1
        `,
        [cleanCoadminUid]
      ),
      runMirrorPoolQuery<Record<string, unknown>>(
        db,
        `
          SELECT firebase_id, player_uid, amount, status, created_at, raw_firestore_data
          FROM public.player_game_requests_cache
          WHERE deleted_at IS NULL
            AND coadmin_uid = $1
            AND type = 'redeem'
        `,
        [cleanCoadminUid]
      ),
    ]);

    return {
      staffDocs: staffResult.rows.map(mapStaffRow),
      playerDocs: playerResult.rows.map(mapPlayerRow),
      cashoutDocs: cashoutResult.rows.map(mapCashoutRow),
      redeemRequestDocs: redeemResult.rows.map(mapRedeemRequestRow),
    };
  } catch (error) {
    console.warn('[COADMIN_BEHAVIOURS_SQL] read failed', {
      coadminUid: cleanCoadminUid,
      error,
    });
    return null;
  }
}
