'use strict';
// rc.8: discovery (only the named folders), SQLite import (types, blob skip, refresh), custom warehouse location
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const h = require('./helpers-ws.js');
const W = require('../src/workspace.js');
const { discover } = require('../src/discover.js');

function mkSqlite(file) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, order_date TEXT, amount REAL, qty INT, note TEXT, pic BLOB, mixed); INSERT INTO orders VALUES (1,'2026-10-01',19.9,2,'a',x'00ff',1),(2,'2026-10-02',5.5,1,NULL,NULL,'x'); CREATE TABLE cust(id INTEGER, name TEXT); INSERT INTO cust VALUES (1,'z');");
  db.close();
}

test('discover: nested folders, hidden / system / node_modules skipped, magic header beats extension, xlsx sheets, duckdb tables', async () => {
  const root = h.tmp('estratto-disc-');
  const mk = (...p) => { const f = path.join(root, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };
  fs.writeFileSync(mk('a', 'sales.csv'), 'order_date,amount\n2026-10-01,5\n2026-10-02,6\n');
  fs.writeFileSync(mk('a', 'b', 'c', 'x.tsv'), 'a\tb\n1\t2\n');
  mkSqlite(mk('a', 'shop.dat'));                 // wrong extension
  mkSqlite(mk('a', 'trick.csv'));                // sqlite pretending to be csv
  mkSqlite(mk('a', 'real.sqlite3'));
  await h.makeDb(mk('a', 'wh.duckdb'));
  fs.writeFileSync(mk('a', '.hidden', 'h.csv'), 'a\n1\n');
  fs.writeFileSync(mk('a', 'node_modules', 'n.csv'), 'a\n1\n');
  fs.writeFileSync(mk('.ssh', 'k.csv'), 'a\n1\n');
  fs.writeFileSync(mk('a', 'b', 'c', 'd', 'e', 'f', 'deep.csv'), 'a\n1\n');
  fs.writeFileSync(mk('outside-not-given', 'o.csv'), 'a\n1\n');
  // xlsx with two sheets
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Q1').addRows([['d', 'v'], [1, 2], [3, 4]]); wb.addWorksheet('Q2').addRows([['d', 'v'], [5, 6]]);
  await wb.xlsx.writeFile(mk('a', 'book.xlsx'));
  const r = await discover([path.join(root, 'a'), path.join(root, '.ssh')]);
  const by = n => r.find(c => c.name === n);
  assert.equal(by('sales.csv').kind, 'csv'); assert.equal(by('sales.csv').tables[0].rows, 2);
  assert.equal(by('x.tsv').kind, 'tsv');
  assert.equal(by('shop.dat').kind, 'sqlite'); assert.equal(by('trick.csv').kind, 'sqlite'); assert.equal(by('real.sqlite3').kind, 'sqlite');
  assert.deepEqual(by('shop.dat').tables.map(t => [t.name, t.rows]), [['cust', 1], ['orders', 2]]);
  assert.equal(by('wh.duckdb').kind, 'duckdb'); assert.equal(by('wh.duckdb').tables[0].name, 'sales'); assert.equal(by('wh.duckdb').tables[0].rows, 5);
  assert.deepEqual(by('book.xlsx').tables.map(t => [t.name, t.rows]), [['Q1', 2], ['Q2', 1]]);
  for (const n of ['h.csv', 'n.csv', 'k.csv', 'deep.csv', 'o.csv']) assert.ok(!by(n), n + ' must not be listed');
  assert.ok(r.skipped.some(s => s.reason === 'credential_folder'));   // .ssh named explicitly is still refused
  assert.ok(r.skipped.some(s => s.reason === 'too_deep'));
  assert.ok((await discover('/')).skipped.some(s => s.reason === 'disk_root'));
  for (const c of r) { assert.ok(c.size > 0); assert.ok(c.mtime); }
  // nothing but the given paths: a sibling folder is never touched
  const only = await discover([path.join(root, 'a', 'sales.csv')]);
  assert.deepEqual(only.map(c => c.name), ['sales.csv']);
  // size limit for preview
  const small = await discover([path.join(root, 'a')], { previewMaxBytes: 10 });
  assert.equal(small.find(c => c.name === 'real.sqlite3').note, 'too_large_for_preview');
});

test('sqlite import: types, blob column skipped with a warning, dates stay text, custom warehouse, refresh by mtime, table selection change', async (t) => {
  const root = h.tmp('estratto-sq-');
  const f = path.join(root, 'shop.db'); mkSqlite(f);
  const home = path.join(root, 'home'), wh = path.join(root, 'own', 'warehouse.duckdb');
  assert.equal(W.sourceFromPath(f).type, 'sqlite');   // .db is no longer assumed to be DuckDB
  await W.initWorkspace({ home, name: 'w', config: { data: { sources: [W.sourceFromPath(f)], warehouse: wh }, behavior: { vectors: false } } });
  const events = [];
  const ws = await W.openWorkspace({ home, name: 'w' }, { onEvent: e => events.push(e), refreshIntervalMs: 0 });
  t.after(() => ws.close());
  assert.ok(fs.existsSync(wh)); assert.ok(!fs.existsSync(path.join(home, 'w', 'warehouse.duckdb')));
  assert.equal(fs.statSync(wh).mode & 0o777, 0o600);
  const tb = Object.fromEntries(ws.engine.tables().map(x => [x.name, Object.fromEntries(x.columns.map(c => [c.name, c.type]))]));
  assert.deepEqual(tb.shop__orders, { id: 'BIGINT', order_date: 'VARCHAR', amount: 'DOUBLE', qty: 'BIGINT', note: 'VARCHAR', mixed: 'VARCHAR' });
  assert.ok(events.some(e => e.type === 'import_warning' && e.reason === 'blob_column' && e.column === 'pic'));
  const sum = await ws.dataSummary();
  const o = sum.find(x => x.name === 'shop__orders');
  assert.deepEqual([o.rows, o.dateColumn, o.from, o.to], [2, 'order_date', '2026-10-01', '2026-10-02']);
  // refresh: the source file changed
  const db = new DatabaseSync(f); db.exec("INSERT INTO cust VALUES (2,'y'),(3,'w')"); db.close();
  fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const r = await ws.refreshData();
  assert.equal(r.refreshed, true);
  assert.equal((await ws.dataSummary()).find(x => x.name === 'shop__cust').rows, 3);
  // choosing other tables re-imports that source and drops the others
  await ws.addSource({ type: 'sqlite', path: f, tables: ['cust'] });
  assert.deepEqual(ws.engine.tables().map(x => x.name), ['shop__cust']);
  // survives a restart (stamp includes the table selection)
  await ws.close();
  const ws2 = await W.openWorkspace({ home, name: 'w' }, { onEvent: () => {} }); t.after(() => ws2.close());
  assert.deepEqual(ws2.engine.tables().map(x => x.name), ['shop__cust']);
});

test('--warehouse never overwrites an existing file; sqlite table that does not exist is a clear error and rolls back', async () => {
  const root = h.tmp('estratto-sq2-');
  const f = path.join(root, 's.sqlite'); mkSqlite(f);
  fs.writeFileSync(path.join(root, 'mine.duckdb'), 'precious');
  await assert.rejects(() => W.initWorkspace({ home: root + '/h', name: 'w', config: { data: { sources: [{ type: 'sqlite', path: f }], warehouse: path.join(root, 'mine.duckdb') } } }), /already exists/);
  assert.equal(fs.readFileSync(path.join(root, 'mine.duckdb'), 'utf8'), 'precious');
  await W.initWorkspace({ home: root + '/h', name: 'w', config: { data: { sources: [{ type: 'sqlite', path: f }] }, behavior: { vectors: false } } });
  const ws = await W.openWorkspace({ home: root + '/h', name: 'w' }, { onEvent: () => {} });
  try {
    await assert.rejects(() => ws.addSource({ type: 'sqlite', path: f, tables: ['nope'] }), /table "nope" not found/);
    assert.deepEqual(ws.config.data.sources[0].tables, undefined);
    assert.ok(ws.engine.tables().length === 2);
  } finally { await ws.close(); }
});
