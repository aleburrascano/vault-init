// Repeatable function-length audit scanner — list every TS function across
// `src/` + `bin/` whose body spans at least 40 lines. Respects strings,
// template literals, and comments so braces inside `${interpolations}` and
// inside `'...'` / `"..."` / `` `...` `` literals don't confuse the depth
// counter (an earlier naive implementation undercounted `init.ts:run`
// because the destructured-param `{ ... }` was treated as the function
// body open). Skips the parameter list before looking for the body brace.
//
// Run: `node scripts/funclen.mjs`
//
// Useful when planning a decomposition pass — surfaces the actual long
// functions to target rather than relying on subjective skim reads. Drove
// workstream A (functional decomposition) of the May 2026 refactor pass.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BACKSLASH = String.fromCharCode(92);

function skipParenList(text, startIdx) {
  // Walk to first '(' then to its matching ')', respecting nested ()/{}/[]/strings.
  let i = startIdx;
  while (i < text.length && text[i] !== '(') i++;
  if (i >= text.length) return startIdx;
  let parens = 0, braces = 0, brackets = 0;
  while (i < text.length) {
    const c = text[i], next = text[i + 1];
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < text.length && text[i] !== q) { if (text[i] === BACKSLASH) i += 2; else i++; }
      i++; continue;
    }
    if (c === '`') {
      i++;
      while (i < text.length && text[i] !== '`') { if (text[i] === BACKSLASH) { i += 2; continue; } i++; }
      i++; continue;
    }
    if (c === '(') parens++;
    else if (c === ')') { parens--; if (parens === 0 && braces === 0 && brackets === 0) return i + 1; }
    else if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === '[') brackets++;
    else if (c === ']') brackets--;
    i++;
  }
  return startIdx;
}

function findEnd(text, startIdx) {
  // First skip the parameter list `(...)`, then find the body `{...}`.
  let i = skipParenList(text, startIdx);
  while (i < text.length && text[i] !== '{') i++;
  if (i >= text.length) return -1;
  let depth = 0;
  while (i < text.length) {
    const c = text[i], next = text[i + 1];
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < text.length && text[i] !== q) { if (text[i] === BACKSLASH) i += 2; else i++; }
      i++; continue;
    }
    if (c === '`') {
      i++;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === BACKSLASH) { i += 2; continue; }
        if (text[i] === '$' && text[i + 1] === '{') {
          let inner = 1; i += 2;
          while (i < text.length && inner > 0) {
            if (text[i] === '{') inner++;
            else if (text[i] === '}') inner--;
            else if (text[i] === '`') { i++; while (i < text.length && text[i] !== '`') i++; }
            i++;
          }
          continue;
        }
        i++;
      }
      i++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

const files = execSync('find src bin -name "*.ts"', { encoding: 'utf8' }).trim().split('\n');
const findings = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const re = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const startLine = text.slice(0, m.index).split('\n').length;
    const end = findEnd(text, m.index);
    if (end < 0) continue;
    const endLine = text.slice(0, end).split('\n').length;
    const len = endLine - startLine + 1;
    if (len >= 40) findings.push({ file, line: startLine, name: m[2], len, kind: 'fn' });
  }
  const re2 = /^(\s*)(?:export\s+)?const\s+(\w+)\s*[:=][^=\n]*=>\s*\{/gm;
  while ((m = re2.exec(text)) !== null) {
    const startLine = text.slice(0, m.index).split('\n').length;
    const arrowIdx = text.indexOf('=>', m.index);
    const braceIdx = text.indexOf('{', arrowIdx);
    const end = findEnd(text, braceIdx);
    if (end < 0) continue;
    const endLine = text.slice(0, end).split('\n').length;
    const len = endLine - startLine + 1;
    if (len >= 40) findings.push({ file, line: startLine, name: m[2], len, kind: 'arrow' });
  }
  const re3 = /^(\s+)(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/gm;
  while ((m = re3.exec(text)) !== null) {
    const name = m[2];
    if (['if', 'for', 'while', 'switch', 'catch', 'else', 'do', 'try', 'function', 'return', 'throw'].includes(name)) continue;
    if (m[1].length === 0) continue;
    const startLine = text.slice(0, m.index).split('\n').length;
    const end = findEnd(text, m.index + m[0].length - 1);
    if (end < 0) continue;
    const endLine = text.slice(0, end).split('\n').length;
    const len = endLine - startLine + 1;
    if (len >= 40) findings.push({ file, line: startLine, name, len, kind: 'method' });
  }
}
const seen = new Set();
const uniq = findings.filter(f => { const k = `${f.file}:${f.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
uniq.sort((a, b) => b.len - a.len);
for (const f of uniq) console.log(`${f.len.toString().padStart(4)}  ${f.kind.padEnd(7)} ${f.file}:${f.line}  ${f.name}`);
