import type { DocumentReference } from 'firebase/firestore';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { belongsToCoadmin, getCurrentUserCoadminUid } from '@/lib/coadmin/scope';

export type GameLogin = {
  id: string;
  gameName: string;
  username: string;
  password: string;
  backendUrl?: string;
  frontendUrl?: string;
  siteUrl?: string;
  createdBy: string;
  coadminUid?: string;
  createdAt?: unknown;
};

function normalizeSiteUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

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
  password: string,
  backendUrl = '',
  frontendUrl = ''
) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const cleanGameName = gameName.trim();
  const cleanUsername = username.trim();
  const cleanBackendUrl = normalizeSiteUrl(backendUrl);
  const cleanFrontendUrl = normalizeSiteUrl(frontendUrl);

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
    backendUrl: cleanBackendUrl,
    frontendUrl: cleanFrontendUrl,
    // Keep legacy field synced for older consumers.
    siteUrl: cleanBackendUrl,
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
    backendUrl?: string;
    frontendUrl?: string;
  }
) {
  const cleanGameName = values.gameName.trim();
  const cleanUsername = values.username.trim();
  const cleanBackendUrl = normalizeSiteUrl(values.backendUrl || '');
  const cleanFrontendUrl = normalizeSiteUrl(values.frontendUrl || '');

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
    backendUrl: cleanBackendUrl,
    frontendUrl: cleanFrontendUrl,
    siteUrl: cleanBackendUrl,
  });
}

const BATCH_DELETE_LIMIT = 450;

async function _collectRefsForGameName(
  collectionName: string,
  scopeField: 'coadminUid' | 'createdBy',
  scopeUid: string,
  gameName: string
) {
  const snap = await getDocs(
    query(collection(db, collectionName), where(scopeField, '==', scopeUid))
  );
  const refs: DocumentReference[] = [];
  snap.forEach((docSnap) => {
    const gn = String((docSnap.data() as { gameName?: string }).gameName || '').trim();
    if (gn === gameName) {
      refs.push(docSnap.ref);
    }
  });
  return refs;
}

/**
 * Permanently removes a `gameLogins` row and scoped Firestore rows tied to the same
 * coadmin + game name (player logins, game requests, carer tasks, bonus events).
 * Uses single-field queries + in-memory gameName match so no new composite indexes are required.
 */
export async function deleteGameLoginAndRelatedData(gameLoginId: string): Promise<{
  deleted: {
    gameLogin: boolean;
    playerGameLogins: number;
    playerGameRequests: number;
    carerTasks: number;
    bonusEvents: number;
  };
}> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const coadminUid = await getCurrentUserCoadminUid();
  const gameRef = doc(db, 'gameLogins', gameLoginId);
  const gameSnap = await getDoc(gameRef);
  if (!gameSnap.exists()) {
    throw new Error('Game not found.');
  }

  const gameData = gameSnap.data() as GameLogin;
  if (!belongsToCoadmin(gameData, coadminUid)) {
    throw new Error('You do not have permission to delete this game.');
  }

  const gameName = String(gameData.gameName || '').trim();
  if (!gameName) {
    throw new Error('Invalid game record.');
  }

  const refByPath = new Map<string, DocumentReference>();

  const mergeRefs = (refs: DocumentReference[]) => {
    for (const r of refs) {
      refByPath.set(r.path, r);
    }
  };

  mergeRefs(await _collectRefsForGameName('playerGameLogins', 'coadminUid', coadminUid, gameName));
  mergeRefs(await _collectRefsForGameName('playerGameLogins', 'createdBy', coadminUid, gameName));
  mergeRefs(await _collectRefsForGameName('playerGameRequests', 'coadminUid', coadminUid, gameName));
  mergeRefs(await _collectRefsForGameName('playerGameRequests', 'createdBy', coadminUid, gameName));
  mergeRefs(await _collectRefsForGameName('carerTasks', 'coadminUid', coadminUid, gameName));
  mergeRefs(await _collectRefsForGameName('bonusEvents', 'coadminUid', coadminUid, gameName));

  const dependentRefs = Array.from(refByPath.values());
  const counts = {
    playerGameLogins: 0,
    playerGameRequests: 0,
    carerTasks: 0,
    bonusEvents: 0,
  };

  for (const r of dependentRefs) {
    const parent = r.parent.id;
    if (parent === 'playerGameLogins') {
      counts.playerGameLogins += 1;
    } else if (parent === 'playerGameRequests') {
      counts.playerGameRequests += 1;
    } else if (parent === 'carerTasks') {
      counts.carerTasks += 1;
    } else if (parent === 'bonusEvents') {
      counts.bonusEvents += 1;
    }
  }

  for (let i = 0; i < dependentRefs.length; i += BATCH_DELETE_LIMIT) {
    const slice = dependentRefs.slice(i, i + BATCH_DELETE_LIMIT);
    const batch = writeBatch(db);
    for (const r of slice) {
      batch.delete(r);
    }
    await batch.commit();
  }

  await deleteDoc(gameRef);

  return {
    deleted: {
      gameLogin: true,
      ...counts,
    },
  };
}
