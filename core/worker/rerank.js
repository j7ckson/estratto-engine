// ================= 候选精排（T3：bge-reranker-base int8）=================
// 作用：问题 + 最多 10 个候选指标名 → 一个「像不像答案」的分数，按分数重排候选。
// 只在这里算分数，不产生计划、不执行、不联网（模型第一次用到才下载，见 main/rerank.js）。
// 模型：BAAI/bge-reranker-base（XLM-R cross-encoder，MIT），int8 ONNX 279MB，放用户数据目录，不进安装包；
// 运行库：复用 worker/vendor/ort 的 onnxruntime-web wasm（与向量同一套，不装原生模块、不加依赖）。
// 切词：XLM-R 的 tokenizer.json（Unigram）。没有引入 sentencepiece 原生库，用词表做 Viterbi 切分；
//       normalizer 的 Precompiled charsmap 用「NFKC + 控制字符/空白归一」近似（对中文指标名/问句影响极小，报告里写明）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ORT = path.join(__dirname, 'vendor', 'ort', 'ort.wasm.min.mjs');
const MODEL = 'bge-reranker-base-q8';
const MAX_TOKENS = 512;            // 问题 + 指标名都很短，512 够用；超了按「先截候选名」处理

let ready = null;
let pending = null;              // {dir, promise}

/* ---------------- 归一化 + 切词（照 tokenizer.json：Sequence[Precompiled, ...] + Metaspace + Unigram） ---------------- */
function normalizeText(text){
  let s = String(text == null ? '' : text).normalize('NFKC');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ');   // 去掉控制字符
  s = s.replace(/[\s\u00A0\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, ' '); // 各种空白归一成一个空格
  return s.trim();
}
function tokenizer(jsonPath){
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!raw.model || raw.model.type !== 'Unigram') throw new Error('rerank_tokenizer_unsupported:' + (raw.model && raw.model.type));
  const vocab = new Map(), id2piece = new Array(raw.model.vocab.length);
  let minScore = 0, maxLen = 1;
  raw.model.vocab.forEach(([piece, score], i) => {
    vocab.set(piece, { id: i, score });
    id2piece[i] = piece;
    if (score < minScore) minScore = score;
    if (piece.length > maxLen) maxLen = piece.length;
  });
  const unkId = raw.model.unk_id == null ? 3 : raw.model.unk_id;
  const unkScore = minScore - 10;                    // sentencepiece 的未知惩罚（比任何词都低一大截）
  const special = new Map((raw.added_tokens || []).map(a => [a.content, a.id]));
  const bos = special.has('<s>') ? special.get('<s>') : 0;
  const eos = special.has('</s>') ? special.get('</s>') : 2;
  // Metaspace(add_prefix_space=true)：空格 → ▁，句首补 ▁
  const metaspace = s => '▁' + s.replace(/ /g, '▁');

  // Unigram Viterbi：每个位置取总分最高的切法；整词表里没有的字走 <unk>（与 sentencepiece 一致）
  function encode(text){
    const s = metaspace(normalizeText(text));
    const chars = Array.from(s);
    const n = chars.length;
    if (!n) return [];
    const best = new Float64Array(n + 1).fill(-Infinity);
    const back = new Int32Array(n + 1).fill(-1);
    const backUnk = new Uint8Array(n + 1);
    best[0] = 0;
    for (let i = 0; i < n; i++){
      if (best[i] === -Infinity) continue;
      const max = Math.min(maxLen, n - i);
      let found = false;
      for (let L = 1; L <= max; L++){
        const piece = chars.slice(i, i + L).join('');
        const e = vocab.get(piece);
        if (!e) continue;
        found = true;
        const sc = best[i] + e.score;
        if (sc > best[i + L]) { best[i + L] = sc; back[i + L] = i; backUnk[i + L] = 0; }
      }
      if (!found){                                   // 这个位置没有词表里的开头：按 1 个字算 <unk>
        const sc = best[i] + unkScore;
        if (sc > best[i + 1]) { best[i + 1] = sc; back[i + 1] = i; backUnk[i + 1] = 1; }
      }
    }
    if (best[n] === -Infinity) return [unkId];       // 理论上走不到（上面每步都有 unk 兜底）
    const ids = [];
    for (let j = n; j > 0; j = back[j]) ids.push(backUnk[j] ? unkId : vocab.get(chars.slice(back[j], j).join('')).id);
    return ids.reverse();
  }
  // 句对模板（与 tokenizer.json 的 post_processor 一致）：<s> A </s></s> B </s>
  function encodePair(query, doc, maxLength){
    const max = Math.max(32, Math.min(Number(maxLength) || MAX_TOKENS, MAX_TOKENS));
    const cap = max - 4;                              // 4 个 special：<s> / </s></s> / </s>
    let a = encode(query), b = encode(doc);
    if (a.length + b.length > cap){
      if (b.length > a.length) b = b.slice(0, Math.max(1, cap - a.length));
      if (a.length + b.length > cap) a = a.slice(0, Math.max(1, cap - b.length));
    }
    return [bos, ...a, eos, eos, ...b, eos];
  }
  return { encode, encodePair, vocabSize: raw.model.vocab.length, id2piece };
}

