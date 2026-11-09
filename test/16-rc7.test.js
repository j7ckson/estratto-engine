'use strict';
// rc.7: rate-wording guard, Chinese date/currency columns in auto-rules mode, dimensions as first-class rule items,
// SQL-lane confirm, CLI friction (warning filter, stable token, --print-config), zh card text, UI wording
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createEngine } = require('..');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const h = require('./helpers-ws.js');
const rateGuard = require('../src/rate-guard.js');
const { metaType, metaTypeAuto } = require('../src/duck.js');
const { startServe } = require('../src/serve/index.js');

const BIN = path.join(__dirname, '..', 'bin', 'estratto.js');
const idleModel = () => h.fakeModel(() => ({}));
const sqlModel = (sql) => h.fakeModel((req) => (/SQL兜底/.test(req.messages[0].content) ? { sql, unit: '', label: 'total amount', params: [] } : { metric: 'none' }));
async function autoEngine(t, files, model = idleModel(), extra = {}) {
  const dir = h.tmp('estratto-rc7-');
  const paths = [];
  for (const [name, text] of Object.entries(files)) { fs.writeFileSync(path.join(dir, name), text); paths.push(path.join(dir, name)); }
  const e = await createEngine({ dataDir: path.join(dir, 'st'), data: { files: paths }, model, vectors: false, anchor: '2026-11-05', timezone: 'UTC', ...extra });
  t.after(() => e.close());
  return { e, dir, model };
}
const REFUNDS = 'order_id,退款金额\nO1,10\nO2,20\n';
const ORDERS = '下单日期,渠道,国家,金额,币种\n2026-09-03,Amazon,英国,10,GBP\n2026-10-04,Amazon,德国,20,EUR\n2026-10-09,独立站,英国,5,GBP\n2026-10-11,独立站,德国,7,EUR\n';
const noDigit = s => !/\d/.test(String(s));

// ---------------------------------------------------------------- 1. rate wording
test('1. "退款率是多少" is not answered with the refund amount: needs_confirm, no number, no model call (local route)', async (t) => {
  const { e, model } = await autoEngine(t, { 'refunds.csv': REFUNDS });
  for (const id of (await e.rules.metrics()).map(m => m.id)) await e.rules.confirm(id);
  const r = await e.ask('退款率是多少');
  assert.equal(r.status, 'needs_confirm');
  assert.equal(r.route, 'local');
  assert.equal(model.calls.length, 0);
  assert.ok(noDigit(r.answerLine), r.answerLine);
  assert.deepEqual(r.facts, []);
  assert.equal(r.confirm.kind, 'no_such_metric');
  assert.match(r.confirm.message, /还没有「退款率」/);
  assert.deepEqual(r.confirm.options, []);
  // the amount question itself is fine, and asking the rate again (now a reuse hit) is still guarded
  const amt = await e.ask('退款金额是多少');
  assert.equal(amt.status, 'verified'); assert.match(amt.answerLine, /30/);
  const again = await e.ask('退款率是多少');
  assert.equal(again.status, 'needs_confirm'); assert.ok(noDigit(again.answerLine));
  // nothing to confirm: a clear refusal, not a loop
  const c = await e.confirm(r.requestId, 'accept');
  assert.equal(c.status, 'refused'); assert.equal(c.refusal.code, 'no_such_metric'); assert.ok(noDigit(c.answerLine));
});

test('1. the message suggests numerator ÷ denominator when both metrics exist', async (t) => {
  const { e } = await autoEngine(t, { 'orders.csv': '下单日期,销售额,退款额\n2026-10-01,100,5\n2026-10-02,200,10\n' });
  for (const id of (await e.rules.metrics()).map(m => m.id)) await e.rules.confirm(id);
  const r = await e.ask('退款率是多少');
  assert.equal(r.status, 'needs_confirm');
  assert.match(r.confirm.message, /退款[^，。]*÷[^，。]*销售额/);
  assert.ok(noDigit(r.answerLine));
});

