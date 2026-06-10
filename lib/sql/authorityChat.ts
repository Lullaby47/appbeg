import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import {
  emitChatMessageOutboxEvent,
  userChatLiveChannel,
} from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export type AuthorityChatSendInput = {
  senderUid: string;
  receiverUid: string;
  conversationId: string;
  type: 'text' | 'image';
  text?: string;
  imageUrl?: string;
  imagePublicId?: string;
};

async function upsertConversationInTxn(
  client: PoolClient,
  input: {
    conversationId: string;
    senderUid: string;
    receiverUid: string;
    lastMessage: string;
    unreadCounts: Record<string, number>;
    nowIso: string;
  }
) {
  const participantUids = [input.senderUid, input.receiverUid].sort();
  await client.query(
    `
      INSERT INTO public.conversations_cache (
        firebase_id, participant_uids, last_message, last_message_sender_uid,
        unread_counts, updated_at, raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6::timestamptz, '{}'::jsonb, 'authority_chat', now(), NULL)
      ON CONFLICT (firebase_id) DO UPDATE SET
        participant_uids = EXCLUDED.participant_uids,
        last_message = EXCLUDED.last_message,
        last_message_sender_uid = EXCLUDED.last_message_sender_uid,
        unread_counts = EXCLUDED.unread_counts,
        updated_at = EXCLUDED.updated_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      input.conversationId,
      JSON.stringify(participantUids),
      input.lastMessage,
      input.senderUid,
      JSON.stringify(input.unreadCounts),
      input.nowIso,
    ]
  );
}

async function upsertMessageInTxn(
  client: PoolClient,
  input: {
    messageId: string;
    conversationId: string;
    senderUid: string;
    receiverUid: string;
    type: 'text' | 'image';
    text: string | null;
    imageUrl: string | null;
    imagePublicId: string | null;
    nowIso: string;
  }
) {
  await client.query(
    `
      INSERT INTO public.chat_messages_cache (
        firebase_id, conversation_id, sender_uid, receiver_uid, type,
        text, image_url, image_public_id, created_at, raw_firestore_data,
        source, mirrored_at, deleted_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''),
        $9::timestamptz, '{}'::jsonb, 'authority_chat', now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        conversation_id = EXCLUDED.conversation_id,
        sender_uid = EXCLUDED.sender_uid,
        receiver_uid = EXCLUDED.receiver_uid,
        type = EXCLUDED.type,
        text = EXCLUDED.text,
        image_url = EXCLUDED.image_url,
        image_public_id = EXCLUDED.image_public_id,
        created_at = EXCLUDED.created_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      input.messageId,
      input.conversationId,
      input.senderUid,
      input.receiverUid,
      input.type,
      input.text,
      input.imageUrl,
      input.imagePublicId,
      input.nowIso,
    ]
  );
}

export async function sendChatMessageInSql(input: AuthorityChatSendInput) {
  const db = getPlayerMirrorPool();
  const senderUid = cleanText(input.senderUid);
  const receiverUid = cleanText(input.receiverUid);
  const conversationId = cleanText(input.conversationId);
  const type = input.type === 'image' ? 'image' : 'text';
  if (!db || !senderUid || !receiverUid || !conversationId) {
    return { ok: false as const, reason: 'missing_input' };
  }

  if (type === 'text' && !cleanText(input.text)) {
    return { ok: false as const, reason: 'empty_text' };
  }
  if (type === 'image' && !cleanText(input.imageUrl)) {
    return { ok: false as const, reason: 'missing_image' };
  }

  const messageId = randomUUID();
  const nowIso = new Date().toISOString();
  const lastMessage = type === 'image' ? '📷 Photo' : cleanText(input.text);
  const unreadCounts = {
    [receiverUid]: 1,
    [senderUid]: 0,
  };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await upsertConversationInTxn(client, {
      conversationId,
      senderUid,
      receiverUid,
      lastMessage,
      unreadCounts,
      nowIso,
    });
    await upsertMessageInTxn(client, {
      messageId,
      conversationId,
      senderUid,
      receiverUid,
      type,
      text: type === 'text' ? cleanText(input.text) : null,
      imageUrl: type === 'image' ? cleanText(input.imageUrl) : null,
      imagePublicId: type === 'image' ? cleanText(input.imagePublicId) : null,
      nowIso,
    });

    const payload = {
      entityId: messageId,
      conversationId,
      senderUid,
      receiverUid,
      type,
      text: type === 'text' ? cleanText(input.text) : null,
      imageUrl: type === 'image' ? cleanText(input.imageUrl) : null,
      updatedAt: nowIso,
      source: 'authority_chat',
    };

    await emitChatMessageOutboxEvent(client, {
      ...payload,
      participantUids: [senderUid, receiverUid],
    });

    await client.query('COMMIT');
    return {
      ok: true as const,
      messageId,
      conversationId,
      createdAt: nowIso,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.warn('[AUTHORITY_CHAT] send failed', { conversationId, error });
    return { ok: false as const, reason: 'sql_write_failed' };
  } finally {
    client.release();
  }
}
