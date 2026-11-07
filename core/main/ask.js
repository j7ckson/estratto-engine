// ================= 自然语言统一入口（plan-ir/2）=================
// 目标（能力方案终审 §1/§2/§5）：
//   · App / Agent 工具 / headless C 都调用同一个 ask()；桥接层只转发和记录，不放解题算法。
//   · 先做「已确认计划的精确参数匹配」：每个约束都明确映射才允许零调用。
//   · 其余用一次短结构化调用生成完整 IR（指标/实体/否定/时间角色与区间/维度/比较/排序并列/公式/单位/输出形状/未决项）。
//   · 每个用户约束必须映射到计划节点；模型省略 unresolved 不等于完整；明确提到但无法表示 → 报能力缺口，不静默丢弃。
//   · 仅可恢复的结构/引用错误允许一次短修复，与首次 IR 调用共用「≤2 次」额度；所有调用累计进同题 token。
//   · 零调用/调用数由调用方传入的 provider 请求日志（callLog）计数；缓存命中返回的 llm_calls 含此前 resolve 调用。
//   · 问数短输出：本地 renderer 从类型化 facts 生成答案；不额外调模型润色。
'use strict';
const { parsePlan, validatePlan, executePlan, normalizePlan, planHash, extractSignals, irToPlan,
  matchConfirmedPlan, buildIRSchema, unmappedConditions: unmappedConditionsBase, structureGaps, residualConcepts, localConditionGaps, skeletonOf, CODES, PLAN_SCHEMA, LEGACY_PLAN_SCHEMA } = require('./plan-ir');
const { ReuseCache } = require('./reuse');
const { FactBook } = require('./facts');
const { answerLine } = require('./answer-format');
const { selfCheck } = require('./self-check');
const { recallCandidates, candidateLimitOf, DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT } = require('./candidate-recall');
const dict = require('./dict');

const fmt = v => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
// P79:题面明确要求保留 N 位小数（或整数）时按题面位数显示，否则沿用默认两位
function askedDecimals(question){
  const q = String(question || ''), CN = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  let m = /保留\s*([0-6零一两二三四五六])\s*位小数/.exec(q); if (m) return CN[m[1]] ?? Number(m[1]);
  m = /\b([0-6])\s*decimal(?:\s+places?|s)\b/i.exec(q); if (m) return Number(m[1]);
  m = /\bto\s+([0-6])\s+decimal/i.exec(q); if (m) return Number(m[1]);
  if (/保留整数|取整数|四舍五入到整数|\bas an integer\b|\bwhole number\b/i.test(q)) return 0;
  return null;
}
const CODE_TEXT = {
  [CODES.MISSING_TIME_ROLE]: '按哪个时间口径统计？',
  [CODES.AMBIGUOUS_METRIC]: '用哪个指标？',
  [CODES.AMBIGUOUS_ENTITY]: '指哪个对象？',
  'ambiguous_dim': '按哪个维度分组？',
  [CODES.UNSUPPORTED_OPERATOR]: '这个组合目前算不了',
  [CODES.PERMISSION_DENIED]: '没有这部分数据的权限',
  [CODES.PLAN_INCOMPLETE]: '条件还不完整',
  [CODES.CAPABILITY_GAP]: '系统表达能力不足，不能保证按你说的口径算',
  [CODES.IR_INVALID]: '模型给的计划结构不合法，已拒绝执行',
  [CODES.BUDGET_EXCEEDED]: '本题模型调用超出 token 预算',
};

const DEFAULT_MAX_CALLS = 2;          // 首次 IR + 一次修复共用
const DEFAULT_MAX_TOKENS = 2000;     // 每题所有调用合计（input+output；reasoning 已含在 output 内不重复加）
const IR_OUTPUT_MAX_TOKENS = 320;    // 短输出：只给结构化计划

const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** 每题一遍：记录 provider 真实请求（调用数/用量以它为准） */
function makeCallLog(seed){
  const log = Array.isArray(seed) ? seed : [];
  log.usage = log.usage || null;
  return log;
}
const { sumUsage } = require('./provider-usage');
function pushCall(callLog, providerResult, fallbackProvider){
  const src = providerResult || {};
  if (src.request_id) {const existing=callLog.find(c=>c && c.request_id===src.request_id);if(existing){if(src.purpose)existing.purpose=src.purpose;return null;}}
  const call = {
    provider: src.provider || fallbackProvider || null,
    model: src.model || null,
    request_id: src.request_id || src.id || null,
    at: new Date().toISOString(),
    usage: src.usage || null,
    finish_reason: src.finish_reason || (src.usage && src.usage.finish_reason) || null,
    purpose: src.purpose || 'ir', attempt_id: src.attempt_id || src.request_id || require('node:crypto').randomUUID(), status: src.status || (src.ok === false ? src.code || 'failed' : 'completed'),
  };
  callLog.push(call);
  return call;
}

/** 候选半径：默认短候选，但必须联动含公式依赖/连接键/时间角色/适用范围（§3）
 *  第 4 组：候选先由 main/candidate-recall.js 按「记忆 > 表头/规则叫法 > 出厂词典 > 本机向量」召回，
 *  这里只做「召回结果在前、相关能力补足、依赖补齐」的组装；上限 5–10（默认 8）由 candidateLimitOf 统一夹住。
 *  权限过滤在候选检索之前完成（scope.datasets 不允许的指标/维度不进候选）。 */
// 10-23（A6 缓存试验「乙」）：把本域全部指标 / 维度的「编号｜名称｜单位」放进固定说明（每题一样 → 按缓存价），
// 每题只发候选编号。只在 o.irCatalog === 'system' 或环境变量 STUDIO_IR_CATALOG=system 时用；超过 CATALOG_MAX 条不用（太长）。
// 权限：和候选同一套过滤（scope.datasets）；按编号排序，保证每题字面一致。
const CATALOG_MAX = 300;
const catalogCache = new WeakMap();
function irCatalogOn(o){ return !!(o && o.irCatalog === 'system'); }
function catalogFor(registry, o){
  if (!registry || !registry.semantic) return null;
  const scopeKey = o && o.scope && Array.isArray(o.scope.datasets) ? o.scope.datasets.map(String).sort().join(',') : '*';
  let byScope = catalogCache.get(registry); if (!byScope) { byScope = new Map(); catalogCache.set(registry, byScope); }
  if (byScope.has(scopeKey)) return byScope.get(scopeKey);
  let out = null;
  try {
    const allowed = scopeKey === '*' ? null : new Set(scopeKey.split(','));
    const okM = m => { if (!allowed) return true; try { const ds = registry.leaves('m:' + String(m.id).replace(/^m:/, '')).map(l => registry.metric(l).dataset || registry.metric(l).boundTo).filter(Boolean); return ds.length ? ds.every(d => allowed.has(d)) : false; } catch (_) { return false; } };
    const okD = d => { if (!allowed) return true; const t = (d.source && d.source.table) || d.dataset; return !!t && allowed.has(String(t)); };
    const ms = [...registry.semantic.metrics.values()].filter(m => !m.unbound && okM(m))
      .map(m => ['m:' + String(m.id).replace(/^m:/, ''), m.name, m.unit || '']).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const ds = [...(registry.semantic.dims ? registry.semantic.dims.values() : [])].filter(d => !d.unbound && d.kind !== 'timeBucket' && okD(d))
      .map(d => ['d:' + String(d.id).replace(/^d:/, ''), d.name]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    if (ms.length + ds.length <= CATALOG_MAX) out = { metrics: ms, dimensions: ds };
  } catch (_) { out = null; }
  byScope.set(scopeKey, out);
  return out;
}

function candidateBundle(registry, question, o){
  const limit = candidateLimitOf(o.candidateLimit != null ? o.candidateLimit : o);
  const recalled = o.candidates || null;
  const allowed = o.scope && Array.isArray(o.scope.datasets) ? new Set(o.scope.datasets.map(String)) : null;
  const metricAllowed = id => {
    if (!allowed) return true;
    try { const ds = registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo).filter(Boolean); return ds.length ? ds.every(d => allowed.has(d)) : false; }
    catch (_) { return false; }
  };
  const dimAllowed = id => {
    if (!allowed) return true;
    try { const d = registry.dim(id); const t = (d.source && d.source.table) || d.dataset; return !!t && allowed.has(String(t)); }
    catch (_) { return false; }
  };
  let cap = null;
  try { cap = registry.capabilities(question, { limit: Math.max(limit, DEFAULT_CANDIDATE_LIMIT) }); } catch (_) { cap = null; }
  const metrics = [], dims = [];
  const seenM = new Set(), seenD = new Set();
  // P78:用户确认的「计划/目标/预算」类指标是带限定词的口径；题面没说计划/目标/预算时，「GMV」默认指实际值，不把计划值拉进候选造成歧义
  const PLAN_WORD = /计划|目标|预算|达成|完成率|plan|target|budget|quota/i;
  const planQualified = raw => { try { const m = registry.metric('m:' + raw); return !!(m && m.confirmed && !m.auto && /计划|目标|预算/.test([m.name, ...(m.aliases || [])].join(' '))); } catch (_) { return false; } };
  const addMetric = id => {
    const raw = String(id).replace(/^m:/, '');
    if (!raw || seenM.has(raw) || !metricAllowed('m:' + raw)) return;
    if (!PLAN_WORD.test(String(question || '')) && planQualified(raw)) return;
    seenM.add(raw); metrics.push('m:' + raw);
  };
  const addDim = id => {
    const raw = String(id).replace(/^d:/, '');
    if (!raw || seenD.has(raw) || !dimAllowed('d:' + raw)) return;
    seenD.add(raw); dims.push('d:' + raw);
  };
  // P78 精确字段提及优先(经典做法:schema linking 的 exact match,如 RAT-SQL 的「题面 n-gram 恰好等于列名」):
  // 题面原样写出某个指标的字段名(如 return_gmv),这个指标一定进候选并排最前。
  const fieldMentioned = m => !!(m && m.field && /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(m.field) && /_/.test(m.field) && new RegExp('(?:^|[^A-Za-z0-9_])' + m.field + '(?=$|[^A-Za-z0-9_])').test(String(question || '')));
  try { for (const m of (registry.semantic ? registry.semantic.metrics.values() : [])) if (!m.unbound && (m.kind || 'simple') === 'simple' && fieldMentioned(m)) addMetric(m.id); } catch (_) {}
  for (const m of (recalled && recalled.metrics) || []) if (metrics.length < limit) addMetric(m.id);
  for (const d of (recalled && recalled.dimensions) || []) if (dims.length < limit) addDim(d.id);
  for (const m of (cap && cap.metrics) || []) if (metrics.length < limit) addMetric(m.id);
  for (const d of (cap && cap.dimensions) || (cap && cap.dims) || []) if (dims.length < limit) addDim(d.id);
  // 候选召回不能把正确答案裁掉：短候选召不满时，回退到「本域全部指标/维度」（小域只有几十个），但仍有上限；
  // 权限过滤由上面 metricAllowed/dimAllowed 在这里同样生效。
  if (metrics.length < Math.min(3, limit)) {
    try {
      // registry.metrics()/dims() 返回的是编号字符串；这里要对象才能看 unbound/绑定
      const allMetrics = [...(registry.semantic ? registry.semantic.metrics.values() : [])].filter(m => !m.unbound);
      for (const m of allMetrics) { if (metrics.length >= limit) break; addMetric(m.id); }
    } catch (_) {}
  }
  // 维度补齐：优先给「和指标同表」的维度（问 SKU 时给 sale_sku，而不是被别的表的同名维度挤掉），再给其它维度
  if (dims.length < limit) {
    try {
      const metricDss = new Set();
      for (const id of metrics) { try { for (const l of registry.leaves(id)) { const mm = registry.metric(l); metricDss.add(mm.dataset || mm.boundTo); } } catch (_) {} }
      // 时间桶维度不进自动补齐：时间序列靠 plan.grain，放进 dimensions 会让模型把「各渠道」答成「渠道·月份」（ratio 类回归）
      const allDims = [...(registry.semantic ? registry.semantic.dims.values() : [])].filter(x => !x.unbound && x.source && x.source.table && x.kind !== 'timeBucket');
      const same = allDims.filter(x => metricDss.has(x.source.table));
      const other = allDims.filter(x => !metricDss.has(x.source.table));
      for (const d of [...same, ...other]) { if (dims.length >= limit) break; addDim(d.id); }
    } catch (_) {}
  }
  const roles = (() => { try { return registry.timeRoles(); } catch (_) { return []; } })();
  const ids = new Set(metrics);
  // 公式依赖：比率/派生指标的分子分母必须一起出现，否则候选不含答案
  const deps = [];
  for (const id of metrics) {
    try {
      const full = registry.metric(id);
      if (full && full.kind === 'ratio' && full.num && full.den) for (const x of [full.num, full.den]) {
        const rid = String(x).replace(/^m:/, '');
        if (!ids.has('m:' + rid)) { ids.add('m:' + rid); deps.push('m:' + rid); }
      }
      if (full && full.kind === 'derived') for (const l of registry.leaves('m:' + (full.id || String(id).replace(/^m:/, '')))) {
        // registry.leaves() 返回的是带 m: 前缀的编号；再拼一次会得到 m:m:gmv 这种空名字候选喂给模型
        const lid = String(l).startsWith('m:') ? String(l) : 'm:' + l;
        if (!ids.has(lid)) { ids.add(lid); deps.push(lid); }
      }
    } catch (_) {}
  }
  // 第三轮：同表「兄弟指标」——题面括号里常写「在途 ÷（可用 + 在途）」，只说「可用」两个字召不回「期末可用库存量」，
  // 模型就会拿别的表的「销量」顶上。这里把候选指标所在表上、名字和题面有两字以上重合的指标补进来（最多 4 个）。
  try {
    const qn = String(question || '');
    const grams = new Set();
    for (let i = 0; i + 2 <= qn.length; i++) { const g = qn.slice(i, i + 2); if (/^[\u4e00-\u9fff]{2}$/.test(g)) grams.add(g); }
    const dss = new Set();
    for (const id of ids) { try { for (const l of registry.leaves(id)) { const mm = registry.metric(l); if (mm.dataset || mm.boundTo) dss.add(mm.dataset || mm.boundTo); } } catch (_) {} }
    let added = 0;
    for (const m of [...(registry.semantic ? registry.semantic.metrics.values() : [])]) {
      if (added >= 4) break;
      if (m.unbound || m.kind !== 'simple' || !dss.has(m.dataset) || ids.has('m:' + m.id) || !metricAllowed('m:' + m.id)) continue;
      const names = [m.name, ...(m.aliases || [])].filter(Boolean).join(' ');
      if ([...grams].some(g => names.includes(g))) { ids.add('m:' + m.id); deps.push('m:' + m.id); added++; }
    }
  } catch (_) {}
  const values = o.entityValues || null;   // 调用方给的值表（权限过滤后）
  // T2：候选卡片短版（只给前 3 个，各加一行「计算方式｜时间角色」；其余保持 id/name/unit，省 token）
  const metricList = [...ids].slice(0, limit + deps.length);
  const cardOfId = id => {
    try {
      if (typeof dict.cardOf !== 'function') return null;
      const c = dict.cardOf(String(id).replace(/^m:/, ''));
      if (!c || !c.spec) return null;
      return [c.spec.calc, c.spec.time_role].filter(Boolean).join('｜');
    } catch (_) { return null; }
  };
  return {
    metrics: metricList.map((id, i) => { try { const m = registry.metric(id); const card = i < 3 ? cardOfId(id) : null; return Object.assign({ id, name: m.name + (fieldMentioned(m) ? '〔字段 ' + m.field + '〕' : ''), unit: m.unit || '', kind: m.kind || 'simple', additivity: m.additivity || null }, card ? { card } : {}); } catch (_) { return { id }; } }),
    dimensions: dims.slice(0, limit).map(d => { const raw = String(d.id || d).replace(/^d:/, ''); let name=d.name;try{name=registry.dim(raw).name||name;}catch(_){}return { id: 'd:' + raw, name: name || raw }; }),
    time_roles: roles.map(r => ({ id: r.id, name: r.name || r.id, dataset: r.dataset || null })),
    entity_values: values,
    deps,
    recall: recalled ? { order: ['memory', 'rules', 'dict', 'vectors'], sources: recalled.sources, denied: recalled.denied, limit } : null,
  };
}

/**
 * 统一入口：原始自然语言 → 计划 → 校验 → 复用 → 本机执行 → 类型化事实 → 本地答案。
 * @param {string} question
 * @param {{registry, tables, cache?, entityLookup?, anchor?, timezone?, scope?, facts?, book?,
 *          resolve?, resolveIR?, repairIR?, callLog?, confirmedPlan?, confirmedIR?,
 *          maxCallsPerQuestion?, maxTokensPerQuestion?, entityValues?, provider?, model?}} o
 */
/**
 * 第三轮（零调用规则融合）：本机解析「干净」且题面又是最简单的一类问法时，才允许不问模型直接执行。
 * 条件（全满足才算低风险）：只有 1 个指标（simple 或已登记的 ratio，非未确认的自动指标）、没有自定义公式、
 * 没有比较 / 排名 / 筛组 / 指示 / 累计、对象 ≤1 个、没有否定、分组维度 ≤1 个，
 * 并且题面里原样写着这个指标的名字或别名（不区分大小写、不看空格）。
 * 注意：本机解析总会把注册表里的指标定义填进 plan.formula，这里只拒绝「不是注册表里原样来的」公式（derived 等）。
 */
function lowRiskLocal(question, plan, registry, signals){
  try {
    if (!plan || !registry) return false;
    const ids = plan.metric_ids || [];
    if (ids.length !== 1) return false;
    const m = registry.metric(ids[0]);
    if (!m || !(m.kind === 'simple' || m.kind === 'ratio')) return false;
    if (m.auto && !m.confirmed) return false;
    const f = plan.formula;
    if (f && !(f.kind === m.kind)) return false;
    if (!plan.comparison || plan.comparison.kind !== 'none') return false;
    if (plan.rank || plan.having || plan.indicator || plan.cumulative) return false;
    if ((plan.entities || []).length > 0 || (plan.negations || []).length) return false;   // 验收 A1 要求带对象的问法先问一次模型（存问法模板），所以这里收紧到 0 个对象
    if ((plan.dimensions || []).length > 1) return false;
    const squash = x => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, '');
    const q = squash(question);
    const names = [m.name, ...(Array.isArray(m.aliases) ? m.aliases : [])].map(squash).filter(Boolean);
    return names.some(n => q.includes(n));
  } catch (_) { return false; }
}

