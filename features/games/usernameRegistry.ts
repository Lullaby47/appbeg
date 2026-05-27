import { auth } from '@/lib/firebase/client';

type RegistryAction = 'check' | 'insert_after_firebase' | 'delete_after_firebase';

async function registryRequest(action: RegistryAction, username: string) {
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
    body: JSON.stringify({ action, username: username.trim() }),
  });
  const data = (await response.json()) as { error?: string; exists?: boolean };
  if (!response.ok) {
    throw new Error(data.error || 'Username registry request failed.');
  }
  return data;
}

export async function ensureUsernameAvailable(username: string) {
  const result = await registryRequest('check', username);
  if (result.exists) {
    throw new Error('That username is already taken.');
  }
}

export async function insertUsernameAfterFirebaseSave(username: string) {
  await registryRequest('insert_after_firebase', username);
}

export async function deleteUsernameAfterFirebaseDelete(username: string) {
  await registryRequest('delete_after_firebase', username);
}
