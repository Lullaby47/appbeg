import { NextResponse } from 'next/server';
import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  REFERRAL_REWARD_COINS,
  SIGNUP_BONUS_COINS,
} from '@/lib/economy/policy';
import {
  buildUniqueReferralCodeCandidates,
  findFreeReferralCodeInTransaction,
  setReferralCodeIndexInTransaction,
} from '@/lib/referral/referralCodeAdmin';

type CreatableRole = 'staff' | 'carer' | 'player';

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

function isCreatableRole(role: string): role is CreatableRole {
  return ['staff', 'carer', 'player'].includes(role);
}

function parseReferralCodeInput(value: unknown) {
  const code = String(value || '').trim();
  if (!code) {
    return '';
  }
  if (!/^\d{6,10}$/.test(code)) {
    throw new Error('Invalid referral code.');
  }
  return code;
}

export async function POST(request: Request) {
  let createdAuthUid: string | null = null;
  try {
    const body = await request.json();

    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const createdBy = body.createdBy ? String(body.createdBy).trim() : null;
    const creatorUid = body.creatorUid ? String(body.creatorUid).trim() : null;
    const coadminUid = body.coadminUid ? String(body.coadminUid).trim() : null;
    const role = String(body.role || 'staff').trim().toLowerCase();
    const ownerCoadminUid = coadminUid || createdBy;
    let creatorRole = '';
    if (creatorUid) {
      const creatorSnap = await adminDb.collection('users').doc(creatorUid).get();
      if (creatorSnap.exists) {
        creatorRole = String((creatorSnap.data() as { role?: string }).role || '').toLowerCase();
      }
    }
    const createdByStaffId = role === 'player' && creatorRole === 'staff' ? creatorUid : null;

    let referralCodeInput = '';
    try {
      referralCodeInput = parseReferralCodeInput(body.referralCodeInput);
    } catch {
      return NextResponse.json({ error: 'Invalid referral code.' }, { status: 400 });
    }

    if (!username) {
      return NextResponse.json({ error: 'Username is required.' }, { status: 400 });
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters.' },
        { status: 400 }
      );
    }

    if (!isCreatableRole(role)) {
      return NextResponse.json({ error: 'Invalid user role.' }, { status: 400 });
    }

    if (!ownerCoadminUid) {
      return NextResponse.json(
        { error: 'coadminUid is required.' },
        { status: 400 }
      );
    }

    const usernameSnap = await adminDb
      .collection('users')
      .where('username', '==', username)
      .limit(1)
      .get();

    if (!usernameSnap.empty) {
      return NextResponse.json({ error: 'Username already exists.' }, { status: 409 });
    }

    let validatedReferrerUid: string | null = null;
    let validatedReferrerUsername: string | null = null;
    if (role === 'player' && referralCodeInput) {
      const referrerSnap = await adminDb
        .collection('users')
        .where('referralCode', '==', referralCodeInput)
        .where('role', '==', 'player')
        .limit(1)
        .get();

      if (referrerSnap.empty) {
        return NextResponse.json({ error: 'Invalid referral code.' }, { status: 400 });
      }

      const referrerDoc = referrerSnap.docs[0];
      validatedReferrerUid = referrerDoc.id;
      validatedReferrerUsername = String(referrerDoc.data().username || 'Player');
    }

    const email = makeHiddenEmail(username);

    const authUser = await adminAuth.createUser({
      email,
      password,
      displayName: username,
      disabled: false,
    });
    createdAuthUid = authUser.uid;

    const userRef = adminDb.collection('users').doc(authUser.uid);
    let referralApplied = false;
    let referralBonusCoins = 0;
    let referredByUid: string | null = null;
    let referredByUsername: string | null = null;
    let referredByCode: string | null = null;

    if (role === 'player') {
      const referralCandidates = buildUniqueReferralCodeCandidates(40);
      const now = new Date();

      await adminDb.runTransaction(async (transaction) => {
        let referrerRef: FirebaseFirestore.DocumentReference | null = null;
        let referrerData: FirebaseFirestore.DocumentData | null = null;

        if (validatedReferrerUid) {
          if (validatedReferrerUid === authUser.uid) {
            throw new Error('A player cannot refer themselves.');
          }
          referrerRef = adminDb.collection('users').doc(validatedReferrerUid);
          const referrerSnap = await transaction.get(referrerRef);
          if (!referrerSnap.exists) {
            throw new Error('Invalid referral code.');
          }
          referrerData = referrerSnap.data() || null;
          referralBonusCoins = REFERRAL_REWARD_COINS;
          referredByUid = validatedReferrerUid;
          referredByUsername =
            validatedReferrerUsername || String(referrerData?.username || 'Player');
          referredByCode = referralCodeInput;
          referralApplied = true;
        }

        const nextReferralCode = await findFreeReferralCodeInTransaction(
          adminDb,
          transaction,
          referralCandidates
        );
        if (!nextReferralCode) {
          throw new Error('Failed to generate a unique referral code. Please try again.');
        }
        setReferralCodeIndexInTransaction(adminDb, transaction, nextReferralCode, authUser.uid);

        transaction.set(userRef, {
          uid: authUser.uid,
          username,
          email,
          role,
          createdBy: ownerCoadminUid,
          coadminUid: ownerCoadminUid,
          createdAt: now,
          status: 'active',
          coin: SIGNUP_BONUS_COINS,
          cash: 0,
          promoLockedCoins: SIGNUP_BONUS_COINS,
          referralCode: nextReferralCode,
          referredByUid,
          referredByCode,
          referralBonusCoins: referralApplied ? referralBonusCoins : 0,
          referralCreatedAt: referralApplied ? now : null,
          referralRewardStatus: referralApplied ? 'pending_first_recharge' : null,
          referralQualifiedAt: null,
          referralRewardClaimedAt: null,
          createdByStaffId,
        });

        if (referrerRef && referrerData) {
          const referralLogRef = adminDb.collection('referrals').doc();
          transaction.set(referralLogRef, {
            referrerUid: referrerRef.id,
            referrerUsername: String(referrerData.username || 'Player'),
            referredPlayerUid: authUser.uid,
            referredPlayerUsername: username,
            referralCode: referralCodeInput,
            rewardCoins: referralBonusCoins,
            status: 'pending_first_recharge',
            createdAt: now,
            qualifiedAt: null,
            claimedAt: null,
          });
        }
      });
      createdAuthUid = null;
    } else {
      await userRef.set({
        uid: authUser.uid,
        username,
        email,
        role,
        createdBy: ownerCoadminUid,
        coadminUid: ownerCoadminUid,
        createdAt: new Date(),
        status: 'active',
      });
      createdAuthUid = null;
    }

    return NextResponse.json({
      success: true,
      uid: authUser.uid,
      message: `${role} created.`,
      referralApplied,
      referralBonusCoins,
      referredByUid,
      referredByUsername,
    });
  } catch (err: unknown) {
    if (createdAuthUid) {
      try {
        await adminAuth.deleteUser(createdAuthUid);
      } catch {
        // If cleanup fails, surface original error while avoiding secondary crash.
      }
    }
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Failed to create user.',
      },
      { status: 500 }
    );
  }
}
