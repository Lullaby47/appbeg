import 'server-only';

import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { PoolClient } from 'pg';

import { adminDb } from '@/lib/firebase/admin';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  readUsersCacheByRole,
  readUsersCacheByRoleWithClient,
  type CachedDirectoryUser,
} from '@/lib/sql/usersCache';

export type PlayerVisibleStaff = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'staff';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
};

function toPlayerVisibleStaff(row: CachedDirectoryUser): PlayerVisibleStaff | null {
  if (row.role !== 'staff' || row.status !== 'active') {
    return null;
  }
  return {
    id: row.id,
    uid: row.uid,
    username: row.username,
    email: row.email,
    role: 'staff',
    status: row.status,
    createdBy: row.createdBy,
    coadminUid: row.coadminUid ?? null,
  };
}

function mapFirestoreStaffDoc(
  docSnap: QueryDocumentSnapshot,
  coadminUid: string
): PlayerVisibleStaff | null {
  const data = docSnap.data() as Record<string, unknown>;
  if (cleanText(data.role) !== 'staff') {
    return null;
  }
  const status = (cleanText(data.status) || 'active') as 'active' | 'disabled';
  if (status !== 'active') {
    return null;
  }
  const createdBy = cleanText(data.createdBy) || null;
  const storedCoadminUid = cleanText(data.coadminUid) || null;
  const belongs =
    storedCoadminUid === coadminUid || createdBy === coadminUid;
  if (!belongs) {
    return null;
  }
  return {
    id: docSnap.id,
    uid: docSnap.id,
    username: cleanText(data.username),
    email: cleanText(data.email),
    role: 'staff',
    status,
    createdBy,
    coadminUid: storedCoadminUid || coadminUid,
  };
}

async function readFirestoreStaffForCoadmin(coadminUid: string) {
  const snapshot = await adminDb
    .collection('users')
    .where('role', '==', 'staff')
    .where('status', '==', 'active')
    .get();

  return snapshot.docs
    .map((docSnap) => mapFirestoreStaffDoc(docSnap, coadminUid))
    .filter((row): row is PlayerVisibleStaff => Boolean(row))
    .sort((left, right) => left.username.localeCompare(right.username));
}

export async function readSafeStaffListForPlayerWithClient(
  client: PoolClient,
  coadminUid: string
): Promise<PlayerVisibleStaff[]> {
  const cleanCoadminUid = cleanText(coadminUid);
  if (!cleanCoadminUid) {
    return [];
  }

  const cached = await readUsersCacheByRoleWithClient(client, {
    role: 'staff',
    coadminUid: cleanCoadminUid,
    status: 'active',
  });
  return cached
    .map(toPlayerVisibleStaff)
    .filter((row): row is PlayerVisibleStaff => Boolean(row));
}

export async function resolvePlayerStaffList(coadminUid: string) {
  const cleanCoadminUid = cleanText(coadminUid);
  if (!cleanCoadminUid) {
    return { staff: [] as PlayerVisibleStaff[], source: 'postgres' as const };
  }

  try {
    const cached = await readUsersCacheByRole({
      role: 'staff',
      coadminUid: cleanCoadminUid,
      status: 'active',
    });
    if (cached !== null) {
      const staff = cached
        .map(toPlayerVisibleStaff)
        .filter((row): row is PlayerVisibleStaff => Boolean(row));
      return { staff, source: 'postgres' as const };
    }
  } catch (error) {
    console.warn('[PLAYER_STAFF_LIST] postgres read failed', {
      coadminUid: cleanCoadminUid,
      error,
    });
  }

  const staff = await readFirestoreStaffForCoadmin(cleanCoadminUid);
  return { staff, source: 'firestore' as const };
}