async function askConfig(question, o = {}){
  const registry = o.registry;
  if (!registry) throw new Error('ask 需要 registry');
  const {compactResolver}=require('./ir-ids');
  o={...o,resolveIR:compactResolver(o.resolveIR),repairIR:compactResolver(o.repairIR)};
  const ef = makeEntityFixer(question, o);
  const stash = ef ? ef.stash : null;
  if (ef) o = ef.o;
  const cache = o.cache || new ReuseCache(o.cacheStore ? { store: o.cacheStore } : undefined);
  const tables = o.tables || {};
  const book = o.facts || o.book || new FactBook();
  const callLog = makeCallLog(o.callLog);
  const seedCalls = Array.isArray(o.callLog) ? o.callLog.length : 0;
  const maxCalls = Number.isFinite(o.maxCallsPerQuestion) ? o.maxCallsPerQuestion : DEFAULT_MAX_CALLS;
  const maxTokens = Number.isFinite(o.maxTokensPerQuestion) ? o.maxTokensPerQuestion : DEFAULT_MAX_TOKENS;
  const trace = { question, schema: PLAN_SCHEMA, layers: [], route: null, notes: [] };
  const tz = o.timezone || 'Asia/Shanghai';
  const base = { status: 'error', plan: null, llm_calls: callLog.length, calls_this_turn: 0, tokens: null, zero_llm: callLog.length === 0, trace };
  const finish = (r) => {
    if (stash && r && r.status === 'ok' && stash.guesses.length) {
      const g = stash.guesses[0];
      r = Object.assign({}, r, { value_guess: { literal: g.literal, value: g.value, table: g.table, col: g.col, dim: 'd:' + g.dim } });
      if (stash.guesses.length > 1) r.value_guesses = stash.guesses.map(x => ({ literal: x.literal, value: x.value, table: x.table, col: x.col, dim: 'd:' + x.dim }));
      if (stash.guesses.some(x => x.picked)) { for (const x of stash.guesses) { try { if (x.picked && typeof o.rememberValue === 'function') o.rememberValue(String(x.literal), { table: x.table, col: x.col, value: String(x.value) }); } catch (_) {} } }
    }
    if (stash && r && r.status && r.status !== 'ok' && stash.unmatched.length) r = Object.assign({}, r, { entity_unmatched: true });
    if (r && r.status && r.status !== 'ok' && (r.answer == null || String(r.answer).trim() === '')) r = Object.assign({}, r, { missing_terms: missingTerms(question, o), answer: reasonAnswer(Object.assign({ trace }, r, { missing_terms: missingTerms(question, o), trace: (r.trace && r.trace.layers && r.trace.layers.length) ? r.trace : trace })) });
    const u = sumUsage(callLog);
    const callsThisTurn = callLog.length - seedCalls;
    return Object.assign(base, r, {
      llm_calls: callLog.length, calls_this_turn: callsThisTurn,
      zero_llm: callLog.length === 0,
      tokens: {
        input_tokens: u.input_tokens, output_tokens: u.output_tokens, reasoning_tokens: u.reasoning_tokens,
        total_tokens: u.total_tokens, calls: u.calls,
        over_budget: u.total_tokens != null && u.total_tokens > maxTokens ? true : null,
        max_tokens_per_question: maxTokens, output_max_tokens: o.outputMaxTokens || IR_OUTPUT_MAX_TOKENS,
      },
      trace,
    });
  };
  const canCall = () => callLog.length < maxCalls;
  const budgetLeft = () => {
    const u = sumUsage(callLog);
    if (u.total_tokens == null) return null;
    return maxTokens - u.total_tokens;
  };

  // ---------- A. 已确认计划的精确参数匹配（每个约束都映射才零调用）----------
  const tpl = questionTemplate(question, { registry, anchor: o.anchor, entityLookup: o.entityLookup });
  const tplCtx = { semantic: registry.stamp(), code: o.codeVersion || 'compute/1', permission: o.permissionVersion || 'perm/1' };
  const entry = cache.getEntry(question, o.scope, tplCtx);
  trace.layers.push({ layer: 'entry', hit: !!entry });
  const confirmed = o.confirmedIR || (entry && (entry.canonical_ir || entry.ir)) || (o.confirmedPlan && planToIR(o.confirmedPlan)) || null;
  if (confirmed) {
    const m = matchConfirmedPlan(question, confirmed, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, scope: o.scope, sameQuestion: !!entry && !o.confirmedIR && !o.confirmedPlan });
    if (m && m.ok) {
      const plan = m.plan;
      const v = validatePlan(plan, { registry });
      if (v.ok) {
        // 已确认计划同样要过条件词门槛：条数/占比等变了就不算「精确参数匹配」
        const unm = unmappedConditions(question, plan, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, dict: o.dict });
        // 原文精确命中：同一个问法此前已经确认过，不再用残留说法门槛卡它（残留门槛只拦「新说法」）
        const rg = reuseConditionGap(question, plan, registry);
        if (rg) trace.notes.push('reuse_recheck_rejected:' + rg);
        if (!unm.length && !rg) {
          trace.route = 'confirmed_exact';
          trace.layers.push({ layer: 'confirmed_match', hit: true });
          return runPlan({ plan, mode: 'confirmed', entry, planCached: null });
        }
        if (unm.length) trace.notes.push('confirmed_conditions_unmapped:' + unm.map(u => u.slot).join(','));
      }
      trace.notes.push('confirmed_match_invalid:' + (v.errors[0] && v.errors[0].code));
    } else if (m && m.reason) {
      trace.notes.push('confirmed_match_miss:' + m.reason);
    }
  }

  // ---------- A3（第三轮）. 问法模板复用：同一句话只换了日期 / 具体对象 → 复用模型验证过的计划，参数按新问题重绑 ----------
  // 比「骨架」更稳：骨架靠本机解析去猜题面结构，新说法常被漏掉条件（第二轮新盲测零调用 19 题对 2 题）；
  // 模板要求除日期和对象值以外的每个字都一样，换了说法就不复用、老老实实问一次模型。
  if (!entry && tpl) {
    try {
      const hit = cache.getTemplate(tpl.template, o.scope, tplCtx);
      trace.layers.push({ layer: 'template', hit: !!hit });
      if (hit && hit.canonical_ir) {
        const m = matchConfirmedPlan(question, hit.canonical_ir, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, scope: o.scope });
        let why = null;
        if (!m || !m.ok) why = 'rebind_failed:' + ((m && m.reason) || '');
        else if (tpl.nDates > 0 && !(m.signals && m.signals.period)) why = 'period_not_rebound';
        else if (JSON.stringify((hit.entity_dims || []).slice().sort()) !== JSON.stringify(tpl.entityDims.slice().sort())) why = 'entity_slots_differ';
        else {
          const want = new Set(tpl.entityValues.map(String));
          const got = (m.plan.entities || []).map(e => String(e.value));
          if (got.length !== want.size || !got.every(v => want.has(v))) why = 'entity_not_rebound';
        }
        if (!why) {
          const v = validatePlan(m.plan, { registry });
          const unm = unmappedConditions(question, m.plan, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, dict: o.dict });
          const rg3 = reuseConditionGap(question, m.plan, registry);
          if (rg3) trace.notes.push('reuse_recheck_rejected:' + rg3);
          if (v.ok && !unm.length && !rg3) {
            trace.route = 'template_exact';
            trace.layers.push({ layer: 'template_match', hit: true });
            return runPlan({ plan: m.plan, mode: 'confirmed', entry: { plan_id: hit.plan_id, canonical_ir: hit.canonical_ir }, planCached: null });
          }
          why = v.ok ? 'conditions' : 'validate:' + (v.errors[0] && v.errors[0].code);
        }
        trace.notes.push('template_rejected:' + why);
      }
    } catch (err) { trace.notes.push('template_error:' + String(err && err.message || err).slice(0, 100)); }
  }

  // ---------- A2. T8 骨架复用：改写重问（原文精确匹配必然 miss）按骨架找已确认计划 ----------
  // 键 = 指标/维度/实体维度/时间角色/比较/粒度/排名/条件类别；期间与实体值是参数，由 matchConfirmedPlan 重绑后再校验。
  // 第三轮：有模型可问时不再凭本机骨架零调用（骨架由本机解析得来，新说法下会漏条件）；没有模型通道时保留原行为。
  const modelChannel = typeof o.resolveIR === 'function' && !o.allowLocalZeroCall;
  if (!entry) {
    try {
      const skel = skeletonOf(question, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, scope: o.scope });
      if (skel) {
        const sctx = { semantic: registry.stamp(), code: o.codeVersion || 'compute/1', workspace: (o.scope && o.scope.workspace) || 'local', permission: o.permissionVersion || 'perm/1' };
        const hit = cache.getSkeleton(skel, sctx);
        trace.layers.push({ layer: 'skeleton', hit: !!hit, metric: skel.metric, dims: skel.dims });
        if (hit) {
          const m = matchConfirmedPlan(question, hit.canonical_ir || hit.ir || hit, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, scope: o.scope });
          // 题面点名了时间口径（如「按退款时间」）时，旧计划的时间角色必须对得上，否则不复用
          const sigA2 = (() => { try { return extractSignals(question, { registry, anchor: o.anchor, entityLookup: o.entityLookup }); } catch (_) { return {}; } })();
          if (m && m.ok && sigA2 && sigA2.namedTimeRole) {
            let roleName = '';
            try { const r = registry.timeRoles().find(x => x.id === m.plan.time.role); roleName = String(r && (r.name || r.id) || ''); } catch (_) {}
            if (!roleName || !roleName.includes(String(sigA2.namedTimeRole))) {
              trace.notes.push('skeleton_role_mismatch:' + String(sigA2.namedTimeRole));
              m.ok = false;
            }
          }
          if (m && m.ok) {
            const plan2 = m.plan;
            const v2 = validatePlan(plan2, { registry });
            const unm2 = unmappedConditions(question, plan2, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, dict: o.dict });
            const resid2 = safeResidual(question, plan2, registry, o.dict || dict);
            // 有模型通道时，骨架命中后的计划也得是低风险问法才允许零调用；否则照旧问一次模型
            const skelRisk = !modelChannel || lowRiskLocal(question, plan2, registry, sigA2);
            const rg2 = reuseConditionGap(question, plan2, registry);
            if (rg2) trace.notes.push('reuse_recheck_rejected:' + rg2);
            if (v2.ok && !unm2.length && !resid2.length && skelRisk && !rg2) {
              trace.route = 'skeleton_exact';
              trace.layers.push({ layer: 'skeleton_match', hit: true });
              return runPlan({ plan: plan2, mode: 'confirmed', entry: { plan_id: hit.plan_id, canonical_ir: hit.canonical_ir }, planCached: null });
            }
            trace.notes.push('skeleton_match_rejected:' + (v2.ok ? (unm2.length ? 'conditions' : (resid2.length ? 'residual' : 'not_low_risk')) : 'validate:' + v2.errors[0].code));
          } else trace.notes.push('skeleton_match_miss:' + ((m && m.reason) || 'no_match'));
        }
        // 相似例题只作为参考记录（不直接拿旧答案）；本轮相似度不参与执行
        const refs = typeof cache.similarEntries === 'function' ? cache.similarEntries(question, { metric: skel.metric, limit: 2, threshold: 0.66 }) : [];
        if (refs.length) trace.layers.push({ layer: 'examples', refs: refs.map(r => ({ sim: r.sim, q: String(r.question).slice(0, 40) })) });
      }
    } catch (err) { trace.notes.push('skeleton_error:' + String(err && err.message || err).slice(0, 100)); }
  }

  // ---------- B. 本机确定性解析；约束全覆盖 + 条件词全部落到计划节点才允许零调用 ----------
  let plan = parsePlan(question, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, scope: o.scope });
  plan = require('./plan-ir').scopeNormalize(question, plan, registry);   // 第三轮：「合计 / 全X」不按 X 分组
  const signals = plan.signals || extractSignals(question, { registry, anchor: o.anchor, entityLookup: o.entityLookup });
  const cov = coverageOf(question, plan, signals, { registry });
  // 第 4 组：条件词（占比 / 退货 / 前N / 哪一天 / 平均每 / SKU / 品类 / 相比的基期 / 加起来）没落到节点 → 不许零调用
  const unmapped = unmappedConditions(question, plan, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, dict: o.dict });
  // 零调用精度（第 1 组遗留）：题面里还有对不上计划节点的说法（周六/工作日/超过/第二高/日均/相差…）→ 不许零调用
  const residual = safeResidual(question, plan, registry, o.dict || dict);
  trace.layers.push({ layer: 'rules', unresolved: (plan.unresolved || []).map(u => u.code), coverage_missing: cov.missing.map(x => x.slot), conditions_unmapped: unmapped.map(u => u.slot), residual });
  const localClean = (plan.unresolved || []).length === 0 && cov.missing.length === 0 && cov.unrepresentable.length === 0 && unmapped.length === 0 && residual.length === 0;
  // 第三轮（又稳又省）：本机解析「看起来完整」也不直接给数——第一次见到的说法先问一次模型；
  // 模型验证过的计划按「问法模板」存下，之后同一句话换日期/对象就零调用（见 A3）。没有模型通道时保留本机直接执行。
  // 例外：最简单的问法（lowRiskLocal）本机解析干净就直接执行，0 次调用
  const lowRisk = localClean && modelChannel && lowRiskLocal(question, plan, registry, signals);
  if (localClean && modelChannel && !lowRisk) trace.notes.push('local_parse_clean_but_model_check');
  if (localClean && (!modelChannel || lowRisk)) {
    if (lowRisk) trace.notes.push('low_risk_zero_call');
    trace.route = 'rules_exact';
    return runPlan({ plan, mode: 'rules', entry, planCached: null });
  }
  if (residual.length) trace.notes.push('local_residual:' + residual.join('、'));
  if (unmapped.length) {
    trace.notes.push('conditions_unmapped:' + unmapped.map(u => u.slot).join(','));
    // 没有 IR 通道可补：明确说这些条件本地落不了，不拿宽泛结果充数
    if (typeof o.resolveIR !== 'function' && typeof o.resolve !== 'function') {
      trace.route = 'condition_unmapped';
      return finish({
        status: 'needs_clarification', code: CODES.PLAN_INCOMPLETE,
        message: '这些条件本机没有落实到计划节点：' + unmapped.map(u => u.word).join('、'),
        errors: unmapped.map(u => ({ code: CODES.PLAN_INCOMPLETE, slot: u.slot, word: u.word, message: u.message })),
        plan, route: 'condition_unmapped',
      });
    }
  }

  // 兼容层：只给了旧的单槽位 resolve（没有完整 IR 通道）时，按旧契约逐槽位选一次，
  // 每次选择都进 provider 请求日志并计入调用数；这只用于兼容既有调用方，不代替完整 IR。
  if (!o.resolveIR && typeof o.resolve === 'function' && plan.unresolved.length && canCall()) {
    let guard = 0;
    while ((plan.unresolved || []).length && canCall() && guard++ < 3) {
      const gap = plan.unresolved.find(u => u.options && u.options.length);
      if (!gap) break;
      let pick = null;
      try { pick = await o.resolve({ question, code: gap.code, options: gap.options, registry, plan }); }
      catch (err) { trace.notes.push('legacy_resolve_error:' + String(err && err.message || err).slice(0, 120)); break; }
      pushCall(callLog, { purpose: 'resolve', usage: pick && pick.usage ? pick.usage : null, provider: o.provider, model: o.model }, o.provider);
      if (!pick) break;
      const prev = plan;
      plan = applyChoice(prev, gap.code, pick, registry, o);
      if (plan.apply_choice_error) { trace.notes.push('apply_choice_error:' + plan.apply_choice_error.message); break; }
    }
    const covL = coverageOf(question, plan, signals, { registry });
    trace.layers.push({ layer: 'legacy_resolve', unresolved: (plan.unresolved || []).map(u => u.code), coverage_missing: covL.missing.map(x => x.slot) });
    if ((plan.unresolved || []).length === 0 && covL.missing.length === 0 && covL.unrepresentable.length === 0) {
      trace.route = 'legacy_resolve';
      return runPlan({ plan, mode: 'legacy_resolve', entry, planCached: null });
    }
  }

  // 用户口径不清 vs 系统表达能力不足：可表示的歧义才澄清；不可表示的条件报缺口
  if (cov.unrepresentable.length && typeof o.resolveIR !== 'function') {
    trace.route = 'capability_gap';
    return finish({ status: 'capability_gap', code: CODES.CAPABILITY_GAP, errors: cov.unrepresentable.map(x => ({ code: CODES.CAPABILITY_GAP, slot: x.slot, message: x.message })), plan, route: 'capability_gap' });
  }

  // ---------- C. 一次短结构化调用生成完整 IR（仅为可恢复错误留一次修复）----------
  // 与postIRCheck的auto_metric门槛相同：全是未确认自动指标且题面无命名候选时，
  // 任一模型选项必被拒绝。缓存/确认计划/规则快路已在上面完成，直接交原SQL兜底。
  if(o.sqlLane!==false&&typeof o.sqlRunner==='function'&&typeof o.resolveIR==='function'&&!(signals.metricCandidates||[]).length){
    const bound=[...registry.semantic.metrics.values()].filter(m=>!m.unbound);
    // P78:用户确认过的指标只有在题面点到它(名字或别名)时才可能被采用;没点到时它不改变「其余全是未确认自动指标」这个判断
    const namedHere=m=>[m.name,...(m.aliases||[])].filter(x=>x&&String(x).length>=2).some(x=>String(question).toLowerCase().includes(String(x).toLowerCase()));
    if(bound.length&&bound.some(m=>m.auto&&!m.confirmed)&&bound.every(m=>(m.auto&&!m.confirmed)||!namedHere(m))){trace.notes.push('auto_unnamed_ir_would_be_rejected');return finish({status:'capability_gap',code:CODES.CAPABILITY_GAP,plan,route:'auto_metric_requires_sql',answer:'无法回答：自动指标尚未与题面叫法对应，交给按表结构核验的计算通道。'});}
  }
  let irCall = null, ir = null, irErrors = [];
  let lastIRPayload = null;                            // 自查不过时用同一次额外调用额度把原因交回模型修
  let expandedCandidates = false, repairedOnce = false, modelRetry = false;
  let postRepairUsed = false;                          // 第三轮：校验不过的那一次修复
  let irAttempts = 0;                                  // 真实尝试次数（不依赖去重后的日志长度）
  if (typeof o.resolveIR === 'function' && canCall()) {
    for (; ;) {
      irAttempts++;
      if (irAttempts > maxCalls) break;
      // 候选检索接回现有三源（记忆 > 表头/规则叫法 > 出厂词典 > 本机向量）；权限过滤在检索之前完成。
      // 扩检那一次把上限放到 10（仍受 5–10 配置约束），用同一次额外调用额度。
      const candLimit = expandedCandidates ? MAX_CANDIDATE_LIMIT : candidateLimitOf(o);
      const recalled = await recallCandidates(question, Object.assign({}, o, {
        registry, candidateLimit: candLimit, dict: o.dict || dict,
      })).catch(err => { trace.notes.push('candidate_recall_error:' + String(err && err.message || err).slice(0, 120)); return null; });
      trace.layers.push({ layer: 'candidates', metrics: recalled ? recalled.metrics.length : 0, dims: recalled ? recalled.dimensions.length : 0, sources: recalled ? recalled.sources : null, denied: recalled ? recalled.denied : 0, expanded: expandedCandidates });
      const cands = candidateBundle(registry, question, Object.assign({}, o, { candidates: recalled, candidateLimit: candLimit, candidateMax: expandedCandidates ? 24 : (o.candidateMax || 12) }));
      const schema = buildIRSchema({ registry, candidates: cands, anchor: o.anchor, timezone: tz });
      const payload = {
        question, anchor: o.anchor || null, timezone: tz, schema, candidates: cands,
        constraints: signals, previous_errors: irErrors.length ? irErrors : null,
        max_output_tokens: IR_OUTPUT_MAX_TOKENS, thinking: false, temperature: 0,
        budget_left_tokens: budgetLeft(),
      };
      if (irCatalogOn(o)) { const cat = catalogFor(registry, o); if (cat) payload.catalog = cat; }
      lastIRPayload = payload;
      const fn = (irErrors.length || modelRetry) && typeof o.repairIR === 'function' ? o.repairIR : o.resolveIR;
      let res = null, thrown = null;
      try { res = await fn(payload); } catch (err) {
        if(['stale_request','cancelled','data_changing'].includes(err?.code))throw err;
        // 模型侧失败（请求失败 / 输出坏格式 / 只回很短一段）：计入那一次额外调用额度重问或修复一次
        thrown = err;
        trace.notes.push('ir_call_error:' + String(err && err.message || err).slice(0, 160));
        res = { ok: false, code: 'model_error', message: String(err && err.message || err), thrown: true };
      }
      if (!res || !res.ok) {
        // 抛异常时请求可能已经发生但拿不到 request_id / 用量：不凭空补一条调用记录，只按尝试次数守额度
        pushCall(callLog, Object.assign({purpose: payload && payload.previous_errors ? 'ir_repair' : 'ir'},res || {}), o.provider);   // 请求已经发生：无论成败都进调用日志/用量
        trace.notes.push('ir_call_failed:' + ((res && res.code) || 'model_error'));
        // 可恢复的模型侧失败（输出被截断、JSON 不完整、只回很短一段）允许共用额度再要一次；不是业务答错重试
        const recoverableModel = ['model_error', 'bad_format', 'model_output_short'].includes(String((res && res.code) || 'model_error'));
        if (recoverableModel && irAttempts < maxCalls && !repairedOnce) {
          repairedOnce = true; modelRetry = true;
          trace.notes.push('ir_retry_bad_output');
          trace.layers.push({ layer: 'ir_parse_repair', used: true, retry: true });
          continue;
        }
        // 仍不行：status 明确，不伪造答案
        trace.route = 'llm_ir_unavailable';
        const why = (res && res.message) || '模型没有返回可用计划';
        return finish({
          status: 'error', code: (res && res.code) || 'model_error', message: why, plan, route: 'llm_ir',
          errors: [{ code: (res && res.code) || 'model_error', message: why }],
          answer: '无法回答：模型这次没有返回可用的计划（' + why + '）。为避免编造，本次没有给出数字。',
        });
      }
      irCall = res;
      pushCall(callLog, res, o.provider);
      ir = res.ir || res.plan || null;
      {const typed=typedCandidateGap(question,ir,registry,o.sqlLane!==false&&typeof o.sqlRunner==='function');if(typed!==ir)trace.notes.push('typed_metric_candidate_gap');ir=typed;}
      ir=resolveStructuralAmbiguity(question,ir,registry);
      if (stash && stash.choice) {   // 对象有几个都像的：让用户选，不执行、不再问模型
        const ch = stash.choice;
        trace.route = 'config_value_choice';
        return finish({ status: 'needs_clarification', code: 'value_choice', route: 'config_value_choice', lane: 'config', plan,
          answer: '无法回答：尚未确认具体对象。这几个里哪个是你说的「' + ch.literal + '」？（选完直接算）',
          value_choice: { config: true, sql: null, question, dim: ch.dim, literal: ch.literal, table: ch.table, col: ch.col, options: ch.options } });
      }
      if (saysCapabilityGap(ir) && o.sqlLane !== false && typeof o.sqlRunner === 'function') {
        trace.notes.push('config_capability_gap_direct_sql');
        return finish({status:'capability_gap',code:CODES.CAPABILITY_GAP,plan,route:'llm_ir'});
      }
      let conv;
      try { conv = irToPlan(ir, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, scope: o.scope, signals }); }
      catch (err) { conv = { plan, errors: [{ code: CODES.IR_INVALID, message: '计划结构无法读取：' + String(err && err.message || err).slice(0, 120) }] }; }
      plan = require('./plan-ir').scopeNormalize(question, conv.plan, registry);
      irErrors = conv.errors || [];
      trace.layers.push({ layer: 'llm_ir', errors: irErrors.map(e => e.code), repair: !!(irErrors.length && callLog.length > 1) });
      // 候选不含答案（首次返回 none）：先做一次有界本地扩检，重新组织短候选，再解析一次；
      // 这次扩检与错误修复共用同一份额外调用额度（总共 ≤2 次），不各开一次。
      if (!irErrors.length && (!plan.metric_ids || !plan.metric_ids.length) && (!ir.metric || ir.metric === 'none') && !expandedCandidates && irAttempts < maxCalls && !(o.sqlLane !== false && typeof o.sqlRunner === 'function' && saysCapabilityGap(ir))) {
        expandedCandidates = true;
        trace.notes.push('candidate_expand_used');
        trace.layers.push({ layer: 'candidate_expand', used: true });
        continue;
      }
      if (!irErrors.length) {
        // 第三轮：结构没错，但计划没把题面条件落全（或模型在已有候选之间犹豫、说表达不了）→ 用剩下那次额度把原因交回去修一次
        const pc = postIRCheck(plan);
        const repairable = pc && irAttempts < maxCalls && !postRepairUsed && (budgetLeft() == null || budgetLeft() > 0) && isRepairablePost(pc, ir, cands) && !(pc.status === 'capability_gap' && o.sqlLane !== false && typeof o.sqlRunner === 'function');
        if (repairable) {
          postRepairUsed = true;
          // 10-24：结构缺口（按月拆 / 对比 / 占比……）也一起交回去，不只交最先撞上的那一条
          try {
            const have = new Set((pc.errors || []).map(e => e && e.slot));
            const more = unmappedConditions(question, plan, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, dict: o.dict }).filter(g => !have.has(g.slot) && !g.unrepresentable);
            if (more.length) pc.errors = (pc.errors || []).concat(more.map(g => ({ code: CODES.PLAN_INCOMPLETE, slot: g.slot, word: g.word, message: g.message })));
          } catch (_) {}
          irErrors = (pc.errors || [{ code: pc.code, message: pc.message || '' }]).slice(0, 4).map(e => ({ code: e.code || pc.code, message: e.message || pc.message || String(e.code || pc.code), slot: e.slot || null, word: e.word || null }));
          trace.notes.push('post_check_repair:' + irErrors.map(e => e.code).join(','));
          trace.layers.push({ layer: 'post_check_repair', used: true, codes: irErrors.map(e => e.code) });
          continue;
        }
        break;
      }
      // 只有「可恢复的结构/引用错误」才允许一次修复；预算不够就带着错误结束
      const recoverable = irErrors.every(e => [CODES.IR_INVALID, CODES.UNKNOWN_METRIC, CODES.UNKNOWN_DIM, CODES.AMBIGUOUS_METRIC, CODES.MISSING_TIME_ROLE, CODES.AMBIGUOUS_ENTITY, CODES.ENTITY_NOT_FOUND, 'bad_enum', 'bad_shape'].includes(e.code));
      if (!recoverable) {
        trace.route = 'capability_gap';
        return finish({ status: 'capability_gap', code: CODES.CAPABILITY_GAP, errors: irErrors, plan, route: 'llm_ir' });
      }
      if (irAttempts >= maxCalls || (budgetLeft() != null && budgetLeft() <= 0)) {
        trace.route = 'ir_unrecoverable';
        trace.notes.push('repair_budget_exhausted');
        // 两次都落不到现有指标：如果题面点了 schema 里没有的概念，按能力缺口明确拒答（不伪造答案）
        if ((!plan.metric_ids || !plan.metric_ids.length) && irErrors.some(x => x.code === CODES.UNKNOWN_METRIC)) {
          const concepts = unsupportedConcepts(question, registry);
          if (concepts.length) {
            return finish({ status: 'capability_gap', code: CODES.CAPABILITY_GAP, plan, route: 'llm_ir',
              errors: [{ code: CODES.CAPABILITY_GAP, message: '解析不到现有指标；数据里可能没有对应概念', concepts }],
              answer: renderRefusal(question, registry, { concepts }) });
          }
        }
        return finish({ status: 'needs_clarification', code: irErrors[0].code, errors: irErrors, options: irErrors[0].options || [], plan, route: 'llm_ir' });
      }
      trace.notes.push('ir_repair_used');
    }
  }

  if (!ir) {
    // 没有 IR 通道：先分清「用户没说清」与「系统表达不了」。
    const codes = (plan.unresolved || []).map(u => u.code);
    if (codes.includes(CODES.UNKNOWN_METRIC) && !plan.metric_ids.length) {
      const concepts = unsupportedConcepts(question, registry);
      trace.route = 'capability_gap';
      return finish({
        status: 'capability_gap', code: CODES.CAPABILITY_GAP, plan, route: 'capability_gap',
        errors: [{ code: CODES.CAPABILITY_GAP, message: '数据里没有能表示这个问题所需的概念', concepts }],
        answer: renderRefusal(question, registry, { concepts }),
        fallback: { used: false, reason: 'no_broad_agent_fallback_by_policy' },
      });
    }
    trace.route = 'clarify_local';
    return finish({
      status: 'needs_clarification', code: (plan.unresolved[0] && plan.unresolved[0].code) || CODES.PLAN_INCOMPLETE,
      errors: (plan.unresolved || []).map(u => ({ code: u.code, message: u.message, options: u.options })),
      options: (plan.unresolved[0] && plan.unresolved[0].options) || [], plan, route: 'clarify_local',
      fallback: { used: false, reason: 'no_broad_agent_fallback_by_policy' },
    });
  }

  // ---------- D. IR 后的最终校验：未决项/约束覆盖不允许被模型省略 ----------
  // 第三轮：校验写成函数——在调用循环里先查一遍，不过且还有额度就把原因交回模型修一次（共用那一次额外调用）
  function postIRCheck(plan){
    // 第三轮：题面有配置单根本表达不了的条件（恰好第 N 名、按星期几……）→ 不修配置单，直接按「表达不了」交给兜底
    if (o.sqlLane !== false && typeof o.sqlRunner === 'function') {
      const unrep = unmappedConditions(question, plan, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, dict: o.dict }).filter(u => u.unrepresentable);
      // 初始候选歧义时早期路由无法判断；解析落定后仍要核对题面的标量极值。
      if (scalarExtremum(question, plan) && plan.metric_ids?.length === 1) {
        try { const m=registry.metric(plan.metric_ids[0]),want=scalarExtremum(question,plan),agg=plan.formula?.kind==='simple'?plan.formula.agg:m.agg;
          if(agg!==want)unrep.push({slot:'extremum_aggregation',word:'标量极值',message:'题面要求'+want+'，已选指标聚合为'+agg+'；不能把平均或合计当极值，交给只读SQL',unrepresentable:true});
        } catch (_) {}
      }
      {const f=plan.formula;if(f?.kind==='ratio'&&f.num===f.den&&!f.num_window&&!f.den_window&&!f.num_filter&&!f.den_filter&&!f.den_expr&&['same',undefined].includes(f.num_period)&&['same',undefined].includes(f.den_period)&&(!plan.comparison||plan.comparison.kind==='none')&&/相当于|多少倍|比值|之比|[÷/]/.test(String(question))&&!/各自|分别|各占/.test(String(question))){let matches=[];try{matches=o.entityLookup?.resolve(String(question))?.matches||[];}catch(_){}const groups=new Map();for(const x of matches)if(['exact','contains'].includes(x.how)&&String(question).includes(String(x.value))){const key=String(x.dim);if(!groups.has(key))groups.set(key,new Set());groups.get(key).add(String(x.value));}if([...groups.values()].some(xs=>xs.size>1))unrep.push({slot:'member_ratio_operands',word:'成员分别作分子和分母',message:'同一指标的不同成员比值不能用共享全局对象筛选后的自身相除表示，交给只读SQL分别取成员',unrepresentable:true});}}

      // 修复 IR 不能悄悄丢掉题面中分子、分母各自明确的期间。
      if (plan.formula?.kind === 'ratio' && (!plan.comparison || plan.comparison.kind === 'none')) {
        const {periodMentions,parsePeriod,shiftPeriod}=require('./plan-ir');
        const key = p => p?.start && p?.end ? p.start.slice(0,10)+'/'+p.end.slice(0,10) : null;
        const requested = new Set(periodMentions(question).filter(x=>/^\d{4}/.test(x.text)).map(x=>{try{return key(parsePeriod(x.text,o.anchor,{timezone:tz}));}catch(_){return null;}}).filter(Boolean));
        if (requested.size > 1) {
          const f=plan.formula, base=plan.time;
          const branch = side => {
            if (f[side+'_window']) return key(f[side+'_window']);
            const kind=f[side+'_period'];
            if(kind==='period_start')return key({start:base.start,end:base.start});
            if(kind==='period_end')return key({start:base.end,end:base.end});
            if(kind==='previous_period'){try{return key(shiftPeriod(base,kind));}catch(_){return null;}}
            return key(base);
          };
          const actual=new Set([branch('num'),branch('den')]);
          if([...requested].some(p=>!actual.has(p)))unrep.push({slot:'formula_periods',word:'分子分母各自的期间',message:'比率计划没有保留题面明确要求的不同期间，交给只读SQL分别取数',unrepresentable:true});
        }
      }

      // 10-23：计划用的是导入时自动起名的指标，但题面里的说法对不上它的名字 / 叫法（问「保费」，手上只有「保单金额」）→ 别硬套，交给兜底按表关系算
      try {
        const autoMs = (plan.metric_ids || []).map(id => { try { return registry.metric(id); } catch (_) { return null; } }).filter(m => m && m.auto && !m.confirmed);
        const named = new Set((signals.metricCandidates || []).map(x => String(x).replace(/^m:/, '')));
        const miss = autoMs.filter(m => !named.has(String(m.id)));
        // 题面点了某个「子类型标记表」的中文名（如「保费」），而计划直接在它所属的大表上算（没按这一类筛）→ 交给兜底连过去筛
        for (const p of (registry.packDefs || [])) for (const st of ((p && p._meta && p._meta.subtypes) || [])) {
          if (!st.zh || String(st.zh).length < 2 || !String(question).includes(st.zh)) continue;
          const onParent = (plan.metric_ids || []).some(id => { try { return registry.leaves(id).some(l => { const mm = registry.metric(l); return (mm.dataset || mm.boundTo) === st.of; }); } catch (_) { return false; } });
          if (onParent) unrep.push({ slot: 'subtype', word: st.zh, message: '题面问的是「' + st.zh + '」（' + st.table + ' 标出的那一类），计划没按这一类筛，交给兜底', unrepresentable: true });
        }
        // P78:比率的分子分母来自两张不同的表、且计划的时间口径只属于其中一张(如实际用销售日期、计划用文本月份)→ 配置单对不齐期间与筛选,交给只读SQL分别取数
        try {
          const f = plan.formula || {};
          if (f.kind === 'ratio' && f.num && f.den) {
            const dsOf = ref => { try { return registry.leaves(String(ref)).map(l => { const mm = registry.metric(l); return mm.dataset || mm.boundTo; }); } catch (_) { try { const mm = registry.metric(String(ref)); return [mm.dataset || mm.boundTo]; } catch (__) { return []; } } };
            const a1 = new Set(dsOf(f.num)), b1 = new Set(dsOf(f.den));
            const disjoint = a1.size && b1.size && [...a1].every(x => !b1.has(x));
            const roleDs = plan.time && plan.time.role ? (registry.timeRoles().find(r => r.id === plan.time.role) || {}).dataset : null;
            const timed = new Set(registry.timeRoles().filter(r => !/varchar|text/i.test(String(r.type || ''))).map(r => r.dataset));
            const sideUntimed = [...a1].some(x => !timed.has(x)) || [...b1].some(x => !timed.has(x)) || (roleDs && (!a1.has(roleDs) || !b1.has(roleDs)) && ![...a1, ...b1].every(x => registry.timeRoles().some(r => r.dataset === x && r.dim === (registry.timeRoles().find(z => z.id === plan.time.role) || {}).dim)));
            if (disjoint && plan.time && plan.time.start && sideUntimed && !f.den_window && !f.num_window) unrep.push({ slot: 'cross_table_ratio', word: '分子分母不在同一张表', message: '比率的分子分母在两张表上，期间和筛选要分别落到各自的表，交给只读SQL', unrepresentable: true });
          }
        } catch (_) {}
        // P78:用户确认的口径只背书题面点到它的问题;题面没点到却被选中 → 不采用,交给兜底按表结构核验
        const confirmedUnnamed = (plan.metric_ids || []).map(id => { try { return registry.metric(id); } catch (_) { return null; } })
          .filter(m => m && m.confirmed === true && m.auto === false && ![m.name, ...(m.aliases || [])].filter(x => x && String(x).length >= 2).some(x => String(question).toLowerCase().includes(String(x).toLowerCase())));
        if (confirmedUnnamed.length) unrep.push({ slot: 'confirmed_metric_unnamed', word: confirmedUnnamed.map(m => m.name).join('、'), message: '题面没有提到已确认口径「' + confirmedUnnamed.map(m => m.name).join('、') + '」，不套用', unrepresentable: true });
        if (autoMs.length && miss.length) unrep.push({ slot: 'auto_metric', word: miss.map(m => m.name).join('、'), message: '自动起名的指标和题面说法对不上（' + miss.map(m => m.name).join('、') + '），交给兜底按表关系算', unrepresentable: true });
      } catch (_) {}
      if (unrep.length) {
        trace.route = 'capability_gap';
        return ({ status: 'capability_gap', code: CODES.CAPABILITY_GAP, plan, route: 'llm_ir', message: '这些条件配置单表达不了：' + unrep.map(u => u.word).join('、'),
          ...(unrep.find(u => u.answer) ? { answer: unrep.find(u => u.answer).answer } : {}),
          errors: unrep.map(u => ({ code: CODES.CAPABILITY_GAP, slot: u.slot, word: u.word, message: u.message })) });
      }
    }
    const v = validatePlan(plan, { registry });
    const cov2 = coverageOf(question, plan, signals, { mode: 'ir', registry });
    trace.layers.push({ layer: 'validate_ir', ok: v.ok, errors: v.errors.map(e => e.code), coverage_missing: cov2.missing.map(x => x.slot) });
    if ((!plan.metric_ids || !plan.metric_ids.length) && (plan.unresolved || []).some(u => u.code === CODES.UNKNOWN_METRIC || u.code === CODES.AMBIGUOUS_METRIC)) {
      const concepts = unsupportedConcepts(question, registry);
      trace.route = 'capability_gap';
      return ({
        status: 'capability_gap', code: CODES.CAPABILITY_GAP, plan, route: 'llm_ir',
        errors: [{ code: CODES.CAPABILITY_GAP, message: '数据里没有能表示这个问题所需的概念', concepts }],
        answer: renderRefusal(question, registry, { concepts }),
      });
    }
    if (!plan.metric_ids.length && !canCall() && ((plan.unresolved || []).length || true)) {
      const concepts = unsupportedConcepts(question, registry);
      if (concepts.length) {
        trace.route = 'capability_gap';
        return ({ status: 'capability_gap', code: CODES.CAPABILITY_GAP, plan, route: 'llm_ir',
          errors: [{ code: CODES.CAPABILITY_GAP, message: '两次解析都没能落到现有指标；数据里可能没有对应概念', concepts }],
          answer: renderRefusal(question, registry, { concepts }) });
      }
    }
    if ((plan.unresolved || []).some(u => u.code === CODES.CAPABILITY_GAP)) {
      const concepts = unsupportedConcepts(question, registry);
      trace.route = 'capability_gap';
      return ({
        status: 'capability_gap', code: CODES.CAPABILITY_GAP, plan, route: 'llm_ir',
        errors: plan.unresolved.filter(u => u.code === CODES.CAPABILITY_GAP).map(u => ({ code: CODES.CAPABILITY_GAP, slot: u.slot || null, message: u.message })),
        answer: renderRefusal(question, registry, { concepts }),
      });
    }
    if (plan.unresolved && plan.unresolved.length) {
      const u = plan.unresolved[0];
      trace.route = 'clarify_ir';
      return ({ status: 'needs_clarification', code: u.code, errors: plan.unresolved.map(x => ({ code: x.code, message: x.message, options: x.options })), options: u.options || [], plan, route: 'llm_ir' });
    }
    if (!v.ok) {
      const code = v.errors[0].code;
      const needsClarify = [CODES.AMBIGUOUS_METRIC, CODES.MISSING_TIME_ROLE, CODES.AMBIGUOUS_ENTITY, 'ambiguous_dim'].includes(code);
      return ({ status: needsClarify ? 'needs_clarification' : 'error', code, errors: v.errors, options: (v.errors[0] && v.errors[0].options) || [], plan, route: 'llm_ir' });
    }
    if (cov2.unrepresentable.length) {
      return ({ status: 'capability_gap', code: CODES.CAPABILITY_GAP, errors: cov2.unrepresentable, plan, route: 'llm_ir' });
    }
    if (cov2.missing.length) {
      // 明确提到但计划里没有节点：不静默执行不完整计划
      const slot = cov2.missing[0];
      trace.route = 'constraint_unmapped';
      return ({ status: 'needs_clarification', code: CODES.PLAN_INCOMPLETE, message: `条件「${slot.slot}」没有落实到计划节点`, errors: cov2.missing.map(x => ({ code: CODES.PLAN_INCOMPLETE, slot: x.slot, message: x.message })), plan, route: 'llm_ir' });
    }
    // 条件词（占比/退货/前N/哪一天/平均每/SKU/品类/基期/合计）模型也没落到节点：不执行不完整计划
    const unmappedIr = unmappedConditions(question, plan, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, dict: o.dict });
    trace.layers.push({ layer: 'conditions_ir', unmapped: unmappedIr.map(u => u.slot) });
    if (unmappedIr.length && unmappedIr.some(u => u.unrepresentable)) {
      trace.route = 'capability_gap';
      return ({ status: 'capability_gap', code: CODES.CAPABILITY_GAP, plan, route: 'llm_ir',
        message: '这些条件配置单表达不了：' + unmappedIr.filter(u => u.unrepresentable).map(u => u.word).join('、'),
        ...(unmappedIr.find(u => u.answer) ? { answer: unmappedIr.find(u => u.answer).answer } : {}),
        errors: unmappedIr.map(u => ({ code: u.unrepresentable ? CODES.CAPABILITY_GAP : CODES.PLAN_INCOMPLETE, slot: u.slot, word: u.word, message: u.message })) });
    }
    if (unmappedIr.length) {
      trace.route = 'constraint_unmapped';
      return ({
        status: 'needs_clarification', code: CODES.PLAN_INCOMPLETE,
        message: '这些条件没有落实到计划节点：' + unmappedIr.map(u => u.word).join('、'),
        errors: unmappedIr.map(u => ({ code: CODES.PLAN_INCOMPLETE, slot: u.slot, word: u.word, message: u.message })),
        plan, route: 'llm_ir',
      });
    }
    return null;
  }
  { const pc = postIRCheck(plan); if (pc) return finish(pc); }
  trace.route = 'llm_ir';
  return runPlan({ plan, mode: 'llm_ir', entry, planCached: null });

  // ---------- 执行 + 复用 + 本地渲染 ----------
  async function runPlan({ plan: plannedIn, mode, entry: entryHit, planCached }){
    require('./request-context').assertCurrent(o);
    // 确认/缓存快路可早于外层signals初始化；仅枚举分组检查在执行作用域本地读取信号。
    const executionSignals=plannedIn?.dimensions?.length===1&&/、/.test(String(question))&&/各|分别/.test(String(question))?extractSignals(question,{registry,anchor:o.anchor,timezone:tz,entityLookup:o.entityLookup}):null;
    // 确认/模板计划的权限范围只能来自本次可信请求，不能沿用旧默认或客户端计划。
    let planned = normalizePlan(Object.assign({}, plannedIn, { permission_scope: Object.assign({workspace:'local',datasets:null}, o.scope || plannedIn.permission_scope || {}) }));
    // 第三轮：「当前 / 目前 / 现在 / 最新」问快照类指标（库存）= 截至今天每个对象最近一次快照，不是「今天这一天恰好有快照」
    if (/当前|目前|现在|最新|截至目前/.test(String(question || '')) && planned && planned.time && planned.time.start) {
      planned = Object.assign({}, planned, { time: Object.assign({}, planned.time, { as_of: true }) });
    }
    const routeLabel = mode === 'rules' ? 'rules_exact' : mode === 'confirmed' ? 'confirmed_exact' : mode;
    const valid = validatePlan(planned, { registry });
    if (!valid.ok) {
      return finish({ status: 'needs_clarification', code: valid.errors[0].code, errors: valid.errors, options: valid.errors[0].options || [], plan: planned, route: routeLabel });
    }
    const ctx = {
      dataStamp: o.dataStamp || null, semanticStamp: registry.stamp(), permissionVersion: o.permissionVersion,
      datasetStamps: o.datasetStamps || null, codeVersion: o.codeVersion, schemaStamp: o.schemaStamp, executorVersion: o.executorVersion,
      timezone: planned.time && planned.time.timezone, anchor: planned.time && planned.time.anchor, intervalSchema: planned.time && planned.time.schema_version,
    };
    if (o.datasetStamps) {
      try {
        const deps=new Set();
        const addMetric=id=>{try{for(const leaf of registry.leaves(id)){const m=registry.metric(leaf);deps.add(m.dataset||m.boundTo);}}catch(_){}};
        const addDim=id=>{try{const d=registry.dim(id);deps.add(d.source?.table||d.dataset);}catch(_){}};
        // 公式、筛选、分区和时间角色都属于真实计算依赖；不能只看显示维度。
        const visit=v=>{if(Array.isArray(v))return v.forEach(visit);if(v&&typeof v==='object')return Object.values(v).forEach(visit);if(typeof v==='string'){if(v.startsWith('m:'))addMetric(v);if(v.startsWith('d:'))addDim(v);if(v.startsWith('t:')){const r=registry.timeRoles().find(x=>x.id===v);if(r)deps.add(r.dataset);}}};
        visit(planned);for(const id of planned.metric_ids||[])addMetric(id);
        for(const id of [...planned.dimensions||[],...(planned.entities||[]).map(e=>e.dim),...(planned.negations||[]).map(e=>e.dim)])addDim(id);
        // 关系组件内的桥表与角色表保守保留，防止漏掉连接中间表的数据变化。
        let expanded=true;while(expanded){expanded=false;for(const r of registry.semantic.rels.values())if(!r.unbound&&(deps.has(r.left)||deps.has(r.right))){if(!deps.has(r.left)||!deps.has(r.right))expanded=true;deps.add(r.left);deps.add(r.right);}}
        const selected=Object.fromEntries([...deps].filter(Boolean).sort().map(ds=>[ds,o.datasetStamps[ds]??o.datasetStamps[registry.tables.find(t=>t.name===ds)?.id]??o.datasetStamps[ds.replace(/^v_/,'')]]));
        if(Object.keys(selected).length && Object.values(selected).every(v=>v!=null)){ctx.datasetStamps=selected;ctx.dataStamp=require('./request-context').fingerprint(selected);}
      } catch (_) {}
    }
    const cachedPlan = cache.getPlan(planned);
    const cached = cache.getResult(planned, ctx);
    trace.layers.push({ layer: 'plan', hit: !!cachedPlan });
    trace.layers.push({ layer: 'result', hit: !!cached });
    if (cached && !selfCheck(planned,cached,{registry,question,signals:executionSignals}).some(x=>x.code==='group_member_subset')) {
      trace.route = mode + '+result_cache';
      trace.outcome = 'ok';
      return finish({
        status: 'ok', answer: cached.answer, facts: cached.facts, rows: cached.rows || [], plan: planned,
        result_status: cached.result_status || 'ok',
        reuse: { entry_hit: !!entryHit, plan_hit: !!cachedPlan, result_hit: true, cached_at: cached.at, cached_data: cached.data_stamp },
        route: routeLabel, trace: Object.assign(trace, { outcome: 'ok', executor: 'cache' }),
      });
    }
    // 正式 App / 评测同一条数据路径：给了 executor 就必须用它（worker/DuckDB），不再用内存行；
    // 只有单元测试（不给 executor）才退回 plan-ir.executePlan 的内存夹具。
    let r = o.executor ? await executeViaExecutor(planned, o, book) : executePlan(planned, { registry, tables, facts: book, book });
    if (!r.ok) {
      return finish({ status: 'error', code: r.errors[0].code, errors: r.errors, plan: planned, route: routeLabel, reuse: { entry_hit: !!entryHit, plan_hit: !!cachedPlan, result_hit: false } });
    }
    // ---------- T6 本机自查：分项/占比合计、期间对齐、单位一致、非空、排名行数 ----------
    // 不过：把原因交给模型修一次（共用那一次额外调用额度）；仍不过就明确说「自查没过，不给数」，绝不把可疑数字当答案。
    {
      let issues = selfCheck(planned, r, { registry, question, signals:executionSignals });
      trace.layers.push({ layer: 'self_check', ok: issues.length === 0, issues: issues.map(i => i.code) });
      if (issues.length && o.resolveIR && canCall() && lastIRPayload) {
        try {
          trace.notes.push('self_check_repair:' + issues.map(i => i.code).join(','));
          const rep = await o.resolveIR(Object.assign({}, lastIRPayload, { previous_errors: issues.map(i => ({ code: i.code, message: ({share_sum:'分组占比合计不满足完整总体约束',share_range:'占比超出定义范围',period_mismatch:'结果期间与计划期间不一致',unit_mismatch:'结果单位与计划单位不一致',empty_result:'成功状态下没有可用结果',rank_overflow:'排名结果行数超出请求范围'})[i.code] || '本机结果结构检查未通过' })) }));
          pushCall(callLog,Object.assign({purpose:'ir_repair'},rep||{}),o.provider);
          if (rep && rep.ok) {
            const conv2 = irToPlan(rep.ir || rep.plan, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, scope: o.scope, signals });
            const v2 = validatePlan(conv2.plan, { registry });
            if (v2.ok) {
              const r2 = o.executor ? await executeViaExecutor(conv2.plan, o, book) : executePlan(conv2.plan, { registry, tables, facts: book, book });
              if (r2.ok) {
                const issues2 = selfCheck(conv2.plan, r2, { registry, question, signals:executionSignals });
                trace.layers.push({ layer: 'self_check_repair', ok: issues2.length === 0, issues: issues2.map(i => i.code) });
                if (!issues2.length) { planned = conv2.plan; r = r2; issues = []; }
              }
            }
          }
        } catch (err) { if(['stale_request','cancelled','data_changing'].includes(err?.code))throw err;pushCall(callLog,{purpose:'ir_repair',usage:null,thrown:true},o.provider);trace.notes.push('self_check_repair_error:' + String(err && err.message || err).slice(0, 120)); }
      }
      if (issues.length) {
        return finish({
          status: 'error', code: 'self_check_failed', errors: issues, plan: planned, route: routeLabel,
          answer: '无法回答：本机自查没过（' + issues.map(i => i.message.replace(/^自查：/, '')).join('；') + '），为避免给错数字，本次没有给出结果。',
          reuse: { entry_hit: !!entryHit, plan_hit: !!cachedPlan, result_hit: false },
        });
      }
    }
    // 第三轮 T4：题面问「变化了多少 / 差多少 / 几个百分点」且计划带对比（差值输出）→ 答案给差值（本期 − 基期），不是只给当期值
    r = withComparisonDelta(question, planned, r, book, registry);
    // 产品答案 = 可读正文（保留事实编号，兼容既有行为）+ 规范化 ANSWER 行（grader/导出消费 ANSWER 行）
    const body = renderAnswer(planned, r, registry);
    let answer = body;
    try {
      { const ad = askedDecimals(question); if (ad != null) planned = Object.assign({}, planned, { decimals: ad }); }
      const line = answerLine(planned, { facts: r.facts, rows: r.rows, result_status: r.result_status, comparison: r.comparison }, { registry }).answer_line;
      answer = body ? body + '\n' + line : line;
      // 10-24：没数据时正文另起一行说清期间和数据实际覆盖到哪（ANSWER 行里不放数字）
      if (r.result_status === 'no_data' && typeof o.sqlRunner === 'function') {
        const rg = await dataRangeFor(planned, registry, o.sqlRunner).catch(() => null);
        const detail = rg ? require('./answer-format').noDataDetail(planned, rg) : null;
        if (detail) answer = answer.replace(/\nANSWER:/, '\n' + detail + '\nANSWER:').replace(/^ANSWER:/, detail + '\nANSWER:');
      }
    } catch (_) { /* 格式模块失败不阻断正文 */ }
    const calculationNotes=[];
    if(planned.formula?.kind==='simple'&&planned.formula.agg==='avg'&&r.result_status!=='no_data')calculationNotes.push('按匹配数据行简单平均');
    if(planned.time?.policy==='prev_week')calculationNotes.push('自然周按周一至周日');
    if(calculationNotes.length)answer=answer.replace(/(ANSWER:[^\n]*?)(（[^\n]*）)?\s*$/,(m,a,b)=>a+(b?b.replace(/）$/,'；'+calculationNotes.join('；')+'）'):'（'+calculationNotes.join('；')+'）'));
    // 10-23：用到了导入时自动起名、还没确认的字段 → 答案标「待确认」（中文名只用来听懂和回答，计算用原字段）
    const autoUsed = require('./auto-semantics').autoUsedInPlan(planned, registry);
    let autoTier = null;
    if (autoUsed.length) {
      autoTier = 'pending';
      const note = '字段名是导入时自动认的（' + autoUsed.join('；') + '），待你确认';
      r = Object.assign({}, r, { facts: (r.facts || []).map(f => Object.assign({}, f, { tier: f.tier || 'pending' })) });
      answer = answer.replace(/(ANSWER:[^\n]*?)(（[^\n]*）)?\s*$/, (m, a, b) => a + (b ? b.replace(/）$/, '；' + note.replace(/[0-9]+/g, '') + '）') : '（' + note.replace(/[0-9]+/g, '') + '）'));
      answer = answer.replace(/\nANSWER:/, '\n' + note + '\nANSWER:');
    }
    // 入口候选保存可执行规范结构 + 绑定要求，不只 plan_id（§7）
    require('./request-context').assertCurrent(o);
    const irCanon = planToIR(planned);
    cache.putEntry(question, { plan_id: planned.id, canonical_ir: irCanon, bindings: { time_role: planned.time && planned.time.role, metric_ids: planned.metric_ids, dims: planned.dimensions, formula: planned.formula, unit: planned.unit }, plan_hash: planHash(planned) }, o.scope, tplCtx);
    // 第三轮：只有模型验证过、执行和自查都通过的计划才存成问法模板
    if (mode === 'llm_ir' && tpl && (r.result_status || 'ok') === 'ok') {
      try { cache.putTemplate(tpl.template, { plan_id: planned.id, canonical_ir: irCanon, entity_dims: (planned.entities || []).map(e => String(e.dim)), n_dates: tpl.nDates }, o.scope, tplCtx); } catch (_) {}
    }
    cache.putPlan(planned, { plan_id: planned.id, canonical_ir: irCanon, bindings: { time_role: planned.time && planned.time.role, metric_ids: planned.metric_ids } });
    // T8：已验证计划进「骨架/例题」库（结果为 ok 才存；口径/代码/工作区/权限版本变化自动作废）
    try {
      if ((r.result_status || 'ok') === 'ok') {
        const skel = skeletonOf(question, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, scope: o.scope });
        if (skel) {
          cache.putSkeleton(skel, { plan_id: planned.id, canonical_ir: irCanon, bindings: { time_role: planned.time && planned.time.role, metric_ids: planned.metric_ids, dims: planned.dimensions, formula: planned.formula, unit: planned.unit } }, {
            question, semantic: registry.stamp(), code: o.codeVersion || 'compute/1',
            workspace: (o.scope && o.scope.workspace) || 'local', permission: o.permissionVersion || 'perm/1',
          });
          trace.layers.push({ layer: 'skeleton_put', metric: skel.metric });
        }
      }
    } catch (_) { /* 骨架入库失败不影响本次答案 */ }
    if (stash && stash.guesses.length) answer = appendGuessNote(answer, guessNoteOf(stash.guesses));
    cache.putResult(planned, ctx, { answer, facts: r.facts, rows: r.rows || [], at: new Date().toISOString(), data_stamp: ctx.dataStamp, result_status: r.result_status || 'ok' });
    trace.layers.push({ layer: 'execute', hit: false });
    return finish({
      status: 'ok', answer, facts: r.facts, rows: r.rows || [], comparison: r.comparison, plan: planned,
      ...(autoTier ? { tier: autoTier, tier_why: { auto_names: autoUsed } } : {}),
      result_status: r.result_status || 'ok', ir: irCanon, route: routeLabel,
      reuse: { entry_hit: !!entryHit, plan_hit: !!cachedPlan, result_hit: false },
      trace: Object.assign(trace, { outcome: 'ok', executor: 'local', snapshot: r.trace.snapshot, time_role: r.trace.time_role, time_applied: r.trace.time_applied, time_semantics: r.trace.time_semantics, plan_id: r.plan_id }),
    });
  }
}

