'use strict';
// 4. two engines in one process must not interfere
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('..');
const h = require('./helpers.js');

test('two engines (different dataDir, different data) share no facts, reuse, or rules', async (t) => {
  const dir = h.tmp();
  const dbA = await h.makeDb(dir + '/a.duckdb');
  const dbB = await h.makeDb(dir + '/b.duckdb', h.SALES_ROWS.map(r => [r[0], r[1], r[2], r[3], r[4] * 10]));   // same shape, amounts x10
  const mA = h.fakeModel(() => h.IR_AMAZON_OCT), mB = h.fakeModel(() => h.IR_AMAZON_OCT);
  const A = await createEngine({ dataDir: dir + '/dA', data: { duckdb: dbA }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model: mA });
  const B = await createEngine({ dataDir: dir + '/dB', data: { duckdb: dbB }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model: mB });
  t.after(async () => { await A.close(); await B.close(); });

  const [ra, rb] = await Promise.all([A.ask(h.Q_AMAZON_OCT), B.ask(h.Q_AMAZON_OCT)]);   // concurrent
  assert.equal(ra.status, 'verified'); assert.equal(rb.status, 'verified');
  assert.match(ra.answerLine, /49\.75/);
  assert.match(rb.answerLine, /497\.5/);
  assert.notEqual(ra.meta.dataStamp, rb.meta.dataStamp);
  assert.equal(ra.facts[0].id, 'F1'); assert.equal(rb.facts[0].id, 'F1');       // fact books are per ask, not shared

  // reuse is per dataDir: A's second ask is a cache hit (no model call); B has its own cache and answers 10x
  const ra2 = await A.ask(h.Q_AMAZON_OCT);
  assert.equal(ra2.route, 'reuse'); assert.equal(ra2.usage.calls, 0); assert.equal(mA.calls.length, 1);
  const rb2 = await B.ask(h.Q_AMAZON_OCT);
  assert.equal(rb2.route, 'reuse'); assert.match(rb2.answerLine, /497\.5/);
  assert.ok(fs.existsSync(path.join(dir, 'dA', 'reuse.db')) && fs.existsSync(path.join(dir, 'dB', 'reuse.db')));

  // rules: a patch confirmed on A is not visible on B
  const rec = await A.rules.propose({ kind: 'alias', origin: 'user', decided_by: 'tester', evidence: [{ type: 'user_decision', note: 't' }], scope: { metric: 'gmv' }, proposal: { target: 'm:gmv', alias: '成交金额' } });
  await A.rules.confirm(rec.id, { by: 'tester' });
  assert.equal(A.rules.list().length, 1);
  assert.equal(B.rules.list().length, 0);
  const gen = d => { try { return fs.readdirSync(path.join(dir, d, 'rules', 'generated')).length; } catch (_) { return 0; } };
  assert.ok(gen('dA') > 0, 'confirmed patch exported as a generated pack under A');
  assert.equal(gen('dB'), 0);
});

test('same dataDir for a second engine sees the persisted reuse cache; closing one engine does not affect the other', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/a.duckdb');
  const m1 = h.fakeModel(() => h.IR_AMAZON_OCT), m2 = h.fakeModel(() => h.IR_AMAZON_OCT);
  const mk = (m, dd) => createEngine({ dataDir: dir + '/' + dd, data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model: m });
  const E1 = await mk(m1, 'shared');
  const r1 = await E1.ask(h.Q_AMAZON_OCT); assert.equal(r1.status, 'verified');
  const E3 = await mk(h.fakeModel(() => h.IR_AMAZON_OCT), 'other');
  await E1.close();
  const r3 = await E3.ask(h.Q_AMAZON_OCT); assert.equal(r3.status, 'verified'); assert.equal(r3.usage.calls, 1);
  const E2 = await mk(m2, 'shared');
  t.after(async () => { await E2.close(); await E3.close(); });
  const r2 = await E2.ask(h.Q_AMAZON_OCT);
  assert.equal(r2.route, 'reuse'); assert.equal(m2.calls.length, 0);
});

test('the engine core never reads process.env and does not mutate it; no credential files are touched', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/a.duckdb');
  const before = JSON.stringify(process.env);
  const read = new Set();
  const realEnv = process.env;
  process.env = new Proxy(realEnv, { get(tg, k) { read.add(String(k)); return tg[k]; }, has(tg, k) { read.add(String(k)); return k in tg; }, set(tg, k, v) { throw new Error('process.env mutated: ' + String(k)); } });
  let engine;
  try {
    engine = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model: h.fakeModel(() => h.IR_AMAZON_OCT) });
    const r = await engine.ask(h.Q_AMAZON_OCT);
    assert.equal(r.status, 'verified');
    await engine.close();
  } finally { process.env = realEnv; }
  const app = [...read].filter(k => /^(STUDIO|EVAL|ARM|OPENCODE|ESTRATTO|REUSE|REPLAY|SQL_LANE|ALLOW_LOCAL|DUCK_PKG|HOME|USERPROFILE|FUSED)/i.test(k));
  assert.deepEqual(app, [], 'engine read app/credential env vars: ' + app.join(','));
  assert.equal(JSON.stringify(process.env), before);
});

test('static guard: no process.env / homedir / .dsh credential access in src/ or core/ (CLI shell excluded)', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p); } };
  walk(path.join(root, 'src')); walk(path.join(root, 'core')); files.push(path.join(root, 'index.js'));
  const bad = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8').split('\n');
    s.forEach((line, i) => { if (/process\.env|os\.homedir|homedir\(\)|\.credentials|\.dsh\b/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bad.push(path.relative(root, f) + ':' + (i + 1) + ': ' + line.trim().slice(0, 100)); });
  }
  assert.deepEqual(bad, []);
});
