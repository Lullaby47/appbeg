import 'server-only';

import {
  cleanText,
  getPlayerMirrorPool,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type CachedConversation = {
  id: string;
  participantUids: string[];
  lastMessage: string | null;
  lastMessageSenderUid: string | null;
  unreadCounts: Record<string, number>;
  updatedAt: string | null;
};

function parseParticipantUids(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => cleanText(entry)).filter(Boolean);
}

function parseUnreadCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(raw);
    if (Number.isFinite(count) && count > 0) {
      out[key] = count;
    }
  }
  return out;
}

function mapConversationRow(row: Record<string, unknown>): CachedConversation | null {
  const id = cleanText(row.firebase_id);
  if (!id) {
    return null;
  }
  return {
    id,
    participantUids: parseParticipantUids(row.participant_uids),
    lastMessage: cleanText(row.last_message) || null,
    lastMessageSenderUid: cleanText(row.last_message_sender_uid) || null,
    unreadCounts: parseUnreadCounts(row.unread_counts),
    updatedAt: toIsoString(row.updated_at),
  };
}

export async function readConversationsCacheForUser(
  uid: string
): Promise<CachedConversation[] | null> {
  const cleanUid = cleanText(uid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanUid) {
    return [];
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT firebase_id, participant_uids, last_message, last_message_sender_uid, unread_counts, updated_at
        FROM public.conversations_cache
        WHERE deleted_at IS NULL
          AND participant_uids ? $1
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 200
      `,
      [cleanUid],
      { context: 'conversations_cache_read' }
    );
    return rows.map(mapConversationRow).filter((row): row is CachedConversation => Boolean(row));
  } catch (error) {
    console.warn('[CONVERSATIONS_CACHE] read failed', { uid: cleanUid, error });
    return null;
  }
}
