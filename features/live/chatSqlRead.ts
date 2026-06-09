'use client';

import { Timestamp } from 'firebase/firestore';

import type { FirestoreChatMessage } from '@/features/messages/chatMessages';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

const POLL_MS = 8_000;

function isoToTimestamp(iso: string | null | undefined) {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Timestamp.fromMillis(ms) : null;
}

function mapCachedMessage(row: Record<string, unknown>): FirestoreChatMessage {
  return {
    id: String(row.id || row.firebase_id || ''),
    text: String(row.text || '').trim() || undefined,
    imageUrl: String(row.imageUrl || '').trim() || undefined,
    imagePublicId: String(row.imagePublicId || '').trim() || undefined,
    type: String(row.type || 'text') === 'image' ? 'image' : 'text',
    senderUid: String(row.senderUid || ''),
    receiverUid: String(row.receiverUid || ''),
    createdAt: isoToTimestamp(String(row.createdAt || '') || null),
  };
}

export async function fetchSqlUnreadCounts() {
  const response = await fetch('/api/chat/unread-counts', {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    unreadCounts?: Record<string, number>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load unread counts.');
  }
  return payload.unreadCounts || {};
}

export async function fetchSqlChatMessages(peerUid: string, limit = 50) {
  const response = await fetch(
    `/api/chat/messages?peerUid=${encodeURIComponent(peerUid)}&limit=${limit}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    messages?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load chat messages.');
  }
  return (payload.messages || []).map(mapCachedMessage);
}

export function attachSqlUnreadCountsPoll(
  onChange: (counts: Record<string, number>) => void,
  onError?: (error: Error) => void
) {
  logClientFirestoreSkipped('chat_unread_counts_listener');
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      const counts = await fetchSqlUnreadCounts();
      if (!cancelled) {
        onChange(counts);
      }
    } catch (error) {
      if (!cancelled) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (!cancelled) {
        timer = setTimeout(() => void tick(), POLL_MS);
      }
    }
  };

  void tick();
  return () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function attachSqlChatMessagesPoll(
  peerUid: string,
  onChange: (messages: FirestoreChatMessage[]) => void,
  options?: { limit?: number },
  onError?: (error: Error) => void
) {
  logClientFirestoreSkipped('chat_messages_listener', { peerUid });
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      const messages = await fetchSqlChatMessages(peerUid, options?.limit || 50);
      if (!cancelled) {
        onChange(messages);
      }
    } catch (error) {
      if (!cancelled) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (!cancelled) {
        timer = setTimeout(() => void tick(), POLL_MS);
      }
    }
  };

  void tick();
  return () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function isChatSqlReadEnabled() {
  return isClientSqlReadMode();
}