test('1. English wording, plan route and SQL route are guarded too; SQL that divides is not', async (t) => {
  // plan route: the model picks the amount metric for "refund rate"
  const planModel = h.fakeModel(() => ({ metric: 'm:au_refunds', output_shape: 'scalar' }));
  const a = await autoEngine(t, { 'refunds.csv': REFUNDS }, planModel);
  for (const m of await a.e.rules.metrics()) await a.e.rules.confirm(m.id);
  const r1 = await a.e.ask('Refund Amount rate');
  assert.ok(a.model.calls.length >= 1, 'went through the model');
  assert.equal(r1.route, 'plan');
  assert.equal(r1.status, 'needs_confirm'); assert.equal(r1.confirm.kind, 'no_such_metric'); assert.ok(noDigit(r1.answerLine));
  // sql route
  const b = await autoEngine(t, { 'refunds.csv': REFUNDS }, sqlModel('SELECT SUM("退款金额") AS v FROM refunds'));
  const r2 = await b.e.ask('平均折扣占比是多少');
  assert.equal(r2.route, 'sql'); assert.equal(r2.status, 'needs_confirm'); assert.equal(r2.confirm.kind, 'no_such_metric'); assert.ok(noDigit(r2.answerLine));
  const c = await autoEngine(t, { 'refunds.csv': REFUNDS }, sqlModel('SELECT SUM("退款金额") / COUNT(*) AS v FROM refunds'));
  const r3 = await c.e.ask('平均每单退款金额是多少');
  assert.equal(r3.route, 'sql'); assert.notEqual(r3.confirm && r3.confirm.kind, 'no_such_metric'); assert.match(r3.answerLine, /15/);
});

test('1. kind detection: ratio / average / growth / SQL division count as a ratio-like answer; totals and counts do not', () => {
  const reg = { metric: id => ({ r: { kind: 'ratio' }, a: { kind: 'simple', agg: 'avg' }, s: { kind: 'simple', agg: 'sum' }, p: { kind: 'simple', agg: 'sum', platform_ratio: true } })[id] };
  const like = plan => rateGuard.answerIsRatioLike({ plan }, reg);
  assert.equal(like({ metric_ids: ['r'] }), true);
  assert.equal(like({ metric_ids: ['a'] }), true);
  assert.equal(like({ metric_ids: ['p'] }), true);
  assert.equal(like({ metric_ids: ['s'] }), false);
  assert.equal(like({ metric_ids: ['s'], formula: { kind: 'share' } }), true);
  assert.equal(like({ metric_ids: ['s'], comparison: { kind: 'yoy' } }), true);
  assert.equal(like({ metric_ids: ['s'], comparison: { kind: 'none' } }), false);
  assert.equal(rateGuard.answerIsRatioLike({ lane: 'sql', sql: 'SELECT a/b FROM t' }, reg), true);
  assert.equal(rateGuard.answerIsRatioLike({ lane: 'sql', sql: "SELECT AVG(a) FROM t WHERE d = '2026/10'" }, reg), true);
  assert.equal(rateGuard.answerIsRatioLike({ lane: 'sql', sql: "SELECT SUM(a) FROM t WHERE d = '2026/10' -- 1/2" }, reg), false);
  for (const q of ['退款率', '各渠道占比', '占总额的比例', '百分比', '平均客单价', '人均', 'conversion rate', 'refund ratio', 'sales share', 'avg order value', 'revenue per order', '占 %']) assert.ok(rateGuard.asksRate(q), q);
  for (const q of ['总销售额', '退款金额', 'sales per channel', '折扣超过10%的订单数', '各渠道订单数', 'total revenue']) assert.ok(!rateGuard.asksRate(q), q);
});

test('1. with a supplied rules pack nothing changes: a rate-worded question keeps its rc.6 answer', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel(() => h.IR_AMAZON_OCT);
  const e = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, rules: [h.salesPack()], model, vectors: false, anchor: '2026-10-22' });
  t.after(() => e.close());
  const ok = await e.ask(h.Q_AMAZON_OCT);
  assert.equal(ok.status, 'verified');
  for (const q of ['2026年10月 Amazon 的销售额占比是多少？', '销售额占比', '平均销售额是多少']) {
    const r = await e.ask(q);   // the rc.6 answers (recorded from the rc.6 build): the core's own refusals, never our message
    assert.notEqual(r.confirm && r.confirm.kind, 'no_such_metric', q);
    assert.ok(!/还没有「/.test(r.answer), q);
  }
  assert.equal((await e.ask('销售额占比')).status, 'needs_confirm');
  assert.equal((await e.ask('平均销售额是多少')).status, 'refused');
});

