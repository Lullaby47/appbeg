import { auth } from '@/lib/firebase/client';

export async function getFirebaseApiHeaders(contentType = true) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const token = await currentUser.getIdToken();
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`,
  };
}
