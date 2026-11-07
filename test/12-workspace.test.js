'use strict';
// rc.6 sections 1-3: workspace, config schema, hidden columns, data auto-refresh, daily budget, rules.preview
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('..');
const W = require('../src/workspace.js');
const { createLedger, costOf } = require('../src/ledger.js');
const h = require('./helpers-ws.js');

const mode = f => fs.statSync(f).mode & 0o777;
const AUTO_IR = { metric: 'm:au_sales_amount', time_role: 't:sales', period: { kind: 'explicit', start: '2026-10-01', end: '2026-10-31' }, entities: [], output_shape: 'scalar' };

test('workspace: init writes 0700/0600 files, key only in secrets.json, owner token generated', async (t) => {
  const x = await h.makeWs(t, { open: false });
  assert.equal(mode(x.dir), 0o700);
  assert.equal(mode(path.join(x.dir, 'estratto.json')), 0o600);
  assert.equal(mode(path.join(x.dir, 'secrets.json')), 0o600);
  const cfg = JSON.parse(fs.readFileSync(path.join(x.dir, 'estratto.json'), 'utf8'));
  assert.equal(cfg.version, 1); assert.equal(cfg.name, 'ws1');
  assert.ok(cfg.access.ownerToken.length >= 16);
  assert.deepEqual(h.filesContaining(x.dir, x.apiKey), ['secrets.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.dir, 'secrets.json'), 'utf8')).apiKey, x.apiKey);
  await assert.rejects(() => W.initWorkspace({ home: x.home, name: 'ws1', config: cfg }), /already exists/);
});

test('workspace: config schema rejects mixed duckdb + files, two duckdb files, unknown keys, bad names', async (t) => {
  const root = h.tmp(); const dbf = await h.makeDb(root + '/a.duckdb'); const csv = root + '/s.csv'; fs.writeFileSync(csv, h.CSV);
  const base = { version: 1, name: 'x' };
  assert.throws(() => W.validateConfig({ ...base, data: { sources: [{ type: 'duckdb', path: dbf }, { type: 'file', path: csv }] } }), /either ONE DuckDB file or any number of files\/folders/);
  assert.throws(() => W.validateConfig({ ...base, data: { sources: [{ type: 'duckdb', path: dbf }, { type: 'duckdb', path: dbf + '2' }] } }), /only one DuckDB/);
  assert.throws(() => W.validateConfig({ ...base, bogus: 1 }), /unknown setting: bogus/);
  assert.throws(() => W.validateConfig({ ...base, limits: { price: { inputPerM: 'x' } } }), /limits\.price\.inputPerM/);
  assert.throws(() => W.validateConfig({ ...base, behavior: { timezone: 'Mars/Base' } }), /time zone/);
  assert.throws(() => W.validateConfig({ ...base, data: { sources: [{ type: 'file', path: 'relative.csv' }] } }), /absolute/);
  assert.throws(() => W.workspaceDir(root, '../evil'), /workspace name/);
  const ok = W.validateConfig({ ...base, data: { sources: [{ type: 'file', path: csv }, { type: 'folder', path: root, pattern: '*.csv' }] } });
  assert.equal(ok.data.refresh, 'auto'); assert.equal(ok.surfaces.serve.port, 7317); assert.equal(ok.surfaces.mcp.allowRuleChanges, false);
});

test('workspace: ask over a fake local model server; key goes only in the Authorization header; usage.jsonl gets one priced line per call', async (t) => {
  const x = await h.makeWs(t, { config: { limits: { price: { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 2 } } } });
  const events = [];
  x.ws.on(e => events.push(e));
  const r = await x.ws.ask(h.Q_AMAZON_OCT);
  assert.equal(r.status, 'verified'); assert.match(r.answerLine, /49\.75/);
  assert.equal(x.srv.seen.length, 1);
  assert.equal(x.srv.seen[0].headers.authorization, 'Bearer ' + x.apiKey);
  const lines = fs.readFileSync(path.join(x.dir, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].requestId, r.requestId);
  assert.ok(Math.abs(lines[0].costUSD - 0.00102) < 1e-12);   // 800*1 + 200*0.1 + 100*2 per million
  assert.equal(x.ws.usage.today().calls, 1);
  assert.ok(Math.abs(x.ws.usage.today().spentUSD - 0.00102) < 1e-12);
  assert.deepEqual(h.filesContaining(x.dir, x.apiKey), ['secrets.json'], 'the key is in no other file (db, cache, usage, config)');
  assert.ok(!JSON.stringify(r).includes(x.apiKey) && !JSON.stringify(events).includes(x.apiKey));
  // a zero-call reuse hit writes no ledger line
  const r2 = await x.ws.ask(h.Q_AMAZON_OCT);
  assert.equal(r2.route, 'reuse');
  assert.equal(fs.readFileSync(path.join(x.dir, 'usage.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('ledger: cost formula incl. cached tokens (both field spellings); other days do not count; limit 0 blocks', async () => {
  const price = { inputPerM: 0.15, cachedInputPerM: 0.003, outputPerM: 0.6 };
  assert.ok(Math.abs(costOf({ prompt_tokens: 10000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 4000 } }, price) - (6000 * 0.15 + 4000 * 0.003 + 1000 * 0.6) / 1e6) < 1e-12);
  assert.ok(Math.abs(costOf({ prompt_tokens: 10000, completion_tokens: 1000, prompt_cache_hit_tokens: 4000, prompt_cache_miss_tokens: 6000 }, price) - (6000 * 0.15 + 4000 * 0.003 + 1000 * 0.6) / 1e6) < 1e-12);
  assert.equal(costOf(null, price), 0); assert.equal(costOf({ prompt_tokens: 5 }, null), 0);
  const f = path.join(h.tmp(), 'usage.jsonl');
  fs.writeFileSync(f, JSON.stringify({ at: '2000-01-01T00:00:00Z', day: '2000-01-01', requestId: 'old', costUSD: 50 }) + '\n');
  const l = createLedger({ file: f, timezone: 'Asia/Shanghai', price, dailyBudgetUSD: 1 });
  assert.equal(l.todayUSD(), 0); assert.equal(l.exceeded(), false); assert.equal(l.totalUSD(), 50);
  l.configure({ dailyBudgetUSD: 0 }); assert.equal(l.exceeded(), true);
});

test('daily budget: over the limit -> refused daily_budget_exceeded with NO model call; cache hits still answer', async (t) => {
  const x = await h.makeWs(t, { config: { limits: { dailyBudgetUSD: 0.001, price: { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 2 } } }, reply: (b, n) => n === 1 ? h.IR_AMAZON_OCT : { metric: 'm:qty', time_role: 't:sales', period: { kind: 'explicit', start: '2026-09-01', end: '2026-09-30' }, entities: [], output_shape: 'scalar' } });
  const first = await x.ws.ask(h.Q_AMAZON_OCT);
  assert.equal(first.status, 'verified');
  assert.equal(x.ws.usage.today().spentUSD >= 0.001, true);
  const n = x.srv.seen.length;
  const blocked = await x.ws.ask('how much did we move overall during the previous month, roughly');
  assert.equal(blocked.status, 'refused');
  assert.equal(blocked.refusal.code, 'daily_budget_exceeded');
  assert.equal(blocked.refusal.limitUSD, 0.001);
  assert.match(blocked.answerLine, /每日上限/);
  assert.equal(x.srv.seen.length, n, 'no request left the machine');
  assert.equal(blocked.usage.calls, 0);
  const cached = await x.ws.ask(h.Q_AMAZON_OCT);
  assert.equal(cached.status, 'verified'); assert.equal(cached.route, 'reuse');
  assert.equal(x.srv.seen.length, n);
  // raising the limit takes effect without a restart
  await x.ws.saveConfig({ limits: { dailyBudgetUSD: 5 } });
  const again = await x.ws.ask('how much did we move overall during the previous month, roughly');
  assert.ok(!(again.refusal && again.refusal.code === 'daily_budget_exceeded'));
  assert.ok(x.srv.seen.length > n, 'the model is called again once the limit allows it');
});

test('hidden columns: excluded from prompts, auto rules, tables() marks them; request bodies with a pack are unchanged', async (t) => {
  const root = h.tmp(); const csv = root + '/orders.csv';
  fs.writeFileSync(csv, 'order_date,channel,customer_email,amount\n2026-10-01,Amazon,a@x.com,10\n2026-10-02,eBay,b@y.com,20\n2026-09-01,Amazon,c@z.com,30\n');
  const seenA = [], seenB = [];
  const mk = (seen, hidden) => createEngine({ dataDir: root + (hidden ? '/dh' : '/dp'), data: { files: [csv] }, model: h.fakeModel(req => { seen.push(JSON.stringify(req.messages)); return { metric: 'm:au_orders_amount', time_role: 't:orders', period: { kind: 'explicit', start: '2026-10-01', end: '2026-10-31' }, entities: [], output_shape: 'scalar' }; }), vectors: false, anchor: '2026-10-22', ...(hidden ? { privacy: { hiddenColumns: ['orders.customer_email'] } } : {}) });
  const plain = await mk(seenA, false), hid = await mk(seenB, true);
  t.after(async () => { await plain.close(); await hid.close(); });
  const pc = plain.tables()[0].columns.map(c => c.name), hc = hid.tables()[0];
  assert.ok(pc.includes('customer_email') && !plain.tables()[0].columns.find(c => c.hidden));
  assert.deepEqual(hc.columns.filter(c => !c.hidden).map(c => c.name), ['order_date', 'channel', 'amount']);
  assert.deepEqual(hc.columns.filter(c => c.hidden).map(c => c.name), ['customer_email']);
  const pack = JSON.parse(fs.readFileSync(root + '/dh/rules/auto-pack.json', 'utf8'));
  assert.ok(!JSON.stringify(pack).includes('customer_email'));
  assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(root + '/dp/rules/auto-pack.json', 'utf8'))).includes('customer_email'), 'without hiding it is in the auto rules');
  await plain.ask('2026年10月 amount 合计？'); await hid.ask('2026年10月 amount 合计？');
  assert.ok(seenA[0].includes('customer_email'));
  assert.ok(!seenB.join('').includes('customer_email') && !seenB.join('').includes('a@x.com'));
  assert.ok(hid.info().hiddenColumns.includes('orders.customer_email'));
  // a table whose every column is hidden is not described at all
  const all = await createEngine({ dataDir: root + '/d9', data: { files: [csv, (() => { fs.writeFileSync(root + '/b.csv', 'x,y\n1,2\n'); return root + '/b.csv'; })()] }, model: h.fakeModel(() => ({})), vectors: false, privacy: { hiddenColumns: ['b.x', 'b.y'] } });
  t.after(() => all.close());
  const bt = all.tables().find(x => x.name === 'b');
  assert.equal(bt.hidden, true); assert.ok(bt.columns.every(c => c.hidden));
});

test('hidden columns with a supplied pack: request body is byte-identical to the one without privacy options', async (t) => {
  const mk = async (extra) => {
    const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb'); const bodies = [];
    const e = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, rules: [h.salesPack()], model: h.fakeModel(req => { bodies.push(JSON.stringify(req)); return h.IR_AMAZON_OCT; }), vectors: false, anchor: '2026-10-22', ...extra });
    await e.ask(h.Q_AMAZON_OCT); await e.close(); return bodies;
  };
  const a = await mk({}), b = await mk({ privacy: { hiddenColumns: [] } }), c = await mk({ privacy: { hiddenColumns: ['nope.none'] } });
  assert.equal(a.length, 1); assert.deepEqual(a, b); assert.deepEqual(a, c);
});

