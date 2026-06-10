/**
 * Full Firebase/Firestore usage inventory for migration planning.
 *
 * Usage:
 *   node scripts/audit-firebase-inventory.cjs
 *   node scripts/audit-firebase-inventory.cjs --json > firebase-inventory.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['app', 'components', 'features', 'lib', 'scripts'];
const EXT = new Set(['.ts', '.tsx', '.js', '.cjs']);

const PATTERNS = [
  { usage: 'onSnapshot', re: /\bonSnapshot\s*\(/ },
  { usage: 'onAuthStateChanged', re: /\bonAuthStateChanged\s*\(/ },
  { usage: 'getFirestore', re: /\bgetFirestore\s*\(/ },
  { usage: 'adminDb', re: /\badminDb\b/ },
  { usage: 'adminAuth', re: /\badminAuth\b/ },
  { usage: 'firebase/firestore import', re: /from ['"]firebase\/firestore['"]/ },
  { usage: 'firebase/auth import', re: /from ['"]firebase\/auth['"]/ },
  { usage: 'firebase-admin', re: /from ['"]firebase-admin/ },
  { usage: 'signInWithEmailAndPassword', re: /\bsignInWithEmailAndPassword\s*\(/ },
  { usage: 'getIdToken', re: /\bgetIdToken\s*\(/ },
  { usage: 'currentUser', re: /\bcurrentUser\b/ },
  { usage: 'setDoc', re: /\bsetDoc\s*\(/ },
  { usage: 'updateDoc', re: /\bupdateDoc\s*\(/ },
  { usage: 'deleteDoc', re: /\bdeleteDoc\s*\(/ },
  { usage: 'runTransaction', re: /\brunTransaction\s*\(/ },
  { usage: 'writeBatch', re: /\bwriteBatch\s*\(/ },
  { usage: 'serverTimestamp', re: /\bserverTimestamp\s*\(/ },
];

const SQL_REPLACEMENT = {
  onSnapshot: 'SQL cache poll or /api/live/stream SSE',
  onAuthStateChanged: 'app_sessions + /api/auth/session/me',
  getFirestore: 'Remove; lazy init blocked in SQL mode',
  adminDb: 'lib/sql authority_* + cache tables',
  adminAuth: 'user_credentials + app_sessions (Phase 5)',
  'firebase/firestore import': 'Remove from client; use SQL APIs',
  'firebase/auth import': 'SQL login only (Phase 5)',
  'firebase-admin': 'Server-only; gate with AUTHORITY_SQL_WRITE',
  signInWithEmailAndPassword: '/api/auth/login-sql + user_credentials',
  getIdToken: 'X-App-Session-Id header',
  currentUser: 'session/me cached user',
  setDoc: 'SQL INSERT/UPSERT authority path',
  updateDoc: 'SQL UPDATE authority path',
  deleteDoc: 'SQL soft-delete / tombstone',
  runTransaction: 'SQL BEGIN/COMMIT transaction',
  writeBatch: 'SQL multi-row transaction',
  serverTimestamp: 'NOW() / timestamptz',
};

function classifyLayer(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('scripts/') || p.startsWith('migrations/')) return 'cold';
  if (p.startsWith('app/api/')) return 'server-runtime';
  if (p.startsWith('lib/server/')) return 'server-runtime';
  if (p.startsWith('lib/firebase/admin')) return 'admin-sdk';
  if (p.startsWith('app/login/')) return 'auth-bootstrap';
  if (
    p.startsWith('app/') ||
    p.startsWith('components/') ||
    p.startsWith('features/') ||
    p.startsWith('lib/client/')
  ) {
    return 'client-runtime';
  }
  if (p.startsWith('lib/firebase/')) return 'admin-sdk';
  return 'library';
}

function decideAction(layer, usage, file, hasGuard) {
  if (layer === 'cold') return 'keep (backfill/audit only)';
  if (layer === 'admin-sdk') return 'keep temporarily (gate all calls)';
  if (layer === 'auth-bootstrap') return 'remove Phase 5 (SQL credentials)';
  if (layer === 'client-runtime') {
    if (hasGuard) return 'guarded — remove import Phase 3';
    return 'remove Phase 3';
  }
  if (layer === 'server-runtime') {
    if (usage === 'adminDb' || usage === 'adminAuth') return 'migrate Phase 4';
    return 'review Phase 4';
  }
  return 'review';
}

function hasSqlGuard(content) {
  return [
    'assertClientFirestoreDisabled',
    'shouldSkipClientFirestore',
    'isClientSqlReadMode',
    'isAuthoritySqlWriteEnabled',
    'isCacheSqlAuthoritative',
    'shouldBlockFirestoreFallback',
    'logFirestoreTouch',
    'authority_',
  ].some((m) => content.includes(m));
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, files);
    } else if (EXT.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const rows = [];
const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

for (const filePath of files) {
  const rel = path.relative(ROOT, filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const layer = classifyLayer(rel);
  const guarded = hasSqlGuard(content);

  for (const pattern of PATTERNS) {
    lines.forEach((line, index) => {
      if (!pattern.re.test(line)) return;
      rows.push({
        file: rel.replace(/\\/g, '/'),
        line: index + 1,
        firebase_usage: pattern.usage,
        layer,
        sql_replacement: SQL_REPLACEMENT[pattern.usage] || 'SQL authority or cache',
        action: decideAction(layer, pattern.usage, rel, guarded),
        guarded,
      });
    });
  }
}

const summary = {
  script: 'audit-firebase-inventory',
  total_hits: rows.length,
  by_layer: rows.reduce((acc, row) => {
    acc[row.layer] = (acc[row.layer] || 0) + 1;
    return acc;
  }, {}),
  by_usage: rows.reduce((acc, row) => {
    acc[row.firebase_usage] = (acc[row.firebase_usage] || 0) + 1;
    return acc;
  }, {}),
  client_runtime_hits: rows.filter((r) => r.layer === 'client-runtime').length,
  client_unguarded_files: [
    ...new Set(
      rows
        .filter((r) => r.layer === 'client-runtime' && !r.guarded)
        .map((r) => r.file)
    ),
  ],
  server_adminDb_files: [
    ...new Set(rows.filter((r) => r.firebase_usage === 'adminDb').map((r) => r.file)),
  ],
  rows,
};

const inventorySummary = {
  total_hits: summary.total_hits,
  client_runtime_hits: summary.client_runtime_hits,
  client_unguarded_files: summary.client_unguarded_files.length,
  server_adminDb_files: summary.server_adminDb_files.length,
};

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ ...summary, inventorySummary }, null, 2));
} else {
  console.info('[FIREBASE_INVENTORY_AUDIT]', inventorySummary);
  console.log(JSON.stringify(summary, null, 2));
}
