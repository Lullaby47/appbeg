import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import {
  CoadminScopedRecord,
  getCurrentUserCoadminUid,
  resolveCoadminUid,
} from '@/lib/coadmin/scope';

export type CoadminUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'coadmin';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  /** Reference images for player “Load coin” flow. */
  paymentDetailPhotoUrls?: string[] | null;
  paymentDetailPhotos?: Array<{
    imageUrl: string;
    imagePublicId: string;
  }> | null;
  createdAt?: any;
};

export type StaffUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'staff';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  createdAt?: any;
};

export type CarerUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'carer';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  paymentQrUrl?: string | null;
  paymentQrPublicId?: string | null;
  paymentDetails?: string | null;
  cashBoxNpr?: number;
  createdAt?: any;
};

export type PlayerUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'player';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  createdAt?: any;
};

export type ManagedUser = StaffUser | CarerUser | PlayerUser;
let playerReferralBackfillAttempted = false;

async function parseApiResponse(response: Response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text || 'Server returned invalid response.');
  }
}

async function normalizeUsersWithCoadminUid<
  T extends {
    id: string;
    uid: string;
    role: string;
    createdBy: string | null;
    coadminUid?: string | null;
  }
>(users: T[]) {
  const creatorIds = Array.from(
    new Set(
      users
        .filter((user) => !user.coadminUid && user.createdBy)
        .map((user) => String(user.createdBy))
    )
  );

  if (creatorIds.length === 0) {
    return users;
  }

  const creatorEntries = await Promise.all(
    creatorIds.map(async (creatorId) => {
      const creatorSnap = await getDoc(doc(db, 'users', creatorId));

      if (!creatorSnap.exists()) {
        return [creatorId, null] as const;
      }

      const creatorData = creatorSnap.data() as CoadminScopedRecord;
      const creatorCoadminUid = resolveCoadminUid({
        uid: creatorSnap.id,
        ...creatorData,
      });

      return [creatorId, creatorCoadminUid] as const;
    })
  );

  const creatorMap = new Map(creatorEntries);

  return users.map((user) => {
    if (user.coadminUid) {
      return user;
    }

    const inferredCoadminUid =
      (user.createdBy && creatorMap.get(user.createdBy)) || null;

    if (!inferredCoadminUid) {
      return user;
    }

    return {
      ...user,
      coadminUid: inferredCoadminUid,
    };
  });
}

async function getUsersByRole<T extends ManagedUser | CoadminUser>(
  role: T['role']
): Promise<T[]> {
  const q = query(collection(db, 'users'), where('role', '==', role));
  const snapshot = await getDocs(q);

  const users = snapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Omit<T, 'id'>),
  }));

  return normalizeUsersWithCoadminUid(users as T[]);
}

async function backfillPlayerReferralCodesIfNeeded() {
  if (playerReferralBackfillAttempted) {
    return;
  }

  playerReferralBackfillAttempted = true;
  try {
    await fetch('/api/admin/backfill-player-referrals', { method: 'POST' });
  } catch {
    // Non-blocking best-effort backfill.
  }
}

async function createManagedUser(
  username: string,
  password: string,
  role: 'staff' | 'carer' | 'player',
  referralCodeInput?: string
) {
  const cleanUsername = username.trim().toLowerCase();

  if (!cleanUsername) throw new Error('Username is required.');
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const coadminUid = await getCurrentUserCoadminUid();

  const response = await fetch('/api/admin/create-staff', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: cleanUsername,
      password,
      role,
      createdBy: coadminUid,
      coadminUid,
      ...(role === 'player'
        ? { referralCodeInput: String(referralCodeInput || '').trim() || null }
        : {}),
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || `Failed to create ${role}.`);
  }

  return data;
}

async function deleteManagedUser(user: ManagedUser) {
  const currentUser = auth.currentUser;
  const response = await fetch('/api/admin/delete-user', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      uid: user.uid,
      deletedByUid: currentUser?.uid || null,
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to delete user.');
  }

  return data;
}

