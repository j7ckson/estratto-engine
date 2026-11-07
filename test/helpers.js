'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmp(prefix = 'estratto-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const SALES_ROWS = [
  ['2026-10-01', 'Amazon', 'A1', 2, 19.9],
  ['2026-10-02', 'Shopify', 'A2', 1, 5.5],
  ['2026-10-03', 'Amazon', 'A1', 3, 29.85],
  ['2026-09-15', 'Amazon', 'A3', 4, 40],
  ['2026-10-20', 'eBay', 'A2', 5, 100],
];

async function makeDb(file, rows = SALES_ROWS) {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(file);
  const conn = await inst.connect();
  await conn.run('CREATE TABLE sales(order_date DATE, channel VARCHAR, sku VARCHAR, qty BIGINT, amount DOUBLE)');
  for (const r of rows) await conn.run(`INSERT INTO sales VALUES ('${r[0]}','${r[1]}','${r[2]}',${r[3]},${r[4]})`);
  conn.closeSync ? conn.closeSync() : conn.disconnectSync();
  inst.closeSync && inst.closeSync();
  return file;
}

const salesPack = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sales-pack.json'), 'utf8'));

// IR the fake model returns for "October 2026 Amazon GMV".
const IR_AMAZON_OCT = { metric: 'm:gmv', time_role: 't:sales', period: { kind: 'explicit', start: '2026-10-01', end: '2026-10-31' }, entities: [{ dim: 'd:channel', value: 'Amazon' }], output_shape: 'scalar' };
const Q_AMAZON_OCT = '2026年10月 Amazon 的销售额是多少？';

/** fake model: fn(req, signal) -> object (becomes JSON text) | {text,...} */
function fakeModel(fn) {
  const calls = [];
  return {
    calls,
    providerName: 'fake', modelName: 'fake-model',
    async generate(req, signal) {
      calls.push(req);
      const out = await fn(req, signal, calls.length);
      if (out && typeof out === 'object' && 'text' in out) return out;
      return { text: JSON.stringify(out), usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, finish_reason: 'stop', request_id: 'fake-' + calls.length };
    },
  };
}

module.exports = { tmp, makeDb, salesPack, fakeModel, IR_AMAZON_OCT, Q_AMAZON_OCT, SALES_ROWS };
