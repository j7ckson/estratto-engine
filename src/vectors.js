'use strict';
// Local vectors for value matching: multilingual-e5-small through the vendored ONNX runtime (wasm), in-process.
// Same shape as arm-public.mjs getVecBatch(): unit-vector dot products, per-process (here: per-engine) text cache,
// disabled (with a warning event) when the model files are absent or fail to load.
const fs = require('node:fs');
const path = require('node:path');

const E5_NAME = 'multilingual-e5-small';
const EMBED_PATH = require.resolve('../core/worker/embed.js');

// core/worker/embed.js keeps loaded sessions in a module-level table keyed by model id. Load a private copy of the
// module per engine so two engines (possibly with different modelsDir) never share that state.
function loadPrivateEmbed() {
  const saved = require.cache[EMBED_PATH];
  delete require.cache[EMBED_PATH];
  try { return require(EMBED_PATH); }
  finally { if (saved) require.cache[EMBED_PATH] = saved; else delete require.cache[EMBED_PATH]; }
}

function resolveModelDir(modelsDir) {
  if (!modelsDir) return null;
  const direct = path.join(modelsDir, 'model_quantized.onnx');
  if (fs.existsSync(direct)) return modelsDir;
  const nested = path.join(modelsDir, E5_NAME);
  if (fs.existsSync(path.join(nested, 'model_quantized.onnx'))) return nested;
  return null;
}

/** @returns {Promise<{vecBatch:Function|undefined, status:'enabled'|'disabled', reason?:string, dir?:string}>} */
async function createVecBatch({ modelsDir, onEvent } = {}) {
  const warn = (reason) => { try { onEvent && onEvent({ type: 'vectors_disabled', level: 'warning', reason }); } catch (_) {} return { vecBatch: undefined, status: 'disabled', reason }; };
  const dir = resolveModelDir(modelsDir);
  if (!dir) return warn('model_missing: multilingual-e5-small not found under modelsDir' + (modelsDir ? ' (' + modelsDir + ')' : ' (modelsDir not set)') + '; run `node scripts/fetch-model.js <dir>`');
  let embed;
  try { embed = loadPrivateEmbed().embed; await embed(['test'], E5_NAME, dir); }
  catch (err) { return warn('model_load_failed: ' + String(err && err.message || err).slice(0, 120)); }
  const mem = new Map();
  const vecs = async (texts) => {
    const need = [...new Set(texts.filter(t => !mem.has(t)))];
    if (need.length) { const out = await embed(need, E5_NAME, dir); need.forEach((t, i) => mem.set(t, out[i])); }
    return texts.map(t => mem.get(t));
  };
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const vecBatch = async (qs, vals) => {
    try {
      const qv = await vecs(qs.map(x => String(x).slice(0, 200)));
      const vv = await vecs(vals.map(x => String(x).slice(0, 200)));
      return qv.map(q => vv.map(v => dot(q, v)));
    } catch (_) { return null; }
  };
  return { vecBatch, status: 'enabled', dir };
}

module.exports = { createVecBatch, resolveModelDir, E5_NAME };
