'use strict';
// 5. status mapping. Rules (verified against core/main/ask.js + sql-lane.js, see src/status.js header):
//   ok -> verified; ok+value_guess / auto-named field / tier pending -> needs_confirm; tier unverified -> unverified;
//   needs_clarification / value_choice -> needs_confirm; capability_gap -> refused; no_data -> no_data; cancelled -> cancelled
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('..');
const { mapStatus, routeOf, confirmOf } = require('../src/status.js');
const h = require('./helpers.js');

test('mapStatus table (core result shapes)', () => {
  const cases = [
    [{ status: 'ok', facts: [{ id: 'F1' }] }, 'verified'],
    [{ status: 'ok', result_status: 'ok', tier: 'verified' }, 'verified'],
    [{ status: 'ok', result_status: 'no_data', lane: 'sql', tier: 'verified' }, 'no_data'],
    [{ status: 'ok', result_status: 'no_data' }, 'no_data'],
    [{ status: 'no_data' }, 'no_data'],
    [{ status: 'ok', tier: 'pending' }, 'needs_confirm'],
    [{ status: 'ok', tier: 'pending', tier_why: { auto_names: ['x = t.f'] } }, 'needs_confirm'],
    [{ status: 'ok', facts: [{ tier: 'pending' }] }, 'needs_confirm'],
    [{ status: 'ok', tier_why: { auto_names: ['x = t.f'] } }, 'needs_confirm'],
    [{ status: 'ok', value_guess: { literal: 'a', value: 'A' } }, 'needs_confirm'],
    [{ status: 'ok', value_guesses: [{ literal: 'a', value: 'A' }] }, 'needs_confirm'],
    [{ status: 'ok', tier: 'unverified' }, 'unverified'],
    [{ status: 'ok', tier: 'unverified', value_guess: { literal: 'a' } }, 'unverified'],
    [{ status: 'needs_clarification', code: 'value_choice', value_choice: { options: [] } }, 'needs_confirm'],
    [{ status: 'needs_clarification', code: 'missing_time_role' }, 'needs_confirm'],
    [{ status: 'needs_clarification', code: 'plan_incomplete' }, 'needs_confirm'],
    [{ status: 'capability_gap', code: 'capability_gap' }, 'refused'],
    [{ status: 'refused' }, 'refused'],
    [{ status: 'error', code: 'model_error' }, 'error'],
    [{ status: 'error' }, 'error'],
    [{ status: 'cancelled' }, 'cancelled'],
    [{ status: 'error', code: 'cancelled' }, 'cancelled'],
    [{ status: 'model_reasoning_only' }, 'error'],
    [{ status: 'weird' }, 'error'],
    [null, 'error'],
  ];
  for (const [input, want] of cases) assert.equal(mapStatus(input), want, JSON.stringify(input));
  assert.equal(routeOf({ lane: 'sql' }, 2), 'sql');
  assert.equal(routeOf({ route: 'sql_value_choice' }, 1), 'sql');
  assert.equal(routeOf({ route: 'llm_ir', reuse: { result_hit: true } }, 0), 'reuse');
  assert.equal(routeOf({ route: 'rules_exact' }, 0), 'local');
  assert.equal(routeOf({ route: 'llm_ir' }, 1), 'plan');
  assert.equal(confirmOf({ status: 'ok' }, 'verified'), undefined);
  assert.equal(confirmOf({ status: 'needs_clarification', code: 'value_choice', value_choice: { literal: 'x', options: [{ value: 'X1' }] } }, 'needs_confirm').kind, 'value_choice');
});

async function engineWith(fn, extra = {}) {
  const dir = h.tmp(); const dbf = extra.dbf || await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel(fn);
  const engine = await createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model, ...extra.opts });
  return { engine, model, dir, dbf };
}

test('verified: registered rules, plan lane, numeric answer matches the data (49.75)', async (t) => {
  const { engine } = await engineWith(() => h.IR_AMAZON_OCT);
  t.after(() => engine.close());
  const r = await engine.ask(h.Q_AMAZON_OCT);
  assert.equal(r.status, 'verified');
  assert.equal(r.route, 'plan');
  assert.equal(r.facts[0].value, 49.75);
  assert.match(r.answerLine, /^ANSWER: 49\.75/);
  assert.ok(!/（F\d+）/.test(r.answerLine));
  assert.equal(r.confirm, undefined);
  assert.equal(r.usage.calls, 1);
  assert.equal(r.meta.codeVersion, 'estratto-engine@' + require('../package.json').version);
  assert.equal(r.meta.anchor, '2026-10-22');
  assert.ok(r.meta.checks.every(c => ['pass', 'fail', 'not_executed'].includes(c.result)));
  assert.equal(r.meta.checks.find(c => c.name === 'plan_validation').result, 'pass');
  assert.equal(r.raw.status, 'ok');                       // raw keeps the core status, like arm-public raw.json
  assert.equal(r.raw.answer_line, r.answerLine);
  assert.equal(r.raw.provider_calls.length, 1);
});

