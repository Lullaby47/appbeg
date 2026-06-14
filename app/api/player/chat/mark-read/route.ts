import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { clearConversationUnreadForUser } from '@/lib/sql/conversationsCache';

export const runtime = 'nodejs';

type PlayerChatType = 'player_agent' | 'player_staff' | 'player_carer' | 'player_player';

type Body = {
  threadId?: unknown;
  chatType?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function getAuthorityConversationId(uid1: string, uid2: string) {
  return [uid1, uid2].sort().join('_');
}

function getDirectConversationId(uid1: string, uid2: string) {
  return [uid1, uid2].sort().join('__');
}

function normalizeChatType(value: unknown): PlayerChatType | null {
  const type = cleanText(value);
  if (
    type === 'player_agent' ||
    type === 'player_staff' ||
    type === 'player_carer' ||
    type === 'player_player'
  ) {
    return type;
  }
  return null;
}

function resolveConversationId(playerUid: string, threadId: string, chatType: PlayerChatType) {
  const separator = chatType === 'player_player' ? '__' : '_';
  if (threadId.includes(separator)) {
    const participants = threadId.split(separator).map(cleanText).filter(Boolean);
    const peerUid = participants.find((uid) => uid !== playerUid) || '';
    const expected =
      chatType === 'player_player'
        ? getDirectConversationId(playerUid, peerUid)
        : getAuthorityConversationId(playerUid, peerUid);
    if (participants.length === 2 && peerUid && threadId === expected) {
      return { conversationId: threadId, peerUid };
    }
    return { conversationId: '', peerUid: '' };
  }

  const peerUid = threadId;
  if (!peerUid || peerUid === playerUid) {
    return { conversationId: '', peerUid: '' };
  }
  return {
    conversationId:
      chatType === 'player_player'
        ? getDirectConversationId(playerUid, peerUid)
        : getAuthorityConversationId(playerUid, peerUid),
    peerUid,
  };
}

async function persistFirestoreReadMarker(input: {
  conversationId: string;
  playerUid: string;
  chatType: PlayerChatType;
}) {
  const collection = input.chatType === 'player_player' ? 'playerConversations' : 'conversations';
  await adminDb
    .collection(collection)
    .doc(input.conversationId)
    .set(
      {
        unreadCounts: { [input.playerUid]: 0 },
        seenAtByUid: { [input.playerUid]: FieldValue.serverTimestamp() },
        deliveredAtByUid: { [input.playerUid]: FieldValue.serverTimestamp() },
      },
      { merge: true }
    );
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const threadId = cleanText(body.threadId);
  const chatType = normalizeChatType(body.chatType);
  if (!threadId || !chatType) {
    return apiError('threadId and valid chatType are required.', 400);
  }

  const playerUid = auth.user.uid;
  const { conversationId, peerUid } = resolveConversationId(playerUid, threadId, chatType);
  if (!conversationId || !peerUid) {
    console.warn('[PLAYER_CHAT_READ] skippedUnauthorizedThread', {
      playerUid,
      threadId,
      chatType,
      reason: 'invalid_thread',
    });
    return apiError('Unauthorized chat thread.', 403);
  }

  const sqlResult = await clearConversationUnreadForUser({
    firebaseId: conversationId,
    uid: playerUid,
    source: 'player_chat_mark_read',
  });
  if (!sqlResult.ok && sqlResult.unauthorized) {
    console.warn('[PLAYER_CHAT_READ] skippedUnauthorizedThread', {
      playerUid,
      threadId,
      chatType,
      conversationId,
      reason: 'not_participant',
    });
    return apiError('Unauthorized chat thread.', 403);
  }

  try {
    await persistFirestoreReadMarker({ conversationId, playerUid, chatType });
  } catch (error) {
    console.warn('[PLAYER_CHAT_READ] persisted', {
      chatType,
      threadId,
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json({
    success: true,
    threadId,
    chatType,
    conversationId,
    unreadCount: sqlResult.unreadCount,
    sqlPersisted: sqlResult.ok,
  });
}
