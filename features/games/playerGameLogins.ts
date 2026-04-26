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

export type PlayerGameLogin = {
  id: string;
  playerUid: string;
  playerUsername: string;
  gameName: string;
  gameUsername: string;
  gamePassword: string;
  coadminUid: string;
  createdBy: string;
  createdAt?: any;
};

async function getPlayerGameLoginsByField(
  field: 'createdBy' | 'coadminUid',
  value: string
) {
  const q = query(collection(db, 'playerGameLogins'), where(field, '==', value));
  const snapshot = await getDocs(q);

  return snapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Omit<PlayerGameLogin, 'id'>),
  }));
}

export async function createPlayerGameLogin(values: {
  playerUid: string;
  playerUsername: string;
  gameName: string;
  gameUsername: string;
  gamePassword: string;
  coadminUid: string;
}) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  if (!values.playerUid) throw new Error('Player is required.');
  if (!values.gameName.trim()) throw new Error('Game name is required.');
  if (!values.gameUsername.trim()) throw new Error('Game username is required.');
  if (!values.gamePassword.trim()) throw new Error('Game password is required.');

  await addDoc(collection(db, 'playerGameLogins'), {
    playerUid: values.playerUid,
    playerUsername: values.playerUsername,
    gameName: values.gameName.trim(),
    gameUsername: values.gameUsername.trim(),
    gamePassword: values.gamePassword,
    coadminUid: values.coadminUid,
    createdBy: values.coadminUid,
    createdAt: serverTimestamp(),
  });
}

export async function updatePlayerGameLogin(
  loginId: string,
  values: {
    gameName: string;
    gameUsername: string;
    gamePassword: string;
  }
) {
  if (!values.gameName.trim()) throw new Error('Game name is required.');
  if (!values.gameUsername.trim()) throw new Error('Game username is required.');
  if (!values.gamePassword.trim()) throw new Error('Game password is required.');

  await updateDoc(doc(db, 'playerGameLogins', loginId), {
    gameName: values.gameName.trim(),
    gameUsername: values.gameUsername.trim(),
    gamePassword: values.gamePassword,
  });
}

export async function getPlayerGameLoginsByPlayer(
  playerUid: string
): Promise<PlayerGameLogin[]> {
  const q = query(
    collection(db, 'playerGameLogins'),
    where('playerUid', '==', playerUid)
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Omit<PlayerGameLogin, 'id'>),
  }));
}

export async function getPlayerGameLoginsByCoadmin(
  coadminUid: string
): Promise<PlayerGameLogin[]> {
  const [coadminOwned, legacyOwned] = await Promise.all([
    getPlayerGameLoginsByField('coadminUid', coadminUid),
    getPlayerGameLoginsByField('createdBy', coadminUid),
  ]);

  return Array.from(
    new Map(
      [...coadminOwned, ...legacyOwned].map((login) => [login.id, login])
    ).values()
  );
}
