import 'server-only';

export function parsePositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed !== Math.floor(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

export function parseTransferId(value: unknown) {
  const transferId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(transferId)) {
    return '';
  }
  return transferId;
}

export function getCashToCoinFee(amountNpr: number) {
  if (!Number.isFinite(amountNpr) || amountNpr <= 0) return 0;
  return Number((amountNpr * 0.02).toFixed(2));
}

export function getCoinToCashTip(amountCoins: number) {
  if (!Number.isFinite(amountCoins) || amountCoins <= 0) return 0;
  if (amountCoins <= 20) return 1;
  if (amountCoins > 200) return Number((amountCoins * 0.1).toFixed(2));
  if (amountCoins >= 150) return 10;
  if (amountCoins >= 100) return 8;
  if (amountCoins >= 40) return 4;
  if (amountCoins >= 30) return 3;
  if (amountCoins >= 20) return 2;
  if (amountCoins >= 10) return 1;
  return 0;
}
