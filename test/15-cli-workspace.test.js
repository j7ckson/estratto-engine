'use strict';
// rc.6 section 4: the workspace commands of the CLI (non-interactive paths, plus one pseudo-terminal run when python3 is available)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const h = require('./helpers-ws.js');

const BIN = path.join(__dirname, '..', 'bin', 'estratto.js');
const KEY = 'sk-cli-test-key-98765';
function cli(args, env = {}, input) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}
async function setup(t, { reply = h.IR_AMAZON_OCT, name = 'demo' } = {}) {
  const root = h.tmp('estratto-cli-');
  const csv = path.join(root, 'sales.csv'); fs.writeFileSync(csv, h.CSV);
  const pack = path.join(root, 'pack.json'); fs.writeFileSync(pack, JSON.stringify(h.salesPack()));
  const srv = await h.modelServer(reply); t.after(() => srv.close());
  return { root, csv, pack, srv, home: path.join(root, 'home'), name, base: ['--home', path.join(root, 'home'), '--name', name] };
}
const initArgs = x => ['init', '--yes', '--home', x.home, '--name', x.name, '--data', x.csv, '--provider', 'custom', '--base-url', x.srv.baseURL, '--model', 'fake-m', '--no-vectors', '--anchor', '2026-10-22'];
const all = r => r.out + '\n' + r.err;

test('cli init --yes: fully non-interactive; key from ESTRATTO_API_KEY; prints metrics, MCP snippet, serve command; never the key', async (t) => {
  const x = await setup(t);
  const r = await cli(initArgs(x), { ESTRATTO_API_KEY: KEY });
  assert.equal(r.code, 0, all(r));
  assert.match(r.out, /Workspace created: /);
  assert.match(r.out, /m:au_sales_amount .*金额.*195\.25/);
  assert.match(r.out, /"mcpServers"/); assert.match(r.out, /"estratto-demo"/); assert.match(r.out, /"mcp"/);
  assert.match(r.out, /estratto serve --name demo --home /);
  assert.ok(!all(r).includes(KEY));
  const dir = path.join(x.home, 'demo');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const f of ['estratto.json', 'secrets.json']) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  assert.deepEqual(h.filesContaining(dir, KEY), ['secrets.json']);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'estratto.json'), 'utf8'));
  assert.equal(cfg.model.baseURL, x.srv.baseURL); assert.equal(cfg.behavior.anchor, '2026-10-22'); assert.equal(cfg.behavior.vectors, false);
  // the snippet's command really starts the MCP server for this workspace
  const snippet = JSON.parse(r.out.slice(r.out.indexOf('{\n  "mcpServers"'), r.out.indexOf('\n}\n', r.out.indexOf('"mcpServers"')) + 2));
  const s = snippet.mcpServers['estratto-demo'];
  assert.ok(fs.existsSync(s.command) && fs.existsSync(s.args[0]));
  // a second init with the same name is refused; init without --yes and without a terminal is a usage error
  const again = await cli(initArgs(x), { ESTRATTO_API_KEY: KEY });
  assert.equal(again.code, 1); assert.match(all(again), /already exists/);
  const noyes = await cli(['init', '--home', x.home, '--name', 'other', '--data', x.csv], {});
  assert.equal(noyes.code, 2); assert.match(all(noyes), /--yes/);
});

test('cli init --yes: mixed sources, missing data, bad provider and bad paths give clear errors', async (t) => {
  const x = await setup(t);
  const dbf = await h.makeDb(x.root + '/z.duckdb');
  const mixed = await cli(['init', '--yes', '--home', x.home, '--name', 'm', '--data', x.csv, '--duckdb', dbf, '--no-vectors'], {});
  assert.equal(mixed.code, 1); assert.match(all(mixed), /either ONE DuckDB file or any number of files\/folders/);
  assert.equal((await cli(['init', '--yes', '--home', x.home, '--name', 'm'], {})).code, 2);
  assert.equal((await cli(['init', '--yes', '--home', x.home, '--name', 'm', '--data', x.csv, '--provider', 'nope'], {})).code, 2);
  const nf = await cli(['init', '--yes', '--home', x.home, '--name', 'm', '--data', x.root + '/missing.csv'], {});
  assert.equal(nf.code, 1); assert.match(all(nf), /not found/);
  assert.equal((await cli(['init', '--yes', '--home', x.home, '--name', '../x', '--data', x.csv], {})).code, 1);
  // duckdb alone works; folder works
  const ok = await cli(['init', '--yes', '--home', x.home, '--name', 'dk', '--duckdb', dbf, '--no-vectors'], {});
  assert.equal(ok.code, 0, all(ok));
  fs.mkdirSync(x.root + '/exports'); fs.copyFileSync(x.csv, x.root + '/exports/sales.csv');
  const fo = await cli(['init', '--yes', '--home', x.home, '--name', 'fo', '--data', x.root + '/exports', '--no-vectors'], {});
  assert.equal(fo.code, 0, all(fo));
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.home, 'fo', 'estratto.json'), 'utf8')).data.sources[0].type, 'folder');
});

