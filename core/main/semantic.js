// ================= 语义层核心（v2：角色绑定） =================
// 领域包 → 指标 / 维度 / 粒度 / 关系 → 绑定用户表 → 计算 + 扇出防护。
//
// 关键设计：领域包不写死表名 / 列名，只写「角色」+「候选名」；运行时用 bind(tables) 把
// 角色解析到用户真实的 (表, 列)。表名 / 列名不认识，词典可作二次匹配（可选 dict.identify）。
//
// 两个阶段：
//   load(pack)   —— 注册定义（角色，未绑定）
//   bind(tables) —— 把角色解析成具体表列（之后 eval / compileSql 才能跑）
//
// 扇出规则（对可加 / 比率 / 去重指标）：
//   维度在基表上 / 在「1 侧」表（沿 N:1 路径，支持多跳）→ 安全
//   维度要经过 1:N / N:N → 拒绝，提示先按粒度预聚合
'use strict';
// P1：关系 / 粒度能力（基数实测、复合键、桥表、扇出、期末快照预聚合）都收在 relations.js，这里是接线。
const relations = require('./relations');
const { sqlDateExpr } = require('./date-format');

const OPS = new Set(['add', 'sub', 'mul', 'div']);
const AGGS = new Set(['sum', 'count', 'avg', 'max', 'min', 'dcount', 'last']);
// none = 不可加：平台算好的比率（CTR、Avg. CPC…）、平均值列（Average Daily …）。只能看单行，或筛到单行上看；
// 跨行 sum / avg 当总体值是错的，要用「分子合计 ÷ 分母合计」的补算指标。
const ADDITIVITY = new Set(['additive', 'semiAdditive', 'ratio', 'distinct', 'none']);
const ADD_NAME = { additive: '可加', semiAdditive: '半可加', ratio: '比率', distinct: '去重', none: '不可加' };

// 比率公共计算路径（10-22 能力终审）：四种口径必须分开，不能都用 kind=ratio 一个公式糊过去。
//   ratio  比值：分子 / 分母（倍数、单价、每公斤成本…）
//   share  占比：部分 / 总体（百分数；分母作用域常要去掉当前分组条件）
//   yoy    同比增长率：本期 / 同一业务口径的上期（百分数；缺对比期要单独报状态）
//   pp     百分点：两个百分点口径的比率相减（毛利率 30% - 25% = 5pp），不做除法
// 公式与单位从计划 / 指标定义（ratioKind / percent_scale）读，渲染层不写死。
const RATIO_KINDS = new Set(['ratio', 'share', 'yoy', 'pp']);
const RATIO_KIND_NAME = { ratio: '比值', share: '占比', yoy: '同比增长率', pp: '百分点' };
// 状态码分开：0 是能算出来的值；零分母 / 无数据 / 缺对比期是不同原因，不能都变 0 或 null 不区分。
const RATIO_STATUS = new Set(['ok', 'no_data', 'zero_denominator', 'missing_comparison']);
// 结构化过滤类别：group/entity 是当前视图条件，period 是时间范围，user/permission 是用户与权限边界。
const FILTER_KINDS = new Set(['group', 'entity', 'period', 'user', 'permission']);

const n = v => v == null ? null : Number(v);
const sum = a => a.reduce((x, y) => x + y, 0);
const div = (a, b) => (b == null || b === 0 || a == null ? null : a / b);
const KEY = '\u0001';

function e(msg, code){ const err = new Error(msg); err.semantic = true; if (code) err.code = code; return err; }
// 能力缺口用固定短码，调用方（计划校验 / Agent 工具）只读 code，不靠猜中文。
function gap(msg, code){ const err = e(msg, code || 'unsupported_operator'); err.capabilityGap = true; return err; }
function norm(s){
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[^0-9a-z\u4e00-\u9fff]/g, '')
    .replace(/(gbp|usd|cny|rmb|eur|jpy|aud|cad|hkd|元|美元|英镑|欧元|港币|%|件|个|次)$/, '');
}
function bucketDate(s, grain){
  s = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  if (grain === 'year') return s.slice(0, 4);
  if (grain === 'quarter') {
    const mo = Number(s.slice(5, 7));
    return Number.isFinite(mo) && mo >= 1 && mo <= 12 ? s.slice(0, 4) + '-Q' + (Math.floor((mo - 1) / 3) + 1) : s.slice(0, 10);
  }
  if (grain === 'month') return s.slice(0, 7);
  if (grain === 'week') {
    const d = new Date(s + 'T00:00:00Z');
    const back = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}

// ---------- 比率路径的结构化过滤 / 期间 / 状态（不接收任意 SQL 片段） ----------
function normalizeFilters(filters){
  return (Array.isArray(filters) ? filters : []).map((f, i) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw e(`筛选条件 #${i + 1} 要是 {field, values[]} 或期间`, 'bad_filter');
    const field = String(f.field == null ? '' : f.field);
    if (!field) throw e(`筛选条件 #${i + 1} 缺 field`, 'bad_filter');
    const kind = f.kind == null ? 'group' : String(f.kind);
    if (!FILTER_KINDS.has(kind)) throw e(`筛选条件「${field}」的 kind 无效：${kind}（只认 ${[...FILTER_KINDS].join('/')}）`, 'bad_filter');
    const table = f.table == null ? null : String(f.table);
    if (f.values != null) {
      if (!Array.isArray(f.values) || !f.values.length) throw e(`筛选条件「${field}」values 要是非空数组`, 'bad_filter');
      return { field, kind, table, values: f.values.map(v => String(v == null ? '' : v)) };
    }
    if (f.from != null || f.to != null || f.start != null || f.endExclusive != null) {
      const start = f.start != null ? f.start : f.from, endExclusive = f.endExclusive, to = f.to;
      if (start == null) throw e(`期间筛选「${field}」缺起点`, 'bad_filter');
      if (endExclusive != null) return { field, kind, table, start: String(start), endExclusive: String(endExclusive) };
      if (to == null) throw e(`期间筛选「${field}」缺终点（to 或 endExclusive）`, 'bad_filter');
      return { field, kind, table, from: String(start), to: String(to) };
    }
    throw e(`筛选条件「${field}」缺 values 或期间`, 'bad_filter');
  });
}
function rowMatches(row, f){
  const v = row ? row[f.field] : null;
  if (f.values) return f.values.includes(String(v == null ? '' : v));
  const s = String(v == null ? '' : v);
  if (f.endExclusive != null) return s >= f.start && s < f.endExclusive;
  return s >= f.from && s <= f.to;
}
function inSpan(value, span){
  const s = String(value == null ? '' : value);
  if (!s) return false;
  if (span.endExclusive != null) return s >= span.start && s < span.endExclusive;
  return s >= span.from && s <= span.to;
}
// 期间统一成 {start,endExclusive}（半开）或 {from,to}（旧闭区间兼容，只在这里适配一次）
function normalizeSpan(span, name){
  if (!span || typeof span !== 'object' || Array.isArray(span)) throw e(`${name}：缺期间`, 'bad_ratio_spec');
  const start = span.start != null ? span.start : span.from;
  if (start == null) throw e(`${name}：缺起点`, 'bad_ratio_spec');
  if (span.endExclusive != null) {
    if (!(String(start) < String(span.endExclusive))) throw e(`${name}：半开区间无效（start 不早于 endExclusive）`, 'bad_ratio_spec');
    return { start: String(start), endExclusive: String(span.endExclusive) };
  }
  if (span.to == null) throw e(`${name}：缺终点（to 或 endExclusive）`, 'bad_ratio_spec');
  if (!(String(start) <= String(span.to))) throw e(`${name}：闭区间无效（from 晚于 to）`, 'bad_ratio_spec');
  return { from: String(start), to: String(span.to) };
}
// 分母作用域（显式）：是否去掉当前分组条件、保留哪些过滤。权限/用户过滤永远不能丢。
function normalizeDenScope(scope, kind){
  const s = scope == null ? {} : scope;
  if (typeof s !== 'object' || Array.isArray(s)) throw e('den_scope 要是 {drop_group_filter, keep[]}', 'bad_ratio_spec');
  if (s.drop_group_filter != null && typeof s.drop_group_filter !== 'boolean') throw e('den_scope.drop_group_filter 要是布尔值', 'bad_ratio_spec');
  if (s.keep != null && (!Array.isArray(s.keep) || s.keep.some(k => !FILTER_KINDS.has(k)))) throw e(`den_scope.keep 只能写 ${[...FILTER_KINDS].join('/')}`, 'bad_ratio_spec');
  if (s.drop_permissions === true) throw gap('分母作用域不能去掉权限/用户过滤：拒绝跨权限口径计算', 'permission_scope_required');
  return {
    drop_group_filter: s.drop_group_filter == null ? kind === 'share' : s.drop_group_filter === true,
    keep: s.keep ? s.keep.slice() : ['period', 'user', 'permission'],
  };
}
function splitFilters(filters, scope){
  const kept = [], dropped = [];
  for (const f of filters) {
    const neverDrop = f.kind === 'permission' || f.kind === 'user';
    const drop = !neverDrop && f.kind === 'group' && scope.drop_group_filter === true && !(scope.keep || []).includes('group');
    if (drop) dropped.push(f.field); else kept.push(f);
  }
  return { filters: kept, dropped };
}
// 分子/分母聚合后的状态：先看数据在不在，再看分母是不是 0。绝不把 null / 0 / 缺对比期混成一个值。
function ratioStatusOf(numVal, denVal){
  if (numVal == null || denVal == null) return 'no_data';
  if (denVal === 0) return 'zero_denominator';
  return 'ok';
}
function combineStatus(list){
  const st = list.map(x => x || 'no_data');
  if (st.includes('missing_comparison')) return 'missing_comparison';
  if (st.includes('zero_denominator')) return 'zero_denominator';
  if (st.every(x => x === 'ok')) return 'ok';
  return 'no_data';
}
function overallStatus(rows){
  if (!rows.length) return 'no_data';
  return rows.some(r => r.status === 'ok') ? 'ok' : rows[0].status;
}

class Semantic {
  constructor(){
    this.metrics = new Map(); this.dims = new Map();
    this.grains = new Map(); this.rels = new Map(); this.datasets = new Map();
    this.dateFormats = {};      // 10-23："表.列" → { format, iso:false }：文本日期列的写法（英文导出的 10/21/2021 等），编译 SQL 时用 TRY_STRPTIME 转
  }

  // 这一列是不是「文本日期、写法不是 ISO」：是就返回格式，不是返回 null（日期列本来就是 DATE、ISO 文本直接 CAST，都保持原样）
  dateFormatOf(table, field){
    const f = this.dateFormats && this.dateFormats[`${table}.${field}`];
    return f && f.format && !f.iso ? f : null;
  }
  // 日期表达式：有登记的写法就用 TRY_STRPTIME，没有就还是 CAST(列 AS DATE)
  _dateSql(table, colSql, field){
    return sqlDateExpr(colSql, this.dateFormatOf(table, field), { asDate: true });
  }

