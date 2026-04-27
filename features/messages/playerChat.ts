'use client';

import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { uploadImageToCloudinary } from '@/lib/cloudinary/uploadImage';

const DIRECT_CONVERSATIONS = 'playerConversations';
const GROUP_CONVERSATIONS = 'playerGroupConversations';
const GLOBAL_GROUP_ID = 'global';
const RATE_LIMIT_MS = 900;

export type PlayerPeer = {
  uid: string;
  username: string;
};

export type PlayerChatMessage = {
  id: string;
  senderUid: string;
  text?: string;
  imageUrl?: string;
  imagePublicId?: string;
  type: 'text' | 'image';
  createdAt?: Timestamp;
  replyToMessageId?: string;
  replyToText?: string;
  deletedForEveryone?: boolean;
  deletedFor?: string[];
  deliveredTo?: string[];
  seenBy?: string[];
};

export type PlayerChatListItem = {
  conversationId: string;
  otherUid: string;
  lastMessage: string;
  lastMessageAt?: Timestamp;
  unreadCount: number;
  muted: boolean;
};

export type FriendLink = {
  id: string;
  participants: string[];
  status: 'pending' | 'accepted';
  requestedByUid: string;
};

type ConversationDoc = {
  participants?: string[];
  lastMessage?: string;
  lastMessageAt?: Timestamp;
  unreadCounts?: Record<string, number>;
  mutedBy?: string[];
};

function assertAuthUid() {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Not authenticated.');
  }
  return uid;
}

function cleanText(text: string) {
  return String(text || '').trim();
}

function tokenizeText(text: string) {
  const t = cleanText(text).toLowerCase();
  if (!t) return [];
  return Array.from(new Set(t.split(/\s+/).filter((part) => part.length >= 2))).slice(0, 25);
}

export function getDirectConversationId(uidA: string, uidB: string) {
  return [uidA, uidB].sort().join('__');
}

function getFriendLinkId(uidA: string, uidB: string) {
  return [uidA, uidB].sort().join('__');
}

async function withRateLimit(conversationId: string, senderUid: string) {
  const ref = doc(db, DIRECT_CONVERSATIONS, conversationId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const nowMs = Date.now();
    const lastSent =
      snap.exists() && snap.data().lastSentAtByUid?.[senderUid]?.toMillis
        ? snap.data().lastSentAtByUid[senderUid].toMillis()
        : 0;
    if (nowMs - lastSent < RATE_LIMIT_MS) {
      throw new Error('You are sending too fast. Please wait a moment.');
    }
    tx.set(
      ref,
      {
        lastSentAtByUid: {
          [senderUid]: serverTimestamp(),
        },
      },
      { merge: true }
    );
  });
}

export async function sendDirectTextMessage(
  receiverUid: string,
  text: string,
  options?: { replyToMessageId?: string; replyToText?: string }
) {
  const senderUid = assertAuthUid();
  const body = cleanText(text);
  if (!body) return;

  const conversationId = getDirectConversationId(senderUid, receiverUid);
  await withRateLimit(conversationId, senderUid);
  const conversationRef = doc(db, DIRECT_CONVERSATIONS, conversationId);

  await setDoc(
    conversationRef,
    {
      participants: [senderUid, receiverUid],
      type: 'direct',
      lastMessage: body,
      lastMessageAt: serverTimestamp(),
      lastMessageSenderUid: senderUid,
      updatedAt: serverTimestamp(),
      unreadCounts: {
        [receiverUid]: increment(1),
        [senderUid]: 0,
      },
      mutedBy: [],
    },
    { merge: true }
  );

  await addDoc(collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'), {
    senderUid,
    receiverUid,
    text: body,
    type: 'text',
    replyToMessageId: options?.replyToMessageId || '',
    replyToText: cleanText(options?.replyToText || ''),
    searchTokens: tokenizeText(body),
    deliveredTo: [senderUid],
    seenBy: [senderUid],
    deletedFor: [],
    createdAt: serverTimestamp(),
  });
}

export async function sendDirectImageMessage(
  receiverUid: string,
  file: File,
  options?: { replyToMessageId?: string; replyToText?: string }
) {
  const senderUid = assertAuthUid();
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are allowed.');
  }
  const maxSizeBytes = 5 * 1024 * 1024;
  if (file.size > maxSizeBytes) {
    throw new Error('Image must be smaller than 5MB.');
  }

  const conversationId = getDirectConversationId(senderUid, receiverUid);
  await withRateLimit(conversationId, senderUid);
  const uploaded = await uploadImageToCloudinary(file);
  const conversationRef = doc(db, DIRECT_CONVERSATIONS, conversationId);

  await setDoc(
    conversationRef,
    {
      participants: [senderUid, receiverUid],
      type: 'direct',
      lastMessage: '📷 Photo',
      lastMessageAt: serverTimestamp(),
      lastMessageSenderUid: senderUid,
      updatedAt: serverTimestamp(),
      unreadCounts: {
        [receiverUid]: increment(1),
        [senderUid]: 0,
      },
      mutedBy: [],
    },
    { merge: true }
  );

  await addDoc(collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'), {
    senderUid,
    receiverUid,
    type: 'image',
    imageUrl: uploaded.url,
    imagePublicId: uploaded.publicId,
    replyToMessageId: options?.replyToMessageId || '',
    replyToText: cleanText(options?.replyToText || ''),
    searchTokens: [],
    deliveredTo: [senderUid],
    seenBy: [senderUid],
    deletedFor: [],
    createdAt: serverTimestamp(),
  });
}