test('hidden columns: the SQL fallback prompt omits them and model-written SQL that names one is blocked locally', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  let n = 0;
  const mk = async (hidden, sql) => {
    const seen = [];
    const e = await createEngine({ dataDir: dir + '/d' + (n++), data: { duckdb: dbf }, model: h.fakeModel(req => { seen.push(req.messages[0].content + req.messages[1].content); if (req.messages[1].content.includes('"candidates"')) return { metric: 'none', unresolved: [{ slot: 'metric', reason: 'capability_gap' }] }; return { sql, unit: '', label: 'x', params: [] }; }), vectors: false, anchor: '2026-10-22', rules: [h.salesPack()], ...(hidden ? { privacy: { hiddenColumns: ['sales.qty'] } } : {}) });
    t.after(() => e.close());
    return { e, seen };
  };
  const Q = '全部渠道一共卖了多少件？';
  const open = await mk(false, 'SELECT SUM(qty) AS v FROM sales');
  const r0 = await open.e.ask(Q);
  assert.equal(r0.route, 'sql'); assert.match(r0.answerLine, /15/);
  assert.ok(open.seen.join('').includes('qty'), 'without hiding, the column is in the prompt');
  const hid = await mk(true, 'SELECT SUM(qty) AS v FROM sales');
  const r1 = await hid.e.ask(Q);
  assert.ok(!hid.seen.join('').includes('qty'), 'the prompts do not mention the hidden column');
  assert.notEqual(r1.status, 'verified'); assert.notEqual(r1.status, 'unverified');
  assert.ok(!/\b15\b/.test(r1.answerLine), r1.answerLine);
  const other = await mk(true, 'SELECT SUM(amount) AS v FROM sales');
  const r2 = await other.e.ask(Q);
  assert.equal(r2.route, 'sql'); assert.match(r2.answerLine, /195\.25/, 'SQL that does not name a hidden column still runs');
});

