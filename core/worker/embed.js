// ================= 本机向量（10-16 第四批）=================
// 把一小段文字（指标名、分法名、分组值、词典说明、记忆）变成一串数（向量），意思越像的两段文字向量越近。
// 只给名字和文字算，不给经营数字算；全部在这台电脑上算，不联网。
// 模型：BAAI/bge-small-zh-v1.5（MIT，中文为主，512 维，int8 量化版 24MB），见 worker/models/bge-small-zh-v1.5/README.md；
// 10-23：加第二个模型 multilingual-e5-small（中英都懂，118MB，第一次用到才下载到用户数据目录，见 main/embed-model.js），按模型名切换；
// 运行库：ONNX Runtime Web 1.22.0 的 WebAssembly 版（MIT，worker/vendor/ort/），不用装原生模块，哪个系统都一样。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODEL_DIR = path.join(__dirname, 'models', 'bge-small-zh-v1.5');
const ORT = path.join(__dirname, 'vendor', 'ort', 'ort.wasm.min.mjs');
const MAX_TOKENS = 64;          // 名字、短句够用；更长的截断

/* ---------- BERT WordPiece 切词（照模型自带的 tokenizer.json：中文字前后加空格、按空白和标点切、最长匹配） ----------
   词表里没有大写英文，所以英文字母一律转小写（不转的话 ROAS 这种全大写缩写会整个变成「不认识」） */
function tokenizer(vocabFile){
  const words = fs.readFileSync(vocabFile, 'utf8').split('\n'); if (words[words.length - 1] === '') words.pop();
  const vocab = new Map(words.map((w, i) => [w, i]));
  const CLS = vocab.get('[CLS]'), SEP = vocab.get('[SEP]'), UNK = vocab.get('[UNK]');
  const isCJK = c => (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x20000 && c <= 0x2A6DF) || (c >= 0x2A700 && c <= 0x2B73F)
    || (c >= 0x2B740 && c <= 0x2B81F) || (c >= 0x2B820 && c <= 0x2CEAF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x2F800 && c <= 0x2FA1F);
  const isWS = ch => /\s/u.test(ch);
  const isCtrl = ch => ch !== '\t' && ch !== '\n' && ch !== '\r' && /[\p{Cc}\p{Cf}]/u.test(ch);
  const isPunct = ch => { const c = ch.codePointAt(0); return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) || /\p{P}/u.test(ch); };
  const normalize = text => {
    let out = '';
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      if (c === 0 || c === 0xFFFD || isCtrl(ch)) continue;
      if (isWS(ch)) { out += ' '; continue; }
      out += isCJK(c) ? ' ' + ch + ' ' : (c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch);
    }
    return out;
  };
  const pretok = text => {
    const out = [];
    for (const w of text.split(' ')) {
      if (!w) continue;
      let cur = '';
      for (const ch of w) { if (isPunct(ch)) { if (cur) out.push(cur); out.push(ch); cur = ''; } else cur += ch; }
      if (cur) out.push(cur);
    }
    return out;
  };
  const wordpiece = word => {
    const chars = Array.from(word);
    if (chars.length > 100) return [UNK];
    const ids = []; let start = 0;
    while (start < chars.length) {
      let end = chars.length, cur = null;
      while (start < end) { let sub = chars.slice(start, end).join(''); if (start > 0) sub = '##' + sub; if (vocab.has(sub)) { cur = vocab.get(sub); break; } end--; }
      if (cur == null) return [UNK];
      ids.push(cur); start = end;
    }
    return ids;
  };
  const encode = text => {
    const ids = [CLS];
    outer: for (const w of pretok(normalize(text))) for (const t of wordpiece(w)) { if (ids.length >= MAX_TOKENS - 1) break outer; ids.push(t); }
    ids.push(SEP);
    return ids;
  };
  return { encode, size: words.length };
}

const MODEL = 'bge-small-zh-v1.5-q8';              // 默认模型（随安装包带的那个）
const MODEL_E5 = 'multilingual-e5-small-q8';
// 对外用的短名 → 实际模型 id；不认识的名字一律当 bge（老调用不带名字就是 bge）
const NAMES = { 'bge-small-zh-v1.5': MODEL, 'bge-small-zh-v1.5-q8': MODEL, 'multilingual-e5-small': MODEL_E5, 'multilingual-e5-small-q8': MODEL_E5 };
const modelId = name => NAMES[name] || MODEL;