export function listenDirectMessages(
  otherUid: string,
  onNext: (messages: PlayerChatMessage[]) => void
) {
  const selfUid = auth.currentUser?.uid;
  if (!selfUid) {
    onNext([]);
    return () => {};
  }
  const conversationId = getDirectConversationId(selfUid, otherUid);
  const q = query(
    collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(250)
  );
  return onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PlayerChatMessage, 'id'>) }));
    onNext(list);
  });
}

export async function markDirectConversationSeen(otherUid: string) {
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);

  await setDoc(
    doc(db, DIRECT_CONVERSATIONS, conversationId),
    {
      unreadCounts: { [selfUid]: 0 },
      seenAtByUid: { [selfUid]: serverTimestamp() },
      deliveredAtByUid: { [selfUid]: serverTimestamp() },
    },
    { merge: true }
  );

  const msgSnap = await getDocs(
    query(
      collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'),
      orderBy('createdAt', 'desc'),
      limit(60)
    )
  );
  if (msgSnap.empty) return;
  const batch = writeBatch(db);
  msgSnap.docs.forEach((m) => {
    const data = m.data() as PlayerChatMessage;
    if (data.senderUid === selfUid) return;
    batch.update(m.ref, {
      deliveredTo: arrayUnion(selfUid),
      seenBy: arrayUnion(selfUid),
    });
  });
  await batch.commit();
}

export function listenDirectTyping(
  otherUid: string,
  onNext: (typing: boolean) => void
) {
  const selfUid = auth.currentUser?.uid;
  if (!selfUid) {
    onNext(false);
    return () => {};
  }
  const conversationId = getDirectConversationId(selfUid, otherUid);
  return onSnapshot(doc(db, DIRECT_CONVERSATIONS, conversationId), (snap) => {
    if (!snap.exists()) {
      onNext(false);
      return;
    }
    const typingAt = snap.data().typingAtByUid?.[otherUid] as Timestamp | undefined;
    const isTyping = !!typingAt && Date.now() - typingAt.toMillis() < 5000;
    onNext(isTyping);
  });
}

export async function setDirectTyping(otherUid: string, typing: boolean) {
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  await setDoc(
    doc(db, DIRECT_CONVERSATIONS, conversationId),
    {
      participants: [selfUid, otherUid],
      type: 'direct',
      typingAtByUid: {
        [selfUid]: typing ? serverTimestamp() : null,
      },
    },
    { merge: true }
  );
}

export function listenDirectChatList(onNext: (rows: PlayerChatListItem[]) => void) {
  const selfUid = auth.currentUser?.uid;
  if (!selfUid) {
    onNext([]);
    return () => {};
  }
  const q = query(
    collection(db, DIRECT_CONVERSATIONS),
    where('participants', 'array-contains', selfUid),
    orderBy('updatedAt', 'desc'),
    limit(100)
  );
  return onSnapshot(q, (snap) => {
    const rows: PlayerChatListItem[] = snap.docs.map((d) => {
      const data = d.data() as ConversationDoc;
      const participants = Array.isArray(data.participants) ? data.participants : [];
      const otherUid = participants.find((uid: string) => uid !== selfUid) || '';
      return {
        conversationId: d.id,
        otherUid,
        lastMessage: String(data.lastMessage || ''),
        lastMessageAt: data.lastMessageAt as Timestamp | undefined,
        unreadCount: Number(data.unreadCounts?.[selfUid] || 0),
        muted: Array.isArray(data.mutedBy) ? data.mutedBy.includes(selfUid) : false,
      };
    });
    onNext(rows.filter((r) => !!r.otherUid));
  });
}

export async function setDirectConversationMuted(otherUid: string, muted: boolean) {
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  await setDoc(
    doc(db, DIRECT_CONVERSATIONS, conversationId),
    {
      participants: [selfUid, otherUid],
      type: 'direct',
      mutedBy: muted ? arrayUnion(selfUid) : arrayRemove(selfUid),
    },
    { merge: true }
  );
}

export async function deleteDirectMessageForMe(otherUid: string, messageId: string) {
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  await updateDoc(doc(db, DIRECT_CONVERSATIONS, conversationId, 'messages', messageId), {
    deletedFor: arrayUnion(selfUid),
  });
}

