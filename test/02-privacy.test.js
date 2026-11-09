'use strict';
// 2. privacy transport
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('..');
const { protect, MARKER } = require('../src/privacy.js');
const h = require('./helpers.js');

const schema = { tables: [{ name: 'sales', columns: [{ name: 'order_date' }, { name: 'channel' }, { name: 'amount' }] }] };
const mk = (payload, { system = 'SYS', extra = {} } = {}) => ({ messages: [{ role: 'system', content: system }, { role: 'user', content: MARKER + JSON.stringify(payload) }], ...extra });
const payloadOf = body => JSON.parse(body.messages[1].content.slice(MARKER.length));

test('entities not literally present in the question are stripped', () => {
  const q = '2026年10月 Amazon 的销售额';
  const r = protect(mk({ question: q, anchor: '2026-10-22', entities: [{ dim: 'sales.channel', value: 'Amazon' }, { dim: 'sales.channel', value: 'Shopify' }, { dim: 'sales.channel', value: 'Zalando' }] }), q, schema);
  assert.equal(r.ok, true);
  assert.deepEqual(payloadOf(r.body).entities, [{ dim: 'sales.channel', value: 'Amazon' }]);
  assert.equal(r.changes.entitiesDropped, 2);  
  assert.ok(!r.body.messages[1].content.includes('Shopify'));
});

test('previous_errors reduced to a typed category + authorized field names; raw detail (values) never leaves', () => {
  const q = '销售额是多少';
  const err = "Binder Error: column amount not found; row value 'ACME Corp 12345.67' could not convert 2026/13/45";
  const r = protect(mk({ question: q, previous_errors: [err, { code: 'x', message: 'share denominator is zero for secretcol' }] }), q, schema);
  assert.equal(r.ok, true);
  const pe = payloadOf(r.body).previous_errors;
  assert.equal(pe.length, 2);
  assert.match(pe[0], /type_conversion/);
  assert.match(pe[0], /涉及已授权字段：amount/);
  assert.match(pe[1], /ratio_or_shape/);
  for (const s of pe) { assert.ok(!/ACME|12345|secretcol|Binder/.test(s)); }
  assert.ok(!r.body.messages[1].content.includes('ACME'));
});

test('malformed bodies are refused', () => {
  const q = 'q';
  const good = mk({ question: q });
  assert.equal(protect(good, q, schema).ok, true);
  const cases = {
    tools: { ...good, tools: [{ type: 'function' }] },
    three_messages: { messages: [...good.messages, { role: 'user', content: 'x' }] },
    wrong_roles: { messages: [{ role: 'user', content: 's' }, good.messages[1]] },
    no_marker: { messages: [good.messages[0], { role: 'user', content: JSON.stringify({ question: q }) }] },
    not_json: { messages: [good.messages[0], { role: 'user', content: MARKER + '{oops' }] },
    question_mismatch: mk({ question: 'something else' }),
    extra_key: mk({ question: q, rows: [[1, 2, 3]] }),
    candidates_objects: mk({ question: q, candidates: { metrics: [{ id: 'x', sample_values: [1, 2] }] } }),
    candidates_extra_key: mk({ question: q, candidates: { rows: [] } }),
    entities_shape: mk({ question: q, entities: 'Amazon' }),
    null_body: null,
  };
  for (const [name, body] of Object.entries(cases)) {
    const r = protect(body, q, schema);
    assert.equal(r.ok, false, name);
    assert.ok(r.reason, name);
  }
});

// load a private copy of the engine whose prompt builder is wrapped (tests only; production code has no hook)
function engineModuleWithPromptMutation(mutate) {
  const irPath = require.resolve('../core/main/ir-prompt.js'), engPath = require.resolve('../src/engine.js');
  const irMod = require(irPath), orig = irMod.buildIRMessages;
  const savedEng = require.cache[engPath];
  irMod.buildIRMessages = (p) => mutate(orig(p));
  delete require.cache[engPath];
  try { return require(engPath); }
  finally { irMod.buildIRMessages = orig; if (savedEng) require.cache[engPath] = savedEng; else delete require.cache[engPath]; }
}

test('engine refuses (status refused + outbound_blocked event) instead of sending a malformed request', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel(() => h.IR_AMAZON_OCT);
  const events = [];
  const eng = engineModuleWithPromptMutation(m => ({ system: m.system, user: m.user + '\nextra: {"row": [1,2,3]}' }));
  const engine = await eng.createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model, onEvent: e => events.push(e) });
  t.after(() => engine.close());
  const r = await engine.ask(h.Q_AMAZON_OCT);
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'outbound_blocked');
  assert.equal(model.calls.length, 0, 'nothing reached the model');
  const blocked = events.filter(e => e.type === 'outbound_blocked');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].requestId, r.requestId);
  assert.equal(r.usage.calls, 0);
  assert.equal(r.meta.checks.find(c => c.name === 'privacy_outbound').result, 'fail');
});

