'use strict';
const { makeRedactor } = require('./redact.js');
// OpenAI-compatible chat adapter. The request body is exactly what arm-public.mjs callModel() builds:
//   { model, messages, stream:false, temperature:0, max_tokens, response_format:{type:'json_object'}, [thinking | reasoning_effort] }
// The apiKey only lives in this closure; it is never part of the engine state, events, or results.

function buildBody({ model, messages, maxOutputTokens, thinking }) {
  const body = {
    model, messages, stream: false, temperature: 0, max_tokens: Number(maxOutputTokens) || 400,
    response_format: { type: 'json_object' },
  };
  const mode = thinking;
  if (mode === 'disabled' || mode === 'typed') body.thinking = { type: 'disabled' };
  else if (mode === 'false_bool') body.thinking = false;
  else if (mode === 'low') body.reasoning_effort = 'low';
  return body;
}

function openaiCompatible(opts = {}) {
  const { baseURL, apiKey, model } = opts;
  if (!baseURL || typeof baseURL !== 'string') throw new Error('openaiCompatible: baseURL is required');
  if (!model || typeof model !== 'string') throw new Error('openaiCompatible: model is required');
  const thinking = opts.thinking === undefined ? 'false_bool' : opts.thinking;
  const thinkingRepair = opts.thinkingRepair === undefined ? thinking : opts.thinkingRepair;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000;
  const extraHeaders = opts.headers && typeof opts.headers === 'object' ? { ...opts.headers } : {};
  const doFetch = typeof opts.fetch === 'function' ? opts.fetch : (...a) => fetch(...a);
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const providerName = opts.providerName || 'openai-compatible';
  const redactor = makeRedactor([apiKey]);

  function redactError(e) {
    if (!e || typeof e !== 'object') return new Error(redactor.str(String(e)));
    const out = new Error(redactor.str(String(e.message || e)));
    out.name = e.name; if (e.status != null) out.status = e.status; if (e.code != null) out.code = e.code;
    return out;
  }

  async function generate(req, signal) {
    const body = buildBody({ model, messages: req.messages, maxOutputTokens: req.maxOutputTokens, thinking: req.repair ? thinkingRepair : thinking });
    const requestParams = { thinking: body.thinking === undefined ? null : body.thinking, reasoning_effort: body.reasoning_effort ?? null, max_tokens: body.max_tokens ?? null, response_format: body.response_format ? body.response_format.type : null, temperature: body.temperature ?? null, stream: !!body.stream };
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    const t = Date.now();
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let res, text;
    try {
      res = await doFetch(url, { method: 'POST', headers, signal: sig, body: JSON.stringify(body) });
      text = await res.text();
    } catch (e) { throw redactError(e); }
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      const err = new Error(redactor.str('provider_http_' + res.status + ':' + String(text).slice(0, 200)));
      err.status = res.status;
      throw err;
    }
    const choice = json && json.choices && json.choices[0];
    const msg = (choice && choice.message) || {};
    return {
      text: msg.content == null ? '' : String(msg.content),
      reasoning: msg.reasoning_content == null ? null : String(msg.reasoning_content),
      usage: json && json.usage ? json.usage : null,
      finish_reason: (choice && choice.finish_reason) || null,
      request_id: (json && (json.id || json.request_id)) || null,
      provider: providerName, model: (json && json.model) || model,
      content_len: (msg.content == null ? 0 : String(msg.content).length),
      reasoning_len: (msg.reasoning_content == null ? 0 : String(msg.reasoning_content).length),
      request_params: requestParams,
      latency_ms: Date.now() - t,
    };
  }
  // `apiKey` is intentionally not exposed on the returned object.
  return { kind: 'openai-compatible', providerName, modelName: model, generate, redact: redactor.str };
}

module.exports = { openaiCompatible, buildBody };
