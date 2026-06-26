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
    onBackToAgents,
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
  const isChatOpen = Boolean(selectedAgent);

  return (

              <div
                className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
                  isChatOpen
                    ? 'h-[calc(100dvh_-_12.5rem_-_env(safe-area-inset-bottom))] max-h-[calc(100dvh_-_12.5rem_-_env(safe-area-inset-bottom))] lg:h-[calc(100dvh_-_7rem)] lg:max-h-[calc(100dvh_-_7rem)]'
                    : 'max-h-[min(78dvh,calc(100dvh-11rem))] sm:max-h-[min(82dvh,calc(100dvh-10rem))]'
                }`}
              >
                <ReachOutView
                  chatUsers={agents}
                  selectedChatUser={selectedAgent}
                  messages={messages}
                  newMessage={newMessage}
                  unreadCounts={unreadCounts}
                  imagePreview={imagePreview}
                  sendingImage={sendingImage}
                  messagesScrollRef={agentsScrollRef}
                  hasMoreOlderMessages={false}
                  loadingOlderMessages={pagedAgentChat.loadingOlder}
                  onLoadOlderMessages={undefined}
                  disableLoadOlder
                  playerLightweightMode
                  onSelectUser={handleAgentSelect}
                  onMessageChange={setNewMessage}
                  onMessageFocus={onMessageFocus}
                  onSendMessage={handleSendMessage}
                  onImageSelect={handleImageSelect}
                  onClearImage={handleClearImage}
                  onBackToList={onBackToAgents}
                  onlineByUid={agentOnlineByUid}
                />
              </div>
  );
}
