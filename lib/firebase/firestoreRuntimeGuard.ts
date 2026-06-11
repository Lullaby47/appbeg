import 'server-only';

import type {
  CollectionReference,
  DocumentReference,
  Firestore,
  Query,
} from 'firebase-admin/firestore';

import { isAppbegSqlOnlyMode } from '@/lib/server/appbegSqlOnlyMode';

export class FirestoreRuntimeBlockedError extends Error {
  readonly code = 'FIRESTORE_RUNTIME_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'FirestoreRuntimeBlockedError';
  }
}

const MIGRATION_PATH_MARKERS = [
  'scripts/firebase-backfill/',
  'scripts/backfill-',
  'lib/firebase/migrationOnly/',
  'app/api/admin/migration/',
] as const;

function normalizePath(file: string) {
  return file.replace(/\\/g, '/').toLowerCase();
}

export function isMigrationFirestorePath(file: string) {
  const normalized = normalizePath(file);
  if (normalized.includes('/scripts/') && normalized.endsWith('.cjs')) {
    return true;
  }
  return MIGRATION_PATH_MARKERS.some((marker) => normalized.includes(marker));
}

function getCallerFile(skipFrames = 2): string {
  const stack = new Error().stack || '';
  const lines = stack.split('\n').slice(skipFrames);
  for (const line of lines) {
    if (line.includes('firestoreRuntimeGuard')) {
      continue;
    }
    const match =
      line.match(/\(([^)]+):\d+:\d+\)/) ||
      line.match(/at ([^ ]+):\d+:\d+/);
    if (!match?.[1]) {
      continue;
    }
    const candidate = match[1].replace(/^file:\/\//, '');
    if (
      candidate.includes('node_modules') ||
      candidate.includes('firestoreRuntimeGuard')
    ) {
      continue;
    }
    return candidate;
  }
  return 'unknown';
}

export function assertFirestoreRuntimeAllowed(
  operation: 'read' | 'write',
  collection?: string | null
) {
  if (!isAppbegSqlOnlyMode()) {
    return;
  }

  const file = getCallerFile(3);
  if (isMigrationFirestorePath(file)) {
    return;
  }

  console.error(
    '[FIREBASE_RUNTIME_BLOCKED] file=%s operation=%s collection=%s',
    file,
    operation,
    collection || '-'
  );

  throw new FirestoreRuntimeBlockedError(
    `Firestore ${operation} blocked in APPBEG_SQL_ONLY_MODE (file=${file}, collection=${collection || '-'})`
  );
}

function guardAsync<T>(
  operation: 'read' | 'write',
  collection: string | null | undefined,
  fn: () => Promise<T>
) {
  assertFirestoreRuntimeAllowed(operation, collection);
  return fn();
}

function wrapQuery<T extends Query>(query: T, collectionPath: string | null): T {
  return new Proxy(query, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      if (prop === 'get') {
        return (...args: unknown[]) =>
          guardAsync('read', collectionPath, () =>
            Reflect.apply(value, target, args)
          );
      }
      if (prop === 'where' || prop === 'orderBy' || prop === 'limit' || prop === 'startAt' || prop === 'startAfter' || prop === 'endAt' || prop === 'endBefore') {
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args);
          return wrapQuery(next as Query, collectionPath);
        };
      }
      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  }) as T;
}

function wrapDocumentReference<T extends DocumentReference>(
  docRef: T,
  collectionPath: string | null
): T {
  return new Proxy(docRef, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      if (prop === 'get') {
        return (...args: unknown[]) =>
          guardAsync('read', collectionPath, () =>
            Reflect.apply(value, target, args)
          );
      }
      if (prop === 'set' || prop === 'update' || prop === 'create' || prop === 'delete') {
        return (...args: unknown[]) =>
          guardAsync('write', collectionPath, () =>
            Reflect.apply(value, target, args)
          );
      }
      if (prop === 'collection') {
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args);
          const childPath = collectionPath
            ? `${collectionPath}/${String(args[0] || '')}`
            : String(args[0] || '');
          return wrapCollectionReference(next as CollectionReference, childPath);
        };
      }
      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  }) as T;
}

function wrapCollectionReference<T extends CollectionReference>(
  collectionRef: T,
  collectionPath: string | null
): T {
  return new Proxy(collectionRef, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      if (prop === 'doc') {
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args);
          return wrapDocumentReference(next as DocumentReference, collectionPath);
        };
      }
      if (prop === 'get') {
        return (...args: unknown[]) =>
          guardAsync('read', collectionPath, () =>
            Reflect.apply(value, target, args)
          );
      }
      if (prop === 'add') {
        return (...args: unknown[]) =>
          guardAsync('write', collectionPath, () =>
            Reflect.apply(value, target, args)
          );
      }
      if (prop === 'where' || prop === 'orderBy' || prop === 'limit' || prop === 'startAt' || prop === 'startAfter' || prop === 'endAt' || prop === 'endBefore') {
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args);
          return wrapQuery(next as Query, collectionPath);
        };
      }
      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  }) as T;
}

export function createGuardedFirestore(db: Firestore): Firestore {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      if (prop === 'collection') {
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args);
          return wrapCollectionReference(
            next as CollectionReference,
            String(args[0] || '')
          );
        };
      }

      if (prop === 'doc') {
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args);
          const path = String(args[0] || '');
          const collectionPath = path.includes('/') ? path.split('/')[0] : path;
          return wrapDocumentReference(next as DocumentReference, collectionPath);
        };
      }

      if (prop === 'getAll') {
        return (...args: unknown[]) =>
          guardAsync('read', null, async () => Reflect.apply(value, target, args) as Promise<unknown>);
      }

      if (prop === 'runTransaction') {
        return (...args: unknown[]) =>
          guardAsync('write', null, async () => Reflect.apply(value, target, args) as Promise<unknown>);
      }

      if (prop === 'batch') {
        return (...args: unknown[]) => {
          assertFirestoreRuntimeAllowed('write', null);
          return Reflect.apply(value, target, args);
        };
      }

      if (prop === 'bulkWriter') {
        return (...args: unknown[]) => {
          assertFirestoreRuntimeAllowed('write', null);
          return Reflect.apply(value, target, args);
        };
      }

      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  }) as Firestore;
}