// ---------------------------------------------------------------- 2. date columns
test('2. auto mode: a DATE column with a Chinese name gets a time role (same preview as order_date); pack mode keeps the name heuristic', async (t) => {
  const prev = {};
  for (const col of ['order_date', '下单日期', '时间']) {
    const { e } = await autoEngine(t, { 't.csv': `${col},amt\n2026-09-03,10\n2026-10-04,20\n2026-10-09,5\n` });
    const id = (await e.rules.metrics()).find(x => /amt/.test(x.field || ''))?.id;
    prev[col] = await e.rules.preview(id);
    assert.deepEqual(prev[col].lastMonth, { period: '2026-10', value: 25 }, col);
    const q = await e.ask('上个月的 amt 合计是多少');
    assert.ok(!/未登记的字段/.test(q.answerLine), q.answerLine);
  }
  assert.equal(metaTypeAuto('下单日期', 'DATE'), 'date');
  assert.equal(metaTypeAuto('created', 'TIMESTAMP WITH TIME ZONE'), 'date');
  assert.equal(metaTypeAuto('月份', 'VARCHAR'), 'date');
  assert.equal(metaTypeAuto('qty', 'BIGINT'), 'number'); assert.equal(metaTypeAuto('p', 'DECIMAL(18,3)'), 'number'); assert.equal(metaTypeAuto('备注', 'VARCHAR'), 'text');
  assert.equal(metaType('下单日期', 'DATE'), 'text', 'the benchmark heuristic is unchanged');
});

// ---------------------------------------------------------------- 3. currency
test('3. Chinese currency column with several codes: metrics are flagged, preview and answers say so, SQL lane too', async (t) => {
  const sql = sqlModel('SELECT SUM("金额") AS v FROM orders');
  const { e, dir } = await autoEngine(t, { 'orders.csv': ORDERS }, sql);
  const pack = JSON.parse(fs.readFileSync(path.join(dir, 'st/rules/auto-pack.json'), 'utf8'));
  assert.equal(pack._meta.currency.orders.multi, true);
  assert.deepEqual(pack._meta.currency.orders.codes.sort(), ['EUR', 'GBP']);
  const amount = pack.metrics.find(m => m.field === '金额');
  assert.equal(amount.multi_currency, true); assert.equal(amount.unit, '');
  const pv = await e.rules.preview('m:' + amount.id);
  assert.match(pv.currencyNote, /多种币种/);
  assert.deepEqual(pv.byCurrency.map(x => x.currency).sort(), ['EUR', 'GBP']);
  assert.equal(pv.byCurrency.find(x => x.currency === 'GBP').value, 15);
  // plan route / local: the answer carries the note
  const r = await e.ask('金额合计是多少');
  assert.match(r.answerLine, /含多种币种，未换汇，不能直接相加/);
  // sql route
  const r2 = await e.ask('total revenue please');
  assert.equal(r2.route, 'sql'); assert.match(r2.answerLine, /含多种币种，未换汇，不能直接相加/);
  // split by currency: no note needed
  const s2 = sqlModel('SELECT "币种" AS c, SUM("金额") AS v FROM orders GROUP BY 1');
  const b = await autoEngine(t, { 'orders.csv': ORDERS }, s2);
  const r3 = await b.e.ask('revenue by currency please');
  assert.ok(!/含多种币种/.test(r3.answerLine), r3.answerLine);
});

test('3. a single Chinese currency is named in the unit (no silent 元)', async (t) => {
  const { e, dir } = await autoEngine(t, { 'orders.csv': '日期,销售额,货币\n2026-10-01,10,USD\n2026-10-02,5,USD\n' });
  for (const m of await e.rules.metrics()) await e.rules.confirm(m.id);
  const pack = JSON.parse(fs.readFileSync(path.join(dir, 'st/rules/auto-pack.json'), 'utf8'));
  const m = pack.metrics.find(x => x.field === '销售额');
  assert.equal(m.unit, '美元'); assert.equal(m.currency, 'USD'); assert.ok(!m.multi_currency);
  const r = await e.ask('销售额合计');
  assert.match(r.answerLine, /15\s*美元/);
});

