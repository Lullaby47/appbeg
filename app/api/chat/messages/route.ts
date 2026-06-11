import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import { sendChatMessageInSql } from '@/lib/sql/authorityChat';
import { readChatMessagesCacheByConversation } from '@/lib/sql/chatMessagesCache';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';

export const runtime = 'nodejs';

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

export async function POST(request: Request) {
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

  if (!isDatabaseUrlConfigured()) {
    return apiError('Chat is unavailable in SQL mode right now.', 503);
  }

  const body = (await request.json().catch(() => ({}))) as {
    peerUid?: string;
    conversationId?: string;
    type?: string;
    text?: string;
    imageUrl?: string;
    imagePublicId?: string;
  };

  const receiverUid = String(body.peerUid || '').trim();
  if (!receiverUid) {
    return apiError('peerUid is required.', 400);
  }

  const type = String(body.type || 'text').trim().toLowerCase() === 'image' ? 'image' : 'text';
  if (type === 'image') {
    return apiError('Image chat not ready.', 501);
  }

  const text = String(body.text || '').trim();
  if (!text) {
    return apiError('Message text is required.', 400);
  }

  const conversationId =
    String(body.conversationId || '').trim() || getConversationId(auth.user.uid, receiverUid);

  const result = await sendChatMessageInSql({
    senderUid: auth.user.uid,
    receiverUid,
    conversationId,
    type: 'text',
    text,
  });

  if (!result.ok) {
    return apiError('Failed to send chat message.', 500);
  }

  return NextResponse.json({
    success: true,
    messageId: result.messageId,
    conversationId: result.conversationId,
    createdAt: result.createdAt,
    source: 'postgres',
    firestore_fallback: false,
  });
}
