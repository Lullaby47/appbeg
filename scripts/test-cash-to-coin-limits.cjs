const CASH_TO_COIN_MAX_TRANSFER_AMOUNT = 25;
const CASH_TO_COIN_FEE_RATE = 0.02;
const CASH_TO_COIN_CASHOUT_LIMIT_FEE_RATE = 0.05;
const CASH_TO_COIN_COOLDOWN_MINUTES = 10;
const CASH_TO_COIN_DAILY_LIMIT = 300;

function fee(amount) {
  return Number((amount * CASH_TO_COIN_FEE_RATE).toFixed(2));
}

function cashoutLimitFee(amount) {
  return Number((amount * CASH_TO_COIN_CASHOUT_LIMIT_FEE_RATE).toFixed(2));
}

function validate(input) {
  if (input.cashoutLimitHit) {
    return {
      ok: true,
      transferAmount: input.amount,
      feeAmount: cashoutLimitFee(input.amount),
      coinsReceived: input.amount - cashoutLimitFee(input.amount),
      cashoutLimitHit: true,
    };
  }
  if (input.amount > CASH_TO_COIN_MAX_TRANSFER_AMOUNT) {
    return { ok: false, error: 'Maximum transfer amount is $25.' };
  }
  if (input.minutesSinceLastSuccessfulTransfer < CASH_TO_COIN_COOLDOWN_MINUTES) {
    return {
      ok: false,
      error: `Another transfer is available in ${
        CASH_TO_COIN_COOLDOWN_MINUTES - input.minutesSinceLastSuccessfulTransfer
      } minutes.`,
    };
  }
  if (input.existing24hTotal + input.amount > CASH_TO_COIN_DAILY_LIMIT) {
    return { ok: false, error: 'Daily transfer limit reached.' };
  }
  return {
    ok: true,
    transferAmount: input.amount,
    feeAmount: fee(input.amount),
    coinsReceived: input.amount - fee(input.amount),
  };
}

const tests = [
  {
    name: '$25 transfer returns 24.5 coins',
    actual: validate({ amount: 25, minutesSinceLastSuccessfulTransfer: 10, existing24hTotal: 0 }),
    expect: { ok: true, coinsReceived: 24.5 },
  },
  {
    name: '$26 transfer rejected',
    actual: validate({ amount: 26, minutesSinceLastSuccessfulTransfer: 10, existing24hTotal: 0 }),
    expect: { ok: false, error: 'Maximum transfer amount is $25.' },
  },
  {
    name: 'second transfer within 10 minutes rejected',
    actual: validate({ amount: 25, minutesSinceLastSuccessfulTransfer: 5, existing24hTotal: 25 }),
    expect: { ok: false, error: 'Another transfer is available in 5 minutes.' },
  },
  {
    name: 'transfer after 10 minutes allowed',
    actual: validate({ amount: 25, minutesSinceLastSuccessfulTransfer: 10, existing24hTotal: 25 }),
    expect: { ok: true, coinsReceived: 24.5 },
  },
  {
    name: '24 hour total exceeds $300 rejected',
    actual: validate({ amount: 25, minutesSinceLastSuccessfulTransfer: 10, existing24hTotal: 290 }),
    expect: { ok: false, error: 'Daily transfer limit reached.' },
  },
  {
    name: 'cashout limit hit allows $100 transfer with 5% fee',
    actual: validate({
      amount: 100,
      minutesSinceLastSuccessfulTransfer: 0,
      existing24hTotal: 300,
      cashoutLimitHit: true,
    }),
    expect: { ok: true, feeAmount: 5, coinsReceived: 95, cashoutLimitHit: true },
  },
];

const results = tests.map((test) => {
  const ok = Object.entries(test.expect).every(([key, value]) => test.actual[key] === value);
  return { ...test, ok };
});

console.log(JSON.stringify({ ok: results.every((result) => result.ok), results }, null, 2));
if (!results.every((result) => result.ok)) {
  process.exitCode = 1;
}