test('data refresh (files): changed csv -> only that table re-imported, rules kept, new numbers, data_refreshed event, dataStamp changes', async (t) => {
  const x = await h.makeWs(t, { overrides: { refreshIntervalMs: 0 }, reply: (b, n) => h.IR_AMAZON_OCT });
  const events = [];
  x.ws.on(e => events.push(e));
  const before = await x.ws.ask(h.Q_AMAZON_OCT);
  assert.match(before.answerLine, /49\.75/);
  const stamp0 = before.meta.dataStamp;
  fs.writeFileSync(x.csv, h.CSV + '2026-10-21,Amazon,A9,1,50\n');
  const future = new Date(Date.now() + 5000); fs.utimesSync(x.csv, future, future);
  const after = await x.ws.ask(h.Q_AMAZON_OCT);
  assert.match(after.answerLine, /99\.75/, after.answerLine);
  assert.notEqual(after.meta.dataStamp, stamp0);
  assert.notEqual(after.route, 'reuse', 'cached answer from the old data is not served');
  const ev = events.find(e => e.type === 'data_refreshed');
  assert.ok(ev && ev.tables.includes('sales') && ev.files.includes('sales.csv'));
  assert.ok(x.ws.engine.info().lastRefreshAt);
  // unchanged data: no second refresh event
  const n = events.filter(e => e.type === 'data_refreshed').length;
  await x.ws.ask(h.Q_AMAZON_OCT);
  assert.equal(events.filter(e => e.type === 'data_refreshed').length, n);
});

