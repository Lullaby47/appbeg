'use client';

import { auth } from '@/lib/firebase/client';

type MigrateResponse = {
  ok?: boolean;
  uid?: string;
  migrated?: boolean;
  error?: string;
};

export async function migrateCredentialsAfterFirebaseLogin(password: string) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    return null;
  }

  const cleanPassword = String(password || '');
  if (cleanPassword.length < 6) {
    return null;
  }

  try {
    const token = await currentUser.getIdToken();
    const response = await fetch('/api/auth/credentials/migrate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ password: cleanPassword }),
    });

    const payload = (await response.json()) as MigrateResponse;
    if (!response.ok || !payload.ok) {
      console.warn('[SQL_CREDENTIALS_MIGRATE] client_failed', {
        status: response.status,
        error: payload.error || 'migrate_failed',
      });
      return null;
    }

    console.info('[SQL_CREDENTIALS_MIGRATE] client_ok', {
      uid: payload.uid || null,
      migrated: payload.migrated === true,
    });
    return payload;
  } catch (error) {
    console.warn('[SQL_CREDENTIALS_MIGRATE] client_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
