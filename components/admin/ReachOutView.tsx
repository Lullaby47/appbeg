'use client';

import { useEffect, useRef, useState } from 'react';
import { AdminUser, ChatMessage } from './types';
import { OnlineIndicator } from '@/components/presence/OnlineIndicator';

const EMOJIS = ['😀', '😂', '😍', '😎', '👍', '🙏', '🔥', '❤️', '🎉', '😢'];

function getOnlineStatusLabel(
  onlineByUid: Record<string, boolean>,
  user: AdminUser
) {
  if (user.uid in onlineByUid) {
    return onlineByUid[user.uid] ? 'Online' : 'Offline';
  }
  return 'Offline';
}

interface Props {
  chatUsers: AdminUser[];
  selectedChatUser: AdminUser | null;
  messages: ChatMessage[];
  newMessage: string;
  unreadCounts?: Record<string, number>;
  imagePreview?: string | null;
  sendingImage?: boolean;
  /** For scroll-anchoring when loading older messages (optional). */
  messagesScrollRef?: React.RefObject<HTMLDivElement | null>;
  hasMoreOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  onSelectUser: (user: AdminUser) => void;
  onMessageChange: (value: string) => void;
  onSendMessage: (e: React.FormEvent) => void;
  onImageSelect?: (file: File) => void;
  onClearImage?: () => void;
  /** Real-time: uid was active recently (for green dot). */
  onlineByUid?: Record<string, boolean>;
}

