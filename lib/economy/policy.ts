export const SIGNUP_BONUS_COINS = 15;
export const REFERRAL_REWARD_COINS = 5;
/** Rolling 24-hour maximum cashout total — not a per-request minimum. */
export const MAX_ROLLING_CASHOUT_NPR_PER_24_H = 1000;

export type WithdrawalPolicyInput = {
  amountNpr: number;
  completedWithdrawalCount: number;
  lastRechargeAmountNpr: number;
};

export type WithdrawalPolicyDecision = {
  allowed: boolean;
  code: 'ok' | 'possible_bonus_abuse';
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
  _input: WithdrawalPolicyInput
): WithdrawalPolicyDecision {
  void _input;
  // TODO: Replace this with a source-aware withdrawal policy once callers pass
  // cash-source breakdowns. The old amount-vs-last-recharge heuristic caused
  // false positives for valid redeem winnings after tiny later recharges.

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
