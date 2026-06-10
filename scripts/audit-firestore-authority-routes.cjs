/**
 * Static audit: API routes with Firestore writes and SQL authority classification.
 *
 * Usage:
 *   node scripts/audit-firestore-authority-routes.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'app', 'api');
const clean = (v) => String(v || '').trim();

const ROUTE_CLASSIFICATION = [
  { route: '/api/cashout-tasks/start', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/cashout-tasks/complete', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/cashout-tasks/decline', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/player/cashout-tasks/create', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/admin/set-user-status', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/admin/create-coadmin', classification: 'migrate_now_sql_authority', status: 'sql_gated_firestore_mirror_blocked' },
  { route: '/api/admin/create-staff', classification: 'migrate_now_sql_authority', status: 'sql_gated_firestore_mirror_blocked' },
  { route: '/api/admin/delete-user', classification: 'migrate_now_sql_authority', status: 'sql_gated_firestore_mirror_blocked' },
  { route: '/api/admin/reset-user-password', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/admin/carer-creation-requests', classification: 'migrate_now_sql_authority', status: 'sql_gated_firestore_mirror_blocked' },
  { route: '/api/coadmin/reset-worker-credentials', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/admin/transfer-player-coadmin', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/admin/player-archive', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/admin/backfill-player-referrals', classification: 'dev_backfill_skipped', status: 'sql_authority_skipped' },
  { route: '/api/coadmin/request-carer', classification: 'migrate_now_sql_authority', status: 'sql_gated_firestore_mirror_blocked' },
  { route: '/api/game-logins/cache', classification: 'remove_legacy_firestore_branch', status: 'read_fallback_sql_blocked' },
  { route: '/api/player/ensure-referral-code', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/coadmin/bonus-events/update-range', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/coadmin/bonus-events/ensure-capacity', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/coadmin/freeplay/give', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/coadmin/player-balance/adjust', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/coadmin/behaviours', classification: 'remove_legacy_firestore_branch', status: 'read_fallback_sql_blocked' },
  { route: '/api/coadmin/players/[playerUid]/history', classification: 'remove_legacy_firestore_branch', status: 'read_fallback_sql_blocked' },
  { route: '/api/coadmin/impersonate-staff', classification: 'firebase_auth_keep', status: 'sql_gated_firestore_mirror_blocked' },
  { route: '/api/carer/automation-agent', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/carer/cashouts', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/player/reset-password', classification: 'firebase_auth_keep', status: 'sql_gated_firestore_mirror_blocked' },
  { route: '/api/player/reward-coins', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/risk/transfer-requests/approve', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/coadmin/workers/cut-reward', classification: 'migrate_now_sql_authority', status: 'sql_gated' },
  { route: '/api/bonus-events/list', classification: 'remove_legacy_firestore_branch', status: 'read_fallback_sql_blocked' },
  { route: '/api/coadmin/bonus-events/cache', classification: 'remove_legacy_firestore_branch', status: 'read_fallback_sql_blocked' },
  { route: '/api/bonus-events/cache/mirror', classification: 'legacy_flag_off_only', status: 'mirror_firestore_read_when_flag_off' },
  { route: '/api/conversations/cache/mirror', classification: 'legacy_flag_off_only', status: 'mirror_firestore_read_when_flag_off' },
  { route: '/api/chat/messages/cache/mirror', classification: 'legacy_flag_off_only', status: 'mirror_firestore_read_when_flag_off' },
  { route: '/api/user-presence/cache/mirror', classification: 'legacy_flag_off_only', status: 'mirror_firestore_read_when_flag_off' },
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name === 'route.ts') files.push(full);
  }
  return files;
}

function routePathFromFile(filePath) {
  const rel = path.relative(path.join(ROOT, '..'), filePath).replace(/\\/g, '/');
  const apiIdx = rel.indexOf('api/');
  if (apiIdx < 0) return rel;
  const suffix = rel.slice(apiIdx + 4).replace(/\/route\.ts$/, '');
  return `/api/${suffix}`;
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const route = routePathFromFile(filePath);
  const hasFirestoreWrite =
    /\.set\(|\.update\(|\.delete\(|runTransaction|batch\(|collection\(/.test(content) &&
    /adminDb/.test(content);
  const hasAuthorityGate =
    /isAuthoritySqlWriteEnabled/.test(content) || /isCacheSqlAuthoritative/.test(content);
  const hasFirestoreTouch = /logFirestoreTouch|FIRESTORE_TOUCH/.test(content);
  const classified = ROUTE_CLASSIFICATION.find((row) => row.route === route);
  return {
    route,
    hasFirestoreWrite,
    hasAuthorityGate,
    hasFirestoreTouch,
    classification: classified?.classification || (hasFirestoreWrite ? 'review_needed' : 'no_firestore_write'),
    migrationStatus: classified?.status || (hasAuthorityGate ? 'sql_gated_unknown' : 'legacy'),
  };
}

function main() {
  const files = walk(ROOT);
  const rows = files.map(scanFile).filter((row) => row.hasFirestoreWrite);
  const exemptClassifications = new Set([
    'dev_backfill_skipped',
    'firebase_auth_keep',
    'legacy_flag_off_only',
    'removed',
  ]);
  const ungated = rows.filter(
    (row) =>
      row.hasFirestoreWrite &&
      !row.hasAuthorityGate &&
      !exemptClassifications.has(row.classification)
  );
  const summary = {
    script: 'audit-firestore-authority-routes',
    routes_with_firestore: rows.length,
    routes_with_authority_gate: rows.filter((r) => r.hasAuthorityGate).length,
    routes_still_ungated_writes: ungated.length,
    known_classifications: ROUTE_CLASSIFICATION,
    ungated_writes: ungated.map((r) => ({
      route: r.route,
      classification: r.classification,
      migrationStatus: r.migrationStatus,
    })),
    all_firestore_routes: rows.sort((a, b) => a.route.localeCompare(b.route)),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.FAIL_ON_UNGATED === '1' && ungated.length) {
    process.exit(2);
  }
}

main();
