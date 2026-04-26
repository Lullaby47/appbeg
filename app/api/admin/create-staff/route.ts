import { NextResponse } from 'next/server';
import { adminAuth, adminDb } from '@/lib/firebase/admin';

type CreatableRole = 'staff' | 'carer' | 'player';

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

function isCreatableRole(role: string): role is CreatableRole {
  return ['staff', 'carer', 'player'].includes(role);
}

function randomInt(min: number, max: number) {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function generateCandidateReferralCode() {
  const length = randomInt(6, 10);
  let code = '';
  for (let index = 0; index < length; index += 1) {
    const digit = index === 0 ? randomInt(1, 9) : randomInt(0, 9);
    code += String(digit);
  }
  return code;
}

async function generateUniqueReferralCode() {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const code = generateCandidateReferralCode();
    const existing = await adminDb
      .collection('users')
      .where('referralCode', '==', code)
      .limit(1)
      .get();

    if (existing.empty) {
      return code;
    }
  }

  throw new Error('Failed to generate a unique referral code. Please try again.');
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
    const coadminUid = body.coadminUid ? String(body.coadminUid).trim() : null;
    const role = String(body.role || 'staff').trim().toLowerCase();
    const ownerCoadminUid = coadminUid || createdBy;
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
      const referralCode = await generateUniqueReferralCode();
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
          referralBonusCoins = randomInt(5, 15);
          referredByUid = validatedReferrerUid;
          referredByUsername =
            validatedReferrerUsername || String(referrerData?.username || 'Player');
          referredByCode = referralCodeInput;
          referralApplied = true;
        }

        transaction.set(userRef, {
          uid: authUser.uid,
          username,
          email,
          role,
          createdBy: ownerCoadminUid,
          coadminUid: ownerCoadminUid,
          createdAt: now,
          status: 'active',
          coin: 0,
          cash: 0,
          referralCode,
          referredByUid,
          referredByCode,
          referralBonusCoins: referralApplied ? referralBonusCoins : 0,
          referralCreatedAt: referralApplied ? now : null,
        });

        if (referrerRef && referrerData) {
          const nextReferrerCoin = Number(referrerData.coin || 0) + referralBonusCoins;
          transaction.update(referrerRef, {
            coin: nextReferrerCoin,
            referralBonusNotice: 'Your referral was successful. Referral bonus has been added.',
            referralBonusNoticeAt: now,
          });

          const referralLogRef = adminDb.collection('referrals').doc();
          transaction.set(referralLogRef, {
            referrerUid: referrerRef.id,
            referrerUsername: String(referrerData.username || 'Player'),
            referredPlayerUid: authUser.uid,
            referredPlayerUsername: username,
            referralCode: referralCodeInput,
            rewardCoins: referralBonusCoins,
            createdAt: now,
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
