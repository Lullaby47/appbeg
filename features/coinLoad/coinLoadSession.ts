import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';

import { auth, db, storage } from '@/lib/firebase/client';

/**
 * Firestore: collection `coinLoadSessions` (fields: playerUid, coadminUid, hashCode,
 * paymentPhotoUrl, createdAt, expiresAt). Rules should allow: create if playerUid ==
 * auth.uid; read/delete if resource.data.playerUid == auth.uid.
 * Storage path: `coadmin-payment-details/{coadminUid}/...` — allow write if auth.uid == coadminUid.
 * Users doc field: `paymentDetailPhotoUrls` (string[]).
 */
const SESSIONS = 'coinLoadSessions';
export const COIN_LOAD_SESSION_MS = 10 * 60 * 1000;
const DURATION_MS = COIN_LOAD_SESSION_MS;

export type CoinLoadSession = {
  id: string;
  playerUid: string;
  coadminUid: string;
  hashCode: string;
  paymentPhotoUrl: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
};

function generate16DigitCode(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += String(bytes[i]! % 10);
  }
  return out;
}

function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

export async function uploadCoadminPaymentDetailPhoto(
  coadminUid: string,
  file: File
): Promise<string> {
  const current = auth.currentUser;
  if (!current || current.uid !== coadminUid) {
    throw new Error('Not authorized to upload for this account.');
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are allowed.');
  }
  const maxSizeMb = 5;
  if (file.size > maxSizeMb * 1024 * 1024) {
    throw new Error(`Image must be smaller than ${maxSizeMb}MB.`);
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `coadmin-payment-details/${coadminUid}/${Date.now()}-${safeName}`;
  const r = ref(storage, path);
  await uploadBytes(r, file);
  return getDownloadURL(r);
}

export async function setCoadminPaymentDetailPhotoUrls(
  coadminUid: string,
  urls: string[]
): Promise<void> {
  const current = auth.currentUser;
  if (!current || current.uid !== coadminUid) {
    throw new Error('Not authorized.');
  }
  await updateDoc(doc(db, 'users', coadminUid), {
    paymentDetailPhotoUrls: urls,
    updatedAt: serverTimestamp(),
  });
}

export async function getCoadminPaymentDetailPhotoUrls(
  coadminUid: string
): Promise<string[]> {
  const snap = await getDoc(doc(db, 'users', coadminUid));
  if (!snap.exists()) {
    return [];
  }
  const data = snap.data() as { paymentDetailPhotoUrls?: string[] };
  return Array.isArray(data.paymentDetailPhotoUrls)
    ? data.paymentDetailPhotoUrls.filter((u) => typeof u === 'string' && u.length > 0)
    : [];
}

async function clearPlayerCoinLoadDocs(playerUid: string): Promise<void> {
  const q = query(
    collection(db, SESSIONS),
    where('playerUid', '==', playerUid)
  );
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}

/**
 * Create a 10-minute coin load session: random coadmin payment photo + 16-digit code.
 * Removes any previous sessions for this player.
 */
export async function createCoinLoadSession(coadminUid: string): Promise<CoinLoadSession> {
  const current = auth.currentUser;
  if (!current) {
    throw new Error('Not authenticated.');
  }
  const playerUid = current.uid;
  if (!coadminUid) {
    throw new Error('No co-admin is linked to your account.');
  }
  const urls = await getCoadminPaymentDetailPhotoUrls(coadminUid);
  if (urls.length === 0) {
    throw new Error(
      'No payment reference images yet. Your co-admin needs to upload photos in their panel (Payment details).'
    );
  }
  const paymentPhotoUrl = randomItem(urls);
  const hashCode = generate16DigitCode();
  const now = Date.now();
  const expiresAt = Timestamp.fromMillis(now + DURATION_MS);

  await clearPlayerCoinLoadDocs(playerUid);

  const refDoc = await addDoc(collection(db, SESSIONS), {
    playerUid,
    coadminUid,
    hashCode,
    paymentPhotoUrl,
    createdAt: serverTimestamp(),
    expiresAt,
  });

  return {
    id: refDoc.id,
    playerUid,
    coadminUid,
    hashCode,
    paymentPhotoUrl,
    createdAt: Timestamp.fromMillis(now),
    expiresAt,
  };
}

export async function deleteCoinLoadSession(sessionId: string): Promise<void> {
  const current = auth.currentUser;
  if (!current) {
    return;
  }
  const sessionRef = doc(db, SESSIONS, sessionId);
  const snap = await getDoc(sessionRef);
  if (!snap.exists()) {
    return;
  }
  const data = snap.data() as { playerUid?: string };
  if (data.playerUid !== current.uid) {
    throw new Error('Not allowed to remove this session.');
  }
  await deleteDoc(sessionRef);
}

export function listenCoinLoadSession(
  sessionId: string,
  onNext: (session: CoinLoadSession | null) => void,
  onError?: (e: Error) => void
) {
  return onSnapshot(
    doc(db, SESSIONS, sessionId),
    (snap) => {
      if (!snap.exists()) {
        onNext(null);
        return;
      }
      const d = snap.data();
      onNext({
        id: snap.id,
        playerUid: d.playerUid as string,
        coadminUid: d.coadminUid as string,
        hashCode: d.hashCode as string,
        paymentPhotoUrl: d.paymentPhotoUrl as string,
        createdAt: d.createdAt as Timestamp,
        expiresAt: d.expiresAt as Timestamp,
      });
    },
    (err) => onError?.(err as Error)
  );
}

export function getSessionExpiresAtMs(session: CoinLoadSession): number {
  if (session.expiresAt && typeof session.expiresAt.toMillis === 'function') {
    return session.expiresAt.toMillis();
  }
  return 0;
}