  load(pack){
    if (!pack || typeof pack !== 'object') throw e('领域包无效');
    if (!/^[a-z0-9_]{1,32}$/.test(pack.id || '')) throw e('领域包 id 无效');
    const mid = new Set(), did = new Set();
    // 10-23：导入自动语义认出的文本日期写法（_meta.date_formats："表.列" → { format }）
    for (const [k, v] of Object.entries((pack._meta && pack._meta.date_formats) || {})) {
      if (v && typeof v.format === 'string' && v.format) this.dateFormats[k] = { format: v.format, iso: false, ambiguous: !!v.ambiguous };
    }
    for (const [ds, def] of Object.entries(pack.datasets || {})) {
      // 数据集只是绑定提示（表名/键列的候选），跨包重复声明允许（后者覆盖），不像指标/维度那样会造成静默错误
      if (!Array.isArray(def.match) || !def.match.length) throw e(`数据集「${ds}」缺 match`);
      this.datasets.set(ds, Object.assign({}, def));
    }
    for (const m of (pack.metrics || [])) {
      if (!m.id || mid.has(m.id)) throw e(`指标 id 重复或缺失：${m.id}`);
      if (this.metrics.has(m.id)) throw e(`指标 id 与已有领域包冲突：${m.id}`);
      mid.add(m.id);
      if (!['simple', 'ratio', 'derived'].includes(m.kind)) throw e(`${m.id}: kind 无效`);
      if (m.kind === 'simple') {
        if (!AGGS.has(m.agg)) throw e(`${m.id}: agg 无效`);
        if (!m.dataset) throw e(`${m.id}: 缺 dataset`);
        if (m.agg !== 'count' && !m.field && !m.role) throw e(`${m.id}: 缺 field 或 role`);
      }
      if (m.kind === 'ratio' && (!m.num || !m.den)) throw e(`${m.id}: ratio 缺 num/den`);
      if (m.kind === 'derived' && !m.expr) throw e(`${m.id}: 缺 expr`);
      if (m.additivity && !ADDITIVITY.has(m.additivity)) throw e(`${m.id}: additivity 无效`);
      // 比率口径与百分点换算必须进指标定义（或计划），不在渲染层猜。
      if (m.ratioKind != null && !RATIO_KINDS.has(m.ratioKind)) throw e(`${m.id}: ratioKind 无效（只认 ${[...RATIO_KINDS].join('/')}）`);
      if (m.percent_scale != null && !(typeof m.percent_scale === 'number' && Number.isFinite(m.percent_scale) && m.percent_scale !== 0)) throw e(`${m.id}: percent_scale 要是非零有限数字`);
      const denScope = m.den_scope != null ? m.den_scope : m.denScope;
      if (denScope != null) {
        if (typeof denScope !== 'object' || Array.isArray(denScope)) throw e(`${m.id}: den_scope 无效`);
        if (denScope.drop_group_filter != null && typeof denScope.drop_group_filter !== 'boolean') throw e(`${m.id}: den_scope.drop_group_filter 要是布尔值`);
        if (denScope.keep != null && (!Array.isArray(denScope.keep) || denScope.keep.some(k => !FILTER_KINDS.has(k)))) throw e(`${m.id}: den_scope.keep 只能写 ${[...FILTER_KINDS].join('/')}`);
        if (denScope.drop_permissions === true) throw e(`${m.id}: 指标定义不能去掉权限过滤（权限边界不可配置）`);
      }
      this.metrics.set(m.id, Object.assign({ additivity: 'additive', unit: '', decimals: 2, mul: 1 }, m));
    }
    for (const d of (pack.dims || [])) {
      if (!d.id || did.has(d.id)) throw e(`维度 id 重复或缺失：${d.id}`);
      if (this.dims.has(d.id)) throw e(`维度 id 与已有领域包冲突：${d.id}`);
      did.add(d.id);
      if (!['column', 'bucket', 'map', 'timeBucket'].includes(d.kind)) throw e(`${d.id}: 维度 kind 无效`);
      const hasSource = !!(d.source && d.source.table && d.source.field);
      const hasRole = !!(d.dataset && d.match);
      if (!hasSource && !hasRole) throw e(`${d.id}: 缺 source 或 (dataset+match)`);
      if (d.kind === 'bucket' && (!Array.isArray(d.edges) || !d.edges.length)) throw e(`${d.id}: bucket 缺 edges`);
      if (d.kind === 'map' && !d.mapping) throw e(`${d.id}: map 缺 mapping`);
      if (d.kind === 'timeBucket' && !d.grain) throw e(`${d.id}: timeBucket 缺 grain`);
      this.dims.set(d.id, Object.assign({}, d));
    }
    for (const [t, g] of Object.entries(pack.grain || {})) this.grains.set(t, Array.isArray(g) ? g : [g]);
    for (const r of (pack.relationships || [])) {
      if (!r.id || this.rels.has(r.id)) throw e(`关系 id 重复或缺失：${r.id}`);
      if (!r.left || !r.right) throw e(`${r.id}: 关系缺 left/right`);
      if (!Array.isArray(r.pairs) && !Array.isArray(r.keys)) throw e(`${r.id}: 关系缺 pairs 或 keys`);
      // P1：四个基数都收；声明只当「要实测的假设」，实测不一致时这条关系不能进安全路径。
      const rec = Object.assign({}, r, { cardinality: relations.normCard(r.cardinality), verification: null, unverified: false, measuredCardinality: null });
      if (r.snapshot != null) {
        if (typeof r.snapshot !== 'object') throw e(`${r.id}: snapshot 声明无效（要 {dateField?, grain?}）`);
        rec.snapshot = Object.assign({}, r.snapshot);
      }
      if (r.bridge != null) rec.bridge = !!r.bridge;
      this.rels.set(r.id, rec);
    }
    for (const m of this.metrics.values()) {
      if (m.kind === 'ratio') { this._ref(m.num); this._ref(m.den); }
      if (m.kind === 'derived') this._walkExpr(m.expr);
    }
    this._cycleCheck();
    return this;
  }

  _ref(id){ if (!this.metrics.has(id)) throw e(`引用不存在的指标：${id}`); }
  _walkExpr(x){ if (typeof x === 'string') return this._ref(x); if (!x || !OPS.has(x.op) || !Array.isArray(x.args) || !x.args.length) throw e('派生表达式无效'); for (const a of x.args) this._walkExpr(a); }
  _cycleCheck(){
    const visiting = new Set(), done = new Set();
    const walk = id => {
      if (done.has(id)) return;
      if (visiting.has(id)) throw e(`指标循环引用：${id}`);
      visiting.add(id);
      const m = this.metrics.get(id);
      if (m.kind === 'ratio') { walk(m.num); walk(m.den); }
      else if (m.kind === 'derived') this._walkRefs(m.expr, walk);
      visiting.delete(id); done.add(id);
    };
    for (const id of this.metrics.keys()) walk(id);
  }
  _walkRefs(x, walk){ if (typeof x === 'string') return walk(x); for (const a of x.args) this._walkRefs(a, walk); }

  /* ---------- 绑定：角色 → (表, 列) ---------- */
  _matchCol(tb, candidates, wantType, dict){
    const cols = (tb && tb.columns) || [];
    const cands = (Array.isArray(candidates) ? candidates : [candidates]).map(norm);
    const pick = (type, fn) => cols.filter(c => (!type || c.type === type) && fn(c));
    let hit = pick(wantType, c => cands.includes(norm(c.name)));
    if (hit.length === 1) return hit[0].name;
    if (hit.length > 1) throw e(`列有歧义：${[].concat(candidates).join('/')} 命中 ${hit.map(c => c.name).join('、')}`);
    if (dict && dict.identify) {
      hit = pick(wantType, c => { const r = dict.identify(c.name); return r.entries.some(en => [en.zh, en.en, ...(en.abbr || [])].some(x => cands.includes(norm(x)))); });
      if (hit.length === 1) return hit[0].name;
      if (hit.length > 1) throw e(`列有歧义（词典）：${[].concat(candidates).join('/')} 命中 ${hit.map(c => c.name).join('、')}`);
    }
    hit = pick(wantType, c => cands.some(m => m.length >= 2 && norm(c.name).includes(m)));
    if (hit.length === 1) return hit[0].name;
    if (hit.length > 1) throw e(`列有歧义：${[].concat(candidates).join('/')} 命中 ${hit.map(c => c.name).join('、')}`);
    throw e(`没找到匹配列：${[].concat(candidates).join('/')}（表「${tb && tb.name}」）`);
  }
  _findDataset(ds, def, T){
    const m = (def.match || []).map(norm);
    const keys = def.keys || [];
    // 名字优先；名字命中唯一才用，否则退回键列。避免「日期」这类通用键列抢先把表认错。
    // 名字**完全相等**优先：用户表叫 dim_store 时，不能因为内置候选里有 "store" 就和「店铺」抢成歧义
    const exact = T.filter(tb => m.includes(norm(tb.name)));
    if (exact.length === 1) return { table: exact[0] };
    if (exact.length > 1) return { error: `数据集「${ds}」名字精确匹配到多张表：${exact.map(t => t.name).join('、')}`, code: 'ambiguous_dataset' };
    const byName = T.filter(tb => m.some(x => norm(tb.name).includes(x)));
    if (byName.length === 1) return { table: byName[0], weak: true };
    if (byName.length > 1) return { error: `数据集「${ds}」名字匹配到多张表：${byName.map(t => t.name).join('、')}`, code: 'ambiguous_dataset' };
    const byKey = T.filter(tb => keys.some(k => (tb.columns || []).some(c => norm(c.name) === norm(k))));
    if (byKey.length === 1) {
      // 只靠键列认出来的表记一笔：键列（订单号/日期）在每张表都常见，宁可让调用方看见这条弱绑定
      return { table: byKey[0], weak: true };
    }
    if (byKey.length > 1) return { error: `数据集「${ds}」键列匹配到多张表：${byKey.map(t => t.name).join('、')}，请细化名字候选`, code: 'ambiguous_dataset' };
    return { missing: true, error: `数据集「${ds}」在用户表里没找到（候选：${def.match.join('/')}）`, code: 'missing_dataset' };
  }
  _bindDatasets(T, partial){
    const out = {}, problems = [], weak = [];
    for (const [ds, def] of this.datasets) {
      const r = this._findDataset(ds, def, T);
      if (r.table) { out[ds] = r.table.name; if (r.weak) weak.push(ds); continue; }
      if (!partial) throw e(r.error, r.code);
      problems.push({ dataset: ds, code: r.code, message: r.error, candidates: def.match || [] });
    }
    return { ds: out, problems, weak };
  }
  // partial（默认）：某个领域包缺数据集只跳过它自己的指标/维度/关系，别的领域照常绑定，并在 this.unbound 里写明缺什么。
  // strict：老行为，缺一个数据集就整体失败。
  bind(tables, dict, opt){
    const strict = !!(opt && opt.strict);
    const T = Array.isArray(tables) ? tables : Object.entries(tables || {}).map(([name, t]) => ({ name, columns: (t && t.columns) || [] }));
    const { ds, problems, weak } = this._bindDatasets(T, !strict);
    if (!Object.keys(ds).length) throw e(`没有任何数据集能绑定到用户表（缺：${problems.map(p => p.dataset).join('、') || '无可用表'}）`, 'missing_dataset');
    this._ds = ds; this.unbound = problems; this.weakDatasets = weak;
    const unboundIds = [];
    for (const m of this.metrics.values()) {
      if (m.kind !== 'simple') continue;
      const table = ds[m.dataset];
      if (!table) { m.unbound = true; m.boundTo = null; unboundIds.push(m.id); continue; }
      if (m.role) {
        const want = ['sum', 'avg', 'max', 'min'].includes(m.agg) ? 'number' : null;
        try { m.field = this._matchCol(T.find(t => t.name === table), m.match, want, dict); }
        catch (err) {
          if (!err.semantic) throw err;
          // 一个领域包的列名对不上：只把这个指标标成未绑定，不拖垮其它包
          m.unbound = true; m.boundTo = table; m.bindingError = { code: 'missing_column', message: err.message }; unboundIds.push(m.id); continue;
        }
      }
      m.dataset = table;      // count / dcount 之类无 role 的指标也要绑定到真实表
      m.unbound = false; m.boundTo = table;
    }
    for (const d of this.dims.values()) {
      if (d.source && d.source.table) continue;
      const table = ds[d.dataset];
      if (!table) { d.unbound = true; unboundIds.push(d.id); continue; }
      const want = d.kind === 'bucket' ? 'number' : d.kind === 'timeBucket' ? 'date' : null;
      try {
        let field;
        try { field = this._matchCol(T.find(t => t.name === table), d.match, want, dict); }
        catch (err) {
          // 10-23：时间维度本来要日期类型的列；文本日期列（登记过写法的）也认，编译时转成日期
          const tb = T.find(t => t.name === table);
          const txt = want === 'date' && tb ? { name: tb.name, columns: (tb.columns || []).filter(c => this.dateFormats[`${tb.name}.${c.name}`]) } : null;
          if (!err.semantic || !txt || !txt.columns.length) throw err;
          field = this._matchCol(txt, d.match, null, dict);
        }
        d.source = { table, field };
      }
      catch (err) {
        if (!err.semantic) throw err;
        d.unbound = true; d.bindingError = { code: 'missing_column', message: err.message }; unboundIds.push(d.id);
      }
    }
    for (const r of this.rels.values()) {
      const L = ds[r.left], R = ds[r.right];
      if (!L || !R) { r.unbound = true; unboundIds.push(r.id); continue; }
      const lt = T.find(t => t.name === L), rt = T.find(t => t.name === R);
      // 支持复合键：pairs = [["订单号","order_id"], ["店铺ID","store_id"]]（每项两侧各自给候选名）；
      // 老格式 keys 仍按单键处理。两侧列名可以不同（订单号 vs order_id）。
      const raw = Array.isArray(r.pairs) ? r.pairs.filter(Boolean) : [];
      // pairs 里每一项是一对「左候选 / 右候选」，候选自身可以是数组；
      // 老的 keys 列表是「同一个键的多个叫法」（订单号 / order_id），所以是**一对**、两侧都从这组叫法里找。
      const cand = raw.length && Array.isArray(raw[0]) ? raw.map(([l, rr]) => [l, rr])
        : raw.length && raw[0] && raw[0].left != null ? raw.map(x => [x.left, x.right])
        : (r.keys && r.keys.length ? [[r.keys, r.keys]] : []);
      if (!cand.length) throw e(`关系「${r.id}」缺 pairs / keys`, 'bad_relationship');
      try {
        r.left = L; r.right = R;
        r.pairs = cand.map(([lc, rc]) => [this._matchCol(lt, lc, null, dict), this._matchCol(rt, rc, null, dict)]);
        r.unbound = false;
      } catch (err) {
        if (!err.semantic) throw err;
        r.unbound = true; r.bindingError = { code: 'missing_column', message: err.message }; unboundIds.push(r.id);
      }
    }
    // P1：把声明的 grain（数据集 → 键列候选）绑到真实列。半可加期末快照、去重、跨表粒度检查都靠它；
    // 对不上就记 grainProblems，需要时按 unsupported_operator 报缺口，绝不猜一组列当 grain。
    this.grainCols = new Map(); this.grainProblems = [];
    for (const [dsId, cols] of this.grains) {
      const table = ds[dsId];
      if (!table) { this.grainProblems.push({ dataset: dsId, code: 'missing_dataset', message: '数据集未绑定' }); continue; }
      const tb = T.find(t => t.name === table);
      try {
        const bound = (Array.isArray(cols) ? cols : [cols]).map(c => this._matchCol(tb, [c], null, dict));
        this.grainCols.set(table, { dataset: dsId, columns: bound });
      } catch (err) {
        if (!err.semantic) throw err;
        this.grainProblems.push({ dataset: dsId, table, code: 'missing_grain_column', message: err.message });
      }
    }
    this.unboundIds = [...new Set(unboundIds)];
    return this;
  }
  // 只要有一个叶子指标没绑定，这个指标就算不可用（校验错误码统一为 missing_binding）
  isBound(metricId){
    const m = this.metric(metricId);
    if (m.kind === 'simple') return !m.unbound;
    return this.leaves(metricId).every(id => !this.metrics.get(id).unbound);
  }