test('data refresh: throttled to the configured interval; a new file in a folder source becomes a table; a removed file drops it', async (t) => {
  const root = h.tmp(); const folder = root + '/exports'; fs.mkdirSync(folder);
  fs.writeFileSync(folder + '/sales.csv', h.CSV);
  const pack = root + '/pack.json'; fs.writeFileSync(pack, JSON.stringify(h.salesPack()));
  const srv = await h.modelServer(h.IR_AMAZON_OCT); t.after(() => srv.close());
  const home = root + '/home';
  await W.initWorkspace({ home, name: 'f', config: { data: { sources: [{ type: 'folder', path: folder, pattern: '*.csv' }] }, rules: { packs: [pack] }, model: { provider: 'custom', baseURL: srv.baseURL, model: 'm' }, behavior: { vectors: false, anchor: '2026-10-22' } } });
  const ws = await W.openWorkspace({ home, name: 'f' }, { refreshIntervalMs: 60000, onEvent: () => {} }); t.after(() => ws.close());
  assert.deepEqual(ws.engine.tables().map(x => x.name), ['sales']);
  fs.writeFileSync(folder + '/returns.csv', 'return_date,qty\n2026-10-02,1\n');
  await ws.ask(h.Q_AMAZON_OCT);   // within the 60s interval of the engine start: no check yet
  assert.deepEqual(ws.engine.tables().map(x => x.name), ['sales'], 'throttled');
  const r = await ws.refreshData();   // explicit refresh ignores the throttle
  assert.equal(r.refreshed, true);
  assert.deepEqual(ws.engine.tables().map(x => x.name).sort(), ['returns', 'sales']);
  fs.rmSync(folder + '/returns.csv');
  const r2 = await ws.refreshData();
  assert.equal(r2.refreshed, true);
  assert.deepEqual(ws.engine.tables().map(x => x.name), ['sales']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws.dir, 'import.json'), 'utf8')).tables.map(x => x.name), ['sales']);
});

