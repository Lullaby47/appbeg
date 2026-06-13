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

export type AuthorityChatDeleteInput = {
  actorUid: string;
  peerUid: string;
  conversationId: string;
  messageId: string;
  scope: 'for_me' | 'for_everyone';
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

function parseJsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(cleanText).filter(Boolean);
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

export async function deleteChatMessageInSql(input: AuthorityChatDeleteInput) {
  const db = getPlayerMirrorPool();
  const actorUid = cleanText(input.actorUid);
  const peerUid = cleanText(input.peerUid);
  const conversationId = cleanText(input.conversationId);
  const messageId = cleanText(input.messageId);
  const scope = input.scope === 'for_everyone' ? 'for_everyone' : 'for_me';
  if (!db || !actorUid || !peerUid || !conversationId || !messageId) {
    return { ok: false as const, status: 400, reason: 'missing_input' };
  }

  const nowIso = new Date().toISOString();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const beforeResult = await client.query(
      `
        SELECT firebase_id, conversation_id, sender_uid, receiver_uid, type, text,
               image_url, image_public_id, deleted_for_uids, deleted_for_everyone
        FROM public.chat_messages_cache
        WHERE firebase_id = $1
          AND conversation_id = $2
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [messageId, conversationId]
    );
    const before = beforeResult.rows[0] as Record<string, unknown> | undefined;
    if (!before) {
      await client.query('ROLLBACK');
      return { ok: false as const, status: 404, reason: 'message_not_found' };
    }

    const senderUid = cleanText(before.sender_uid);
    const receiverUid = cleanText(before.receiver_uid);
    const participants = [senderUid, receiverUid].filter(Boolean);
    const isParticipant = participants.includes(actorUid) && participants.includes(peerUid);
    const beforeDeletedFor = parseJsonArray(before.deleted_for_uids);
    const beforeDeletedForEveryone = before.deleted_for_everyone === true;

    console.info('[CHAT_DELETE_REQUEST]', {
      messageId,
      conversationId,
      actorUid,
      peerUid,
      senderUid,
      currentDeleteFields: {
        deletedFor: beforeDeletedFor,
        deletedForEveryone: beforeDeletedForEveryone,
      },
      scope,
    });

    if (!isParticipant) {
      console.info('[CHAT_DELETE_PERMISSION_DENIED]', {
        messageId,
        conversationId,
        actorUid,
        peerUid,
        senderUid,
        reason: 'actor_or_peer_not_participant',
      });
      await client.query('ROLLBACK');
      return { ok: false as const, status: 403, reason: 'not_participant' };
    }

    if (scope === 'for_everyone' && senderUid !== actorUid) {
      console.info('[CHAT_DELETE_PERMISSION_DENIED]', {
        messageId,
        conversationId,
        actorUid,
        peerUid,
        senderUid,
        reason: 'not_sender',
      });
      await client.query('ROLLBACK');
      return { ok: false as const, status: 403, reason: 'only_sender_can_delete_for_everyone' };
    }

    let updatedRow: Record<string, unknown> | undefined;
    if (scope === 'for_me') {
      const updatedDeletedFor = Array.from(new Set([...beforeDeletedFor, actorUid]));
      console.info('[CHAT_DELETE_FOR_ME]', {
        messageId,
        senderUid,
        currentDeleteFields: {
          deletedFor: beforeDeletedFor,
          deletedForEveryone: beforeDeletedForEveryone,
        },
        updatedDeleteFields: {
          deletedFor: updatedDeletedFor,
          deletedForEveryone: beforeDeletedForEveryone,
        },
      });
      const result = await client.query(
        `
          UPDATE public.chat_messages_cache
          SET deleted_for_uids = $3::jsonb,
              raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('deletedFor', $3::jsonb),
              source = 'authority_chat_delete',
              mirrored_at = now()
          WHERE firebase_id = $1
            AND conversation_id = $2
            AND deleted_at IS NULL
          RETURNING firebase_id, conversation_id, sender_uid, receiver_uid, type, text,
                    image_url, image_public_id, deleted_for_uids, deleted_for_everyone
        `,
        [messageId, conversationId, JSON.stringify(updatedDeletedFor)]
      );
      updatedRow = result.rows[0] as Record<string, unknown> | undefined;
    } else {
      console.info('[CHAT_DELETE_FOR_ALL]', {
        messageId,
        senderUid,
        currentDeleteFields: {
          deletedFor: beforeDeletedFor,
          deletedForEveryone: beforeDeletedForEveryone,
        },
        updatedDeleteFields: {
          deletedFor: beforeDeletedFor,
          deletedForEveryone: true,
        },
      });
      const result = await client.query(
        `
          UPDATE public.chat_messages_cache
          SET text = NULL,
              image_url = NULL,
              image_public_id = NULL,
              deleted_for_everyone = TRUE,
              deleted_for_everyone_at = COALESCE(deleted_for_everyone_at, now()),
              raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
                || jsonb_build_object(
                  'text', '',
                  'imageUrl', '',
                  'imagePublicId', '',
                  'deletedForEveryone', true,
                  'deletedForEveryoneAt', $3::text,
                  'searchTokens', '[]'::jsonb
                ),
              source = 'authority_chat_delete',
              mirrored_at = now()
          WHERE firebase_id = $1
            AND conversation_id = $2
            AND deleted_at IS NULL
          RETURNING firebase_id, conversation_id, sender_uid, receiver_uid, type, text,
                    image_url, image_public_id, deleted_for_uids, deleted_for_everyone
        `,
        [messageId, conversationId, nowIso]
      );
      updatedRow = result.rows[0] as Record<string, unknown> | undefined;
      const latestResult = await client.query(
        `
          SELECT firebase_id
          FROM public.chat_messages_cache
          WHERE conversation_id = $1
            AND deleted_at IS NULL
          ORDER BY created_at DESC NULLS LAST
          LIMIT 1
        `,
        [conversationId]
      );
      if (cleanText(latestResult.rows[0]?.firebase_id) === messageId) {
        await client.query(
          `
            UPDATE public.conversations_cache
            SET last_message = 'Message deleted',
                source = 'authority_chat_delete',
                mirrored_at = now()
            WHERE firebase_id = $1
              AND deleted_at IS NULL
          `,
          [conversationId]
        );
      }
    }

    if (!updatedRow) {
      await client.query('ROLLBACK');
      return { ok: false as const, status: 500, reason: 'message_update_failed' };
    }

    const updatedDeletedFor = parseJsonArray(updatedRow.deleted_for_uids);
    const updatedDeletedForEveryone = updatedRow.deleted_for_everyone === true;
    console.info('[CHAT_DELETE_DB_UPDATED]', {
      messageId,
      senderUid,
      currentDeleteFields: {
        deletedFor: beforeDeletedFor,
        deletedForEveryone: beforeDeletedForEveryone,
      },
      updatedDeleteFields: {
        deletedFor: updatedDeletedFor,
        deletedForEveryone: updatedDeletedForEveryone,
      },
      writeResult: 'updated',
    });

    await emitChatMessageOutboxEvent(client, {
      entityId: messageId,
      conversationId,
      senderUid,
      receiverUid,
      type: cleanText(updatedRow.type) || cleanText(before.type) || 'text',
      text: updatedDeletedForEveryone ? null : cleanText(updatedRow.text) || null,
      imageUrl: updatedDeletedForEveryone ? null : cleanText(updatedRow.image_url) || null,
      updatedAt: nowIso,
      source: 'authority_chat_delete',
      participantUids: participants,
    });

    await client.query('COMMIT');
    return {
      ok: true as const,
      message: {
        id: messageId,
        senderUid,
        receiverUid,
        type: cleanText(updatedRow.type) === 'image' ? 'image' : 'text',
        text: updatedDeletedForEveryone ? null : cleanText(updatedRow.text) || null,
        imageUrl: updatedDeletedForEveryone ? null : cleanText(updatedRow.image_url) || null,
        imagePublicId: updatedDeletedForEveryone ? null : cleanText(updatedRow.image_public_id) || null,
        deletedFor: updatedDeletedFor,
        deletedForEveryone: updatedDeletedForEveryone,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.warn('[AUTHORITY_CHAT] delete failed', { conversationId, messageId, scope, error });
    return { ok: false as const, status: 500, reason: 'sql_delete_failed' };
  } finally {
    client.release();
  }
}
