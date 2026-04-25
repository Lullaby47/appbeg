'use client';

import { useRef, useState } from 'react';
import { ChatMessage } from './types';

const EMOJIS = ['😀', '😂', '😍', '😎', '👍', '🙏', '🔥', '❤️', '🎉', '😢'];

interface BaseUser {
  id: string;
  uid: string;
  username: string;
  role: string;
  status: string;
  isOnline?: boolean;
  lastSeen?: any;
}

interface Props<T extends BaseUser> {
  title: string;
  emptyText: string;
  selectText: string;
  deleteTitle: string;
  deleteMessage: string;
  users: T[];
  selectedUser: T | null;
  deleteTarget: T | null;
  loadingList: boolean;
  loading: boolean;
  unreadCounts?: Record<string, number>;
  onSelectUser: (user: T) => void;
  onSetDeleteTarget: (user: T | null) => void;
  onDelete: () => void;

  onStartChat?: (user: T) => void;
  chatUser?: T | null;
  messages?: ChatMessage[];
  newMessage?: string;
  imagePreview?: string | null;
  sendingImage?: boolean;
  onMessageChange?: (value: string) => void;
  onSendMessage?: (e: React.FormEvent) => void;
  onImageSelect?: (file: File) => void;
  onClearImage?: () => void;
}

