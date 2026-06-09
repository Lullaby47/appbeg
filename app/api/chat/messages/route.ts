import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import { readChatMessagesCacheByConversation } from '@/lib/sql/chatMessagesCache';

const ROUTE = '/api/chat/messages';

function getConversationId(uid1: string, uid2: string) {
  return [uid1, uid2].sort().join('_');
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, [
    'admin',
    'coadmin',
    'staff',
    'carer',
    'player',
  ]);
  if ('response' in auth) {
    return auth.response;
  }

  const peerUid = String(new URL(request.url).searchParams.get('peerUid') || '').trim();
  if (!peerUid) {
    return apiError('peerUid query parameter is required.', 400);
  }

  const limit = Math.max(1, Math.min(200, Number(new URL(request.url).searchParams.get('limit') || 50)));
  const conversationId = getConversationId(auth.user.uid, peerUid);
  const messages = await readChatMessagesCacheByConversation(conversationId, limit);

  if (isCacheSqlAuthoritative()) {
    logCacheSqlRead(ROUTE, {
      conversationId,
      count: messages?.length || 0,
      durationMs: Date.now() - startedAt,
    });
    if (messages === null) {
      logCacheFirestoreFallbackBlocked(ROUTE, 'chat_messages', { conversationId });
    }
  }

  return NextResponse.json({
    messages: (messages || []).map((message) => ({
      id: message.id,
      senderUid: message.senderUid,
      receiverUid: message.receiverUid,
      type: message.type,
      text: message.text,
      imageUrl: message.imageUrl,
      imagePublicId: message.imagePublicId,
      createdAt: message.createdAt,
    })),
    conversationId,
    source: 'postgres',
    firestore_fallback: false,
  });
}
