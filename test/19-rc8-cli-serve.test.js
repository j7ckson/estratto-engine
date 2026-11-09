'use strict';
// rc.8: CLI non-interactive init/add for every source kind, HTTP data API, password hygiene
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const h = require('./helpers-ws.js');
const dbh = require('./helpers-db.js');
const W = require('../src/workspace.js');
const { startServe } = require('../src/serve/index.js');
const CD = require('../src/cli-data.js');

const BIN = path.join(__dirname, '..', 'bin', 'estratto.js');
function cli(args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err })); p.stdin.end();
  });
}
const all = r => r.out + '\n' + r.err;
const mkSqlite = f => { const d = new DatabaseSync(f); d.exec("CREATE TABLE orders(id INTEGER, order_date TEXT, amount REAL); INSERT INTO orders VALUES (1,'2026-10-01',5.5),(2,'2026-10-09',6); CREATE TABLE cust(id INTEGER)"); d.close(); };
const base = (root, name) => ['--home', path.join(root, 'home'), '--name', name];
const initBase = (root, name) => ['init', '--yes', ...base(root, name), '--provider', 'custom', '--base-url', 'http://127.0.0.1:9/v1', '--model', 'm', '--no-vectors'];

test('parseDbUrl / parsePick / pick globs', () => {
  const r = CD.parseDbUrl('postgres://bob:s3cret@db.example.com:6543/shop?schema=sales&sslmode=require', 'postgres');
  assert.deepEqual(r.spec, { type: 'postgres', host: 'db.example.com', database: 'shop', user: 'bob', port: 6543, schema: 'sales', ssl: true });
  assert.equal(r.password, 's3cret'); assert.ok(!JSON.stringify(r.spec).includes('s3cret'));
  assert.throws(() => CD.parseDbUrl('mysql://u@h/d', 'postgres'), /postgres URL/); assert.throws(() => CD.parseDbUrl('http://x/y'), /postgres:\/\/ or mysql/);
  assert.deepEqual(CD.parsePick('1,3', 4), [0, 2]); assert.deepEqual(CD.parsePick('2-3', 4), [1, 2]); assert.deepEqual(CD.parsePick('', 3), [0, 1, 2]); assert.equal(CD.parsePick('9', 3), null); assert.equal(CD.parsePick('x', 3), null);
  const c = [{ name: 'a.csv', path: '/x/a.csv' }, { name: 'b.db', path: '/x/b.db' }];
  assert.deepEqual(CD.pickByGlobs(c, '*.csv').map(x => x.name), ['a.csv']); assert.equal(CD.pickByGlobs(c, 'all').length, 2);
});

test('cli init --yes: --db none --warehouse --scan --pick (csv + sqlite by magic header), own DuckDB at the chosen place', async () => {
  const root = h.tmp('estratto-c8-'); const d = path.join(root, 'data'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'sales.csv'), h.CSV); mkSqlite(path.join(d, 'shop.bin')); fs.mkdirSync(path.join(d, '.cache')); fs.writeFileSync(path.join(d, '.cache', 'x.csv'), 'a\n1\n');
  const wh = path.join(root, 'mine', 'wh.duckdb');
  const r = await cli([...initBase(root, 'a'), '--db', 'none', '--warehouse', wh, '--scan', d, '--pick', 'all'], {});
  assert.equal(r.code, 0, all(r));
  assert.ok(fs.existsSync(wh));
  assert.match(r.out, /Imported 3 table\(s\)/); assert.match(r.out, /shop__orders +2 +2026-10-01 ~ 2026-10-09/); assert.ok(!/x\.csv|\.cache/.test(r.out));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'home', 'a', 'estratto.json'), 'utf8'));
  assert.equal(cfg.data.warehouse, wh); assert.deepEqual(cfg.data.sources.map(s => s.type).sort(), ['file', 'sqlite']);
  // --pick with a glob; unknown --db; mismatches
  assert.equal((await cli([...initBase(root, 'b'), '--scan', d, '--pick', '*.csv'])).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'home', 'b', 'estratto.json'), 'utf8')).data.sources.map(s => s.type), ['file']);
  assert.equal((await cli([...initBase(root, 'c'), '--db', 'oracle', '--scan', d])).code, 2);
  assert.equal((await cli([...initBase(root, 'c'), '--db', 'postgres', '--scan', d])).code, 2);
  assert.equal((await cli([...initBase(root, 'c'), '--scan', path.join(root, 'empty-nothing')])).code, 2);
  // existing file as warehouse is refused, never overwritten
  fs.writeFileSync(path.join(root, 'keep.duckdb'), 'keep'); assert.notEqual((await cli([...initBase(root, 'e'), '--scan', d, '--warehouse', path.join(root, 'keep.duckdb')])).code, 0);
  assert.equal(fs.readFileSync(path.join(root, 'keep.duckdb'), 'utf8'), 'keep');
});

