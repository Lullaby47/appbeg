/** Fee on player-to-player coin rewards; must stay in sync with `/api/player/reward-coins`. */
export const REWARD_TRANSFER_FEE_PERCENT = 6;

/**
 * Sender spends `amountCoins` from balance; rounded-up percentage is withheld so it does not
 * credit the recipient. Edge case: sending 1 coin cannot apply a proportional fee — recipient keeps 1.
 */
export function computeRewardCoinsAfterFee(amountCoins: number): {
  feeCoins: number;
  recipientCoins: number;
} {
  const whole = Math.max(0, Math.floor(Number(amountCoins) || 0));
  if (whole <= 0) {
    return { feeCoins: 0, recipientCoins: 0 };
  }

  let feeCoins = Math.ceil((whole * REWARD_TRANSFER_FEE_PERCENT) / 100);
  if (feeCoins >= whole) {
    feeCoins = Math.max(0, whole - 1);
  }
  return { feeCoins, recipientCoins: whole - feeCoins };
}
