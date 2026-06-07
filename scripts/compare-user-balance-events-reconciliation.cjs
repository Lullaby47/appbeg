const { Pool } = require('pg');

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function clean(value) {
  return String(value || '').trim();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createPgPool() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (connectionString) return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  return new Pool({
    host: clean(process.env.APPBEG_PG_HOST || '127.0.0.1'),
    port: Number(process.env.APPBEG_PG_PORT || '5433'),
    database: clean(process.env.APPBEG_PG_DATABASE || 'appbeg'),
    user: clean(process.env.APPBEG_PG_USER || 'appbeg_user'),
    password: requiredEnv('APPBEG_PG_PASSWORD'),
    connectionTimeoutMillis: 10_000,
  });
}

function round(value) {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value) * 100000000) / 100000000;
}

function emptyBalances() {
  return {
    coin: null,
    cash: null,
    cashBoxNpr: null,
    promoLockedCoins: null,
    referralBonusCoins: null,
  };
}

function emptyDeltas() {
  return {
    coin: 0,
    cash: 0,
    cashBoxNpr: 0,
    promoLockedCoins: 0,
    referralBonusCoins: 0,
  };
}

function classify(snapshot, baseline, derivedDeltas, residualDeltas, eventCount) {
  if (eventCount === 0) return 'ledger_missing';
  let hasSnapshot = false;
  let hasBaseline = false;
  let hasDerived = false;
  let hasMismatch = false;

  for (const balanceType of Object.keys(snapshot)) {
    const snapshotValue = snapshot[balanceType];
    if (snapshotValue == null) continue;
    hasSnapshot = true;
    if (baseline[balanceType] != null) hasBaseline = true;
    if (derivedDeltas[balanceType] !== 0) hasDerived = true;

    const ledgerValue = baseline[balanceType] != null
      ? baseline[balanceType] + residualDeltas[balanceType]
      : derivedDeltas[balanceType] + residualDeltas[balanceType];
    if (round(ledgerValue) !== round(snapshotValue)) hasMismatch = true;
  }

  if (!hasSnapshot) return 'snapshot_missing';
  if (!hasBaseline && !hasDerived) return 'ledger_missing';
  if (hasMismatch && !hasBaseline) return 'missing_source';
  if (hasMismatch) return 'mismatch';
  if (hasBaseline && !hasDerived) return 'explained_by_baseline';
  return 'matched';
}

async function main() {
  const pool = createPgPool();
  const [snapshotResult, eventResult] = await Promise.all([
    pool.query('SELECT * FROM public.user_balance_snapshots_cache WHERE deleted_at IS NULL'),
    pool.query('SELECT * FROM public.user_balance_events WHERE deleted_at IS NULL'),
  ]);

  const snapshots = new Map();
  for (const row of snapshotResult.rows) {
    snapshots.set(clean(row.firebase_id), {
      user_uid: clean(row.firebase_id),
      username: clean(row.username),
      role: clean(row.role),
      coadmin_uid: clean(row.coadmin_uid),
      balances: {
        coin: num(row.coin),
        cash: num(row.cash),
        cashBoxNpr: num(row.cash_box_npr),
        promoLockedCoins: num(row.promo_locked_coins),
        referralBonusCoins: num(row.referral_bonus_coins),
      },
    });
  }

  const ledger = new Map();
  for (const event of eventResult.rows) {
    const userUid = clean(event.user_uid);
    if (!ledger.has(userUid)) {
      ledger.set(userUid, {
        baseline: emptyBalances(),
        derivedDeltas: emptyDeltas(),
        residualDeltas: emptyDeltas(),
        eventCount: 0,
        countsByConfidence: {},
      });
    }
    const bucket = ledger.get(userUid);
    const balanceType = clean(event.balance_type);
    const value = num(event.absolute_after);
    const delta = num(event.delta) || 0;
    bucket.eventCount += 1;
    bucket.countsByConfidence[event.confidence] = (bucket.countsByConfidence[event.confidence] || 0) + 1;

    if (event.is_baseline && value != null) bucket.baseline[balanceType] = value;
    else if (event.is_residual_adjustment) bucket.residualDeltas[balanceType] += delta;
    else bucket.derivedDeltas[balanceType] += delta;
  }

  const userIds = new Set([...snapshots.keys(), ...ledger.keys()]);
  const rows = [];
  const classifications = {};

  for (const userUid of userIds) {
    const snapshot = snapshots.get(userUid);
    const userLedger = ledger.get(userUid) || {
      baseline: emptyBalances(),
      derivedDeltas: emptyDeltas(),
      residualDeltas: emptyDeltas(),
      eventCount: 0,
      countsByConfidence: {},
    };
    const snapshotBalances = snapshot?.balances || emptyBalances();
    const classification = snapshot
      ? classify(snapshotBalances, userLedger.baseline, userLedger.derivedDeltas, userLedger.residualDeltas, userLedger.eventCount)
      : 'snapshot_missing';
    classifications[classification] = (classifications[classification] || 0) + 1;

    const row = {
      user_uid: userUid,
      username: snapshot?.username || null,
      role: snapshot?.role || null,
      coadmin_uid: snapshot?.coadmin_uid || null,
      classification,
      event_count: userLedger.eventCount,
      counts_by_confidence: userLedger.countsByConfidence,
    };

    for (const balanceType of Object.keys(snapshotBalances)) {
      const snapshotValue = snapshotBalances[balanceType];
      const baselineValue = userLedger.baseline[balanceType];
      const ledgerValue = baselineValue != null
        ? baselineValue + userLedger.residualDeltas[balanceType]
        : userLedger.derivedDeltas[balanceType] + userLedger.residualDeltas[balanceType];
      row[`snapshot_${balanceType}`] = snapshotValue;
      row[`baseline_${balanceType}`] = baselineValue;
      row[`derived_delta_${balanceType}`] = round(userLedger.derivedDeltas[balanceType]);
      row[`residual_delta_${balanceType}`] = round(userLedger.residualDeltas[balanceType]);
      row[`ledger_${balanceType}`] = round(ledgerValue);
      row[`difference_${balanceType}`] = snapshotValue == null ? null : round(ledgerValue - snapshotValue);
    }
    rows.push(row);
  }

  rows.sort((a, b) => {
    if (a.classification !== b.classification) return a.classification.localeCompare(b.classification);
    return a.user_uid.localeCompare(b.user_uid);
  });

  await pool.end();
  console.log(JSON.stringify({
    user_balance_snapshots_count: snapshots.size,
    user_balance_events_count: eventResult.rows.length,
    classifications,
    rows,
  }, null, 2));
}

main().catch((error) => {
  console.error('[COMPARE_USER_BALANCE_EVENTS_RECONCILIATION] fatal', error);
  process.exitCode = 1;
});