/* ---------------- 模型加载（一条线程只加载一次） ---------------- */
async function init(dir){
  if (ready) return ready;
  if (pending && pending.dir === dir) return pending.promise;
  const modelDir = String(dir || '');
  if (!modelDir) throw new Error('rerank_model_dir_missing');
  const modelFile = path.join(modelDir, 'model_quantized.onnx');
  const tokenizerFile = path.join(modelDir, 'tokenizer.json');
  pending = { dir: modelDir, promise: (async () => {
    const ort = await import(pathToFileURL(ORT).href);
    ort.env.wasm.numThreads = 1;                      // 单线程：不抢查数/看板的核
    ort.env.logLevel = 'error';
    const tok = tokenizer(tokenizerFile);
    const buf = fs.readFileSync(modelFile);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);   // 零拷贝视图，少占 279MB
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    return { ort, tok, session, model: MODEL, dir: modelDir, bytes: buf.byteLength };
  })().catch(err => { pending = null; throw err; }) };
  ready = pending.promise;
  try { return await ready; } catch (err) { ready = null; throw err; }
}

/* ---------------- 打分：一批 (问题, 候选名) → logit ---------------- */
async function rerank(query, docs, opts = {}){
  const { ort, tok, session } = await init(opts.dir);
  if (!Array.isArray(docs) || !docs.length) return [];
  const maxLength = opts.maxLength;
  const scores = new Array(docs.length);
  const batch = Math.max(1, Math.min(Number(opts.batch) || 16, 32));   // 候选 ≤10 时一批算完，比 8 条一批快一倍
  for (let i = 0; i < docs.length; i += batch){
    const part = docs.slice(i, i + batch);
    const enc = part.map(d => tok.encodePair(query, d, maxLength));
    const B = enc.length, L = Math.max(...enc.map(e => e.length));
    const ids = new BigInt64Array(B * L), mask = new BigInt64Array(B * L), types = new BigInt64Array(B * L);
    enc.forEach((e, b) => e.forEach((v, j) => { ids[b * L + j] = BigInt(v); mask[b * L + j] = 1n; }));
    const feeds = { input_ids: new ort.Tensor('int64', ids, [B, L]), attention_mask: new ort.Tensor('int64', mask, [B, L]) };
    if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', types, [B, L]);
    const r = await session.run(feeds);
    const out = r[session.outputNames[0]];
    const cols = out.dims.length > 1 ? Number(out.dims[out.dims.length - 1]) : 1;
    for (let b = 0; b < B; b++) scores[i + b] = cols === 1 ? Number(out.data[b]) : Number(out.data[b * cols + cols - 1]);
  }
  return scores;
}

async function info(dir){
  const { session, bytes } = await init(dir);
  return { model: MODEL, dir, bytes, inputs: session.inputNames.slice(), outputs: session.outputNames.slice() };
}

module.exports = { rerank, init, info, tokenizer, normalizeText, MODEL, MAX_TOKENS };
