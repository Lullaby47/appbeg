/**
 * Fix misplaced `export const runtime = 'nodejs'` lines inserted inside import blocks.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'app', 'api');
const RUNTIME_LINE = "export const runtime = 'nodejs';";
const RUNTIME_RE = /^\s*export\s+const\s+runtime\s*=\s*['"]nodejs['"];\s*$/gm;

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

function fixFile(file) {
  const original = fs.readFileSync(file, 'utf8');
  if (!RUNTIME_RE.test(original)) {
    return false;
  }

  let text = original.replace(RUNTIME_RE, '');
  const lines = text.split(/\r?\n/);
  const importEnd = findLastImportLineIndex(lines);
  if (importEnd < 0) {
    return false;
  }

  const insertAt = importEnd + 1;
  if ((lines[insertAt] || '').trim() === RUNTIME_LINE) {
    return false;
  }

  lines.splice(insertAt, 0, '', RUNTIME_LINE);
  const updated = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}`;
  fs.writeFileSync(file, updated, 'utf8');
  return updated !== original;
}

let fixed = 0;
for (const route of walk(API_DIR)) {
  if (fixFile(route)) {
    fixed += 1;
    console.info('[fix-api-nodejs-runtime-placement] fixed', path.relative(ROOT, route));
  }
}
console.info('[fix-api-nodejs-runtime-placement] done', { fixed });
