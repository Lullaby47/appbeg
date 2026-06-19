'use client';

import '@/styles/player-fire.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { computeRewardCoinsAfterFee } from '@/lib/rewardCoinTransferFee';
import { getPublicDisplayName } from '@/lib/player/publicDisplayName';
import { logChatPageMount } from '@/lib/client/chatLogoutDiagnostics';
import { shouldSkipClientFirestore } from '@/lib/client/clientFirestoreGuard';
import { useIsPlayerSessionRole } from '@/features/player/useIsPlayerSessionRole';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import {
  clearStaleRoleThemeStorage,
  installPlayerThemeAudioGuard,
  stopWrongPlayerRouteThemeAudio,
} from '@/lib/client/playerThemeAudioGuard';
import { CASINO_BACKGROUND_TRACKS } from '../constants';
import {
  acceptFriendRequest,
  deleteDirectMessageForEveryone,
  deleteDirectMessageForMe,
  ensureReferralFriendLinks,
  fetchPlayerChatBootstrap,
  filterVisibleDirectMessages,
  FriendLink,
  listenDirectChatList,
  listenFriendLinks,
  listenDirectMessages,
  listenDirectTyping,
  markDirectConversationSeen,
  PlayerChatMessage,
  PlayerPeer,
  searchDirectMessages,
  sendFriendRequest,
  sendFriendRequestByReferralCode,
  rewardCoinsToPlayer,
  sendDirectImageMessage,
  sendDirectTextMessage,
  setDirectConversationMuted,
  setDirectTyping,
  PLAYER_CHAT_RENDER_LIMIT,
} from '@/features/messages/playerChat';
import { markPlayerChatThreadRead, type PlayerChatReadType } from '@/features/messages/playerChatRead';

const PLAYER_CHAT_RENDER_MAX = 10;

function trimRenderedPlayerMessages(messages: PlayerChatMessage[]) {
  return messages.slice(-PLAYER_CHAT_RENDER_LIMIT);
}

function logChatMessageLimitApplied(beforeCount: number, afterCount: number) {
  if (process.env.NODE_ENV !== 'development' || beforeCount <= afterCount) {
    return;
  }
  console.info('[CHAT_MESSAGE_LIMIT_APPLIED]', {
    chatType: 'player_player',
    beforeCount,
    afterCount,
    limit: PLAYER_CHAT_RENDER_LIMIT,
  });
}

