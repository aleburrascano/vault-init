// Repeatable import-graph audit for `src/lib/` root files.
//
// For each root-level lib file, prints (a) the sibling `.ts` files it
// directly imports, and (b) the count of external callers (under
// `src/commands/`, `src/mcp-tools/`, `bin/`, `tests/`).
//
// High external-usage counts (e.g. `errors`, `logger`, `platform`,
// `vault`) indicate truly cross-cutting modules that don't belong in
// any single cluster. Tightly self-referential subsets (e.g. the
// `templates/` and `notices/` clusters extracted in May 2026) jump out
// as cluster candidates from the sibling-import column.
//
// Run: `node scripts/import-graph.mjs`
//
// Drove workstream B (lib clustering) of the May 2026 refactor pass.
// Re-run after any `src/lib/` reorganization to verify there are no
// accidental cross-cluster reach-overs and to spot new cluster
// candidates as the codebase grows.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIB = 'src/lib';
const rootFiles = readdirSync(LIB)
  .filter(f => f.endsWith('.ts'))
  .filter(f => statSync(join(LIB, f)).isFile())
  .map(f => f.replace(/\.ts$/, ''));

// Map of file -> list of root lib siblings it imports from.
const imports = new Map();
const importedBy = new Map();
for (const f of rootFiles) imports.set(f, new Set());
for (const f of rootFiles) importedBy.set(f, new Set());

for (const f of rootFiles) {
  const text = readFileSync(join(LIB, `${f}.ts`), 'utf8');
  // ./X.js sibling imports
  const re = /from\s+['"]\.\/([\w-]+)\.js['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const target = m[1];
    if (rootFiles.includes(target)) {
      imports.get(f).add(target);
      importedBy.get(target).add(f);
    }
  }
}

console.log('# Lib-root import graph (sibling .ts files only)\n');
const sorted = [...rootFiles].sort();
for (const f of sorted) {
  const out = [...imports.get(f)].sort();
  const inn = [...importedBy.get(f)].sort();
  console.log(`${f.padEnd(22)}  imports: [${out.join(', ')}]`);
  console.log(`${' '.repeat(22)}  used by: [${inn.join(', ')}]`);
}

// Cross-file from outside src/lib (commands, mcp-tools, bin) — count how
// many external files import each root lib file. High = cross-cutting.
import { execSync } from 'node:child_process';
const allTs = execSync('find src bin tests -name "*.ts"', { encoding: 'utf8' })
  .trim().split('\n').filter(p => !p.startsWith(LIB + '/') || p.includes('/'));

const externalUsage = new Map();
for (const f of rootFiles) externalUsage.set(f, 0);
for (const file of allTs) {
  if (file.startsWith(`${LIB}/`) && !file.includes('/', LIB.length + 1)) continue; // skip root lib itself
  const text = readFileSync(file, 'utf8');
  for (const f of rootFiles) {
    const re = new RegExp(`from\\s+['"][^'"]*lib/${f}\\.js['"]`);
    if (re.test(text)) externalUsage.set(f, externalUsage.get(f) + 1);
  }
}

console.log('\n# External usage (commands + mcp-tools + bin + tests)\n');
const externalSorted = [...externalUsage.entries()].sort((a, b) => b[1] - a[1]);
for (const [f, n] of externalSorted) {
  console.log(`${f.padEnd(22)}  ${n.toString().padStart(3)} files`);
}