/**
 * 第三轮：问法模板——把日期和本机认出的具体对象（渠道、品类、SKU 等维度值）换成占位符，其余每个字原样保留。
 * 只换「参数」，不换「条件」：数字门槛（低于 40 万）、前 N 名等都留在模板里，换了就是另一句话。
 */
function questionTemplate(question, o){
  try {
    let t = String(question || '');
    let nDates = 0;
    const DATE_RES = [
      /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, /\d{4}-\d{1,2}-\d{1,2}/g, /\d{4}\s*年\s*\d{1,2}\s*月/g, /\d{4}-\d{1,2}/g,
      /\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, /\d{4}\s*年\s*第?[一二三四1-4]\s*季度/g,
    ];
    for (const re of DATE_RES) t = t.replace(re, () => { nDates++; return '〈D〉'; });
    const sig = extractSignals(question, { registry: o.registry, anchor: o.anchor, entityLookup: o.entityLookup }) || {};
    const ents = (sig.entities || []).filter(e => e && e.value != null && e.dim);
    const entityDims = [], entityValues = [];
    for (const e of ents.slice().sort((a, b) => String(b.value).length - String(a.value).length)) {
      const v = String(e.value);
      if (!v || !t.includes(v)) continue;
      t = t.split(v).join('〈E:' + String(e.dim).replace(/^d:/, '') + '〉');
      entityDims.push('d:' + String(e.dim).replace(/^d:/, '')); entityValues.push(v);
    }
    t = t.toLowerCase().replace(/[\s，,。？?！!、；;：:"'「」『』]/g, '');
    if (t.length < 4) return null;
    return { template: t, nDates, entityDims, entityValues };
  } catch (_) { return null; }
}

/**
 * 第三轮：校验不过时值不值得交回模型修一次。
 * 条件没落全 / 计划结构不成立 → 值得；模型说「表达不了」→ 只有它其实在已有候选之间犹豫（选项里写的是候选 id）才值得，
 * 真缺概念（广告费、毛利、仓库……）不再花第二次调用。
 */
function isRepairablePost(pc, ir, cands){
  if (!pc) return false;
  if (pc.status === 'needs_clarification' || pc.status === 'error') return true;
  if (pc.status === 'capability_gap') {
    const ids = new Set([...((cands && cands.metrics) || []).map(m => String(m.id)), ...((cands && cands.dimensions) || []).map(d => String(d.id))]);
    const opts = ((ir && ir.unresolved) || []).flatMap(u => Array.isArray(u.options) ? u.options : []).map(String);
    return opts.some(x => ids.has(x) || ids.has('m:' + x.replace(/^m:/, '')) || ids.has('d:' + x.replace(/^d:/, '')));
  }
  return false;
}

/** 10-24：不顶替——题面点到出厂词典里的指标类概念（目标 / 成本 / 毛利……），这份数据里一个对得上的字段都没有（missingTerms），
 *  而计划用的指标名字 / 叫法里也不含它（含词典里它的同义说法也算含）→ 说明配置单拿别的指标顶上了，不出数。 */
function substitutedConcepts(question, plan, o){
  try {
    const reg = o && o.registry;
    if (!reg || !plan || !(plan.metric_ids || []).length) return [];
    const miss = missingTerms(question, o);
    if (!miss.length) return [];
    const d = (o && o.dict) || dict;
    const low = x => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, '');
    let text = '';
    for (const id of plan.metric_ids) {
      const m = reg.metric(id); text += ' ' + [m.id, m.name, ...(m.aliases || [])].join(' ');
      try { for (const l of reg.leaves(id)) { const lm = reg.metric(l); text += ' ' + [lm.id, lm.name, ...(lm.aliases || [])].join(' '); } } catch (_) {}
    }
    text = low(text);
    const entVals = (plan.entities || []).map(e => String(e && e.value));
    // P79:「the Amazon purchase-spend table」「采购支出表」里的词是在点名哪张表,不是要算的指标概念
    const tableSpans = [...String(question || '').matchAll(/\b([A-Za-z][\w\s-]{0,40}?)\s+(?:table|dataset|data set|sheet)\b/gi)].map(m => low(m[1])).concat([...String(question || '').matchAll(/([\u4e00-\u9fff]{2,10})(?:表|数据集)/g)].map(m => low(m[1])));
    const out = [];
    for (const term of miss) {
      if (tableSpans.some(sp => sp.includes(low(term)))) continue;
      const ents = d.termsIn(term).flatMap(x => x.ids || []).map(id => d.byId.get(id)).filter(Boolean);
      if (!ents.length || !ents.some(e => e.agg && e.agg !== 'none')) continue;      // 只管指标类概念
      const names = [term, ...ents.flatMap(e => [e.zh, e.en, ...(e.abbr || []), ...(e.alias || [])])].map(low).filter(x => x.length >= 2);
      if (names.some(n => text.includes(n))) continue;
      if (entVals.some(v => v.includes(term))) continue;
      out.push(term);
    }
    return out;
  } catch (_) { return []; }
}

/** 条件缺口 = 原有的条件词核对 + 结构核对 + 不顶替；同一个 slot 只报一次（占比 / 哪一天原来就有，不重复报） */
function unmappedConditions(question, plan, opts = {}){
  const base = unmappedConditionsBase(question, plan, opts);
  const seen = new Set(base.map(x => x.slot));
  const out = base.slice();
  const add = g => { if (g && !seen.has(g.slot)) { seen.add(g.slot); out.push(g); } };
  try {
    for (const g of structureGaps(question, plan, opts)) { if (g.slot === 'grain_day' && seen.has('day')) continue; add(g); }
  } catch (_) {}
  try {
    const sub = substitutedConcepts(question, plan, opts);
    if (sub.length) add({ slot: 'substitute', word: sub.join('、'), unrepresentable: true,
      message: '话里的「' + sub.join('」「') + '」在这份数据里没有对应的字段，计划拿别的指标顶上了，不能给数',
      answer: '无法回答：数据里没有「' + sub.join('」「') + '」对应的字段（计划里用的是别的指标，不能顶替）。为避免给错数字，本次没有给出结果。' });
  } catch (_) {}
  return out;
}

/** 10-24：话里点到的出厂词典里的说法（毛利率、进货成本、访客……），在这份数据的指标 / 维度里一个都对不上的，列出来（本机比对，不调模型） */
function missingTerms(question, o){
  try {
    const d = (o && o.dict) || dict; const reg = o && o.registry;
    if (!d || typeof d.termsIn !== 'function' || !reg || !reg.semantic) return [];
    const norm = x => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, '');
    const have = [];
    for (const m of reg.semantic.metrics.values()) if (!m.unbound) have.push(m.name, m.id, m.field, ...(m.aliases || []));
    for (const x of reg.semantic.dims.values()) if (!x.unbound) have.push(x.name, x.id, ...(x.aliases || []), ...(x.match || []));
    for(const t of reg.tables||[])for(const c of t.columns||[])have.push(c.name);
    const H = have.map(norm).filter(Boolean);
    const knownIds=new Set();for(const h of have.filter(Boolean)){try{for(const e of d.identify(String(h).replace(/^.*[·:：]/,'')).entries||[])knownIds.add(e.id);}catch(_){}}
    const out = [];
    for (const t of d.termsIn(String(question || ''))) {
      const k = norm(t.term); if (k.length < 2) continue;
      if (H.some(h => h.includes(k) || k.includes(h) && h.length >= 2)) continue;
      if((t.ids||[]).some(id=>knownIds.has(id)))continue;
      if (!out.includes(t.term)) out.push(t.term);
    }
    return out.slice(0, 4);
  } catch (_) { return []; }
}

