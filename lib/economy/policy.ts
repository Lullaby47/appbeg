export const SIGNUP_BONUS_COINS = 15;
export const REFERRAL_REWARD_COINS = 5;
export const MIN_WITHDRAWAL_NPR = 1000;

export type WithdrawalPolicyInput = {
  amountNpr: number;
  completedWithdrawalCount: number;
  lastRechargeAmountNpr: number;
};

export type WithdrawalPolicyDecision = {
  allowed: boolean;
  code: 'ok' | 'minimum_withdrawal' | 'possible_bonus_abuse';
  message: string;
};

function toWhole(value: unknown) {
  const parsed = Math.floor(Number(value) || 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function getLockedPromoCoins(value: unknown) {
  return toWhole(value);
}

export function getTransferableCoinBalance(totalCoins: unknown, lockedPromoCoins: unknown) {
  return Math.max(0, toWhole(totalCoins) - getLockedPromoCoins(lockedPromoCoins));
}

export function evaluateWithdrawalPolicy(
  input: WithdrawalPolicyInput
): WithdrawalPolicyDecision {
  const amountNpr = toWhole(input.amountNpr);
  const completedWithdrawalCount = toWhole(input.completedWithdrawalCount);
  const lastRechargeAmountNpr = toWhole(input.lastRechargeAmountNpr);

  if (amountNpr < MIN_WITHDRAWAL_NPR) {
    return {
      allowed: false,
      code: 'minimum_withdrawal',
      message: `Minimum withdrawal is ${MIN_WITHDRAWAL_NPR}.`,
    };
  }

  if (
    completedWithdrawalCount > 0 &&
    lastRechargeAmountNpr > 0 &&
    amountNpr >= lastRechargeAmountNpr
  ) {
    return {
      allowed: false,
      code: 'possible_bonus_abuse',
      message: 'Possible Bonus Abuse',
    };
  }

  return {
    allowed: true,
    code: 'ok',
    message: 'Withdrawal allowed.',
  };
}

export function isReferralRechargeEligible(values: {
  bonusEventId?: string | null;
  bonusPercentage?: number | null;
}) {
  const bonusEventId = String(values.bonusEventId || '').trim();
  if (!bonusEventId) {
    return true;
  }

  const bonusPercentage = Number(values.bonusPercentage || 0);
  return Number.isFinite(bonusPercentage) && bonusPercentage <= 10;
}
