import {
  addDoc,
  collection,
  doc,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';

import { auth, db, storage } from '@/lib/firebase/client';

export type FirestoreChatMessage = {
  id: string;
  text?: string;
  imageUrl?: string;
  imagePath?: string;
  type?: 'text' | 'image';
  senderUid: string;
  receiverUid: string;
  createdAt?: any;
};

export type UnreadConversationNotice = {
  uid: string;
  unreadCount: number;
  lastMessage?: string;
};

export function getConversationId(uid1: string, uid2: string) {
  return [uid1, uid2].sort().join('_');
}

export async function sendChatMessage(receiverUid: string, text: string) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const cleanText = text.trim();

  if (!cleanText) {
    return;
  }

  const conversationId = getConversationId(currentUser.uid, receiverUid);
  const conversationRef = doc(db, 'conversations', conversationId);

  await setDoc(
    conversationRef,
    {
      participants: [currentUser.uid, receiverUid],
      lastMessage: cleanText,
      lastMessageSenderUid: currentUser.uid,
      updatedAt: serverTimestamp(),
      unreadCounts: {
        [receiverUid]: increment(1),
        [currentUser.uid]: 0,
      },
    },
    { merge: true }
  );

  await addDoc(collection(db, 'conversations', conversationId, 'messages'), {
    type: 'text',
    text: cleanText,
    senderUid: currentUser.uid,
    receiverUid,
    createdAt: serverTimestamp(),
  });
}

export async function sendImageMessage(receiverUid: string, file: File) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are allowed.');
  }

  const maxSizeMb = 5;
  const maxSizeBytes = maxSizeMb * 1024 * 1024;

  if (file.size > maxSizeBytes) {
    throw new Error(`Image must be smaller than ${maxSizeMb}MB.`);
  }

  const conversationId = getConversationId(currentUser.uid, receiverUid);
  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const imagePath = `chat-images/${conversationId}/${Date.now()}-${safeFileName}`;

  const imageRef = ref(storage, imagePath);

  await uploadBytes(imageRef, file);

  const imageUrl = await getDownloadURL(imageRef);

  const conversationRef = doc(db, 'conversations', conversationId);

  await setDoc(
    conversationRef,
    {
      participants: [currentUser.uid, receiverUid],
      lastMessage: '📷 Photo',
      lastMessageSenderUid: currentUser.uid,
      updatedAt: serverTimestamp(),
      unreadCounts: {
        [receiverUid]: increment(1),
        [currentUser.uid]: 0,
      },
    },
    { merge: true }
  );

  await addDoc(collection(db, 'conversations', conversationId, 'messages'), {
    type: 'image',
    imageUrl,
    imagePath,
    senderUid: currentUser.uid,
    receiverUid,
    createdAt: serverTimestamp(),
  });
}

export function listenToMessages(
  receiverUid: string,
  callback: (messages: FirestoreChatMessage[]) => void
) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    callback([]);
    return () => {};
  }

  const conversationId = getConversationId(currentUser.uid, receiverUid);

  const messagesQuery = query(
    collection(db, 'conversations', conversationId, 'messages'),
    orderBy('createdAt', 'asc')
  );

  return onSnapshot(messagesQuery, (snapshot) => {
    const messages = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...(docSnap.data() as Omit<FirestoreChatMessage, 'id'>),
    }));

    callback(messages);
  });
}

export async function markConversationAsRead(receiverUid: string) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    return;
  }

  const conversationId = getConversationId(currentUser.uid, receiverUid);

  await setDoc(
    doc(db, 'conversations', conversationId),
    {
      unreadCounts: {
        [currentUser.uid]: 0,
      },
    },
    { merge: true }
  );
}

export function listenToUnreadCounts(
  callback: (unreadCounts: Record<string, number>) => void
) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    callback({});
    return () => {};
  }

  const conversationsQuery = query(
    collection(db, 'conversations'),
    where('participants', 'array-contains', currentUser.uid)
  );

  return onSnapshot(conversationsQuery, (snapshot) => {
    const counts: Record<string, number> = {};

    snapshot.docs.forEach((docSnap) => {
      const data = docSnap.data() as any;

      const otherUid = data.participants?.find(
        (uid: string) => uid !== currentUser.uid
      );

      if (!otherUid) {
        return;
      }

      counts[otherUid] = data.unreadCounts?.[currentUser.uid] || 0;
    });

    callback(counts);
  });
}

export function listenToUnreadNotices(
  callback: (notices: UnreadConversationNotice[]) => void
) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    callback([]);
    return () => {};
  }

  const conversationsQuery = query(
    collection(db, 'conversations'),
    where('participants', 'array-contains', currentUser.uid)
  );

  return onSnapshot(conversationsQuery, (snapshot) => {
    const notices: UnreadConversationNotice[] = [];

    snapshot.docs.forEach((docSnap) => {
      const data = docSnap.data() as any;

      const unreadCount = data.unreadCounts?.[currentUser.uid] || 0;

      if (unreadCount <= 0) {
        return;
      }

      const otherUid = data.participants?.find(
        (uid: string) => uid !== currentUser.uid
      );

      if (!otherUid) {
        return;
      }

      notices.push({
        uid: otherUid,
        unreadCount,
        lastMessage: data.lastMessage || '',
      });
    });

    callback(notices);
  });
}