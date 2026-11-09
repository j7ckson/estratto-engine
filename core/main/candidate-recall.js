// ================= 候选检索（理解入口第 4 组）=================
// 目的：一次短结构化调用之前，把「这句话可能指哪个指标 / 维度」按本机已有线索排好序，交给模型选。
// 约束（能力方案终审 §3 / 第 4 组要求）：
//   · 复用现有三源，不新写检索服务：
//       ① 每个人的记忆 memory_items（main/memory.js 的 MemoryStore，kind=name 的叫法）
//       ② 表头 / 规则叫法（plan-ir 现有的 metricCandidates / dimCandidates：绑定列的表头名 + 规则叫法）
//       ③ 出厂词典（main/dict.js 的 termsIn / lookup）
//       ④ 本机向量（main/vectors.js 的 VectorIndex.resolve，worker/embed；没开或不可用就不查）
//   · 顺序固定：记忆 > 表头/规则叫法 > 出厂词典 > 本机向量；去重后取前 N 个。
//   · 候选上限 5–10 可配置，默认 8（candidateLimitOf 负责夹住，越界不报错、按边界算）。
//   · 权限过滤在检索 / 缓存读取之前：不允许的数据集，其指标 / 维度 / 记忆条目在进入候选前就被丢掉，
//     并记在 denied 里（可解释），不靠后续校验兜底。
// 返回值只描述候选，不产生计划、不执行、不调模型。
'use strict';

const DEFAULT_CANDIDATE_LIMIT = 8;
const MIN_CANDIDATE_LIMIT = 5;
const MAX_CANDIDATE_LIMIT = 10;
const SOURCE_ORDER = ['memory', 'rules', 'dict', 'vectors'];

const norm = s => String(s == null ? '' : s).replace(/[\s_\-·.、()（）\[\]【】]/g, '').toLowerCase();
const stripPrefix = (s, p) => String(s == null ? '' : s).replace(new RegExp('^' + p + ':'), '');

/** 候选上限：默认 8，夹在 5–10；接受数字或 {candidateLimit} */
function candidateLimitOf(v) {
  const raw = v && typeof v === 'object' ? v.candidateLimit : v;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CANDIDATE_LIMIT;
  return Math.max(MIN_CANDIDATE_LIMIT, Math.min(MAX_CANDIDATE_LIMIT, Math.round(n)));
}

/* ---------------- 权限：检索之前先算允许范围 ---------------- */
function allowedDatasetsOf(o) {
  const scope = (o && o.scope) || null;
  const ds = scope && Array.isArray(scope.datasets) ? scope.datasets : null;
  return Array.isArray(ds) ? new Set(ds.map(String)) : null;
}
function permissions(registry, allowed) {
  const datasetsOfMetric = id => {
    try { return registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo).filter(Boolean); }
    catch (_) { try { const m = registry.metric(id); return [m.dataset || m.boundTo].filter(Boolean); } catch (_) { return []; } }
  };
  return {
    allowed,
    metric(id) {
      if (!allowed) return true;
      const ds = datasetsOfMetric(id);
      return ds.length ? ds.every(d => allowed.has(d)) : false;
    },
    dim(id) {
      if (!allowed) return true;
      try { const d = registry.dim(id); const t = (d.source && d.source.table) || d.dataset || null; return !!t && allowed.has(String(t)); }
      catch (_) { return false; }
    },
    table(tableId) { return !allowed || tableId == null || allowed.has(String(tableId)); },
  };
}

/* ---------------- ① 记忆：叫法 → 指标 / 维度 ---------------- */
function metricIndex(registry) {
  const byKey = new Map();                      // 规范化叫法 → [metricId]
  const add = (k, id) => { const n = norm(k); if (!n || n.length < 2) return; const a = byKey.get(n) || []; if (!a.includes(id)) a.push(id); byKey.set(n, a); };
  let metrics = [];
  try { metrics = [...registry.semantic.metrics.values()]; } catch (_) {}
  for (const m of metrics) {
    if (m.unbound) continue;
    const id = 'm:' + m.id;
    for (const k of [m.id, m.name, m.field, ...(m.aliases || []), ...(m.match || [])].filter(Boolean)) add(k, id);
  }
  return byKey;
}
function dimIndex(registry) {
  const byKey = new Map();
  const add = (k, id) => { const n = norm(k); if (!n || n.length < 2) return; const a = byKey.get(n) || []; if (!a.includes(id)) a.push(id); byKey.set(n, a); };
  let dims = [];
  try { dims = [...registry.semantic.dims.values()]; } catch (_) {}
  for (const d of dims) {
    if (d.unbound) continue;
    const id = 'd:' + d.id;
    for (const k of [d.id, d.name, d.source && d.source.field, ...(d.match || []), ...(d.aliases || [])].filter(Boolean)) add(k, id);
  }
  return byKey;
}

