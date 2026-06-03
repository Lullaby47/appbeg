import { auth } from '@/lib/firebase/client';
import { assertValidGameUsername } from '@/lib/games/gameUsernameRule';

type RegistryAction = 'check' | 'record_after_firebase' | 'insert_after_firebase' | 'delete_after_firebase';

type RegistryPayload = {
  game?: string;
  playerUid?: string;
  coadminUid?: string;
  source?: string;
};

async function registryRequest(action: RegistryAction, username: string, payload: RegistryPayload = {}) {
  assertValidGameUsername(username);
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const response = await fetch('/api/username-registry', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await currentUser.getIdToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, username: username.trim(), ...payload }),
  });
  const data = (await response.json()) as { error?: string; exists?: boolean };
  if (!response.ok) {
    throw new Error(data.error || 'Username registry request failed.');
  }
  return data;
}

export async function ensureUsernameAvailable(username: string) {
  try {
    const result = await registryRequest('check', username);
    if (result.exists) {
      throw new Error('That username is already taken.');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'That username is already taken.') {
      throw error;
    }
    console.error('[USERNAME_REGISTRY] availability check unavailable; continuing with Firebase save', {
      username,
      error,
    });
  }
}

export async function recordGameUsernameAfterFirebaseSave(
  username: string,
  payload: Required<Pick<RegistryPayload, 'game'>> & RegistryPayload
) {
  try {
    await registryRequest('record_after_firebase', username, payload);
  } catch (error) {
    console.error('[USERNAME_REGISTRY] non-blocking record failed after Firebase save', {
      username,
      ...payload,
      error,
    });
  }
}

export async function insertUsernameAfterFirebaseSave(username: string) {
  try {
    await registryRequest('insert_after_firebase', username);
  } catch (error) {
    console.error('[USERNAME_REGISTRY] non-blocking legacy insert failed after Firebase save', {
      username,
      error,
    });
  }
}

export async function deleteUsernameAfterFirebaseDelete(username: string) {
  try {
    await registryRequest('delete_after_firebase', username);
  } catch (error) {
    console.error('[USERNAME_REGISTRY] non-blocking delete failed after Firebase delete', {
      username,
      error,
    });
  }
}
