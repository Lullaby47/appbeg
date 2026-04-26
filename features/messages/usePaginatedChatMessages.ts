'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  CHAT_OLDER_MESSAGE_PAGE_SIZE,
  CHAT_RECENT_MESSAGE_WINDOW,
  fetchMessagesOlderThan,
  type FirestoreChatMessage,
  listenToMessages,
} from '@/features/messages/chatMessages';

export type UsePaginatedChatMessagesOptions = {
  recentWindowSize?: number;
  pageSize?: number;
  onWindowMessages?: (windowMessages: FirestoreChatMessage[]) => void;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
};

export function usePaginatedChatMessages(
  otherUid: string | null,
  options?: UsePaginatedChatMessagesOptions
) {
  const recentWindow = options?.recentWindowSize ?? CHAT_RECENT_MESSAGE_WINDOW;
  const pageSize = options?.pageSize ?? CHAT_OLDER_MESSAGE_PAGE_SIZE;
  const onWindowRef = useRef(options?.onWindowMessages);
  onWindowRef.current = options?.onWindowMessages;
  const scrollRef = options?.scrollContainerRef;

  const [windowMessages, setWindowMessages] = useState<FirestoreChatMessage[]>([]);
  const [olderMessages, setOlderMessages] = useState<FirestoreChatMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const exhaustedOlderRef = useRef(false);
  const pendingScrollRestore = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const prevOlderLengthRef = useRef(0);

  useEffect(() => {
    exhaustedOlderRef.current = false;
    prevOlderLengthRef.current = 0;
    setOlderMessages([]);
    setWindowMessages([]);
    setHasMoreOlder(false);
  }, [otherUid]);

  useEffect(() => {
    if (!otherUid) {
      return;
    }

    const unsubscribe = listenToMessages(
      otherUid,
      (items) => {
        setWindowMessages(items);
        onWindowRef.current?.(items);
        setHasMoreOlder(() => {
          if (exhaustedOlderRef.current) {
            return false;
          }
          return items.length === recentWindow;
        });
      },
      { limit: recentWindow }
    );

    return () => unsubscribe();
  }, [otherUid, recentWindow]);

  const items = useMemo(() => {
    if (olderMessages.length === 0) {
      return windowMessages;
    }
    return [...olderMessages, ...windowMessages];
  }, [olderMessages, windowMessages]);

  const loadOlder = useCallback(async () => {
    if (!otherUid || loadingOlder) {
      return;
    }
    if (exhaustedOlderRef.current) {
      return;
    }
    if (!hasMoreOlder) {
      return;
    }

    const oldest = olderMessages[0] ?? windowMessages[0];
    if (!oldest) {
      return;
    }

    const el = scrollRef?.current;
    if (el) {
      pendingScrollRestore.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
    } else {
      pendingScrollRestore.current = null;
    }

    setLoadingOlder(true);
    try {
      const batch = await fetchMessagesOlderThan(otherUid, oldest.id, pageSize);
      if (batch.length === 0) {
        exhaustedOlderRef.current = true;
        setHasMoreOlder(false);
        pendingScrollRestore.current = null;
        return;
      }
      if (batch.length < pageSize) {
        exhaustedOlderRef.current = true;
        setHasMoreOlder(false);
      }
      setOlderMessages((prev) => [...batch, ...prev]);
    } finally {
      setLoadingOlder(false);
    }
  }, [
    otherUid,
    loadingOlder,
    hasMoreOlder,
    olderMessages,
    windowMessages,
    pageSize,
    scrollRef,
  ]);

  useLayoutEffect(() => {
    if (olderMessages.length === prevOlderLengthRef.current) {
      return;
    }
    prevOlderLengthRef.current = olderMessages.length;

    const p = pendingScrollRestore.current;
    const el = scrollRef?.current;
    if (!p || !el) {
      return;
    }
    const nextHeight = el.scrollHeight;
    el.scrollTop = p.scrollTop + (nextHeight - p.scrollHeight);
    pendingScrollRestore.current = null;
  }, [olderMessages.length, scrollRef]);

  return {
    items,
    loadOlder,
    loadingOlder,
    hasMoreOlder,
  };
}