test('cli init --yes --db sqlite / duckdb (+ --tables) and add --sqlite / --scan', async () => {
  const root = h.tmp('estratto-c9-'); const f = path.join(root, 'shop.sqlite3'); mkSqlite(f);
  const r = await cli([...initBase(root, 's'), '--db', 'sqlite', '--data', f, '--tables', 'orders']);
  assert.equal(r.code, 0, all(r)); assert.match(r.out, /shop__orders/); assert.ok(!/shop__cust/.test(r.out));
  const add = await cli(['add', '--sqlite', f, '--tables', 'orders,cust', ...base(root, 's')]); assert.equal(add.code, 0, all(add)); assert.match(add.out, /shop__cust/);
  const f2 = path.join(root, 'two'); fs.mkdirSync(f2); fs.writeFileSync(path.join(f2, 'r.csv'), 'a,b\n1,2\n');
  const add2 = await cli(['add', '--scan', f2, '--pick', 'all', ...base(root, 's')]); assert.equal(add2.code, 0, all(add2)); assert.match(add2.out, /\br\b/);
  const ddb = await h.makeDb(path.join(root, 'x.duckdb'));
  const d = await cli([...initBase(root, 'd'), '--db', 'duckdb', '--duckdb', ddb]); assert.equal(d.code, 0, all(d));
  const mix = await cli([...initBase(root, 'm'), '--duckdb', ddb, '--data', f]); assert.notEqual(mix.code, 0);
  const st = await cli(['status', ...base(root, 's')]); assert.match(st.out, /sqlite:.*shop\.sqlite3/);
});

for (const kind of ['postgres', 'mysql']) {
  test(`cli ${kind}: init --yes with a URL; password from ESTRATTO_DB_PASSWORD only; add --refresh; doctor --online; no leak anywhere`, async (t) => {
    const s = kind === 'postgres' ? await dbh.startPostgres() : await dbh.startMysql();
    if (!s) return t.skip('server binaries not installed');
    t.after(() => s.stop());
    if (kind === 'postgres') { const { Client } = require('pg'); const c = new Client(s); await c.connect(); await c.query('CREATE TABLE t1(id int, d date); INSERT INTO t1 VALUES (1,\'2026-01-05\'),(2,\'2026-02-07\'); CREATE TABLE t2(x int)'); await c.end(); }
    else { const m = require('mysql2/promise'); const c = await m.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password, database: s.database }); await c.query('CREATE TABLE t1(id int, d date)'); await c.query("INSERT INTO t1 VALUES (1,'2026-01-05'),(2,'2026-02-07')"); await c.query('CREATE TABLE t2(x int)'); await c.end(); }
    const root = h.tmp('estratto-c10-');
    const url = `${kind}://${s.user}:${encodeURIComponent('url-pass-ignored-1')}@${s.host}:${s.port}/${s.database}`;
    const bare = `${kind}://${s.user}@${s.host}:${s.port}/${s.database}`;
    const flag = kind === 'postgres' ? '--pg-url' : '--mysql-url';
    assert.equal((await cli([...initBase(root, 'n'), flag, bare], { ESTRATTO_DB_PASSWORD: s.password })).code, 2, 'no --tables: tells which exist');
    const r = await cli([...initBase(root, 'n'), '--db', kind, flag, bare, '--tables', 't1'], { ESTRATTO_DB_PASSWORD: s.password });
    assert.equal(r.code, 0, all(r)); assert.match(r.out, /__t1 +2 +2026-01-05 ~ 2026-02-07/);
    const dir = path.join(root, 'home', 'n');
    assert.ok(!fs.readFileSync(path.join(dir, 'estratto.json'), 'utf8').includes(s.password));
    assert.deepEqual(h.filesContaining(dir, s.password), ['secrets.json']);
    assert.ok(!all(r).includes(s.password));
    // a password inside the URL never lands in estratto.json
    const r2 = await cli([...initBase(root, 'u'), flag, url, '--tables', 'all'], { ESTRATTO_DB_PASSWORD: s.password });
    assert.equal(r2.code, 0, all(r2)); assert.ok(!fs.readFileSync(path.join(root, 'home', 'u', 'estratto.json'), 'utf8').includes('url-pass'));
    assert.ok(!all(r2).includes('url-pass-ignored-1'));
    assert.match(r2.out, /__t2/);
    // refresh + doctor
    const rf = await cli(['add', '--refresh', ...base(root, 'n')]); assert.equal(rf.code, 0, all(rf)); assert.match(rf.out, /Refreshed|Nothing changed/);
    const doc = await cli(['doctor', '--online', ...base(root, 'n')], { ESTRATTO_DB_PASSWORD: s.password }); assert.match(doc.out, /\[ok\] database .*connected read-only/); assert.ok(!all(doc).includes(s.password));
    const st = await cli(['status', '--json', ...base(root, 'n')]); assert.ok(!all(st).includes(s.password));
    // wrong password: failure, workspace not kept, password not echoed
    const bad = await cli([...initBase(root, 'bad'), flag, bare, '--tables', 't1'], { ESTRATTO_DB_PASSWORD: 'nope-wrong-77' });
    assert.notEqual(bad.code, 0); assert.ok(!all(bad).includes('nope-wrong-77')); assert.ok(!fs.existsSync(path.join(root, 'home', 'bad')));
  });
}

