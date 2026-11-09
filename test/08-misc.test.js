'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine, writeAttempt } = require('..');
const { createVecBatch, resolveModelDir } = require('../src/vectors.js');
const h = require('./helpers.js');

const E5 = '/home/claude/assets/models/multilingual-e5-small';

test('ESM wrapper exposes the same API', async () => {
  const esm = await import('../index.mjs');
  const cjs = require('..');
  assert.equal(typeof esm.createEngine, 'function');
  assert.equal(esm.createEngine, cjs.createEngine);
  assert.equal(esm.openaiCompatible, cjs.openaiCompatible);
  assert.equal(esm.default.createEngine, cjs.createEngine);
});

test('vectors: model absent -> disabled with a clear warning event; engine still answers', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const events = [];
  const engine = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, rules: [h.salesPack()], model: h.fakeModel(() => h.IR_AMAZON_OCT), anchor: '2026-10-22', modelsDir: dir + '/no-such-dir', onEvent: e => events.push(e) });
  t.after(() => engine.close());
  const w = events.find(e => e.type === 'vectors_disabled');
  assert.ok(w && w.level === 'warning' && /model_missing/.test(w.reason));
  assert.equal(engine.info().vectors, 'disabled');
  assert.equal((await engine.ask(h.Q_AMAZON_OCT)).status, 'verified');
});

test('vectors: real multilingual-e5-small (unit vectors, dot-product similarity, per-engine cache)', { skip: !fs.existsSync(path.join(E5, 'model_quantized.onnx')) && 'e5 model not present' }, async (t) => {
  assert.equal(resolveModelDir(path.dirname(E5)), E5);       // parent dir with multilingual-e5-small/ works too
  const a = await createVecBatch({ modelsDir: E5 });
  assert.equal(a.status, 'enabled');
  const m = await a.vecBatch(['美国亚马逊'], ['Amazon US', 'Shopify', 'Amazon UK']);
  assert.equal(m.length, 1); assert.equal(m[0].length, 3);
  assert.ok(m[0][0] > m[0][1], 'Amazon US is closer to 美国亚马逊 than Shopify');
  for (const v of m[0]) assert.ok(v > -1 && v <= 1.0001);
  const again = await a.vecBatch(['美国亚马逊'], ['Amazon US']);
  assert.equal(again[0][0], m[0][0], 'same text -> same vector (cached)');
  // engine with vectors on, end to end
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const events = [];
  const engine = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, rules: [h.salesPack()], model: h.fakeModel(() => h.IR_AMAZON_OCT), anchor: '2026-10-22', modelsDir: path.dirname(E5), onEvent: e => events.push(e) });
  t.after(() => engine.close());
  assert.equal(engine.info().vectors, 'enabled');
  assert.ok(!events.some(e => e.type === 'vectors_disabled'));
  assert.equal((await engine.ask(h.Q_AMAZON_OCT)).status, 'verified');
});

test('rules: propose/confirm/reject/revert hot-load into the registry; persisted under dataDir/rules', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel(() => h.IR_AMAZON_OCT);
  const events = [];
  const mkEngine = () => createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model, onEvent: e => events.push(e) });
  const engine = await mkEngine();
  assert.equal(engine.info().aliasesApplied, 0);
  const rec = await engine.rules.propose({ kind: 'alias', origin: 'user', decided_by: 'tester', evidence: [{ type: 'user_decision', note: 'test' }], scope: { metric: 'gmv' }, proposal: { target: 'm:gmv', alias: '成交金额' } });
  assert.equal(engine.rules.list()[0].status, 'candidate');
  assert.equal(engine.info().aliasesApplied, 0, 'a candidate patch is not applied');
  await engine.rules.confirm(rec.id, { by: 'tester' });
  assert.equal(engine.rules.list({ status: 'confirmed' }).length, 1);
  assert.equal(engine.info().aliasesApplied, 1, 'confirmed patch is hot-loaded into the registry');
  assert.equal((await engine.ask(h.Q_AMAZON_OCT)).status, 'verified');
  assert.ok(events.some(e => e.type === 'rules_changed' && e.action === 'confirm'));
  await engine.rules.revert(rec.id, { by: 'tester' });
  assert.equal(engine.rules.list()[0].status, 'reverted');
  assert.equal(engine.info().aliasesApplied, 0, 'revert removes it again');
  const rec2 = await engine.rules.propose({ kind: 'alias', origin: 'rule', evidence: [{ type: 'schema' }], scope: { metric: 'gmv' }, proposal: { target: 'm:gmv', alias: 'xx' } });
  await engine.rules.reject(rec2.id, { by: 'tester', reason: 'no' });
  assert.equal(engine.rules.list({ status: 'rejected' }).length, 1);
  await assert.rejects(() => engine.rules.confirm('patch_unknown', { by: 'tester' }), /没有这条补丁|unknown/);
  await engine.close();
  assert.ok(fs.existsSync(path.join(dir, 'd', 'rules', 'patches.json')));
  const again = await mkEngine();
  t.after(() => again.close());
  assert.equal(again.rules.list().length, 2, 'patches survive restart');
});

test('writeAttempt writes the arm-public file set', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const engine = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model: h.fakeModel(() => h.IR_AMAZON_OCT) });
  t.after(() => engine.close());
  const r = await engine.ask(h.Q_AMAZON_OCT);
  writeAttempt(r, dir + '/attempt');
  assert.match(fs.readFileSync(dir + '/attempt/answer.txt', 'utf8'), /^ANSWER: 49\.75/);
  const raw = JSON.parse(fs.readFileSync(dir + '/attempt/raw.json', 'utf8'));
  for (const k of ['qid', 'question', 'status', 'code', 'route', 'answer', 'answer_line', 'lane', 'sql', 'tier', 'plan', 'result_status', 'facts', 'rows', 'comparison', 'llm_calls', 'calls_this_turn', 'tokens', 'zero_llm', 'ir', 'reuse', 'trace', 'provider_calls', 'ir_raw_text', 'ir_reasoning', 'latency_ms', 'errors', 'message']) assert.ok(k in raw, 'raw.json has ' + k);
  const facts = JSON.parse(fs.readFileSync(dir + '/attempt/facts.json', 'utf8'));
  assert.equal(facts.schema, 'facts-export/1');
  assert.equal(facts.items.F1.value, 49.75);
  assert.equal(facts.items.F1.d, 49.75);
  assert.ok(JSON.parse(fs.readFileSync(dir + '/attempt/meta.json', 'utf8')).code_version.startsWith('estratto-engine@'));
});

test('concurrent asks on one engine and close() while idle', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const engine = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', reuse: false, model: h.fakeModel(async () => { await new Promise(r => setTimeout(r, 30)); return h.IR_AMAZON_OCT; }) });
  const rs = await Promise.all([1, 2, 3, 4].map(i => engine.ask(h.Q_AMAZON_OCT, { requestId: 'c' + i })));
  assert.deepEqual(rs.map(r => r.status), ['verified', 'verified', 'verified', 'verified']);
  assert.deepEqual(rs.map(r => r.requestId), ['c1', 'c2', 'c3', 'c4']);
  assert.ok(!fs.existsSync(dir + '/d/reuse.db'), 'reuse:false -> no reuse.db');
  await engine.close();
  await assert.rejects(() => engine.ask('x'), /closed/);
});
