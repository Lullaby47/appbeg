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

import { getAppSessionRequestHeaders } from '@/features/auth/appSession';
import { auth, db } from '@/lib/firebase/client';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

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

const PLAYER_GAME_LOGINS_CACHE_TIMEOUT_MS = 5_000;

async function fetchWithPlayerGameLoginsCacheTimeout(
  input: RequestInfo | URL,
  init: RequestInit
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLAYER_GAME_LOGINS_CACHE_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function tryReadPlayerGameLoginsCacheByCoadmin(
  coadminUid: string
): Promise<PlayerGameLogin[] | null> {
  const cleanCoadminUid = coadminUid.trim();
  if (!cleanCoadminUid) {
    return [];
  }

  const startedAt = Date.now();
  try {
    const headers = await getFirebaseApiHeaders(false);
    const response = await fetchWithPlayerGameLoginsCacheTimeout(
      `/api/player-game-logins/cache?coadminUid=${encodeURIComponent(cleanCoadminUid)}`,
      {
        method: 'GET',
        headers,
        cache: 'no-store',
      }
    );
    if (!response.ok) {
      console.info('[PLAYER_GAME_LOGINS_CACHE_READ] source=firestore_fallback', {
        coadminUid: cleanCoadminUid,
        reason: `cache_api_status_${response.status}`,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }

    const payload = (await response.json()) as {
      playerGameLogins?: PlayerGameLogin[];
      source?: string;
    };
    if (Array.isArray(payload.playerGameLogins)) {
      console.info(
        `[PLAYER_GAME_LOGINS_CACHE_READ] source=${payload.source === 'postgres' ? 'postgres' : 'firestore_fallback'} coadminUid=${cleanCoadminUid} count=${payload.playerGameLogins.length} durationMs=${Date.now() - startedAt}`
      );
      return payload.playerGameLogins;
    }
    return null;
  } catch (error) {
    console.info('[PLAYER_GAME_LOGINS_CACHE_READ] source=firestore_fallback', {
      coadminUid: cleanCoadminUid,
      reason: 'cache_api_failed',
      durationMs: Date.now() - startedAt,
      error,
    });
    return null;
  }
}

async function mirrorPlayerGameLoginCacheBestEffort(
  loginId: string,
  action: 'upsert' | 'tombstone' = 'upsert'
) {
  const cleanLoginId = String(loginId || '').trim();
  if (!cleanLoginId) return;
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return;
    const response = await fetch('/api/player-game-logins/cache/mirror', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...getAppSessionRequestHeaders(),
      },
      body: JSON.stringify({ loginId: cleanLoginId, action }),
    });
    if (!response.ok) {
      console.error('[PLAYER_GAME_LOGINS_CACHE] mirror failed', {
        loginId: cleanLoginId,
        action,
        status: response.status,
      });
    }
  } catch (error) {
    console.error('[PLAYER_GAME_LOGINS_CACHE] mirror failed', {
      loginId: cleanLoginId,
      action,
      error,
    });
  }
}

export async function mirrorPlayerGameLoginsCacheDeleteBestEffort(loginIds: string[]) {
  const cleanLoginIds = loginIds.map((loginId) => String(loginId || '').trim()).filter(Boolean);
  if (!cleanLoginIds.length) return;
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return;
    const response = await fetch('/api/player-game-logins/cache/mirror', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...getAppSessionRequestHeaders(),
      },
      body: JSON.stringify({ loginIds: cleanLoginIds, action: 'tombstone' }),
    });
    if (!response.ok) {
      console.error('[PLAYER_GAME_LOGINS_CACHE] mirror failed', {
        loginIds: cleanLoginIds,
        action: 'tombstone',
        status: response.status,
      });
    }
  } catch (error) {
    console.error('[PLAYER_GAME_LOGINS_CACHE] mirror failed', {
      loginIds: cleanLoginIds,
      action: 'tombstone',
      error,
    });
  }
}

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

  const loginRef = await addDoc(collection(db, 'playerGameLogins'), {
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
  void mirrorPlayerGameLoginCacheBestEffort(loginRef.id);
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
  void mirrorPlayerGameLoginCacheBestEffort(loginId);
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

export async function getPlayerGameLoginsByCoadminSqlFirst(
  coadminUid: string
): Promise<PlayerGameLogin[]> {
  const cached = await tryReadPlayerGameLoginsCacheByCoadmin(coadminUid);
  if (cached) {
    return cached;
  }

  const startedAt = Date.now();
  const logins = await getPlayerGameLoginsByCoadmin(coadminUid);
  console.info(
    `[PLAYER_GAME_LOGINS_CACHE_READ] source=firestore_fallback coadminUid=${coadminUid.trim()} count=${logins.length} durationMs=${Date.now() - startedAt}`
  );
  return logins;
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