export async function deleteDirectMessageForEveryone(otherUid: string, messageId: string) {
  const selfUid = assertAuthUid();
  const conversationId = getDirectConversationId(selfUid, otherUid);
  const messageRef = doc(db, DIRECT_CONVERSATIONS, conversationId, 'messages', messageId);
  const snap = await getDoc(messageRef);
  if (!snap.exists()) return;
  const data = snap.data() as PlayerChatMessage;
  if (data.senderUid !== selfUid) {
    throw new Error('Only sender can delete for everyone.');
  }
  await updateDoc(messageRef, {
    text: '',
    imageUrl: '',
    imagePublicId: '',
    deletedForEveryone: true,
    searchTokens: [],
  });
}

export async function searchDirectMessages(otherUid: string, keyword: string) {
  const selfUid = assertAuthUid();
  const token = cleanText(keyword).toLowerCase();
  if (token.length < 2) {
    return [] as PlayerChatMessage[];
  }
  const conversationId = getDirectConversationId(selfUid, otherUid);
  const q = query(
    collection(db, DIRECT_CONVERSATIONS, conversationId, 'messages'),
    where('searchTokens', 'array-contains', token),
    orderBy('createdAt', 'desc'),
    limit(40)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PlayerChatMessage, 'id'>) }));
}

export async function sendGlobalGroupTextMessage(text: string) {
  const senderUid = assertAuthUid();
  const body = cleanText(text);
  if (!body) return;
  await addDoc(collection(db, GROUP_CONVERSATIONS, GLOBAL_GROUP_ID, 'messages'), {
    senderUid,
    text: body,
    type: 'text',
    searchTokens: tokenizeText(body),
    createdAt: serverTimestamp(),
  });
  await setDoc(
    doc(db, GROUP_CONVERSATIONS, GLOBAL_GROUP_ID),
    {
      updatedAt: serverTimestamp(),
      lastMessage: body,
      lastMessageAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export function listenGlobalGroupMessages(onNext: (messages: PlayerChatMessage[]) => void) {
  const q = query(
    collection(db, GROUP_CONVERSATIONS, GLOBAL_GROUP_ID, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(120)
  );
  return onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PlayerChatMessage, 'id'>) }));
    onNext(list);
  });
}

export async function sendFriendRequest(otherUid: string) {
  const selfUid = assertAuthUid();
  if (selfUid === otherUid) return;
  const ref = doc(db, 'playerFriendLinks', getFriendLinkId(selfUid, otherUid));
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(
    ref,
    {
      participants: [selfUid, otherUid],
      status: 'pending',
      requestedByUid: selfUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function sendFriendRequestByReferralCode(referralCode: string) {
  const selfUid = assertAuthUid();
  const cleanCode = String(referralCode || '').trim().toUpperCase();
  if (!cleanCode) {
    throw new Error('Referral code is required.');
  }

  const matchSnap = await getDocs(
    query(
      collection(db, 'users'),
      where('role', '==', 'player'),
      where('status', '==', 'active'),
      where('referralCode', '==', cleanCode),
      limit(1)
    )
  );

  if (matchSnap.empty) {
    throw new Error('No player found with this referral code.');
  }

  const matchedDoc = matchSnap.docs[0];
  if (matchedDoc.id === selfUid) {
    throw new Error('You cannot add yourself.');
  }

  await sendFriendRequest(matchedDoc.id);
  const data = matchedDoc.data() as { username?: string };
  return {
    uid: matchedDoc.id,
    username: String(data.username || '').trim() || 'Player',
  };
}

export async function acceptFriendRequest(otherUid: string) {
  const selfUid = assertAuthUid();
  const ref = doc(db, 'playerFriendLinks', getFriendLinkId(selfUid, otherUid));
  await setDoc(
    ref,
    {
      participants: [selfUid, otherUid],
      status: 'accepted',
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export function listenFriendLinks(onNext: (links: FriendLink[]) => void) {
  const selfUid = auth.currentUser?.uid;
  if (!selfUid) {
    onNext([]);
    return () => {};
  }
  const q = query(
    collection(db, 'playerFriendLinks'),
    where('participants', 'array-contains', selfUid),
    orderBy('updatedAt', 'desc'),
    limit(500)
  );
  return onSnapshot(q, (snap) => {
    const links = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FriendLink, 'id'>) }));
    onNext(links);
  });
}

export async function ensureReferralFriendLinks() {
  const selfUid = assertAuthUid();
  const referredSnap = await getDocs(
    query(collection(db, 'users'), where('role', '==', 'player'), where('referredByUid', '==', selfUid))
  );
  if (referredSnap.empty) return;

  const batch = writeBatch(db);
  referredSnap.docs.forEach((d) => {
    const otherUid = d.id;
    if (otherUid === selfUid) return;
    const ref = doc(db, 'playerFriendLinks', getFriendLinkId(selfUid, otherUid));
    batch.set(
      ref,
      {
        participants: [selfUid, otherUid],
        status: 'accepted',
        requestedByUid: selfUid,
        source: 'referral',
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });
  await batch.commit();
}
