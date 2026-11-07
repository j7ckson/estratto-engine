'use strict';
// 1. request-body parity: openaiCompatible sends exactly the body arm-public.mjs callModel builds.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createEngine, openaiCompatible } = require('..');
const h = require('./helpers.js');

// ---- reimplementation of arm-public.mjs callModel() body construction (assets/arm-public.mjs lines 231-241) ----
function armBody({ MODEL, messages, maxOut, thinkingMode }) {
  const MAX_OUT = 400;
  const body = {
    model: MODEL, messages, stream: false, temperature: 0, max_tokens: Number(maxOut) || MAX_OUT,
    response_format: { type: 'json_object' },
  };
  const mode = thinkingMode;
  if (mode === 'disabled' || mode === 'typed') body.thinking = { type: 'disabled' };
  else if (mode === 'false_bool') body.thinking = false;
  else if (mode === 'low') body.reasoning_effort = 'low';
  return body;
}

function startServer(replies) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body: JSON.parse(data) });
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'chatcmpl-' + seen.length, model: 'srv-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, baseURL: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('body sent by openaiCompatible deep-equals the arm-public body (first call and repair call)', async (t) => {
  const dir = h.tmp(); const dbf = await h.makeDb(dir + '/b.duckdb');
  // 1st reply is an unusable plan -> forces a repair call (second request) which then succeeds.
  const { server, seen, baseURL } = await startServer([{}, h.IR_AMAZON_OCT]);
  t.after(() => server.close());
  const SECRET = 'sk-test-secret-123';
  const events = [];
  const engine = await createEngine({
    dataDir: dir + '/data', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22',
    model: openaiCompatible({ baseURL, apiKey: SECRET, model: 'my-model', thinking: 'false_bool', thinkingRepair: 'disabled' }),
    onEvent: e => events.push(e),
  });
  t.after(() => engine.close());
  const r = await engine.ask(h.Q_AMAZON_OCT);
  assert.equal(r.status, 'verified');
  assert.equal(seen.length, 2);

  // same inputs through a custom generate() give us the messages the engine builds (deterministic) -> arm body for those messages
  const capture = h.fakeModel((req, sig, n) => n === 1 ? {} : h.IR_AMAZON_OCT);
  const e2 = await createEngine({ dataDir: dir + '/data2', data: { duckdb: dbf }, rules: [h.salesPack()], vectors: false, anchor: '2026-10-22', model: capture });
  t.after(() => e2.close());
  await e2.ask(h.Q_AMAZON_OCT);
  assert.equal(capture.calls.length, 2);
  assert.equal(capture.calls[0].repair, false);
  assert.equal(capture.calls[1].repair, true);
  assert.equal(capture.calls[0].maxOutputTokens, 400);
  assert.equal(capture.calls[0].temperature, 0);
  assert.equal(capture.calls[0].purpose, 'ir');

  assert.deepEqual(seen[0].body, armBody({ MODEL: 'my-model', messages: capture.calls[0].messages, maxOut: 400, thinkingMode: 'false_bool' }));
  assert.deepEqual(seen[1].body, armBody({ MODEL: 'my-model', messages: capture.calls[1].messages, maxOut: 400, thinkingMode: 'disabled' }));
  assert.equal(seen[0].body.thinking, false);
  assert.deepEqual(seen[1].body.thinking, { type: 'disabled' });
  assert.deepEqual(Object.keys(seen[0].body).sort(), ['max_tokens', 'messages', 'model', 'response_format', 'stream', 'temperature', 'thinking']);

  // transport
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].headers.authorization, 'Bearer ' + SECRET);
  assert.equal(seen[0].headers['content-type'], 'application/json');

  // the key stays in the adapter closure: not in results, events, or engine info
  const dump = JSON.stringify([r, events, engine.info()], (k, v) => typeof v === 'bigint' ? Number(v) : v);
  assert.ok(!dump.includes(SECRET));
  // request params are recorded like arm-public does
  assert.deepEqual(r.usage.providerCalls[0].request_params, { thinking: false, reasoning_effort: null, max_tokens: 400, response_format: 'json_object', temperature: 0, stream: false });
});

test('thinking modes: low -> reasoning_effort, typed/disabled -> {type:disabled}; default false_bool', async () => {
  const { buildBody } = require('../src/openai.js');
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  for (const [mode, expectKey] of [['low', { reasoning_effort: 'low' }], ['disabled', { thinking: { type: 'disabled' } }], ['false_bool', { thinking: false }], [undefined, {}]]) {
    assert.deepEqual(buildBody({ model: 'm', messages, maxOutputTokens: 400, thinking: mode }), armBody({ MODEL: 'm', messages, maxOut: 400, thinkingMode: mode }));
    const b = buildBody({ model: 'm', messages, maxOutputTokens: 400, thinking: mode });
    for (const [k, v] of Object.entries(expectKey)) assert.deepEqual(b[k], v);
  }
  // defaults (arm-public: THINKING default false_bool)
  const seenBodies = [];
  const gen = openaiCompatible({ baseURL: 'http://x/v1', model: 'm', fetch: async (url, init) => { seenBodies.push(JSON.parse(init.body)); return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{}' } }] }) }; } });
  await gen.generate({ messages, maxOutputTokens: 400, repair: false });
  assert.equal(seenBodies[0].thinking, false);
  assert.ok(!('authorization' in {}));
});
