import {
  collection,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { assertValidGameUsername } from '@/lib/games/gameUsernameRule';

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

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as { error?: string; warning?: string; recorded?: boolean };
  } catch {
    return { error: text || 'Server returned invalid response.' };
  }
}

async function savePlayerGameLoginOnServer(body: Record<string, unknown>) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const response = await fetch('/api/player-game-logins', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await currentUser.getIdToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await readApiResponse(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to save game username.');
  }
  if (data.warning) {
    console.error('[PLAYER_GAME_LOGINS] server saved Firebase username with warning', data);
  }
  return data;
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
  assertValidGameUsername(values.gameUsername);
  if (!values.gamePassword.trim()) throw new Error('Game password is required.');

  await savePlayerGameLoginOnServer({
    action: 'create',
    playerUid: values.playerUid,
    playerUsername: values.playerUsername,
    gameName: values.gameName.trim(),
    gameUsername: values.gameUsername.trim(),
    gamePassword: values.gamePassword,
    frontendUrl: String(values.frontendUrl || '').trim(),
    siteUrl: String(values.siteUrl || '').trim(),
    coadminUid: values.coadminUid,
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
  assertValidGameUsername(values.gameUsername);
  if (!values.gamePassword.trim()) throw new Error('Game password is required.');

  await savePlayerGameLoginOnServer({
    action: 'update',
    loginId,
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

export async function getPlayerGameLoginsByPlayerGame(
  playerUid: string,
  gameName: string
): Promise<PlayerGameLogin[]> {
  const q = query(
    collection(db, 'playerGameLogins'),
    where('playerUid', '==', playerUid),
    where('gameName', '==', gameName.trim())
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
