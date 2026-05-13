import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
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
  frontendUrl?: string;
  siteUrl?: string;
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
  frontendUrl?: string;
  siteUrl?: string;
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
    frontendUrl: String(values.frontendUrl || '').trim(),
    siteUrl: String(values.siteUrl || '').trim(),
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
    frontendUrl?: string;
    siteUrl?: string;
  }
) {
  if (!values.gameName.trim()) throw new Error('Game name is required.');
  if (!values.gameUsername.trim()) throw new Error('Game username is required.');
  if (!values.gamePassword.trim()) throw new Error('Game password is required.');

  await updateDoc(doc(db, 'playerGameLogins', loginId), {
    gameName: values.gameName.trim(),
    gameUsername: values.gameUsername.trim(),
    gamePassword: values.gamePassword,
    frontendUrl: String(values.frontendUrl || '').trim(),
    siteUrl: String(values.siteUrl || '').trim(),
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

/**
 * Live updates when carer-agent (or anyone) merges new credentials — same pattern as
 * listenToPlayerGameLoginsByCoadmin on the carer app.
 */
export function listenToPlayerGameLoginsByPlayer(
  playerUid: string,
  onChange: (logins: PlayerGameLogin[]) => void,
  onError?: (error: Error) => void
) {
  const q = query(collection(db, 'playerGameLogins'), where('playerUid', '==', playerUid));

  return onSnapshot(
    q,
    (snapshot) => {
      const rows = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<PlayerGameLogin, 'id'>),
      }));
      onChange(rows);
    },
    (error) => {
      onError?.(error as Error);
    }
  );
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

export function listenToPlayerGameLoginsByCoadmin(
  coadminUid: string,
  onChange: (logins: PlayerGameLogin[]) => void,
  onError?: (error: Error) => void
) {
  const coadminQuery = query(
    collection(db, 'playerGameLogins'),
    where('coadminUid', '==', coadminUid)
  );
  const legacyQuery = query(
    collection(db, 'playerGameLogins'),
    where('createdBy', '==', coadminUid)
  );

  let coadminDocs: PlayerGameLogin[] = [];
  let legacyDocs: PlayerGameLogin[] = [];

  const emit = () => {
    const merged = Array.from(
      new Map(
        [...coadminDocs, ...legacyDocs].map((login) => [login.id, login])
      ).values()
    );
    onChange(merged);
  };

  const unsubCoadmin = onSnapshot(
    coadminQuery,
    (snapshot) => {
      coadminDocs = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<PlayerGameLogin, 'id'>),
      }));
      emit();
    },
    (error) => {
      onError?.(error as Error);
    }
  );

  const unsubLegacy = onSnapshot(
    legacyQuery,
    (snapshot) => {
      legacyDocs = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<PlayerGameLogin, 'id'>),
      }));
      emit();
    },
    (error) => {
      onError?.(error as Error);
    }
  );

  return () => {
    unsubCoadmin();
    unsubLegacy();
  };
}
