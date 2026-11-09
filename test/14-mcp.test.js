'use strict';
// rc.6 section 6: MCP over stdio, tested with the SDK's own client against a workspace that talks to a fake local model server
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const W = require('../src/workspace.js');
const h = require('./helpers-ws.js');

const BIN = path.join(__dirname, '..', 'bin', 'estratto.js');
async function connect(t, x) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', '--home', x.home, '--name', x.name], env: { PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  let err = ''; 
  await client.connect(transport);
  if (transport.stderr) transport.stderr.on('data', d => { err += d; });
  t.after(() => client.close());
  return { client, stderr: () => err };
}
const text = r => r.content.map(c => c.text).join('\n');

test('mcp: default tools are ask, list_tables, list_rules only', async (t) => {
  const x = await h.makeWs(t, { open: false });
  const { client } = await connect(t, x);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['ask', 'list_rules', 'list_tables']);
  for (const tool of tools.tools) assert.ok(!JSON.stringify(tool.inputSchema).match(/path|dir|file/i), 'no tool takes a path: ' + tool.name);
  // rule-changing tools are not callable either
  for (const name of ['confirm_rule', 'revert_rule', 'confirm_choice']) {
    const r = await client.callTool({ name, arguments: { id: 'm:gmv', requestId: 'r', choice: 'accept' } });
    assert.equal(r.isError, true, name);
  }
});

test('mcp: ask returns the answer text, status and notes - no key, no raw/sql/plan/rows', async (t) => {
  const x = await h.makeWs(t, { open: false });
  const { client } = await connect(t, x);
  const r = await client.callTool({ name: 'ask', arguments: { question: h.Q_AMAZON_OCT } });
  assert.ok(!r.isError);
  const tx = text(r);
  assert.match(tx, /ANSWER: 49\.75/); assert.match(tx, /status: verified/); assert.match(tx, /口径/);
  assert.equal(r.structuredContent.status, 'verified');
  assert.deepEqual(Object.keys(r.structuredContent).sort(), ['answer', 'answerLine', 'confirm', 'refusal', 'requestId', 'route', 'status']);
  assert.ok(!JSON.stringify(r).includes(x.apiKey));
  assert.equal(x.srv.seen[0].headers.authorization, 'Bearer ' + x.apiKey);
  assert.ok(!/SELECT|"rows"|"raw"/.test(JSON.stringify(r)));
  const bad = await client.callTool({ name: 'ask', arguments: { question: '   ' } });
  assert.equal(bad.isError, true);
  const nope = await client.callTool({ name: 'ask', arguments: { question: 'x', dir: '/etc' } });
  assert.ok(nope);   // unknown arguments are ignored; the workspace comes from the configuration only
});

test('mcp: list_tables hides hidden columns; list_rules shows metrics and their state', async (t) => {
  const x = await h.makeWs(t, { open: false, config: { privacy: { hiddenColumns: ['sales.sku'] } } });
  const { client } = await connect(t, x);
  const lt = await client.callTool({ name: 'list_tables', arguments: {} });
  assert.deepEqual(lt.structuredContent.tables.map(t => t.name), ['sales']);
  assert.deepEqual(lt.structuredContent.tables[0].columns.map(c => c.name), ['order_date', 'channel', 'qty', 'amount']);
  assert.ok(!text(lt).includes('sku'));
  const lr = await client.callTool({ name: 'list_rules', arguments: {} });
  const gmv = lr.structuredContent.metrics.find(m => m.id === 'm:gmv');
  assert.equal(gmv.name, '销售额'); assert.equal(gmv.status, 'provided'); assert.match(gmv.formula, /sales 表 amount 合计/);
});

test('mcp: allowRuleChanges=true adds confirm_rule, revert_rule, confirm_choice and they work', async (t) => {
  const x = await h.makeWs(t, { open: false, rules: false, config: { surfaces: { mcp: { allowRuleChanges: true } } }, reply: { metric: 'm:au_sales_amount', time_role: 't:sales', period: { kind: 'explicit', start: '2026-10-01', end: '2026-10-31' }, entities: [], output_shape: 'scalar' } });
  const { client } = await connect(t, x);
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['ask', 'confirm_choice', 'confirm_rule', 'list_rules', 'list_tables', 'revert_rule']);
  const a = await client.callTool({ name: 'ask', arguments: { question: '2026年10月 amount 合计？' } });
  assert.equal(a.structuredContent.status, 'needs_confirm');
  assert.match(text(a), /needs confirmation \(requestId: /);
  const c = await client.callTool({ name: 'confirm_choice', arguments: { requestId: a.structuredContent.requestId, choice: 'accept' } });
  assert.equal(c.structuredContent.status, 'verified');
  const lr = await client.callTool({ name: 'list_rules', arguments: {} });
  assert.equal(lr.structuredContent.metrics.find(m => m.id === 'm:au_sales_amount').status, 'confirmed');
  const rv = await client.callTool({ name: 'revert_rule', arguments: { id: 'm:au_sales_amount' } });
  assert.ok(!rv.isError, text(rv)); assert.match(text(rv), /reverted/);
  const cf = await client.callTool({ name: 'confirm_rule', arguments: { id: 'm:au_sales_amount' } });
  assert.ok(!cf.isError, text(cf)); assert.match(text(cf), /confirmed/);
  const miss = await client.callTool({ name: 'confirm_rule', arguments: { id: 'm:nothing' } });
  assert.equal(miss.isError, true);
});

test('mcp: the daily budget applies to MCP asks too', async (t) => {
  const x = await h.makeWs(t, { open: false, config: { limits: { dailyBudgetUSD: 0.001, price: { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 2 } } } });
  const { client } = await connect(t, x);
  await client.callTool({ name: 'ask', arguments: { question: h.Q_AMAZON_OCT } });
  const b = await client.callTool({ name: 'ask', arguments: { question: 'how much did we move overall during the previous month, roughly' } });
  assert.equal(b.structuredContent.status, 'refused'); assert.equal(b.structuredContent.refusal.code, 'daily_budget_exceeded');
  assert.equal(x.srv.seen.length, 1);
});

test('mcp: a model server that echoes the key in its error body cannot make the key appear in a tool result', async (t) => {
  const http = require('node:http');
  const x = await h.makeWs(t, { open: false });
  const evil = http.createServer((req, res) => { req.resume(); res.statusCode = 500; res.end('upstream error, you sent Authorization: ' + req.headers.authorization + ' and key ' + String(req.headers.authorization).replace('Bearer ', '')); });
  await new Promise(r => evil.listen(0, '127.0.0.1', r)); t.after(() => { evil.close(); evil.closeAllConnections(); });
  const ws = await W.openWorkspace({ home: x.home, name: x.name }, {});
  await ws.saveConfig({ model: { baseURL: `http://127.0.0.1:${evil.address().port}/v1` } }); await ws.close();
  const { client } = await connect(t, x);
  const r = await client.callTool({ name: 'ask', arguments: { question: 'how much did we move overall during the previous month, roughly' } });
  assert.ok(!JSON.stringify(r).includes(x.apiKey), JSON.stringify(r).slice(0, 400));
  assert.ok(!JSON.stringify(r).includes(x.apiKey.slice(3)));
});
