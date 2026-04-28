import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { uploadImageToCloudinary } from '@/lib/cloudinary/uploadImage';

export type FirestoreChatMessage = {
  id: string;
  text?: string;
  imageUrl?: string;
  imagePublicId?: string;
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

/** Newest messages for the live window (realtime listener + pagination). */
export const CHAT_RECENT_MESSAGE_WINDOW = 50;
/** How many older messages to fetch per "Load previous" action. */
export const CHAT_OLDER_MESSAGE_PAGE_SIZE = 50;

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
  const uploaded = await uploadImageToCloudinary(file);

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
    imageUrl: uploaded.url,
    imagePublicId: uploaded.publicId,
    senderUid: currentUser.uid,
    receiverUid,
    createdAt: serverTimestamp(),
  });
}

function compareChatMessagesChronological(
  a: FirestoreChatMessage,
  b: FirestoreChatMessage
) {
  const ta = a.createdAt?.toMillis?.() ?? a.createdAt?.toDate?.()?.getTime?.() ?? 0;
  const tb = b.createdAt?.toMillis?.() ?? b.createdAt?.toDate?.()?.getTime?.() ?? 0;
  if (ta !== tb) {
    return ta - tb;
  }
  return a.id.localeCompare(b.id);
}

export type ListenToMessagesOptions = {
  /**
   * Max recent messages to keep in the live snapshot (newest only).
   * Omit or set very high to mirror legacy “load all” (not recommended).
   */
  limit?: number;
};

/**
 * Listens to the newest slice of a conversation in realtime (default last 50).
 * Older messages are loaded via `fetchMessagesOlderThan`.
 */
export function listenToMessages(
  receiverUid: string,
  callback: (messages: FirestoreChatMessage[]) => void,
  options?: ListenToMessagesOptions
) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    callback([]);
    return () => {};
  }

  const conversationId = getConversationId(currentUser.uid, receiverUid);
  const collectionRef = collection(
    db,
    'conversations',
    conversationId,
    'messages'
  );
  const windowLimit = options?.limit;

  const messagesQuery =
    windowLimit == null
      ? query(collectionRef, orderBy('createdAt', 'asc'))
      : query(
          collectionRef,
          orderBy('createdAt', 'desc'),
          limit(Math.max(1, windowLimit))
        );

  return onSnapshot(messagesQuery, (snapshot) => {
    const messages = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...(docSnap.data() as Omit<FirestoreChatMessage, 'id'>),
    }));

    if (windowLimit == null) {
      messages.sort(compareChatMessagesChronological);
    } else {
      messages.reverse();
    }

    callback(messages);
  });
}

/**
 * Fetches messages older than a given message (the chronologically first one currently shown).
 * Returns messages sorted ascending (oldest first in the batch).
 */
export async function fetchMessagesOlderThan(
  receiverUid: string,
  olderThanMessageId: string,
  pageSize: number = CHAT_OLDER_MESSAGE_PAGE_SIZE
): Promise<FirestoreChatMessage[]> {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    return [];
  }

  const conversationId = getConversationId(currentUser.uid, receiverUid);
  const collectionRef = collection(
    db,
    'conversations',
    conversationId,
    'messages'
  );
  const cursorRef = doc(
    db,
    'conversations',
    conversationId,
    'messages',
    olderThanMessageId
  );
  const cursorSnap = await getDoc(cursorRef);

  if (!cursorSnap.exists()) {
    return [];
  }

  const size = Math.max(1, pageSize);
  const olderQuery = query(
    collectionRef,
    orderBy('createdAt', 'desc'),
    startAfter(cursorSnap),
    limit(size)
  );

  const snap = await getDocs(olderQuery);
  const batch = snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<FirestoreChatMessage, 'id'>),
  }));
  batch.reverse();
  return batch;
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
    where(`unreadCounts.${currentUser.uid}`, '>', 0)
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
    where(`unreadCounts.${currentUser.uid}`, '>', 0)
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
