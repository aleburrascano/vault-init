#!/usr/bin/env node
// THROWAWAY — Phase 0.2 (P2) latency benchmark for node:sqlite + FTS5.
// Builds a 500-note fixture index, measures cold-load + query latency.

import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, statSync, existsSync, unlinkSync } from 'node:fs';

process.removeAllListeners('warning'); // mute ExperimentalWarning for clean output

const dbPath = join(tmpdir(), `vk-bench-${process.pid}.db`);
if (existsSync(dbPath)) unlinkSync(dbPath);

const NOTES = 500;
const VAULTS = 3;

// ----- Build fixture -----
const t0 = Date.now();
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE VIRTUAL TABLE notes USING fts5(
    vault, path, title, tags, body,
    tokenize = 'unicode61'
  );
`);

// Word pool deliberately disjoint from the friend's-failure-case query terms
// (claude, code, context, token, optimization, CLAUDE, md). This way the salted
// anchor notes are the ONLY ones that match the query, so ranking validation
// under 500-note load is meaningful.
const POOL = [
  'apple','river','mountain','bicycle','ocean','garden','window','telescope',
  'rabbit','candle','feather','marble','crystal','meadow','lighthouse','compass',
  'harbor','fountain','sparrow','willow','copper','silver','bronze','ivory',
  'pebble','blossom','butterfly','firefly','dragonfly','seashell','driftwood',
  'lantern','umbrella','basket','wagon','chimney','lavender','peppermint',
  'cinnamon','vanilla','sapphire','emerald','jade','quartz','obsidian-stone',
  'autumn','spring','winter','summer','dawn','twilight','equinox','solstice',
  'horizon','silence','whisper','echo','breeze','rainfall','thunderstorm',
];
function pick(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(POOL[Math.floor(Math.random() * POOL.length)]);
  return out;
}
function makeNote(i) {
  const titleWords = pick(3);
  const tagWords = pick(2);
  const bodyWords = pick(40);
  return {
    vault: `vault${(i % VAULTS) + 1}`,
    path: `notes/${i.toString().padStart(4, '0')}.md`,
    title: titleWords.map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
    tags: tagWords.join(', '),
    body: bodyWords.join(' '),
  };
}

// Salt one note with the friend's failure-case anchor terms so we can validate ranking.
const insert = db.prepare('INSERT INTO notes(vault, path, title, tags, body) VALUES (?, ?, ?, ?, ?)');
db.exec('BEGIN');
for (let i = 0; i < NOTES - 2; i++) {
  const n = makeNote(i);
  insert.run(n.vault, n.path, n.title, n.tags, n.body);
}
insert.run('vault1', 'notes/anchor1.md', 'Token Efficiency', 'ai, llm', 'How tokens are used inside model context.');
insert.run('vault1', 'notes/anchor2.md', 'Context Engineering', 'prompts', 'Curating context for downstream models.');
db.exec('COMMIT');
db.close();

const buildMs = Date.now() - t0;
const dbSize = statSync(dbPath).size;
console.log(`fixture built: ${NOTES} notes / ${VAULTS} vaults / ${dbSize.toLocaleString()} bytes / ${buildMs} ms`);

// ----- Cold-load + query latency -----
function timeIt(label, n, fn) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t) / 1e6); // ms
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const max = samples[samples.length - 1];
  console.log(`${label}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms (n=${n})`);
  return { p50, p95, max };
}

// "Cold load" — open DB, prepare query, run query, close. Mirrors a worst case where the MCP server reloads.
const QUERY_RAW = 'claude OR code OR context OR token OR optimization OR CLAUDE OR md';
const QUERY_SQL = `
  SELECT path, title, vault,
         bm25(notes, 5.0, 3.0, 1.0) AS score
  FROM notes(?)
  ORDER BY score
  LIMIT 5
`;

const cold = timeIt('cold-load + query (open + prepare + query + close)', 50, () => {
  const d = new DatabaseSync(dbPath);
  const r = d.prepare(QUERY_SQL).all(QUERY_RAW);
  d.close();
  if (!r.length) throw new Error('no hits');
});

// "Warm" — DB already open, prepared statement reused. Mirrors a hot MCP server.
const dbWarm = new DatabaseSync(dbPath);
const stmtWarm = dbWarm.prepare(QUERY_SQL);
const warm = timeIt('warm query (prepared statement, reuse)', 1000, () => {
  const r = stmtWarm.all(QUERY_RAW);
  if (!r.length) throw new Error('no hits');
});

// Validate ranking on the friend's case — should rank the salted notes top.
const topHits = stmtWarm.all(QUERY_RAW);
console.log('---');
console.log('top hits for friend\'s failure-case query:');
for (const h of topHits) console.log(`  score=${h.score.toFixed(3)} vault=${h.vault} path=${h.path} title="${h.title}"`);
const tops = topHits.slice(0, 2).map((h) => h.title);
const expectedSet = new Set(['Token Efficiency', 'Context Engineering']);
const matched = tops.filter((t) => expectedSet.has(t)).length;
console.log(`---`);
if (matched >= 2) {
  console.log(`PASS  both anchor notes ("Token Efficiency", "Context Engineering") in top 2 hits`);
} else {
  console.log(`FAIL  expected both anchors in top 2 — got ${matched}/2`);
  process.exitCode = 1;
}

dbWarm.close();
unlinkSync(dbPath);

// ----- Verdict -----
const TARGET_P95 = 50;
console.log(`---`);
if (cold.p95 < TARGET_P95 && warm.p95 < TARGET_P95) {
  console.log(`OK — p95 latencies under ${TARGET_P95}ms target`);
} else {
  console.log(`WARN — p95 above ${TARGET_P95}ms target: cold=${cold.p95.toFixed(2)} warm=${warm.p95.toFixed(2)}`);
}
