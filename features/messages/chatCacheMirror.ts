import { getAppSessionRequestHeaders } from '@/features/auth/appSession';
import { auth } from '@/lib/firebase/client';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

async function postJson(path: string, body: Record<string, unknown>) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) {
    return;
  }
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...getAppSessionRequestHeaders(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn('[CHAT_CACHE_MIRROR] request failed', {
        path,
        status: response.status,
      });
    }
  } catch (error) {
    console.warn('[CHAT_CACHE_MIRROR] request failed', { path, error });
  }
}

export async function mirrorConversationCacheBestEffort(values: {
  conversationId: string;
  participants: string[];
  lastMessage: string;
  lastMessageSenderUid: string;
  unreadCounts: Record<string, number>;
}) {
  if (!isClientSqlReadMode()) {
    return;
  }
  await postJson('/api/conversations/cache/mirror', {
    conversationId: values.conversationId,
    action: 'upsert',
    raw: {
      participants: values.participants,
      lastMessage: values.lastMessage,
      lastMessageSenderUid: values.lastMessageSenderUid,
      unreadCounts: values.unreadCounts,
      updatedAt: new Date().toISOString(),
    },
  });
}

export async function mirrorChatMessageCacheBestEffort(values: {
  conversationId: string;
  messageId: string;
  type: 'text' | 'image';
  text?: string;
  imageUrl?: string;
  imagePublicId?: string;
  senderUid: string;
  receiverUid: string;
}) {
  if (!isClientSqlReadMode()) {
    return;
  }
  await postJson('/api/chat/messages/cache/mirror', {
    conversationId: values.conversationId,
    messageId: values.messageId,
    action: 'upsert',
    raw: {
      type: values.type,
      text: values.text || '',
      imageUrl: values.imageUrl || '',
      imagePublicId: values.imagePublicId || '',
      senderUid: values.senderUid,
      receiverUid: values.receiverUid,
      createdAt: new Date().toISOString(),
    },
  });
}

export async function markConversationReadCacheBestEffort(conversationId: string, uid: string) {
  if (!isClientSqlReadMode()) {
    return;
  }
  await postJson('/api/conversations/cache/mirror', {
    conversationId,
    action: 'mark_read',
    unreadCounts: { [uid]: 0 },
  });
}
