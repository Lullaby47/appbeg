'use client';

import ReachOutView from '@/components/admin/ReachOutView';

type Props = Record<string, any>;

export default function Agents(props: Props) {
  const {
    agentOnlineByUid,
    agents,
    agentsScrollRef,
    handleAgentSelect,
    handleClearImage,
    handleImageSelect,
    handleSendMessage,
    imagePreview,
    messages,
    newMessage,
    onMessageFocus,
    pagedAgentChat,
    selectedAgent,
    sendingImage,
    setNewMessage,
    unreadCounts,
  } = props;

  return (

              <div className="flex min-h-0 min-w-0 max-h-[min(78dvh,calc(100dvh-11rem))] flex-1 flex-col overflow-hidden sm:max-h-[min(82dvh,calc(100dvh-10rem))]">
                <ReachOutView
                  chatUsers={agents}
                  selectedChatUser={selectedAgent}
                  messages={messages}
                  newMessage={newMessage}
                  unreadCounts={unreadCounts}
                  imagePreview={imagePreview}
                  sendingImage={sendingImage}
                  messagesScrollRef={agentsScrollRef}
                  hasMoreOlderMessages={pagedAgentChat.hasMoreOlder}
                  loadingOlderMessages={pagedAgentChat.loadingOlder}
                  onLoadOlderMessages={pagedAgentChat.loadOlder}
                  onSelectUser={handleAgentSelect}
                  onMessageChange={setNewMessage}
                  onMessageFocus={onMessageFocus}
                  onSendMessage={handleSendMessage}
                  onImageSelect={handleImageSelect}
                  onClearImage={handleClearImage}
                  onlineByUid={agentOnlineByUid}
                />
              </div>
  );
}
