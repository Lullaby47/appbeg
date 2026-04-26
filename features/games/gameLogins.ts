import {
  addDoc,
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { getCurrentUserCoadminUid } from '@/lib/coadmin/scope';

export type GameLogin = {
  id: string;
  gameName: string;
  username: string;
  password: string;
  createdBy: string;
  coadminUid?: string;
  createdAt?: any;
};

async function getGameLoginsByField(
  field: 'createdBy' | 'coadminUid',
  value: string
) {
  const gameQuery = query(collection(db, 'gameLogins'), where(field, '==', value));
  const snapshot = await getDocs(gameQuery);

  return snapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Omit<GameLogin, 'id'>),
  }));
}

export async function createGameLogin(
  gameName: string,
  username: string,
  password: string
) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const cleanGameName = gameName.trim();
  const cleanUsername = username.trim();

  if (!cleanGameName) {
    throw new Error('Game name is required.');
  }

  if (!cleanUsername) {
    throw new Error('Username is required.');
  }

  if (!password.trim()) {
    throw new Error('Password is required.');
  }

  const coadminUid = await getCurrentUserCoadminUid();

  await addDoc(collection(db, 'gameLogins'), {
    gameName: cleanGameName,
    username: cleanUsername,
    password,
    createdBy: coadminUid,
    coadminUid,
    createdAt: serverTimestamp(),
  });
}

export async function getMyGameLogins(): Promise<GameLogin[]> {
  const coadminUid = await getCurrentUserCoadminUid();
  return getGameLoginsByCoadmin(coadminUid);
}

export async function getGameLoginsByCoadmin(
  coadminUid: string
): Promise<GameLogin[]> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    getGameLoginsByField('coadminUid', coadminUid),
    getGameLoginsByField('createdBy', coadminUid),
  ]);

  return Array.from(
    new Map(
      [...coadminOwned, ...legacyOwned].map((gameLogin) => [gameLogin.id, gameLogin])
    ).values()
  );
}

export async function updateGameLogin(
  gameLoginId: string,
  values: {
    gameName: string;
    username: string;
    password: string;
  }
) {
  const cleanGameName = values.gameName.trim();
  const cleanUsername = values.username.trim();

  if (!cleanGameName) {
    throw new Error('Game name is required.');
  }

  if (!cleanUsername) {
    throw new Error('Username is required.');
  }

  if (!values.password.trim()) {
    throw new Error('Password is required.');
  }

  await updateDoc(doc(db, 'gameLogins', gameLoginId), {
    gameName: cleanGameName,
    username: cleanUsername,
    password: values.password,
  });
}