// ---------------------------------------------------------------- 4. dimensions
test('4. engine.rules.dimensions(): list, preview (distinct + top 5, local), confirm / reject / revert by d: id', async (t) => {
  const { e, model } = await autoEngine(t, { 'orders.csv': ORDERS });
  const dims = e.rules.dimensions();
  const ch = dims.find(d => d.name === '渠道');
  assert.ok(ch); assert.match(ch.id, /^d:/); assert.equal(ch.status, 'unconfirmed'); assert.equal(ch.kind, 'column'); assert.equal(ch.dataset, 'orders'); assert.equal(ch.field, '渠道'); assert.equal(ch.auto, true);
  assert.ok(dims.some(d => d.kind === 'timeBucket'));
  const pv = await e.rules.preview(ch.id);
  assert.equal(pv.kind, 'dimension'); assert.equal(pv.distinct, 2); assert.equal(pv.rows, 4);
  assert.deepEqual(pv.top.map(x => [x.value, x.count]), [['Amazon', 2], ['独立站', 2]]);
  const tb = dims.find(d => d.kind === 'timeBucket');
  const pt = await e.rules.preview(tb.id);
  assert.equal(pt.distinct, 2); assert.deepEqual(pt.top.map(x => x.value).sort(), ['2026-09-01', '2026-10-01']);
  assert.equal(model.calls.length, 0, 'previews are local');
  // confirm -> record -> status
  const rec = await e.rules.confirm(ch.id);
  assert.equal(rec.kind, 'auto_confirm'); assert.deepEqual(rec.items, [{ kind: 'dim', id: ch.id }]);
  assert.equal(e.rules.dimensions().find(d => d.id === ch.id).status, 'confirmed');
  assert.equal(e.rules.dimensions().find(d => d.id === ch.id).recordId, rec.id);
  assert.equal((await e.rules.preview(rec.id)).kind, 'dimension');
  await assert.rejects(() => e.rules.confirm(ch.id), /already confirmed/);
  await e.rules.revert(ch.id);
  assert.equal(e.rules.dimensions().find(d => d.id === ch.id).status, 'reverted');
  // reject -> listed as rejected, left out of the rules; revert brings it back
  const co = dims.find(d => d.name === '国家');
  await e.rules.reject(co.id);
  assert.equal(e.rules.dimensions().find(d => d.id === co.id).status, 'rejected');
  await e.rules.revert(co.id);
  assert.equal(e.rules.dimensions().find(d => d.id === co.id).status, 'unconfirmed');
  // metric ids and dimension ids do not mix up
  assert.ok((await e.rules.metrics()).every(m => m.id.startsWith('m:')));
  await assert.rejects(() => e.rules.preview('d:nope'), /unknown/);
});

test('4. confirming metrics and dimensions makes a grouped answer verified (the Q2 case of the simulation)', async (t) => {
  const { e } = await autoEngine(t, { 'orders.csv': '下单日期,渠道,销量\n2026-10-01,Amazon,3\n2026-10-02,独立站,4\n2026-10-03,Amazon,5\n' });
  const r0 = await e.ask('各渠道的销量');
  assert.equal(r0.status, 'needs_confirm');
  for (const m of await e.rules.metrics()) await e.rules.confirm(m.id);
  for (const d of e.rules.dimensions()) await e.rules.confirm(d.id);
  const r1 = await e.ask('各渠道的销量');
  assert.equal(r1.status, 'verified');
  assert.match(r1.answerLine, /Amazon/); assert.match(r1.answerLine, /8/);
});