export default function UserManagementView<T extends BaseUser>({
  title,
  emptyText,
  selectText,
  deleteTitle,
  deleteMessage,
  users,
  selectedUser,
  deleteTarget,
  loadingList,
  loading,
  unreadCounts = {},
  onSelectUser,
  onSetDeleteTarget,
  onDelete,

  onStartChat,
  chatUser,
  messages = [],
  newMessage = '',
  imagePreview = null,
  sendingImage = false,
  onMessageChange,
  onSendMessage,
  onImageSelect,
  onClearImage,
}: Props<T>) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showEmojis, setShowEmojis] = useState(false);
  const [openImageUrl, setOpenImageUrl] = useState<string | null>(null);

  function getOnlineLabel(user: T) {
    return user.isOnline ? 'Online' : 'Offline';
  }

  function formatTime(date: Date) {
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function handleEmojiClick(emoji: string) {
    onMessageChange?.(`${newMessage}${emoji}`);
    setShowEmojis(false);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];

    if (!file || !onImageSelect) return;

    onImageSelect(file);
    e.target.value = '';
  }

  const isChatOpen =
    selectedUser && chatUser && selectedUser.uid === chatUser.uid;

  return (
    <div className="grid h-[calc(100vh-48px)] grid-cols-[320px_1fr] gap-6">
      <div className="rounded-2xl border border-white/10 bg-neutral-900/60 p-4">
        <h2 className="mb-4 text-xl font-bold">{title}</h2>

        {loadingList ? (
          <p className="text-sm text-neutral-400">Loading...</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-neutral-400">{emptyText}</p>
        ) : (
          <div className="space-y-2">
            {users.map((user) => {
              const unreadCount = unreadCounts[user.uid] || 0;

              return (
                <button
                  key={user.id}
                  onClick={() => {
                    onSelectUser(user);
                    onSetDeleteTarget(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-xl p-4 text-left transition ${
                    selectedUser?.id === user.id
                      ? 'bg-white text-black'
                      : unreadCount > 0
                        ? 'bg-red-500/10 text-white ring-1 ring-red-500/30 hover:bg-red-500/20'
                        : 'bg-white/5 text-white hover:bg-white/10'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-semibold">{user.username}</p>

                      {unreadCount > 0 && (
                        <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
                          {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                      )}
                    </div>

                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          user.isOnline ? 'bg-green-500' : 'bg-neutral-500'
                        }`}
                      />

                      <p
                        className={`text-xs ${
                          selectedUser?.id === user.id
                            ? 'text-black/60'
                            : unreadCount > 0
                              ? 'text-red-200'
                              : 'text-neutral-500'
                        }`}
                      >
                        {getOnlineLabel(user)}
                      </p>
                    </div>
                  </div>

                  {unreadCount > 0 && (
                    <span className="rounded-full bg-red-500 px-2 py-1 text-xs font-bold text-white">
                      New
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col rounded-2xl border border-white/10 bg-white/5 p-6">
        {!selectedUser ? (
          <div className="flex h-full items-center justify-center text-neutral-500">
            {selectText}
          </div>
        ) : (
          <>
            <div>
              <div className="mb-6 flex justify-end gap-3">
                {onStartChat && (
                  <button
                    onClick={() => onStartChat(selectedUser)}
                    className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200"
                  >
                    {isChatOpen ? 'Close Chat' : 'Chat'}
                  </button>
                )}

                <button
                  onClick={() => onSetDeleteTarget(selectedUser)}
                  className="rounded-xl bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-400 hover:bg-red-500/30"
                >
                  Delete
                </button>
              </div>

              <h2 className="text-4xl font-bold capitalize">
                {selectedUser.username}
              </h2>

              <div className="mt-4 space-y-3">
                <p className="text-sm text-neutral-400">
                  Role: <span className="text-white">{selectedUser.role}</span>
                </p>

                <p className="text-sm text-neutral-400">
                  Status:{' '}
                  <span className="text-white">{selectedUser.status}</span>
                </p>

                <div className="flex items-center gap-2 text-sm text-neutral-400">
                  <span>Online Status:</span>

                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      selectedUser.isOnline ? 'bg-green-500' : 'bg-neutral-500'
                    }`}
                  />

                  <span className="text-white">
                    {getOnlineLabel(selectedUser)}
                  </span>
                </div>
              </div>
            </div>

            {isChatOpen && (
              <div className="mt-8 flex min-h-[420px] flex-1 flex-col rounded-2xl border border-white/10 bg-neutral-950/60">
                <div className="border-b border-white/10 p-4">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-700 font-bold">
                        {selectedUser.username.charAt(0).toUpperCase()}
                      </div>

                      <div
                        className={`absolute bottom-0 right-0 h-3 w-3 rounded-full ring-2 ring-neutral-950 ${
                          selectedUser.isOnline
                            ? 'bg-green-500'
                            : 'bg-neutral-500'
                        }`}
                      />
                    </div>

                    <div>
                      <h3 className="font-semibold">
                        Chat with {selectedUser.username}
                      </h3>
                      <p className="text-xs text-neutral-400">
                        {getOnlineLabel(selectedUser)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                  {messages.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                      No messages yet. Start the conversation.
                    </div>
                  ) : (
                    messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex ${
                          msg.sender === 'admin'
                            ? 'justify-end'
                            : 'justify-start'
                        }`}
                      >
                        <div
                          className={`max-w-[70%] rounded-xl px-4 py-2 ${
                            msg.sender === 'admin'
                              ? 'bg-white text-black'
                              : 'bg-neutral-800 text-white'
                          }`}
                        >
                          {msg.imageUrl && (
                            <button
                              type="button"
                              onClick={() => setOpenImageUrl(msg.imageUrl || null)}
                              className="mb-2 block overflow-hidden rounded-xl"
                            >
                              <img
                                src={msg.imageUrl}
                                alt="Chat image"
                                className="max-h-72 max-w-full rounded-xl object-cover"
                              />
                            </button>
                          )}

                          {msg.text && (
                            <p className="break-words text-sm">{msg.text}</p>
                          )}

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

                  {imagePreview && (
                    <div className="flex justify-end">
                      <div className="max-w-[70%] rounded-xl bg-white p-2 text-black">
                        <div className="relative">
                          <img
                            src={imagePreview}
                            alt="Preview"
                            className="max-h-60 rounded-xl object-cover"
                          />

                          {onClearImage && (
                            <button
                              type="button"
                              onClick={onClearImage}
                              className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-bold text-white"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-black/60">
                          Image ready to send
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {onSendMessage && onMessageChange && (
                  <form
                    onSubmit={onSendMessage}
                    className="border-t border-white/10 p-4"
                  >
                    {showEmojis && (
                      <div className="mb-3 flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-neutral-900 p-3">
                        {EMOJIS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => handleEmojiClick(emoji)}
                            className="rounded-xl bg-white/5 px-3 py-2 text-xl hover:bg-white/10"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="hidden"
                    />

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowEmojis((value) => !value)}
                        className="rounded-xl bg-neutral-900 px-3 py-2 text-lg hover:bg-neutral-800"
                        title="Emoji"
                      >
                        😊
                      </button>

                      {onImageSelect && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="rounded-xl bg-neutral-900 px-3 py-2 text-lg hover:bg-neutral-800"
                          title="Send image"
                        >
                          📷
                        </button>
                      )}

                      <input
                        type="text"
                        value={newMessage}
                        onChange={(e) => onMessageChange(e.target.value)}
                        placeholder="Type a message..."
                        className="flex-1 rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-white/30"
                      />

                      <button
                        type="submit"
                        disabled={sendingImage || (!newMessage.trim() && !imagePreview)}
                        className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {sendingImage ? 'Sending...' : 'Send'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {deleteTarget && (
        <div
          onClick={() => onSetDeleteTarget(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl border border-red-400 bg-red-600 p-6 text-white shadow-2xl"
          >
            <h3 className="text-xl font-bold">{deleteTitle}</h3>

            <p className="mt-2 text-sm text-red-100">
              {deleteMessage} {deleteTarget.username}?
            </p>

            <div className="mt-6 flex gap-3">
              <button
                onClick={onDelete}
                disabled={loading}
                className="flex-1 rounded-xl bg-white px-4 py-3 font-bold text-red-600 disabled:opacity-60"
              >
                {loading ? 'Deleting...' : 'Yes'}
              </button>

              <button
                onClick={() => onSetDeleteTarget(null)}
                className="flex-1 rounded-xl bg-black/20 px-4 py-3 font-semibold text-white"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {openImageUrl && (
        <div
          onClick={() => setOpenImageUrl(null)}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
        >
          <img
            src={openImageUrl}
            alt="Full chat image"
            className="max-h-[90vh] max-w-[90vw] rounded-2xl object-contain"
          />
        </div>
      )}
    </div>
  );
}