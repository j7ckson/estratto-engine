'use strict';
// 7. CLI smoke test with a fake model behind a tiny local http server
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./helpers.js');

const BIN = path.join(__dirname, '..', 'bin', 'estratto.js');
const CSV = 'order_date,channel,sku,qty,amount\n' + h.SALES_ROWS.map(r => r.join(',')).join('\n') + '\n';

function startServer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(data), url: req.url });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'cmpl-' + seen.length, model: 'cli-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, baseURL: `http://127.0.0.1:${server.address().port}/v1` })));
}
function runCli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
  });
}

test('estratto ask: csv + rules + fake model server -> ANSWER line, api key from ESTRATTO_API_KEY only', async (t) => {
  const dir = h.tmp(); const csv = path.join(dir, 'sales.csv'); fs.writeFileSync(csv, CSV);
  const rules = path.join(dir, 'pack.json'); fs.writeFileSync(rules, JSON.stringify(h.salesPack()));
  const { server, seen, baseURL } = await startServer(h.IR_AMAZON_OCT);
  t.after(() => server.close());
  const r = await runCli(['ask', '--data', csv, '--rules', rules, '--base-url', baseURL, '--model', 'cli-model', '--data-dir', path.join(dir, 'state'), '--anchor', '2026-10-22', '--no-vectors', h.Q_AMAZON_OCT], { ESTRATTO_API_KEY: 'cli-key-1' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ANSWER: 49\.75/);
  assert.match(r.err, /\[status\] verified/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, 'Bearer cli-key-1');
  assert.equal(seen[0].body.model, 'cli-model');
  assert.equal(seen[0].body.thinking, false);
  assert.ok(fs.existsSync(path.join(dir, 'state', 'reuse.db')));
  assert.ok(!r.out.includes('cli-key-1') && !r.err.includes('cli-key-1'));

  // second run: answered from the persisted reuse cache, no new HTTP request; --json prints the structured result without raw
  const r2 = await runCli(['ask', '--data', csv, '--rules', rules, '--base-url', baseURL, '--model', 'cli-model', '--data-dir', path.join(dir, 'state'), '--anchor', '2026-10-22', '--no-vectors', '--json', h.Q_AMAZON_OCT], { ESTRATTO_API_KEY: 'cli-key-1' });
  assert.equal(r2.code, 0, r2.err);
  const j = JSON.parse(r2.out);
  assert.equal(j.status, 'verified'); assert.equal(j.route, 'reuse'); assert.ok(!('raw' in j));
  assert.equal(seen.length, 1);
});

test('estratto ask: duckdb file input, no key -> no Authorization header; usage errors exit 2', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const rules = path.join(dir, 'pack.json'); fs.writeFileSync(rules, JSON.stringify(h.salesPack()));
  const { server, seen, baseURL } = await startServer(h.IR_AMAZON_OCT);
  t.after(() => server.close());
  const r = await runCli(['ask', '--data', dbf, '--rules', rules, '--base-url', baseURL, '--model', 'm', '--data-dir', path.join(dir, 'state'), '--anchor', '2026-10-22', '--no-vectors', h.Q_AMAZON_OCT], {});
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /49\.75/);
  assert.equal(seen[0].headers.authorization, undefined);
  const bad = await runCli(['ask', '--data', dbf], {});
  assert.equal(bad.code, 2);
  const unk = await runCli(['frobnicate'], {});
  assert.equal(unk.code, 2);
});
