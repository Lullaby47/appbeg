'use client';

import '@/styles/player-fire.css';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  collection,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';

import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { auth, db } from '@/lib/firebase/client';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import {
  acceptFriendRequest,
  deleteDirectMessageForEveryone,
  deleteDirectMessageForMe,
  ensureReferralFriendLinks,
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
  sendDirectImageMessage,
  sendDirectTextMessage,
  setDirectConversationMuted,
  setDirectTyping,
} from '@/features/messages/playerChat';

type PlayerUserDoc = {
  uid?: string;
  username?: string;
  role?: string;
  status?: string;
};

function toTime(value: { toMillis?: () => number } | null | undefined) {
  const ms = value?.toMillis?.() ?? 0;
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function PlayerChatPage() {
  const [allPlayers, setAllPlayers] = useState<PlayerPeer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<PlayerPeer | null>(null);
  const [messages, setMessages] = useState<PlayerChatMessage[]>([]);
  const [typing, setTyping] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [messageError, setMessageError] = useState('');
  const [replyTarget, setReplyTarget] = useState<PlayerChatMessage | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<PlayerChatMessage[]>([]);
  const [chatList, setChatList] = useState<Record<string, { unread: number; muted: boolean; last: string }>>({});
  const [friendByUid, setFriendByUid] = useState<
    Record<string, { status: 'pending' | 'accepted'; requestedByUid: string }>
  >({});

  useEffect(() => {
    void ensureReferralFriendLinks();
    const q = query(
      collection(db, 'users'),
      where('role', '==', 'player'),
      where('status', '==', 'active')
    );
    return onSnapshot(q, (snap) => {
      const me = auth.currentUser?.uid || '';
      const list = snap.docs
        .map((d) => {
          const data = d.data() as PlayerUserDoc;
          return {
            uid: d.id,
            username: String(data.username || '').trim() || 'Player',
          };
        })
        .filter((p) => p.uid !== me);
      setAllPlayers(list);
    });
  }, []);

  const onlineByUid = usePresenceOnlineMap(allPlayers.map((p) => p.uid));

  useEffect(() => {
    return listenDirectChatList((rows) => {
      const next: Record<string, { unread: number; muted: boolean; last: string }> = {};
      rows.forEach((row) => {
        next[row.otherUid] = {
          unread: row.unreadCount,
          muted: row.muted,
          last: row.lastMessage,
        };
      });
      setChatList(next);
    });
  }, []);

  useEffect(() => {
    return listenFriendLinks((links: FriendLink[]) => {
      const selfUid = auth.currentUser?.uid || '';
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
  }, []);

  useEffect(() => {
    if (!selectedPeer) return;
    const unsubMessages = listenDirectMessages(selectedPeer.uid, (list) => {
      const selfUid = auth.currentUser?.uid || '';
      const visible = list.filter((m) => !Array.isArray(m.deletedFor) || !m.deletedFor.includes(selfUid));
      setMessages(visible);
    });
    const unsubTyping = listenDirectTyping(selectedPeer.uid, setTyping);
    void markDirectConversationSeen(selectedPeer.uid);
    return () => {
      unsubMessages();
      unsubTyping();
      void setDirectTyping(selectedPeer.uid, false);
    };
  }, [selectedPeer]);

  const selectedMuted = selectedPeer ? Boolean(chatList[selectedPeer.uid]?.muted) : false;
  const selectedFriend = selectedPeer ? friendByUid[selectedPeer.uid] : null;
  const selfUid = auth.currentUser?.uid || '';

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPeer || sending) return;
    const body = newMessage.trim();
    if (!body) return;
    setSending(true);
    setMessageError('');
    try {
      await sendDirectTextMessage(selectedPeer.uid, body, {
        replyToMessageId: replyTarget?.id || '',
        replyToText: replyTarget?.text || '',
      });
      setNewMessage('');
      setReplyTarget(null);
      await markDirectConversationSeen(selectedPeer.uid);
    } catch (error) {
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
    setSearchResults(results);
  }

  return (
    <ProtectedRoute allowedRoles={['player']}>
      <main className="min-h-screen bg-[#050509] text-white">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 lg:h-screen lg:flex-row lg:gap-5 lg:p-5">
          <aside className="fire-panel fire-violet w-full rounded-2xl border border-violet-400/30 bg-black/50 p-4 lg:w-[320px] lg:shrink-0">
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-xl font-black tracking-wide text-amber-200">Player Chat</h1>
              <Link
                href="/player"
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-amber-100/80 hover:bg-white/10"
              >
                Back
              </Link>
            </div>
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-emerald-300/80">
              All players
            </p>
            <div className="max-h-[32dvh] space-y-2 overflow-y-auto pr-1 lg:max-h-[70dvh]">
              {allPlayers.length === 0 ? (
                <p className="rounded-xl border border-white/10 bg-black/40 p-3 text-sm text-amber-100/60">
                  No players available right now.
                </p>
              ) : (
                allPlayers.map((p) => {
                  const stat = chatList[p.uid];
                  const selected = selectedPeer?.uid === p.uid;
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
                          {p.username}
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

          <section className="fire-panel fire-orange flex min-h-[60dvh] flex-1 flex-col rounded-2xl border border-amber-400/20 bg-black/45">
            {!selectedPeer ? (
              <div className="m-auto p-8 text-center text-amber-100/65">
                <p className="text-4xl">💬</p>
                <p className="mt-2 text-sm">Pick an online player to start a private chat.</p>
              </div>
            ) : (
              <>
                <header className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">
                  <h2 className="mr-auto text-lg font-bold">{selectedPeer.username}</h2>
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
                </header>

                <div className="flex items-center gap-2 border-b border-white/10 p-2">
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
                  <div className="max-h-28 space-y-1 overflow-y-auto border-b border-white/10 bg-black/25 p-2">
                    {searchResults.map((m) => (
                      <div key={m.id} className="rounded bg-white/5 px-2 py-1 text-xs text-amber-100/80">
                        {m.text || 'Image'} · {toTime(m.createdAt)}
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="flex-1 space-y-2 overflow-y-auto p-3">
                  {messages.length === 0 ? (
                    <div className="pt-14 text-center text-sm text-amber-100/45">
                      No messages yet.
                    </div>
                  ) : (
                    messages.map((m) => {
                      const mine = m.senderUid === auth.currentUser?.uid;
                      const delivered = mine && (m.deliveredTo || []).length > 1;
                      const seen = mine && (m.seenBy || []).length > 1;
                      const status = seen ? 'Seen' : delivered ? 'Delivered' : 'Sent';
                      return (
                        <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
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
                              <p className="italic opacity-70">This message was deleted.</p>
                            ) : (
                              <>
                                {m.imageUrl ? (
                                  <img src={m.imageUrl} alt="" className="mb-2 max-h-48 rounded-lg" />
                                ) : null}
                                {m.text ? <p className="break-words">{m.text}</p> : null}
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
                                onClick={() => void deleteDirectMessageForMe(selectedPeer.uid, m.id)}
                                className="underline"
                              >
                                Delete for me
                              </button>
                              {mine ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void deleteDirectMessageForEveryone(selectedPeer.uid, m.id)
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
                </div>

                {replyTarget ? (
                  <div className="border-t border-white/10 bg-black/20 px-3 py-2 text-xs text-amber-100/75">
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

                <form onSubmit={onSend} className="border-t border-white/10 p-3">
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
                      onChange={(e) => {
                        setNewMessage(e.target.value);
                        void setDirectTyping(selectedPeer.uid, e.target.value.trim().length > 0);
                      }}
                      placeholder="Type a message"
                      className="flex-1 rounded-xl border border-white/15 bg-black/55 px-3 py-2 text-sm"
                    />
                    <button
                      type="submit"
                      disabled={sending || !newMessage.trim()}
                      className="rounded-xl bg-amber-300 px-4 py-2 text-sm font-bold text-black disabled:opacity-50"
                    >
                      Send
                    </button>
                  </div>
                  {messageError ? (
                    <p className="mt-2 text-xs text-red-300">{messageError}</p>
                  ) : null}
                </form>
              </>
            )}
          </section>
        </div>
      </main>
    </ProtectedRoute>
  );
}
