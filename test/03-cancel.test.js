'use strict';
// 3. cancellation
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createEngine } = require('..');
const h = require('./helpers.js');

function reuseRows(dataDir) {
  const f = path.join(dataDir, 'reuse.db');
  if (!fs.existsSync(f)) return 0;
  const db = new DatabaseSync(f, { readOnly: true });
  try {
    let n = 0;
    for (const t of ['reuse_plan_cache', 'reuse_result_cache', 'reuse_kv_cache']) n += db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return n;
  } finally { db.close(); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('cancel aborts the in-flight model call, returns cancelled, and writes nothing to the reuse cache', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  let sawAbort = false, started;
  const startedP = new Promise(r => { started = r; });
  const model = h.fakeModel((req, signal) => new Promise((resolve, reject) => {
    started();
    signal.addEventListener('abort', () => { sawAbort = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  }));
  const engine = await createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model });
  t.after(() => engine.close());
  const p = engine.ask(h.Q_AMAZON_OCT, { requestId: 'r-cancel-1' });
  await startedP;
  assert.equal(engine.cancel('r-cancel-1'), true);
  const r = await p;
  assert.equal(r.status, 'cancelled');
  assert.equal(r.requestId, 'r-cancel-1');
  assert.equal(sawAbort, true, 'abort signal reached the model call');
  await sleep(100);
  assert.equal(reuseRows(path.join(dir, 'data')), 0);
  assert.equal(engine.cancel('r-cancel-1'), false, 'no longer in flight');
  assert.equal(engine.cancel('nope'), false);
});

test('a late model result (call ignores the signal) is discarded and never written to the reuse cache', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  let release, started;
  const gate = new Promise(r => { release = r; });
  const startedP = new Promise(r => { started = r; });
  const model = h.fakeModel(async () => { started(); await gate; return h.IR_AMAZON_OCT; });   // ignores `signal`
  const engine = await createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model });
  t.after(() => engine.close());
  const p = engine.ask(h.Q_AMAZON_OCT, { requestId: 'late-1' });
  await startedP;
  engine.cancel('late-1');
  const r = await p;
  assert.equal(r.status, 'cancelled');
  release();                       // the model answers after the cancel
  await sleep(400);                // let the core finish whatever it does with the late result
  assert.equal(reuseRows(path.join(dir, 'data')), 0, 'late result must not reach reuse.db');
  // the same question afterwards is computed fresh (no stale cache), and then is cached normally
  const model2calls = model.calls.length;
  const r2 = await engine.ask(h.Q_AMAZON_OCT);
  assert.equal(r2.status, 'verified');
  assert.ok(model.calls.length > model2calls || r2.usage.calls > 0);
  assert.ok(reuseRows(path.join(dir, 'data')) > 0);
});

test('external AbortSignal cancels too', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel((req, signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); }));
  const engine = await createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model });
  t.after(() => engine.close());
  const ac = new AbortController();
  const p = engine.ask(h.Q_AMAZON_OCT, { signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  const r = await p;
  assert.equal(r.status, 'cancelled');
  assert.equal(reuseRows(path.join(dir, 'data')), 0);
});

test('GatedStore drops every write once the request is aborted (defence in depth behind the core abort checks)', () => {
  const { GatedStore } = require('../src/engine.js');
  const writes = [];
  const inner = { putKV: (...a) => writes.push(['kv', a]), putSkeleton: (...a) => writes.push(['sk', a]), putPlan: (...a) => writes.push(['plan', a]), putResult: (...a) => writes.push(['res', a]), getKV: () => 'g' };
  const ac = new AbortController();
  const g = new GatedStore(inner, ac.signal);
  g.putKV('a'); g.putPlan('b'); g.putResult('c'); g.putSkeleton('d');
  assert.equal(writes.length, 4);
  ac.abort();
  g.putKV('a'); g.putPlan('b'); g.putResult('c'); g.putSkeleton('d');
  assert.equal(writes.length, 4, 'no writes after abort');
  assert.equal(g.getKV(), 'g', 'reads still pass through');
});