export type DeletedPlayerRecord = {
  uid: string;
  username: string;
  email: string;
  status?: string;
  createdBy?: string | null;
  coadminUid?: string | null;
  coin?: number;
  cash?: number;
  role: 'player';
  deletedAt?: string;
  deletedByUid?: string | null;
};

export async function getDeletedPlayers(): Promise<DeletedPlayerRecord[]> {
  const response = await fetch('/api/admin/player-archive', {
    method: 'GET',
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load deleted players.');
  }

  return (data.players || []) as DeletedPlayerRecord[];
}

export async function recreateDeletedPlayer(uid: string) {
  const response = await fetch('/api/admin/player-archive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uid }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to recreate player.');
  }

  return data;
}

export async function deletePlayerForever(uid: string) {
  const response = await fetch('/api/admin/player-archive', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uid }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to permanently delete player.');
  }

  return data;
}

async function setManagedUserStatus(
  uid: string,
  status: 'active' | 'disabled'
) {
  const response = await fetch('/api/admin/set-user-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      uid,
      status,
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to update user status.');
  }

  return data;
}

export async function getStaff(): Promise<StaffUser[]> {
  return getUsersByRole<StaffUser>('staff');
}

export async function createStaff(username: string, password: string) {
  return createManagedUser(username, password, 'staff');
}

export async function deleteStaff(staff: StaffUser) {
  return deleteManagedUser(staff);
}

export async function blockStaff(staff: StaffUser) {
  return setManagedUserStatus(staff.uid, 'disabled');
}

export async function unblockStaff(staff: StaffUser) {
  return setManagedUserStatus(staff.uid, 'active');
}

export async function getCarers(): Promise<CarerUser[]> {
  return getUsersByRole<CarerUser>('carer');
}

export async function createCarer(username: string, password: string) {
  return createManagedUser(username, password, 'carer');
}

export async function deleteCarer(carer: CarerUser) {
  return deleteManagedUser(carer);
}

export async function blockCarer(carer: CarerUser) {
  return setManagedUserStatus(carer.uid, 'disabled');
}

export async function unblockCarer(carer: CarerUser) {
  return setManagedUserStatus(carer.uid, 'active');
}

export async function getPlayers(): Promise<PlayerUser[]> {
  await backfillPlayerReferralCodesIfNeeded();
  return getUsersByRole<PlayerUser>('player');
}

export async function createPlayer(
  username: string,
  password: string,
  referralCodeInput?: string
) {
  return createManagedUser(username, password, 'player', referralCodeInput);
}

export async function deletePlayer(player: PlayerUser) {
  return deleteManagedUser(player);
}

export async function blockPlayer(player: PlayerUser) {
  return setManagedUserStatus(player.uid, 'disabled');
}

export async function unblockPlayer(player: PlayerUser) {
  return setManagedUserStatus(player.uid, 'active');
}

export async function getCoadmins(): Promise<CoadminUser[]> {
  return getUsersByRole<CoadminUser>('coadmin');
}

export async function createCoadmin(username: string, password: string) {
  const cleanUsername = username.trim().toLowerCase();

  if (!cleanUsername) throw new Error('Username is required.');
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const response = await fetch('/api/admin/create-coadmin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: cleanUsername,
      password,
      createdBy: currentUser.uid,
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create co-admin.');
  }

  return data;
}

export async function deleteCoadmin(coadmin: CoadminUser) {
  const response = await fetch('/api/admin/delete-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid: coadmin.uid,
    }),
  });

  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to delete co-admin.');
  }

  return data;
}

export async function blockCoadmin(coadmin: CoadminUser) {
  return setManagedUserStatus(coadmin.uid, 'disabled');
}

export async function unblockCoadmin(coadmin: CoadminUser) {
  return setManagedUserStatus(coadmin.uid, 'active');
}
