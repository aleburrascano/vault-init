#!/usr/bin/env node
// THROWAWAY — verify node:sqlite has FTS5 compiled in.
// If yes: zero-dependency SQLite is on the table (not in the original plan).

import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');

try {
  // Create an FTS5 virtual table with the same schema we use today.
  db.exec(`
    CREATE VIRTUAL TABLE notes USING fts5(
      vault, path, title, tags, body,
      tokenize = 'unicode61'
    );
  `);
  console.log('PASS  FTS5 virtual table created');

  // Insert a row.
  db.prepare(`
    INSERT INTO notes(vault, path, title, tags, body) VALUES (?, ?, ?, ?, ?)
  `).run('alfa', 'note1.md', 'Token Efficiency', 'ai,llm', 'How tokens are used inside model context.');

  db.prepare(`
    INSERT INTO notes(vault, path, title, tags, body) VALUES (?, ?, ?, ?, ?)
  `).run('alfa', 'note2.md', 'Context Engineering', 'prompts', 'Curating context for downstream models.');

  db.prepare(`
    INSERT INTO notes(vault, path, title, tags, body) VALUES (?, ?, ?, ?, ?)
  `).run('alfa', 'note3.md', 'Random Topic', '', 'Nothing related to either subject above.');
  console.log('PASS  inserts succeed');

  // BM25 query with column weighting (5,3,1) — same as today's build.
  // FTS5 MATCH syntax: 'token OR optimization OR context OR claude'
  const q = `
    SELECT path, title,
           bm25(notes, 5.0, 3.0, 1.0) AS score,
           snippet(notes, 4, '[', ']', ' … ', 12) AS snip
    FROM notes(?)
    ORDER BY score
    LIMIT 5
  `;
  // FTS5 ranks ascending (lower = better) when bm25 used.
  // Try the friend's failing case: "claude code context token optimization CLAUDE.md"
  // Need to wrap MATCH-unsafe characters — for prototype, manually tokenize and OR-join.
  const queryStr = 'claude OR code OR context OR token OR optimization OR CLAUDE OR md';
  const hits = db.prepare(q).all(queryStr);
  console.log('PASS  bm25 query returns hits:');
  for (const h of hits) console.log(`        score=${h.score.toFixed(2)} path=${h.path} title="${h.title}"`);

  // Verify the friend's failure case ranks the right notes top.
  const top = hits[0];
  if (top && (top.title === 'Token Efficiency' || top.title === 'Context Engineering')) {
    console.log('PASS  friend\'s failure-case query ranks expected notes top');
  } else {
    console.log(`FAIL  expected Token Efficiency/Context Engineering top, got: ${top?.title}`);
    process.exitCode = 1;
  }

  // Confirm bm25() function is available.
  const r = db.prepare('SELECT bm25(notes, 1.0, 1.0, 1.0) FROM notes WHERE notes MATCH ? LIMIT 1').get('token');
  console.log('PASS  bm25() function callable');

  db.close();
  console.log('---');
  console.log(process.exitCode ? 'FAIL — see above' : 'OK — node:sqlite has FTS5 + BM25');
} catch (e) {
  console.error('FAIL — error during FTS5 test:');
  console.error(e);
  process.exit(1);
}
