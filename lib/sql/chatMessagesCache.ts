import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
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

export async function upsertChatMessageCache(input: {
  firebaseId: string;
  conversationId: string;
  raw: Record<string, unknown>;
  source?: string;
}) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  const conversationId = cleanText(input.conversationId);
  if (!db || !firebaseId || !conversationId) {
    return false;
  }

  const raw = input.raw;
  const normalizedRaw = (normalizeJson(raw) || {}) as Record<string, unknown>;
  const type = cleanText(raw.type).toLowerCase() === 'image' ? 'image' : 'text';

  try {
    await db.query(
      `
        INSERT INTO public.chat_messages_cache (
          firebase_id,
          conversation_id,
          sender_uid,
          receiver_uid,
          type,
          text,
          image_url,
          image_public_id,
          created_at,
          raw_firestore_data,
          source,
          mirrored_at,
          deleted_at
        )
        VALUES (
          $1,
          $2,
          NULLIF($3, ''),
          NULLIF($4, ''),
          NULLIF($5, ''),
          NULLIF($6, ''),
          NULLIF($7, ''),
          NULLIF($8, ''),
          $9::timestamptz,
          $10::jsonb,
          $11,
          now(),
          NULL
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          conversation_id = EXCLUDED.conversation_id,
          sender_uid = EXCLUDED.sender_uid,
          receiver_uid = EXCLUDED.receiver_uid,
          type = EXCLUDED.type,
          text = EXCLUDED.text,
          image_url = EXCLUDED.image_url,
          image_public_id = EXCLUDED.image_public_id,
          created_at = COALESCE(public.chat_messages_cache.created_at, EXCLUDED.created_at),
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        firebaseId,
        conversationId,
        cleanText(raw.senderUid ?? raw.sender_uid),
        cleanText(raw.receiverUid ?? raw.receiver_uid),
        type,
        cleanText(raw.text),
        cleanText(raw.imageUrl ?? raw.image_url),
        cleanText(raw.imagePublicId ?? raw.image_public_id),
        toIsoString(raw.createdAt ?? raw.created_at),
        JSON.stringify(normalizedRaw),
        cleanText(input.source) || 'mirror',
      ]
    );
    return true;
  } catch (error) {
    console.warn('[CHAT_MESSAGES_CACHE] upsert failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorChatMessageSnapshot(
  conversationId: string,
  snap: DocumentSnapshot
) {
  if (!snap.exists) {
    return false;
  }
  return upsertChatMessageCache({
    firebaseId: snap.id,
    conversationId,
    raw: snap.data() as Record<string, unknown>,
    source: 'mirror',
  });
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
