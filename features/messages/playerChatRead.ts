'use client';

import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';

export type PlayerChatReadType =
  | 'player_agent'
  | 'player_staff'
  | 'player_carer'
  | 'player_player';

export async function markPlayerChatThreadRead(threadId: string, chatType: PlayerChatReadType) {
  const response = await fetch('/api/player/chat/mark-read', {
    method: 'POST',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify({ threadId, chatType }),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    unreadCount?: number;
    conversationId?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to mark chat as read.');
  }
  return payload;
}