// e5 模型文件放哪：消息里带的 dir > 环境变量 STUDIO_E5_DIR（main/embed-model.js 下载好后设）> <STUDIO_MODELS_DIR>/multilingual-e5-small
function e5Dir(dir){
  if (dir) return String(dir);
  return null;
}

/* ---------- e5 的切词：XLM-R 的 Unigram（直接用 worker/rerank.js 里那份 Viterbi + NFKC 近似），前后补 <s> </s> ---------- */
function e5Tokenizer(jsonPath){
  const t = require('./rerank.js').tokenizer(jsonPath);
  const BOS = 0, EOS = 2;
  // e5 的用法：每段文字前面加 "query: "（名字、短句都当 query 用，两边对称）
  const encode = text => {
    let ids = t.encode('query: ' + String(text == null ? '' : text));
    if (ids.length > MAX_TOKENS - 2) ids = ids.slice(0, MAX_TOKENS - 2);
    return [BOS, ...ids, EOS];
  };
  return { encode, size: t.vocabSize };
}

const ready = {};                                    // 模型 id → 加载好的 Promise
async function loadOrt(){
  const ort = await import(pathToFileURL(ORT).href);
  ort.env.wasm.numThreads = 1;                        // 单线程：不另开线程，也不抢查数的核
  ort.env.logLevel = 'error';
  return ort;
}
function init(name, dir){
  const id = modelId(name);
  if (ready[id]) return ready[id];
  ready[id] = (async () => {
    const ort = await loadOrt();
    if (id === MODEL_E5) {
      const d = e5Dir(dir);
      const mf = d && path.join(d, 'model_quantized.onnx'), tf = d && path.join(d, 'tokenizer.json');
      if (!d || !fs.existsSync(mf) || !fs.existsSync(tf)) throw new Error('e5_model_missing');
      const buf = fs.readFileSync(mf);
      const session = await ort.InferenceSession.create(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      return { ort, tok: e5Tokenizer(tf), session, pool: 'mean' };
    }
    const tok = tokenizer(path.join(MODEL_DIR, 'vocab.txt'));
    const session = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(path.join(MODEL_DIR, 'model_quantized.onnx'))));
    return { ort, tok, session, pool: 'cls' };
  })().catch(err => { delete ready[id]; throw err; });
  return ready[id];
}
// 一批文字 → 一批单位向量。bge：取 [CLS] 位置、归一化；e5：按 attention_mask 做平均池化、归一化
async function embed(texts, name, dir){
  const { ort, tok, session, pool } = await init(name, dir);
  const out = [];
  // e5 是 int8 动态量化：一批里别的句子会影响量化刻度，同一句话换了批次向量会差 0.3%，所以 e5 一次只算一句（缓存里同一句永远是同一个向量）
  const step = pool === 'mean' ? 1 : 32;                      // bge 每批 32 条，长短差不多的放一起更省
  for (let i = 0; i < texts.length; i += step) {
    const enc = texts.slice(i, i + step).map(t => tok.encode(t));
    const B = enc.length, L = Math.max(...enc.map(e => e.length));
    const ids = new BigInt64Array(B * L), mask = new BigInt64Array(B * L), types = new BigInt64Array(B * L);
    // e5 的补位用 <pad>=1，bge 补 0；补的位置 mask 是 0，不参与池化
    if (pool === 'mean') ids.fill(1n);
    enc.forEach((e, b) => e.forEach((v, j) => { ids[b * L + j] = BigInt(v); mask[b * L + j] = 1n; }));
    const feeds = { input_ids: new ort.Tensor('int64', ids, [B, L]), attention_mask: new ort.Tensor('int64', mask, [B, L]) };
    if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', types, [B, L]);
    const r = await session.run(feeds);
    const h = r[session.outputNames[0]], D = h.dims[2];
    for (let b = 0; b < B; b++) {
      const v = new Float32Array(D);
      if (pool === 'mean') {
        const n = enc[b].length;
        for (let j = 0; j < n; j++) for (let d = 0; d < D; d++) v[d] += h.data[(b * L + j) * D + d];
        for (let d = 0; d < D; d++) v[d] /= n;
      } else for (let d = 0; d < D; d++) v[d] = h.data[b * L * D + d];
      let s = 0; for (let d = 0; d < D; d++) s += v[d] * v[d];
      s = Math.sqrt(s) || 1; for (let d = 0; d < D; d++) v[d] /= s;
      out.push(v);
    }
  }
  return out;
}
module.exports = { embed, init, tokenizer, e5Tokenizer, e5Dir, modelId, MODEL, MODEL_E5, NAMES };
