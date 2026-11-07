'use strict';
// rc.8: PostgreSQL and MySQL(MariaDB) snapshots against REAL servers started on loopback (see helpers-db.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers-ws.js');
const db = require('./helpers-db.js');
const W = require('../src/workspace.js');
const snapshot = require('../src/snapshot.js');

let pg = null, my = null;
test.before(async () => {
  pg = await db.startPostgres(); my = await db.startMysql();
  if (pg) {
    const { Client } = require('pg'); const c = new Client(pg); await c.connect();
    await c.query(`CREATE TABLE orders(id serial primary key, order_date date, ts timestamptz, amount numeric(12,2), qty int, big bigint, flag boolean, note text, pic bytea, price double precision);
      INSERT INTO orders(order_date,ts,amount,qty,big,flag,note,pic,price) VALUES ('2026-10-01','2026-10-01 10:00:00+08',19.90,2,9000000000,true,'a','\\x00ff',1.5),('2026-10-02',null,5.5,1,null,false,null,null,null);
      CREATE TABLE big(n int); INSERT INTO big SELECT generate_series(1,50);`);
    await c.end();
  }
  if (my) {
    const m = require('mysql2/promise'); const c = await m.createConnection({ host: my.host, port: my.port, user: my.user, password: my.password, database: my.database });
    await c.query('CREATE TABLE orders(id int auto_increment primary key, order_date date, ts datetime, amount decimal(12,2), qty tinyint, note varchar(50), pic blob, zd datetime)');
    await c.query("INSERT INTO orders(order_date,ts,amount,qty,note,pic,zd) VALUES ('2026-10-01','2026-10-01 10:00:00',19.90,2,'a','x','0000-00-00 00:00:00'),('2026-10-02',null,5.5,1,null,null,null)");
    await c.query('CREATE TABLE big(n int)'); await c.query('INSERT INTO big SELECT seq FROM seq_1_to_50');
    await c.end();
  }
});
test.after(async () => { if (pg) await pg.stop(); if (my) await my.stop(); });

const spec = (s, extra = {}) => ({ type: s.kind, host: s.host, port: s.port, database: s.database, user: s.user, ...(s.kind === 'postgres' ? { schema: 'public' } : {}), ...extra });
const readable = dir => h.walkFiles(dir).map(f => path.relative(dir, f));

