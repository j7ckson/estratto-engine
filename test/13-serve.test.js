'use strict';
// rc.6 section 5: estratto serve (HTTP on 127.0.0.1)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startServe } = require('../src/serve/index.js');
const h = require('./helpers-ws.js');

/** raw request so Host / Origin / path can be set freely */
function call(srv, { method = 'GET', url = '/', headers = {}, body, host, json = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const hd = { host: host === undefined ? `127.0.0.1:${srv.port}` : host, ...headers };
    if (data !== null && !hd['content-type']) hd['content-type'] = 'application/json';
    if (data !== null) hd['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: url, headers: hd, setHost: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let j = null; if (json) { try { j = JSON.parse(text); } catch (_) {} } resolve({ status: res.statusCode, headers: res.headers, text, json: j }); });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const api = (srv, x, o = {}) => call(srv, { ...x, headers: { 'x-estratto-token': srv.sessionToken, ...(o.owner ? { 'x-estratto-owner': o.owner } : {}), ...(x.headers || {}) } });

async function setup(t, wsOpts = {}, serveOpts = {}) {
  const x = await h.makeWs(t, wsOpts);
  const ui = path.join(x.root, 'ui'); fs.mkdirSync(ui);
  fs.writeFileSync(path.join(ui, 'estratto-ask.js'), "customElements.define('estratto-ask', class extends HTMLElement {});");
  fs.writeFileSync(path.join(ui, 'estratto-settings.js'), "customElements.define('estratto-settings', class extends HTMLElement {});");
  fs.writeFileSync(path.join(x.root, 'secret.txt'), 'TOP SECRET');
  const srv = await startServe(x.ws, { port: 0, uiDir: ui, ...serveOpts });
  t.after(() => srv.close());
  x.srv2 = srv; x.owner = x.ws.config.access.ownerToken; x.ui = ui;
  return { x, srv };
}

test('serve: binds to 127.0.0.1 only', async (t) => {
  const { srv } = await setup(t);
  assert.equal(srv.server.address().address, '127.0.0.1');
});

test('serve: Host header must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding) -> 403', async (t) => {
  const { srv } = await setup(t);
  for (const host of ['evil.example.com', `evil.example.com:${srv.port}`, '127.0.0.1', `127.0.0.1:${srv.port + 1}`, `localhost.evil.com:${srv.port}`, `127.0.0.1.evil.com:${srv.port}`]) {
    const r = await api(srv, { url: '/api/status', host });
    assert.equal(r.status, 403, host); assert.equal(r.json.error.code, 'bad_host');
    assert.equal((await call(srv, { url: '/', host })).status, 403, 'pages too: ' + host);
    assert.equal((await call(srv, { url: '/ui/estratto-ask.js', host })).status, 403, 'static too: ' + host);
  }
  assert.equal((await api(srv, { url: '/api/status', host: `localhost:${srv.port}` })).status, 200);
  assert.equal((await api(srv, { url: '/api/status' })).status, 200);
});

test('serve: foreign Origin -> 403 (also preflight); same-origin and no Origin pass; allowedOrigins get CORS headers', async (t) => {
  const { x, srv } = await setup(t, { config: { surfaces: { serve: { allowedOrigins: ['https://app.example.com'] } } } });
  for (const origin of ['https://evil.example.com', 'null', 'http://127.0.0.1:1', `http://localhost.evil.com:${srv.port}`]) {
    const r = await api(srv, { url: '/api/status', headers: { origin } });
    assert.equal(r.status, 403, origin); assert.equal(r.json.error.code, 'bad_origin');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const p = await call(srv, { method: 'OPTIONS', url: '/api/ask', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-estratto-token,content-type' } });
    assert.equal(p.status, 403, 'preflight ' + origin);
    assert.equal((await api(srv, { method: 'POST', url: '/api/ask', headers: { origin }, body: { question: 'x' } })).status, 403);
  }
  assert.equal((await api(srv, { url: '/api/status', headers: { origin: `http://127.0.0.1:${srv.port}` } })).status, 200);
  const ok = await api(srv, { url: '/api/status', headers: { origin: 'https://app.example.com' } });
  assert.equal(ok.status, 200); assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.com');
  const pre = await call(srv, { method: 'OPTIONS', url: '/api/ask', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204); assert.match(pre.headers['access-control-allow-headers'], /x-estratto-token/);
  // pages are never shared cross-origin, not even with an allowed origin
  assert.equal((await call(srv, { url: '/', headers: { origin: 'https://app.example.com' } })).status, 403);
  assert.ok(x);
});

test('serve: every /api call needs the session token (missing / wrong -> 401); pages and static files do not', async (t) => {
  const { srv } = await setup(t);
  for (const [method, url, body] of [['GET', '/api/status'], ['POST', '/api/ask', { question: 'q' }], ['POST', '/api/cancel', { requestId: 'r' }], ['POST', '/api/confirm', { requestId: 'r', choice: 'accept' }], ['GET', '/api/rules'], ['GET', '/api/rules/m%3Agmv/preview'], ['POST', '/api/rules/m%3Agmv/confirm', {}], ['GET', '/api/settings'], ['PUT', '/api/settings', {}], ['PUT', '/api/settings/key', { apiKey: 'k' }], ['POST', '/api/data/add', { path: '/x' }], ['POST', '/api/data/refresh', {}], ['GET', '/api/usage'], ['GET', '/api/nothing']]) {
    const none = await call(srv, { method, url, body });
    assert.equal(none.status, 401, method + ' ' + url); assert.equal(none.json.error.code, 'bad_token');
    const wrong = await call(srv, { method, url, body, headers: { 'x-estratto-token': 'nope' } });
    assert.equal(wrong.status, 401, 'wrong ' + url);
  }
  assert.equal((await call(srv, { url: '/ui/estratto-ask.js', json: false })).status, 200);
  assert.equal((await call(srv, { url: '/', json: false })).status, 200);
});

test('serve: an asker (no owner key) cannot change rules, settings, the key or data -> 403; a wrong owner key is just an asker', async (t) => {
  const { x, srv } = await setup(t);
  const before = fs.readFileSync(path.join(x.dir, 'estratto.json'), 'utf8');
  const extra = path.join(x.root, 'more.csv'); fs.writeFileSync(extra, 'a,b\n1,2\n');
  const attempts = [
    ['PUT', '/api/settings', { limits: { dailyBudgetUSD: 99 } }],
    ['PUT', '/api/settings/key', { apiKey: 'sk-asker-attack-123' }],
    ['POST', '/api/data/add', { path: extra }],
    ['POST', '/api/rules/m%3Agmv/confirm', {}], ['POST', '/api/rules/m%3Agmv/reject', {}], ['POST', '/api/rules/m%3Agmv/revert', {}],
    ['POST', '/api/confirm', { requestId: 'whatever', choice: 'accept' }],
  ];
  for (const owner of [undefined, 'wrong-owner-token-0000000']) {
    for (const [method, url, body] of attempts) {
      const r = await api(srv, { method, url, body }, { owner });
      assert.equal(r.status, 403, method + ' ' + url); assert.equal(r.json.error.code, 'owner_only');
    }
  }
  assert.equal(fs.readFileSync(path.join(x.dir, 'estratto.json'), 'utf8'), before, 'config untouched');
  assert.equal(x.ws.keyStatus(), 'set'); assert.deepEqual(h.filesContaining(x.dir, 'sk-asker-attack-123'), []);
  assert.equal(x.ws.config.data.sources.length, 1);
  // what an asker CAN do
  assert.equal((await api(srv, { url: '/api/rules' })).status, 200);
  assert.equal((await api(srv, { url: '/api/settings' })).status, 200);
  assert.equal((await api(srv, { url: '/api/usage' })).status, 200);
  assert.equal((await api(srv, { method: 'POST', url: '/api/ask', body: { question: h.Q_AMAZON_OCT } })).status, 200);
  // the settings an asker sees are a short, safe view
  const s = (await api(srv, { url: '/api/settings' })).json;
  assert.equal(s.role, 'asker'); assert.equal(s.data, undefined); assert.equal(s.model.baseURL, undefined); assert.equal(s.privacy, undefined);
});

test('serve: owner can change settings (whitelisted fields only), add data, set the key; the key is never returned anywhere', async (t) => {
  const { x, srv } = await setup(t);
  const O = { owner: x.owner };
  const s0 = await api(srv, { url: '/api/settings' }, O);
  assert.equal(s0.json.role, 'owner'); assert.equal(s0.json.apiKey, 'set');
  assert.equal(s0.json.model.baseURL, x.srv.baseURL);
  assert.ok(s0.json.privacy.tables.find(t => t.name === 'sales'));
  const put = await api(srv, { method: 'PUT', url: '/api/settings', body: { limits: { dailyBudgetUSD: 3 }, privacy: { hiddenColumns: ['sales.sku'] } } }, O);
  assert.equal(put.status, 200, put.text); assert.equal(put.json.limits.dailyBudgetUSD, 3);
  assert.ok(put.json.privacy.tables.find(t => t.name === 'sales').columns.find(c => c.name === 'sku').hidden);
  // not editable over HTTP: sources, access, surfaces, rules packs, name
  for (const body of [{ access: { ownerToken: 'x'.repeat(20) } }, { surfaces: { mcp: { allowRuleChanges: true } } }, { rules: { packs: ['/etc/passwd'] } }, { name: 'z' }, { data: { sources: [] } }, { model: { apiKey: 'sk-x' } }]) {
    const r = await api(srv, { method: 'PUT', url: '/api/settings', body }, O);
    assert.equal(r.status, 403, JSON.stringify(body)); assert.equal(r.json.error.code, 'not_editable');
  }
  assert.equal((await api(srv, { method: 'PUT', url: '/api/settings', body: { limits: { dailyBudgetUSD: 'lots' } } }, O)).status, 400);
  assert.equal(x.ws.config.surfaces.mcp.allowRuleChanges, false);
  // key: write-only
  const NEWKEY = 'sk-owner-set-key-ABCDEFGH1234';
  const kr = await api(srv, { method: 'PUT', url: '/api/settings/key', body: { apiKey: NEWKEY } }, O);
  assert.deepEqual(kr.json, { apiKey: 'set' });
  assert.ok(!kr.text.includes(NEWKEY));
  for (const [url, o] of [['/api/status', {}], ['/api/status', O], ['/api/settings', {}], ['/api/settings', O], ['/api/usage', O], ['/api/rules', O]]) {
    const r = await api(srv, { url }, o);
    assert.ok(!r.text.includes(NEWKEY) && !r.text.includes(x.apiKey), url);
  }
  const pageSettings = await call(srv, { url: '/settings?owner=' + encodeURIComponent(x.owner), json: false });
  assert.ok(!pageSettings.text.includes(NEWKEY));
  assert.deepEqual(h.filesContaining(x.dir, NEWKEY), ['secrets.json']);
  // a bad JSON body that contains the key is not echoed back
  const bad = await api(srv, { method: 'PUT', url: '/api/settings/key', body: '{"apiKey": "' + NEWKEY + '" oops' }, O);
  assert.equal(bad.status, 400); assert.ok(!bad.text.includes(NEWKEY));
  // the next model call uses it
  await api(srv, { method: 'POST', url: '/api/ask', body: { question: h.Q_AMAZON_OCT } });
  assert.equal(x.srv.seen.at(-1).headers.authorization, 'Bearer ' + NEWKEY);
  // add data
  const extra = path.join(x.root, 'returns.csv'); fs.writeFileSync(extra, 'return_date,qty\n2026-10-02,1\n');
  const add = await api(srv, { method: 'POST', url: '/api/data/add', body: { path: extra } }, O);
  assert.equal(add.status, 200); assert.ok(add.json.tables.find(t => t.name === 'returns'));
  const dbf = await h.makeDb(x.root + '/z.duckdb');
  const mix = await api(srv, { method: 'POST', url: '/api/data/add', body: { path: dbf } }, O);
  assert.equal(mix.status, 400); assert.match(mix.json.error.message, /ONE DuckDB file/);
  const rfAsker = await api(srv, { method: 'POST', url: '/api/data/refresh', body: {} });
  assert.equal(rfAsker.status, 403);
  const rf = await api(srv, { method: 'POST', url: '/api/data/refresh', body: {} }, O);
  assert.equal(rf.status, 200); assert.equal(typeof rf.json.refreshed, 'boolean');
});

test('serve: ask / cancel / confirm; the answer has no raw, plan, sql or rows; confirming a plan needs the owner', async (t) => {
  const { x, srv } = await setup(t, { rules: false, reply: { metric: 'm:au_sales_amount', time_role: 't:sales', period: { kind: 'explicit', start: '2026-10-01', end: '2026-10-31' }, entities: [], output_shape: 'scalar' } });
  const a = await api(srv, { method: 'POST', url: '/api/ask', body: { question: '2026年10月 amount 合计？', requestId: 'q-1' } });
  assert.equal(a.status, 200); assert.equal(a.json.requestId, 'q-1'); assert.equal(a.json.status, 'needs_confirm');
  assert.equal(a.json.confirm.kind, 'plan');
  for (const k of ['requestId', 'status', 'answer', 'answerLine', 'facts', 'route', 'confirm', 'meta', 'usage']) assert.ok(k in a.json, k);
  for (const k of ['raw', 'plan', 'sql', 'rows']) assert.ok(!(k in a.json), k);
  assert.ok(a.json.facts.length && a.json.facts[0].value === 155.25);
  const deny = await api(srv, { method: 'POST', url: '/api/confirm', body: { requestId: 'q-1', choice: 'accept' } });
  assert.equal(deny.status, 403);
  assert.equal(x.ws.engine.rules.list({ kind: 'auto_confirm' }).length, 0, 'nothing was confirmed by the asker');
  const ok = await api(srv, { method: 'POST', url: '/api/confirm', body: { requestId: 'q-1', choice: 'accept' } }, { owner: x.owner });
  assert.equal(ok.status, 200); assert.equal(ok.json.status, 'verified');
  assert.equal(x.ws.engine.rules.list({ kind: 'auto_confirm' }).length, 1);
  assert.equal((await api(srv, { method: 'POST', url: '/api/confirm', body: { requestId: 'nope', choice: 'accept' } }, { owner: x.owner })).status, 400);
  assert.equal((await api(srv, { method: 'POST', url: '/api/ask', body: { question: '' } })).status, 400);
  assert.equal((await api(srv, { method: 'POST', url: '/api/ask', body: { question: 'x'.repeat(2001) } })).status, 400);
  assert.equal((await api(srv, { method: 'POST', url: '/api/ask', body: { question: 'q', requestId: 'bad id!' } })).status, 400);
  assert.equal((await api(srv, { method: 'POST', url: '/api/ask', body: 'question=q', headers: { 'content-type': 'text/plain' } })).status, 415);
  const c = await api(srv, { method: 'POST', url: '/api/cancel', body: { requestId: 'q-unknown' } });
  assert.deepEqual(c.json, { requestId: 'q-unknown', cancelled: false });
});

test('serve: cancel stops an in-flight ask', async (t) => {
  let release;
  const gate = new Promise(r => { release = r; });
  const srvModel = await h.modelServer(h.IR_AMAZON_OCT);
  t.after(() => srvModel.close());
  const { x, srv } = await setup(t);
  // slow model: wrap the engine's model through a hanging server
  const slow = http.createServer((req, res) => { req.resume(); gate.then(() => { try { res.end('{}'); } catch (_) {} }); });
  await new Promise(r => slow.listen(0, '127.0.0.1', r)); t.after(() => { release(); slow.close(); slow.closeAllConnections(); });
  await x.ws.saveConfig({ model: { baseURL: `http://127.0.0.1:${slow.address().port}/v1` } });
  const p = api(srv, { method: 'POST', url: '/api/ask', body: { question: 'a question that needs the model, please', requestId: 'slow-1' } });
  await new Promise(r => setTimeout(r, 300));
  const c = await api(srv, { method: 'POST', url: '/api/cancel', body: { requestId: 'slow-1' } });
  assert.equal(c.json.cancelled, true);
  const r = await p;
  assert.equal(r.json.status, 'cancelled');
});

test('serve: pages and static files: shells carry endpoint + session token; /settings needs the owner key; missing components give a plain message', async (t) => {
  const { x, srv } = await setup(t);
  const home = await call(srv, { url: '/', json: false });
  assert.equal(home.status, 200); assert.match(home.headers['content-type'], /text\/html/);
  assert.match(home.text, new RegExp(`<estratto-ask endpoint="http://127\\.0\\.0\\.1:${srv.port}" token="${srv.sessionToken}"`));
  assert.match(home.text, /<script type="module" src="\/ui\/estratto-ask\.js">/);
  assert.ok(!home.text.includes(x.owner), 'the ask page never carries the owner key');
  assert.match(home.headers['content-security-policy'], /script-src 'self'/);
  const noOwner = await call(srv, { url: '/settings', json: false });
  assert.equal(noOwner.status, 403); assert.ok(!noOwner.text.includes('<estratto-settings'));
  assert.equal((await call(srv, { url: '/settings?owner=wrong', json: false })).status, 403);
  const st = await call(srv, { url: '/settings?owner=' + encodeURIComponent(x.owner), json: false });
  assert.equal(st.status, 200);
  assert.match(st.text, /<estratto-settings /); assert.ok(st.text.includes(`owner-token="${x.owner}"`)); assert.ok(st.text.includes(`token="${srv.sessionToken}"`));
  assert.equal(st.headers['cache-control'], 'no-store');
  // localhost host name: endpoint follows the Host header (same origin)
  const viaLocalhost = await call(srv, { url: '/', host: `localhost:${srv.port}`, json: false });
  assert.ok(viaLocalhost.text.includes(`endpoint="http://localhost:${srv.port}"`));
  // component files that do not exist yet
  fs.rmSync(path.join(x.ui, 'estratto-ask.js'));
  const none = await call(srv, { url: '/', json: false });
  assert.equal(none.status, 200); assert.ok(!none.text.includes('<estratto-ask')); assert.match(none.text, /not installed/);
  assert.equal((await call(srv, { url: '/ui/estratto-ask.js', json: false })).status, 404);
});

test('serve: /ui serves only plain files of the ui folder: no listing, no traversal, no dotfiles, no symlink escape', async (t) => {
  const { x, srv } = await setup(t);
  fs.writeFileSync(path.join(x.ui, 'extra.css'), 'a{}'); fs.writeFileSync(path.join(x.ui, '.hidden.js'), 'x'); fs.mkdirSync(path.join(x.ui, 'sub')); fs.writeFileSync(path.join(x.ui, 'sub', 'in.js'), 'x');
  fs.symlinkSync(path.join(x.root, 'secret.txt'), path.join(x.ui, 'link.js'));
  fs.symlinkSync(path.join(x.root, 'pack.json'), path.join(x.ui, 'link2.json'));
  const ok = await call(srv, { url: '/ui/estratto-ask.js', json: false });
  assert.equal(ok.status, 200); assert.match(ok.headers['content-type'], /text\/javascript/); assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal((await call(srv, { url: '/ui/extra.css', json: false })).headers['content-type'].split(';')[0], 'text/css');
  const bads = ['/ui/', '/ui', '/ui/sub', '/ui/sub/', '/ui/sub/in.js', '/ui/.hidden.js', '/ui/..%2fsecret.txt', '/ui/%2e%2e/secret.txt', '/ui/../secret.txt', '/ui/..\\secret.txt', '/ui/%2e%2e%2fsecret.txt', '/ui/..%5csecret.txt', '/ui/%252e%252e/secret.txt', '/ui/estratto-ask.js%00.txt', '/ui/link.js', '/ui/link2.json', '/ui/nope.js', '/ui/estratto-ask.js/', '/ui//etc/passwd', '/ui/%00', '/ui/....//secret.txt', '/ui/x.txt'];
  for (const u of bads) {
    const r = await call(srv, { url: u, json: false });
    assert.ok([404, 400].includes(r.status), u + ' -> ' + r.status);
    assert.ok(!r.text.includes('TOP SECRET') && !r.text.includes('"name"'), u);
  }
  assert.equal((await call(srv, { method: 'POST', url: '/ui/estratto-ask.js', body: {} })).status, 405);
  assert.equal((await call(srv, { url: 'http://evil.example.com/x', json: false })).status, 400);
});

test('serve: daily budget over the HTTP API -> status refused, refusal.code daily_budget_exceeded', async (t) => {
  const { srv } = await setup(t, { config: { limits: { dailyBudgetUSD: 0.001, price: { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 2 } } } });
  const a = await api(srv, { method: 'POST', url: '/api/ask', body: { question: h.Q_AMAZON_OCT } });
  assert.equal(a.json.status, 'verified');
  const b = await api(srv, { method: 'POST', url: '/api/ask', body: { question: 'how much did we move overall during the previous month, roughly' } });
  assert.equal(b.json.status, 'refused'); assert.equal(b.json.refusal.code, 'daily_budget_exceeded');
  const u = await api(srv, { url: '/api/usage' });
  assert.ok(u.json.todayUSD >= 0.001); assert.equal(u.json.dailyBudgetUSD, 0.001); assert.equal(u.json.entries, undefined);
});

test('serve: rules API: list, preview (local numbers), owner confirm / reject / revert of an auto metric', async (t) => {
  const { x, srv } = await setup(t, { rules: false });
  const O = { owner: x.owner };
  const list = await api(srv, { url: '/api/rules' });
  assert.equal(list.json.mode, 'auto');
  const m = list.json.metrics.find(m => m.id === 'm:au_sales_amount');
  assert.equal(m.status, 'unconfirmed'); assert.match(m.formula, /sales 表 amount 合计/);
  const pv = await api(srv, { url: '/api/rules/' + encodeURIComponent('m:au_sales_amount') + '/preview' });
  assert.equal(pv.status, 200); assert.equal(pv.json.total, 195.25); assert.deepEqual(pv.json.lastMonth, { period: '2026-09', value: 40 });
  assert.equal(x.srv.seen.length, 0, 'no model call');
  assert.equal((await api(srv, { url: '/api/rules/m%3Anope/preview' })).status, 404);
  const c = await api(srv, { method: 'POST', url: '/api/rules/' + encodeURIComponent('m:au_sales_amount') + '/confirm', body: {} }, O);
  assert.equal(c.status, 200); assert.equal(c.json.status, 'confirmed');
  assert.equal((await api(srv, { method: 'POST', url: '/api/rules/' + encodeURIComponent('m:au_sales_amount') + '/confirm', body: {} }, O)).status, 409);
  assert.equal((await api(srv, { url: '/api/rules' })).json.metrics.find(m => m.id === 'm:au_sales_amount').status, 'confirmed');
  assert.equal((await api(srv, { url: '/api/rules' })).json.records.length, 1);
  const rv = await api(srv, { method: 'POST', url: '/api/rules/' + encodeURIComponent('m:au_sales_amount') + '/revert', body: {} }, O);
  assert.equal(rv.json.status, 'reverted');
  const rj = await api(srv, { method: 'POST', url: '/api/rules/' + encodeURIComponent('m:au_sales_qty') + '/reject', body: {} }, O);
  assert.equal(rj.json.status, 'rejected');
  const st = await api(srv, { url: '/api/status' }, O);
  assert.equal(st.json.role, 'owner'); assert.equal(st.json.apiKey, 'set'); assert.ok(st.json.sources[0].path);
  const sta = await api(srv, { url: '/api/status' });
  assert.equal(sta.json.role, 'asker'); assert.equal(sta.json.sources[0].path, undefined); assert.equal(sta.json.model.baseURL, undefined);
});

test('serve: hidden columns are not shown to askers; large / malformed bodies are rejected', async (t) => {
  const { x, srv } = await setup(t, { config: { privacy: { hiddenColumns: ['sales.sku'] } } });
  const a = await api(srv, { url: '/api/status' });
  assert.ok(!a.json.tables[0].columns.some(c => c.name === 'sku'));
  const o = await api(srv, { url: '/api/status' }, { owner: x.owner });
  assert.ok(o.json.tables[0].columns.find(c => c.name === 'sku').hidden);
  assert.equal((await api(srv, { method: 'POST', url: '/api/ask', body: 'x'.repeat(70000) })).status, 413);
  assert.equal((await api(srv, { method: 'POST', url: '/api/ask', body: '[1,2]' })).status, 400);
  assert.equal((await api(srv, { method: 'POST', url: '/api/ask', body: '' })).status, 400);
});
