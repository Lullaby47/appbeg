/**
 * Audit: client components must not import firebase/firestore without SQL guards.
 *
 * Usage:
 *   node scripts/audit-client-firestore.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['app', 'components', 'features', 'lib'];
const EXT = new Set(['.ts', '.tsx']);

const ALLOWLIST = new Set([
  path.normalize('lib/firebase/client.ts'),
  path.normalize('lib/client/firestoreSdk.ts'),
  path.normalize('lib/client/clientFirestoreQuery.ts'),
  path.normalize('app/login/page.tsx'),
]);

const GUARD_MARKERS = [
  'assertClientFirestoreDisabled',
  'shouldSkipClientFirestore',
  "from '@/lib/client/firestoreSdk'",
  'from "@/lib/client/firestoreSdk"',
  'isClientSqlReadMode()',
  'isChatSqlReadEnabled()',
  'isPlayerGameLoginsSqlReadEnabled()',
  'isPlayerCashoutSqlReadEnabled()',
  'PLAYER_REQUESTS_SQL_READ_ENABLED',
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'server') continue;
      walk(full, files);
    } else if (EXT.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function isClientFile(content) {
  return (
    content.includes("'use client'") ||
    content.includes('"use client"') ||
    /from ['"]@\/lib\/firebase\/client['"]/.test(content)
  );
}

function importsFirestoreSdk(content) {
  return /from ['"]firebase\/firestore['"]/.test(content);
}

function importsTypeOnly(content) {
  const lines = content.split('\n');
  return lines.every((line) => {
    if (!/from ['"]firebase\/firestore['"]/.test(line)) return true;
    return /import\s+type\s+/.test(line);
  });
}

function hasGuard(content) {
  return GUARD_MARKERS.some((marker) => content.includes(marker));
}

function usesOnSnapshot(content) {
  return /\bonSnapshot\s*\(/.test(content);
}

const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
const violations = [];

for (const filePath of files) {
  const rel = path.normalize(path.relative(ROOT, filePath));
  const content = fs.readFileSync(filePath, 'utf8');

  if (!isClientFile(content)) continue;
  if (!importsFirestoreSdk(content)) continue;
  if (importsTypeOnly(content)) continue;
  if (ALLOWLIST.has(rel)) continue;
  if (hasGuard(content)) continue;

  violations.push({
    file: rel,
    usesOnSnapshot: usesOnSnapshot(content),
  });
}

if (violations.length) {
  console.error('[audit:client-firestore] FAILED — unguarded firebase/firestore imports:\n');
  for (const v of violations) {
    console.error(
      `  - ${v.file}${v.usesOnSnapshot ? ' (uses onSnapshot)' : ''}`
    );
  }
  console.error(
    '\nAdd assertClientFirestoreDisabled / shouldSkipClientFirestore guards, or import from @/lib/client/firestoreSdk.'
  );
  process.exit(1);
}

console.log('[audit:client-firestore] OK — all client Firestore imports are guarded or allowlisted.');
