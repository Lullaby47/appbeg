import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  findUniqueReferralCodeWithQueries,
  isReferralCodeReusableByPlayer,
  isValidReferralCodeString,
  REFERRAL_CODE_INDEX,
} from '@/lib/referral/referralCodeAdmin';

type DeletedPlayerDoc = {
  uid: string;
  username: string;
  email: string;
  role: 'player';
  status?: string;
  createdBy?: string | null;
  coadminUid?: string | null;
  coin?: number;
  cash?: number;
  referralCode?: string;
  referredByUid?: string | null;
  referredByCode?: string | null;
  referralBonusCoins?: number;
  referralCreatedAt?: string | null;
  deletedAt?: string;
  deletedByUid?: string | null;
};

function defaultPasswordFor(username: string) {
  const clean = (username || 'player').replace(/[^a-zA-Z0-9]/g, '');
  return `${clean || 'player'}@12345`;
}

export async function GET() {
  try {
    const snapshot = await adminDb
      .collection('deletedPlayers')
      .where('role', '==', 'player')
      .get();

    const players = snapshot.docs
      .map((docSnap) => docSnap.data() as DeletedPlayerDoc)
      .sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));

    return NextResponse.json({ success: true, players });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to load deleted players.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const uid = String(body.uid || '').trim();

    if (!uid) {
      return NextResponse.json({ error: 'Player uid is required.' }, { status: 400 });
    }

    const deletedRef = adminDb.collection('deletedPlayers').doc(uid);
    const deletedSnap = await deletedRef.get();

    if (!deletedSnap.exists) {
      return NextResponse.json({ error: 'Deleted player not found.' }, { status: 404 });
    }

    const deletedData = deletedSnap.data() as DeletedPlayerDoc;
    const username = String(deletedData.username || '').trim().toLowerCase();
    const email = String(deletedData.email || `${username}@app.local`).trim().toLowerCase();

    if (!username) {
      return NextResponse.json({ error: 'Deleted player username is invalid.' }, { status: 400 });
    }

    const activeUserRef = adminDb.collection('users').doc(uid);
    const activeUserSnap = await activeUserRef.get();

    if (activeUserSnap.exists) {
      return NextResponse.json({ error: 'Player already active.' }, { status: 409 });
    }

    const defaultPassword = defaultPasswordFor(username);
    const referralCodeFromArchive = String(deletedData.referralCode || '').trim();
    let referralCode: string;
    if (
      isValidReferralCodeString(referralCodeFromArchive) &&
      (await isReferralCodeReusableByPlayer(adminDb, referralCodeFromArchive, uid))
    ) {
      referralCode = referralCodeFromArchive;
    } else {
      referralCode = await findUniqueReferralCodeWithQueries(adminDb);
    }

    try {
      await adminAuth.createUser({
        uid,
        email,
        password: defaultPassword,
        displayName: username,
        disabled: false,
      });
    } catch (error: any) {
      if (error?.code === 'auth/email-already-exists') {
        return NextResponse.json(
          { error: 'Email is already in use. Contact admin for manual restore.' },
          { status: 409 }
        );
      }

      if (error?.code === 'auth/uid-already-exists') {
        await adminAuth.updateUser(uid, {
          email,
          password: defaultPassword,
          displayName: username,
          disabled: false,
        });
      } else {
        throw error;
      }
    }

    await activeUserRef.set({
      uid,
      username,
      email,
      role: 'player',
      status: deletedData.status || 'active',
      createdBy: deletedData.createdBy || null,
      coadminUid: deletedData.coadminUid || null,
      coin: Number(deletedData.coin || 0),
      cash: Number(deletedData.cash || 0),
      referralCode,
      referredByUid: deletedData.referredByUid || null,
      referredByCode: deletedData.referredByCode || null,
      referralBonusCoins: Number(deletedData.referralBonusCoins || 0),
      referralCreatedAt: deletedData.referralCreatedAt || null,
      createdAt: new Date(),
      restoredAt: new Date(),
    });

    await adminDb
      .collection(REFERRAL_CODE_INDEX)
      .doc(referralCode)
      .set(
        { playerUid: uid, createdAt: FieldValue.serverTimestamp() },
        { merge: true }
      );

    await deletedRef.delete();

    return NextResponse.json({
      success: true,
      message: 'Player recreated successfully.',
      temporaryPassword: defaultPassword,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to recreate player.' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const uid = String(body.uid || '').trim();

    if (!uid) {
      return NextResponse.json({ error: 'Player uid is required.' }, { status: 400 });
    }

    await adminDb.collection('deletedPlayers').doc(uid).delete();

    return NextResponse.json({
      success: true,
      message: 'Deleted player archive removed permanently.',
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to delete player archive.' },
      { status: 500 }
    );
  }
}