for (const kind of ['postgres', 'mysql']) {
  const srv = () => (kind === 'postgres' ? pg : my);
  test(`${kind}: real server, read-only session (INSERT refused), types, blob skipped, password only in secrets.json, never in outputs`, async (t) => {
    const s = srv(); if (!s) return t.skip('server binaries not installed');
    const root = h.tmp('estratto-rm-'); const home = path.join(root, 'home');
    const events = [];
    await W.initWorkspace({ home, name: 'w', config: { data: { sources: [{ ...spec(s), tables: ['orders', 'big'], password: s.password }] }, behavior: { vectors: false } } });
    const ws = await W.openWorkspace({ home, name: 'w' }, { onEvent: e => events.push(e) }); t.after(() => ws.close());
    const dir = path.join(home, 'w');
    const cfgText = fs.readFileSync(path.join(dir, 'estratto.json'), 'utf8');
    assert.ok(!cfgText.includes(s.password), 'password not in estratto.json');
    assert.deepEqual(h.filesContaining(dir, s.password), ['secrets.json']);
    const sec = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
    const id = ws.config.data.sources[0].id;
    assert.equal(sec.connections[id].password, s.password); assert.equal(fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(events).includes(s.password));
    const name = ws.config.data.sources[0].name;
    const tb = Object.fromEntries(ws.engine.tables().map(x => [x.name, Object.fromEntries(x.columns.map(c => [c.name, c.type]))]));
    const o = tb[name + '__orders'];
    assert.ok(o, JSON.stringify(Object.keys(tb)));
    assert.match(o.amount, /^DECIMAL\(12,2\)$/); assert.equal(o.order_date, 'DATE'); assert.equal(o.ts, 'TIMESTAMP'); assert.ok(!('pic' in o), 'blob column skipped');
    assert.ok(events.some(e => e.type === 'import_warning' && e.reason === 'blob_column'));
    const sum = await ws.dataSummary();
    assert.equal(sum.find(x => x.name === name + '__orders').rows, 2); assert.equal(sum.find(x => x.name === name + '__big').rows, 50);
    assert.equal(sum.find(x => x.name === name + '__orders').from, '2026-10-01');
    const pv = await ws.engine.rules.preview('m:au_' + name + '__orders_amount'); assert.equal(pv.total, 25.4);
    // read-only: a write through a connection opened the way the importer opens it must fail
    if (kind === 'postgres') {
      const { Client } = require('pg'); const c = new Client(s); await c.connect();
      await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
      await assert.rejects(() => c.query("INSERT INTO big VALUES (1)"), /read-only transaction/); await c.end();
    } else {
      const m = require('mysql2/promise'); const c = await m.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password, database: s.database });
      await c.query('SET SESSION TRANSACTION READ ONLY');
      await assert.rejects(() => c.query('INSERT INTO big VALUES (1)'), /read[- ]only/i); await c.end();
    }
    // the importer itself never changed the source
    const { rows } = kind === 'postgres' ? await (async () => { const { Client } = require('pg'); const c = new Client(s); await c.connect(); const r = await c.query('SELECT count(*)::int n FROM big'); await c.end(); return r; })() : { rows: [{ n: 50 }] };
    assert.equal(rows[0].n, 50);
  });

  test(`${kind}: wrong password -> clear error without the password; add rolls back; test-connection lists tables with counts`, async (t) => {
    const s = srv(); if (!s) return t.skip('server binaries not installed');
    const ok = await snapshot.listSource(W.normalizeSource({ ...spec(s), tables: ['_'] }), s.password, { maxRows: 40 });
    const big = ok.tables.find(x => x.name === 'big'); assert.equal(big.rows, 50); assert.equal(big.overLimit, true);
    assert.deepEqual(ok.tables.find(x => x.name === 'orders').columns.map(c => c.name).slice(0, 2), ['id', 'order_date']);
    const wrong = 'wrong-pass-9917';
    let err; try { await snapshot.listSource(W.normalizeSource({ ...spec(s), tables: ['_'] }), wrong, {}); } catch (e) { err = e; }
    assert.ok(err, 'must fail'); assert.ok(!String(err.message).includes(wrong));
    const root = h.tmp('estratto-rm2-'); const home = path.join(root, 'home');
    await W.initWorkspace({ home, name: 'w', config: { data: { sources: [{ type: 'sqlite', path: await mkS(root) }] }, behavior: { vectors: false } } });
    const ws = await W.openWorkspace({ home, name: 'w' }, { onEvent: () => {} }); t.after(() => ws.close());
    await assert.rejects(() => ws.addSource({ ...spec(s), tables: ['orders'], password: wrong }), e => !String(e.message).includes(wrong));
    assert.equal(ws.config.data.sources.length, 1);
    assert.deepEqual(h.filesContaining(path.join(home, 'w'), wrong), []);
  });

  test(`${kind}: row cap refuses with a clear message (no silent truncation); manual refresh re-snapshots; auto interval does not hit the source on every question`, async (t) => {
    const s = srv(); if (!s) return t.skip('server binaries not installed');
    const root = h.tmp('estratto-rm3-'); const home = path.join(root, 'home');
    await W.initWorkspace({ home, name: 'w', config: { data: { maxRowsPerTable: 40, sources: [{ ...spec(s), tables: ['orders', 'big'], password: s.password }] }, behavior: { vectors: false } } });
    await assert.rejects(() => W.openWorkspace({ home, name: 'w' }, { onEvent: () => {} }), /table "big" has 50 rows, more than the limit of 40/);
    // within the cap: works; then the source grows and a manual refresh picks it up
    await W.initWorkspace({ home, name: 'w2', config: { data: { sources: [{ ...spec(s), tables: ['orders'], password: s.password }] }, behavior: { vectors: false } } });
    const ws = await W.openWorkspace({ home, name: 'w2' }, { onEvent: () => {}, refreshIntervalMs: 0 }); t.after(() => ws.close());
    const nm = ws.config.data.sources[0].name + '__orders';
    assert.equal((await ws.dataSummary()).find(x => x.name === nm).rows, 2);
    const add = async sql => { if (kind === 'postgres') { const { Client } = require('pg'); const c = new Client(s); await c.connect(); await c.query(sql); await c.end(); } else { const m = require('mysql2/promise'); const c = await m.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password, database: s.database }); await c.query(sql); await c.end(); } };
    await add("INSERT INTO orders(order_date,amount,qty) VALUES ('2026-10-03',1,1)");
    const r0 = await ws.engine.refreshData();   // plain re-check: the 15-minute interval has not passed, so the server is not asked again
    assert.equal(r0.refreshed, false);
    assert.equal((await ws.dataSummary()).find(x => x.name === nm).rows, 2);
    const r = await ws.refreshData();           // manual refresh
    assert.equal(r.refreshed, true);
    assert.equal((await ws.dataSummary()).find(x => x.name === nm).rows, 3);
    await add("DELETE FROM orders WHERE amount = 1");
  });
}

async function mkS(root) { const { DatabaseSync } = require('node:sqlite'); const f = path.join(root, 'x.sqlite'); const d = new DatabaseSync(f); d.exec('CREATE TABLE t(a INT); INSERT INTO t VALUES (1)'); d.close(); return f; }

test('auto refresh: remote snapshot is retaken only after data.refreshMinutes (marker file mtime), questions in between do not touch the server', async (t) => {
  if (!pg) return t.skip('postgres not installed');
  const root = h.tmp('estratto-rm4-'); const home = path.join(root, 'home');
  await W.initWorkspace({ home, name: 'w', config: { data: { refreshMinutes: 1, sources: [{ ...spec(pg), tables: ['big'], password: pg.password }] }, behavior: { vectors: false } } });
  const ws = await W.openWorkspace({ home, name: 'w' }, { onEvent: () => {}, refreshIntervalMs: 0 }); t.after(() => ws.close());
  const { Client } = require('pg'); const c = new Client(pg); await c.connect();
  await c.query('INSERT INTO big VALUES (999)');
  const nm = ws.config.data.sources[0].name + '__big';
  assert.equal((await ws.engine.refreshData()).refreshed, false);
  assert.equal((await ws.dataSummary()).find(x => x.name === nm).rows, 50);
  // pretend the last snapshot is 2 minutes old
  const marker = h.walkFiles(path.join(home, 'w', 'sources'))[0]; const old = new Date(Date.now() - 120000); fs.utimesSync(marker, old, old);
  const r = await ws.engine.refreshData();
  assert.equal(r.refreshed, true);
  assert.equal((await ws.dataSummary()).find(x => x.name === nm).rows, 51);
  await c.query('DELETE FROM big WHERE n = 999'); await c.end();
});