  /* ---------- P1：关系实测 / 粒度 ---------- */
  // 用真实行实测每条关系的基数与键唯一性。声明与实测不一致 → 这条关系标记 unverified，
  // 不再进安全路径（调用方会看到 relation_unverified / fanout，而不是一个看着正常的错数）。
  measureRelations(o = {}){
    const rowsOf = typeof o.rowsOf === 'function' ? o.rowsOf : null;
    const store = o.rows || {};
    const rowsFor = name => {
      if (rowsOf) { const r = rowsOf(name); return Array.isArray(r) ? r : (r && Array.isArray(r.rows) ? r.rows : null); }
      const r = store[name];
      return Array.isArray(r) ? r : (r && Array.isArray(r.rows) ? r.rows : null);
    };
    const out = [];
    for (const r of this.rels.values()) {
      if (r.unbound) { r.verification = { ok: false, code: 'missing_binding' }; r.unverified = true; out.push({ id: r.id, ok: false, code: 'missing_binding' }); continue; }
      const m = relations.measureRelation({ declared: r.cardinality, pairs: r.pairs, leftRows: rowsFor(r.left), rightRows: rowsFor(r.right), left: r.left, right: r.right });
      r.verification = Object.assign({ at: new Date().toISOString() }, m);
      r.measuredCardinality = m.measured;
      r.unverified = !m.ok;
      out.push({ id: r.id, ok: m.ok, declared: r.cardinality, measured: m.measured, code: m.code || null,
        message: m.message, composite: (r.pairs || []).length > 1 });
    }
    this.relationsVerified = out.every(x => x.ok);
    return { ok: this.relationsVerified, relations: out };
  }
  // 某张真实表声明的 grain 列（已绑定）；没有声明 / 绑不上 → null（调用方按缺口处理，不猜）
  grainColumnsFor(tableName){
    return this.grainCols && this.grainCols.has(tableName) ? this.grainCols.get(tableName).columns.slice() : null;
  }
  _grainByTable(){ const out = {}; if (this.grainCols) for (const [t, g] of this.grainCols) out[t] = g.columns.slice(); return out; }
  graph(){ return new relations.RelationGraph([...this.rels.values()]); }
  bridges(){ return this.graph().bridges(this._grainByTable()); }
  // grain 缺失/不覆盖连接键的疑似桥表：只提示，不参与扇出判定（避免点名错表）
  bridgeCandidates(){
    const strict = new Set(this.bridges().map(b => b.table));
    return this.graph().bridges(this._grainByTable(), true).filter(b => !strict.has(b.table));
  }

  metric(id){ const m = this.metrics.get(id); if (!m) throw e(`没有指标：${id}`); return m; }
  dim(id){ const d = this.dims.get(id); if (!d) throw e(`没有维度：${id}`); return d; }
  leaves(id){
    const m = this.metrics.get(id); if (!m) throw e(`没有指标：${id}`);
    if (m.kind === 'simple') return [id];
    if (m.kind === 'ratio') return [...this.leaves(m.num), ...this.leaves(m.den)];
    const out = [];
    const rec = x => { if (typeof x === 'string') out.push(...this.leaves(x)); else x.args.forEach(rec); };
    rec(m.expr); return [...new Set(out)];
  }

  _safeHop(cur){
    const hops = [];
    for (const r of this.rels.values()) {
      if (r.unbound || r.unverified || !Array.isArray(r.pairs) || !r.pairs.length) continue;   // 没实测通过的关系不参与安全寻路
      const pairs = r.pairs.map(p => Array.isArray(p) ? [p[0], p[1]] : [p.left, p.right]);
      if (r.left === cur && (r.cardinality === 'N:1' || r.cardinality === '1:1'))
        hops.push({ next: r.right, pairs: pairs.map(([l, rr]) => ({ baseKey: l, oneKey: rr })), baseKey: pairs[0][0], oneKey: pairs[0][1] });
      else if (r.right === cur && (r.cardinality === '1:N' || r.cardinality === '1:1'))
        hops.push({ next: r.left, pairs: pairs.map(([l, rr]) => ({ baseKey: rr, oneKey: l })), baseKey: pairs[0][1], oneKey: pairs[0][0] });
    }
    return hops;
  }
  _adj(cur){
    const next = [];
    for (const r of this.rels.values()) {
      if (r.unbound) continue;
      if (r.left === cur) next.push(r.right);
      else if (r.right === cur) next.push(r.left);
    }
    return next;
  }
  _safePath(base, target, depth = 5){
    const q = [{ t: base, path: [] }], seen = new Set([base]);
    while (q.length) {
      const { t, path } = q.shift();
      if (t === target) return path;
      if (path.length >= depth) continue;
      for (const hop of this._safeHop(t)) {
        if (seen.has(hop.next)) continue;
        seen.add(hop.next);
        q.push({ t: hop.next, path: [...path, hop] });
      }
    }
    return null;
  }
  _anyPath(base, target, depth = 6){
    const q = [{ t: base, path: [] }], seen = new Set([base]);
    while (q.length) {
      const { t, path } = q.shift();
      if (t === target) return path;
      if (path.length >= depth) continue;
      for (const nx of this._adj(t)) {
        if (seen.has(nx)) continue;
        seen.add(nx);
        q.push({ t: nx, path: [...path, nx] });
      }
    }
    return null;
  }
  // 计算项：比率 / 派生指标里「各自单独聚合」的那几项。普通叶子就是自己；行级乘积的派生指标（销售额 = 数量 × 单价）整体算一项
  _termIds(id){
    const m = this.metrics.get(id); if (!m) throw e(`没有指标：${id}`);
    if (this.rowProductOf(id)) return [id];
    if (m.kind === 'simple') return [id];
    const sub = x => this._termIds(String(x).replace(/^m:/, ''));
    if (m.kind === 'ratio') return [...new Set([...sub(m.num), ...sub(m.den)])];
    const out = [];
    const rec = x => { if (typeof x === 'string') out.push(...sub(x)); else x.args.forEach(rec); };
    rec(m.expr); return [...new Set(out)];
  }
  // 行级乘积（第三轮）：派生指标 = A × B，A 是事实表上的 sum 叶子，B 是沿安全 N:1 路径可达表上的属性字段。
  // 正确口径是「逐行相乘再求和」（Σ 可用库存×单价），不是「Σ可用库存 × 平均单价」；多实体时两者不同。
  rowProductOf(metricId){
    const m = this.metrics.get(String(metricId == null ? '' : metricId).replace(/^m:/, ''));
    if (!m || m.kind !== 'derived' || !m.expr || m.expr.op !== 'mul' || !Array.isArray(m.expr.args) || m.expr.args.length !== 2) return null;
    const [x, y] = m.expr.args;
    if (typeof x !== 'string' || typeof y !== 'string') return null;
    const A = this.metrics.get(String(x).replace(/^m:/, '')), B = this.metrics.get(String(y).replace(/^m:/, ''));
    const pick = (F, G) => {
      if (!F || !G || F.kind !== 'simple' || G.kind !== 'simple' || F.unbound || G.unbound) return null;
      if (F.agg !== 'sum' || !F.field || !G.field || !['avg', 'max', 'min', 'sum'].includes(G.agg)) return null;
      if (F.dataset === G.dataset) return G.agg === 'avg' ? { fact: F, attr: G, path: [] } : null;
      const path = this._safePath(F.dataset, G.dataset);
      return path ? { fact: F, attr: G, path } : null;
    };
    return pick(A, B) || pick(B, A);
  }
  // 一致键（第三轮）：筛选字段恰好就是 base 与该表之间关系的连接键 → 在 base 自己的键列上筛，等价且不扇出
  _keyOnBase(base, table, field){
    for (const r of this.rels.values()) {
      if (r.unbound || !Array.isArray(r.pairs)) continue;
      for (const p of r.pairs) {
        const l = Array.isArray(p) ? p[0] : p.left, rr = Array.isArray(p) ? p[1] : p.right;
        if (r.left === base && r.right === table && rr === field) return l;
        if (r.right === base && r.left === table && l === field) return rr;
      }
    }
    return null;
  }
  _relBetween(a, b){
    for (const r of this.rels.values()) {
      if (r.unbound) continue;
      if (r.left === a && r.right === b) return { rel: r, side: 'L' };
      if (r.left === b && r.right === a) return { rel: r, side: 'R' };
    }
    return null;
  }