test('cli status / rules / config / usage / add / doctor on a workspace; output never contains the key', async (t) => {
  const x = await setup(t);
  assert.equal((await cli(initArgs(x), { ESTRATTO_API_KEY: KEY })).code, 0);
  const st = await cli(['status', ...x.base, '--json']);
  assert.equal(st.code, 0, all(st));
  const sj = JSON.parse(st.out); assert.equal(sj.name, 'demo'); assert.equal(sj.apiKey, 'set'); assert.equal(sj.rules, 'auto'); assert.equal(sj.metrics.unconfirmed, 4);
  assert.ok(!all(st).includes(KEY));
  const st2 = await cli(['status', '--home', x.home]);   // single workspace: --name optional
  assert.equal(st2.code, 0); assert.match(st2.out, /workspace +demo/);
  // rules
  const rl = await cli(['rules', 'list', ...x.base]); assert.match(rl.out, /m:au_sales_amount .*\[unconfirmed\]/);
  const pv = await cli(['rules', 'preview', 'm:au_sales_amount', ...x.base, '--json']);
  const pj = JSON.parse(pv.out); assert.equal(pj.total, 195.25); assert.equal(pj.lastMonth.value, 40); assert.equal(pj.lastMonth.period, '2026-09');
  assert.equal(x.srv.seen.length, 0, 'preview made no model call');
  assert.match((await cli(['rules', 'confirm', 'm:au_sales_amount', ...x.base])).out, /confirm ok/);
  assert.match((await cli(['rules', 'list', ...x.base])).out, /m:au_sales_amount .*\[confirmed\]/);
  const again = await cli(['rules', 'confirm', 'm:au_sales_amount', ...x.base]); assert.equal(again.code, 1);
  assert.match((await cli(['rules', 'reject', 'm:au_sales_qty', ...x.base])).out, /rejected/);
  const exp = path.join(x.root, 'rules.json');
  assert.match((await cli(['rules', 'export', exp, ...x.base])).out, /Exported/);
  assert.equal(fs.statSync(exp).mode & 0o777, 0o600);
  assert.match((await cli(['rules', 'revert', 'm:au_sales_amount', ...x.base])).out, /revert ok/);
  assert.match((await cli(['rules', 'revert', 'm:au_sales_qty', ...x.base])).out, /revert ok/);
  const imp = await cli(['rules', 'import', exp, ...x.base]);
  assert.match(imp.out, /1 confirmed, 1 marked not right/);
  assert.match((await cli(['rules', 'list', ...x.base])).out, /m:au_sales_qty .*\[rejected\]/);
  assert.equal((await cli(['rules', 'import', x.pack, ...x.base])).code, 2);
  // config
  const g = await cli(['config', 'get', 'model.baseURL', ...x.base]); assert.equal(g.out.trim(), x.srv.baseURL);
  const all0 = await cli(['config', 'get', ...x.base]); const cfg0 = JSON.parse(all0.out); assert.equal(cfg0.access.ownerToken, '(set)');
  assert.equal((await cli(['config', 'get', 'access.ownerToken', ...x.base])).out.trim(), '(hidden)');
  assert.match((await cli(['config', 'set', 'limits.dailyBudgetUSD', '2.5', ...x.base])).out, /= 2\.5/);
  assert.match((await cli(['config', 'set', 'privacy.hiddenColumns', 'sales.sku', ...x.base])).out, /\["sales\.sku"\]/);
  assert.match((await cli(['status', ...x.base])).out, /hidden +sales\.sku/);
  assert.equal((await cli(['config', 'set', 'limits.maxCallsPerQuestion', '"many"', ...x.base])).code, 1);
  assert.equal((await cli(['config', 'set', 'access.ownerToken', 'x'.repeat(20), ...x.base])).code, 2);
  assert.equal((await cli(['config', 'set', 'data.sources', '[]', ...x.base])).code, 2);
  // set-key without a terminal reads ESTRATTO_API_KEY
  const NEW = 'sk-rotated-key-55555';
  const sk = await cli(['config', 'set-key', ...x.base], { ESTRATTO_API_KEY: NEW }); assert.equal(sk.code, 0, all(sk)); assert.match(sk.out, /api key: set/); assert.ok(!all(sk).includes(NEW));
  assert.deepEqual(h.filesContaining(path.join(x.home, 'demo'), NEW), ['secrets.json']);
  assert.equal((await cli(['config', 'set-key', ...x.base], {})).code, 2);
  // add + usage + doctor
  const extra = path.join(x.root, 'returns.csv'); fs.writeFileSync(extra, 'return_date,qty\n2026-10-02,1\n');
  assert.match((await cli(['add', extra, ...x.base])).out, /returns/);
  assert.equal((await cli(['add', x.root + '/nope.csv', ...x.base])).code, 1);
  const us = await cli(['usage', ...x.base]); assert.equal(us.code, 0); assert.match(us.out, /today .*0\.0000 USD/);
  const doc = await cli(['doctor', ...x.base]); assert.equal(doc.code, 0, all(doc)); assert.match(doc.out, /\[ok\] config: valid/); assert.ok(!all(doc).includes(NEW));
  const docOnline = await cli(['doctor', '--online', ...x.base]); assert.match(docOnline.out, /model server: GET \/models -> HTTP/);
  assert.ok(!all(docOnline).includes(NEW));
  // doctor flags a loose permission as FAIL
  fs.chmodSync(path.join(x.home, 'demo', 'secrets.json'), 0o644);
  const bad = await cli(['doctor', ...x.base]); assert.equal(bad.code, 1); assert.match(bad.out, /\[FAIL\] secrets\.json permissions/);
});