test('data refresh: a file that cannot be imported keeps its old table and is not retried until it changes again', async (t) => {
  const root = h.tmp(); const dbf = await h.makeDb(root + '/b.duckdb');
  const pq = root + '/sales.parquet';
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(dbf); const conn = await inst.connect();
  await conn.run(`COPY sales TO '${pq}' (FORMAT PARQUET)`); conn.closeSync ? conn.closeSync() : conn.disconnectSync(); inst.closeSync && inst.closeSync();
  const events = [];
  const e = await createEngine({ dataDir: root + '/d', data: { files: [pq], refresh: 'auto', refreshIntervalMs: 0 }, rules: [h.salesPack()], model: h.fakeModel(() => h.IR_AMAZON_OCT), vectors: false, anchor: '2026-10-22', reuse: false, onEvent: ev => events.push(ev) });
  t.after(() => e.close());
  assert.match((await e.ask(h.Q_AMAZON_OCT)).answerLine, /49\.75/);
  fs.writeFileSync(pq, 'this is not a parquet file');
  const f1 = new Date(Date.now() + 8000); fs.utimesSync(pq, f1, f1);
  const r = await e.ask(h.Q_AMAZON_OCT);
  assert.match(r.answerLine, /49\.75/, 'old data still answers');
  assert.equal(events.filter(x => x.code === 'data_refresh_failed').length, 1);
  assert.ok(!events.some(x => x.type === 'data_refreshed'));
  await e.ask(h.Q_AMAZON_OCT);
  assert.equal(events.filter(x => x.code === 'data_refresh_failed').length, 1, 'not retried for the same version of the file');
  // a good file afterwards is picked up
  const inst2 = await DuckDBInstance.create(':memory:'); const c2 = await inst2.connect();
  await c2.run("CREATE TABLE sales(order_date DATE, channel VARCHAR, sku VARCHAR, qty BIGINT, amount DOUBLE)");
  await c2.run("INSERT INTO sales VALUES ('2026-10-01','Amazon','A1',1,7)");
  await c2.run(`COPY sales TO '${root}/new.parquet' (FORMAT PARQUET)`);
  fs.renameSync(root + '/new.parquet', pq);
  const f2 = new Date(Date.now() + 16000); fs.utimesSync(pq, f2, f2);
  const r3 = await e.ask(h.Q_AMAZON_OCT);
  assert.match(r3.answerLine, /7 元/, r3.answerLine);
  assert.ok(events.some(x => x.type === 'data_refreshed'));
});

test('data refresh (duckdb): replacing the file reopens the connection', async (t) => {
  const root = h.tmp(); const dbf = await h.makeDb(root + '/b.duckdb');
  const e = await createEngine({ dataDir: root + '/d', data: { duckdb: dbf, refresh: 'auto', refreshIntervalMs: 0 }, rules: [h.salesPack()], model: h.fakeModel(() => h.IR_AMAZON_OCT), vectors: false, anchor: '2026-10-22', reuse: false });
  t.after(() => e.close());
  const events = []; 
  const r1 = await e.ask(h.Q_AMAZON_OCT); assert.match(r1.answerLine, /49\.75/);
  const next = await h.makeDb(root + '/next.duckdb', [...h.SALES_ROWS, ['2026-10-25', 'Amazon', 'A1', 1, 1000]]);
  fs.renameSync(next, dbf);
  const f = new Date(Date.now() + 5000); fs.utimesSync(dbf, f, f);
  const r2 = await e.ask(h.Q_AMAZON_OCT);
  assert.match(r2.answerLine, /1,?049\.75/, r2.answerLine);
  assert.notEqual(r2.meta.dataStamp, r1.meta.dataStamp);
});

test('rules.preview: all-data total + last full month, no model call; works for auto metrics, records and pending requests', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel(() => AUTO_IR);
  const e = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, model, vectors: false, anchor: '2026-10-22' });
  t.after(() => e.close());
  const p = await e.rules.preview('m:au_sales_amount');
  assert.equal(p.id, 'm:au_sales_amount'); assert.equal(p.label, '金额'); assert.match(p.formula, /sales 表 amount 合计/);
  assert.equal(p.total, 195.25);
  assert.deepEqual(p.lastMonth, { period: '2026-09', value: 40 });
  assert.equal((await e.rules.preview('au_sales_qty')).total, 15);
  assert.equal(model.calls.length, 0);
  await assert.rejects(() => e.rules.preview('m:nope'), /unknown metric/);
  // pending request id
  const r = await e.ask('2026年10月 amount 合计？');
  assert.equal(r.status, 'needs_confirm');
  assert.equal((await e.rules.preview(r.requestId)).id, 'm:au_sales_amount');
  // record id after confirm
  await e.confirm(r.requestId, 'accept');
  const rec = e.rules.list({ kind: 'auto_confirm' })[0];
  const pr = await e.rules.preview(rec.id);
  assert.equal(pr.recordId, rec.id); assert.equal(pr.total, 195.25);
});