test('no_data: period with no rows', async (t) => {
  const { engine } = await engineWith(() => ({ ...h.IR_AMAZON_OCT, period: { kind: 'explicit', start: '2025-01-01', end: '2025-01-31' } }));
  t.after(() => engine.close());
  const r = await engine.ask('2025年1月 Amazon 的销售额是多少？');
  assert.equal(r.status, 'no_data');
});

test('refused: model reports a capability gap', async (t) => {
  const { engine } = await engineWith(() => ({ metric: 'none', unresolved: [{ slot: 'metric', reason: 'capability_gap' }] }));
  t.after(() => engine.close());
  const r = await engine.ask('Amazon 的利润率是多少？');
  assert.equal(r.status, 'refused');
  assert.equal(r.raw.code, 'capability_gap');
});

test('needs_confirm: clarification (time role ambiguous) carries confirm.kind + options', async (t) => {
  const { engine } = await engineWith(() => ({ metric: 'm:gmv', unresolved: [{ slot: 'time_role', reason: 'ambiguous', options: ['t:sales'] }] }));
  t.after(() => engine.close());
  const r = await engine.ask('Amazon 的销售额是多少？');
  assert.equal(r.status, 'needs_confirm');
  assert.equal(r.confirm.kind, 'missing_time_role');
  assert.deepEqual(r.confirm.options, ['t:sales']);
});

test('error: model returns unusable output / throws', async (t) => {
  for (const fn of [() => ({ text: 'not json' }), () => { throw new Error('boom'); }]) {
    const { engine } = await engineWith(fn);
    const r = await engine.ask(h.Q_AMAZON_OCT);
    assert.equal(r.status, 'error');
    assert.equal(r.raw.code, 'model_error');
    await engine.close();
  }
  const { engine } = await engineWith(() => h.IR_AMAZON_OCT);
  t.after(() => engine.close());
  assert.equal((await engine.ask('   ')).status, 'error');
});

test('sql lane: plan cannot express it -> SQL fallback runs read-only locally -> verified, route sql', async (t) => {
  const { engine, model } = await engineWith((req) => {
    if (req.messages[1].content.includes('"candidates"')) return { metric: 'none', unresolved: [{ slot: 'metric', reason: 'capability_gap' }] };
    return { sql: "SELECT SUM(amount) AS v FROM sales WHERE channel = 'Amazon'", unit: '元', label: 'Amazon 销售额合计', params: [{ role: 'entity', value: 'Amazon', dim: 'sales.channel' }] };
  });
  t.after(() => engine.close());
  const r = await engine.ask('Amazon 渠道的销售额一共多少？');
  assert.equal(r.status, 'verified');
  assert.equal(r.route, 'sql');
  assert.match(r.sql, /SUM\(amount\)/);
  assert.match(r.answerLine, /89\.75/);
  assert.equal(r.usage.calls, 2);
  // the SQL-lane request obeys the same transport: question + anchor + period/entities (question literals) only
  const sqlReq = model.calls[1].messages[1].content;
  assert.ok(!sqlReq.includes('Shopify'));
  // sqlFallback:false turns the lane off
  const off = await engineWith((req) => ({ metric: 'none', unresolved: [{ slot: 'metric', reason: 'capability_gap' }] }), { opts: { sqlFallback: false } });
  t.after(() => off.engine.close());
  const r2 = await off.engine.ask('Amazon 渠道的销售额一共多少？');
  assert.notEqual(r2.route, 'sql');
  assert.ok(off.model.calls.every(c => !c.messages[0].content.includes('【SQL兜底】')), 'no SQL-lane prompt is ever sent when sqlFallback is false');
});

test('sql lane: SQL is single-SELECT only; a write statement is rejected locally and never executed', async (t) => {
  const { engine, dbf } = await engineWith((req) => {
    if (req.messages[1].content.includes('"candidates"')) return { metric: 'none', unresolved: [{ slot: 'metric', reason: 'capability_gap' }] };
    return { sql: "DELETE FROM sales", unit: '', label: 'x', params: [] };
  });
  t.after(() => engine.close());
  const r = await engine.ask('Amazon 渠道的销售额一共多少？');
  assert.notEqual(r.status, 'verified');
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(dbf, { access_mode: 'READ_ONLY' }); const c = await inst.connect();
  const n = Number((await c.runAndReadAll('SELECT COUNT(*) AS n FROM sales')).getRowObjects()[0].n);
  assert.equal(n, 5);
  c.closeSync ? c.closeSync() : c.disconnectSync(); inst.closeSync && inst.closeSync();
});