export default function ReachOutView({
  chatUsers,
  selectedChatUser,
  messages,
  newMessage,
  unreadCounts = {},
  imagePreview = null,
  sendingImage = false,
  onSelectUser,
  onMessageChange,
  onSendMessage,
  onImageSelect,
  onClearImage,
  messagesScrollRef,
  hasMoreOlderMessages = false,
  loadingOlderMessages = false,
  onLoadOlderMessages,
  onlineByUid = {},
}: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastScrolledIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showEmojis, setShowEmojis] = useState(false);

  useEffect(() => {
    lastScrolledIdRef.current = null;
  }, [selectedChatUser?.id]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    const last = messages[messages.length - 1].id;
    if (lastScrolledIdRef.current === last) {
      return;
    }
    lastScrolledIdRef.current = last;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const totalUnread = Object.values(unreadCounts).reduce(
    (total, count) => total + count,
    0
  );

  const getMaskedDisplayName = (user: AdminUser) => {
    const role = String(user.role || '').toLowerCase();
    if (role === 'admin' || role === 'staff' || role === 'coadmin') {
      return 'Support Team';
    }
    return user.username;
  };

  const getAvatarLetter = (user: AdminUser) => {
    const name = getMaskedDisplayName(user).trim();
    return (name.charAt(0) || '?').toUpperCase();
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-hidden lg:grid lg:max-h-full lg:min-h-0 lg:grid-cols-[minmax(0,300px)_1fr] lg:grid-rows-1 lg:gap-6">
      <div className="flex min-h-0 max-h-[min(36dvh,320px)] shrink-0 flex-col overflow-hidden rounded-2xl border border-violet-500/25 bg-gradient-to-b from-violet-950/80 to-black/60 p-3 shadow-lg shadow-violet-500/10 backdrop-blur-md sm:max-h-[min(40dvh,360px)] lg:max-h-full lg:min-h-0 lg:p-4">
        <div className="mb-3 flex shrink-0 items-center justify-between lg:mb-4">
          <h2 className="text-lg font-black tracking-tight text-amber-100 lg:text-xl">
            💬 Agents
          </h2>

          {totalUnread > 0 && (
            <span className="rounded-full bg-red-500 px-2.5 py-1 text-xs font-bold text-white">
              {totalUnread} unread
            </span>
          )}
        </div>

        {chatUsers.length === 0 ? (
          <p className="text-sm text-violet-200/60">No agents available.</p>
        ) : (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain pr-1">
            {chatUsers.map((user) => {
              const unreadCount = unreadCounts[user.uid] || 0;

              return (
                <button
                  key={user.id}
                  onClick={() => onSelectUser(user)}
                  className={`flex w-full items-center gap-3 rounded-xl p-4 text-left transition ${
                    selectedChatUser?.id === user.id
                      ? 'bg-white text-black'
                      : unreadCount > 0
                        ? 'bg-red-500/10 text-white ring-1 ring-red-500/30 hover:bg-red-500/20'
                        : 'bg-white/5 text-white hover:bg-white/10'
                  }`}
                >
                  <div className="relative">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-700 font-bold">
                      {getAvatarLetter(user)}
                    </div>

                    {unreadCount > 0 && (
                      <div className="absolute -right-1 -top-1 z-[1] flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-bold text-white">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </div>
                    )}

                    <div className="absolute bottom-0 right-0 z-[1]">
                      <OnlineIndicator
                        online={Boolean(onlineByUid[user.uid])}
                        sizeClassName="h-2.5 w-2.5"
                        ringClassName="ring-neutral-800"
                      />
                    </div>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold">
                        {getMaskedDisplayName(user)}
                      </p>

                      {unreadCount > 0 && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            selectedChatUser?.id === user.id
                              ? 'bg-red-500 text-white'
                              : 'bg-red-500 text-white'
                          }`}
                        >
                          NEW
                        </span>
                      )}
                    </div>

                    <p
                      className={`text-xs ${
                        selectedChatUser?.id === user.id
                          ? 'text-black/60'
                          : unreadCount > 0
                            ? 'text-red-200'
                            : 'text-neutral-500'
                      }`}
                    >
                      {getOnlineStatusLabel(onlineByUid, user)} · {user.role}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-amber-500/20 bg-black/40 shadow-xl shadow-amber-500/5 backdrop-blur-md">
        {!selectedChatUser ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-amber-100/50">
            <p>
              <span className="text-2xl">✨</span>
              <br />
              Pick an agent to open your VIP messenger
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-white/10 bg-black/30 p-3 lg:p-4">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-700 font-bold">
                    {getAvatarLetter(selectedChatUser)}
                  </div>
                  <div className="absolute bottom-0 right-0 z-[1]">
                    <OnlineIndicator
                      online={Boolean(onlineByUid[selectedChatUser.uid])}
                      sizeClassName="h-3 w-3"
                    />
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold">
                    {getMaskedDisplayName(selectedChatUser)}
                  </h3>
                  <p className="text-xs text-neutral-400">
                    {getOnlineStatusLabel(onlineByUid, selectedChatUser)} ·{' '}
                    {selectedChatUser.role}
                  </p>
                </div>
              </div>
            </div>

            <div
              ref={messagesScrollRef}
              className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden overscroll-contain p-3 lg:p-4"
            >
              {onLoadOlderMessages && hasMoreOlderMessages ? (
                <div className="sticky top-0 z-10 -mt-1 mb-2 flex justify-center">
                  <button
                    type="button"
                    disabled={loadingOlderMessages}
                    onClick={() => onLoadOlderMessages()}
                    className="rounded-full border border-amber-500/30 bg-black/50 px-4 py-2 text-xs font-semibold text-amber-100/90 shadow-sm backdrop-blur-sm hover:border-amber-400/50 hover:bg-black/60 disabled:opacity-50"
                  >
                    {loadingOlderMessages
                      ? 'Loading…'
                      : 'Load previous messages'}
                  </button>
                </div>
              ) : null}
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                  No messages yet. Start the conversation.
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.sender === 'admin' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2 shadow-md sm:max-w-[70%] ${
                        msg.sender === 'admin'
                          ? 'bg-gradient-to-br from-amber-100 to-amber-200 text-black'
                          : 'border border-white/10 bg-neutral-800/90 text-white'
                      }`}
                    >
                      {msg.imageUrl ? (
                        <img
                          src={msg.imageUrl}
                          alt=""
                          className="mb-2 max-h-48 w-full rounded-lg object-cover"
                        />
                      ) : null}
                      {msg.text ? (
                        <p className="break-words text-sm">{msg.text}</p>
                      ) : null}
                      <p
                        className={`mt-1 text-xs ${
                          msg.sender === 'admin'
                            ? 'text-black/60'
                            : 'text-neutral-500'
                        }`}
                      >
                        {formatTime(msg.timestamp)}
                      </p>
                    </div>
                  </div>
                ))
              )}

              <div ref={messagesEndRef} />
            </div>

            <form
              onSubmit={onSendMessage}
              className="shrink-0 border-t border-white/10 bg-black/40 p-3 lg:p-4"
            >
              {imagePreview && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-white/5 p-3">
                  <img
                    src={imagePreview}
                    alt="preview"
                    className="h-16 w-16 rounded object-cover"
                  />
                  <button
                    type="button"
                    onClick={onClearImage}
                    className="ml-auto text-xs text-neutral-400 hover:text-white"
                  >
                    Remove
                  </button>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => onMessageChange(e.target.value)}
                  placeholder="Message…"
                  className="min-w-0 flex-1 rounded-xl border border-amber-500/20 bg-neutral-900/90 px-4 py-3 text-base text-white placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                />

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowEmojis(!showEmojis)}
                    className="rounded-xl bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
                  >
                    😊
                  </button>

                  {showEmojis && (
                    <div className="absolute bottom-full right-0 mb-2 grid w-48 grid-cols-5 gap-1 rounded-lg bg-neutral-800 p-2 shadow-lg">
                      {EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => {
                            onMessageChange(`${newMessage}${emoji}`);
                            setShowEmojis(false);
                          }}
                          className="rounded bg-neutral-700 p-2 text-lg hover:bg-neutral-600"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file && onImageSelect) {
                      onImageSelect(file);
                    }
                    e.target.value = '';
                  }}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-xl bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
                >
                  📷
                </button>

                <button
                  type="submit"
                  disabled={(!newMessage.trim() && !imagePreview) || sendingImage}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sendingImage ? '...' : 'Send'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}