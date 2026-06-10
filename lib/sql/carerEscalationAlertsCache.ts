import 'server-only';

import { randomUUID } from 'crypto';

import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export type CachedCarerEscalationAlert = {
  id: string;
  coadminUid: string;
  contextType: string | null;
  escalationFrom: string | null;
  taskId: string | null;
  playerUid: string | null;
  playerUsername: string | null;
  gameName: string | null;
  message: string | null;
  createdByCarerUid: string | null;
  createdByCarerUsername: string | null;
  createdAt: string | null;
};

function mapRow(row: Record<string, unknown>): CachedCarerEscalationAlert | null {
  const id = cleanText(row.alert_id);
  const coadminUid = cleanText(row.coadmin_uid);
  if (!id || !coadminUid) {
    return null;
  }
  return {
    id,
    coadminUid,
    contextType: cleanText(row.context_type) || null,
    escalationFrom: cleanText(row.escalation_from) || null,
    taskId: cleanText(row.task_id) || null,
    playerUid: cleanText(row.player_uid) || null,
    playerUsername: cleanText(row.player_username) || null,
    gameName: cleanText(row.game_name) || null,
    message: cleanText(row.message) || null,
    createdByCarerUid: cleanText(row.created_by_carer_uid) || null,
    createdByCarerUsername: cleanText(row.created_by_carer_username) || null,
    createdAt: toIsoString(row.created_at),
  };
}

export async function createCarerEscalationAlertInSql(input: {
  coadminUid: string;
  contextType?: string | null;
  escalationFrom?: string | null;
  taskId?: string | null;
  playerUid?: string | null;
  playerUsername?: string | null;
  gameName?: string | null;
  message?: string | null;
  createdByCarerUid?: string | null;
  createdByCarerUsername?: string | null;
}) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  if (!db || !coadminUid) {
    return null;
  }

  const alertId = randomUUID();
  const nowIso = new Date().toISOString();
  await db.query(
    `
      INSERT INTO public.carer_escalation_alerts_cache (
        alert_id, coadmin_uid, context_type, escalation_from, task_id,
        player_uid, player_username, game_name, message,
        created_by_carer_uid, created_by_carer_username, created_at,
        source, mirrored_at, deleted_at
      )
      VALUES (
        $1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
        NULLIF($10, ''), NULLIF($11, ''), $12::timestamptz,
        'authority', now(), NULL
      )
    `,
    [
      alertId,
      coadminUid,
      cleanText(input.contextType),
      cleanText(input.escalationFrom),
      cleanText(input.taskId),
      cleanText(input.playerUid),
      cleanText(input.playerUsername),
      cleanText(input.gameName),
      cleanText(input.message),
      cleanText(input.createdByCarerUid),
      cleanText(input.createdByCarerUsername),
      nowIso,
    ]
  );

  return { id: alertId, createdAt: nowIso };
}

export async function readCarerEscalationAlertsByCoadmin(coadminUid: string, limit = 24) {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  const safeLimit = Math.max(1, Math.min(limit, 100));
  if (!db || !cleanCoadminUid) {
    return null;
  }

  const result = await db.query(
    `
      SELECT *
      FROM public.carer_escalation_alerts_cache
      WHERE coadmin_uid = $1
        AND deleted_at IS NULL
        AND dismissed_at IS NULL
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2
    `,
    [cleanCoadminUid, safeLimit]
  );

  return result.rows
    .map((row) => mapRow(row as Record<string, unknown>))
    .filter((row): row is CachedCarerEscalationAlert => Boolean(row));
}