function isNearScrollBottom(el: HTMLElement | null, threshold = 96) {
  if (!el) {
    return true;
  }
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function toTime(value: { toMillis?: () => number } | null | undefined) {
  const ms = value?.toMillis?.() ?? 0;
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function PlayerChatPage() {
  const isPlayerRole = useIsPlayerSessionRole();
  const mountLoggedRef = useRef(false);
  const [allPlayers, setAllPlayers] = useState<PlayerPeer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<PlayerPeer | null>(null);
  const [messages, setMessages] = useState<PlayerChatMessage[]>([]);
  const [rawMessageCount, setRawMessageCount] = useState(0);
  const [typing, setTyping] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [messageError, setMessageError] = useState('');
  const [replyTarget, setReplyTarget] = useState<PlayerChatMessage | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [playerSearchTerm, setPlayerSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<PlayerChatMessage[]>([]);
  const [showRewardPanel, setShowRewardPanel] = useState(false);
  const [rewardAmount, setRewardAmount] = useState('10');
  const [rewardBusy, setRewardBusy] = useState(false);
  const [rewardNotice, setRewardNotice] = useState('');
  const rewardRequestIdRef = useRef<string | null>(null);
  const rewardInFlightRef = useRef(false);
  const [chatList, setChatList] = useState<Record<string, { unread: number; muted: boolean; last: string }>>({});
  const [friendByUid, setFriendByUid] = useState<
    Record<string, { status: 'pending' | 'accepted'; requestedByUid: string }>
  >({});
  const [showAddByReferralModal, setShowAddByReferralModal] = useState(false);
  const [referralInput, setReferralInput] = useState('');
  const [referralLoading, setReferralLoading] = useState(false);
  const [referralError, setReferralError] = useState('');
  const [referralNotice, setReferralNotice] = useState('');
  const [selfUid, setSelfUid] = useState('');
  const [chatLoading, setChatLoading] = useState(true);
  const [chatLoadError, setChatLoadError] = useState('');
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const pendingScrollToBottomRef = useRef(false);
  const [showNewMessagePill, setShowNewMessagePill] = useState(false);
  const [failedDraft, setFailedDraft] = useState('');
  const chatReadInFlightRef = useRef<Set<string>>(new Set());
  const lastChatReadClearAtRef = useRef<Record<string, number>>({});

  useEffect(() => {
    installPlayerThemeAudioGuard(CASINO_BACKGROUND_TRACKS);
    clearStaleRoleThemeStorage();
    stopWrongPlayerRouteThemeAudio(CASINO_BACKGROUND_TRACKS);

    return () => {
      stopWrongPlayerRouteThemeAudio(CASINO_BACKGROUND_TRACKS);
    };
  }, []);

  const markThreadReadOnPlayerChatFocus = useCallback(
    (
      threadId: string | null | undefined,
      chatType: PlayerChatReadType,
      trigger: 'open' | 'input' = 'input'
    ) => {
      const cleanThreadId = String(threadId || '').trim();
      if (!cleanThreadId) {
        console.info('[PLAYER_CHAT_READ] skippedNoThread', { chatType });
        return;
      }

      const dedupeKey = `${chatType}:${cleanThreadId}`;
      const now = Date.now();
      if (chatReadInFlightRef.current.has(dedupeKey)) {
        console.info('[PLAYER_CHAT_READ] debounced', { chatType, threadId: cleanThreadId, reason: 'in_flight' });
        return;
      }
      if (now - (lastChatReadClearAtRef.current[dedupeKey] || 0) < 10000) {
        console.info('[PLAYER_CHAT_READ] debounced', { chatType, threadId: cleanThreadId, reason: 'recent' });
        return;
      }
      lastChatReadClearAtRef.current[dedupeKey] = now;

      console.info(
        trigger === 'open'
          ? '[PLAYER_CHAT_READ] openThreadClearUnread'
          : '[PLAYER_CHAT_READ] inputFocusClearUnread',
        {
        chatType,
        threadId: cleanThreadId,
        playerUid: selfUid || getCachedSessionUser()?.uid || null,
        }
      );
      setChatList((previous) => {
        const current = previous[cleanThreadId];
        if (!current?.unread) {
          return previous;
        }
        console.info('[PLAYER_CHAT_READ] optimisticClear', {
          chatType,
          threadId: cleanThreadId,
        });
        return {
          ...previous,
          [cleanThreadId]: {
            ...current,
            unread: 0,
          },
        };
      });

      chatReadInFlightRef.current.add(dedupeKey);
      void markPlayerChatThreadRead(cleanThreadId, chatType)
        .then((payload) => {
          console.info('[PLAYER_CHAT_READ] persisted', {
            chatType,
            threadId: cleanThreadId,
            conversationId: payload.conversationId || null,
            unreadCount: payload.unreadCount ?? null,
          });
        })
        .catch((error) => {
          console.warn('[PLAYER_CHAT_READ] persisted', {
            chatType,
            threadId: cleanThreadId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          chatReadInFlightRef.current.delete(dedupeKey);
        });
    },
    [selfUid]
  );

  useEffect(() => {
    if (!isPlayerRole) {
      setSelfUid('');
      return;
    }
    let cancelled = false;
    void (async () => {
      const cached = getCachedSessionUser();
      const sessionUser =
        cached?.role === 'player'
          ? cached
          : await getSessionUserOnce().catch(() => null);
      if (cancelled) {
        return;
      }
      if (sessionUser?.role === 'player' && sessionUser.uid) {
        setSelfUid(sessionUser.uid);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlayerRole]);

  useEffect(() => {
    if (mountLoggedRef.current) {
      return;
    }
    mountLoggedRef.current = true;

    void (async () => {
      const cached = getCachedSessionUser();
      const sessionUser =
        cached?.role === 'player'
          ? cached
          : await getSessionUserOnce().catch(() => null);
      const appSessionId = getLocalAppSessionId();
      const playerSessionId = getLocalPlayerSessionId();
      logChatPageMount({
        role: sessionUser?.role ?? cached?.role ?? null,
        uid: sessionUser?.uid ?? cached?.uid ?? null,
        hasAppSessionId: Boolean(appSessionId),
        hasPlayerSessionId: Boolean(playerSessionId),
        appSessionIdPrefix: appSessionId ? appSessionId.slice(0, 8) : null,
        playerSessionIdPrefix: playerSessionId ? playerSessionId.slice(0, 8) : null,
      });
    })();
  }, []);

  useEffect(() => {
    if (!isPlayerRole) {
      setAllPlayers([]);
      setChatLoading(false);
      return;
    }

    let cancelled = false;

    const loadSqlPlayers = async () => {
      setChatLoading(true);
      setChatLoadError('');
      try {
        const players = await fetchPlayerChatBootstrap(playerSearchTerm);
        if (!cancelled) {
          setAllPlayers(players);
        }
      } catch (error) {
        if (!cancelled) {
          setAllPlayers([]);
          setChatLoadError(error instanceof Error ? error.message : 'Failed to load player chat.');
        }
      } finally {
        if (!cancelled) {
          setChatLoading(false);
        }
      }
    };

    const skipFirestore = shouldSkipClientFirestore({
      file: 'app/player/chat/page.tsx',
      feature: 'player_chat_active_players_list',
      collection: 'users',
      operation: 'onSnapshot',
    });

    if (skipFirestore) {
      void loadSqlPlayers();
      return () => {
        cancelled = true;
      };
    }

    void ensureReferralFriendLinks();
    setChatLoading(false);
    return () => {
      cancelled = true;
    };
  }, [isPlayerRole, selfUid, playerSearchTerm]);

  const onlineByUid = usePresenceOnlineMap(allPlayers.map((p) => p.uid), {
    requirePlayerRole: true,
  });

  useEffect(() => {
    if (!isPlayerRole) {
      return;
    }
    return listenDirectChatList((rows) => {
      const next: Record<string, { unread: number; muted: boolean; last: string }> = {};
      rows.forEach((row) => {
        next[row.otherUid] = {
          unread: row.unreadCount,
          muted: row.muted,
          last: row.lastMessage,
        };
      });
      console.info('[PLAYER_CHAT_READ] refreshReadStateLoaded', {
        threadCount: Object.keys(next).length,
      });
      setChatList(next);
    });
  }, [isPlayerRole]);

  useEffect(() => {
    if (!isPlayerRole) {
      return;
    }
    return listenFriendLinks((links: FriendLink[]) => {
      const next: Record<string, { status: 'pending' | 'accepted'; requestedByUid: string }> = {};
      links.forEach((link) => {
        const otherUid = (link.participants || []).find((uid) => uid !== selfUid) || '';
        if (!otherUid) return;
        next[otherUid] = {
          status: link.status,
          requestedByUid: link.requestedByUid,
        };
      });
      setFriendByUid(next);
    });
  }, [isPlayerRole, selfUid]);

  useEffect(() => {
    if (!isPlayerRole || !selectedPeer) return;
    const unsubMessages = listenDirectMessages(selectedPeer.uid, (list) => {
      const visible = filterVisibleDirectMessages(list, selfUid);
      const rendered = trimRenderedPlayerMessages(visible);
      logChatMessageLimitApplied(visible.length, rendered.length);
      setRawMessageCount(list.length);
      if (nearBottomRef.current) {
        pendingScrollToBottomRef.current = true;
      } else {
        setShowNewMessagePill(true);
      }
      setMessages(rendered);
      console.info('[CHAT_MESSAGES_FILTERED]', {
        conversationId: [selfUid, selectedPeer.uid].sort().join('__'),
        currentUid: selfUid,
        participantIds: [selfUid, selectedPeer.uid],
        totalMessages: list.length,
        visibleMessages: visible.length,
        renderedMessages: rendered.length,
        messageIds: list.slice(0, 5).map((message) => message.id),
        visibleMessageIds: visible.slice(0, 5).map((message) => message.id),
        messages: list.slice(0, 5).map((message) => ({
          id: message.id,
          senderUid: message.senderUid,
          text: message.text,
          deletedForAll: message.deletedForEveryone,
          deletedForUsers: message.deletedFor,
          createdAt: message.createdAt?.toDate?.()?.toISOString?.() || null,
        })),
      });
      console.info('[CHAT_DELETE_UI_REFRESH]', {
        reason: 'live_messages_refresh',
        peerUid: selectedPeer.uid,
        visibleCount: rendered.length,
        rawCount: list.length,
      });
    });
    const unsubTyping = listenDirectTyping(selectedPeer.uid, setTyping);
    markThreadReadOnPlayerChatFocus(selectedPeer.uid, 'player_player', 'open');
    return () => {
      unsubMessages();
      unsubTyping();
      void setDirectTyping(selectedPeer.uid, false);
    };
  }, [isPlayerRole, markThreadReadOnPlayerChatFocus, selectedPeer, selfUid]);

  useEffect(() => {
    setShowRewardPanel(false);
    setRewardNotice('');
    setShowNewMessagePill(false);
    nearBottomRef.current = true;
    pendingScrollToBottomRef.current = true;
  }, [selectedPeer?.uid]);

  const rewardFeePreview = useMemo(() => {
    const amt = Math.max(0, Math.floor(Number(rewardAmount || 0)));
    if (!amt) return null;
    return computeRewardCoinsAfterFee(amt);
  }, [rewardAmount]);

  const selectedMuted = selectedPeer ? Boolean(chatList[selectedPeer.uid]?.muted) : false;
  const selectedFriend = selectedPeer ? friendByUid[selectedPeer.uid] : null;
  const selectedPeerDisplayName = selectedPeer
    ? getPublicDisplayName(selectedPeer.username)
    : '';
  const filteredPlayers = useMemo(() => {
    const term = playerSearchTerm.trim().toLowerCase();
    if (!term) {
      return allPlayers;
    }
    return allPlayers.filter((p) => p.username.toLowerCase().includes(term));
  }, [allPlayers, playerSearchTerm]);
  const messagesHiddenByFilters = rawMessageCount > 0 && messages.length === 0;

  useEffect(() => {
    if (!selectedPeer) return;
    if (pendingScrollToBottomRef.current) {
      pendingScrollToBottomRef.current = false;
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      setShowNewMessagePill(false);
      nearBottomRef.current = true;
    }
    const el = messagesScrollRef.current;
    if (process.env.NODE_ENV === 'development' && el) {
      console.info('[CHAT_RENDER_STATE]', {
        chatType: 'player_player',
        messageCount: rawMessageCount,
        renderedCount: messages.length,
        containerHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        isOverflowing: el.scrollHeight > el.clientHeight,
      });
    }
    console.info('[CHAT_MESSAGES_RENDER]', {
      conversationId: [selfUid, selectedPeer.uid].sort().join('__'),
      currentUid: selfUid,
      participantIds: [selfUid, selectedPeer.uid],
      totalMessages: rawMessageCount,
      visibleMessages: messages.length,
      messageIds: messages.slice(0, 5).map((message) => message.id),
    });
  }, [messages, rawMessageCount, selectedPeer, selfUid]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    await sendCurrentTextMessage(newMessage);
  }

  async function sendCurrentTextMessage(value: string) {
    if (!selectedPeer || sending) return;
    const body = value.trim();
    if (!body) return;
    setSending(true);
    setMessageError('');
    setFailedDraft('');
    try {
      await sendDirectTextMessage(selectedPeer.uid, body, {
        replyToMessageId: replyTarget?.id || '',
        replyToText: replyTarget?.text || '',
      });
      setNewMessage('');
      setReplyTarget(null);
      await markDirectConversationSeen(selectedPeer.uid);
    } catch (error) {
      setFailedDraft(body);
      setMessageError(error instanceof Error ? error.message : 'Failed to send message.');
    } finally {
      setSending(false);
    }
  }

  async function onSendImage(file: File) {
    if (!selectedPeer) return;
    setSending(true);
    setMessageError('');
    try {
      await sendDirectImageMessage(selectedPeer.uid, file, {
        replyToMessageId: replyTarget?.id || '',
        replyToText: replyTarget?.text || '',
      });
      setReplyTarget(null);
    } catch (error) {
      setMessageError(error instanceof Error ? error.message : 'Failed to send image.');
    } finally {
      setSending(false);
    }
  }

  async function onSearch() {
    if (!selectedPeer) return;
    const results = await searchDirectMessages(selectedPeer.uid, searchTerm);
    setSearchResults(filterVisibleDirectMessages(results, selfUid));
  }

  async function onDeleteForMe(message: PlayerChatMessage) {
    if (!selectedPeer) return;
    setMessageError('');
    console.info('[CHAT_DELETE_REQUEST]', {
      messageId: message.id,
      senderUid: message.senderUid,
      peerUid: selectedPeer.uid,
      scope: 'for_me',
      source: 'ui',
    });
    try {
      await deleteDirectMessageForMe(selectedPeer.uid, message.id);
      setMessages((current) => current.filter((item) => item.id !== message.id).slice(-PLAYER_CHAT_RENDER_MAX));
      setChatList((current) => ({
        ...current,
        [selectedPeer.uid]: {
          ...(current[selectedPeer.uid] || { unread: 0, muted: false, last: '' }),
          last:
            current[selectedPeer.uid]?.last &&
            message.text &&
            current[selectedPeer.uid]?.last === message.text
              ? ''
              : current[selectedPeer.uid]?.last || '',
        },
      }));
      console.info('[CHAT_DELETE_UI_REFRESH]', {
        reason: 'delete_for_me_local_state',
        messageId: message.id,
        peerUid: selectedPeer.uid,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to delete message.';
      console.error('[CHAT_DELETE_FOR_ME]', {
        messageId: message.id,
        senderUid: message.senderUid,
        error: reason,
      });
      setMessageError(reason);
    }
  }

  async function onDeleteForEveryone(message: PlayerChatMessage) {
    if (!selectedPeer) return;
    setMessageError('');
    console.info('[CHAT_DELETE_REQUEST]', {
      messageId: message.id,
      senderUid: message.senderUid,
      peerUid: selectedPeer.uid,
      scope: 'for_everyone',
      source: 'ui',
    });
    try {
      await deleteDirectMessageForEveryone(selectedPeer.uid, message.id);
      setMessages((current) =>
        current
          .map((item) =>
            item.id === message.id
              ? {
                  ...item,
                  text: '',
                  imageUrl: '',
                  imagePublicId: '',
                  deletedForEveryone: true,
                }
              : item
          )
          .slice(-PLAYER_CHAT_RENDER_MAX)
      );
      setChatList((current) => ({
        ...current,
        [selectedPeer.uid]: {
          ...(current[selectedPeer.uid] || { unread: 0, muted: false, last: '' }),
          last: 'Message deleted',
        },
      }));
      console.info('[CHAT_DELETE_UI_REFRESH]', {
        reason: 'delete_for_everyone_local_state',
        messageId: message.id,
        peerUid: selectedPeer.uid,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to delete message.';
      console.error('[CHAT_DELETE_FOR_ALL]', {
        messageId: message.id,
        senderUid: message.senderUid,
        error: reason,
      });
      setMessageError(reason);
    }
  }

  async function onAddFriendByReferralCode(e: React.FormEvent) {
    e.preventDefault();
    const code = referralInput.trim().toUpperCase();
    if (!code) {
      setReferralError('Please enter a referral code.');
      return;
    }

    setReferralLoading(true);
    setReferralError('');
    setReferralNotice('');
    try {
      const matched = await sendFriendRequestByReferralCode(code);
      setReferralNotice(`Friend request sent to ${getPublicDisplayName(matched.username)}.`);
      setReferralInput('');
    } catch (error) {
      setReferralError(error instanceof Error ? error.message : 'Failed to add friend.');
    } finally {
      setReferralLoading(false);
    }
  }

  async function onRewardCoins() {
    if (!selectedPeer || rewardBusy || rewardInFlightRef.current) return;
    const amount = Math.max(0, Math.floor(Number(rewardAmount || 0)));
    if (amount <= 0) {
      setMessageError('Reward amount must be at least 1 coin.');
      return;
    }
    rewardInFlightRef.current = true;
    setRewardBusy(true);
    setMessageError('');
    setRewardNotice('');
    rewardRequestIdRef.current =
      rewardRequestIdRef.current ||
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const result = await rewardCoinsToPlayer(selectedPeer.uid, amount, {
        idempotencyKey: rewardRequestIdRef.current,
      });
      try {
        await sendDirectTextMessage(
          selectedPeer.uid,
          `Received ${result.recipientCoins} coin reward.`
        );
      } catch (noticeError) {
        console.warn('[PLAYER_CHAT_REWARD_NOTICE_FAILED]', noticeError);
      }
      setRewardNotice(`Reward sent. Friend receives ${result.recipientCoins} coins.`);
      setShowRewardPanel(false);
    } catch (error) {
      setMessageError(error instanceof Error ? error.message : 'Failed to reward coins.');
    } finally {
      rewardRequestIdRef.current = null;
      rewardInFlightRef.current = false;
      setRewardBusy(false);
    }
  }

  return (
    <>
    <main className="min-h-[100dvh] overflow-hidden bg-[#050509] text-white">
        <div className="mx-auto flex h-[100dvh] min-h-0 w-full max-w-7xl flex-col gap-4 overflow-hidden p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:flex-row lg:gap-5 lg:p-5">
          <aside className="fire-panel fire-violet flex max-h-[34dvh] min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-2xl border border-violet-400/30 bg-black/50 p-4 lg:max-h-none lg:w-[320px]">
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-xl font-black tracking-wide text-amber-200">Player Chat</h1>
              <Link
                href="/player"
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-amber-100/80 hover:bg-white/10"
              >
                Back
              </Link>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowAddByReferralModal(true);
                setReferralError('');
                setReferralNotice('');
              }}
              className="mb-3 w-full rounded-xl border border-emerald-300/40 bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/25"
            >
              Add Friend
            </button>
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-emerald-300/80">
              All players
            </p>
            <input
              value={playerSearchTerm}
              onChange={(e) => setPlayerSearchTerm(e.target.value)}
              placeholder="Search players"
              className="mb-3 w-full rounded-xl border border-white/15 bg-black/45 px-3 py-2 text-sm"
            />
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain pr-1">
              {chatLoading ? (
                <p className="rounded-xl border border-white/10 bg-black/40 p-3 text-sm text-amber-100/60">
                  Chat loading...
                </p>
              ) : filteredPlayers.length === 0 ? (
                <p className="rounded-xl border border-white/10 bg-black/40 p-3 text-sm text-amber-100/60">
                  {chatLoadError || 'No matching players found.'}
                </p>
              ) : (
                filteredPlayers.map((p) => {
                  const stat = chatList[p.uid];
                  const selected = selectedPeer?.uid === p.uid;
                  const publicName = getPublicDisplayName(p.username);
                  return (
                    <button
                      key={p.uid}
                      type="button"
                      onClick={() => {
                        setSelectedPeer(p);
                        setSearchResults([]);
                      }}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        selected
                          ? 'border-amber-400/60 bg-amber-500/15'
                          : 'border-white/10 bg-black/30 hover:border-violet-300/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-semibold">
                          <span
                            className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${
                              onlineByUid[p.uid] ? 'bg-emerald-400' : 'bg-neutral-600'
                            }`}
                          />
                          {publicName}
                        </span>
                        {stat?.unread ? (
                          <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-black">
                            {stat.unread > 9 ? '9+' : stat.unread}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-amber-100/50">
                        {stat?.last || 'Start chatting'}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="fire-panel fire-orange flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-amber-400/20 bg-black/45">
            {!selectedPeer ? (
              <div className="m-auto p-8 text-center text-amber-100/65">
                <p className="text-4xl">💬</p>
                <p className="mt-2 text-sm">Pick an online player to start a private chat.</p>
              </div>
            ) : (
              <>
                <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 p-3">
                  <h2 className="mr-auto text-lg font-bold">{selectedPeerDisplayName}</h2>
                  {typing ? <span className="text-xs text-emerald-300">typing...</span> : null}
                  {!selectedFriend ? (
                    <button
                      type="button"
                      onClick={() => void sendFriendRequest(selectedPeer.uid)}
                      className="rounded-lg border border-emerald-300/40 bg-emerald-500/15 px-2.5 py-1 text-xs hover:bg-emerald-500/25"
                    >
                      Add Friend
                    </button>
                  ) : selectedFriend.status === 'pending' && selectedFriend.requestedByUid !== selfUid ? (
                    <button
                      type="button"
                      onClick={() => void acceptFriendRequest(selectedPeer.uid)}
                      className="rounded-lg border border-amber-300/40 bg-amber-500/15 px-2.5 py-1 text-xs hover:bg-amber-500/25"
                    >
                      Accept Request
                    </button>
                  ) : (
                    <span className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-emerald-300">
                      {selectedFriend.status === 'accepted' ? 'Friends' : 'Request Sent'}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void setDirectConversationMuted(selectedPeer.uid, !selectedMuted)
                    }
                    className="rounded-lg border border-white/20 px-2.5 py-1 text-xs hover:bg-white/10"
                  >
                    {selectedMuted ? 'Unmute' : 'Mute'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRewardPanel((v) => !v)}
                    className="rounded-lg border border-amber-300/40 bg-amber-500/15 px-2.5 py-1 text-xs hover:bg-amber-500/25"
                  >
                    Reward Coins
                  </button>
                </header>
                {rewardNotice ? (
                  <p className="border-b border-white/10 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                    {rewardNotice}
                  </p>
                ) : null}
                {showRewardPanel ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 bg-black/20 p-2">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={rewardAmount}
                      onChange={(e) => setRewardAmount(e.target.value)}
                      className="w-32 rounded-lg border border-white/15 bg-black/45 px-3 py-2 text-sm"
                      placeholder="Coins"
                    />
                    <button
                      type="button"
                      onClick={() => void onRewardCoins()}
                      disabled={rewardBusy}
                      className="rounded-lg border border-amber-300/40 bg-amber-500/15 px-3 py-2 text-xs hover:bg-amber-500/25 disabled:opacity-60"
                    >
                      {rewardBusy ? 'Sending…' : 'Send Reward'}
                    </button>
                    {rewardFeePreview !== null ? (
                      <span className="text-[11px] text-amber-100/65">
                        Friend gets {rewardFeePreview.recipientCoins}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex shrink-0 items-center gap-2 border-b border-white/10 p-2">
                  <input
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search messages"
                    className="flex-1 rounded-lg border border-white/15 bg-black/45 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void onSearch()}
                    className="rounded-lg border border-white/20 px-3 py-2 text-xs hover:bg-white/10"
                  >
                    Search
                  </button>
                </div>

                {searchResults.length > 0 ? (
                  <div className="max-h-28 shrink-0 space-y-1 overflow-y-auto overflow-x-hidden border-b border-white/10 bg-black/25 p-2">
                    {searchResults.map((m) => (
                      <div key={m.id} className="rounded bg-white/5 px-2 py-1 text-xs text-amber-100/80">
                        {m.text || 'Image'} · {toTime(m.createdAt)}
                      </div>
                    ))}
                  </div>
                ) : null}

                <div
                  ref={messagesScrollRef}
                  onScroll={(event) => {
                    const nearBottom = isNearScrollBottom(event.currentTarget);
                    nearBottomRef.current = nearBottom;
                    if (nearBottom) {
                      setShowNewMessagePill(false);
                    }
                    if (process.env.NODE_ENV === 'development') {
                      console.info('[CHAT_AUTOSCROLL]', {
                        chatType: 'player_player',
                        reason: 'user_scroll',
                        nearBottom,
                      });
                    }
                  }}
                  className="relative min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain p-3"
                >
                  {chatLoading ? (
                    <div className="pt-14 text-center text-sm text-amber-100/45">
                      Chat loading...
                    </div>
                  ) : messagesHiddenByFilters ? (
                    <div className="pt-14 text-center text-sm text-red-200">
                      Messages loaded but hidden by filters
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="pt-14 text-center text-sm text-amber-100/45">
                      No messages yet.
                    </div>
                  ) : (
                    messages.map((m) => {
                      const mine = m.senderUid === selfUid;
                      const delivered = mine && (m.deliveredTo || []).length > 1;
                      const seen = mine && (m.seenBy || []).length > 1;
                      const status = seen ? 'Seen' : delivered ? 'Delivered' : 'Sent';
                      return (
                        <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[85%] overflow-hidden rounded-2xl px-3 py-2 text-sm [overflow-wrap:anywhere] ${
                              mine
                                ? 'bg-gradient-to-br from-amber-200 to-amber-300 text-black'
                                : 'border border-white/10 bg-white/5 text-white'
                            }`}
                          >
                            {m.replyToText ? (
                              <p className="mb-1 rounded-lg bg-black/10 px-2 py-1 text-xs opacity-80">
                                Reply: {m.replyToText}
                              </p>
                            ) : null}
                            {m.deletedForEveryone ? (
                              <p className="italic opacity-70">Message deleted</p>
                            ) : (
                              <>
                                {m.imageUrl ? (
                                  <img src={m.imageUrl} alt="" loading="lazy" className="mb-2 max-h-48 max-w-full rounded-lg object-contain" />
                                ) : null}
                                {m.text ? <p className="break-words [overflow-wrap:anywhere]">{m.text}</p> : null}
                              </>
                            )}
                            <div className="mt-1 flex items-center justify-between gap-3 text-[10px] opacity-70">
                              <span>{toTime(m.createdAt)}</span>
                              {mine ? <span>{status}</span> : null}
                            </div>
                            <div className="mt-1 flex gap-2 text-[10px]">
                              <button type="button" onClick={() => setReplyTarget(m)} className="underline">
                                Reply
                              </button>
                              <button
                                type="button"
                                onClick={() => void onDeleteForMe(m)}
                                className="underline"
                              >
                                Delete for me
                              </button>
                              {mine ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void onDeleteForEveryone(m)
                                  }
                                  className="underline"
                                >
                                  Delete for all
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                  {showNewMessagePill ? (
                    <button
                      type="button"
                      onClick={() => {
                        pendingScrollToBottomRef.current = false;
                        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
                        nearBottomRef.current = true;
                        setShowNewMessagePill(false);
                        if (process.env.NODE_ENV === 'development') {
                          console.info('[CHAT_AUTOSCROLL]', {
                            chatType: 'player_player',
                            reason: 'new_message_pill',
                            nearBottom: false,
                          });
                        }
                      }}
                      className="sticky bottom-2 z-10 mx-auto block rounded-full border border-amber-300/50 bg-amber-300 px-3 py-1 text-xs font-bold text-black shadow-lg shadow-black/30"
                    >
                      New message
                    </button>
                  ) : null}
                </div>

                {replyTarget ? (
                  <div className="shrink-0 border-t border-white/10 bg-black/20 px-3 py-2 text-xs text-amber-100/75">
                    Replying to: {replyTarget.text || 'Image'}
                    <button
                      type="button"
                      onClick={() => setReplyTarget(null)}
                      className="ml-3 underline"
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}

                <form
                  onSubmit={onSend}
                  onClick={() => markThreadReadOnPlayerChatFocus(selectedPeer.uid, 'player_player', 'input')}
                  className="shrink-0 border-t border-white/10 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
                >
                  <div className="mb-2 flex gap-2">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          void onSendImage(file);
                        }
                        e.target.value = '';
                      }}
                      className="text-xs"
                    />
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={newMessage}
                      onFocus={() =>
                        markThreadReadOnPlayerChatFocus(selectedPeer.uid, 'player_player', 'input')
                      }
                      onClick={() =>
                        markThreadReadOnPlayerChatFocus(selectedPeer.uid, 'player_player', 'input')
                      }
                      onChange={(e) => {
                        setNewMessage(e.target.value);
                        void setDirectTyping(selectedPeer.uid, e.target.value.trim().length > 0);
                      }}
                      placeholder="Type a message"
                      className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/55 px-3 py-2 text-sm [overflow-wrap:anywhere]"
                    />
                    <button
                      type="submit"
                      disabled={sending || !newMessage.trim()}
                      className="rounded-xl bg-amber-300 px-4 py-2 text-sm font-bold text-black disabled:opacity-50"
                    >
                      {sending ? 'Sending...' : 'Send'}
                    </button>
                  </div>
                  {messageError ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-300">
                      <span>{messageError}</span>
                      {failedDraft ? (
                        <button
                          type="button"
                          onClick={() => void sendCurrentTextMessage(failedDraft)}
                          className="rounded-full border border-red-300/40 px-2 py-0.5 font-semibold text-red-100 hover:bg-red-500/15"
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </form>
              </>
            )}
          </section>
        </div>
      </main>
      {showAddByReferralModal ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setShowAddByReferralModal(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-emerald-300/30 bg-[#090a12] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-emerald-200">Add Friend by Referral Code</h3>
            <p className="mt-1 text-xs text-emerald-100/60">
              Enter a player referral code to send a friend request.
            </p>
            <form onSubmit={onAddFriendByReferralCode} className="mt-3 space-y-3">
              <input
                value={referralInput}
                onChange={(e) => setReferralInput(e.target.value.toUpperCase())}
                placeholder="Referral code"
                className="w-full rounded-xl border border-white/15 bg-black/50 px-3 py-2 text-sm uppercase tracking-wide text-white"
              />
              {referralError ? <p className="text-xs text-red-300">{referralError}</p> : null}
              {referralNotice ? <p className="text-xs text-emerald-300">{referralNotice}</p> : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddByReferralModal(false)}
                  className="flex-1 rounded-xl border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={referralLoading}
                  className="flex-1 rounded-xl bg-emerald-300 px-3 py-2 text-sm font-bold text-black disabled:opacity-60"
                >
                  {referralLoading ? 'Adding...' : 'Send Request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