/** 第三轮：不给数时也必须说清为什么（不再出现空答案）；只用错误里的原因，不编 */
function reasonAnswer(r){
  const errs = Array.isArray(r.errors) ? r.errors : [];
  const msgs = [...new Set(errs.map(e => String(e && e.message || '').replace(/^自查：/, '').trim()).filter(Boolean))].slice(0, 3);
  let why = msgs.length ? msgs.join('；') : (r.message ? String(r.message) : (CODE_TEXT && CODE_TEXT[r.code]) || String(r.code || '没有可用的计划'));
  // 10-24：说清是话里哪个说法在数据里找不到（本机比对剩下没落到任何字段的词），用户才知道是「没有这个数据」还是「要换个说法」
  if (r.status === 'needs_clarification' || r.status === 'capability_gap') {
    try {
      const layers = (r.trace && r.trace.layers) || [];
      const res = [...new Set(layers.filter(l => l && l.layer === 'rules').flatMap(l => l.residual || []).map(x => String(x).trim()))]
        .filter(x => x.length >= 2 && x.length <= 12 && !/^[\d\s\-~～.,，、:：()（）%]+$/.test(x)).slice(0, 4);
      // 计划里已经用到的词（比如 diff 的左右成员「独立站」）不算「没对上」
      const used = JSON.stringify(r.plan || {});
      const all = [...new Set([...(r.missing_terms || []), ...res])].filter(x => !used.includes(x)).slice(0, 4);
      if (all.length) why += '（话里的「' + all.join('」「') + '」在现有数据里没有对上的字段）';
    } catch (_) {}
  }
  if (r.status === 'needs_clarification') return '无法回答：需要先确认——' + why + '。为避免给错数字，本次没有给出结果。';
  if (r.status === 'capability_gap') return '无法回答：现在的计算方式表达不了这个问题（' + why + '）。为避免给错数字，本次没有给出结果。';
  return '无法回答：' + why + '。为避免给错数字，本次没有给出结果。';
}

/** 计划 → 可复用的规范 IR（入口候选/计划缓存保存它，不只保存 plan_id） */
function planToIR(plan){
  const p = normalizePlan(plan);
  return {
    schema: 'ir/1',
    metric_ids: p.metric_ids,
    time: { role: p.time.role, anchor: p.time.anchor || null, start: p.time.start, end: p.time.end, endExclusive: p.time.endExclusive, label: p.time.label, grain: p.time.grain, timezone: p.time.timezone, interval: p.time.interval },
    dimensions: p.dimensions, entities: p.entities, filters: p.filters, negations: p.negations,
    // 第三轮：对比要连同输出口径（增长率 / 差值）和基期一起存；基期是参数，复用时按新问题重绑（matchConfirmedPlan）
    comparison: p.comparison && p.comparison.kind && p.comparison.kind !== 'none' ? { kind: p.comparison.kind, explicit: !!p.comparison.explicit, output: p.comparison.output || null, policy: p.comparison.policy || null, base: p.comparison.base || null } : 'none',
    rank: p.rank, grain: p.grain, formula: p.formula, unit: p.unit,
    // 第三轮：按指标筛组（having）、是否判断（indicator）、累计也是计划的一部分——不存的话复用时会悄悄丢掉条件
    having: p.having || null, indicator: p.indicator || null, cumulative: p.cumulative === true ? true : undefined,
    output_shape: p.output_shape, metric_name: p.metric_name || null,
  };
}

// 口径限定词的同义组：题面写「退货」、指标叫「退款金额」时不该判成「没落到计划」。
// 只用于放宽「候选词根不同但限定词一致」的指标一致性检查，不参与选指标。
const QUALIFIER_GROUPS = [
  ['退货', '退款', '换货', '返修', 'return', 'refund'],
  ['实际', '真实', '发生'],
  ['净', '净额', 'net'],
  ['广告', 'ad'],
  ['直播', 'live'],
  ['库存', '在途', 'snapshot', 'inventory', 'stock'],
  ['期末', '快照'],
];
/** 题面里出现的口径限定词，在计划指标（含叶子）里是否有同组对应 */
function qualifierCovered(question, plan, registry){
  if (!registry) return false;
  const q = String(question == null ? '' : question).toLowerCase();
  let text = '';
  try {
    for (const id of (plan.metric_ids || [])) {
      const m = registry.metric(id);
      text += ' ' + [m.id, m.name, ...(m.aliases || [])].join(' ').toLowerCase();
      for (const l of registry.leaves(id)) { const lm = registry.metric(l); text += ' ' + [lm.id, lm.name].join(' ').toLowerCase(); }
    }
  } catch (_) { return false; }
  for (const group of QUALIFIER_GROUPS) {
    if (!group.some(w => q.includes(w))) continue;
    return group.some(w => text.includes(w));
  }
  return false;
}

/** 残留说法检查的薄包装：本机判断不能因为这里抛错而拖垮零调用以外的路径 */
// P78 复用前重新核条件(用户 10-29 定:存的是核过的计算计划/SQL 模板,用时按本题重新核条件,核不过就正常求解):
// 只用运行时拿得到的信息——题面 + 计划本身,不看任何参考答案。
function reuseConditionGap(question, plan, registry){
  const sc = require('./sql-constraints');
  if (sc.rowNumericFilter(question)) return 'row_numeric_filter_not_in_config_plan';
  try {
    const ctx = { metrics: (plan.metric_ids || []).map(id => { try { const m = registry.metric(id); return { kind: m.kind || 'simple', agg: m.agg, field: m.field, name: m.name, aliases: m.aliases || [], dataset: m.dataset || m.boundTo }; } catch (_) { return null; } }).filter(Boolean) };
    const avgs = sc.explicitSumAvgDefaults(question, ctx);
    const agg = plan.formula && plan.formula.kind === 'simple' ? plan.formula.agg : null;
    if (avgs.length && (!agg || agg === 'avg')) return 'explicit_sum_vs_avg_plan';
  } catch (_) {}
  return null;
}
function safeResidual(question, plan, registry, dictMod){
  try {
    const r = residualConcepts(question, plan, { registry, dict: dictMod }) || [];
    for (const g of localConditionGaps(question, plan)) if (!r.includes(g)) r.push(g);
    return r;
  } catch (_) { return ['residual_check_error']; }
}

/** 约束覆盖：每个用户约束都要有计划节点；明确提到但无法表示 → unrepresentable（不静默丢） */
/**
 * 第三轮：题面点到的指标虽然不是计划的主指标，但确实已经落进计划——
 *  1) 它就是计划公式里的分子/分母/派生项（「退款金额占销售额」主指标是比率，销售额在分母里）；
 *  2) 「有销量的 SKU 有多少个」：要数的是对象个数，计划用的是同一张表上的计数类指标，「销量」是计数的条件说法。
 */
function mentionCovered(question, plan, want, registry){
  try {
    const f = plan.formula || {};
    const refs = new Set();
    const add = x => { if (typeof x === 'string') refs.add(String(x).replace(/^m:/, '')); };
    [f.num, f.den, f.base, f.left, f.right].forEach(add);
    if(require('./sql-constraints').rowCountShareQuestion(question))[f.num_filter?.metric,f.den_filter?.metric].forEach(add);
    if (f.den_expr && Array.isArray(f.den_expr.args)) f.den_expr.args.forEach(add);
    const walk = x => { if (typeof x === 'string') add(x); else if (x && Array.isArray(x.args)) x.args.forEach(walk); };
    walk(f.expr);
    for (const id of plan.metric_ids || []) { try { for (const l of registry.leaves(id)) add(l); } catch (_) {} }
    const wantIds = [...want].map(x => String(x).replace(/^m:/, ''));
    if (wantIds.some(w => refs.has(w))) return true;
    const m = registry && plan.metric_ids && plan.metric_ids[0] ? registry.metric(plan.metric_ids[0]) : null;
    if (m && m.kind === 'simple' && ['count', 'dcount'].includes(m.agg) && /多少个|几个|个数|有多少(?:个|家|种|款)|多少种|多少款/.test(String(question || ''))) {
      const ds = m.dataset || m.boundTo;
      return wantIds.every(w => { try { const wm = registry.metric('m:' + w); return (wm.dataset || wm.boundTo) === ds; } catch (_) { return false; } });
    }
  } catch (_) {}
  return false;
}

function coverageOf(question, plan, signals, opts){
  const missing = [], unrepresentable = [];
  const s = signals || {};
  // 指标：括号公式里出现的词不算“用户在问的指标”（否则「退货率（退货GMV÷GMV）」会被 gmv 抢走）
  if ((opts && opts.mode) !== 'ir' && (plan.metric_ids || []).length && !(s.metricCandidates || []).some(id => String(id).replace(/^m:/, '') === String(plan.metric_ids[0]).replace(/^m:/, ''))) {
    missing.push({ slot: 'metric', message: '题面指名的指标没有被候选覆盖（可能只在公式说明里出现）' });
  }
  if (s.metricCandidates && s.metricCandidates.length) {
    if (!plan.metric_ids || !plan.metric_ids.length) missing.push({ slot: 'metric', message: '话里点了指标，但计划没有指标节点' });
    else if (plan.metric_ids.length === 1) {
      const want = new Set(s.metricCandidates.map(x => String(x)));
      if (!plan.metric_ids.some(id => want.has(String(id)) || want.has(String(id).replace(/^m:/, ''))) && !qualifierCovered(question, plan, opts && opts.registry) && !mentionCovered(question, plan, want, opts && opts.registry)) unrepresentable.push({ slot: 'metric', message: `提到的指标（${s.metricCandidates.join(',')}）没有落到计划` });
    }
  }
  // 时间：话里有期间就必须有区间；没有就允许「全部数据」；但有时间字样却没解析出来 = 条件被静默丢掉
  if (s.periodMissing && !(plan.time && plan.time.start)) {
    missing.push({ slot: 'time', message: '题面提到了时间，但计划没有期间（不能按「全部数据」算）' });
  }
  if (s.period) {
    if (!plan.time || !plan.time.start) missing.push({ slot: 'time', message: '话里有时间范围，但计划没有期间节点' });
    else if (s.period.start && plan.time.start && String(s.period.start).slice(0, 10) !== String(plan.time.start).slice(0, 10)) {
      let endpoints=false;
      try{const m=opts.registry.metric(plan.metric_ids[0]),b=plan.comparison?.base;endpoints=m.additivity==='semiAdditive'&&plan.comparison.kind!=='none'&&plan.comparison.output==='delta'&&b?.start===s.period.start&&b.endExclusive===require('./time-core').addDays(s.period.start,1)&&plan.time.start===s.period.end&&plan.time.endExclusive===s.period.endExclusive;}catch(_){}
      if(!endpoints)missing.push({ slot: 'time', message: `期间不一致：话里 ${s.period.start}，计划 ${plan.time.start}` });
    }
  }
  if (s.namedTimeRole && !(plan.time && plan.time.role)) missing.push({ slot: 'time_role', message: '话里点名了时间口径，但计划没有时间角色' });
  // 维度：分组维度、实体/否定条件、或「合计类」题里只是范围描述的维度，都算落实
  const AGG_SCOPE_RE = /加起来|合计|一共|总共|总计|总和|累计|加总|所有|全部|整体|全渠道/;
  for (const d of (s.dimensions || [])) {
    const rawId = String(d).replace(/^d:/, '');
    const idOf = x => String(x == null ? '' : x).replace(/^d:/, '');
    const inDims = (plan.dimensions || []).some(x => idOf(x) === rawId);
    // 第三轮 T4：「A 比 B 低几个百分点」规整成成员差（member_diff）后，维度和两个成员在公式里，不在实体里
    const md = plan.formula && plan.formula.kind === 'member_diff' ? plan.formula : null;
    const inCond = [...(plan.entities || []), ...(plan.negations || [])].some(x => x && x.dim && idOf(x.dim) === rawId) || !!(md && idOf(md.dim) === rawId);
    // 「四个渠道的 GMV 加起来」里的「渠道」是范围描述，不是要求按渠道分组（没别的分组/粒度时）
    const scopeOnly = AGG_SCOPE_RE.test(String(question || '')) && !(plan.dimensions || []).length && !plan.grain;
    if (!inDims && !inCond && !scopeOnly) missing.push({ slot: 'dimension:' + d, message: '话里要求按该维度分组，但计划没有这个维度' });
  }
  // 实体 / 否定
  for (const e of (s.entities || [])) {
    if (!e || e.dim == null || e.value == null) continue;
    if(require('./sql-constraints').definedIndicatorCovers(question,e.value,plan,opts?.registry))continue;
    const mdf = plan.formula && plan.formula.kind === 'member_diff' ? plan.formula : null;
    if (mdf && String(mdf.dim).replace(/^d:/, '') === String(e.dim).replace(/^d:/, '') && [String(mdf.left), String(mdf.right)].includes(String(e.value))) continue;
    if (!(plan.entities || []).some(x => String(x.value) === String(e.value) && String(x.dim).replace(/^d:/, '') === String(e.dim).replace(/^d:/, ''))) missing.push({ slot: 'entity:' + e.value, message: `提到的对象「${e.value}」没有落到计划` });
  }
  if ((s.ambiguousEntities || []).length && !(plan.entities || []).length && !(s.ambiguousEntities||[]).every(g=>g.options?.length&&g.options.every(x=>require('./sql-constraints').definedIndicatorCovers(question,x.value,plan,opts?.registry)))) missing.push({ slot: 'entity', message: '题面里的对象有多个候选，计划没有落实' });
  // 多个对象分别出现在多个候选维度时，落实其中一个不能掩盖另一个对象遗漏；只核对题面已有字面值，不替用户消歧。
  const qText=String(question||'').toLowerCase(),literalValues=[...new Set((s.ambiguousEntities||[]).flatMap(g=>(g.options||[]).filter(x=>['exact','contains'].includes(x.how)&&String(x.value).length>=2&&qText.includes(String(x.value).toLowerCase())).map(x=>String(x.value))))];
  const coveredValues=[...(plan.entities||[]),...(plan.negations||[])].map(x=>String(x.value).toLowerCase());
  coveredValues.push(...require('./self-check').enumeratedMembers(plan,{question,signals:s}));
  if(plan.formula?.kind==='member_diff')coveredValues.push(String(plan.formula.left).toLowerCase(),String(plan.formula.right).toLowerCase());
  for(const v of literalValues){const text=v.toLowerCase();if(require('./sql-constraints').definedIndicatorCovers(question,v,plan,opts?.registry))continue;if(literalValues.some(other=>other.length>v.length&&other.toLowerCase().includes(text)&&!qText.split(other.toLowerCase()).join('').includes(text)))continue;if(!coveredValues.includes(text))missing.push({slot:'entity:'+v,message:'题面对象「'+v+'」没有落实；不能因另一对象已有筛选而省略'});}
  const mappedNeg = (plan.negations || []).filter(n => n && n.value != null && n.dim);
  if ((s.negations || []).length && mappedNeg.length < (s.negations || []).length) {
    unrepresentable.push({ slot: 'negation', message: '否定/排除条件目前没有可表示的计划节点（只有文字、没有落到维度值）' });
  }
  // 比较 / 排序 / 粒度
  const kind = s.comparisonKind || 'none';
  if (kind !== 'none' && (!plan.comparison || plan.comparison.kind !== kind)) missing.push({ slot: 'comparison', message: `话里要 ${kind} 对比，计划没落` });
  if (s.comparisonOutput === 'growth_rate' && (!plan.comparison || plan.comparison.output !== 'growth_rate')) missing.push({ slot: 'comparison_output', message: '话里要增长率（百分比），计划只给了差值' });
  if (s.rank && s.rank.top && (!plan.rank || plan.rank.top !== s.rank.top)) missing.push({ slot: 'rank', message: '话里的前 N/排名没有落到计划' });
  if (s.grain && plan.grain !== s.grain) missing.push({ slot: 'grain', message: '话里的时间粒度没有落到计划' });
  return { missing, unrepresentable };
}

/**
 * 消歧：按槽位赋值，再重新校验所有依赖（不能只删除 unresolved 当作落实）。
 * @param {object} plan
 * @param {string} code 缺口短码
 * @param {{id?, value?, dim?, name?}|string} pick 选项
 */
function applyChoice(plan, code, pick, registry, o = {}){
  const next = normalizePlan(JSON.parse(JSON.stringify(plan || {})));
  const id = pick && typeof pick === 'object' ? (pick.id || pick.value) : pick;
  const applied = [];
  const drop = c => { next.unresolved = (next.unresolved || []).filter(u => u.code !== c); };
  const idOf = (v, prefix) => { const x = String(v || '').replace(new RegExp('^' + prefix + ':'), ''); return prefix + ':' + x; };
  try {
    if (code === CODES.AMBIGUOUS_METRIC && id) {
      next.metric_ids = [idOf(id, 'm')];
      const m = registry.metric(next.metric_ids[0]);
      next.unit = m.unit || '';
      next.metric_name = m.name;
      next.formula = m.kind === 'ratio' ? { kind: 'ratio', num: 'm:' + m.num, den: 'm:' + m.den, mul: m.mul || 1, scope: 'keep_group_filter' }
        : m.kind === 'derived' ? { kind: 'derived', expr: m.expr }
          : { kind: 'simple', agg: m.agg, field: m.field, dataset: m.dataset };
      drop(CODES.AMBIGUOUS_METRIC);
      applied.push({ slot: 'metric', value: next.metric_ids[0] });
      // 依赖重算：换了指标，时间角色要按新指标重新判断（旧角色若不再适用必须清掉）
      const leaves = registry.leaves(next.metric_ids[0]);
      const datasets = [...new Set(leaves.map(l => registry.metric(l).dataset || registry.metric(l).boundTo).filter(Boolean))];
      const usable = registry.timeRoles().filter(r => datasets.includes(r.dataset));
      if (next.time && next.time.role && !usable.some(r => r.id === next.time.role)) { next.time.role = null; drop(CODES.MISSING_TIME_ROLE); }
      if (next.time && next.time.start && !next.time.role) {
        if (usable.length === 1) { next.time.role = usable[0].id; applied.push({ slot: 'time_role', value: usable[0].id, derived: true }); }
        else if (usable.length > 1) next.unresolved.push({ code: CODES.MISSING_TIME_ROLE, message: '这个指标涉及多个日期口径', options: usable });
        else next.unresolved.push({ code: CODES.MISSING_TIME_ROLE, message: '这些数据里没有可用的日期列', options: registry.timeRoles() });
      }
    } else if (code === CODES.MISSING_TIME_ROLE && id) {
      next.time = Object.assign({}, next.time, { role: idOf(id, 't') });
      drop(CODES.MISSING_TIME_ROLE);
      applied.push({ slot: 'time_role', value: next.time.role });
    } else if (code === CODES.AMBIGUOUS_ENTITY && pick) {
      const e = typeof pick === 'object' ? pick : { dim: pick.dim, value: pick.value };
      if (!e || !e.dim || e.value == null) throw new Error('实体消歧缺少 dim/value');
      next.entities = (next.entities || []).filter(x => String(x.dim) !== String(e.dim)).concat([{ dim: idOf(e.dim, 'd'), value: String(e.value), how: e.how || 'choice' }]);
      drop(CODES.AMBIGUOUS_ENTITY); drop(CODES.ENTITY_NOT_FOUND);
      applied.push({ slot: 'entity', dim: next.entities[next.entities.length - 1].dim, value: String(e.value) });
      if ((next.negations || []).length) next.negations = [];
    } else if (String(code).startsWith('ambiguous_dim') && id) {
      const d = idOf(id, 'd');
      if (!next.dimensions.includes(d)) next.dimensions.push(d);
      // 维度依赖：时间角色的日期维度不能同时当分组/过滤维度
      if (next.time && next.time.role) {
        const role = registry.timeRoles().find(r => r.id === next.time.role);
        if (role && role.dim && next.dimensions.includes('d:' + role.dim)) next.dimensions = next.dimensions.filter(x => x !== 'd:' + role.dim);
      }
      // 落地后必须能安全连接；不能只把错误删掉
      if (next.metric_ids && next.metric_ids.length === 1) {
        try { registry.semantic.checkJoin(next.metric_ids[0].slice(2), next.dimensions.map(x => String(x).replace(/^d:/, ''))); }
        catch (err) { throw Object.assign(new Error('消歧后的维度不能安全连接：' + err.message), { code: err.code || CODES.FANOUT }); }
      }
      drop(code);
      applied.push({ slot: 'dimension', value: d });
    } else if (code === CODES.PLAN_INCOMPLETE && pick && typeof pick === 'object' && pick.slot) {
      applied.push({ slot: pick.slot, value: pick.value });
    } else {
      throw new Error('这个缺口不能只用选项赋值来落实：' + code);
    }
  } catch (err) {
    next.apply_choice_error = { code: err.code || 'apply_choice_failed', message: err.message };
    return next;
  }
  // 重新校验依赖：清掉已不成立的缺口，补上依赖产生的新缺口；不把「删了错误」当落实
  next.unresolved = (next.unresolved || []).filter(u => {
    if (u.code === CODES.AMBIGUOUS_METRIC) return next.metric_ids.length !== 1;
    if (u.code === CODES.MISSING_TIME_ROLE) return !(next.time && next.time.role);
    if (u.code === CODES.AMBIGUOUS_ENTITY) return !(next.entities && next.entities.length);
    if (u.code === 'ambiguous_dim') return !(next.dimensions && next.dimensions.length);
    return true;
  });
  next.apply_choice = applied;
  next.id = planHash(next);
  return next;
}

