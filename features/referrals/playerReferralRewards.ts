import { auth } from '@/lib/firebase/client';

export type ReferralRewardRow = {
  rechargeId: string;
  rechargeAmount: number;
  rechargeTypeLabel: 'Normal recharge' | 'Bonus event recharge';
  bonusPercentage: number | null;
  rewardCoins: number;
  claimStatus: 'pending' | 'claimed' | 'ineligible';
  canClaim: boolean;
  claimedAt: string | null;
  ineligibleReason: string | null;
};

export type ReferralRewardGroup = {
  referredPlayerUid: string;
  referredPlayerName: string;
  pendingRewardCoins: number;
  hasClaimableReward: boolean;
};

async function getAuthHeader() {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const idToken = await currentUser.getIdToken();
  return {
    Authorization: `Bearer ${idToken}`,
    'Content-Type': 'application/json',
  };
}

export async function fetchMyReferralRewards() {
  const headers = await getAuthHeader();
  const response = await fetch('/api/player/referral-rewards', {
    method: 'GET',
    headers,
  });
  const data = (await response.json()) as {
    error?: string;
    groups?: ReferralRewardGroup[];
  };
  if (!response.ok) {
    throw new Error(data.error || 'Failed to load referral rewards.');
  }
  return data.groups || [];
}

export async function claimMyReferralReward(referredPlayerUid: string) {
  const headers = await getAuthHeader();
  const response = await fetch('/api/player/referral-rewards', {
    method: 'POST',
    headers,
    body: JSON.stringify({ referredPlayerUid }),
  });
  const data = (await response.json()) as {
    error?: string;
    rewardCoins?: number;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(data.error || 'Failed to claim referral reward.');
  }
  return {
    rewardCoins: Number(data.rewardCoins || 0),
    message:
      data.message ||
      "Congratulations! You received referral reward coins from this player's recharge.",
  };
}
