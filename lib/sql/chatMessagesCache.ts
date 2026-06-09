import 'server-only';

import {
  cleanText,
  getPlayerMirrorPool,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type CachedChatMessage = {
  id: string;
  conversationId: string;
  senderUid: string;
  receiverUid: string;
  type: 'text' | 'image';
  text: string | null;
  imageUrl: string | null;
  imagePublicId: string | null;
  createdAt: string | null;
};

function mapChatMessageRow(row: Record<string, unknown>): CachedChatMessage | null {
  const id = cleanText(row.firebase_id);
  const conversationId = cleanText(row.conversation_id);
  if (!id || !conversationId) {
    return null;
  }
  const type = cleanText(row.type).toLowerCase() === 'image' ? 'image' : 'text';
  return {
    id,
    conversationId,
    senderUid: cleanText(row.sender_uid),
    receiverUid: cleanText(row.receiver_uid),
    type,
    text: cleanText(row.text) || null,
    imageUrl: cleanText(row.image_url) || null,
    imagePublicId: cleanText(row.image_public_id) || null,
    createdAt: toIsoString(row.created_at),
  };
}

export async function readChatMessagesCacheByConversation(
  conversationId: string,
  limit = 50
): Promise<CachedChatMessage[] | null> {
  const cleanConversationId = cleanText(conversationId);
  const db = getPlayerMirrorPool();
  if (!db || !cleanConversationId) {
    return [];
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT firebase_id, conversation_id, sender_uid, receiver_uid, type, text, image_url, image_public_id, created_at
        FROM public.chat_messages_cache
        WHERE deleted_at IS NULL
          AND conversation_id = $1
        ORDER BY created_at DESC NULLS LAST
        LIMIT $2
      `,
      [cleanConversationId, Math.max(1, Math.min(200, limit))],
      { context: 'chat_messages_cache_read' }
    );
    const messages = rows
      .map(mapChatMessageRow)
      .filter((row): row is CachedChatMessage => Boolean(row))
      .reverse();
    return messages;
  } catch (error) {
    console.warn('[CHAT_MESSAGES_CACHE] read failed', {
      conversationId: cleanConversationId,
      error,
    });
    return null;
  }
}