  checkJoin(metricId, dimIds){
    const ids = Array.isArray(dimIds) ? dimIds : [];
    const rp = this.rowProductOf(metricId);
    for (const leaf of (rp ? [rp.fact.id] : this._termIds(metricId).map(t => { const r2 = this.rowProductOf(t); return r2 ? r2.fact.id : t; }))) {
      const m = this.metrics.get(leaf);
      // 去重计数对扇出不敏感：COUNT(DISTINCT x) 不会因为同一行匹配多次而变大（N:N 桥表也能用）。
      const fanoutSafe = m.agg === 'dcount';
      const base = m.dataset;
      for (const id of ids) {
        const d = this.dim(id);
        const t = (d.source && d.source.table) || d.dataset;
        if (!t || t === base) continue;
        if (this._safePath(base, t)) continue;
        const any = this.graph().anyPath(base, t);
        if (any) {
          if (any.unverified) throw e(`关系未通过实测：「${base}」→「${t}」路径上有关系的声明基数与实测不符，不能当安全路径用（先 measureRelations / 确认基数）`, 'relation_unverified');
          if (fanoutSafe) continue;
          const n2n = any.cards.includes('N:N');
          const bridge = n2n || any.path.length > 1
            ? this.bridges().find(b => any.path.some(x => x.to === b.table || (x.rel && x.rel.left === b.table)))
            : null;
          if (n2n || bridge) {
            throw e(`扇出风险：「${m.name}」不能按「${d.name}」分组（「${base}」→「${t}」经过 N:N${bridge ? ' 桥表「' + bridge.table + '」' : ''}，同一行会匹配多行；归因/权重未声明，不估算）。可改用 dcount，或先声明分配权重再算。`, 'fanout');
          }
          throw e(`扇出风险：「${m.name}」是${ADD_NAME[m.additivity] || ''}指标，不能按「${d.name}」分组（「${base}」到「${t}」要经过 1:N，会放大行）。先按粒度预聚合到 1 侧，或改用 1 侧字段 / dcount；半可加快照请按 grain 取期末值。`, 'fanout');
        }
        throw e(`表「${base}」和「${t}」之间没有声明关系，无法按「${d.name}」分组`, 'missing_relationship');
      }
    }
    return { ok: true };
  }

