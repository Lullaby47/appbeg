import { getAppSessionRequestHeaders } from '@/features/auth/appSession';
import { auth } from '@/lib/firebase/client';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

async function postJson(
  path: string,
  body: Record<string, unknown>,
  options?: { requireSuccess?: boolean }
) {
  const token = await auth.currentUser?.getIdToken();
  const appSessionHeaders = getAppSessionRequestHeaders();
  if (!token && !appSessionHeaders['X-App-Session-Id']) {
    if (options?.requireSuccess) {
      throw new Error('No app session is available to update chat read state.');
    }
    return false;
  }
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...appSessionHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn('[CHAT_CACHE_MIRROR] request failed', {
        path,
        status: response.status,
      });
      if (options?.requireSuccess) {
        throw new Error('Failed to update chat read state.');
      }
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[CHAT_CACHE_MIRROR] request failed', { path, error });
    if (options?.requireSuccess) {
      throw error;
    }
    return false;
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

export async function markConversationReadCacheBestEffort(
  conversationId: string,
  uid: string,
  options?: { requireSuccess?: boolean }
) {
  if (!isClientSqlReadMode()) {
    return;
  }
  await postJson('/api/conversations/cache/mirror', {
    conversationId,
    action: 'mark_read',
    unreadCounts: { [uid]: 0 },
  }, { requireSuccess: options?.requireSuccess });
}
