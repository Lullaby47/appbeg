/**
 * Add `export const runtime = 'nodejs'` to API routes that import SQL/auth/server modules.
 *
 * Usage: node scripts/ensure-api-nodejs-runtime.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'app', 'api');

const NODE_ONLY_PATTERNS = [
  /from\s+['"]crypto['"]/,
  /from\s+['"]node:crypto['"]/,
  /from\s+['"]@\/lib\/server\//,
  /from\s+['"]@\/lib\/sql\//,
  /from\s+['"]@\/lib\/firebase\/admin['"]/,
  /from\s+['"]firebase-admin/,
  /from\s+['"]@\/lib\/firebase\/apiAuth['"]/,
  /from\s+['"]@\/lib\/firebase\/liveAuthTokenCache['"]/,
  /from\s+['"]@\/lib\/automation\/autoTickBrowserToken['"]/,
];

const RUNTIME_NODE_RE = /export\s+const\s+runtime\s*=\s*['"]nodejs['"]/;
const RUNTIME_LINE = "export const runtime = 'nodejs';";

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.isFile() && entry.name === 'route.ts') {
      acc.push(full);
    }
  }
  return acc;
}

function findLastImportLineIndex(lines) {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s/.test(lines[i])) {
      let j = i;
      while (j < lines.length && !/ from ['"]/.test(lines[j])) {
        j += 1;
      }
      if (j < lines.length) {
        last = j;
        i = j;
      }
    }
  }
  return last;
}

function ensureRuntime(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (RUNTIME_NODE_RE.test(text)) {
    return false;
  }
  const usesNodeOnly = NODE_ONLY_PATTERNS.some((pattern) => pattern.test(text));
  if (!usesNodeOnly) {
    return false;
  }

  const lines = text.split(/\r?\n/);
  const importEnd = findLastImportLineIndex(lines);
  if (importEnd < 0) {
    return false;
  }
  lines.splice(importEnd + 1, 0, '', RUNTIME_LINE);
  fs.writeFileSync(file, `${lines.join('\n')}`, 'utf8');
  return true;
}

const routes = walk(API_DIR);
let updated = 0;
for (const route of routes) {
  if (ensureRuntime(route)) {
    updated += 1;
    console.info('[ensure-api-nodejs-runtime] updated', path.relative(ROOT, route));
  }
}
console.info('[ensure-api-nodejs-runtime] done', { routes: routes.length, updated });