test('http: discover / test-connection / add {source} / progress / refresh; owner only; password write-only and never returned', async (t) => {
  const pg = await dbh.startPostgres(); if (pg) { t.after(() => pg.stop()); const { Client } = require('pg'); const c = new Client(pg); await c.connect(); await c.query("CREATE TABLE ev(id int, at date); INSERT INTO ev VALUES (1,'2026-03-01'),(2,'2026-03-09')"); await c.end(); }
  const x = await h.makeWs(t, { rules: false });
  const ui = path.join(x.root, 'ui'); fs.mkdirSync(ui);
  const srv = await startServe(x.ws, { port: 0, uiDir: ui }); t.after(() => srv.close());
  const owner = x.ws.config.access.ownerToken;
  const call = (method, url, body, asOwner = true) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: url, headers: { host: `127.0.0.1:${srv.port}`, 'x-estratto-token': srv.sessionToken, ...(asOwner ? { 'x-estratto-owner': owner } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { const text = Buffer.concat(ch).toString(); let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, text, json }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  const d = path.join(x.root, 'scan'); fs.mkdirSync(d); mkSqlite(path.join(d, 'a.db')); fs.writeFileSync(path.join(d, 'b.csv'), 'k,v\n1,2\n');
  for (const [m, u, b] of [['POST', '/api/data/discover', { paths: [d] }], ['POST', '/api/data/test-connection', { source: { type: 'sqlite', path: path.join(d, 'a.db') } }], ['GET', '/api/data/progress'], ['POST', '/api/data/add', { source: { type: 'file', path: path.join(d, 'b.csv') } }]]) assert.equal((await call(m, u, b, false)).status, 403, u);
  const disc = await call('POST', '/api/data/discover', { paths: [d] });
  assert.equal(disc.status, 200); assert.deepEqual(disc.json.candidates.map(c => c.kind).sort(), ['csv', 'sqlite']);
  assert.equal((await call('POST', '/api/data/discover', { paths: [] })).status, 400);
  const tc = await call('POST', '/api/data/test-connection', { source: { type: 'sqlite', path: path.join(d, 'a.db') } });
  assert.deepEqual(tc.json.tables.map(t => [t.name, t.rows]), [['cust', 0], ['orders', 2]]);
  const add = await call('POST', '/api/data/add', { sources: [{ type: 'sqlite', path: path.join(d, 'a.db'), tables: ['orders'] }, { type: 'file', path: path.join(d, 'b.csv') }] });
  assert.equal(add.status, 200, add.text); assert.deepEqual(add.json.imported.map(t => t.name).sort(), ['b', 'shop__orders'].map(n => n === 'shop__orders' ? 'a__orders' : n).sort());
  assert.equal(add.json.imported.find(t => t.name === 'a__orders').to, '2026-10-09');
  const pr = await call('GET', '/api/data/progress?since=0'); assert.ok(pr.json.events.some(e => e.type === 'import_table'));
  assert.equal((await call('POST', '/api/data/add', { path: path.join(d, 'a.db') })).status, 200);   // old {path} form still works (sqlite detected)
  assert.equal((await call('POST', '/api/data/add', { source: { type: 'file', path: 'relative.csv' } })).status, 400);
  if (!pg) return;
  const bad = await call('POST', '/api/data/test-connection', { source: { type: 'postgres', host: pg.host, port: pg.port, database: pg.database, user: pg.user, password: 'wrong-pw-4242' } });
  assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'connection_failed'); assert.ok(!bad.text.includes('wrong-pw-4242'));
  const ok = await call('POST', '/api/data/test-connection', { source: { type: 'postgres', host: pg.host, port: pg.port, database: pg.database, user: pg.user, password: pg.password } });
  assert.equal(ok.status, 200); assert.ok(ok.json.tables.some(t => t.name === 'ev')); assert.ok(!ok.text.includes(pg.password));
  const pgAdd = await call('POST', '/api/data/add', { source: { type: 'postgres', host: pg.host, port: pg.port, database: pg.database, user: pg.user, password: pg.password, tables: ['ev'] } });
  assert.equal(pgAdd.status, 200, pgAdd.text); assert.ok(!pgAdd.text.includes(pg.password));
  for (const u of ['/api/status', '/api/settings']) { const r = await call('GET', u); assert.ok(!r.text.includes(pg.password), u); }
  const rf = await call('POST', '/api/data/refresh', {}); assert.equal(rf.status, 200); assert.ok(!rf.text.includes(pg.password));
  assert.deepEqual(h.filesContaining(path.join(x.home, x.name), pg.password), ['secrets.json']);
  const settings = await call('PUT', '/api/settings', { data: { sources: [] } }); assert.equal(settings.status, 403);
  // asker view of a database source shows no connection details
  const st = await call('GET', '/api/status', undefined, false); assert.ok(!st.text.includes(pg.host + ':') && !st.text.includes(pg.user));
});