test('production code has no outbound test hook', () => {
  for (const f of ['../src/engine.js', '../src/privacy.js']) assert.ok(!/_testMutateOutbound/.test(require('fs').readFileSync(require.resolve(f), 'utf8')));
});

test('hardened transport REFUSES (never mutates) odd shapes', () => {
  const q = 'q', good = { question: q, anchor: '2026-10-22', timezone: 'Asia/Shanghai', period: { start: '2026-10-01', end: '2026-10-31', end_exclusive: '2026-11-01' }, entities: [{ dim: 'sales.channel', value: 'q' }], candidates: { metrics: [['m:a', 'n', 'u']], dimensions: [['d:b', 'c']], time_roles: [['t:x', 'y']] } };
  assert.equal(protect(mk(good), q, schema).ok, true);
  const bad = {
    entity_extra_key: { ...good, entities: [{ dim: 'a', value: 'q', sample: 'x' }] },
    entity_nonstring_value: { ...good, entities: [{ dim: 'a', value: 42 }] },
    entity_nonstring_dim: { ...good, entities: [{ dim: { x: 1 }, value: 'q' }] },
    entity_not_object: { ...good, entities: ['q'] },
    period_nested: { ...good, period: { start: { rows: [1] } } },
    period_array: { ...good, period: ['2026'] },
    period_long: { ...good, period: { start: 'x'.repeat(500) } },
    anchor_obj: { ...good, anchor: { a: 1 } },
    anchor_long: { ...good, anchor: 'x'.repeat(200) },
    tz_number: { ...good, timezone: 5 },
    cand_number: { ...good, candidates: { metrics: [['m:a', 5]] } },
    cand_object: { ...good, candidates: { metrics: [['m:a', { v: 1 }]] } },
  };
  for (const [name, payload] of Object.entries(bad)) assert.equal(protect(mk(payload), q, schema).ok, false, name);
  for (const k of ['tools', 'functions', 'tool_choice', 'function_call']) assert.equal(protect(mk(good, { extra: { [k]: k === 'tools' || k === 'functions' ? [{ a: 1 }] : 'auto' } }), q, schema).ok, false, k);
});

test('what the model receives in a normal request: question, anchor, names/ids only; no data rows or values', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel(() => h.IR_AMAZON_OCT);
  const engine = await createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model });
  t.after(() => engine.close());
  const r = await engine.ask(h.Q_AMAZON_OCT);
  assert.equal(r.status, 'verified');
  const sent = JSON.stringify(model.calls.map(c => c.messages));
  for (const leak of ['Shopify', 'eBay', '19.9', '29.85', '49.75', '100', 'A3']) assert.ok(!sent.includes(leak), 'leaked ' + leak);
  const p = payloadOf({ messages: model.calls[0].messages });
  assert.deepEqual(Object.keys(p).sort(), ['anchor', 'candidates', 'question', 'timezone']);
});

test('auto-generated rules: measured row counts in notes never reach the SQL-fallback prompt', async (t) => {
  const dir = h.tmp();
  const dbf = await h.makeDb(dir + '/b.duckdb', [['2026-10-01', 'Amazon', 'A1', -2, 19.9], ['2026-10-02', 'Shopify', 'A2', 1, 5.5], ['2026-10-03', 'Amazon', 'A1', -3, 29.85]]);
  const model = h.fakeModel(req => req.messages[1].content.includes('"candidates"')
    ? { metric: 'none', unresolved: [{ slot: 'metric', reason: 'capability_gap' }] }
    : { sql: 'SELECT SUM(qty) AS v FROM sales', unit: '件', label: 'x', params: [] });
  const engine = await createEngine({ dataDir: dir + '/d', data: { duckdb: dbf }, model, vectors: false, anchor: '2026-10-22' });
  t.after(() => engine.close());
  const r = await engine.ask('销量一共多少？');
  assert.equal(r.route, 'sql');
  const sys = model.calls.map(c => c.messages[0].content).join('\n');
  assert.match(sys, /负数/);                      // the structural hint is still there
  assert.ok(!/有\s*\d+\s*行负数/.test(sys), 'no measured count');
});
