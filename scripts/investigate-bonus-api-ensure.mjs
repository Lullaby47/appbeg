import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
const coadminUid = String(process.env.TEST_COADMIN_UID || 'pNaCcFpMHccu5l3TgLSKvldtrOB2').trim();
const playerUid = String(process.env.TEST_PLAYER_UID || '').trim();
const baseUrl = String(process.env.AUTOMATION_TICK_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const connectionString =
  String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
  'postgresql://appbeg_user:AppBeg2026Strong47@103.214.71.5:5432/appbeg';

async function activeCount(pool, uid) {
  const { rows } = await pool.query(
    `
      SELECT COUNT(*)::int AS count
      FROM public.bonus_events_cache
      WHERE deleted_at IS NULL
        AND trim(coalesce(coadmin_uid, '')) = $1
        AND lower(trim(coalesce(status, 'active'))) = 'active'
        AND (start_date IS NULL OR start_date <= now())
        AND (end_date IS NULL OR end_date >= now())
    `,
    [uid]
  );
  return rows[0]?.count ?? 0;
}

function loadServiceAccount() {
  const b64 = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 missing');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

async function getIdToken(uid) {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  }
  const customToken = await admin.auth().createCustomToken(uid);
  const apiKey = String(process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '').trim();
  if (!apiKey) throw new Error('NEXT_PUBLIC_FIREBASE_API_KEY missing');
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || 'Failed to exchange custom token');
  }
  return payload.idToken;
}

async function main() {
  const pool = new Pool({ connectionString });
  const before = await activeCount(pool, coadminUid);
  const coadminToken = await getIdToken(coadminUid);

  const listResponse = await fetch(
    `${baseUrl}/api/bonus-events/list?coadminUid=${encodeURIComponent(coadminUid)}`,
    {
      headers: { Authorization: `Bearer ${coadminToken}` },
      cache: 'no-store',
    }
  );
  const listBody = await listResponse.json().catch(() => ({}));

  let playerList = null;
  if (playerUid) {
    const playerToken = await getIdToken(playerUid);
    const playerListResponse = await fetch(
      `${baseUrl}/api/bonus-events/list?coadminUid=${encodeURIComponent(coadminUid)}`,
      {
        headers: { Authorization: `Bearer ${playerToken}` },
        cache: 'no-store',
      }
    );
    const playerListBody = await playerListResponse.json().catch(() => ({}));
    playerList = {
      playerUid,
      status: playerListResponse.status,
      eventCount: Array.isArray(playerListBody.events) ? playerListBody.events.length : null,
      filterReason: playerListBody.filterReason ?? null,
    };
  }

  const ensureResponse = await fetch(`${baseUrl}/api/coadmin/bonus-events/ensure-capacity`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${coadminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ activeCountHint: before }),
  });
  const ensureBody = await ensureResponse.json().catch(() => ({}));
  const after = await activeCount(pool, coadminUid);

  console.log(
    JSON.stringify(
      {
        coadminUid,
        list: {
          status: listResponse.status,
          eventCount: Array.isArray(listBody.events) ? listBody.events.length : null,
          filterReason: listBody.filterReason ?? null,
        },
        playerList,
        ensure: {
          status: ensureResponse.status,
          autoCreatedCount: ensureBody.autoCreatedCount ?? null,
          totalActive: ensureBody.totalActive ?? null,
          skipped: ensureBody.skipped ?? null,
        },
        activeCountBefore: before,
        activeCountAfter: after,
      },
      null,
      2
    )
  );

  await pool.end();
}

main().catch((error) => {
  console.error('[INVESTIGATE_BONUS_API_ENSURE] fatal', error);
  process.exitCode = 1;
});
