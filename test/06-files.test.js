'use strict';
// 6. files import: csv / tsv / xlsx / parquet -> dataDir/warehouse.duckdb -> ask
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('..');
const h = require('./helpers.js');

const CSV = 'order_date,channel,sku,qty,amount\n' + h.SALES_ROWS.map(r => r.join(',')).join('\n') + '\n';

test('csv -> table -> ask (fake model, user rules) -> verified numeric answer, warehouse lives in dataDir', async (t) => {
  const dir = h.tmp(); const csv = path.join(dir, 'sales.csv'); fs.writeFileSync(csv, CSV);
  const model = h.fakeModel(() => h.IR_AMAZON_OCT);
  const engine = await createEngine({ dataDir: dir + '/data', data: { files: [csv] }, rules: [h.salesPack()], model, vectors: false, anchor: '2026-10-22' });
  t.after(() => engine.close());
  assert.ok(fs.existsSync(path.join(dir, 'data', 'warehouse.duckdb')));
  assert.deepEqual(engine.tables().map(x => x.name), ['sales']);
  assert.deepEqual(engine.tables()[0].columns.map(c => c.name), ['order_date', 'channel', 'sku', 'qty', 'amount']);
  assert.equal(engine.tables()[0].columns[0].type, 'DATE');          // read_csv_auto inferred a date
  const r = await engine.ask(h.Q_AMAZON_OCT);
  assert.equal(r.status, 'verified');
  assert.equal(r.facts[0].value, 49.75);
  assert.match(r.answerLine, /^ANSWER: 49\.75/);
});

test('csv without rules: rules are auto-generated (documented best effort) -> numeric answer is right but status needs_confirm', async (t) => {
  const dir = h.tmp(); const csv = path.join(dir, 'sales.csv'); fs.writeFileSync(csv, CSV);
  const model = h.fakeModel(() => ({ metric: 'm:au_sales_amount', time_role: 't:sales', period: { kind: 'explicit', start: '2026-10-01', end: '2026-10-31' }, entities: [{ dim: 'd:au_sales_channel', value: 'Amazon' }], output_shape: 'scalar' }));
  const engine = await createEngine({ dataDir: dir + '/data', data: { files: [csv] }, model, vectors: false, anchor: '2026-10-22' });
  t.after(() => engine.close());
  assert.ok(fs.existsSync(path.join(dir, 'data', 'rules', 'auto-pack.json')));
  const r = await engine.ask('2026年10月 Amazon 的 amount 合计是多少？');
  assert.equal(r.status, 'needs_confirm');
  assert.equal(r.facts[0].value, 49.75);
});

test('xlsx (multi-sheet) and parquet and tsv import; re-open reuses the warehouse when files are unchanged', async (t) => {
  const dir = h.tmp();
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Orders');
  ws.addRow(['order_date', 'channel', 'sku', 'qty', 'amount']);
  for (const r of h.SALES_ROWS) ws.addRow([new Date(r[0] + 'T00:00:00Z'), r[1], r[2], r[3], r[4]]);
  const ws2 = wb.addWorksheet('Refunds'); ws2.addRow(['id', 'refund']); ws2.addRow([1, 2.5]); ws2.addRow([2, 4]);
  const xlsx = path.join(dir, 'book.xlsx'); await wb.xlsx.writeFile(xlsx);
  const tsv = path.join(dir, 'notes.tsv'); fs.writeFileSync(tsv, 'a\tb\n1\tx\n2\ty\n');
  // parquet through duckdb itself
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(':memory:'); const c = await inst.connect();
  const pq = path.join(dir, 'p.parquet');
  await c.run(`COPY (SELECT 1 AS k, 'z' AS v UNION ALL SELECT 2, 'w') TO '${pq}' (FORMAT PARQUET)`);
  c.closeSync ? c.closeSync() : c.disconnectSync(); inst.closeSync && inst.closeSync();

  const events = [];
  const mk = () => createEngine({ dataDir: dir + '/data', data: { files: [xlsx, tsv, pq] }, rules: [h.salesPack()], model: h.fakeModel(() => h.IR_AMAZON_OCT), vectors: false, anchor: '2026-10-22', onEvent: e => events.push(e) });
  const engine = await mk();
  assert.deepEqual(engine.tables().map(x => x.name).sort(), ['book_Orders', 'book_Refunds', 'notes', 'p']);
  assert.equal(events.filter(e => e.type === 'import_table').length, 4);
  const info = engine.info();
  assert.equal(info.imported.find(x => x.name === 'book_Orders').rows, 5);
  await engine.close();
  events.length = 0;
  const again = await mk();
  t.after(() => again.close());
  assert.equal(events.filter(e => e.type === 'import_table').length, 0, 'unchanged files are not re-imported');
  assert.equal(again.tables().length, 4);
});

test('bad inputs: missing file, unsupported type, no data source', async () => {
  const dir = h.tmp();
  const base = { dataDir: dir + '/d', model: h.fakeModel(() => ({})), vectors: false };
  await assert.rejects(() => createEngine({ ...base, data: { files: [dir + '/nope.csv'] } }), /not found/);
  fs.writeFileSync(dir + '/x.json', '{}');
  await assert.rejects(() => createEngine({ ...base, data: { files: [dir + '/x.json'] } }), /unsupported/);
  await assert.rejects(() => createEngine({ ...base, data: {} }), /data/);
  await assert.rejects(() => createEngine({ ...base, model: {}, data: { files: [dir + '/x.json'] } }), /model/);
});
