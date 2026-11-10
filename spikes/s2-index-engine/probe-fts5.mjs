// S2 step 1: does each engine support the exact SPEC §5.3 FTS5 + fts5vocab schema?
// Usage: ../node.sh probe-fts5.mjs
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.mjs';

const require = createRequire(import.meta.url);

const CHECKS = [
  ['compile options', null],
  ['full §5.3 schema', SCHEMA_SQL],
  ['insert + MATCH', `INSERT INTO turn_text(id,title,prompt,response,tools,files,aux) VALUES (1,'t','Členů parseJsonLine refactoring','x','run_in_terminal','a/b.ts','parse json line');
    INSERT INTO turn_fts(rowid,title,prompt,response,tools,files,aux) SELECT id,title,prompt,response,tools,files,aux FROM turn_text;`],
  ['diacritics (clenu)', `SELECT count(*) AS n FROM turn_fts WHERE turn_fts MATCH '"clenu"'`],
  ['tokenchars _ (run_in_terminal)', `SELECT count(*) AS n FROM turn_fts WHERE turn_fts MATCH '"run_in_terminal"'`],
  ['prefix (refact*)', `SELECT count(*) AS n FROM turn_fts WHERE turn_fts MATCH '"refact"*'`],
  ['bm25 weights + snippet', `SELECT bm25(turn_fts,5,4,1,1.5,2,0.5) AS r, snippet(turn_fts,1,char(1),char(2),'…',24) AS s FROM turn_fts WHERE turn_fts MATCH '"parsejsonline"'`],
  ['fts5vocab rows', `SELECT count(*) AS n FROM turn_vocab`],
];

function run(name, exec, all) {
  const out = { engine: name, results: {} };
  for (const [label, sql] of CHECKS) {
    try {
      if (!sql) out.results[label] = all(`SELECT group_concat(compile_options, ' ') AS o FROM pragma_compile_options`)[0]?.o?.match(/ENABLE_FTS\d|ENABLE_JSON1|THREADSAFE=\d/g)?.join(' ') ?? '?';
      else if (/^\s*SELECT/i.test(sql)) out.results[label] = all(sql)[0];
      else { exec(sql); out.results[label] = 'ok'; }
    } catch (e) { out.results[label] = `ERROR: ${e.message}`; }
  }
  return out;
}

// sql.js
const initSqlJs = require('sql.js');
const SQL = await initSqlJs();
{
  const db = new SQL.Database();
  const version = db.exec('select sqlite_version()')[0].values[0][0];
  const all = (sql) => { const r = db.exec(sql)[0]; return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
  console.log(JSON.stringify({ ...run(`sql.js ${'1.15.2'} (SQLite ${version})`, (s) => db.exec(s), all) }, null, 1));
}

// node:sqlite
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const version = db.prepare('select sqlite_version() v').get().v;
  console.log(JSON.stringify(run(`node:sqlite (Node ${process.versions.node}, SQLite ${version})`, (s) => db.exec(s), (s) => db.prepare(s).all()), null, 1));
} catch (e) {
  console.log(JSON.stringify({ engine: 'node:sqlite', error: e.message }));
}