test('cli usage: after asks through a workspace the ledger shows priced calls', async (t) => {
  const x = await setup(t);
  assert.equal((await cli(initArgs(x).concat(['--daily-budget', '1']), { ESTRATTO_API_KEY: KEY })).code, 0);
  assert.equal((await cli(['config', 'set', 'limits.price', '{"inputPerM":1,"cachedInputPerM":0.1,"outputPerM":2}', ...x.base])).code, 0);
  assert.equal((await cli(['config', 'set', 'rules.packs', x.pack, ...x.base])).code, 0);
  const W = require('../src/workspace.js');
  const ws = await W.openWorkspace({ home: x.home, name: 'demo' }, { onEvent: () => {} });
  const r = await ws.ask(h.Q_AMAZON_OCT); assert.equal(r.status, 'verified'); await ws.close();
  const u = await cli(['usage', ...x.base, '--json']);
  const uj = JSON.parse(u.out); assert.equal(uj.today.calls, 1); assert.ok(Math.abs(uj.today.spentUSD - 0.00102) < 1e-9); assert.equal(uj.today.limitUSD, 1);
  assert.ok(!all(u).includes(KEY));
});

test('cli serve: prints the local URLs and the session token; the server answers with that token', async (t) => {
  const x = await setup(t);
  assert.equal((await cli(initArgs(x).concat(['--rules', x.pack]), { ESTRATTO_API_KEY: KEY })).code, 0);
  const p = spawn(process.execPath, [BIN, 'serve', ...x.base, '--port', '0'], { env: { PATH: process.env.PATH } });
  t.after(() => p.kill('SIGKILL'));
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  await new Promise((res, rej) => { const iv = setInterval(() => { if (/Press Ctrl\+C/.test(out)) { clearInterval(iv); res(); } }, 50); setTimeout(() => { clearInterval(iv); rej(new Error('serve did not start: ' + out + err)); }, 20000); });
  const url = /Ask page: +(http:\/\/127\.0\.0\.1:\d+)\//.exec(out)[1];
  const token = /Session token: +(\S+)/.exec(out)[1];
  const settings = /Settings page: +(http\S+)/.exec(out)[1];
  assert.match(settings, /\/settings\?owner=/);
  const get = (u, headers) => new Promise((resolve, reject) => http.get(u, { headers }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d })); }).on('error', reject));
  assert.equal((await get(url + '/api/status')).status, 401);
  const st = await get(url + '/api/status', { 'x-estratto-token': token });
  assert.equal(st.status, 200); assert.equal(JSON.parse(st.text).name, 'demo');
  assert.equal((await get(settings)).status, 200);
  assert.ok(!(out + err + st.text).includes(KEY));
  p.kill('SIGINT');
  const code = await new Promise(r => p.on('close', r));
  assert.equal(code, 0);
});

