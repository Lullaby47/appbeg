'use client';

/**
 * Guarded browser Firestore SDK entry points.
 * Import onSnapshot/getDoc/collection from here in client code so SQL mode never opens Listen/channel.
 */
import {
  collection as firestoreCollection,
  doc as firestoreDoc,
  getDoc as firestoreGetDoc,
  getDocs as firestoreGetDocs,
  onSnapshot as firestoreOnSnapshot,
  query as firestoreQuery,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type Query,
  type QueryConstraint,
  type Unsubscribe,
} from 'firebase/firestore';

import { assertClientFirestoreDisabled, noopFirestoreUnsubscribe } from '@/lib/client/clientFirestoreGuard';
import { getClientFirestore } from '@/lib/firebase/client';

export function collection(
  firestore: Firestore,
  path: string,
  ...pathSegments: string[]
) {
  if (assertClientFirestoreDisabled('firestore_sdk', 'query', { helper: 'collection' })) {
    return {} as ReturnType<typeof firestoreCollection>;
  }
  return firestoreCollection(firestore, path, ...pathSegments);
}

export function doc(
  firestore: Firestore,
  path: string,
  ...pathSegments: string[]
) {
  if (assertClientFirestoreDisabled('firestore_sdk', 'query', { helper: 'doc' })) {
    return {} as DocumentReference<DocumentData>;
  }
  return firestoreDoc(firestore, path, ...pathSegments);
}

export function query<T>(
  baseQuery: Query<T>,
  ...constraints: QueryConstraint[]
) {
  if (assertClientFirestoreDisabled('firestore_sdk', 'query', { helper: 'query' })) {
    return baseQuery;
  }
  return firestoreQuery(baseQuery, ...constraints);
}

export async function getDoc(reference: DocumentReference<DocumentData>) {
  if (assertClientFirestoreDisabled('firestore_sdk', 'getDoc')) {
    return {
      exists: () => false,
      data: () => undefined,
      id: '',
    };
  }
  return firestoreGetDoc(reference);
}

export async function getDocs(firestoreQueryRef: Query<DocumentData>) {
  if (assertClientFirestoreDisabled('firestore_sdk', 'getDocs')) {
    return {
      empty: true,
      docs: [],
      size: 0,
    };
  }
  return firestoreGetDocs(firestoreQueryRef);
}

export function onSnapshot(
  reference: Query<DocumentData> | DocumentReference<DocumentData>,
  onNext: (snapshot: unknown) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  if (assertClientFirestoreDisabled('firestore_sdk', 'onSnapshot')) {
    return noopFirestoreUnsubscribe();
  }
  return firestoreOnSnapshot(
    reference as DocumentReference<DocumentData>,
    onNext,
    onError
  );
}

export function getDb() {
  return getClientFirestore();
}
