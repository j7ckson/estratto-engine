'use strict';
// helpers for the rc.6 workspace / serve / mcp tests: a fake OpenAI-compatible model server on 127.0.0.1 and workspace builders
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');
const W = require('../src/workspace.js');

const CSV = 'order_date,channel,sku,qty,amount\n' + h.SALES_ROWS.map(r => r.join(',')).join('\n') + '\n';

/** reply: object | (body, n) => object ; usage can be set per server */
function modelServer(reply, { usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200 } } } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      if (req.method !== 'POST') { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); return; }   // e.g. GET /models from `doctor --online`
      const body = JSON.parse(data);
      seen.push({ url: req.url, headers: req.headers, body, raw: data });
      const out = typeof reply === 'function' ? reply(body, seen.length) : reply;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'cmpl-' + seen.length, model: 'fake-m', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(out) } }], usage }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, baseURL: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(r => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }) })));
}

/** create + open a workspace in a temp home; returns { ws, home, dir, csv, root } */
async function makeWs(t, { reply = h.IR_AMAZON_OCT, config = {}, apiKey = 'sk-test-key-0123456789', rules = true, name = 'ws1', open = true, overrides = {}, serverOpts } = {}) {
  const root = h.tmp('estratto-ws-');
  const csv = path.join(root, 'sales.csv'); fs.writeFileSync(csv, CSV);
  const pack = path.join(root, 'pack.json'); fs.writeFileSync(pack, JSON.stringify(h.salesPack()));
  const srv = await modelServer(reply, serverOpts);
  const home = path.join(root, 'home');
  const cfg = { data: { sources: [{ type: 'file', path: csv }] }, ...(rules ? { rules: { packs: [pack] } } : {}), model: { provider: 'custom', baseURL: srv.baseURL, model: 'fake-m' }, behavior: { vectors: false, anchor: '2026-10-22' }, ...config };
  await W.initWorkspace({ home, name, config: cfg, apiKey });
  let ws = null;
  if (open) { ws = await W.openWorkspace({ home, name }, { onEvent: () => {}, ...overrides }); t.after(() => ws.close()); }
  t.after(() => srv.close());
  return { ws, home, name, dir: path.join(home, name), csv, root, srv, pack, apiKey };
}

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walkFiles(p)); else out.push(p); }
  return out;
}
/** files under dir whose bytes contain `needle` */
function filesContaining(dir, needle) {
  const n = Buffer.from(needle);
  return walkFiles(dir).filter(f => { try { return fs.readFileSync(f).includes(n); } catch (_) { return false; } }).map(f => path.relative(dir, f));
}

module.exports = { ...h, CSV, modelServer, makeWs, walkFiles, filesContaining };
