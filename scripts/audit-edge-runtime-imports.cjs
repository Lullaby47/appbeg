/**
 * Audit Edge-unsafe imports in Next.js app routes and instrumentation.
 *
 * Usage: node scripts/audit-edge-runtime-imports.cjs
 * Exit 1 when violations are found (set FAIL_ON_EDGE_IMPORTS=0 to report only).
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
  /from\s+['"]@\/lib\/automation\/autoTickBrowserToken['"]/,
  /from\s+['"]pg['"]/,
  /from\s+['"]postgres['"]/,
];

const RUNTIME_NODE_RE = /export\s+const\s+runtime\s*=\s*['"]nodejs['"]/;
const RUNTIME_EDGE_RE = /export\s+const\s+runtime\s*=\s*['"]edge['"]/;

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

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function audit() {
  const violations = [];

  const instrumentation = path.join(ROOT, 'instrumentation.ts');
  if (fs.existsSync(instrumentation)) {
    const text = fs.readFileSync(instrumentation, 'utf8');
    for (const pattern of NODE_ONLY_PATTERNS) {
      if (pattern.test(text)) {
        violations.push({
          file: rel(instrumentation),
          issue: `instrumentation.ts must not import Node-only modules (${pattern})`,
        });
      }
    }
  }

  const middleware = path.join(ROOT, 'middleware.ts');
  if (fs.existsSync(middleware)) {
    const text = fs.readFileSync(middleware, 'utf8');
    for (const pattern of NODE_ONLY_PATTERNS) {
      if (pattern.test(text)) {
        violations.push({
          file: rel(middleware),
          issue: `middleware.ts must not import Node-only modules (${pattern})`,
        });
      }
    }
    if (RUNTIME_EDGE_RE.test(text) === false && text.includes('middleware')) {
      // middleware is always edge — informational only
    }
  }

  const routes = walk(API_DIR);
  for (const route of routes) {
    const text = fs.readFileSync(route, 'utf8');
    const usesNodeOnly = NODE_ONLY_PATTERNS.some((pattern) => pattern.test(text));
    const hasNodeRuntime = RUNTIME_NODE_RE.test(text);
    const hasEdgeRuntime = RUNTIME_EDGE_RE.test(text);

    if (hasEdgeRuntime && usesNodeOnly) {
      violations.push({
        file: rel(route),
        issue: 'route declares edge runtime but imports Node-only modules',
      });
    }

    if (usesNodeOnly && !hasNodeRuntime) {
      violations.push({
        file: rel(route),
        issue: 'SQL/auth route missing export const runtime = "nodejs"',
      });
    }
  }

  const edgeRuntimeFiles = [];
  function scanTs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
        scanTs(full);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (RUNTIME_EDGE_RE.test(text)) {
          edgeRuntimeFiles.push(rel(full));
          for (const pattern of NODE_ONLY_PATTERNS) {
            if (pattern.test(text)) {
              violations.push({
                file: rel(full),
                issue: `edge runtime file imports Node-only module (${pattern})`,
              });
            }
          }
        }
      }
    }
  }
  scanTs(path.join(ROOT, 'app'));

  console.info('[EDGE_RUNTIME_AUDIT]', {
    apiRoutes: routes.length,
    edgeRuntimeFiles,
    violationCount: violations.length,
  });

  for (const v of violations) {
    console.error(`[EDGE_RUNTIME_AUDIT] ${v.file}: ${v.issue}`);
  }

  if (violations.length && process.env.FAIL_ON_EDGE_IMPORTS !== '0') {
    process.exit(1);
  }
}

audit();