test('4. HTTP /api/rules returns dimensions; a dimension preview is owner-only; MCP list_rules lists dimensions without values', async (t) => {
  const x = await h.makeWs(t, { rules: false });
  const ui = path.join(x.root, 'ui'); fs.mkdirSync(ui);
  const srv = await startServe(x.ws, { port: 0, uiDir: ui }); t.after(() => srv.close());
  const get = (url, owner) => fetch(`http://127.0.0.1:${srv.port}${url}`, { headers: { 'X-Estratto-Token': srv.sessionToken, ...(owner ? { 'X-Estratto-Owner': x.ws.config.access.ownerToken } : {}) } }).then(async r => ({ status: r.status, json: await r.json() }));
  const rules = await get('/api/rules');
  assert.equal(rules.status, 200);
  assert.ok(Array.isArray(rules.json.dimensions) && rules.json.dimensions.length);
  const ch = rules.json.dimensions.find(d => d.name === 'channel');
  assert.ok(ch, JSON.stringify(rules.json.dimensions.map(d => d.name)));
  assert.equal((await get(`/api/rules/${encodeURIComponent(ch.id)}/preview`)).status, 403);
  const ok = await get(`/api/rules/${encodeURIComponent(ch.id)}/preview`, true);
  assert.equal(ok.status, 200); assert.equal(ok.json.kind, 'dimension'); assert.equal(ok.json.distinct, 3);
  assert.equal((await get(`/api/rules/${encodeURIComponent(rules.json.metrics[0].id)}/preview`)).status, 200, 'metric previews stay open to askers');
  const post = await fetch(`http://127.0.0.1:${srv.port}/api/rules/${encodeURIComponent(ch.id)}/confirm`, { method: 'POST', headers: { 'X-Estratto-Token': srv.sessionToken, 'X-Estratto-Owner': x.ws.config.access.ownerToken, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 200);
  assert.equal((await get('/api/rules')).json.dimensions.find(d => d.id === ch.id).status, 'confirmed');
  // MCP
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', '--home', x.home, '--name', x.name], env: { PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'c', version: '1' }); await client.connect(transport); t.after(() => client.close());
  const lr = await client.callTool({ name: 'list_rules', arguments: {} });
  assert.ok(lr.structuredContent.dimensions.length); assert.ok(lr.structuredContent.dimensions.every(d => d.id && d.status && !('top' in d)));
  assert.match(lr.content.map(c => c.text).join('\n'), /dimension +d:/);
  assert.ok(!/Amazon|Shopify|eBay/.test(JSON.stringify(lr)), 'no data values in list_rules');
});

// ---------------------------------------------------------------- 5. SQL lane confirm
test('5. engine.confirm on a SQL-lane answer that rests only on auto-named fields makes it verified (no loop)', async (t) => {
  const { e } = await autoEngine(t, { 'orders.csv': 'order_id,channel,amount\nO1,A,10\nO2,B,20\nO3,A,5\n' }, sqlModel('SELECT SUM(orders.amount) AS v FROM orders'));
  const r = await e.ask('total revenue');
  assert.equal(r.status, 'needs_confirm'); assert.equal(r.route, 'sql');
  const c = await e.confirm(r.requestId, 'accept');
  assert.equal(c.status, 'verified');
  assert.equal(e.rules.list({ kind: 'auto_confirm' }).length, 1);
  assert.equal((await e.ask('total revenue')).status, 'verified');
});

test('5. a SQL-lane answer that rests on a NEW calculation cannot be confirmed by a click: clear refusal, README limitation', async (t) => {
  const { e } = await autoEngine(t, { 'orders.csv': 'order_id,channel,amount\nO1,A,10\nO2,B,20\nO3,A,5\n' }, sqlModel("SELECT SUM(CASE WHEN channel = 'A' THEN amount ELSE 0 END) AS v FROM orders"));
  const r = await e.ask('total revenue of A');
  assert.equal(r.status, 'needs_confirm');
  const c = await e.confirm(r.requestId, 'accept');
  assert.equal(c.status, 'refused'); assert.equal(c.refusal.code, 'sql_not_confirmable');
  assert.match(c.answerLine, /这类新算法 1\.0 还不能一键确认，请在口径里把它定义成指标/);
  assert.equal(c.route, 'sql');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8'), /sql_not_confirmable/);
});

// ---------------------------------------------------------------- 6. friction
function runCli(args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err })); p.stdin.end();
  });
}
test('6. CLI: no node:sqlite ExperimentalWarning; other warnings are not hidden', async (t) => {
  const root = h.tmp('estratto-cli7-'); const csv = path.join(root, 's.csv'); fs.writeFileSync(csv, h.CSV);
  const srv = await h.modelServer({}); t.after(() => srv.close());
  const home = path.join(root, 'home');
  const init = await runCli(['init', '--yes', '--home', home, '--name', 'w', '--data', csv, '--provider', 'custom', '--base-url', srv.baseURL, '--model', 'm', '--no-vectors']);
  assert.equal(init.code, 0, init.err);
  const ask = await runCli(['rules', 'list', '--home', home, '--name', 'w']);
  assert.equal(ask.code, 0, ask.err);
  assert.ok(!/ExperimentalWarning|SQLite is an experimental/.test(ask.err), ask.err);
  assert.match(ask.out, /dimension\/column/); assert.match(ask.out, /metric\/simple/);
  // the filter is narrow: another experimental warning still prints
  const src = fs.readFileSync(BIN, 'utf8');
  assert.match(src, /type === 'ExperimentalWarning' && \/\\bSQLite\\b\/\.test\(message\)/);
});
test('6. serve --token / surfaces.serve.token give a stable token; --print-config json prints it; config get hides it', async (t) => {
  const root = h.tmp('estratto-cli7-'); const csv = path.join(root, 's.csv'); fs.writeFileSync(csv, h.CSV);
  const srv = await h.modelServer({}); t.after(() => srv.close());
  const home = path.join(root, 'home');
  assert.equal((await runCli(['init', '--yes', '--home', home, '--name', 'w', '--data', csv, '--provider', 'custom', '--base-url', srv.baseURL, '--model', 'm', '--no-vectors'])).code, 0);
  const serve = async (extra) => {
    const p = spawn(process.execPath, [BIN, 'serve', '--home', home, '--name', 'w', '--port', '0', '--print-config', 'json', ...extra], { env: { PATH: process.env.PATH } });
    let out = ''; p.stdout.on('data', d => { out += d; });
    for (let i = 0; i < 200 && !out.includes('\n'); i++) await new Promise(r => setTimeout(r, 50));
    p.kill('SIGINT'); await new Promise(r => p.on('close', r));
    return JSON.parse(out.split('\n')[0]);
  };
  const a = await serve(['--token', 'my-stable-token-0123456789']);
  assert.equal(a.token, 'my-stable-token-0123456789'); assert.equal(a.tokenStable, true);
  assert.match(a.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal(a.port, Number(a.endpoint.split(':')[2]));
  assert.match(a.settingsUrl, /\/settings\?owner=/); assert.ok(a.ownerKey);
  const rnd1 = await serve([]), rnd2 = await serve([]);
  assert.notEqual(rnd1.token, rnd2.token); assert.equal(rnd1.tokenStable, false);
  // config
  const set = await runCli(['config', 'set', 'surfaces.serve.token', 'config-token-0123456789-abc', '--home', home, '--name', 'w']);
  assert.equal(set.code, 0, set.err); assert.ok(!set.out.includes('config-token-0123456789-abc'));
  const fromCfg = await serve([]);
  assert.equal(fromCfg.token, 'config-token-0123456789-abc');
  const got = await runCli(['config', 'get', '--home', home, '--name', 'w']);
  assert.ok(!got.out.includes('config-token-0123456789-abc')); assert.match(got.out, /"token": "\(set\)"/);
  const bad = await runCli(['serve', '--home', home, '--name', 'w', '--token', 'short']);
  assert.equal(bad.code, 2, bad.err + bad.out);
  assert.notEqual((await runCli(['config', 'set', 'surfaces.serve.token', 'x y', '--home', home, '--name', 'w'])).code, 0);
});
test('6. zh cards: no English sentence in the auto-rules confirm card; pack mode keeps the rc.6 text', async (t) => {
  const { e } = await autoEngine(t, { 'orders.csv': 'order_id,channel,amount\nO1,A,10\n' }, sqlModel('SELECT SUM(orders.amount) AS v FROM orders'));
  const r = await e.ask('total revenue');
  assert.equal(r.confirm.kind, 'plan');
  assert.ok(!/[A-Za-z]{4,} [a-z]{3,} [a-z]{3,}/.test(r.confirm.message), r.confirm.message);
  assert.match(r.confirm.message, /自动认的/);
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const p = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, rules: [h.salesPack()], model: h.fakeModel(() => ({ metric: 'none' })), vectors: false, anchor: '2026-10-22' });
  t.after(() => p.close());
  const { confirmOf } = require('../src/status.js');
  assert.match(confirmOf({ lane: 'sql', plan: {} , tier: 'pending' }, 'needs_confirm').message, /^Field meaning or calculation/);
});

// ---------------------------------------------------------------- 7. UI wording
test('7. UI: Latin/CJK spacing helper, dimensions section, no-such-metric card', () => {
  const settings = fs.readFileSync(path.join(__dirname, '..', 'ui', 'estratto-settings.js'), 'utf8');
  const ask = fs.readFileSync(path.join(__dirname, '..', 'ui', 'estratto-ask.js'), 'utf8');
  const m = /const cjkSpace = s => ([^\n]+)/.exec(settings);
  assert.ok(m);
  const cjkSpace = new Function('return (s => ' + m[1].replace(/;$/, '') + ')')();
  assert.equal(cjkSpace('orders表的 amount 列求和'), 'orders 表的 amount 列求和');
  assert.equal(cjkSpace('下单日期（按月）'), '下单日期（按月）');
  assert.match(settings, /cjkSpace\(`\$\{tab\}表的 \$\{col\} 列\$\{op\}`\)/);
  assert.match(settings, /_dims\(\)/); assert.match(settings, /dims: '分组用的字段（维度）'/); assert.match(settings, /rules\.dimensions/);
  assert.match(ask, /no_such_metric/); assert.match(ask, /缺指标/);
});
