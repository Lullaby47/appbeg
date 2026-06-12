const COOLDOWN_MS = 30 * 60_000;

function tip(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (amount <= 20) return 1;
  if (amount > 200) return Number((amount * 0.1).toFixed(2));
  if (amount >= 150) return 10;
  if (amount >= 100) return 8;
  if (amount >= 40) return 4;
  if (amount >= 30) return 3;
  if (amount >= 20) return 2;
  if (amount >= 10) return 1;
  return 0;
}

function blockedByCooldown(nowMs, lastTransferAtMs) {
  const remainingWaitMs = COOLDOWN_MS - (nowMs - lastTransferAtMs);
  return {
    blocked: lastTransferAtMs > 0 && remainingWaitMs > 0,
    remainingWaitMs: Math.max(0, remainingWaitMs),
  };
}

const baseMs = Date.parse('2026-06-12T09:30:00.000Z');
const tests = [
  {
    name: 'amount <= 20 deducts exactly 1',
    result: tip(20),
    ok: tip(20) === 1,
  },
  {
    name: 'amount > 200 deducts 10 percent',
    result: tip(250),
    ok: tip(250) === 25,
  },
  {
    name: 'amount > 20 and <= 200 keeps existing tier',
    result: tip(100),
    ok: tip(100) === 8,
  },
  {
    name: 'second transfer within 30 minutes rejected',
    result: blockedByCooldown(baseMs, baseMs - 20 * 60_000),
    ok: blockedByCooldown(baseMs, baseMs - 20 * 60_000).blocked,
  },
  {
    name: 'transfer after 30 minutes allowed',
    result: blockedByCooldown(baseMs, baseMs - 30 * 60_000),
    ok: !blockedByCooldown(baseMs, baseMs - 30 * 60_000).blocked,
  },
];

console.log(
  JSON.stringify(
    {
      script: 'test-coin-to-cash-rules',
      tests,
      ok: tests.every((test) => test.ok),
    },
    null,
    2
  )
);

if (!tests.every((test) => test.ok)) {
  process.exitCode = 1;
}
