const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');

const clean = (v) => String(v || '').trim();
function req(n) {
  const v = clean(process.env[n]);
  if (!v) throw new Error(`${n} is required`);
  return v;
}

function initFirebase() {
  const s = JSON.parse(Buffer.from(req('FIREBASE_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8'));
  return getApps()[0] || initializeApp({ credential: cert(s) });
}

function balanceRowFs(doc) {
  const d = doc.data() || {};
  return {
    uid: doc.id,
    coin: Math.max(0, Math.floor(Number(d.coin || 0))),
    cash: Math.max(0, Math.floor(Number(d.cash || 0))),
    role: clean(d.role) || 'player',
  };
}

function balanceRowSql(r) {
  return {
    uid: clean(r.uid),
    coin: Math.max(0, Math.floor(Number(r.coin || 0))),
    cash: Math.max(0, Math.floor(Number(r.cash || 0))),
    role: clean(r.role) || 'player',
  };
}

function diffBalances(a, b) {
  const fields = {};
  if (a.coin !== b.coin) fields.coin = { firebase: a.coin, sql: b.coin };
  if (a.cash !== b.cash) fields.cash = { firebase: a.cash, sql: b.cash };
  if (a.role !== b.role) fields.role = { firebase: a.role, sql: b.role };
  return fields;
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pg = new Pool({
    connectionString: clean(process.env.DATABASE_URL || process.env.POSTGRES_URL) || req('DATABASE_URL'),
  });

  const [fsSnap, sqlResult] = await Promise.all([
    db.collection('users').where('role', '==', 'player').get(),
    pg.query(`
      SELECT uid, coin, cash, role
      FROM public.players_cache
      WHERE deleted_at IS NULL
        AND role = 'player'
    `),
  ]);

  const firebaseByUid = new Map(fsSnap.docs.map((d) => [d.id, balanceRowFs(d)]));
  const sqlByUid = new Map(sqlResult.rows.map((r) => [String(r.uid), balanceRowSql(r)]));

  const missing_in_sql = [];
  const extra_in_sql = [];
  const mismatched_balances = [];

  for (const [uid, fb] of firebaseByUid) {
    const sql = sqlByUid.get(uid);
    if (!sql) {
      missing_in_sql.push(uid);
      continue;
    }
    const fields = diffBalances(fb, sql);
    if (Object.keys(fields).length) {
      mismatched_balances.push({ uid, fields });
    }
  }

  for (const uid of sqlByUid.keys()) {
    if (!firebaseByUid.has(uid)) extra_in_sql.push(uid);
  }

  await pg.end();
  console.log(
    JSON.stringify(
      {
        script: 'compare-players-cache-balances',
        firebase_player_count: firebaseByUid.size,
        postgres_player_count: sqlByUid.size,
        missing_in_sql,
        extra_in_sql,
        mismatched_balances,
        ok:
          missing_in_sql.length === 0 &&
          extra_in_sql.length === 0 &&
          mismatched_balances.length === 0,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[COMPARE_PLAYERS_CACHE_BALANCES] fatal', e);
  process.exitCode = 1;
});