test('cli init interactive (pseudo-terminal), rc.8 flow "no database yet": name, own DuckDB location, scan, pick, import, summary, model, hidden key, per-metric confirmation', { skip: spawnSync('python3', ['--version']).status !== 0 }, async (t) => {
  const x = await setup(t);
  const dataDir = path.join(x.root, 'mydata'); fs.mkdirSync(dataDir); fs.copyFileSync(x.csv, path.join(dataDir, 'sales.csv'));
  fs.mkdirSync(path.join(dataDir, '.hidden')); fs.writeFileSync(path.join(dataDir, '.hidden', 'secret.csv'), 'a,b\n1,2\n');
  const wh = path.join(x.root, 'elsewhere', 'my-own.duckdb');
  const steps = [['工作区名字', 'pty1'], ['请选', '1'], ['放在哪', wh], ['数据在哪', dataDir], ['导入哪些\\?', 'all'], ['模型服务商', 'custom'], ['服务地址', x.srv.baseURL], ['模型名', 'm1'], ['API key', 'sk-typed-secret-4242'], ['对吗', 'y'], ['对吗', 'n'], ['对吗', 's'], ['对吗', 'y']];
  const r = spawnSync('python3', [path.join(__dirname, 'pty-drive.py'), JSON.stringify(steps), '--', process.execPath, BIN, 'init', '--home', x.home, '--no-vectors'], { encoding: 'utf8', timeout: 90000 });
  const j = JSON.parse(r.stdout);
  assert.equal(j.code, 0, j.output);
  assert.ok(!j.output.includes('sk-typed-secret-4242'), 'the typed key was not echoed');
  assert.match(j.output, /你有没有已经在用的数据库/);
  assert.match(j.output, /找到 1 个可以导入的数据/); assert.ok(!/secret\.csv/.test(j.output), 'hidden folder was not scanned');
  assert.match(j.output, /已导入 1 张表/); assert.match(j.output, /2026-09-15 ~ 2026-10-20/);
  assert.match(j.output, /工作区已建好/);
  const dir = path.join(x.home, 'pty1');
  assert.ok(fs.existsSync(wh), 'the engine\'s own DuckDB was created where the user said');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'estratto.json'), 'utf8'));
  assert.equal(cfg.data.warehouse, wh); assert.deepEqual(cfg.data.sources.map(s => s.type), ['file']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).apiKey, 'sk-typed-secret-4242');
  assert.deepEqual(h.filesContaining(dir, 'sk-typed-secret-4242'), ['secrets.json']);
  const rl = await cli(['rules', 'list', '--home', x.home, '--name', 'pty1']);
  assert.match(rl.out, /au_sales_rows .*\[confirmed\]/); assert.match(rl.out, /au_sales_sku_n .*\[rejected\]/); assert.match(rl.out, /au_sales_qty .*\[unconfirmed\]/); assert.match(rl.out, /au_sales_amount .*\[confirmed\]/);
});

test('cli: existing ask command still works and unknown commands exit 2', async (t) => {
  const x = await setup(t);
  const r = await cli(['ask', '--data', x.csv, '--rules', x.pack, '--base-url', x.srv.baseURL, '--model', 'm', '--data-dir', x.root + '/state', '--anchor', '2026-10-22', '--no-vectors', h.Q_AMAZON_OCT], { ESTRATTO_API_KEY: KEY });
  assert.equal(r.code, 0, all(r)); assert.match(r.out, /^ANSWER: 49\.75/);
  assert.equal((await cli(['frobnicate'])).code, 2);
  assert.equal((await cli(['status', '--home', x.home])).code, 2);   // no workspace yet
});