  _agg(agg, field, rows){
    if (agg === 'count') return rows.length;
    const vs = rows.map(r => n(r[field])).filter(v => v != null);
    if (agg === 'sum') return vs.length ? sum(vs) : null;
    if (agg === 'avg') return vs.length ? sum(vs) / vs.length : null;
    if (agg === 'max') return vs.length ? Math.max(...vs) : null;
    if (agg === 'min') return vs.length ? Math.min(...vs) : null;
    if (agg === 'dcount') return new Set(rows.map(r => r[field]).filter(v => v != null)).size;   // 与 SQL COUNT(DISTINCT) 一致：NULL 不计数
    if (agg === 'last') return rows.length ? n(rows[rows.length - 1][field]) : null;
    throw e(`agg 无效：${agg}`);
  }
  _dimFn(d){
    const s = d.source || {};
    if (d.kind === 'column') return r => r[s.field];
    if (d.kind === 'timeBucket') return r => bucketDate(r[s.field], d.grain);
    if (d.kind === 'map') return r => { const v = r[s.field]; return Object.prototype.hasOwnProperty.call(d.mapping, v) ? d.mapping[v] : (d.default || '其他'); };
    if (d.kind === 'bucket') return r => {
      const v = n(r[s.field]);
      if (v == null) return '（空）';
      for (let i = 0; i < d.edges.length; i++) if (v <= d.edges[i]) return (d.labels && d.labels[i]) || `≤${d.edges[i]}`;
      return (d.labels && d.labels[d.edges.length]) || `>${d.edges[d.edges.length - 1]}`;
    };
    throw e(`维度 kind 无效：${d.kind}`);
  }
  _rows(tables, name){
    const x = tables && tables[name];
    return Array.isArray(x) ? x : (x && x.rows) || [];
  }
  _labelers(dimIds, base, tables){
    return dimIds.map(id => {
      const d = this.dim(id);
      const t = (d.source && d.source.table) || d.dataset;
      if (!t || t === base) return this._dimFn(d);
      const path = this._safePath(base, t);
      if (!path) throw e(`无法按「${d.name}」分组：缺关系声明，或路径上存在扇出`);
      const dimFn = this._dimFn(d);
      const steps = path.map(hop => {
        const lookup = new Map(), oneKeys = hop.pairs.map(p => p.oneKey);
        for (const r of this._rows(tables, hop.next)) {
          const k = oneKeys.map(c => r[c]).map(v => v == null ? null : String(v)).join(KEY);
          if (oneKeys.every((c, i) => r[c] != null) && !lookup.has(k)) lookup.set(k, r);
        }
        return { baseKeys: hop.pairs.map(p => p.baseKey), lookup };
      });
      return row => {
        let cur = row;
        for (const s of steps) {
          const k = cur ? s.baseKeys.map(c => cur[c]).map(v => v == null ? null : String(v)).join(KEY) : null;
          cur = k != null ? s.lookup.get(k) : undefined;
        }
        return cur ? dimFn(cur) : '（空）';
      };
    });
  }
  // dcount 专用：同一行可以沿 1:N / N:N 匹配多个维度行（去重计数不受放大影响），
  // 所以标签返回数组，按「行 × 每个匹配到的维度值」展开再数不同值。SQL 侧用 JOIN 放大 + COUNT(DISTINCT)。
  _multiLabelers(dimIds, base, tables){
    return dimIds.map(id => {
      const d = this.dim(id);
      const t = (d.source && d.source.table) || d.dataset;
      const dimFn = this._dimFn(d);
      if (!t || t === base) return row => [dimFn(row)];
      const any = this.graph().anyPath(base, t);
      if (!any) throw e(`无法按「${d.name}」分组：缺关系声明`, 'missing_relationship');
      if (any.unverified) throw e(`关系未通过实测：无法按「${d.name}」分组`, 'relation_unverified');
      const steps = any.path.map(edge => {
        const idx = new Map(), oneKeys = edge.pairs.map(p => p.oneKey);
        for (const r of this._rows(tables, edge.to)) {
          const k = oneKeys.map(c => r[c]).map(v => v == null ? null : String(v)).join(KEY);
          if (!idx.has(k)) idx.set(k, []);
          idx.get(k).push(r);
        }
        return { baseKeys: edge.pairs.map(p => p.baseKey), idx, multi: !!edge.fanout };
      });
      return row => {
        let cur = [row];
        for (const s of steps) {
          const next = [];
          for (const r of cur) {
            if (!r) { next.push(null); continue; }
            const k = s.baseKeys.map(c => r[c]).map(v => v == null ? null : String(v)).join(KEY);
            const hits = s.idx.get(k);
            if (!hits || !hits.length) next.push(null);
            else next.push(...hits);
          }
          cur = next;
          if (!cur.length) break;
        }
        return cur.map(r => (r ? dimFn(r) : '（空）'));
      };
    });
  }
  _eval(id, dimIds, tables){
    const m = this.metrics.get(id);
    if (m.kind === 'simple') return this._evalSimple(m, dimIds, tables);
    if (m.kind === 'ratio') return this._evalRatio(m, dimIds, tables);
    return this._evalDerived(m, dimIds, tables);
  }
  _evalSimple(m, dimIds, tables){
    // 半可加（快照）指标：同一 grain 键在期间内有多行时取日期最后一行，再按维度分组 / 合计。
    // 没有日期列却有重复 grain 行 → 明确报缺口，不把多期快照直接加总。
    const rows0 = this._rows(tables, m.dataset);
    const rows = m.additivity === 'semiAdditive' ? this._snapshotRows(m, rows0, dimIds) : rows0;
    // 不可加（平台算好的比率 / 平均值列）：同一组里多于一行就是在跨行汇总，不估算
    const noneCheck = (rs) => { if (m.additivity === 'none' && m.agg !== 'count' && rs.length > 1) throw this._noneGap(m); };
    // dcount 可以跨 1:N / N:N 分组：同一行匹配多个维度值时按每个值展开，再数不同值（放大不影响去重计数）。
    const fanoutDim = m.agg === 'dcount' && dimIds.some(id => {
      const d = this.dim(id);
      const t = (d.source && d.source.table) || d.dataset;
      return t && t !== m.dataset && !this._safePath(m.dataset, t);
    });
    if (fanoutDim) {
      const labelFns = this._multiLabelers(dimIds, m.dataset, tables);
      const groups = new Map();
      for (const r of rows) {
        let combos = [[]];
        for (const fn of labelFns) {
          const values = fn(r);
          combos = combos.flatMap(c => values.map(v => [...c, v]));
          if (!combos.length) break;
        }
        for (const c of combos) {
          const k = c.map(v => v == null ? '（空）' : String(v)).join(KEY);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(r);
        }
      }
      const out = new Map();
      for (const [k, rs] of groups) out.set(k, this._agg(m.agg, m.field, rs));
      return { scalar: null, records: rows.length, map: out };
    }
    const labels = this._labelers(dimIds, m.dataset, tables);
    if (!labels.length) { noneCheck(rows); return { scalar: this._agg(m.agg, m.field, rows), records: rows.length, map: null }; }
    const map = new Map();
    for (const r of rows) {
      const k = labels.map(f => f(r)).map(v => v == null ? '（空）' : String(v)).join(KEY);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    const out = new Map();
    for (const [k, rs] of map) { noneCheck(rs); out.set(k, this._agg(m.agg, m.field, rs)); }
    return { scalar: null, records: rows.length, map: out };
  }
  // 「不可加」指标被要求跨行汇总时的能力缺口（问数转兜底，或改用分子合计 ÷ 分母合计的补算指标）
  _noneGap(m){
    return gap(`「${m.name || m.id}」是平台算好的比率 / 平均值，不能跨行相加或求平均当总体值：只能看单行，或筛到单行再看。要算总体请用「分子合计 ÷ 分母合计」（补算指标）`, 'unsupported_operator');
  }
  // SQL 路径：不可加指标只许「筛选后看单行」。要按期间聚合、或完全没有筛选（= 整表汇总），都报缺口
  _guardNone(metricId, opts){
    const o = opts || {};
    const hasFilter = Array.isArray(o.filters) && o.filters.some(f => f && f.field);
    const hasPeriod = !!(o.period && (o.period.from || o.period.to));
    for (const id of this.leaves(metricId)) {
      const m = this.metrics.get(id);
      if (m && m.additivity === 'none' && m.agg !== 'count' && (hasPeriod || !hasFilter)) throw this._noneGap(m);
    }
  }
  // 半可加快照去重：按声明的 grain 里的「实体键」取期间内日期最后一行（日期本身不进分区键）。
  // grain / 日期列缺失且有重复行 → 能力缺口，不估算。
  _snapshotRows(m, rows, dimIds){
    const grain = this.grainColumnsFor(m.dataset);
    if (!grain || !grain.length) throw gap(`「${m.name}」是半可加（快照）指标，但表「${m.dataset}」没有声明 grain：不知道「一个实体」是什么，不估算跨期合计`, 'unsupported_operator');
    if (!rows.length) return rows;
    const date = dateFieldForBase(this, m.dataset);
    const keys = grain.filter(c => c !== date);
    // 按时间桶分组时，期末值要「每个时间桶内各自取最后一行」：时间桶表达式也是去重分区键的一部分；
    // 跨表的时间桶不能在去重前算出来，明确报缺口。
    const timeDims = (Array.isArray(dimIds) ? dimIds : []).map(id => this.dim(id)).filter(d => d.kind === 'timeBucket');
    for (const d of timeDims) if (!d.source || d.source.table !== m.dataset) throw gap(`「${m.name}」是半可加快照，按跨表时间维度「${d.name}」分组要先取期末快照：发射器未实现，不估算`, 'unsupported_operator');
    const keyOfRow = r => [...keys.map(c => r[c]), ...timeDims.map(d => bucketDate(r[d.source.field], d.grain))].map(v => v == null ? '' : String(v)).join(relations.KEY);
    if (!date) {
      // 没有日期列：同一实体多行时无法取期末值（JS 能检出重复，SQL 路径会按缺口处理）
      const seen = new Set();
      for (const r of rows) {
        const k = grain.map(c => r[c] == null ? '' : String(r[c])).join(relations.KEY);
        if (seen.has(k)) throw gap(`「${m.name}」是半可加（快照）指标，但表上没有日期列：同一 grain 有多行时无法确定取哪一行（期末值），不估算`, 'unsupported_operator');
        seen.add(k);
      }
      return rows;
    }
    if (!keys.length) {
      // grain 只有日期（每天一行）：取期间最后一天，不跨天相加
      let max = '';
      for (const r of rows) max = String(r[date] || '') > max ? String(r[date] || '') : max;
      return rows.filter(r => String(r[date] || '') === max);
    }
    const by = new Map();
    for (const r of rows) {
      const k = keyOfRow(r);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    if (![...by.values()].some(g => g.length > 1)) return rows;
    const out = [];
    for (const g of by.values()) {
      if (g.length === 1) { out.push(g[0]); continue; }
      let pick = g[0];
      for (const r of g) if (String(r[date] || '') >= String(pick[date] || '')) pick = r;
      out.push(pick);
    }
    return out;
  }
  // 空组补 0 的规则：可加指标（sum/count）在没有匹配行时就是 0；比率 / 半可加不补（null 表示不可比）。
  _zeroIfAdditive(id){ const m = this.metrics.get(id); return !!(m && m.additivity === 'additive'); }
  _evalRatio(m, dimIds, tables){
    const a = this._eval(m.num, dimIds, tables), b = this._eval(m.den, dimIds, tables);
    const ratio = (x, y) => (x == null || y == null || y === 0 ? null : (x / y) * (m.mul || 1));
    if (dimIds.length === 0) return { scalar: ratio(a.scalar, b.scalar), records: a.records, map: null };
    const out = new Map(), keys = new Set([...a.map.keys(), ...b.map.keys()]);
    for (const k of keys) {
      const x = a.map.has(k) ? a.map.get(k) : (this._zeroIfAdditive(m.num) ? 0 : null);
      const y = b.map.has(k) ? b.map.get(k) : (this._zeroIfAdditive(m.den) ? 0 : null);
      out.set(k, ratio(x, y));
    }
    return { scalar: null, records: a.records, map: out };
  }
  _evalDerived(m, dimIds, tables){
    return this._evalNode(m.expr, dimIds, tables);
  }
  _evalNode(x, dimIds, tables){
    if (typeof x === 'string') return this._eval(x, dimIds, tables);
    const a = this._evalNode(x.args[0], dimIds, tables), b = this._evalNode(x.args[1], dimIds, tables);
    const combine = (op, p, q) => (op === 'add' ? p + q : op === 'sub' ? p - q : op === 'mul' ? p * q : div(p, q));
    const miss = (arg) => typeof arg === 'string' && this._zeroIfAdditive(arg) ? 0 : null;
    if (dimIds.length === 0) return { scalar: combine(x.op, a.scalar, b.scalar), records: a.records, map: null };
    const out = new Map(), keys = new Set([...a.map.keys(), ...b.map.keys()]);
    for (const k of keys) {
      const p = a.map.has(k) ? a.map.get(k) : miss(x.args[0]);
      const q = b.map.has(k) ? b.map.get(k) : miss(x.args[1]);
      out.set(k, combine(x.op, p, q));
    }
    return { scalar: null, records: a.records, map: out };
  }
  /* ---------- 比率公共计算路径（ratio / share / yoy / pp） ---------- */
  // 取数：先把结构化过滤与期间作用到每个叶子的基表上，再走既有 eval（简单/派生/比率都能复用）。
  // 跨表指标按各自基表的日期列过滤，口径逐表写明；只接受结构化条件，不收任意 SQL 片段。
  _scopedTables(metricId, tables, filters, span, periodField){
    const leaves = this.leaves(metricId);
    const bases = [...new Set(leaves.map(id => this.metrics.get(id).dataset || this.metrics.get(id).boundTo))];
    const scoped = Object.assign({}, tables);
    for (const base of bases) {
      const rows = this._rows(tables, base);
      const cols = new Set();
      for (const r of rows) for (const k of Object.keys(r || {})) cols.add(k);
      const use = [];
      for (const f of (filters || [])) {
        if (f.table && f.table !== base) continue;
        if (!cols.has(f.field)) {
          if (!rows.length) continue;                 // 空表：过滤后仍为空，不从数据猜列
          throw e(`筛选条件「${f.field}」不在表「${base}」上`, 'bad_filter');
        }
        use.push(f);
      }
      let out = rows;
      if (use.length) out = out.filter(r => use.every(f => rowMatches(r, f)));
      if (span) {
        const field = periodField || dateFieldForBase(this, base);
        if (!field) throw gap(`期间计算：表「${base}」没有日期列，算不了这段期间`, 'unsupported_operator');
        out = out.filter(r => inSpan(r[field], span));
      }
      scoped[base] = out;
    }
    return scoped;
  }
  // 先聚合：同一指标按同一组维度聚合出一行一个值，绝不拿各行比率再平均。
  _aggregateFor(metricId, dimIds, tables, filters, span, periodField){
    this.checkJoin(metricId, dimIds);
    return this._eval(metricId, dimIds, this._scopedTables(metricId, tables, filters, span, periodField));
  }
  _checkRatioMetric(id, role){
    if (!id) throw e(`比率 ${role} 缺指标 id`, 'bad_ratio_spec');
    const m = this.metric(id);
    if (!this.isBound(id)) throw e(`指标「${id}」没绑定到用户表，不能算比率`, 'missing_binding');
    return m;
  }
  // 比值 / 占比：分子分母各自先聚合到同一组维度，再相除。
  _evalQuotient(kind, spec, dims, tables, filters, scope){
    const ref = spec.metric ? this._checkRatioMetric(spec.metric, 'metric') : null;
    const numId = spec.num || (ref && ref.num);
    const denId = spec.den || (kind === 'share' ? numId : (ref && ref.den));
    const numM = this._checkRatioMetric(numId, '分子');
    const denM = this._checkRatioMetric(denId, '分母');
    const unit = spec.unit != null ? String(spec.unit) : (ref && ref.unit) || (kind === 'share' ? '%' : '');
    const scale = spec.scale != null ? Number(spec.scale)
      : (kind === 'share' ? 100 : (ref && ref.mul != null ? Number(ref.mul) : (unit === '%' ? 100 : 1)));
    if (!Number.isFinite(scale) || scale === 0) throw e('比率 scale 要是非零有限数字', 'bad_ratio_spec');
    const decimals = spec.decimals != null ? spec.decimals : (ref && ref.decimals);
    const split = splitFilters(filters, scope);
    const numRes = this._aggregateFor(numId, dims, tables, filters);
    // 分母作用域显式：分组维度不进占比分母；是否去掉当前分组条件由 den_scope 决定（权限/用户过滤永不丢）。
    const denRes = kind === 'share'
      ? this._aggregateFor(denId, [], tables, split.filters)
      : this._aggregateFor(denId, dims, tables, split.filters);
    const base = {
      kind, kind_name: RATIO_KIND_NAME[kind], unit, scale, decimals,
      numerator_metric: numId, denominator_metric: denId,
      numerator_label: numM.name || numId, denominator_label: denM.name || denId,
      formula: (kind === 'share' ? `${numId} / 总体(${denId})` : `${numId} / ${denId}`) + (scale !== 1 ? ` × ${scale}` : '') + (kind === 'share' ? '（分母 = 去掉当前分组条件的总体）' : ''),
      scope: { drop_group_filter: scope.drop_group_filter === true, keep: scope.keep.slice(), dropped_filters: split.dropped },
      records: { num: numRes.records, den: denRes.records },
    };
    if (!dims.length) {
      const nv = numRes.scalar, dv = denRes.scalar, st = ratioStatusOf(nv, dv);
      return Object.assign(base, { status: st, value: st === 'ok' ? (nv / dv) * scale : null, numerator: nv, denominator: dv, rows: [] });
    }
    if (kind === 'share') {
      const dv = denRes.scalar;
      const rows = [...numRes.map.entries()].map(([k, nv]) => {
        const st = ratioStatusOf(nv, dv);
        return { label: k.split(KEY), value: st === 'ok' ? (nv / dv) * scale : null, status: st, numerator: nv, denominator: dv };
      });
      return Object.assign(base, { status: overallStatus(rows), value: null, numerator: null, denominator: dv, rows });
    }
    const keys = new Set([...numRes.map.keys(), ...denRes.map.keys()]);
    const rows = [];
    for (const k of keys) {
      const nv = numRes.map.has(k) ? numRes.map.get(k) : (this._zeroIfAdditive(numId) ? 0 : null);
      const dv = denRes.map.has(k) ? denRes.map.get(k) : (this._zeroIfAdditive(denId) ? 0 : null);
      const st = ratioStatusOf(nv, dv);
      rows.push({ label: k.split(KEY), value: st === 'ok' ? (nv / dv) * scale : null, status: st, numerator: nv, denominator: dv });
    }
    return Object.assign(base, { status: overallStatus(rows), value: null, numerator: null, denominator: null, rows });
  }
  // 同比增长率：同一指标在两个期间各聚合一次，再算 (本期 - 上期) / 上期。缺对比期单独报 missing_comparison。
  _evalYoy(spec, dims, tables, filters, scope){
    const id = spec.metric || spec.num;
    const m = this._checkRatioMetric(id, '同比指标');
    const periods = spec.periods || spec.comparison || {};
    const cur = normalizeSpan(periods.current, '同比本期');
    const prev = normalizeSpan(periods.previous, '同比对比期');
    const periodField = spec.period_field || spec.periodField || null;
    const split = splitFilters(filters, scope);
    const curRes = this._aggregateFor(id, dims, tables, split.filters, cur, periodField);
    const prevRes = this._aggregateFor(id, dims, tables, split.filters, prev, periodField);
    const unit = spec.unit != null ? String(spec.unit) : '%';
    const scale = spec.scale != null ? Number(spec.scale) : 100;
    if (!Number.isFinite(scale) || scale === 0) throw e('同比 scale 要是非零有限数字', 'bad_ratio_spec');
    const decimals = spec.decimals != null ? spec.decimals : (m.decimals == null ? 2 : m.decimals);
    const statusOf = (c, p) => (c == null ? 'no_data' : p == null ? 'missing_comparison' : p === 0 ? 'zero_denominator' : 'ok');
    const growth = (c, p) => statusOf(c, p) === 'ok' ? ((c - p) / p) * scale : null;
    const base = {
      kind: 'yoy', kind_name: RATIO_KIND_NAME.yoy, unit, scale, decimals,
      numerator_metric: id, denominator_metric: id, numerator_label: m.name || id, denominator_label: (m.name || id) + ' · 对比期',
      periods: { current: cur, previous: prev, period_field: periodField },
      formula: `(本期 ${id} - 上期 ${id}) / 上期 ${id}` + (scale !== 1 ? ` × ${scale}` : ''),
      scope: { drop_group_filter: scope.drop_group_filter === true, keep: scope.keep.slice(), dropped_filters: split.dropped },
      records: { current: curRes.records, previous: prevRes.records },
    };
    if (!dims.length) {
      const c = curRes.scalar, p = prevRes.scalar, st = statusOf(c, p);
      return Object.assign(base, { status: st, value: st === 'ok' ? growth(c, p) : null, numerator: c, denominator: p, rows: [] });
    }
    const keys = new Set([...curRes.map.keys(), ...prevRes.map.keys()]);
    const rows = [];
    for (const k of keys) {
      const c = curRes.map.has(k) ? curRes.map.get(k) : null;
      const p = prevRes.map.has(k) ? prevRes.map.get(k) : null;
      const st = statusOf(c, p);
      rows.push({ label: k.split(KEY), value: st === 'ok' ? growth(c, p) : null, status: st, numerator: c, denominator: p });
    }
    return Object.assign(base, { status: overallStatus(rows), value: null, numerator: null, denominator: null, rows });
  }
  // 百分点：两个「百分点口径」指标的聚合值相减。每个指标怎么换算成百分点必须由指标定义写明
  // （ratio + unit % + mul，或 percent_scale），渲染层不猜 ×100。
  _percentPoints(m, v){
    if (v == null) return null;
    if (m.percent_scale != null) return v * Number(m.percent_scale);
    if (m.unit !== '%') throw gap(`「${m.name || m.id}」单位不是 %，不能做百分点比较`, 'unsupported_operator');
    if (m.kind === 'ratio') {
      const mul = m.mul == null ? 1 : Number(m.mul);
      return v * 100 / (mul || 1);                     // ratio 定义里已乘过 mul（通常 ×100），这里还原成百分点数值
    }
    throw gap(`「${m.name || m.id}」是派生百分比指标，指标定义没声明 percent_scale：不知道算出来是小数还是百分点，不做百分点比较`, 'unsupported_operator');
  }
  _rateWithStatus(metricId, dims, tables, filters){
    const m = this._checkRatioMetric(metricId, '百分点指标');
    if (m.kind === 'ratio') {
      const numRes = this._aggregateFor(m.num, dims, tables, filters);
      const denRes = this._aggregateFor(m.den, dims, tables, filters);
      const mul = m.mul == null ? 1 : Number(m.mul);
      if (!dims.length) {
        const st = ratioStatusOf(numRes.scalar, denRes.scalar);
        const raw = st === 'ok' ? (numRes.scalar / denRes.scalar) * mul : null;
        return { metric: m, status: st, scalar: st === 'ok' ? this._percentPoints(m, raw) : null, map: null, records: numRes.records };
      }
      const keys = new Set([...numRes.map.keys(), ...denRes.map.keys()]);
      const out = new Map(); let firstBad = 'ok';
      for (const k of keys) {
        const nv = numRes.map.has(k) ? numRes.map.get(k) : (this._zeroIfAdditive(m.num) ? 0 : null);
        const dv = denRes.map.has(k) ? denRes.map.get(k) : (this._zeroIfAdditive(m.den) ? 0 : null);
        const st = ratioStatusOf(nv, dv);
        out.set(k, st === 'ok' ? this._percentPoints(m, (nv / dv) * mul) : null);
        if (st !== 'ok' && firstBad === 'ok') firstBad = st;
      }
      return { metric: m, status: keys.size ? firstBad : 'no_data', scalar: null, map: out, records: numRes.records };
    }
    const res = this._aggregateFor(metricId, dims, tables, filters);
    if (!dims.length) {
      const st = res.scalar == null ? 'no_data' : 'ok';
      return { metric: m, status: st, scalar: st === 'ok' ? this._percentPoints(m, res.scalar) : null, map: null, records: res.records };
    }
    const out = new Map(); let firstBad = 'ok';
    for (const [k, v] of res.map) {
      const st = v == null ? 'no_data' : 'ok';
      out.set(k, st === 'ok' ? this._percentPoints(m, v) : null);
      if (st !== 'ok' && firstBad === 'ok') firstBad = st;
    }
    return { metric: m, status: res.map.size ? firstBad : 'no_data', scalar: null, map: out, records: res.records };
  }
  _evalPp(spec, dims, tables, filters){
    const leftId = spec.left || spec.num, rightId = spec.right || spec.den;
    if (!leftId || !rightId) throw e('百分点 spec 缺 left/right（或 num/den）', 'bad_ratio_spec');
    const L = this._rateWithStatus(leftId, dims, tables, filters);
    const R = this._rateWithStatus(rightId, dims, tables, filters);
    const status = combineStatus([L.status, R.status]);
    const decimals = spec.decimals != null ? spec.decimals : (L.metric.decimals == null ? 2 : L.metric.decimals);
    const base = {
      kind: 'pp', kind_name: RATIO_KIND_NAME.pp, unit: 'pp', scale: 1, decimals,
      numerator_metric: leftId, denominator_metric: rightId,
      numerator_label: L.metric.name || leftId, denominator_label: R.metric.name || rightId,
      formula: `${leftId} - ${rightId}（百分点）`,
      scope: { drop_group_filter: false, keep: [], dropped_filters: [] },
      records: { left: L.records, right: R.records },
    };
    if (!dims.length) {
      return Object.assign(base, { status, value: status === 'ok' ? L.scalar - R.scalar : null, numerator: L.scalar, denominator: R.scalar, rows: [] });
    }
    const keys = new Set([...(L.map ? L.map.keys() : []), ...(R.map ? R.map.keys() : [])]);
    const rows = [];
    for (const k of keys) {
      const lv = L.map && L.map.has(k) ? L.map.get(k) : null;
      const rv = R.map && R.map.has(k) ? R.map.get(k) : null;
      const st = lv == null || rv == null ? (status === 'ok' ? 'no_data' : status) : 'ok';
      rows.push({ label: k.split(KEY), value: st === 'ok' ? lv - rv : null, status: st, numerator: lv, denominator: rv });
    }
    return Object.assign(base, { status: overallStatus(rows), value: null, numerator: null, denominator: null, rows });
  }
  // 公共入口。spec 示例（口径要么来自指标定义，要么在计划里显式写清）：
  //   { kind:'ratio', metric:'aov' }                                     // 复用指标定义里的 num/den/mul
  //   { kind:'ratio', num:'gmv', den:'order_count', unit:'¥' }
  //   { kind:'share', num:'gmv', filters:[{field:'店铺ID',values:['S1'],kind:'group',table:'销售明细'}],
  //     den_scope:{drop_group_filter:true, keep:['period','user','permission']} }
  //   { kind:'yoy', metric:'gmv', periods:{current:{start,endExclusive}, previous:{start,endExclusive}} }
  //   { kind:'pp', left:'gross_margin', right:'refund_rate' }              // gross_margin 需在指标定义声明 percent_scale
  // 返回 { kind, status, value, unit, numerator, denominator, formula, scope, rows }；status 非 ok 时 value 一律 null。
  evalRatio(spec, dimIds, tables){
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw e('evalRatio 需要结构化 spec', 'bad_ratio_spec');
    const dims = Array.isArray(dimIds) ? dimIds : [];
    const kind = spec.kind == null ? ((spec.metric && this.metric(spec.metric).ratioKind) || 'ratio') : String(spec.kind);
    if (!RATIO_KINDS.has(kind)) throw e(`比率口径无效：${kind}（只认 ${[...RATIO_KINDS].join('/')}）`, 'bad_ratio_spec');
    const filters = normalizeFilters(spec.filters);
    const scope = normalizeDenScope(spec.den_scope, kind);
    if (kind === 'yoy') return this._evalYoy(spec, dims, tables, filters, scope);
    if (kind === 'pp') return this._evalPp(spec, dims, tables, filters);
    return this._evalQuotient(kind, spec, dims, tables, filters, scope);
  }
  // 把比率结果桥接成 facts v2 的结构化 spec（A+B 接口）：状态码原样带入，渲染层能区分
  // 无数据 / 零分母 / 缺对比期；有父事实时按派生事实存公式与父编号，没有就不伪造来源。
  ratioFactSpec(result, opt){
    if (!result || typeof result !== 'object' || !RATIO_STATUS.has(result.status)) throw e('ratioFactSpec 需要 evalRatio 的结果', 'bad_ratio_spec');
    const o = opt || {};
    const spec = {
      label: o.label || `${result.kind_name || result.kind}${result.numerator_label ? ' · ' + result.numerator_label : ''}`,
      value: result.status === 'ok' ? result.value : null,
      unit: o.unit != null ? o.unit : (result.unit || ''),
      status: result.status,
      filter_fp: o.filter_fp,
      plan_id: o.plan_id,
      qid: o.qid,
      dims: o.dims,
      period: o.period,
      source: o.source,
    };
    const parents = Array.isArray(o.parents) ? o.parents : [];
    if (parents.length) { spec.parents = parents; spec.derived = true; spec.formula = o.formula || result.formula; }
    return spec;
  }
  /* ---------- 百分比口径 / 单位（结构化可判定的才补，业务口径不猜） ---------- */
  // 把指标的「聚合值」换算成「百分点」的倍数：整数值 × scale = 百分点数值。
  // 只做**结构上可判定**的推断，三种来源按优先级：
  //   declared                 指标定义里写死了 percent_scale（最权威，业务口径已确认）
  //   ratio_mul                比率指标 = 分子/分母 × mul，还原成百分点要 /mul × 100
  //   derived_fraction_same_unit 派生表达式是 div 且所有叶子同单位（不是 %）→ 结果是无量纲分数，×100 得百分点
  // 判不出来（缺单位 / 叶子单位不一致 / 取平均值 / 单位本身就是 %）返回 null：交给业务口径，不猜。
  percentScaleOf(metricId){
    const m = this.metric(String(metricId).replace(/^m:/, ''));
    if (m.percent_scale != null) {
      const s = Number(m.percent_scale);
      if (Number.isFinite(s) && s !== 0) return { scale: s, source: 'declared', unit: m.unit || '' };
    }
    if (String(m.unit || '') !== '%') return null;
    if (m.kind === 'ratio') {
      const mul = m.mul == null ? 1 : Number(m.mul);
      if (!Number.isFinite(mul) || mul === 0) return null;
      return { scale: 100 / mul, source: 'ratio_mul', unit: '%' };
    }
    if (m.kind === 'derived') {
      const top = m.expr && !Array.isArray(m.expr) ? m.expr : null;
      if (!top || top.op !== 'div') return null;
      const leaves = this.leaves(m.id).map(id => this.metrics.get(id));
      if (!leaves.length) return null;
      const units = [...new Set(leaves.map(l => String(l.unit == null ? '' : l.unit)))];
      if (units.length !== 1) return null;
      if (units[0] === '%') return null;        // 比率再相除：是不是百分点要看业务定义，不推断
      return { scale: 100, source: 'derived_fraction_same_unit', unit: '%' };
    }
    return null;
  }
  // 单位审计：只报告「能确定 / 不能确定」和依据，不修改指标定义、不替业务拍板。
  // unit_status: declared（定义里有单位）/ dimensionless（计数类，本来就没有单位）/ missing（缺单位）
  // percent_scale 用同一套结构推断；issues 列出需要业务确认的点（币种、百分比换算、派生单位不一致…）。
  unitAudit(){
    const CURRENCY = new Set(['GBP', 'USD', 'EUR', 'JPY', 'CNY', 'RMB', 'HKD', 'AUD', 'CAD', 'CHF', 'SGD', 'KRW']);
    return [...this.metrics.values()].map(m => {
      const unit = m.unit == null ? '' : String(m.unit);
      const issues = [];
      let unit_status = unit ? 'declared' : 'missing';
      if (!unit && m.kind === 'simple' && ['count', 'dcount'].includes(m.agg)) unit_status = 'dimensionless';
      if (CURRENCY.has(unit)) issues.push({
        code: 'currency_from_definition_only',
        message: `金额单位「${unit}」只来自领域包定义：用户表没有币种列，无法从数据结构确认币种`,
      });
      if (!unit && (m.kind === 'ratio' || m.kind === 'derived')) issues.push({
        code: 'unit_missing_on_ratio',
        message: '比值/派生结果没有写单位，展示时不能替它补单位',
      });
      if (m.kind === 'derived' && m.additivity !== 'ratio') {
        const us = [...new Set(this.leaves(m.id).map(id => String((this.metrics.get(id) || {}).unit || '')))];
        if (us.length > 1) issues.push({ code: 'derived_unit_mismatch', message: `加减派生指标的叶子单位不一致（${us.join('/')}），不能直接相加` });
      }
      const ps = this.percentScaleOf(m.id);
      if (unit === '%' && !ps) issues.push({
        code: 'percent_scale_undetermined',
        message: '百分比指标无法从结构确定「百分点」换算，百分点比较需要业务口径（percent_scale）',
      });
      return { id: 'm:' + m.id, name: m.name, kind: m.kind, additivity: m.additivity, unit, unit_status, percent_scale: ps, issues };
    });
  }

  eval(metricId, dimIds, tables){
    this.metric(metricId);
    this.checkJoin(metricId, dimIds);
    const r = this._eval(metricId, dimIds, tables);
    if (r.scalar != null || dimIds.length === 0) return { scalar: r.scalar, records: r.records, rows: [] };
    return { scalar: null, records: r.records, rows: [...r.map.entries()].map(([k, v]) => ({ label: k.split(KEY), value: v })) };
  }

  _dimSql(d, alias){
    const col = `${alias}.${qi(d.source.field)}`;
    if (d.kind === 'column') return col;
    if (d.kind === 'timeBucket') {
      // 日期列在用户表里可能是 VARCHAR：strftime 前先 CAST 成 DATE（DATE 列 CAST 回来也没问题）
      // 10-23：文本日期列登记过写法（如 10/21/2021 的 %m/%d/%Y）就改用 TRY_STRPTIME 转，转不动的行是空，不报错
      const dt = this._dateSql(d.source.table, col, d.source.field);
      if (d.grain === 'week') return `strftime('%Y-%m-%d', date_trunc('week', ${dt}))`;
      if (d.grain === 'month') return `strftime('%Y-%m', ${dt})`;
      if (d.grain === 'year') return `strftime('%Y', ${dt})`;
      // 季度：日历季度（跨年同比按「年-季」对齐，2026-Q3 ↔ 2025-Q3）；先 CAST 成 DATE，列是 VARCHAR 也能算
      if (d.grain === 'quarter') return `strftime('%Y', ${dt}) || '-Q' || CAST(quarter(${dt}) AS VARCHAR)`;
      return `strftime('%Y-%m-%d', ${dt})`;
    }
    if (d.kind === 'bucket') {
      let out = `CASE WHEN ${col} IS NULL THEN ${ql('（空）')}`;
      d.edges.forEach((ed, i) => { out += ` WHEN ${col} <= ${Number(ed)} THEN ${ql((d.labels && d.labels[i]) || `≤${ed}`)}`; });
      out += ` ELSE ${ql((d.labels && d.labels[d.edges.length]) || `>${d.edges[d.edges.length - 1]}`)} END`;
      return out;
    }
    if (d.kind === 'map') {
      let out = `CASE WHEN ${col} IS NULL THEN ${ql(d.default || '其他')}`;
      for (const [k, v] of Object.entries(d.mapping)) out += ` WHEN ${col} = ${ql(String(k))} THEN ${ql(v)}`;
      out += ` ELSE ${ql(d.default || '其他')} END`;
      return out;
    }
    throw e(`维度 kind 无效：${d.kind}`);
  }
  // 聚合列一律带基表别名：dcount 跨扇出时 join 里常有同名列（sku），不带别名会 Binder Error / 取错列。
  _aggSql(agg, field, alias){
    const a = alias || 'b';
    if (agg === 'count') return `COUNT(*)`;
    if (agg === 'dcount') return `COUNT(DISTINCT ${a}.${qi(field)})`;
    if (['sum', 'avg', 'max', 'min'].includes(agg)) return `${agg.toUpperCase()}(${a}.${qi(field)})`;
    // last（存量期末值）要按日期窗口取最后一行，发射器还没实现：明确报能力缺口，不返回一个看着对的合计
    throw gap(`SQL 发射器暂不支持 agg=${agg}（能力缺口：存量期末值需要按日期窗口取最后一行）`, 'unsupported_operator');
  }
  // 一个叶子指标的「按维度分组」子查询。维度可以跨多跳（退款→订单→店铺），每跳都要求 N:1 / 1:1。
  // 计划里带了期间/筛选时，把 WHERE 条件翻译成引号化 SQL（只接受结构化条件，不接受任意 SQL 片段）
  _whereSql(base, filters, period, map){
    const conds = [];
    for (const f of (filters || [])) {
      const field = typeof f === 'string' ? f : f.field;
      const values = typeof f === 'string' ? [] : (f.values || []);
      if (!field || !Array.isArray(values) || !values.length) throw e('筛选条件格式不对：要 {field, values[]}', 'bad_filter');
      const inList = values.map(v => ql(String(v))).join(', ');
      conds.push(`b.${qi(field)} IN (${inList})`);
    }
    if (period && period.from && period.to) {
      const field = period.field || 'date';
      // 10-23：文本日期列登记过写法就转成日期再比（字符串比较对 10/21/2021 这种全是错的）
      const fmt = this.dateFormatOf(base, field) || this.dateFormatOf((map && map[base]) || base, field);
      if (fmt) conds.push(`${sqlDateExpr(`b.${qi(field)}`, fmt, { asDate: true })} BETWEEN CAST(${ql(period.from)} AS DATE) AND CAST(${ql(period.to)} AS DATE)`);
      // 10-23：只比前 10 位（YYYY-MM-DD）。带时分的文本时间（2011-11-30 17:05）整串比会把最后一天漏掉
      else conds.push(`SUBSTR(CAST(b.${qi(field)} AS VARCHAR), 1, 10) BETWEEN ${ql(period.from)} AND ${ql(period.to)}`);
    }
    return conds.length ? ' WHERE ' + conds.join(' AND ') : '';
  }
  _leafSql(leafId, dimIds, map, opts){
    const m = this.metrics.get(leafId);
    if (!m) throw e(`没有指标：${leafId}`);
    if (m.unbound) throw e(`指标「${m.id}」没有绑定到用户表（${(m.bindingError && m.bindingError.message) || '缺数据集'}）`, 'missing_binding');
    const base = m.dataset;
    const b = qi((map && map[base]) || base);
    const joins = [], groupExprs = [], snapshotTimeExprs = [];
    let snapshotCrossTime = null;
    for (const id of dimIds) {
      const d = this.dim(id);
      if (d.unbound) throw e(`维度「${d.id}」没有绑定到用户表`, 'missing_binding');
      const t = d.source && d.source.table;
      if (!t) throw e(`维度「${d.id}」还没有绑定`, 'missing_binding');
      if (t === base) {
        const expr = this._dimSql(d, 'b');
        groupExprs.push(expr);
        if (d.kind === 'timeBucket') snapshotTimeExprs.push(expr);
        continue;
      }
      if (d.kind === 'timeBucket') snapshotCrossTime = d;
      const path = this._safePath(base, t);
      if (!path) {
        // dcount 跨扇出：JOIN 放大不影响 COUNT(DISTINCT)，按任意路径建 join 是安全的；
        // 其它聚合仍按扇出能力缺口处理，不估算。
        if (m.agg !== 'dcount') {
          if (this._anyPath(base, t)) throw e(`扇出风险：不能按「${d.name}」分组（「${base}」→「${t}」要经过 1:N / N:N，会放大行）`, 'fanout');
          throw e(`表「${base}」和「${t}」之间没有声明关系，无法按「${d.name}」分组`, 'missing_relationship');
        }
        const any = this.graph().anyPath(base, t);
        if (!any) throw e(`表「${base}」和「${t}」之间没有声明关系，无法按「${d.name}」分组`, 'missing_relationship');
        if (any.unverified) throw e(`关系未通过实测：无法按「${d.name}」分组`, 'relation_unverified');
        let fanAlias = 'b';
        for (const edge of any.path) {
          const nextAlias = 'j' + (joins.length + 1);
          const conds = (edge.pairs || []).map(p => `${fanAlias}.${qi(p.baseKey)} = ${nextAlias}.${qi(p.oneKey)}`);
          joins.push({ table: qi((map && map[edge.to]) || edge.to), alias: nextAlias, cond: conds.join(' AND ') });
          fanAlias = nextAlias;
        }
        groupExprs.push(this._dimSql(d, fanAlias));
        continue;
      }
      let alias = 'b', cur = base;
      for (const hop of path) {
        const nextAlias = 'j' + (joins.length + 1);
        const conds = (hop.pairs || [{ baseKey: hop.baseKey, oneKey: hop.oneKey }])
          .map(p => `${alias}.${qi(p.baseKey)} = ${nextAlias}.${qi(p.oneKey)}`);
        joins.push({ table: qi((map && map[hop.next]) || hop.next), alias: nextAlias, cond: conds.join(' AND ') });
        alias = nextAlias; cur = hop.next;
      }
      groupExprs.push(this._dimSql(d, alias));
    }
    // 筛选条件先落到维度：字段属于别的表（库存按供应商/品类筛）时必须先 join 再筛，
    // 不能直接拼 b.<字段>（会 Binder Error / 筛错表）。这里与分组维度共用同一条安全连接路径。
    const filterConds = [];
    for (const f of ((opts && opts.filters) || [])) {
      const field = typeof f === 'string' ? f : f.field;
      const values = typeof f === 'string' ? [] : (f.values || []);
      // 度量谓词（如 可用库存=0、销售额>300万）：按字段+比较符筛，不走维度值目录
      if (f && typeof f === 'object' && f.op) {
        const OPS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
        const op = OPS[String(f.op)];
        if (!op || !field || values.length !== 1) throw e('筛选条件格式不对：要 {field, op, value}', 'bad_filter');
        const ft = f.table || base;
        let fAlias = 'b';
        if (ft !== base) {
          const fpath = this._safePath(base, ft);
          if (!fpath) throw e(`筛选字段「${field}」所在表和基表之间没有安全连接`, 'missing_relationship');
          for (const hop of fpath) {
            const nextAlias = 'j' + (joins.length + 1);
            const conds = (hop.pairs || [{ baseKey: hop.baseKey, oneKey: hop.oneKey }]).map(p => `${fAlias}.${qi(p.baseKey)} = ${nextAlias}.${qi(p.oneKey)}`);
            joins.push({ table: qi((map && map[hop.next]) || hop.next), alias: nextAlias, cond: conds.join(' AND ') });
            fAlias = nextAlias;
          }
        }
        const raw = values[0];
        const lit = (raw != null && Number.isFinite(Number(raw))) ? String(Number(raw)) : ql(String(raw));
        filterConds.push(`${fAlias}.${qi(field)} ${op} ${lit}`);
        continue;
      }
      if (!field || !Array.isArray(values) || !values.length) throw e('筛选条件格式不对：要 {field, values[]}', 'bad_filter');
      let d = null;
      if (f && f.dim) { try { d = this.dim(String(f.dim).replace(/^d:/, '')); } catch (_) { d = null; } }
      if (!d) {
        const cands = [...this.dims.values()].filter(x => !x.unbound && x.source && x.source.field === field);
        d = cands.find(x => x.source.table === base) || (cands.length === 1 ? cands[0] : null);
      }
      if (!d || !d.source || !d.source.table) throw e(`筛选字段「${field}」没有绑定到任何维度`, 'unknown_dim');
      let alias = 'b';
      if (d.source.table !== base) {
        const path = this._safePath(base, d.source.table);
        const keyCol = path ? null : this._keyOnBase(base, d.source.table, d.source.field);
        if (keyCol) {
          filterConds.push(`b.${qi(keyCol)} IN (${values.map(v => ql(String(v))).join(', ')})`);
          continue;
        }
        if (!path) {
          if (this._anyPath(base, d.source.table)) throw e(`筛选「${d.name}」会放大行（扇出风险），不估算`, 'fanout');
          throw e(`筛选字段「${field}」所在表和基表之间没有声明关系`, 'missing_relationship');
        }
        for (const hop of path) {
          const nextAlias = 'j' + (joins.length + 1);
          const conds = (hop.pairs || [{ baseKey: hop.baseKey, oneKey: hop.oneKey }])
            .map(p => `${alias}.${qi(p.baseKey)} = ${nextAlias}.${qi(p.oneKey)}`);
          joins.push({ table: qi((map && map[hop.next]) || hop.next), alias: nextAlias, cond: conds.join(' AND ') });
          alias = nextAlias;
        }
      }
      filterConds.push(`${alias}.${qi(d.source.field)} IN (${values.map(v => ql(String(v))).join(', ')})`);
    }
    // 半可加快照：跨表 / 多期时必须先按 grain 取期间末最后一行，再做 join / 聚合。
    // 有 grain + 日期列 → 生成 ROW_NUMBER 去重子查询；没有 → 只允许同表且无重复风险，否则报缺口，不把多期快照直接加总。
    const o = opts || {};
    const baseDate = dateFieldForBase(this, base, o.roleDataset);
    let per = o.period ? { from: o.period.from, to: o.period.to, field: o.periodField || baseDate } : null;
    if (o.period && !per.field) {
      // 纯维度表（一个实体一行、没有日期列、且是关系的「一」侧）的指标（如商品单价）不参与期间过滤：
      // 不是漏算，是时不变维度。事实表没有日期列时仍然报缺口，不能静默忽略用户的时间条件。
      const anyDate = [...this.dims.values()].some(d => d.source && d.source.table === base
        && (d.kind === 'timeBucket' || /日期|date|时间|month/i.test(String(d.name) + String(d.id) + String(d.source.field))));
      let isDimension = false;
      try {
        // 声明 grain 里没有任何日期列的基表 = 维度表（一个实体一行）；事实表没有日期列时仍然报缺口
        const grainCols = this.grains.get(base) || [];
        const cols = ((this.tables || []).find(t => t.name === base) || {}).columns || [];
        const dateCols = new Set(cols.filter(c => c.type === 'date').map(c => c.name));
        const grainHasDate = grainCols.some(c => dateCols.has(c) || /date|日期|时间|month|月份/i.test(String(c)));
        const rels = [...this.rels.values()];
        const oneCard = r => ['N:1', '1:1'].includes(String(r.cardinality || ''));
        const asOne = rels.some(r => String(r.right) === String(base) && oneCard(r));
        const asFactStrong = rels.some(r => String(r.left) === String(base) && ['N:1', '1:N'].includes(String(r.cardinality || '')));
        isDimension = asOne && !asFactStrong && !grainHasDate;
      } catch (_) {}
      if (anyDate || !isDimension) throw gap(`期间过滤：表「${base}」没有可用的期间字段，算不了这段时间`, 'unsupported_operator');
      per = null;
    }
    // 期间条件只能引用基表别名 b（进 dedupe 子查询）；表外筛选条件在 join 之后再加
    const periodWhere = this._whereSql(base, [], per, map);
    const filterWhere = filterConds.length ? (periodWhere ? ' AND ' : ' WHERE ') + filterConds.join(' AND ') : '';
    const filterWhereOuter = filterConds.length ? ' WHERE ' + filterConds.join(' AND ') : '';
    let dedupe = null;
    if (m.additivity === 'semiAdditive' && m.agg !== 'last') {
      const grain = this.grainColumnsFor(base);
      if (!grain || !grain.length) throw gap(`「${m.name}」是半可加（快照）指标，但表「${base}」没有声明 grain：不知道「一个实体」是什么，不估算跨期合计`, 'unsupported_operator');
      if (baseDate) {
        // 实体键 = grain 去掉日期列；日期列本身不进分区键，否则每个快照各成一组、等于没去重
        const entityKeys = grain.filter(c => c !== baseDate);
        const parts = [...entityKeys.map(c => `b.${qi(c)}`), ...snapshotTimeExprs];
        if (snapshotCrossTime) throw gap(`「${m.name}」是半可加快照，按跨表时间维度「${snapshotCrossTime.name}」分组要先取期末快照：SQL 发射器未实现，不估算`, 'unsupported_operator');
        const dateOrd = this.dateFormatOf(base, baseDate) ? this._dateSql(base, `b.${qi(baseDate)}`, baseDate) : `b.${qi(baseDate)}`;   // 文本日期要转成日期再排
        const win = parts.length
          ? `PARTITION BY ${parts.join(', ')} ORDER BY ${dateOrd} DESC`
          : `ORDER BY ${dateOrd} DESC`;
        dedupe = `(SELECT * FROM (SELECT b.*, ROW_NUMBER() OVER (${win}) AS ${qi('__rn')}`
          + ` FROM ${b} b${periodWhere}) WHERE ${qi('__rn')} = 1)`;
      } else if (joins.length) {
        throw gap(`「${m.name}」是半可加（快照）指标，跨表分组的 SQL 需要先按 grain 取期末快照；这张表没有日期列，发射器不估算`, 'unsupported_operator');
      }
    }
    let aggExpr = null;
    if (o.rowMul && o.rowMul.attr) {
      // 行级乘积：沿安全 N:1 路径把属性表连进来，逐行相乘再求和
      let ra = 'b';
      for (const hop of (o.rowMul.path || [])) {
        const nextAlias = 'r' + (joins.length + 1);
        const conds = (hop.pairs || [{ baseKey: hop.baseKey, oneKey: hop.oneKey }]).map(p => `${ra}.${qi(p.baseKey)} = ${nextAlias}.${qi(p.oneKey)}`);
        joins.push({ table: qi((map && map[hop.next]) || hop.next), alias: nextAlias, cond: conds.join(' AND ') });
        ra = nextAlias;
      }
      aggExpr = `SUM(b.${qi(m.field)} * ${ra}.${qi(o.rowMul.attr.field)})`;
    }
    const from = (dedupe ? `${dedupe} b` : `${b} b`) + joins.map(j => ` LEFT JOIN ${j.table} ${j.alias} ON ${j.cond}`).join('');
    const keys = groupExprs.map((g, i) => `${g} AS ${qi('k' + i)}`);
    const sql = `SELECT ${[...keys, `${aggExpr || this._aggSql(m.agg, m.field, 'b')}::DOUBLE AS ${qi('v')}`, `COUNT(*)::DOUBLE AS ${qi('n')}`].join(', ')} FROM ${from}${dedupe ? filterWhereOuter : periodWhere + filterWhere}`
      + (groupExprs.length ? ` GROUP BY ${groupExprs.map((_, i) => i + 1).join(', ')}` : '');
    return { sql, keys: groupExprs.length, base, snapshot_deduped: !!dedupe };
  }
  // 单叶子（simple）：保留 g0..gn / m / n 的输出形状（看板与测试都按这个读）
  _simpleSql(m, dimIds, map, opts){
    const r = this._leafSql(m.id, dimIds, map || {}, opts);
    const cols = [];
    for (let i = 0; i < r.keys; i++) cols.push(`${qi('k' + i)} AS ${qi('g' + i)}`);
    // 把 k0..kn 换回 g0..gn；v（聚合值）和 n（组内行数）原样带出
    const sql = `SELECT ${[...cols, `${qi('v')} AS ${qi('m')}`, `${qi('n')} AS ${qi('n')}`].join(', ')} FROM (${r.sql}) t`;
    return { sql, keys: r.keys };
  }
  // 比率 / 派生：每个叶子各自按同一组维度聚合，再 FULL JOIN 到同一组键上做四则运算（分子分母口径一致，漏斗不会错位）
  _compositeSql(m, dimIds, map, opts){
    const rp = this.rowProductOf(m.id);
    if (rp) {
      const r = this._leafSql(rp.fact.id, dimIds, map || {}, Object.assign({}, opts || {}, { rowMul: rp }));
      const cols = [];
      for (let i = 0; i < r.keys; i++) cols.push(`${qi('k' + i)} AS ${qi('g' + i)}`);
      return { sql: `SELECT ${[...cols, `${qi('v')} AS ${qi('m')}`, `${qi('n')} AS ${qi('n')}`].join(', ')} FROM (${r.sql}) t`, keys: r.keys, row_product: true };
    }
    // 分子 / 分母是行级乘积派生指标（客单价 = 销售额 ÷ 订单数）时，那一项用 SUM(a×b) 单独算，再和另一项按同一组键相除
    const leaves = this._termIds(m.id);
    if (leaves.length === 1 && !this.rowProductOf(leaves[0])) return this._simpleSql(this.metrics.get(leaves[0]), dimIds, map, opts);
    const parts = leaves.map((id, i) => {
      const rp2 = this.rowProductOf(id);
      return { id, i, ...(rp2 ? this._leafSql(rp2.fact.id, dimIds, map || {}, Object.assign({}, opts || {}, { rowMul: rp2 })) : this._leafSql(id, dimIds, map || {}, opts)) };
    });
    const keys = parts[0].keys;
    const ctes = parts.map(p => `t${p.i} AS (${p.sql})`).join(', ');
    const keySel = [];
    for (let k = 0; k < keys; k++) keySel.push(`COALESCE(${parts.map(p => `t${p.i}.${qi('k' + k)}`).join(', ')}) AS ${qi('g' + k)}`);
    const joinCond = parts.slice(1).map(p => {
      const on = [];
      for (let k = 0; k < keys; k++) on.push(`t0.${qi('k' + k)} IS NOT DISTINCT FROM t${p.i}.${qi('k' + k)}`);
      return `FULL OUTER JOIN t${p.i} ON ${on.join(' AND ')}`;
    }).join(' ');
    // 可加叶子在没有匹配行的组里补 0（SUM over empty = 0），和本机 JS 计算口径一致
    const at = new Map(parts.map(p => [p.id, this._zeroIfAdditive(p.id) ? `COALESCE(t${p.i}.${qi('v')}, 0)` : `t${p.i}.${qi('v')}`]));
    const exprOf = x => {
      if (typeof x === 'string') return at.get(x);
      const A = exprOf(x.args[0]), B = exprOf(x.args[1]);
      if (A == null || B == null) throw gap(`派生表达式引用了未参与聚合的叶子：${JSON.stringify(x)}`, 'unsupported_operator');
      const op = { add: '+', sub: '-', mul: '*', div: '/' }[x.op];
      return op === '/' ? `(${A} / NULLIF(${B}, 0))` : `(${A} ${op} ${B})`;
    };
    const expr = m.kind === 'ratio'
      ? `((${at.get(m.num)}) / NULLIF((${at.get(m.den)}), 0) * ${Number(m.mul || 1)})`
      : exprOf(m.expr);
    // 没有分组维度时每个叶子只有一行：直接笛卡尔（= 一行）求值，不需要 ON 子句
    const fromClause = keys ? `t0 ${joinCond}` : `t0 ${parts.slice(1).map(p => `CROSS JOIN t${p.i}`).join(' ')}`;
    const sql = `WITH ${ctes} SELECT ${[...keySel, `${expr}::DOUBLE AS ${qi('m')}`].join(', ')} FROM ${fromClause}`;
    return { sql, keys };
  }
  compileSql(metricId, dimIds, map, opts){
    this.metric(metricId);
    if (!this.isBound(metricId)) throw e(`指标「${metricId}」还没绑定到用户表`, 'missing_binding');
    this.checkJoin(metricId, dimIds);
    this._guardNone(metricId, opts);
    const m = this.metrics.get(metricId);
    // opts: { filters:[{field, values[]}], period:{from,to}, periodField } —— 结构化条件，不接受 SQL 片段
    if (m.kind === 'simple') return this._simpleSql(m, dimIds, map || {}, opts);
    return this._compositeSql(m, dimIds, map || {}, opts);
  }
  // 能力清单：调用方（discover_capabilities / 测试）按这个判断「能不能做」，不靠猜。
  capabilities(){
    return {
      metrics: [...this.metrics.values()].map(m => ({ id: m.id, name: m.name, kind: m.kind, additivity: m.additivity, unit: m.unit, bound: !m.unbound,
        ratio_kind: m.ratioKind || null, percent_scale: m.percent_scale == null ? null : Number(m.percent_scale),
        den_scope: (m.den_scope || m.denScope) ? Object.assign({}, m.den_scope || m.denScope) : null })),
      dims: [...this.dims.values()].map(d => ({ id: d.id, name: d.name, kind: d.kind, dataset: (d.source && d.source.table) || d.dataset, bound: !d.unbound })),
      ops: {
        sum_group: true, count_group: true, ratio_group: true, derived_group: true,
        multi_hop_dim: true, bucket_group: true, time_bucket_group: true,
        relation_cardinality: relations.CARDS.slice(),
        relation_measured: !!this.relationsVerified,
        composite_key_relation: true,
        fanout_guard: true,
        dcount_through_fanout: true,
        snapshot_end_of_period: true,            // grain + 日期列齐备时，按 grain 取期末快照再算
        semiadditive_cross_table: true,          // 先取期末快照再 join，不再拿多期快照硬加
        semiadditive_requires_grain_date: true,
        bridge_allocation: false,                // N:N 桥表归因/权重未声明 → 不估算
        last_period_end: false,
        ratio_kinds: [...RATIO_KINDS],                // 比值 / 占比 / 同比增长率 / 百分点
        ratio_aggregate_first: true,                  // 先聚合分子分母再相除，不平均各行比率
        ratio_denominator_scope: true,                // den_scope 显式声明是否去掉当前分组过滤、保留哪些过滤
        ratio_status_codes: [...RATIO_STATUS],        // ok / no_data / zero_denominator / missing_comparison
        arbitrary_sql: false,
      },
      grain: this._grainByTable(),
      grain_problems: (this.grainProblems || []).slice(),
      bridges: this.bridges(),
      bridge_candidates: this.bridgeCandidates(),
      unbound: (this.unbound || []).slice(),
    };
  }
}

// 期间过滤用哪一列：先找计划时间角色指向这张表的那一列，其次找这张表上任意日期列。
// 每个叶子各用自己基表的日期列（退款按退款日期、销售额按下单日期），口径在 trace 里逐表写明。
function dateFieldForBase(sem, base, roleDataset){
  const dateDims = [...sem.dims.values()].filter(d => d.source && d.source.table === base && !d.unbound
    && (d.kind === 'timeBucket' || /日期|date|时间/i.test(String(d.name) + ' ' + String(d.id))));
  if (roleDataset && roleDataset === base) return dateDims.length ? dateDims[0].source.field : null;
  return dateDims.length ? dateDims[0].source.field : null;
}
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';
const ql = s => "'" + String(s).replace(/'/g, "''") + "'";

module.exports = { Semantic, bucketDate, norm, RATIO_KINDS, RATIO_KIND_NAME, RATIO_STATUS };