test('rules: metrics() states; confirm / reject / revert an auto metric by id (explicit, no question needed), persisted, survive restart', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const mk = () => createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, model: h.fakeModel(() => AUTO_IR), vectors: false, anchor: '2026-10-22' });
  let e = await mk();
  const st = id => e.rules.metrics().find(m => m.id === id);
  assert.equal(st('m:au_sales_amount').status, 'unconfirmed');
  const rec = await e.rules.confirm('m:au_sales_amount');
  assert.equal(rec.kind, 'auto_confirm'); assert.equal(rec.status, 'confirmed');
  assert.equal(st('m:au_sales_amount').status, 'confirmed'); assert.equal(st('m:au_sales_amount').recordId, rec.id);
  await assert.rejects(() => e.rules.confirm('m:au_sales_amount'), /already confirmed/);
  await e.close(); e = await mk();
  assert.equal(st('m:au_sales_amount').status, 'confirmed', 'survives restart');
  const rv = await e.rules.revert('m:au_sales_amount');
  assert.equal(rv.status, 'reverted'); assert.equal(st('m:au_sales_amount').status, 'reverted');
  const again = await e.rules.confirm('m:au_sales_amount');
  assert.equal(again.id, rec.id, 're-confirm reuses the same record');
  // "not right": left out of the rules until reverted
  const rj = await e.rules.reject('m:au_sales_qty');
  assert.equal(rj.status, 'rejected'); assert.equal(st('m:au_sales_qty').status, 'rejected');
  const ans = await e.ask('2026年10月 qty 合计？');
  assert.notEqual(ans.status, 'verified');
  await e.close(); e = await mk();
  assert.equal(st('m:au_sales_qty').status, 'rejected', 'rejection persisted');
  await e.rules.revert('m:au_sales_qty');
  assert.equal(st('m:au_sales_qty').status, 'unconfirmed');
  await e.close();
});

test('workspace.saveConfig: live settings (budget, key, base url) without rebuilding; hidden columns rebuild; invalid change is rejected and rolled back', async (t) => {
  const x = await h.makeWs(t);
  const e0 = x.ws.engine;
  await x.ws.saveConfig({ limits: { dailyBudgetUSD: 2 } });
  assert.equal(x.ws.engine, e0, 'budget change does not rebuild');
  assert.equal(x.ws.usage.today().limitUSD, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.dir, 'estratto.json'), 'utf8')).limits.dailyBudgetUSD, 2);
  await x.ws.saveConfig({ privacy: { hiddenColumns: ['sales.sku'] } });
  assert.notEqual(x.ws.engine, e0);
  assert.ok(x.ws.engine.tables()[0].columns.find(c => c.name === 'sku').hidden);
  await assert.rejects(() => x.ws.saveConfig({ limits: { maxCallsPerQuestion: 'many' } }), /maxCallsPerQuestion/);
  await assert.rejects(() => x.ws.saveConfig({ data: { sources: [] } }), /at least one data source/);
  assert.equal(x.ws.config.limits.maxCallsPerQuestion, 2);
  assert.equal(await x.ws.setApiKey('sk-new-key-abcdefghij'), 'set');
  const r = await x.ws.ask(h.Q_AMAZON_OCT);
  assert.equal(x.srv.seen.at(-1).headers.authorization, 'Bearer sk-new-key-abcdefghij');
  assert.deepEqual(h.filesContaining(x.dir, 'sk-new-key-abcdefghij'), ['secrets.json']);
  assert.equal(await x.ws.setApiKey(''), 'not set');
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(x.dir, 'secrets.json'), 'utf8'))), '{}');
  assert.ok(r);
});

test('workspace.addSource: a second csv becomes a table without rebuilding the engine; duckdb + file is refused with a clear message', async (t) => {
  const x = await h.makeWs(t);
  const extra = path.join(x.root, 'returns.csv'); fs.writeFileSync(extra, 'return_date,qty\n2026-10-02,1\n');
  const e0 = x.ws.engine;
  await x.ws.addSource(extra);
  assert.equal(x.ws.engine, e0);
  assert.deepEqual(x.ws.engine.tables().map(t => t.name).sort(), ['returns', 'sales']);
  const dbf = await h.makeDb(x.root + '/z.duckdb');
  await assert.rejects(() => x.ws.addSource(dbf), /ONE DuckDB file/);
  await assert.rejects(() => x.ws.addSource(x.root + '/nope.csv'), /not found/);
  await assert.rejects(() => x.ws.addSource(x.root + '/pack.json'), /unsupported file type/);
  assert.equal(x.ws.config.data.sources.length, 2);
});
