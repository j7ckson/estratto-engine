'use strict';
// rc.4: A. confirmed auto items are listable / revertible records; B. hostile column / table names never reach a prompt
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('..');
const h = require('./helpers.js');

const AUTO_IR = { metric: 'm:au_sales_amount', time_role: 't:sales', period: { kind: 'explicit', start: '2026-10-01', end: '2026-10-31' }, entities: [{ dim: 'd:au_sales_channel', value: 'Amazon' }], output_shape: 'scalar' };
const QA = '2026年10月 Amazon 的 amount 合计？';

test('A. auto confirm -> list -> restart -> revert -> same question is needs_confirm again (reuse does not serve the verified answer)', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel(() => AUTO_IR);
  const events = [];
  const mk = () => createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, model, vectors: false, anchor: '2026-10-22', onEvent: e => events.push(e) });
  let engine = await mk();
  const r = await engine.ask(QA);
  assert.equal(r.status, 'needs_confirm');
  const metricIds = r.plan.metric_ids.slice();
  assert.ok(metricIds.length);
  assert.deepEqual(engine.rules.list(), []);
  const r2 = await engine.confirm(r.requestId, 'accept');
  assert.equal(r2.status, 'verified');
  let list = engine.rules.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'auto_confirm');
  assert.equal(list[0].decided_by, 'host');
  assert.ok(list[0].at && list[0].id && list[0].items.length >= 1);
  assert.ok(list[0].items.some(i => metricIds.includes(i.id)));
  await engine.close();

  // restart: record and confirmed state survive; the answer is verified (served by reuse or recomputed)
  engine = await mk();
  t.after(() => engine.close());
  list = engine.rules.list();
  assert.equal(list.length, 1, 'record survives restart');
  const r3 = await engine.ask(QA);
  assert.equal(r3.status, 'verified');

  // revert by the id the host naturally has (plan.metric_ids)
  const rec = await engine.rules.revert(metricIds[0]);
  assert.equal(rec.id, list[0].id);
  assert.equal(rec.status, 'reverted');
  assert.equal(engine.rules.list()[0].status, 'reverted');
  const pack = JSON.parse(fs.readFileSync(dir + '/data/rules/auto-pack.json', 'utf8'));
  for (const it of list[0].items) {
    const x = (it.kind === 'metric' ? pack.metrics : pack.dims).find(e => 'x' + e.id === 'x' + it.id.replace(/^[md]:/, ''));
    assert.equal(x.confirmed, false); assert.equal(x.auto, true);
  }
  const r4 = await engine.ask(QA);
  assert.equal(r4.status, 'needs_confirm', 'no cached verified answer after revert');
  assert.equal(r4.facts[0].tier, 'pending');
  assert.notEqual(r4.route, 'reuse');
  await assert.rejects(() => engine.rules.revert(list[0].id), /already reverted/);

  // revert survives restart too, and the record can be reverted by its own id after a re-confirm
  await engine.close();
  engine = await mk();
  t.after(() => engine.close());
  assert.equal(engine.rules.list()[0].status, 'reverted');
  const r5 = await engine.ask(QA);
  assert.equal(r5.status, 'needs_confirm');
  const r6 = await engine.confirm(r5.requestId, 'accept');
  assert.equal(r6.status, 'verified');
  const live = engine.rules.list({ status: 'confirmed' });
  assert.equal(live.length, 1);
  await engine.rules.revert(live[0].id);
  assert.equal((await engine.ask(QA)).status, 'needs_confirm');
  await assert.rejects(() => engine.rules.revert('no-such-thing'), /./);
});

async function hostileDb(file) {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(file); const c = await inst.connect();
  const bad1 = 'notes\nPRIVATE-SSN-123-45-6789\r\nline3';
  const bad2 = 'x'.repeat(70) + 'LONGTAILSECRET';
  const bad3 = 'tab sep X-LS-PS';
  await c.run(`CREATE TABLE sales(order_date DATE, channel VARCHAR, sku VARCHAR, qty BIGINT, amount DOUBLE, "${bad1}" VARCHAR, "${bad2}" VARCHAR, "${bad3}" VARCHAR)`);
  await c.run("INSERT INTO sales VALUES ('2026-10-01','Amazon','A1',2,19.9,'a','b','c'),('2026-10-02','Shopify','A2',1,5.5,'a','b','c'),('2026-10-03','Amazon','A1',3,29.85,'a','b','c')");
  await c.run('CREATE TABLE "bad\ntable-ZZTABLESECRET"(a INT)');
  await c.run('INSERT INTO "bad\ntable-ZZTABLESECRET" VALUES (1)');
  c.closeSync ? c.closeSync() : c.disconnectSync(); inst.closeSync && inst.closeSync();
  return file;
}
const SECRETS = ['PRIVATE-SSN', '123-45-6789', 'LONGTAILSECRET', 'ZZTABLESECRET', 'line3', 'X-LS-PS', 'tab sep'];