/** 数据/schema 里没有的概念：用于「系统表达能力不足」的明确拒答（不猜、不静默丢） */
const SCHEMA_STOP = new Set(['多少','什么','哪些','哪个','分别','拆分','按照','按','各','的','是','在','里','时','快照','数据','请问','帮我','看一下','查一下','一下','呢','吗','和','与','跟','比','相比','对比','增长','上涨','下降','下滑','环比','同比','保留','两位','小数','百分','占比','金额','数量','合计','所有','全渠道','各自','这个','那个','时候','存放','放在','位于','可以','一个']);
function unsupportedConcepts(question, registry){
  let schemaText = '';
  try {
    const parts = [];
    for (const t of (registry.semantic && registry.semantic.datasets ? [] : [])) parts.push(String(t));
    for (const m of (registry.semantic ? [...registry.semantic.metrics.values()] : [])) parts.push(m.name, m.id, ...(m.aliases || []));
    for (const d of (registry.semantic ? [...registry.semantic.dims.values()] : [])) parts.push(d.name, d.id, ...(d.match || []), ...(d.aliases || []));
    for (const t of (registry.tables || [])) { parts.push(t.name); for (const c of (t.columns || [])) parts.push(c.name); }
    schemaText = parts.join(' ').toLowerCase();
  } catch (_) {}
  const s = String(question || '');
  // 先把疑问/虚词/单位/操作词换成空格，剩下的中文片段才可能是「概念」
  const cleaned = s
    .replace(/(?:是多少|多少|什么|哪些|哪个|哪|怎么样|怎么|如何|请问|帮我|麻烦|看一下|查一下|列出|给出|显示|统计|计算|进行|保留|两位|小数|百分|增长|下降|上涨|下滑|环比|同比|相比|对比|之间|分别|拆分|按照|按|各|在|里|时|的|是|和|与|跟|比|了|呢|吗|呀|啊|请|把|将|以|从|到|为|有|没有|一个|这个|那个|一下|时候|存放|放在|位于|属于|哪个仓库|仓位|库位)/g, ' ')
    .replace(/[元件天个%％\/]/g, ' ');
  const out = [];
  for (const m of cleaned.matchAll(/[\u4e00-\u9fff]{2,8}/g)) {
    const seg = m[0].replace(/^(?:的|是|和|与|跟|在|按|把|将|以|从|到|为)+/, '');
    if (seg.length < 2) continue;
    if (SCHEMA_STOP.has(seg)) continue;
    if (schemaText.includes(seg.toLowerCase())) continue;
    if (!out.includes(seg)) out.push(seg);
  }
  return out.slice(0, 3);
}
/** executor（main/plan-executor.js / worker DuckDB）→ ask 内部 result shape */
async function executeViaExecutor(plan, o, book){
  const ex = o.executor;
  const ctx = { registry: o.registry, tables: o.tables || {}, book, facts: book, shiftPeriod: require('./plan-ir').shiftPeriod };
  let raw = null;
  try {
    raw = typeof ex === 'function' ? await ex(plan, ctx) : await ex.execute(plan, ctx);
  } catch (err) {
    return { ok: false, errors: [{ code: err.code || 'executor_error', message: String(err && err.message || err) }] };
  }
  if (!raw || raw.ok === false) return { ok: false, errors: (raw && raw.errors) || [{ code: 'executor_error', message: 'executor 没有返回可用结果' }] };
  require('./request-context').assertCurrent(o);
  const m = raw.metric || {};
  const unit = m.unit != null ? m.unit : (plan.unit || '');
  const decimals = m.decimals == null ? 2 : m.decimals;
  const period = plan.time && plan.time.start ? { start: plan.time.start, endExclusive: plan.time.endExclusive, interval: plan.time.interval || '[start,endExclusive)', timezone: plan.time.timezone } : null;
  const filter_fp = 'fp:' + require('node:crypto').createHash('sha256').update(JSON.stringify({ entities: plan.entities || [], filters: plan.filters || [], negations: plan.negations || [], interval: [plan.time && plan.time.start, plan.time && plan.time.endExclusive], role: plan.time && plan.time.role })).digest('hex').slice(0, 16);
  const facts = [];
  const addFact = (label, value, extra = {}) => {
    const v = value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    const spec = {
      schema_version: 'fb/2', kind: extra.kind || 'metric', label, value: v, unit,
      display: v == null ? '—' : `${Number(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${unit || ''}`,
      status: v == null ? (raw.result_status === 'no_data' ? 'empty' : 'no_data') : (extra.status && extra.status !== 'ok' ? extra.status : 'ok'),
      dims: extra.dims || null, period, filter_fp, plan_id: plan.id || null, qid: plan.qid || null,
      formula: extra.formula || null, parents: extra.parents || null,
      source: raw.source && raw.source.dataset ? { table: raw.source.dataset, field: raw.source.field || '', stamp: raw.source.stamp || o.registry.stamp() } : null,
      data_version: o.dataStamp || null, semantic_version: o.registry.stamp(), permission_version: o.permissionVersion || null,
    };
    let id;
    try { id = typeof book.addTyped === 'function' ? book.addTyped(spec) : book.add(spec.label, spec.display); }
    catch (_) { id = book.add(spec.label, spec.display); }
    facts.push(Object.assign({ id }, spec));
    return id;
  };
  const rows = (raw.rows || []).map(r => {
    const label = Array.isArray(r.label) ? r.label.filter(x => x != null && x !== '').join(' · ') : String(r.label == null ? '' : r.label);
    const f = addFact(`${m.name || plan.metric_name || '指标'} · ${label || '（空）'}`, r.value, { dims: Array.isArray(r.label) ? r.label : null, status: r.status });
    return { label: label || '（空）', value: r.value, fact: f, status: r.status || 'ok' };
  });
  let scalar = null;
  const rawScalar = raw.value != null ? raw.value : (raw.scalar != null ? raw.scalar : null);
  if (!rows.length) scalar = rawScalar;
  else if (raw.result_kind === 'value' && rows.length === 1 && rows[0].value != null) scalar = rows[0].value;
  let comparison = null;
  if (raw.comparison && typeof raw.comparison === 'object') {
    const c = raw.comparison;
    const per = c.period && typeof c.period === 'object' ? c.period : { label: String(c.period || '') };
    comparison = Object.assign({}, c, { period: per, value: c.value == null ? null : c.value, delta: c.delta == null ? null : c.delta });
  }
  return {
    ok: true, rows, facts, scalar, comparison,
    result_status: raw.result_status || 'ok',
    trace: { executor: 'plan-executor', result_kind: raw.result_kind || null, applied: raw.applied || [], source: raw.source || null, plan_id: raw.plan_id || plan.id, snapshot: (raw.source && raw.source.stamp) || null },
  };
}
function renderRefusal(question, registry, outcome){
  const missing = outcome && outcome.concepts && outcome.concepts.length ? outcome.concepts.join('、') : '';
  if (missing) return `无法回答：数据里没有「${missing}」相关字段或口径，无法确定。`;
  return '无法回答：数据里没有能回答这个问题的指标或字段，无法确定。';
}

/** 本地 renderer：只从类型化 facts 生成答案；不调模型润色；空结果不能渲染成 0 */
function renderAnswer(plan, r, registry){
  const name = (plan.metric_name || (registry.metric(plan.metric_ids[0]) || {}).name || '指标');
  const lines = [];
  const facts = r.facts || [];
  const unitOf = f => (f && f.unit != null ? f.unit : (plan.unit || ''));
  const status = r.result_status || 'ok';
  if (status === 'no_data') return `${name}${plan.time && plan.time.label ? '（' + plan.time.label + '）' : ''}：查询成功，但这段时间没有匹配的数据`;
  if (status === 'zero_denominator') return `${name}${plan.time && plan.time.label ? '（' + plan.time.label + '）' : ''}：分母为 0，无法计算`;
  if (status === 'missing_comparison') return `${name}${plan.time && plan.time.label ? '（' + plan.time.label + '）' : ''}：缺少可对比的上一期数据`;
  if (r.rows && r.rows.length) {
    lines.push(`${name}${plan.time && plan.time.label ? '（' + plan.time.label + '）' : ''}：`);
    for (const row of r.rows) {
      const f = facts.find(x => x.id === row.fact) || null;
      const val = f && f.value != null ? fmt(f.value) + (unitOf(f) ? ' ' + unitOf(f) : '') : (row.fact || '无数据');
      lines.push(`- ${row.label}：${val}`);
    }
  } else {
    const f = facts[0];
    if (!f) lines.push(`${name}：无数据`);
    else lines.push(`${name}${plan.time && plan.time.label ? '（' + plan.time.label + '）' : ''} = ${f.value == null ? '无数据' : fmt(f.value) + (unitOf(f) ? ' ' + unitOf(f) : '')}（${f.id}）`);
  }
  if (r.comparison) {
    const c = r.comparison;
    const pv = c.value == null ? '无数据' : fmt(c.value) + (plan.unit ? ' ' + plan.unit : '');
    const delta = c.delta == null ? '—' : fmt(c.delta);
    lines.push(`对比 ${c.period && c.period.label ? c.period.label : ''}：${pv}，变化 ${delta}`);
    if (c.status && c.status !== 'ok') lines.push(`对比状态：${c.status}`);
  }
  return lines.join('\n');
}

/** 第三轮 T4：对比题的差值作为答案（带父事实与公式，可追溯）；只在题面确实问变化量、且没有分组时生效 */
const CHANGE_WORDS = /变化了?多少|变了?多少|变化了?几|差了?多少|相差|多了?多少|少了?多少|增加了?多少|减少了?多少|高了?多少|低了?多少|上升了?多少|下降了?多少|百分点/;
function withComparisonDelta(question, plan, r, book, registry){
  try {
    const c = r && r.comparison;
    if (!c || String(c.output || '') !== 'delta' || c.delta == null || !Number.isFinite(Number(c.delta))) return r;
    if ((plan.dimensions || []).length || !CHANGE_WORDS.test(String(question || '').replace(/[（(][^）)]*[）)]/g,''))) return r;
    if (/增长率|增速|变化率|百分之多少|多少%|多少％/.test(String(question || '')) && !/百分点/.test(String(question || ''))) return r;
    const cur = (r.facts || [])[0];
    if (!cur || cur.value == null) return r;
    const unitRaw = cur.unit != null ? String(cur.unit) : String(plan.unit || '');
    const unit = unitRaw === '%' ? '百分点' : unitRaw;
    const v = Number(c.delta);
    const display = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (unit ? (unit === '百分点' ? ' ' : '') + unit : '');
    const spec = { schema_version: 'fb/2', kind: 'metric', label: String(cur.label || '指标').replace(/ · .*$/, '') + ' · 变化（本期 − 基期）', value: v, unit, display, status: 'ok',
      period: cur.period || null, filter_fp: cur.filter_fp || null, plan_id: cur.plan_id || null, formula: '本期 − 基期', parents: [cur.id], source: cur.source || null };
    let id = null;
    try { id = typeof book.addTyped === 'function' ? book.addTyped(spec) : book.add(spec.label, spec.display); } catch (_) { try { id = book.add(spec.label, spec.display); } catch (__) {} }
    if (!id) return r;
    const f = Object.assign({ id }, spec);
    return Object.assign({}, r, { facts: [f, ...r.facts], rows: [{ label: '变化', value: v, fact: id, status: 'ok' }] });
  } catch (_) { return r; }
}

/* ================= 第三轮：限制级 SQL 兜底的路由（规格 T2 / 方案 §9.3）=================
 * 问法模板 / 兜底模板命中 → 0 次；配置单 1 次（条件没落全修 1 次）；模型说「表达不了」→ 不修配置单，直接转兜底写 SQL；
 * 兜底 SQL 检查不过或执行报错 → 去值后修 1 次；每题总调用 ≤ maxCallsTotal（默认 4），超过就明确说答不了。
 * 本机逻辑（检查、执行、可信档、去值）全在 main/sql-lane.js；这里只做路由、事实编号和答案。 */
