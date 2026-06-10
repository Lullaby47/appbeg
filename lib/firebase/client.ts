'use client';

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const storage = getStorage(app);

let clientFirestore: Firestore | null = null;

function isBrowserSqlFirestoreBlocked() {
  return typeof window !== 'undefined' && isClientSqlReadMode();
}

/**
 * Lazily initializes Firestore only outside SQL read mode.
 * In SQL mode the SDK is never started — no Listen/channel connections.
 */
export function getClientFirestore(context = 'firebase-client'): Firestore {
  if (isBrowserSqlFirestoreBlocked()) {
    console.info('[CLIENT_FIRESTORE_BLOCKED]', {
      feature: 'firebase_client_getClientFirestore',
      operation: 'init',
      context,
    });
    throw new Error('client_firestore_disabled_sql_mode');
  }

  if (!clientFirestore) {
    clientFirestore = getFirestore(app);
  }
  return clientFirestore;
}

/** @deprecated Prefer getClientFirestore() — lazy and SQL-gated. */
export function getClientDb(context = 'firebase-client'): Firestore {
  return getClientFirestore(context);
}

/**
 * Legacy `db` export. Accessing this in SQL mode throws before Firestore initializes.
 */
export const db: Firestore = new Proxy({} as Firestore, {
  get(_target, prop) {
    if (isBrowserSqlFirestoreBlocked()) {
      console.info('[CLIENT_FIRESTORE_BLOCKED]', {
        feature: 'firebase_client_db_proxy',
        operation: 'access',
        prop: String(prop),
      });
      throw new Error('client_firestore_disabled_sql_mode');
    }
    const realDb = getClientFirestore('db_proxy');
    const value = (realDb as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(realDb)
      : value;
  },
});
