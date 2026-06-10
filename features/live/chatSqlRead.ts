'use client';

import { Timestamp } from 'firebase/firestore';

import type { FirestoreChatMessage } from '@/features/messages/chatMessages';
import { fetchChatApi } from '@/lib/client/chatLogoutDiagnostics';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { checkPlayerPollRole } from '@/lib/client/playerPollGuard';
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

async function readChatApiContext() {
  const cached = getCachedSessionUser();
  const headers = await getSqlApiReadHeaders(false);
  return {
    role: cached?.role ?? null,
    uid: cached?.uid ?? null,
    hasAppSessionId: Boolean(getLocalAppSessionId()),
    hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    headersSent: Object.keys(headers),
    headers,
  };
}

export async function fetchSqlUnreadCounts() {
  const context = await readChatApiContext();
  const response = await fetchChatApi(
    '/api/chat/unread-counts',
    {
      method: 'GET',
      headers: context.headers,
      cache: 'no-store',
    },
    {
      role: context.role,
      uid: context.uid,
      hasAppSessionId: context.hasAppSessionId,
      hasPlayerSessionId: context.hasPlayerSessionId,
      headersSent: context.headersSent,
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    unreadCounts?: Record<string, number>;
    error?: string;
  };
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(payload.error || 'Chat unread counts unauthorized.');
    }
    throw new Error(payload.error || 'Failed to load unread counts.');
  }
  return payload.unreadCounts || {};
}

export async function fetchSqlChatMessages(peerUid: string, limit = 50) {
  const context = await readChatApiContext();
  const url = `/api/chat/messages?peerUid=${encodeURIComponent(peerUid)}&limit=${limit}`;
  const response = await fetchChatApi(
    url,
    {
      method: 'GET',
      headers: context.headers,
      cache: 'no-store',
    },
    {
      role: context.role,
      uid: context.uid,
      hasAppSessionId: context.hasAppSessionId,
      hasPlayerSessionId: context.hasPlayerSessionId,
      headersSent: context.headersSent,
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    messages?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(payload.error || 'Chat messages unauthorized.');
    }
    throw new Error(payload.error || 'Failed to load chat messages.');
  }
  return (payload.messages || []).map(mapCachedMessage);
}

export function attachSqlUnreadCountsPoll(
  onChange: (counts: Record<string, number>) => void,
  onError?: (error: Error) => void,
  options?: { requirePlayerRole?: boolean }
) {
  logClientFirestoreSkipped('chat_unread_counts_listener');
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    if (options?.requirePlayerRole) {
      const sessionUser = await checkPlayerPollRole('player_chat_unread_counts');
      if (!sessionUser) {
        cancelled = true;
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
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
  options?: { limit?: number; requirePlayerRole?: boolean },
  onError?: (error: Error) => void
) {
  logClientFirestoreSkipped('chat_messages_listener', { peerUid });
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    if (options?.requirePlayerRole) {
      const sessionUser = await checkPlayerPollRole('player_chat_messages');
      if (!sessionUser) {
        cancelled = true;
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
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