/**
 * 记忆里的叫法（memory_items kind=name）：说法出现在这句话里才算命中。
 * 目标可能是指标（target.kind=metric）、维度（dim）或某个分组值（value → 只收维度）。
 * 记忆条目在权限过滤之前先按 table_id 过一遍，没权限的直接不进候选。
 */
function memoryCandidates(question, o, perm, indices) {
  const out = { metrics: [], dimensions: [], denied: 0 };
  const store = o && o.memory;
  if (!store || typeof store.names !== 'function') return out;
  let rows = [];
  try { rows = store.names() || []; } catch (_) { return out; }
  const q = norm(question);
  for (const r of rows) {
    if (!r || r.status === 'off') continue;
    const data = r.data || {}, tgt = data.target || {};
    const phrase = norm(data.phrase || data.term);
    if (!phrase || !q.includes(phrase)) continue;
    if (!perm.table(r.table_id || tgt.tableId)) { out.denied++; continue; }
    const keys = [tgt.col, tgt.value, data.phrase].filter(Boolean).map(norm);
    if (tgt.kind === 'dim' || tgt.kind === 'value') {
      const hits = new Set();
      for (const k of keys) for (const id of (indices.dims.get(k) || [])) hits.add(id);
      for (const id of hits) if (perm.dim(id)) out.dimensions.push(id);
    } else {
      const hits = new Set();
      for (const k of keys) for (const id of (indices.metrics.get(k) || [])) hits.add(id);
      for (const id of hits) if (perm.metric(id)) out.metrics.push(id);
    }
  }
  return out;
}

/* ---------------- ② 表头 / 规则叫法（plan-ir 现有匹配） ---------------- */
function rulesCandidates(question, o, perm, planIr) {
  const out = { metrics: [], dimensions: [] };
  try {
    const mc = planIr.metricCandidates(o.registry, question);
    for (const id of mc.candidates || []) if (perm.metric(id)) out.metrics.push(id);
  } catch (_) {}
  try {
    const dc = planIr.dimCandidates(o.registry, question);
    const ids = Array.isArray(dc) ? dc : (dc && dc.ambiguous) || [];
    for (const id of ids) if (perm.dim(id)) out.dimensions.push(id);
  } catch (_) {}
  return out;
}

/* ---------------- ③ 出厂词典（main/dict.js） ---------------- */
function dictCandidates(question, o, perm, indices) {
  const out = { metrics: [], dimensions: [] };
  const dict = o && o.dict;
  if (!dict || typeof dict.termsIn !== 'function') return out;
  let terms = [];
  try { terms = dict.termsIn(question) || []; } catch (_) { return out; }
  const ids = new Set();
  for (const t of terms) for (const id of (t.ids || [])) ids.add(id);
  let byId = null;
  try { byId = (dict.byId || null); } catch (_) {}
  for (const id of ids) {
    const entry = byId && byId.get ? byId.get(id) : null;
    if (!entry) continue;
    const keys = [entry.id, entry.zh, entry.en, ...(entry.abbr || []), ...(entry.alias || [])].filter(Boolean);
    const hits = new Set();
    for (const k of keys) for (const mid of (indices.metrics.get(norm(k)) || [])) hits.add(mid);
    for (const mid of hits) if (perm.metric(mid)) out.metrics.push(mid);
  }
  return out;
}

/* ---------------- ④ 本机向量（只在还缺候选时查；不可用就当没有） ---------------- */
async function vectorCandidates(question, o, perm, limit) {
  const out = { metrics: [], dimensions: [] };
  const vectors = o && o.vectors;
  if (!vectors || typeof vectors.resolve !== 'function') return out;
  try {
    if (typeof vectors.on === 'function' && !o.forceVectors && !vectors.on()) return out;
    const metrics = [];
    for (const m of registryMetrics(o.registry)) {
      if (m.unbound || !perm.metric('m:' + m.id)) continue;
      metrics.push({ id: 'm:' + m.id, label: m.name, alias: [...(m.aliases || []), ...(m.match || [])] });
    }
    if (!metrics.length) return out;
    const r = await vectors.resolve(question, metrics, true);
    if (!r) return out;
    const picked = r.pick ? [r.pick] : (r.options || []);
    for (const m of picked) if (m && m.id && perm.metric(m.id)) out.metrics.push(m.id);
  } catch (_) { /* 向量没开 / worker 不在：不阻断，按没有处理 */ }
  return out;
}

