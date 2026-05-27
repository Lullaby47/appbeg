import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  deleteUsername,
  insertUsername,
  isUniqueViolation,
  usernameExists,
} from '@/lib/sql/usernameRegistry';

type RegistryAction = 'check' | 'insert_after_firebase' | 'delete_after_firebase';

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) return auth.response;

  const body = (await request.json()) as { action?: unknown; username?: unknown };
  const action = String(body.action || '') as RegistryAction;
  const username = String(body.username || '').trim();
  if (!username) {
    return NextResponse.json({ error: 'Username is required.' }, { status: 400 });
  }

  try {
    if (action === 'check') {
      const exists = await usernameExists(username);
      return NextResponse.json({ exists, available: !exists });
    }
    if (action === 'insert_after_firebase') {
      await insertUsername(username);
      return NextResponse.json({ success: true });
    }
    if (action === 'delete_after_firebase') {
      await deleteUsername(username);
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ error: 'Invalid registry action.' }, { status: 400 });
  } catch (error) {
    if (action === 'insert_after_firebase') {
      if (isUniqueViolation(error)) {
        console.info(`[USERNAME_REGISTRY] duplicate username=${username}`);
        return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 });
      }
      console.error(`[USERNAME_REGISTRY] SQL insert failed after Firebase save username=${username}`);
    }
    if (action === 'delete_after_firebase') {
      console.error(`[USERNAME_REGISTRY] SQL delete failed after Firebase delete username=${username}`);
    }
    return NextResponse.json({ error: 'Username registry SQL is unavailable.' }, { status: 503 });
  }
}
