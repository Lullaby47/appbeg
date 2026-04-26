export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  text: string;
  createdAt: Date;
  read: boolean;
};

export type Conversation = {
  id: string;
  participantIds: string[];
  participantRoles: string[];
  lastMessage: string;
  lastMessageAt: Date;
};