/* ---------------- 组装：顺序 + 去重 + 上限 ---------------- */
function registryMetrics(registry) {
  try { return [...registry.semantic.metrics.values()]; } catch (_) { return []; }
}
function describeMetric(registry, id) {
  try { const m = registry.metric(id); return { id, name: m.name, unit: m.unit || '', kind: m.kind || 'simple' }; }
  catch (_) { return { id }; }
}
function describeDim(registry, id) {
  try { const d = registry.dim(id); return { id, name: d.name }; }
  catch (_) { const raw = stripPrefix(id, 'd'); return { id: 'd:' + raw, name: raw }; }
}

/**
 * 候选检索主入口。
 * @param {string} question
 * @param {{registry, scope?, memory?, dict?, vectors?, candidateLimit?, candidateMax?, forceVectors?}} o
 * @returns {Promise<{limit:number, metrics:Array, dimensions:Array, sources:object, denied:number, vectors_used:boolean}>}
 */
async function recallCandidates(question, o = {}) {
  const registry = o.registry;
  if (!registry) throw new Error('候选检索需要 registry');
  const limit = candidateLimitOf(o);
  // 权限过滤在检索之前：先算出允许范围，再让各源只能往里放
  const allowed = allowedDatasetsOf(o);
  const perm = permissions(registry, allowed);
  const indices = { metrics: metricIndex(registry), dims: dimIndex(registry) };
  const q = String(question == null ? '' : question);

  const memory = memoryCandidates(q, o, perm, indices);
  const rules = rulesCandidates(q, o, perm, o.planIr || require('./plan-ir'));
  const dict = dictCandidates(q, o, perm, indices);
  const sources = {
    memory: memory.metrics.length + memory.dimensions.length,
    rules: rules.metrics.length + rules.dimensions.length,
    dict: dict.metrics.length + dict.dimensions.length,
    vectors: 0,
  };
  let denied = memory.denied;

  // 本机向量：只在还没凑够候选时查（同一段文字本机有缓存，不会重复算）
  let vectors = { metrics: [], dimensions: [] };
  const seeded = new Set([...memory.metrics, ...rules.metrics, ...dict.metrics].map(x => stripPrefix(x, 'm')));
  if (seeded.size < limit) {
    vectors = await vectorCandidates(q, o, perm, limit);
    sources.vectors = vectors.metrics.length + vectors.dimensions.length;
  }

  const buckets = { memory, rules, dict, vectors };
  const metrics = [], dimensions = [], seenM = new Set(), seenD = new Set();
  for (const src of SOURCE_ORDER) {
    for (const id of buckets[src].metrics) {
      const raw = stripPrefix(id, 'm');
      if (seenM.has(raw)) continue;
      if (!perm.metric('m:' + raw)) { denied++; continue; }
      seenM.add(raw);
      if (metrics.length < limit) metrics.push(Object.assign(describeMetric(registry, 'm:' + raw), { source: src }));
    }
    for (const id of buckets[src].dimensions) {
      const raw = stripPrefix(id, 'd');
      if (seenD.has(raw)) continue;
      if (!perm.dim('d:' + raw)) { denied++; continue; }
      seenD.add(raw);
      if (dimensions.length < limit) dimensions.push(Object.assign(describeDim(registry, 'd:' + raw), { source: src }));
    }
  }
  // 末尾精排钩子（T3）：o.rerank 由调用方注入（main/rerank.js 的 Reranker），只在选中候选 >1 时按「问题↔指标名」重排顺序，
  // 不增减候选、不改四源逻辑与上限语义；精排关闭 / 模型缺 / 下载中 / 出错都原样返回（orderCandidates 内部已兜底）。
  if (o.rerank && typeof o.rerank.orderCandidates === 'function' && metrics.length > 1) {
    try {
      const ordered = await o.rerank.orderCandidates(q, metrics);
      if (Array.isArray(ordered) && ordered.length === metrics.length) metrics.splice(0, metrics.length, ...ordered);
    } catch (_) { /* 精排坏了不影响候选 */ }
  }
  return { question: q, limit, metrics, dimensions, sources, denied, vectors_used: sources.vectors > 0 };
}

/** 候选里有这几个 id 吗（测试 / 可解释性用） */
function hasMetric(recall, id) { return !!(recall && (recall.metrics || []).some(m => m.id === String(id))); }
function rankOf(recall, id) { return (recall && (recall.metrics || []).findIndex(m => m.id === String(id))) ?? -1; }

module.exports = {
  recallCandidates, candidateLimitOf, hasMetric, rankOf,
  DEFAULT_CANDIDATE_LIMIT, MIN_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT, SOURCE_ORDER,
};