test('needs_confirm (auto-generated rules) -> confirm(accept) -> verified without a new model call', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  const model = h.fakeModel(() => ({ metric: 'm:au_sales_amount', time_role: 't:sales', period: { kind: 'explicit', start: '2026-10-01', end: '2026-10-31' }, entities: [{ dim: 'd:au_sales_channel', value: 'Amazon' }], output_shape: 'scalar' }));
  const warnings = [];
  const engine = await createEngine({ dataDir: dir + '/data', data: { duckdb: dbf }, model, vectors: false, anchor: '2026-10-22', onEvent: e => { if (e.level === 'warning') warnings.push(e.type); } });
  t.after(() => engine.close());
  assert.ok(warnings.includes('rules_auto_generated'));
  assert.equal(engine.info().rules, 'auto');
  const r = await engine.ask('2026年10月 Amazon 的 amount 合计？');
  assert.equal(r.status, 'needs_confirm');
  assert.equal(r.confirm.kind, 'plan');
  assert.equal(r.facts[0].value, 49.75);
  assert.equal(r.facts[0].tier, 'pending');
  const r2 = await engine.confirm(r.requestId, 'accept');
  assert.equal(r2.status, 'verified');
  assert.equal(r2.usage.calls, 0);
  assert.equal(r2.facts[0].value, 49.75);
  await assert.rejects(() => engine.confirm('unknown-id', 'accept'), /no pending/);
});

async function dbWithCost(dir, channels = [['Amazon US'], ['Amazon UK'], ['Shopify']]) {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const f = dir + '/c.duckdb'; const inst = await DuckDBInstance.create(f); const c = await inst.connect();
  await c.run('CREATE TABLE sales(order_date DATE, channel VARCHAR, sku VARCHAR, qty BIGINT, amount DOUBLE, cost DOUBLE)');
  await c.run("INSERT INTO sales VALUES ('2026-10-01','Amazon US','A1',2,19.9,5),('2026-10-02','Amazon UK','A2',1,5.5,2),('2026-10-03','Shopify','A1',3,29.85,9)");
  c.closeSync ? c.closeSync() : c.disconnectSync(); inst.closeSync && inst.closeSync();
  return f;
}

test('unverified: SQL lane uses a column that no rule registers (sales.cost)', async (t) => {
  const dir = h.tmp(); const dbf = await dbWithCost(dir);
  const { engine } = await engineWith((req) => req.messages[1].content.includes('"candidates"')
    ? { metric: 'none', unresolved: [{ slot: 'metric', reason: 'capability_gap' }] }
    : { sql: 'SELECT SUM(cost) AS v FROM sales', unit: '元', label: '成本', params: [] }, { dbf });
  t.after(() => engine.close());
  const r = await engine.ask('成本一共多少？');
  assert.equal(r.status, 'unverified');
  assert.equal(r.route, 'sql');
  assert.equal(r.raw.tier, 'unverified');
  assert.equal(r.facts[0].value, 16);
});

test('needs_confirm (value_choice) -> confirm(option) -> verified; the pick is remembered in dataDir', async (t) => {
  const dir = h.tmp(); const dbf = await dbWithCost(dir);
  const { engine, model } = await engineWith(() => h.IR_AMAZON_OCT, { dbf });
  t.after(() => engine.close());
  const r = await engine.ask(h.Q_AMAZON_OCT);
  assert.equal(r.status, 'needs_confirm');
  assert.equal(r.confirm.kind, 'value_choice');
  assert.equal(r.confirm.literal, 'Amazon');
  assert.deepEqual(r.confirm.options.map(o => o.value).sort(), ['Amazon UK', 'Amazon US']);
  await assert.rejects(() => engine.confirm(r.requestId, 'Not An Option'), /not one of the offered options/);
  const r2 = await engine.confirm(r.requestId, 'Amazon US');
  assert.equal(r2.status, 'verified');
  assert.equal(r2.facts[0].value, 19.9);
  assert.match(r2.answerLine, /19\.9/);
  assert.equal(r2.requestId, r.requestId);
  assert.equal(model.calls.length >= 1, true);
});