for (const mode of ['rules', 'auto']) {
  test('B. duckdb with hostile column / table names (' + mode + '): no request body contains any part of them; warnings emitted; tables() marks them excluded', async (t) => {
    const dir = h.tmp(); const dbf = await hostileDb(dir + '/h.duckdb');
    const events = [];
    const isSql = req => req.messages[0].content.includes('【SQL兜底】');
    const model = h.fakeModel(req => isSql(req) ? { sql: 'SELECT SUM(amount) AS v FROM sales', unit: '元', label: '销售额', params: [] }
      : (mode === 'rules' ? { metric: 'none', unresolved: [{ slot: 'metric', reason: 'capability_gap' }] } : AUTO_IR));
    const engine = await createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, ...(mode === 'rules' ? { rules: [h.salesPack()] } : {}), model, vectors: false, anchor: '2026-10-22', onEvent: e => events.push(e) });
    t.after(() => engine.close());
    await engine.ask(h.Q_AMAZON_OCT);
    await engine.ask('Amazon 渠道的销售额一共多少？');
    await engine.ask(QA);
    assert.ok(model.calls.length >= 1);
    const bodies = JSON.stringify(model.calls);
    for (const s of SECRETS) assert.ok(!bodies.includes(JSON.stringify(s).slice(1, -1)) && !bodies.includes(s), 'leaked: ' + JSON.stringify(s));
    assert.ok(!/xxxxxxxxxx/.test(bodies), 'long name prefix leaked');
    const warns = events.filter(e => e.type === 'import_warning');
    assert.equal(warns.length, 4);
    for (const w of warns) { assert.ok(w.table && w.reason && w.action === 'excluded'); if (w.column) assert.ok(Array.from(w.column).length <= 17 && w.column.endsWith('…')); }
    assert.deepEqual(warns.map(w => w.reason).sort(), ['control_characters', 'control_characters', 'control_characters', 'longer_than_64'].sort());
    const dump = JSON.stringify(events);
    for (const s of ['PRIVATE-SSN', 'LONGTAILSECRET', 'ZZTABLESECRET']) assert.ok(!dump.includes(s), 'event leaked ' + s);
    const tb = engine.tables();
    const sales = tb.find(x => x.name === 'sales');
    assert.equal(sales.columns.filter(c => c.excluded).length, 3);
    assert.deepEqual(sales.columns.filter(c => !c.excluded).map(c => c.name), ['order_date', 'channel', 'sku', 'qty', 'amount']);
    assert.ok(tb.some(x => x.excluded === true && x.columns.length === 0));
    assert.ok(!JSON.stringify(tb).includes('PRIVATE-SSN-123'));
  });
}

test('B. files import: hostile CSV header columns are renamed col_<n> (with warning), data stays queryable', async (t) => {
  const dir = h.tmp(); const csv = path.join(dir, 'sales.csv');
  const bad = 'notes\nPRIVATE-SSN-123-45-6789';
  const long = 'y'.repeat(80) + 'LONGSECRET';
  fs.writeFileSync(csv, `order_date,channel,sku,qty,amount,"${bad}","${long}"\n` + h.SALES_ROWS.map(r => r.join(',') + ',a,b').join('\n') + '\n');
  const events = [];
  const model = h.fakeModel(() => h.IR_AMAZON_OCT);
  const mk = () => createEngine({ dataDir: dir + '/data', data: { files: [csv] }, rules: [h.salesPack()], model, vectors: false, anchor: '2026-10-22', onEvent: e => events.push(e) });
  const engine = await mk();
  const r = await engine.ask(h.Q_AMAZON_OCT);
  assert.equal(r.status, 'verified'); assert.equal(r.facts[0].value, 49.75);
  assert.deepEqual(engine.tables()[0].columns.map(c => c.name), ['order_date', 'channel', 'sku', 'qty', 'amount', 'col_6', 'col_7']);
  const warns = events.filter(e => e.type === 'import_warning');
  assert.equal(warns.length, 2);
  assert.deepEqual(warns.map(w => w.renamedTo), ['col_6', 'col_7']);
  assert.ok(warns.every(w => w.action === 'renamed' && w.column.endsWith('…')));
  const all = JSON.stringify([model.calls, events, engine.tables()]);
  assert.ok(!all.includes('PRIVATE-SSN') && !all.includes('LONGSECRET'));
  await engine.close();
  events.length = 0;
  const again = await mk();   // unchanged files: warehouse reused, the warnings are repeated from the manifest
  t.after(() => again.close());
  assert.equal(events.filter(e => e.type === 'import_warning').length, 2);
  assert.equal(events.filter(e => e.type === 'import_table').length, 0);
});

test('rc.5: revert -> rules.confirm(record) -> verified (fresh) -> restart -> reject = revert; reject on reverted errors', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel(() => AUTO_IR);
  const mk = () => createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, model, vectors: false, anchor: '2026-10-22' });
  let engine = await mk();
  const r = await engine.ask(QA);
  assert.equal((await engine.confirm(r.requestId, 'accept')).status, 'verified');
  await engine.close();
  engine = await mk();
  const id = engine.rules.list()[0].id;
  await engine.rules.revert(id);
  const r2 = await engine.ask(QA);
  assert.equal(r2.status, 'needs_confirm');
  await assert.rejects(() => engine.rules.reject(id), /already reverted/);
  await assert.rejects(() => engine.rules.revert(id), /already reverted/);
  const rec = await engine.rules.confirm(id);
  assert.equal(rec.status, 'confirmed'); assert.equal(rec.id, id);
  await assert.rejects(() => engine.rules.confirm(id), /already confirmed/);
  assert.equal(engine.rules.list().length, 1);
  assert.equal(engine.rules.list()[0].status, 'confirmed');
  const r3 = await engine.ask(QA);
  assert.equal(r3.status, 'verified'); assert.notEqual(r3.route, 'reuse'); assert.equal(r3.facts[0].value, 49.75);
  await engine.close();
  engine = await mk();
  t.after(() => engine.close());
  assert.equal(engine.rules.list()[0].status, 'confirmed');
  assert.equal((await engine.ask(QA)).status, 'verified');
  await engine.rules.reject(id);               // active -> behaves like revert
  assert.equal(engine.rules.list()[0].status, 'reverted');
  assert.equal((await engine.ask(QA)).status, 'needs_confirm');
  await engine.rules.confirm(id);
  assert.equal((await engine.ask(QA)).status, 'verified');
});