const lane = require('./sql-lane');
const DEFAULT_MAX_CALLS_TOTAL = 4;
const SQL_LANE_TRIES = 2;            // 写一次 + 修一次
const _typeCache = new WeakMap();
/** 兜底提示词里的列类型用数据库真实类型（information_schema 只有表名、列名、类型，不含任何数据）；取不到就用语义包里的粗类型 */
// 10-24：这张表的日期实际覆盖到哪（只在本机查 MIN / MAX；快照类列出有快照的日子，最多 20 个）
async function dataRangeFor(plan, registry, run){
  const id = (plan && plan.metric_ids && plan.metric_ids[0]) || null; if (!id) return null;
  let m = null; try { m = registry.metric(id); const lv = registry.leaves(id); if (lv && lv.length) m = registry.metric(lv[0]); } catch (_) { return null; }
  const ds = m && (m.dataset || m.boundTo); if (!ds) return null;
  const t = ((registry && registry.tables) || []).find(x => x.name === ds); if (!t) return null;
  const dc = (t.columns || []).find(c => /date|time/i.test(String(c.type || ''))) || (t.dateCol ? { name: t.dateCol } : null);
  if (!dc) return null;
  const q = x => '"' + String(x).replace(/"/g, '""') + '"';
  const rowsOf = r => Array.isArray(r) ? r : (r && r.rows) || [];
  if (m.additivity === 'semiAdditive') {
    const rs = rowsOf(await run(`SELECT DISTINCT SUBSTR(CAST(${q(dc.name)} AS VARCHAR), 1, 10) AS d FROM ${q(ds)} WHERE ${q(dc.name)} IS NOT NULL ORDER BY 1 LIMIT 21`));
    if (rs.length && rs.length <= 20) return { snapshots: rs.map(x => String(x.d)) };
  }
  const r = rowsOf(await run(`SELECT SUBSTR(CAST(MIN(${q(dc.name)}) AS VARCHAR), 1, 10) AS a, SUBSTR(CAST(MAX(${q(dc.name)}) AS VARCHAR), 1, 10) AS b FROM ${q(ds)}`))[0];
  return r && r.a && r.b ? { start: String(r.a), end: String(r.b) } : null;
}
const _catCache = new Map();
async function columnTypesOf(run, registry){
  let key = 'x'; try { key = registry.stamp(); } catch (_) {}
  let byRun = _typeCache.get(run); if (!byRun) { byRun = new Map(); _typeCache.set(run, byRun); }
  if (byRun.has(key)) return byRun.get(key);
  const out = {};
  try {
    const rows = await run('SELECT table_name, column_name, data_type FROM information_schema.columns');
    for (const r of (Array.isArray(rows) ? rows : (rows && rows.rows) || [])) {
      const t = String(r.table_name || '').toLowerCase(), c = String(r.column_name || '').toLowerCase();
      if (!t || !c) continue;
      (out[t] = out[t] || {})[c] = String(r.data_type || '').toUpperCase();
    }
  } catch (_) {}
  byRun.set(key, out);
  return out;
}
const valueMatch = require('./value-match');

// ---------- 配置单这条路的「对象」本机核对（和兜底里的取值匹配同一套规矩）----------
// 模型在配置单里写的对象（供应商「东莞母婴厂」、品类「洗发类」）在值目录里对不上时：本机去候选的文本维度里找最像的真实取值。
// 唯一很像 → 用它并注明；几个都像 → 返回 value_choice 让用户选；都不像 → 标记「没找到」，由 shouldFallback 转 SQL 兜底。
// 硬规矩：真实取值只在本机比对、只给用户看，不进任何发给模型的请求（这里只改模型返回的 IR，不改发出去的 payload）。
const ENTITY_SUFFIX_RE = /(一级类目|二级类目|三级类目|大类|小类|细分类|类目|品类|系列|店铺|渠道|平台|品牌|类|店|厂)$/;
function entityQueries(value){
  const v = String(value == null ? '' : value).trim();
  const out = [v];
  const st = v.replace(ENTITY_SUFFIX_RE, '');
  if (st && st !== v && st.length >= 2) out.push(st);
  return out;
}
const TEXT_TYPE_RE = /CHAR|TEXT|STRING|ENUM/;
/** 可以拿来找对象的文本维度（排除日期桶 / 分箱 / 未绑定 / 数值列），指定的维度排最前 */
function entityDimCandidates(registry, entityLookup, types, preferId){
  const out = [], seen = new Set();
  const push = (d) => {
    if (!d || d.unbound || !d.source || d.kind !== 'column' || !d.source.table || !d.source.field) return;
    try { if (entityLookup && typeof entityLookup.isTemporal === 'function' && entityLookup.isTemporal(String(d.id))) return; } catch (_) {}
    const key = d.source.table + '\u0000' + d.source.field;
    if (seen.has(key)) return;
    const t = types && types[String(d.source.table).toLowerCase()] && types[String(d.source.table).toLowerCase()][String(d.source.field).toLowerCase()];
    if (t && !TEXT_TYPE_RE.test(t)) return;
    seen.add(key); out.push({ id: String(d.id), table: d.source.table, col: d.source.field });
  };
  try {
    if (preferId && registry.semantic.dims.has(preferId)) push(registry.semantic.dims.get(preferId));
    for (const d of registry.semantic.dims.values()) { if (out.length >= 40) break; push(d); }
  } catch (_) {}
  return out;
}
/** 答案里加一句「按『X』理解（你说的是『Y』）」，位置和兜底那边一致 */
function appendGuessNote(answer, note){
  let ans = String(answer || '');
  ans = ans.includes('\nANSWER: ') ? ans.replace('\nANSWER: ', '\n' + note + '。\nANSWER: ') : ans + '\n' + note + '。';
  return ans.replace(/）\s*$/, '；' + note + '）');
}
const guessNoteOf = (guesses) => guesses.map(x => `按「${x.value}」理解（你说的是「${x.literal}」），不对点一下改`).join('；');
/**
 * 包一层 resolveIR / repairIR：模型返回的 IR 里，对象在值目录里对不上就本机核对一遍。
 * 只在 ask 有 sqlRunner（能本机查不重复值）、有 entityLookup（知道目录里有什么）时启用；否则原样不动。
 */
function makeEntityFixer(question, o){
  if (!o || typeof o.sqlRunner !== 'function' || typeof o.resolveIR !== 'function' || !o.registry || !o.entityLookup || o.entityMatch === false) return null;
  const registry = o.registry, lookup = o.entityLookup;
  const stash = { guesses: [], choice: null, unmatched: [], memo: new Map(), pick: null, verified: new Map() };
  const verify = (value, dim) => { stash.verified.set(valueMatch.norm(value), { dim: String(dim || ''), value: String(value) }); };
  const pk = o.entityPick || (o.valueChoice && o.valueChoice.config ? o.valueChoice : null);
  if (pk && pk.literal != null && pk.value != null) stash.pick = pk;
  const existsInLookup = (value, dimId) => {
    try {
      const h = lookup.resolve(value, dimId ? { dimIds: [dimId] } : {});
      if (h.status === 'matched') return true;
      // 同一个值挂在多个维度、且有精确命中：计划那边会按指标所在表收敛，这里不插手
      if (h.status === 'ambiguous' && (h.candidates || []).some(c => (c.options || []).some(x => x.how === 'exact'))) return true;
    } catch (_) { return true; }   // 目录出错：不猜，交回原流程
    return false;
  };
  async function fixOne(e){
    if (!e || typeof e !== 'object' || e.value == null) return e;
    const literal = String(e.value).trim();
    if (!literal) return e;
    if (/^(?:全部|所有|整体|[一二两三四五六七八九十\d]+个)(?:渠道|平台|供应商|类目|品类|商品|货号|店铺)$/.test(literal)) return null;
    // P78:「美妆六个三级类」=「美妆」+ 范围说明(六个三级类目);只有前半段在目录里精确存在时才这样拆,否则照旧
    { const mq = /^(.{2,20}?)(?:的)?(?:全部|所有|[一二两三四五六七八九十\d]+个)(?:[一二三]级)?(?:类目|类|品类|渠道|平台|店铺|供应商|商品|货号|款)$/.exec(literal);
      if (mq) { try { const hh = lookup.resolve(mq[1], {}); const ex = (hh.matches || [hh]).find(x => x && String(x.value) === mq[1] && (x.how === 'exact' || hh.status === 'matched')); if (ex && ex.dim) { verify(mq[1], String(ex.dim).replace(/^d:/, '')); stash.guesses.push({ literal, value: mq[1], dim: String(ex.dim).replace(/^d:/, '') }); return Object.assign({}, e, { value: mq[1], dim: 'd:' + String(ex.dim).replace(/^d:/, '') }); } } catch (_) {} } }
    const dimId = String(e.dim || '').replace(/^d:/, '');
    const knownDim = dimId && dimId !== 'none' && registry.semantic.dims.has(dimId) ? dimId : '';
    if (stash.pick && String(stash.pick.literal) === literal) {
      const pd = String(stash.pick.dim || '').replace(/^d:/, '');
      if (!stash.guesses.some(g => g.literal === literal)) stash.guesses.push({ literal, value: String(stash.pick.value), dim: pd, table: stash.pick.table, col: stash.pick.col, picked: true });
      verify(stash.pick.value, pd);
      return Object.assign({}, e, { value: String(stash.pick.value), dim: pd ? 'd:' + pd : e.dim });
    }
    const memoKey = literal + '\u0000' + knownDim;
    if (stash.memo.has(memoKey)) { const m = stash.memo.get(memoKey); return m ? Object.assign({}, e, m) : e; }
    // 题面加引号点名的取值:只认逐字相同的真实取值;没有就交给只读 SQL 按原文精确算(结果可能是 0),不让用户先选、不换成相近值
    if (valueMatch.quotedVerbatim(question, literal)) {
      let exactHit = false;
      try { const h = lookup.resolve(literal, knownDim ? { dimIds: [knownDim] } : {}); exactHit = (h.matches || [h]).some(x => x && String(x.value) === literal && (x.how === 'exact' || h.status === 'matched')); } catch (_) {}
      if (exactHit) { stash.memo.set(memoKey, null); return e; }
      stash.unmatched.push(literal); stash.verbatim = (stash.verbatim || []).concat(literal);
      stash.memo.set(memoKey, null);
      return e;
    }
    if (existsInLookup(literal, knownDim)) { stash.memo.set(memoKey, null); return e; }
    if(knownDim){const dd=registry.dim(knownDim),exact=valueMatch.exactQuestionValue({question,table:dd.source?.table,col:dd.source?.field,registry,lookup});if(exact){verify(exact,knownDim);stash.guesses.push({literal,value:exact,dim:knownDim,table:dd.source.table,col:dd.source.field});const patch={value:exact,dim:'d:'+knownDim};stash.memo.set(memoKey,patch);return {...e,...patch};}}

    // 空值/缺字段条件不是对象名称；配置单不能表达时交给 SQL，不让用户从相似取值里选。
    if (/^(?:空值|为空|非空|不为空|未填写|未提供|没有.{1,24}(?:的记录|记录|的行|行)|null|not null|missing|blank|empty)$/i.test(literal)) {
      stash.unsupportedValue = true;
      stash.unmatched.push(literal);
      return e;
    }
    // 目录里没有：先查叫法记忆，再本机找候选
    const types = await columnTypesOf(o.sqlRunner, registry).catch(() => ({}));
    const dims = entityDimCandidates(registry, lookup, types, knownDim);
    let cands = [];
    for (const d of dims) {
      let alias = null;
      try { const a = typeof o.lookupValueAlias === 'function' ? await o.lookupValueAlias(literal, { table: d.table, col: d.col }) : null; alias = a && typeof a === 'object' ? a.value : a; } catch (_) {}
      if (alias != null && String(alias) !== '' && String(alias) !== literal) { cands = [{ value: String(alias), score: 1, n: 0, d }]; break; }
      let got = [];
      try {
        // 向量只在指定了维度（或候选维度很少）时用，别对几十列都算一遍
        const useVec = d.id === knownDim || dims.length <= 3;
        got = await valueMatch.findValues({ run: o.sqlRunner, table: d.table, col: d.col, queries: entityQueries(literal), limit: 5, vecScore: o.vecScore, vecBatch: useVec ? o.vecBatch : undefined });
      } catch (_) {}
      for (const x of got) cands.push(Object.assign({}, x, { d }));
    }
    const rank = new Map(dims.map((d, i) => [d.id, i]));
    cands.sort((a, b) => b.score - a.score || b.n - a.n || (rank.get(a.d.id) - rank.get(b.d.id)));
    const seenV = new Set(); cands = cands.filter(x => { const k = String(x.value); if (seenV.has(k)) return false; seenV.add(k); return true; });
    const dec = valueMatch.decide(cands);
    if (dec.mode === 'auto') {
      const top = cands[0];
      verify(top.value, top.d.id);
      if (String(top.value) !== literal) stash.guesses.push({ literal, value: String(top.value), dim: top.d.id, table: top.d.table, col: top.d.col });
      const patch = { value: String(top.value), dim: 'd:' + top.d.id };
      stash.memo.set(memoKey, patch);
      return Object.assign({}, e, patch);
    }
    if (dec.mode === 'ask') {
      const top = cands[0];
      const opts = dec.options.filter(x => x.d.id === top.d.id).map(x => ({ value: x.value, score: x.score, n: x.n }));
      stash.choice = { literal, dim: 'd:' + top.d.id, table: top.d.table, col: top.d.col, options: opts };
    } else {
      stash.unmatched.push(literal);
    }
    stash.memo.set(memoKey, null);
    return e;
  }
  async function fixIR(ir){
    if (!ir || typeof ir !== 'object') return null;
    const out = Object.assign({}, ir);
    let recalledDim=null;
    if(!(out.entities||[]).length && !/[和及、与或]/.test(String(question)) && !/不含|不包括|排除|剔除|除了|之外|以外|除外|非|不是|不属于/.test(String(question)) && out.metric && out.metric!=='none'){
      try{
        const bases=registry.leaves(out.metric).map(id=>{const m=registry.metric(id);return m.dataset||m.boundTo;});
        const types=await columnTypesOf(o.sqlRunner,registry);
        const dims=entityDimCandidates(registry,lookup,types,'').filter(d=>bases.some(t=>t===d.table||registry.semantic._safePath(t,d.table)));
        let hit=lookup.resolve(question,{dimIds:dims.map(d=>d.id)});
        // P78:同一个编号同时出现在维度表和事实表(按编号连接)时会「多处命中」;优先取指标所在表上的那一列(同一实体,不是歧义)
        if(hit.status==='ambiguous'){const own=dims.filter(d=>bases.includes(d.table));if(own.length){const h2=lookup.resolve(question,{dimIds:own.map(d=>d.id)});if(h2.status==='matched'&&['exact','contains'].includes(h2.how))hit=h2;}}
        if(hit.status==='matched'&&['exact','contains'].includes(hit.how)&&String(hit.value).length>=2&&!/^(全部|所有|整体|全体|合计|总计)$/.test(String(hit.value))&&String(question).includes(String(hit.value))){
          recalledDim=String(hit.dim).replace(/^d:/,'');out.entities=[{dim:'d:'+recalledDim,value:String(hit.value)}];verify(hit.value,recalledDim);
        } else {
          const alias=valueMatch.explicitNominalAlias(question,{lookup,dimIds:dims.map(d=>d.id)});
          if(alias){recalledDim=alias.dim;out.entities=[{dim:'d:'+alias.dim,value:alias.value}];verify(alias.value,alias.dim);stash.guesses.push({literal:alias.literal,value:alias.value,dim:alias.dim});}
        }
      }catch(_){}
    }
    const lists = ['entities', 'negations'].filter(k => Array.isArray(out[k]) && out[k].length);
    if (!lists.length) return null;
    // 模型把“类商品/产品”等语法尾词并入实体时，只用原题唯一精确对象纠正。
    // 已存在的完整取值、歧义、无安全关系路径均不改，不降低候选阈值。
    if(out.metric&&out.metric!=='none')try{
      const bases=registry.leaves(out.metric).map(id=>{const m=registry.metric(id);return m.dataset||m.boundTo;});
      const dims=entityDimCandidates(registry,lookup,await columnTypesOf(o.sqlRunner,registry),'').filter(d=>bases.some(t=>t===d.table||registry.semantic._safePath(t,d.table)));
      const dimIds=dims.map(d=>d.id);
      out.entities=(out.entities||[]).map(e=>{
        const literal=String(e.value||''),stem=literal.replace(/(?:类(?:商品|产品)?|商品|产品)$/,'');
        if(stem===literal||stem.length<2||!String(question).includes(literal))return e;
        const full=lookup.resolve(literal,{dimIds});if((full.matches||[]).some(x=>x.how==='exact'&&String(x.value)===literal))return e;
        const hit=lookup.resolve(stem,{dimIds});if(hit.status!=='matched'||hit.how!=='exact'||String(hit.value)!==stem)return e;
        const dim=String(hit.dim).replace(/^d:/,'');verify(stem,dim);stash.guesses.push({literal,value:stem,dim});return {...e,value:stem,dim:'d:'+dim};
      });
    }catch(_){}
    for (const k of lists) out[k] = (await Promise.all(out[k].map(x => fixOne(x).catch(() => x)))).filter(Boolean);
    if(stash.verified.size&&Array.isArray(out.unresolved))out.unresolved=out.unresolved.filter(u=>{
      if(!/^(?:entities|entity)(?:\[\d+\])?$/.test(String(u.slot||''))||!u.options?.length)return true;
      if(recalledDim&&['ambiguous','candidate_miss'].includes(u.reason)&&u.options.every(x=>registry.semantic.dims.has(String(x).replace(/^d:/,'')))&&u.options.some(x=>String(x).replace(/^d:/,'')===recalledDim))return false;
      if(u.reason!=='candidate_miss')return true;
      const resolved=(out.entities||[]).filter(e=>{const h=stash.verified.get(valueMatch.norm(e.value));return h&&h.dim===String(e.dim).replace(/^d:/,'');});
      return !u.options.every(x=>resolved.some(e=>String(x).includes(String(e.value))));
    });
    if (stash.unsupportedValue) out.unresolved = [...(out.unresolved || []), { slot: 'filter', reason: 'capability_gap' }];
    return out;
  }
  const wrap = (fn) => async (payload) => {
    const clean = JSON.parse(JSON.stringify(payload));
    const restore = v => typeof v === 'string' ? stash.guesses.reduce((s,g)=>s.split(g.value).join(g.literal),v) : Array.isArray(v) ? v.map(restore) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,restore(x)])) : v;
    const outbound=restore(clean);
    // 只还原查询值；题面及已授权schema/候选名称不因同名数据值而被改写。
    for(const key of ['question','schema','candidates','catalog','sql_context'])if(Object.hasOwn(clean,key))outbound[key]=clean[key];
    const res = await fn(outbound);
    if (payload && payload.lane === 'sql') return res;
    if (res && res.ok) {
      const key = res.ir ? 'ir' : 'plan';
      let fixed = null; try { fixed = await fixIR(res[key]); } catch (_) {}
      if (fixed) return Object.assign({}, res, { [key]: fixed });
    }
    return res;
  };
  // 本机已经在数据里核实过的真实取值：后面计划转换时目录（可能只装了一部分）认不出，就由这层认下来
  const lookup2 = Object.create(lookup);
  lookup2.resolve = function(text, opt){
    const hit = stash.verified.get(valueMatch.norm(text));
    const want = opt && Array.isArray(opt.dimIds) && opt.dimIds.length ? opt.dimIds.map(d => String(d).replace(/^d:/, '')) : null;
    if (hit && hit.dim && (!want || want.includes(hit.dim))) return { status: 'matched', dim: hit.dim, value: hit.value, count: null, how: 'exact', coverage: {}, matches: [{ dim: hit.dim, value: hit.value, how: 'exact' }] };
    return lookup.resolve(text, opt);
  };
  const o2 = Object.assign({}, o, { resolveIR: wrap(o.resolveIR), entityLookup: lookup2 });
  if (typeof o.repairIR === 'function') o2.repairIR = wrap(o.repairIR);
  return { o: o2, stash };
}
/** 把 SQL 里的 'literal' 整个换成 'value'（单引号转义） */
function swapLiteral(sql, literal, value){
  const from = "'" + String(literal).replace(/'/g, "''") + "'", to = "'" + String(value).replace(/'/g, "''") + "'";
  return String(sql).split(from).join(to);
}
const SUBSTITUTE_RE = /代替|替代|顶替|近似|估算|估计值|字段缺失|没有[^，。；]{0,8}字段|无[^，。；]{0,6}字段|无法(?:回答|计算|得到|获取|区分)|缺[^，。；]{0,20}字段|不可行|作为[^，。；]{0,10}口径/;
function typedCandidateGap(question,ir,registry,canUseSql){
  const q=String(question||'');
  // 去重对象是输出，退货金额等是行条件；简单dcount配置没有这种度量行筛选，交给已有SQL校验通道。
  if(canUseSql&&ir?.metric&&Array.isArray(ir.unresolved)&&/(?:有|存在).{1,24}(?:记录|明细|交易)/.test(q)){
    try{
      const m=registry.metric(ir.metric),p={metric_ids:[ir.metric],dimensions:ir.dimensions||[],entities:ir.entities||[],filters:[],negations:[],time:{},formula:{kind:'simple',agg:m.agg,field:m.field,dataset:m.dataset||m.boundTo}};
      if(m.kind==='simple'&&m.agg==='dcount'&&unmappedConditions(q,p,{registry}).some(g=>g.slot==='return')){
        let changed=false;const unresolved=ir.unresolved.map(u=>{
          if(u.slot!=='metric'||!['ambiguous','candidate_miss'].includes(u.reason)||!u.options?.length)return u;
          const options=u.options.map(id=>{try{return registry.metric(id);}catch(_){return null;}});
          if(options.every(x=>x&&!['count','dcount'].includes(x.agg))){changed=true;return {...u,reason:'capability_gap'};}return u;
        });if(changed)return {...ir,unresolved};
      }
    }catch(_){}
  }
  if(!ir||!Array.isArray(ir.unresolved)||!/(?:多少(?:元|美元|英镑|欧元|日元)|金额|保费|销售额|成交额|费用|成本|收入|revenue|premium|amount)/i.test(q)||/记录数|笔数|张数|行数|次数|(?:多少|几)(?:个|笔|张|条|件|次)/.test(q))return ir;
  let changed=false;const unresolved=ir.unresolved.map(u=>{
    if(u.slot!=='metric'||u.reason!=='ambiguous'||!u.options?.length)return u;
    const metrics=u.options.map(x=>{try{return registry.metric(typeof x==='object'?x.id:x);}catch(_){return null;}});
    if(metrics.every(m=>m&&m.auto&&!m.confirmed&&(['count','dcount'].includes(m.agg)||/(?:^|_)(?:id|identifier|key|code|type)(?:_|$)/i.test(String(m.field||''))))){changed=true;return {...u,reason:'capability_gap'};}
    return u;
  });return changed?{...ir,unresolved}:ir;
}
function resolveStructuralAmbiguity(question,ir,registry){
  if(!ir?.metric||ir.metric==='none'||!Array.isArray(ir.unresolved))return ir;
  const text=String(question).toLowerCase().replace(/\s/g,''),raw=id=>String(id).replace(/^[md]:/,'');
  const wanted=[];
  for(const e of ir.entities||[])if(e.value!=null&&String(question).includes(String(e.value)))wanted.push(e.dim);
  for(const id of ir.dimensions||[])try{const d=registry.dim(id);if([d.name,...d.aliases||[],...d.match||[]].some(n=>String(n||'').length>=2&&text.includes(String(n).toLowerCase().replace(/\s/g,''))))wanted.push(id);}catch(_){}
  let changed=false;const unresolved=ir.unresolved.filter(u=>{
    if(u.slot==='time_role'&&ir.period?.kind==='none'){
      try{const bases=registry.leaves(ir.metric).map(id=>{const m=registry.metric(id);return m.dataset||m.boundTo;});if(!/(?:今|昨|前|上|下|本|近|这|那).{0,4}(?:天|日|周|月|年|季|期)|日期|时间|期间|最新|当前|截至|近期|期末|期初|as of|current|latest|recent|last|today|\d{4}[-年/]/i.test(String(question))&&!extractSignals(question,{registry}).period&&!registry.timeRoles().some(r=>bases.includes(r.dataset))){changed=true;return false;}}catch(_){}
    }
    if(u.slot==='time_role'&&ir.time_role&&ir.time_role!=='none'&&u.options?.length){
      try{const bases=registry.leaves(ir.metric).map(id=>{const m=registry.metric(id);return m.dataset||m.boundTo;}),all=registry.timeRoles(),eligible=u.options.map(x=>all.find(r=>r.id===String(typeof x==='object'?x.id:x))).filter(r=>r&&bases.includes(r.dataset)),named=extractSignals(question,{registry}).namedTimeRole;if(eligible.length===1&&eligible[0].id===ir.time_role&&(!named||String(eligible[0].name).includes(named))){changed=true;return false;}}catch(_){}
    }
    if(u.slot!=='metric'||!['ambiguous','candidate_miss'].includes(u.reason)||!u.options?.length)return true;
    const ms=u.options.map(x=>{try{return registry.metric(typeof x==='object'?x.id:x);}catch(_){return null;}});if(ms.some(x=>!x))return true;
    const exact=ms.filter(m=>{const f=String(m.field||'');if(f.length<2)return false;if(/^[A-Za-z0-9_]+$/.test(f))return new RegExp('(?:^|[^A-Za-z0-9_])'+f.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^A-Za-z0-9_])','i').test(String(question));return text.includes(f.toLowerCase().replace(/\s/g,''));});
    let unique=exact.length===1?exact:[];
    if(!unique.length&&wanted.length)unique=ms.filter(m=>wanted.every(id=>{try{const d=registry.dim(id);return registry.leaves('m:'+m.id).every(l=>{const v=registry.metric(l),base=v.dataset||v.boundTo;return base===d.source?.table||registry.semantic._safePath(base,d.source?.table);});}catch(_){return false;}}));
    if(unique.length===1&&raw(unique[0].id)===raw(ir.metric)){changed=true;return false;}return true;
  });return changed?{...ir,unresolved}:ir;
}
function saysCapabilityGap(ir){ return !!(ir && Array.isArray(ir.unresolved) && ir.unresolved.some(u => u && u.reason === 'capability_gap')); }
const stripDigitTokens = s => { let t = String(s || '').split(/(\s+|[，、；：（）()])/).filter(t => !/[0-9]/.test(t)).join(''); for (let i = 0; i < 3; i++) t = t.replace(/（\s*%?\s*）|\(\s*%?\s*\)/g, ''); return t.replace(/^[：、，；\s]+|[：、，；\s]+$/g, ''); };

/** 配置单这条路什么时候转兜底：系统表达不了 / 条件落不全 / 计划结构不成立 / 自查不过；用户没说清（指标、维度、对象歧义）不转 */
function shouldFallback(r, o = {}){
  if (!r || r.status === 'ok') return false;
  if (r.status === 'capability_gap') return true;
  const code = String(r.code || '');
  if (r.status === 'needs_clarification') {
    // 导入时自动生成的同名指标碰撞是目录表达问题；让只读 SQL 按完整列定义求解，保留人工口径的真正歧义。
    if(code===CODES.AMBIGUOUS_METRIC && o.registry && !o.confirmedIR && !o.confirmedPlan){
      const options=(r.errors||[]).filter(e=>e.code===code).flatMap(e=>e.options||[]);
      if(options.length>1 && options.every(x=>{try{const m=o.registry.metric(x.id||x);return m.auto&&!m.confirmed;}catch(_){return false;}}))return true;
    }

    if(code===CODES.MISSING_TIME_ROLE&&(r.errors||[]).some(e=>/^IR 选了不存在的时间角色/.test(String(e.message))))return true;
    if ([CODES.PLAN_INCOMPLETE, CODES.IR_INVALID, CODES.UNKNOWN_METRIC, CODES.UNKNOWN_DIM, CODES.UNSUPPORTED_OPERATOR, CODES.ENTITY_NOT_FOUND, 'bad_shape', 'bad_enum'].includes(code)) return true;
    // 对象对不上：本机核对也没找到（或本来就没有真实选项）→ 不是用户没说清，是配置单这边的目录里没有，转兜底按表关系去查
    if (code === CODES.AMBIGUOUS_ENTITY && (r.entity_unmatched || !(Array.isArray(r.options) && r.options.length))) return true;
    // 「分组对象」的候选不是语义包里的维度编号（模型在候选里没找到这个分组）→ 是系统缺候选，不是用户没说清
    if (code === 'ambiguous_dim') { const opts = Array.isArray(r.options) ? r.options : []; return opts.length > 0 && opts.every(x => !/^d:/.test(String(x))); }
    return false;
  }
  return ['self_check_failed', CODES.PLAN_INCOMPLETE, CODES.IR_INVALID, CODES.UNSUPPORTED_OPERATOR, CODES.UNKNOWN_METRIC, CODES.UNKNOWN_DIM, 'bad_shape', 'bad_filter', 'bad_plan', 'unsupported_operator', 'fanout', 'missing_relationship', 'execution_error', 'executor_error'].includes(code);
}

function scalarExtremum(question, plan){
  const text=String(question||'');
  if(plan?.dimensions?.length||plan?.grain||plan?.rank&&(plan.rank.top!==1||plan.output_shape!=='scalar')||plan?.comparison&&plan.comparison.kind!=='none')return null;
  const chineseValue=/(?:多少|几)(?:天|日|元|件|个|次|米|千克|公斤|小时|分钟)?[？?。.!！\s]*$/.test(text);
  const englishValue=/\b(?:what|give|return|show|calculate|how (?:high|low|long))\b/i.test(text)&&!/\b(?:which|who|rank(?:ing)?|top\s*\d+)\b/i.test(text);
  if(!chineseValue&&!englishValue)return null;
  if(/前\s*\d|第\s*[一二三四五六七八九十\d]|哪些|哪几个|哪个|谁|排名|排行|[一二三四五六七八九十百\d]+\s*(?:个|款|家|名|种|笔|条)/.test(text))return null;
  return /最长|最久|最老|最旧|最大|最高|最贵|最多|\b(?:max(?:imum)?|highest|largest|longest|most expensive)\b/i.test(text)?'max':/最短|最小|最低|最便宜|最少|\b(?:min(?:imum)?|lowest|smallest|shortest|cheapest)\b/i.test(text)?'min':null;
}

// 拒答时点名用户问的那个概念(用用户自己的原词),让用户一眼看出「缺的是哪一样」。
// 经典做法:不可回答问题的拒答要说明缺的是什么(TrustSQL 等基准把「缺 schema 元素」作为一类并要求明确拒答)。
// 只抽题面原词,不含数字(避免拒答里出现数字),已经出现在回答里的不重复。
function askedConcepts(question){
  const q=String(question||'').trim(),out=[];
  const add=x=>{x=String(x||'').replace(/^(?:the|a|an|各|每个|每一|所有)\s*/i,'').replace(/[\s,，。？?]+$/,'').trim();if(/(?:时|时候|之前|之后)$/.test(x))return;if(x.length>=2&&x.length<=40&&!/\d/.test(x)&&!out.includes(x))out.push(x);};
  const en=q.match(/\b(?:what(?:'s| is| are| was| were)?|how (?:much|many)|give|show|report|calculate|compute|list)\s+(?:is\s+|are\s+)?(?:the\s+|a\s+|an\s+)?(.+?)(?=\s*(?:,|\?|\.|\bfor\b|\bin\b|\bof (?:each|all|the|every)\b|\bper\b|\bby\b|\bacross\b|\bamong\b|\bduring\b|\bagreed\b|\bwith\b|\bthat\b|\bwhich\b|\bwho\b|\bwhen\b|$))/i);
  if(en)add(en[1]);
  for(const m of q.matchAll(/[\u201c\u300c\u300e"]([^\u201d\u300d\u300f"]{2,20})[\u201d\u300d\u300f"]/g))add(m[1]);
  for(const m of q.matchAll(/各([^，。？?的]{2,12})的([^，。？?]{2,14}?)(?=是多少|有多少|为多少|是什么|是怎样|[？?。，]|$)/g)){add(m[1]);add(m[2]);}
  for(const m of q.matchAll(/的([^，。？?的]{2,14}?)(?=是多少|有多少|为多少|是什么)/g))add(m[1]);
  // P79:「计算/给出/求/统计/分析 X」里的 X 也是所问概念(B4:「给出客户复购率」「分析各商品在缺货期间的持续天数」)
  for(const m of q.matchAll(/(?:计算|给出|求出|求|统计|分析|列出|算出|算一下)(?:一下)?(?:各|每个|每一|所有)?([^，。？?；\s]{2,16}?)(?=[，。？?；]|并|，|$)/g))add(m[1].replace(/^(?:按[^，。]{1,8}?(?:给出|列出))/,''));
  return out.slice(0,3);
}
function withAskedConcept(question,r){
  if(!r||r.status==='ok'||r.code==='value_choice'||(r.facts||[]).length)return r;
  // 只给「数据里确实缺东西」的拒答点名;查询没通过检查(sql_failed)等不是缺字段,不能误说「没有字段」
  if(!['sql_abstain','missing_required_input'].includes(String(r.route||''))&&!['unknown_metric'].includes(String(r.code||'')))return r;
  const ans=String(r.answer||'');if(!/^(?:ANSWER:\s*)?无法回答/.test(ans.split('\n').find(Boolean)||'')&&!/\nANSWER:\s*无法回答/.test(ans))return r;
  const miss=askedConcepts(question).filter(x=>!ans.includes(x));if(!miss.length)return r;
  const note='（所问的'+miss.map(x=>'「'+x+'」').join('')+'在现有数据里没有可以直接计算的字段）';
  const lines=ans.split('\n');let i=lines.findIndex(l=>/^ANSWER:/.test(l));if(i<0)i=lines.length-1;
  lines[i]=lines[i].replace(/(。?)\s*$/,note+'$1');
  return Object.assign({},r,{answer:lines.join('\n'),asked_concepts:miss});
}
async function ask(question, o = {}){ return withAskedConcept(question, await askInner(question, o)); }
async function askInner(question, o = {}){
  const { scopedRegistry, assertCurrent } = require('./request-context');
  assertCurrent(o);
  o = Object.assign({}, o, { registry: scopedRegistry(o.registry, o.scope) });
  const required=require('./required-inputs').missingRequiredInput(question,o.registry);
  if(required?.local_reject||required?.local_clarify){const calls=makeCallLog(o.callLog),usage=sumUsage(calls);return {status:required.local_clarify?'needs_clarification':'capability_gap',code:required.code||CODES.CAPABILITY_GAP,route:'missing_required_input',answer:'无法回答：数据里没有'+required.missing+'；'+required.reason+'。',facts:[],trace:{question,layers:[{layer:'required_input',missing:required.concept}],route:'missing_required_input',notes:[]},llm_calls:calls.length,calls_this_turn:0,zero_llm:calls.length===0,tokens:{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,total_tokens:usage.total_tokens,calls:usage.calls,unknown_calls:usage.unknown_calls}};}
  const sqlOn = o.sqlLane !== false && typeof o.sqlRunner === 'function' && typeof o.resolveIR === 'function' && !!o.registry;
  if (!sqlOn) return askConfig(question, o);
  const callLog = makeCallLog(o.callLog);
  const seed = callLog.length;
  const o2 = Object.assign({}, o, { callLog });
  const maxTotal = Number.isFinite(o.maxCallsTotal) ? o.maxCallsTotal : DEFAULT_MAX_CALLS_TOTAL;
  const registry = o.registry, tz = o.timezone || 'Asia/Shanghai';


  const cache = o.cache || new ReuseCache(o.cacheStore ? { store: o.cacheStore } : undefined);
  o2.cache = cache;
  const context = lane.contextFromRegistry(registry, { types: await columnTypesOf(o.sqlRunner, registry) });
  const dataDateCoverage=/最早/.test(String(question))&&/最晚/.test(String(question))&&/缺/.test(String(question))&&/天|日/.test(String(question))&&context.tables.some(t=>t.columns.some(c=>/DATE|TIMESTAMP/i.test(c.type)));
  // 10-24：试过把类别列的取值清单给兜底（对「断货」「预警」这类说法），但这样真实取值就出了本机，违反「模型看不到取值」的约定，不做。
  // 改由模型照题面原话写取值（如 shelf_status = '断货'），本机核对不存在时按取值匹配（缩写 + 中英向量）对到真实取值或让用户选。
  const lctx = { run: o.sqlRunner, context, signal: o.signal, cancel: o.cancelSql };
  const tpl = questionTemplate(question, { registry, anchor: o.anchor, entityLookup: o.entityLookup });
  const tplCtx = { semantic: registry.stamp(), code: o.codeVersion || 'compute/1', permission: o.permissionVersion || 'perm/1' };
  let localPlan = null; try { localPlan = parsePlan(question,{registry,anchor:o.anchor,timezone:tz,entityLookup:o.entityLookup,scope:o.scope}); } catch (_) {}
  const sqlContext=require('./sql-context'),shortTables=sqlContext.tableAliases(context);
  let selected = sqlContext.selectContext(context,registry,localPlan,question);
  // P78:问计划达成率且有用户确认的计划指标 → 实际和计划两张表都要给到 SQL 通道(只给结构,不给数据)
  try{ if(/达成|完成率|完成了|(?:占|是)[^，。；]{0,12}(?:计划|目标|预算)|计划(?:的)?(?:百分|多少)/.test(String(question))&&context.metrics.some(m=>m.confirmed&&!m.auto&&/计划|目标|预算/.test([m.name,...(m.aliases||[])].join(' ')))&&selected.context!==context) selected={context,reason:'goal_rate_actual_and_plan'}; }catch(_){}
  let period = null; try { period = require('./plan-ir').parsePeriod(question, o.anchor, { timezone: tz }); } catch (_) {}
  if (!period) { try { const ep = require('./sql-constraints').englishPeriod(question); if (ep) period = Object.assign({ timezone: tz, interval: '[start,endExclusive)' }, ep); } catch (_) {} }
  if (!period) { try { const sp = require('./sql-constraints').snapshotDayPeriod(question, o.anchor); if (sp) period = Object.assign({ timezone: tz, interval: '[start,endExclusive)' }, sp); } catch (_) {} }
  const tplEntities = tpl ? tpl.entityDims.map((d, i) => ({ dim: d, value: tpl.entityValues[i] })) : [];
  const audit = (e) => { try { if (typeof o.audit === 'function') o.audit(Object.assign({ at: new Date().toISOString() }, e)); } catch (_) {} };
  const done = (r, extra) => {
    const u = sumUsage(callLog);
    const out = Object.assign({}, r, extra || {});
    out.llm_calls = callLog.length; out.calls_this_turn = callLog.length - seed; out.zero_llm = callLog.length === 0;
    out.tokens = Object.assign({}, r && r.tokens, { input_tokens: u.input_tokens, output_tokens: u.output_tokens, reasoning_tokens: u.reasoning_tokens, total_tokens: u.total_tokens, calls: u.calls, unknown_calls:u.unknown_calls, cache_read_tokens:u.cache_read_tokens, cache_write_tokens:u.cache_write_tokens, uncached_input_tokens:u.uncached_input_tokens, over_budget:u.total_tokens == null ? null : u.total_tokens > (o.maxTokensPerQuestion ?? DEFAULT_MAX_TOKENS) });
    return out;
  };

  // ---------- 用户在「这几个里选哪个」里点了一个：本机直接换值重算，0 次调用 ----------
  if (o.valueChoice && o.valueChoice.sql && o.valueChoice.literal != null && o.valueChoice.value != null) {
    const vc = o.valueChoice;
    const sql3 = swapLiteral(String(vc.sql), String(vc.literal), String(vc.value));
    const trace3 = { question, schema: PLAN_SCHEMA, layers: [{ layer: 'sql_value_choice' }], route: 'sql_value_choice', notes: [] };
    const got3 = await runChecked(sql3, { label: vc.label || '', unit: vc.unit || '' }, { noValueFix: true });
    if (got3.ok) {
      try { if (typeof o.rememberValue === 'function') await o.rememberValue(String(vc.literal), { table: vc.table, col: vc.col, value: String(vc.value) }); } catch (_) {}
      return done(Object.assign(got3.result, { route: 'sql_value_choice', trace: trace3 }));
    }
    return done({ status: 'error', code: 'value_choice_failed', route: 'sql_value_choice', lane: 'sql', trace: trace3,
      answer: '无法回答：按你选的写法重新计算没有通过本机检查。为避免给错数字，本次没有给出结果。' });
  }

  // ---------- 兜底模板：同一句换日期 / 对象 → 用参数换掉 SQL 里的字面值 → 重新检查 → 执行，0 次调用 ----------
  if (tpl) {
    try {
      const hit = cache.getTemplate(tpl.template, o.scope, tplCtx);
      if (hit && hit.kind === 'sql' && hit.sql) {
        const trace = { question, schema: PLAN_SCHEMA, layers: [{ layer: 'sql_template', hit: true }], route: null, notes: [] };
        let why = null, sql2 = null;
        if (JSON.stringify((hit.entity_dims || []).slice().sort()) !== JSON.stringify(tpl.entityDims.slice().sort())) why = 'entity_slots_differ';
        else if ((hit.params || []).some(p => p.role !== 'entity') && !(period && hit.grain && period.grain === hit.grain)) why = 'period_not_rebound';
        else { sql2 = lane.rebindSql(hit.sql, hit.params, period, tplEntities); if (!sql2) why = 'params_not_rebound'; }
        if (!why) {
          let label2 = String(hit.label || '');
          for (const p of hit.params || []) if (p.role === 'entity') { const ne = tplEntities.find(e => String(e.dim) === String(p.dim)); if (ne) label2 = label2.split(String(p.value)).join(String(ne.value)); }
          const res = await runChecked(sql2, { unit: hit.unit, label: label2 });
          audit({ kind: 'sql_template', question, sql: sql2, tables: res.check ? res.check.tables : [], tier: res.tier || null, ok: !!res.ok });
          if (res.ok) {
            trace.route = 'sql_template';
            return done(Object.assign(res.result, { route: 'sql_template', trace }));
          }
          why = 'rerun_failed';
        }
        trace.notes.push('sql_template_rejected:' + why);
      }
    } catch (err) { /* 模板复用失败就正常走 */ }
  }

  const roleGap=require('./sql-constraints').unconfirmedRole(question,context,registry,o.entityLookup);
  if(roleGap&&!o.confirmedIR&&!o.confirmedPlan&&!o.valueChoice&&!cache.getEntry(question,o.scope,tplCtx))return done({status:'needs_clarification',code:'role_mapping_unconfirmed',route:'role_mapping_unconfirmed',facts:[],answer:'无法回答：'+roleGap.role+'尚未与角色代码确认对应；角色字段已存在，但不能用保单编号或其他角色代替。请明确角色代码后重问。',trace:{question,layers:[{layer:'role_mapping',field:roleGap.field,confirmed:false}],route:'role_mapping_unconfirmed',notes:[roleGap.reason]}});
  // 明知配置单表达不了（第 N 名 / 星期几）：本机先解析一次，题面有「表达不了」的条件词就跳过配置单这一次模型调用，直接走兜底
  let knownNullLabel = false;
  for (const word of ['未填写','未提供']) if (String(question).includes(word)) { try { if (o.entityLookup?.resolve(word)?.status === 'matched') knownNullLabel = true; } catch (_) {} }
  let skipSlot = dataDateCoverage ? 'data_date_coverage' : required ? 'missing_required_input' : !knownNullLabel && /为空|空值|空白|没填|未填|未提供|\b(?:null|missing|blank)\b/i.test(String(question)) ? 'null_predicate' : null, skipAnswer = null;
  try {
    const pl0 = localPlan || parsePlan(question, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, scope: o.scope });
    const snapshotMetric=(pl0.metric_ids||[]).some(id=>{try{return registry.metric(id).additivity==='semiAdditive'||registry.leaves(id).some(leaf=>registry.metric(leaf).additivity==='semiAdditive');}catch(_){return false;}});
    const datedSnapshots=(String(question).match(/(?:\d{4}[-年/])?\d{1,2}[.月/-]\d{1,2}(?:日)?/g)||[]).length;
    if(snapshotMetric&&datedSnapshots>=2&&/断货|缺货|状态|转为|变成|恢复/.test(String(question))&&/到|至|变|恢复|已经|这期|现在/.test(String(question))&&!o.confirmedIR&&!o.confirmedPlan&&!cache.getEntry(question,o.scope,tplCtx))skipSlot='cross_snapshot_state_requires_sql';
    const duration=require('./sql-constraints').dateDifferenceRoles(question,context);
    if(require('./sql-constraints').requiredRoleMappings(question,context).length&&[...registry.semantic.metrics.values()].every(m=>m.auto&&!m.confirmed)&&!o.confirmedIR&&!o.confirmedPlan&&!cache.getEntry(question,o.scope,tplCtx))skipSlot='declared_role_condition_requires_sql';
    if(!o.confirmedIR&&!o.confirmedPlan&&!cache.getEntry(question,o.scope,tplCtx)&&require('./sql-constraints').subtypeAmountNeedsSql(question,context,registry))skipSlot='subtype_amount_requires_sql';
    if(duration&&!o.confirmedIR&&!o.confirmedPlan&&!cache.getEntry(question,o.scope,tplCtx)&&!(pl0.metric_ids||[]).some(id=>{try{const m=registry.metric(id),text=[m.name,...m.aliases||[]].join(' ');return m.unit==='天'&&duration.roles.every(role=>text.includes(role));}catch(_){return false;}}))skipSlot='date_difference_requires_sql';
    if(snapshotMetric&&/当前|目前|最新|现在|此刻/.test(String(question))&&!/本月|今年|昨天|上月|上期|去年|最近|近\d|\d{4}|\d{1,2}[月日./-]/.test(String(question))&&(!pl0.comparison||pl0.comparison.kind==='none')&&!o.confirmedIR&&!o.confirmedPlan&&!cache.getEntry(question,o.scope,tplCtx))skipSlot='latest_snapshot_requires_max_date';
    if(snapshotMetric&&pl0.rank&&period?.start&&period.end&&period.start!==period.end&&/(?:从|由).+(?:到|至)/.test(String(question))&&/涨得|降得|增长|增加|减少|变化|变动|上涨|下降/.test(String(question)))skipSlot='rank_snapshot_delta';
    if (pl0.metric_ids?.length===1 && /平均|均值/.test(String(question))) {
      const m=registry.metric(pl0.metric_ids[0]);
      if(m.kind==='simple' && m.agg==='sum' && !pl0.formula?.den) skipSlot='aggregation_override';
    }
    if(pl0.metric_ids?.length===1 && /合计|加总|总和/.test(String(question)) && !/平均|均值/.test(String(question))) {const m=registry.metric(pl0.metric_ids[0]);if(m.kind==='simple'&&m.agg==='avg')skipSlot='aggregation_override';
    }
    const scalarOp=scalarExtremum(question,pl0);
    if(scalarOp&&pl0.metric_ids?.length===1&&!o.confirmedIR&&!o.confirmedPlan&&!cache.getEntry(question,o.scope,tplCtx)){const metric=registry.metric(pl0.metric_ids[0]),agg=pl0.formula?.kind==='simple'?pl0.formula.agg:metric.agg;if(agg!==scalarOp)skipSlot='extremum_aggregation_override';}

    if(require('./sql-constraints').rankedSubsetAggregate(question)&&!o.confirmedIR&&!o.confirmedPlan&&!cache.getEntry(question,o.scope,tplCtx))skipSlot='aggregate_ranked_subset_requires_sql';
    const bad = unmappedConditions(question, pl0, { registry, anchor: o.anchor, timezone: tz, entityLookup: o.entityLookup, dict: o.dict }).find(u => u && u.unrepresentable);
    if (bad) { skipSlot = bad.slot; skipAnswer = bad.answer || null; }
  } catch (_) { skipSlot = null; }
  if(require('./sql-constraints').decimalRatioOutput(question)&&!o.confirmedIR&&!o.confirmedPlan&&!cache.getEntry(question,o.scope,tplCtx))skipSlot='explicit_decimal_ratio_requires_sql';
  if(!skipSlot&&require('./sql-constraints').rawSnapshotSum(question,context).length&&!o.confirmedIR&&!o.confirmedPlan)skipSlot='explicit_raw_snapshot_sum';
  if(!skipSlot&&require('./sql-constraints').rowNumericFilter(question)&&!require('./sql-constraints').rowCountShareQuestion(question)&&!o.confirmedIR&&!o.confirmedPlan)skipSlot='row_numeric_filter_requires_sql';
  const r = skipSlot
    ? { status: 'capability_gap', code: 'capability_gap', plan: null,
        trace: { question, schema: PLAN_SCHEMA, layers: [], route: null, notes: ['skip_config_unrepresentable:' + skipSlot] },
        answer: skipAnswer || ('无法回答：配置单表达不了这个问法（' + skipSlot + '）。') }
    : await askConfig(question, o2);
  if (!shouldFallback(r, o)) return done(r);
  const trace = r.trace || { question, layers: [], notes: [] };
  trace.layers.push({ layer: 'sql_context', reason:selected.reason, tables:selected.context.tables.length, full_tables:context.tables.length,table_aliases:Object.fromEntries(shortTables) });
  trace.layers.push({ layer: 'sql_lane', from: r.status + '/' + (r.code || '') });
  let prevErr = null, narrowAbstain = null;
  const entitiesForModel = (() => {
    try {
      const sig = extractSignals(question, { registry, anchor: o.anchor, entityLookup: o.entityLookup }) || {};
      return (sig.entities || []).filter(e => e && e.dim && e.value != null).map(e => {
        let f = null; try { const d = registry.dim(e.dim); f = d && d.source ? d.source.table + '.' + d.source.field : null; } catch (_) {}
        return { dim: f || String(e.dim).replace(/^d:/, ''), value: String(e.value) };
      }).filter(e => String(question).includes(e.value));
    } catch (_) { return []; }
  })();
  // (P78 曾试过把题面里所有逐字出现的目录取值连同字段都告诉模型;正式内部评测发现同一取值落在预聚合汇总表上时会把模型引去用汇总表，回退，不再这样做)
  // P78:题面里登记过的中文专名（亚马逊/虾皮/抖音海外版…）在目录里唯一对应的英文取值，也作为已核实对象告诉模型（说法→取值）
  try { if (o.entityLookup && o.entityLookup.index) { const hit = valueMatch.explicitNominalAlias(question, { lookup: o.entityLookup, dimIds: [...o.entityLookup.index.keys()] });
    if (hit && !entitiesForModel.some(e => e.value === hit.value)) { let f = null; try { const d = registry.dim(hit.dim); f = d && d.source ? d.source.table + '.' + d.source.field : null; } catch (_) {}
      void f; /* P79:目录取值不在题面里,不出站;改由本机在 SQL 里把题面专名换成目录取值 */ } } } catch (_) {}
  for (let attempt = 0; attempt < SQL_LANE_TRIES; attempt++) {
    require('./request-context').assertCurrent(o);
    if (callLog.length - seed >= maxTotal) { trace.notes.push('sql_lane_call_cap'); break; }
    const payload = {
      lane: 'sql', question, anchor: o.anchor || null, timezone: tz, sql_context: sqlContext.aliasContext(selected.context,shortTables),
      period: period ? { start: period.start, end: period.end, end_exclusive: period.endExclusive } : null,
      entities: sqlContext.aliasContext({entities:entitiesForModel},shortTables).entities, previous_errors: prevErr ? [prevErr] : null,
    };
    let res = null;
    try { res = await o.resolveIR(payload); } catch (err) { if(['stale_request','cancelled','data_changing'].includes(err?.code))throw err; res = { ok: false, code: 'model_error', message: String(err && err.message || err), thrown: true }; }
    pushCall(callLog, Object.assign({purpose: attempt ? 'sql_repair' : 'sql'},res || {}), o.provider);
    if (!res || !res.ok) { prevErr = '上次没有返回合法 JSON：只输出一个 JSON 对象'; trace.notes.push('sql_lane_model_error'); continue; }
    const outp = res.ir || res.plan || {};
    if(required)outp.abstain='缺少'+required.missing+'；'+required.reason;
    // 第三轮：模型自己在说明里承认是拿别的字段顶替 / 近似 / 字段缺失 → 不给这个数，按「数据里没有」答
    if (!outp.abstain && SUBSTITUTE_RE.test(String(outp.label || ''))) { outp.abstain = String(outp.label); trace.notes.push('sql_lane_self_declared_substitute'); }
    // P79:扩到完整目录只有在能多出新字段时才有意义;多出来的只是同名列的副本表(raw_/c_ 等血缘副本)时,
    // 模型已在同样的字段里判了缺失,再问一次只多花一次调用(B4 里 10 次扩展全部仍是拒答),直接按缺失回答。
    const expandAddsFields = () => { const names = ctx => new Set((ctx.tables || []).flatMap(t => (t.columns || []).filter(c => !(c && c.system === true) && !/^_/.test(String(c.name || c))).map(c => String(c.name || c).toLowerCase()))); const have = names(selected.context); return [...names(context)].some(n => !have.has(n)); };
    if (outp.abstain && selected.context !== context && !required && !expandAddsFields()) trace.notes.push('expand_skipped_no_new_fields');
    else if (outp.abstain && selected.context !== context && !required) { narrowAbstain={tables:new Set(selected.context.tables.map(t=>t.name)),reason:String(outp.abstain)}; selected={context,reason:'expand_candidate_miss'}; prevErr='candidate_scope_expanded: 在完整准许目录重核必要字段，确实缺失才abstain';trace.notes.push('sql_context_expanded');continue; }
    if (outp.abstain) {
      trace.route = 'sql_abstain';
      audit({ kind: 'sql_fallback', question, sql: null, tables: [], tier: null, ok: false, abstain: true });
      const base = r.status === 'capability_gap' && /^无法回答/.test(String(r.answer || '')) ? String(r.answer) : '无法回答：数据里没有能回答这个问题的字段。';
      const reason = stripDigitTokens(outp.abstain).slice(0, 60);
      return done(r, { status: 'capability_gap', code: CODES.CAPABILITY_GAP, route: 'sql_abstain', lane: 'sql', trace,
        answer: reason ? base.replace(/。?$/, '') + '（' + reason + '）。为避免给错数字，本次没有给出结果。' : base });
    }
    let sql = typeof outp.sql === 'string' ? outp.sql : '';
    try{sql=await sqlContext.restoreAliases(sql,shortTables,o.sqlRunner);outp.sql=sql;
      for(const param of outp.params||[])if(typeof param.dim==='string')for(const [real,short]of shortTables)if(param.dim===short||param.dim.startsWith(short+'.'))param.dim=real+param.dim.slice(short.length);
    }catch(_){prevErr='SQL标识符还原失败，请返回完整合法SQL';continue;}
    if (!sql.trim()) { prevErr = '上次没有给出 sql 字段'; continue; }
    const got = await runChecked(sql, outp);
    audit({ kind: 'sql_fallback', question, sql, tables: got.check ? got.check.tables : [], tier: got.tier || null, ok: !!got.ok });
    if (!got.ok && got.stage === 'value_choice') {   // 要用户选：不执行、不交回模型（这条不进 previous_errors）
      trace.route = 'sql_value_choice';
      audit({ kind: 'sql_fallback', question, sql, tables: got.check ? got.check.tables : [], tier: null, ok: false, value_choice: true });
      return done(Object.assign({}, got.result, { trace }));
    }
    if (!got.ok) { if (selected.context !== context && got.stage==='check') selected={context,reason:'expand_sql_reference'}; let message=got.stage==='run'?lane.executionRepairError(got.error,context,got.check):String(got.error||'');if(got.stage==='run'&&/^conversion_error/.test(message)){try{message+=await yearMonthTextHint(got.check);}catch(_){}}for(const [real,short]of shortTables)message=message.split(real).join(short);prevErr=got.stage==='run'?message:lane.sanitizeError(message); trace.notes.push('sql_lane_failed:' + (got.stage || '') + ':' + String(got.error || '').split(/[:：]/)[0].slice(0, 48)); trace.layers.push({ layer: 'sql_check', ok: false, stage: got.stage }); continue; }
    // 扩到完整目录只为找「候选范围外」的字段；若扩后答案只用了候选范围里早已完整给过的表（同表字段全保留），
    // 模型在同样信息下先判缺失、被要求重核后又给数 → 两次判断自相矛盾，按先前的缺失判断拒答，不给可能是顶替字段的数。
    if (narrowAbstain && (got.check?.tables||[]).length && got.check.tables.every(t=>narrowAbstain.tables.has(t))) {
      trace.route = 'sql_abstain'; trace.notes.push('expanded_answer_uses_only_narrow_tables');
      audit({ kind: 'sql_fallback', question, sql: null, tables: [], tier: null, ok: false, abstain: true, overruled_sql: true });
      const base = r.status === 'capability_gap' && /^无法回答/.test(String(r.answer || '')) ? String(r.answer) : '无法回答：数据里没有能回答这个问题的字段。';
      const reason = stripDigitTokens(narrowAbstain.reason).slice(0, 60);
      return done(r, { status: 'capability_gap', code: CODES.CAPABILITY_GAP, route: 'sql_abstain', lane: 'sql', trace,
        answer: reason ? base.replace(/。?$/, '') + '（' + reason + '）。为避免给错数字，本次没有给出结果。' : base });
    }
    trace.route = 'sql_fallback';
    trace.layers.push({ layer: 'sql_check', ok: true, tier: got.tier });
    // 兜底成功且不是未核 → 存「兜底模板」（问法模板同一套键）；参数换不全就不存
    if (tpl && got.tier !== 'unverified') {
      const params = lane.templateParams(got.sql, period, tplEntities, outp.params);
      const dateParams = params && params.some(p => p.role !== 'entity');
      if (params && (!dateParams || (period && period.grain)) && (tpl.nDates === 0 || dateParams)) {
        try { cache.putTemplate(tpl.template, { kind: 'sql', sql: got.sql, unit: outp.unit || '', label: outp.label || '', params, grain: period ? period.grain : null, entity_dims: tpl.entityDims, tier: got.tier }, o.scope, tplCtx); trace.layers.push({ layer: 'sql_template_put' }); } catch (_) {}
      }
    }
    return done(Object.assign(got.result, { route: 'sql_fallback', trace }));
  }
  // 兜底也没成：明确说答不了（不放兜底里的任何数据值）
  trace.route = 'sql_failed';
  const refuse = /^无法回答/.test(String(r.answer || '')) ? String(r.answer) : '无法回答：现在的计算方式表达不了这个问题，兜底查询也没通过本机检查。为避免给错数字，本次没有给出结果。';
  return done(r, { route: 'sql_failed', lane: 'sql', trace, answer: refuse });

  // P78:日期转换失败时,本机看一下所涉文本列是不是「年-月」写法(只报格式,不报取值),帮模型改成按字符串比较
  async function yearMonthTextHint(check){
    const cols=((check&&check.columns)||[]).filter(c=>c&&c.table&&c.col);const out=[];const types=await columnTypesOf(o.sqlRunner,registry).catch(()=>({}));
    for(const c of cols.slice(0,6)){
      const t=types[String(c.table).toLowerCase()]?.[String(c.col).toLowerCase()];if(t&&!/CHAR|TEXT|STRING/.test(t))continue;
      const q=x=>'"'+String(x).replace(/"/g,'""')+'"';
      const r=await o.sqlRunner(`SELECT AVG(CASE WHEN regexp_full_match(CAST(${q(c.col)} AS VARCHAR),'\\d{4}-\\d{2}') THEN 1 ELSE 0 END) AS p FROM ${q(c.table)} WHERE ${q(c.col)} IS NOT NULL`);
      const p=Number((Array.isArray(r)?r:(r&&r.rows)||[])[0]?.p);if(p>=0.6)out.push(c.col+'是文本年月(YYYY-MM)，按字符串比较年月边界(如 >= \'YYYY-MM\')，不要CAST成DATE；其中不合规的月份会被字符串边界自然排除');
    }
    return out.length?'；'+[...new Set(out)].join('；'):'';
  }
  // 对每个缺失的字面值：先查叫法记忆，再本机找候选；auto 直接换，ask 返回给用户选，none 留给模型重写
  async function fixMissingValues(sql, miss){
    let cur = sql; const guesses = [], rest = [];
    for (const m of miss) {
      const exact=valueMatch.exactQuestionValue({question,table:m.table,col:m.col,registry,lookup:o.entityLookup});
      if(exact){cur=swapLiteral(cur,m.value,exact);guesses.push({literal:m.value,value:exact,table:m.table,col:m.col});continue;}
      let alias = null;
      try { const a = typeof o.lookupValueAlias === 'function' ? await o.lookupValueAlias(m.value, { table: m.table, col: m.col }) : null; alias = a && typeof a === 'object' ? a.value : a; } catch (_) {}
      if (alias != null && String(alias) !== '' && String(alias) !== String(m.value)) { cur = swapLiteral(cur, m.value, String(alias)); guesses.push({ literal: m.value, value: String(alias), table: m.table, col: m.col }); continue; }
      let cands = [];
      try { cands = await valueMatch.findValues({ run: o.sqlRunner, table: m.table, col: m.col, queries: [m.value], limit: 5, vecScore: o.vecScore, vecBatch: o.vecBatch }); } catch (_) {}
      const dec = valueMatch.decide(cands);
      if (dec.mode === 'auto') { cur = swapLiteral(cur, m.value, dec.value); guesses.push({ literal: m.value, value: dec.value, table: m.table, col: m.col }); continue; }
      if (dec.mode === 'ask') {
        return { choice: { status: 'needs_clarification', code: 'value_choice', route: 'sql_value_choice', lane: 'sql',
          answer: '无法回答：尚未确认具体对象。这几个里哪个是你说的「' + m.value + '」？（选完直接算，不再问模型）',
          value_choice: { sql: cur, literal: m.value, table: m.table, col: m.col, options: dec.options } } };
      }
      rest.push(m);
    }
    if (rest.length) return { rest, guesses: [], sql: null };
    return { sql: cur, guesses };
  }

  // 检查 → 执行 → 可信档 → 事实编号 → 答案（模型看不到这里的任何值）
  async function runChecked(sql, outp, ropt = {}){
    require('./request-context').assertCurrent(o);
    let chk = await lane.checkSql(sql, lctx);
    if (!chk.ok) return { ok: false, stage: 'check', error: chk.errors.join('；'), check: chk };
    if (require('./sql-constraints').rowAverageRatioGap(question,chk)) {
      chk=await lane.normalizePerUnitAverage(chk,lctx);
      if(!chk.ok)return {ok:false,stage:'check',error:chk.errors.join('；'),check:chk};
      if(chk.per_unit_weighting_normalized)audit({kind:'sql_local_normalization',normalization:'per_unit_weighting',conditions_preserved:true});
    }
    const objectCount=/有(?:几|多少)(?:个|款|种|行|条|张)|(?:几|多少)(?:个|款|种|行|条|张)(?:[，。；?？]|$)/.test(String(question))&&!/销售额|成交额|总额|金额|收入|成本|费用|利润|GMV|revenue|amount/i.test(String(question));
    if(objectCount&&!chk.cases&&!chk.aggregates.some(a=>a.fn==='count')&&chk.aggregates.some(a=>a.fn==='sum'&&a.col))return {ok:false,stage:'constraint',error:'count_unit_mismatch: 题面询问对象个数或行数，不能用数量或金额字段SUM顶替；保留条件，按题意COUNT或COUNT(DISTINCT业务标识)',check:chk};
    // 业务数据问数不能用模型自填的常数冒充查询结果；安全SELECT不等于有数据依据。
    if (!chk.tables.length && context.tables.length) return {ok:false,stage:'constraint',error:'missing_data_source: 必须从准许业务表读取所需字段，不能填常数或编造日期边界',check:chk};
    if(dataDateCoverage&&!period){
      let invented=false;const scan=x=>{if(Array.isArray(x))return x.forEach(scan);if(!x||typeof x!=='object')return;if(x.class==='CONSTANT'&&typeof x.value?.value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.value.value)&&!String(question).includes(x.value.value))invented=true;Object.values(x).forEach(scan);};scan(chk.ast);
      if(invented)return {ok:false,stage:'constraint',error:'unsupported_data_boundary: 数据起止日期必须从日期列MIN/MAX取得，不能用未提供的日期常量或anchor代替',check:chk};
    }
    const timeEvidence=/\d{4}\s*年|\d{1,2}\s*月|[上下本去今前近这那][^，。；]{0,5}[年月周日期季天]|全年|盘点|期末|快照|当前|目前|最新|截至|as of|latest|current/i.test(String(question));
    const snapshot=chk.columns.some(c=>context.metrics.some(m=>m.dataset===c.table&&m.field===c.col&&m.additivity==='semiAdditive'));
    if(!period && !timeEvidence && !snapshot && !(o.scope?.filters?.length)) {
      try { chk = await lane.removeUnsupportedDates(chk,lctx); } catch (_) {return {ok:false,stage:'constraint',error:'unsupported_date_filter: 无依据日期过滤未能安全移除',check:chk};}
      if(!chk.ok)return {ok:false,stage:'check',error:chk.errors.join('；'),check:chk};
    }
    if(require('./sql-constraints').periodMissingInSql(period,chk.sql))return {ok:false,stage:'constraint',error:'explicit_period_missing: 题面明确的期间没有落到SQL条件；按已声明的日期列加 [期间开始, 期间结束次日) 条件，保留其他筛选',check:chk};
    {const fixes=require('./sql-constraints').entitySpanRepairs(question,o.entityLookup,chk).concat(require('./sql-constraints').nominalAliasRepairs(question,o.entityLookup,chk));
     if(fixes.length){let s2=String(chk.sql||sql);for(const f of fixes)s2=s2.split("'"+f.from.replace(/'/g,"''")+"'").join("'"+f.to.replace(/'/g,"''")+"'");
      const c2=await lane.checkSql(s2,lctx);if(c2.ok){chk=c2;if(outp&&typeof outp.label==='string')for(const f of fixes)outp.label=outp.label.split(f.from).join(f.to);audit({kind:'sql_local_normalization',normalization:'entity_span_trim',fixes});}}}
    const omitted=await require('./sql-constraints').missingEntities(question,o.entityLookup,registry,chk,o.sqlRunner);
    const aggregateRefs=chk.aggregates.filter(a=>a.col).map(a=>({table:a.col.table,field:a.col.col,agg:a.fn}));
    if(require('./sql-constraints').rowCountShareSqlGap(question,chk))return {ok:false,stage:'constraint',error:'row_count_share_measure: 所问是符合条件的行数/全部行数；使用COUNT(*) FILTER或0/1条件计数，不能SUM/AVG金额或数量，也不能去重对象替代行数',check:chk};
    if(require('./sql-constraints').automaticSummarySourceGaps(question,registry,aggregateRefs).length)return {ok:false,stage:'constraint',error:'metric_source_not_equivalent: 未确认的同名自动汇总不能替代明细口径；按原题核对已登记明细来源，明确点名汇总时保留',check:chk};
    if(require('./sql-constraints').monthKeySourceGaps(period,registry,aggregateRefs.map(a=>a.table)).length)return {ok:false,stage:'constraint',error:'period_granularity: 月份键不能按日边界裁出部分月，不能用整月汇总替代用户所问日级期间',check:chk};
    if(require('./sql-constraints').snapshotCountDomainGap(question,chk,context))return {ok:false,stage:'constraint',error:'complete_snapshot_domain: 各期快照对象计数须保留实际快照日期域；将状态条件放入COUNT CASE或FILTER，不能用外层WHERE状态筛掉零事件日期；期间、其他实体与权限范围保留',check:chk};
    if(require('./sql-constraints').temporalStateScopeGap(question,chk,context))return {ok:false,stage:'constraint',error:'temporal_state_scope: 跨快照状态变化不能把早期状态放在同时筛两期的公共WHERE；每期条件分别放入对应日期CASE或子查询，再按业务标识连接',check:chk};
    chk=await lane.normalizeUnroundedRank(chk,lctx,question);
    if(!chk.ok)return {ok:false,stage:'check',error:chk.errors.join('；'),check:chk};
    if(chk.raw_rank_normalized)audit({kind:'sql_local_normalization',normalization:'unrounded_rank',conditions_preserved:true});
    { const want=scalarExtremum(question,null);
      if(want&&!chk.aggregates.some(a=>a.fn===want)&&!/"type":"LIMIT[A-Z_]*MODIFIER"/.test(JSON.stringify(chk.ast||{})))return {ok:false,stage:'constraint',error:'extremum_aggregation: 题面问最'+(want==='max'?'高/大/贵':'低/小/便宜')+'的那个值，用'+want.toUpperCase()+'(字段)或排序后取第一个，不能用平均或合计代替',check:chk}; }
    if(require('./sql-constraints').planActualSameSource(question,chk,context)){
      const plans=context.metrics.filter(m=>m.confirmed&&!m.auto&&/计划|目标|预算/.test([m.name,...(m.aliases||[])].join(' ')));
      const actual=context.metrics.filter(m=>m.kind==='simple'&&m.agg==='sum'&&plans.some(p=>p.field===m.field&&p.dataset!==m.dataset)).map(m=>m.name+'='+m.dataset+'.'+m.field).slice(0,3);
      return {ok:false,stage:'constraint',error:'actual_vs_plan_source: 达成率/完成率的「实际」须取自明细业务表的已登记实际指标'+(actual.length?'（'+actual.join('；')+'，按该表日期列取期间、按登记关系连接取类目）':'')+'，「计划」取自已确认的计划指标；不能用计划表同一列同时当实际和计划，也不能用单价等其他字段代替',check:chk};
    }
    if(require('./sql-constraints').runningTotalRankGap(question,chk.sql||sql))return {ok:false,stage:'constraint',error:'running_total_ranked: 不要按 SUM() OVER(ORDER BY…) 的滚动累计值排名（非负量滚动累计单调递增，取最高N个等于取最后N期）；「累计」在这里指把每天/每行的值加总到各组，先按组 SUM 再排名',check:chk};
    {const pc=require('./sql-constraints').percentDoubleScale(question,chk.sql||sql,context);if(pc.length)return {ok:false,stage:'constraint',error:'percent_double_scale: 题面说明「'+pc.join('、')+'」原值已是百分数（百分点），平均/加权平均后直接就是百分数，unit 写 %，不要再乘100',check:chk};}
    if(require('./sql-constraints').rowConditionHavingGap(question,chk))return {ok:false,stage:'constraint',error:'row_level_condition: 题面条件作用于逐条记录（…的记录），在WHERE里逐行判断后再分组汇总，不能先分组再用HAVING判断合计或比率',check:chk};
    if(require('./sql-constraints').explicitSumGap(question,chk,context))return {ok:false,stage:'constraint',error:'explicit_aggregation_sum: 题面明确要合计/求和，该字段默认按平均登记也要按题面用SUM并保留全部条件，不能用AVG代替合计',check:chk};
    if(require('./sql-constraints').rankOrderGap(question,chk))return {ok:false,stage:'constraint',error:'rank_order_metric: 前N须按所问同一数值指标降序；按原值排名时用展示舍入前的表达式，明确要求舍入后排名才用展示值；不能按日期、标签或另一指标截断，保留筛选',check:chk};
    if(require('./sql-constraints').snapshotExtremumGap(question,chk,context))return {ok:false,stage:'constraint',error:'snapshot_extremum_not_latest: 历史各期数量极值须先按快照日期汇总，再按所问数量取MAX/MIN或排序；不得用MAX/MIN日期筛成最近或最早快照',check:chk};
    const businessLabels=require('./sql-constraints').businessLabelGap(question,chk,context);if(businessLabels.length)return {ok:false,stage:'shape',error:'business_label_required: 题目按业务编号分组，应沿登记关系取 '+businessLabels.join('、')+' 作标签；内部Identifier只作连接，不代替业务编号',check:chk};
    const subtypeMarkers=require('./sql-constraints').missingSubtypeMarkers(question,chk,context);if(subtypeMarkers.length)return {ok:false,stage:'constraint',error:'subtype_scope_missing: 题面明确子类型，不能汇总所属父表的所有行；按已登记的 '+subtypeMarkers.join('；')+' 连接或IN筛选标记记录，保留题目其他总体分母',check:chk};
    const personNames=require('./sql-constraints').personNameLabelGap(question,chk,context);if(personNames.length)return {ok:false,stage:'shape',error:'person_name_label_required: 用户问具体是哪几个人，标签须沿登记关系读取 '+personNames.join('、')+'；内部人员ID只连接，不能拼接ID代替姓名',check:chk};
    const roleMappings=require('./sql-constraints').roleMappingGap(question,chk,context);if(roleMappings.length)return {ok:false,stage:'constraint',error:'declared_role_scope: 必须按已确认的角色定义筛选并用该角色编号分组，不能按协议编号或不筛角色；'+roleMappings.join('；'),check:chk};
    if(require('./sql-constraints').rowAverageRatioGap(question,chk))return {ok:false,stage:'constraint',error:'per_unit_weighting: 整体平均每件/每单金额须按总金额除以总数量或对应去重订单数；不能AVG逐行相除的比率，除非题面明确要求逐行简单平均',check:chk};
    if(require('./sql-constraints').rawRecordCountGap(question,chk))return {ok:false,stage:'constraint',error:'raw_record_count: 题面询问原始记录条数，应在原始行WHERE比较字段后COUNT；不能先按SKU/渠道/日期等分组，再用HAVING比较聚合金额或把组数当行数',check:chk};
    if(omitted.length)return {ok:false,stage:'constraint',error:'missing_entity_constraint: 题面明确对象未落实；核对字段 '+((omitted.hints&&omitted.hints.length===omitted.length)?omitted.hints:omitted).join('、')+'，不要丢失原题筛选',check:chk};
    let miss = await lane.checkLiterals(chk, lctx);
    for(const m of miss)if(String(question).includes(String(m.value))&&o.entityLookup?.resolve){
      const ids=[...registry.semantic.dims.values()].filter(d=>!d.unbound&&d.source?.table===m.table&&d.kind==='column').map(d=>d.id);
      const hit=o.entityLookup.resolve(m.value,{dimIds:ids});
      if(hit.status==='matched'&&hit.how==='exact'&&String(hit.value)===String(m.value)){
        const d=registry.dim(hit.dim);if(d.source?.field!==m.col)return {ok:false,stage:'constraint',error:'entity_field_mismatch: 题面对象已在本机精确核实，所属字段为 '+d.source.table+'.'+d.source.field+'；不能放到其他层级列，请修正原题筛选与分组',check:chk};
      }
    }
    // 题面加引号 / exactly 点名的取值：按原文精确算（数据里没有就是 0 行），相近取值只作本机提示，不拦着用户先选
    let vbNote = null;
    const verbatimMiss = miss.filter(m => valueMatch.quotedVerbatim(question, m.value));
    if (verbatimMiss.length) {
      miss = miss.filter(m => !verbatimMiss.includes(m));
      const hints = [];
      for (const m of verbatimMiss) {
        let near = [];
        try { near = (await valueMatch.findValues({ run: o.sqlRunner, table: m.table, col: m.col, queries: [m.value], limit: 3 })).filter(x => x.score >= 0.5).map(x => x.value); } catch (_) {}
        hints.push(`数据里没有和「${m.value}」完全一样的取值，按你写的原文精确匹配计算` + (near.length ? `（相近的有：${near.join('、')}，要按它们算可以点一下改）` : ''));
      }
      vbNote = hints.join('；');
      audit({ kind: 'sql_literal_verbatim', question, literals: verbatimMiss.map(m => ({ table: m.table, col: m.col })), executed_as_written: true });
    }
    if (miss.length && !ropt.noValueFix) {
      // 字面值在列里不存在：本机去这一列找最像的真实写法（真实取值只给用户看，不给模型）
      const fixed = await fixMissingValues(sql, miss);
      if (fixed.choice) return { ok: false, stage: 'value_choice', check: chk, result: fixed.choice };
      if (fixed.sql && fixed.guesses.length) {
        const again = await runChecked(fixed.sql, outp, { noValueFix: true });
        if (!again.ok || !again.result) return again;
        const g = fixed.guesses[0];
        const note = fixed.guesses.map(x => `按「${x.value}」理解（你说的是「${x.literal}」），不对点一下改`).join('；');
        let ans = String(again.result.answer || '');
        ans = ans.includes('\nANSWER: ') ? ans.replace('\nANSWER: ', '\n' + note + '。\nANSWER: ') : ans + '\n' + note + '。';
        ans = ans.replace(/）\s*$/, '；' + note + '）');
        again.result.answer = ans;
        again.result.value_guess = { literal: g.literal, value: g.value, table: g.table, col: g.col };
        if (fixed.guesses.length > 1) again.result.value_guesses = fixed.guesses.map(x => ({ literal: x.literal, value: x.value, table: x.table, col: x.col }));
        return again;
      }
      if (fixed.rest) miss = fixed.rest;
    }
    if (miss.length) return { ok: false, stage: 'literal', error: 'literal_not_found: ' + miss.map(m => `${m.table}.${m.col}`).join('；') + '。题面对象无法在本机确认，不能猜测取值，必要时 abstain', check: chk };
    const projection=(chk.ast?.node||chk.ast)?.select_list||[];
    const outputNames=projection.map(x=>x.alias||(x.class==='COLUMN_REF'?x.column_names?.at(-1):null)).filter(Boolean).map(x=>String(x).toLowerCase());
    if(new Set(outputNames).size!==outputNames.length)return {ok:false,stage:'shape',error:'duplicate_output_name: 输出列名必须唯一，分组标签不能也叫v；仅唯一数值列使用v',check:chk};
    chk=await lane.prepareSqliteCtes(chk,lctx);
    if(!chk.ok)return {ok:false,stage:'check',error:chk.errors.join('；'),check:chk};
    const ran = await lane.runSql(chk.sql, lctx);
    if (!ran.ok) return { ok: false, stage: 'run', error: ran.error, check: chk };
    require('./request-context').assertCurrent(o);
    const cols = ran.columns.length ? ran.columns : [];
    let vcol = cols.find(c => String(c).toLowerCase() === 'v');
    if (!vcol) { const nums = cols.filter(c => ran.rows.every(row => row[c] == null || lane.toNum(row[c]) != null)); if (nums.length === 1) vcol = nums[0]; }
    if (!vcol && ran.rows.length) return { ok: false, stage: 'shape', error: '输出里没有数值列 v（输出列 = 标签列 + 一个数值列 v）', check: chk };
    if(vcol&&ran.rows.some(row=>row[vcol]!=null&&lane.toNum(row[vcol])==null))return {ok:false,stage:'shape',error:'non_numeric_v: v只能是数值；货号/姓名等清单保留为标签列，纯清单用1 AS v，不得把文本清单放进v',check:chk};
    // P78:题面要的是一个合计(「…合计/一共/总共多少」,没有分别/各/每/按),不能拆成多行
    // 括注里的计算约定（「按原样逐行算」）不是分组要求；「按日/逐日累计多少」问的是一个总数
    const qMain=String(question).replace(/（[^（）]*）|\([^()]*\)/g,'').replace(/按原样|原样|逐行|按行/g,'').replace(/(?:按|逐)(?:日|天)累计/g,'累计');
    if(ran.rows.length>1&&/(?:合计|一共|总共|总计|加起来|累计)[^，。；?？]{0,6}(?:多少|是多少|几)|\btotal\b[^.?]{0,30}\?|in total/i.test(qMain)&&!/分别|各|每|按|逐|哪|前\s*\d|top\s*\d|by\b|each|per\b|respectively/i.test(qMain))return {ok:false,stage:'shape',error:'scalar_total: 题面只要一个合计数（把所列对象/日子都算在一起），输出一行数值v，不要按对象或日期拆成多行',check:chk};
    if(objectCount&&ran.rows.length>1&&cols.length===1&&!/按|分别|各|分组|每天|每月|每年|每周|each|per\b|group|by\b/i.test(String(question)))return {ok:false,stage:'shape',error:'scalar_object_count: 题面只问符合条件的对象总个数，不能输出每个对象一行COUNT；若对象条件依赖聚合，先按业务对象分组并HAVING筛选，再在最外层COUNT这些对象，仅输出一行数值v',check:chk};
    // 明确的按维度拆分X份额应组成同一个总体；复用配置通道的分项和校验，错误反馈不带本机数值。
    if((/按[^，。？?]{1,24}(?:拆分|细分)的?[^，。？?]{1,40}(?:占比|份额|比重)/.test(String(question))||/(?:各|每个|[一二三四五六七八九十两\d]+(?:个|大))[^，。？?]{0,10}(?:渠道|平台|类目|品类|店铺|供应商|国家|地区|设备|浏览器)[^，。？?]{0,20}(?:占比|份额|比重|占多少)/.test(String(question)))&&!/前\s*\d|最高|最低|最多|最少|部分|其中/.test(String(question))&&ran.rows.length>1&&vcol){
      const issues=require('./self-check').selfCheck({formula:{kind:'share'}},{result_status:'ok',rows:ran.rows.map(x=>({value:lane.toNum(x[vcol])}))});
      if(issues.some(x=>x.code==='share_sum'))return {ok:false,stage:'constraint',error:'group_share_total: 按维度拆分同一指标份额，分母是该指标在同期间同用户筛选下的总体，不是另一指标或每组自己的其他金额；各组完整份额应合计100%',check:chk};
    }
    const tier = lane.tierOf(chk, context);
    const why = chk.tier_why || {};
    const constantLabels=new Set(ran.rows.length===1?((chk.ast?.node||chk.ast)?.select_list||[]).filter(x=>x.class==='CONSTANT'&&x.alias).map(x=>String(x.alias).toLowerCase()):[]);
    const labels = cols.filter(c => c !== vcol&&!constantLabels.has(String(c).toLowerCase()));
    // P78:「和 X …最多/最像的是哪位同事」问的是 X 以外的对象;结果把 X 自己排进来 = 自连接没排除同一对象(经典自连接 a.id<>b.id)
    if(labels.length&&ran.rows.length&&/(?:和|与|跟|同)\s*[^，。？?]{2,40}?(?:重合|相同|共同|一样|相似|最像|合作|共事)[^，。？?]{0,20}(?:最多|最高|最大|最像|最相似)[^，。？?]{0,12}(?:哪位|哪个|谁|哪些|同事|其他|别的|另)/.test(String(question))){
      const top=ran.rows.slice(0,3).flatMap(row=>labels.map(c=>row[c]==null?'':String(row[c]).trim())).filter(x=>x.length>=2);
      const selfHit=top.find(x=>String(question).includes(x));
      if(selfHit)return {ok:false,stage:'shape',error:'self_comparison: 题面问的是和题中这个对象相比的其他对象，结果不能是它自己；自连接时排除同一对象（左右两侧编号不相等），保留其他条件',check:chk};
    }
    const temporalLabels=require('./sql-constraints').temporalLabelKinds(chk);
    const unit = String(lane.registeredCountUnit(chk,context)??((outp && outp.unit) || '')).slice(0, 4);
    const book = o.facts || o.book || null;
    const facts = [];
    const rows = [];
    for (const row of ran.rows) {
      const v = lane.toNum(row[vcol]);
      const lab = labels.map(c => {
        if(row[c]==null)return '（空）';const value=String(row[c]);
        if((/^(?:年份|年|year)$/i.test(String(c))||temporalLabels.get(c)==='year')&&/^\d{4}$/.test(value))return '年份'+value;
        if((/^(?:月份|月|month)$/i.test(String(c))||temporalLabels.get(c)==='month')&&/^\d{1,2}$/.test(value)&&Number(value)>=1&&Number(value)<=12)return '月份'+value.padStart(2,'0');
        return value;
      }).join(' · ');
      const ad = askedDecimals(question);
      const display = v == null ? '—' : (ad != null ? Number(v).toLocaleString('en-US', { minimumFractionDigits: ad, maximumFractionDigits: ad }) : lane.fmtValue(v)) + unit;
      const spec = { schema_version: 'fb/2', kind: 'metric', label: ((outp && outp.label) ? String(outp.label).slice(0, 40) : '兜底查询') + (lab ? ' · ' + lab : ''),
        value: v, unit, display, status: v == null ? 'no_data' : 'ok', dims: labels.length ? labels.map(c => row[c] == null ? null : String(row[c])) : null,
        period: period ? { start: period.start, endExclusive: period.endExclusive, interval: '[start,endExclusive)', timezone: tz } : null,
        source: { table: (chk.tables[0] || 'sql'), field: 'sql:v' }, tier, lane: 'sql' };
      let id = null;
      if (book) { try { id = typeof book.addTyped === 'function' ? book.addTyped(spec) : book.add(spec.label, spec.display); } catch (_) { try { id = book.add(spec.label, spec.display); } catch (__) {} } }
      if (!id) id = 'F' + (facts.length + 1);
      facts.push(Object.assign({ id }, spec));
      rows.push({ label: lab || null, value: v, fact: id, status: v == null ? 'no_data' : 'ok' });
    }
    let good = facts.filter(f => f.value != null);
    // P78 已知范围里的空合计 = 0(经典:SUM 对空集合是 NULL,但「卖了几件/退了多少」在数据覆盖期内没有记录就是 0)
    // 只在:单个 SUM、一行、标量;所问期间完全落在这张表的数据覆盖范围里;题面对象都已在本机核实存在(上面字面值核对已过)时适用。
    if (!good.length && ran.rows.length <= 1 && labels.length === 0
        && chk.aggregates.length === 1 && chk.aggregates[0].fn === 'sum' && !chk.divisions.length) {
      try {
        const hasDate = t => ((registry.tables || []).find(x => x.name === t)?.columns || []).some(c => /date|time/i.test(String(c.type || '')));
        const mm = context.metrics.find(m => chk.tables.includes(m.dataset) && m.field && hasDate(m.dataset) && m.additivity !== 'semiAdditive');
        const rg = mm ? await dataRangeFor({ metric_ids: ['m:' + mm.id] }, registry, o.sqlRunner) : null;
        const nextDay = d => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
        // 用 SQL 自己的日期边界判断查询窗口(本机解析的期间可能不准),窗口必须完整落在数据覆盖范围里
        const ds = []; const scan = x => { if (Array.isArray(x)) return x.forEach(scan); if (!x || typeof x !== 'object') return; if (x.class === 'CONSTANT' && typeof x.value?.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.value.value)) ds.push(x.value.value); Object.values(x).forEach(scan); }; scan(chk.ast); ds.sort();
        if (ds.length >= 2 && rg && rg.start && rg.end && rg.start <= ds[0] && ds[ds.length - 1] <= nextDay(rg.end)) {
          const f0 = facts[0] || { id: 'F1' };
          Object.assign(f0, { value: 0, display: lane.fmtValue(0) + unit, status: 'ok', note: 'empty_sum_in_covered_period' });
          if (!facts.length) facts.push(f0);
          rows.splice(0, rows.length, { label: null, value: 0, fact: f0.id, status: 'ok' });
          good = [f0];
          audit({ kind: 'sql_local_normalization', normalization: 'empty_sum_in_covered_period', conditions_preserved: true });
          vbNote = [vbNote, `数据覆盖 ${rg.start} 到 ${rg.end}，这段时间没有符合条件的记录，按 0 计`].filter(Boolean).join('；');
        }
      } catch (_) {}
    }
    if (!good.length) {
      return { ok: true, tier, check: chk, sql: chk.sql, result: { status: 'ok', result_status: 'no_data', lane: 'sql', sql: chk.sql, tier, facts: [], rows: [], plan: null,
        answer: await (async()=>{
          let range=null;
          // P78:优先用带日期列的表(连接查询里第一张表可能是没有日期的维度表)
          const hasDate=t=>((registry.tables||[]).find(x=>x.name===t)?.columns||[]).some(c=>/date|time/i.test(String(c.type||'')));
          const metric=context.metrics.find(m=>chk.tables.includes(m.dataset)&&m.field&&hasDate(m.dataset)&&m.additivity==='semiAdditive')||context.metrics.find(m=>chk.tables.includes(m.dataset)&&m.field&&hasDate(m.dataset))||context.metrics.find(m=>chk.tables.includes(m.dataset)&&m.field);
          if(metric){try{range=await dataRangeFor({metric_ids:['m:'+metric.id]},registry,o.sqlRunner);}catch(_){}}
          // 没解析出期间时,用 SQL 自己的日期边界说明「查的是哪段」(只用于说明没数据的原因)
          let sqlWin=null;{const ds=[];const scan=x=>{if(Array.isArray(x))return x.forEach(scan);if(!x||typeof x!=='object')return;if(x.class==='CONSTANT'&&typeof x.value?.value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.value.value))ds.push(x.value.value);Object.values(x).forEach(scan);};scan(chk.ast);if(ds.length){ds.sort();sqlWin={start:ds[0],endExclusive:ds[ds.length-1]};}}
          const formatter=require('./answer-format'),pl={time:sqlWin||period||{}};
          const detail=formatter.noDataDetail(pl,range);
          const reason=chk.divisions.length && ran.rows.length ? '无法回答：比率结果为空，分母或输入没有可计算的数据，请确认销售或成交范围。' : formatter.noDataText(pl,range);
          return ['查询成功，但没有匹配的数据',detail,vbNote?vbNote+'。':null,'ANSWER: '+reason+(vbNote?'（按原文精确匹配）':'')].filter(Boolean).join('\n');
        })() } };
    }
    const usedIds=[...new Set(chk.aggregates.flatMap(a=>context.metrics.filter(m=>a.col && m.dataset===a.col.table && m.field===a.col.col).map(m=>'m:'+m.id)))];
    const pseudo={metric_ids:usedIds,time:period||{},unit};
    const meaning=require('./answer-format').defaultCalibNotes(pseudo,registry,[]).join('；');
    const fieldName=a=>{const m=context.metrics.find(x=>x.dataset===a.col.table&&x.field===a.col.col&&x.kind==='simple');const n=m&&String(m.name||'').split('·').pop();return n&&n!==a.col.col?n+'=':'';};
    const aggNotes=chk.aggregates.filter(a=>a.col && typeof a.col.table==='string').map(a=>`${fieldName(a)}${a.distinct?'去重':''}${a.fn.toUpperCase()}(${a.col.col})`);
    const sentence = [lane.tierSentence(tier, why),meaning,period?.policy==='prev_week'?'自然周按周一至周日':null,chk.aggregates.some(a=>a.fn==='avg')?'按匹配数据行简单平均':null,aggNotes.length?'口径：'+[...new Set(aggNotes)].join('，'):null].filter(Boolean).join('；');
    const body = [((outp && outp.label) || '兜底查询') + '：', ...rows.map(x => `- ${x.label ? x.label + '：' : ''}${(facts.find(f => f.id === x.fact) || {}).display}（${x.fact}）`), sentence + '。', vbNote ? vbNote + '。' : null].filter(Boolean).join('\n');
    const parts = rows.filter(x => x.value != null).map(x => { const f = facts.find(y => y.id === x.fact); return (x.label ? x.label + ': ' : '') + f.display; });
    const lab = stripDigitTokens(String((outp && outp.label) || '').slice(0, 60));
    const line = 'ANSWER: ' + parts.join('；') + '（' + (lab ? lab + '；' : '') + stripDigitTokens(sentence) + '）';
    return { ok: true, tier, check: chk, sql: chk.sql, result: {
      status: 'ok', result_status: 'ok', lane: 'sql', sql: chk.sql, tier, tier_why: why, confirmed: false,
      facts, rows, plan: null, answer: body + '\n' + line } };
  }
}

module.exports = { ask, askedConcepts, withAskedConcept, askConfig, shouldFallback, applyChoice, renderAnswer, coverageOf, planToIR, candidateBundle, makeCallLog, sumUsage, unsupportedConcepts, renderRefusal, CODE_TEXT,
  DEFAULT_MAX_CALLS, DEFAULT_MAX_TOKENS, IR_OUTPUT_MAX_TOKENS };
