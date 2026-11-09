// ================= 计划执行器（复用 worker 本机 SQL 路径）=================
// 从 main/agent.js 的 executePlanTool 抽出来，给「Agent 语义工具 / 统一问数服务 / 以后的 headless」共用。
// 边界（不变）：
//   · 不拼 SQL、不接外部 SQL：所有 SQL 只来自 registry.compileSql（语义层唯一出口），
//     执行器只决定「按计划跑几次聚合、聚合值按什么声明口径组合」。
//   · 不返回明细、不拼答案、不写事实编号：调用方自己决定给模型看什么。
//   · 结果状态显式区分：ok / no_data / zero_denominator / missing_comparison；查询成功但结果空不当 0。
//
// 支持的计划节点（口径一律来自计划 / 指标定义，执行器不猜）：
//   · 占比 share       formula.kind=share：分子按分组聚合 / 分母按总体聚合（去掉分组条件）× scale（默认 100）
//   · 比值 ratio       formula.kind=ratio：分子、分母各自先聚合再相除（分母用去重计数时就是「平均每个 X」）
//   · 增长率 growth    comparison.output=growth_rate：(本期 − 基期) / |基期| × 100
//                      · 按非时间维度分组：同 label 对齐；季度/月/年同比按「年份+1」对齐（跨季同比 2026-Q3 ↔ 2025-Q3）
//                      · 只允许 year_over_year 带时间维度；时间维度上的环比标签跨期不同，明确报缺口，不瞎对齐
//   · 百分点 pp        formula.kind=pp：两个百分比指标各自聚合 → 换成百分点 → 相减；
//                      换算倍数来自指标定义 percent_scale，或 registry.percentScaleOf 的结构推断（判不出来就报缺口）
//   · 前 N 名 rank     plan.rank：并列保留（ties=include）、null 排序（last/first/drop）、同值按 label 稳定
//   · 时间粒度 grain   plan.grain=day/week/month/quarter/year：优先领域包时间桶，缺的从日期列派生（registry.grainDim）
//
// 调用：execute(plan, { registry, cards, role? }) →
//   { ok, rows:[{label,value,...}], applied:[], result_status, result_reason, result_kind,
//     metric:{id,name,unit,decimals,...}, comparison?, formula?, rank?, source:{dataset,field,stamp,datasets?}, plan_id? }
'use strict';

const WORKER_TIMEOUT_MS = 120000;
const GROWTH_SCALE = 100;

function fail(code, message, extra) {
  return Object.assign({ ok: false, errors: [{ code, message }], rows: [], applied: [], result_status: 'error', source: { dataset: null, stamp: null } }, extra || {});
}
function capabilityError(code, message) {
  return Object.assign(new Error(message), { code: code || 'unsupported_operator' });
}
const refId = x => String(x == null ? '' : x).replace(/^m:/, '');

/** 迟到的 plan-ir.shiftPeriod 优先用调用方注入的（避免执行器自己锁死时间语义版本） */
function shiftOf(o) {
  if (typeof o.shiftPeriod === 'function') return o.shiftPeriod;
  const { shiftPeriod } = require('./plan-ir');
  return shiftPeriod;
}
/** 期间统一成编译器认识的 {from,to} 闭区间（compileSql 的 _whereSql 只读这两个字段） */
function periodArg(time) {
  if (!time || !time.start) return null;
  const start = String(time.start).slice(0, 10);
  if (time.end != null) return { from: start, to: String(time.end).slice(0, 10) };
  if (time.endExclusive != null) {
    const { addDays } = require('./time-core');
    return { from: start, to: addDays(String(time.endExclusive).slice(0, 10), -1) };
  }
  return { from: start, to: null };
}

function labelOf(keys) {
  const parts = (keys || []).filter(k => k != null && k !== '');
  return parts.length ? parts.join(' · ') : '（空）';
}
const keyOf = keys => JSON.stringify((keys || []).map(k => (k == null ? null : String(k))));
const cmpLabel = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** 比率类状态：空值 ≠ 0 ≠ 零分母 */
function rateStatus(num, den) {
  if (num == null || den == null) return 'no_data';
  if (Number(den) === 0) return 'zero_denominator';
  return 'ok';
}
/** 多行状态汇总：有一行能算就是 ok；否则按「零分母 > 缺对比期 > 无数据」给原因 */
function overallStatus(list) {
  const st = (list || []).map(x => x || 'no_data');
  if (st.includes('ok')) return 'ok';
  if (st.includes('zero_denominator')) return 'zero_denominator';
  if (st.includes('missing_comparison')) return 'missing_comparison';
  return 'no_data';
}

/**
 * 前 N 名：并列边界全保留；null 按 last/first 排或 drop；同值按 label 稳定排序。
 * direction=desc → 大的在前；asc → 小的在前。
 */
function rankRows(rows, rank) {
  const dir = rank.direction === 'asc' ? 1 : -1;
  const nulls = rank.nulls || 'last';
  const cmp = (a, b) => {
    const av = a.value, bv = b.value;
    if (av == null && bv == null) return cmpLabel(a.label, b.label);
    if (av == null) return nulls === 'first' ? -1 : 1;
    if (bv == null) return nulls === 'first' ? 1 : -1;
    if (av === bv) return cmpLabel(a.label, b.label);
    return dir * (av - bv);
  };
  const sorted = [...rows].sort(cmp);
  const filtered = nulls === 'drop' ? sorted.filter(r => r.value != null) : sorted;
  const cut = filtered.length > rank.top ? filtered[rank.top - 1].value : null;
  const kept = rank.ties === 'include' && cut != null
    ? filtered.filter((r, i) => i < rank.top || r.value === cut)
    : filtered.slice(0, rank.top);
  return { rows: kept, ties_included: kept.length - Math.min(rank.top, filtered.length), dropped_nulls: sorted.length - filtered.length };
}

/** 同比对齐：把基期标签里的年份 +1，使「2025-Q3」对到「2026-Q3」、「2025-10」对到「2026-10」 */
function liftYearComponent(part) {
  const s = String(part).trim();
  const m = /^(\d{4})(-Q[1-4]|-\d{2}(?:-\d{2})?)?$/.exec(s);
  return m ? String(Number(m[1]) + 1) + (m[2] || '') : part;
}
function liftYearLabel(label) {
  return String(label).split(' · ').map(liftYearComponent).join(' · ');
}

function metricOf(registry, ref) {
  const id = refId(ref);
  const m = registry.semantic && registry.semantic.metrics ? registry.semantic.metrics.get(id) : null;
  if (!m) throw Object.assign(new Error(`没有指标：${ref}`), { code: 'unknown_metric' });
  return m;
}
function metricInfo(registry, ref, extra) {
  const m = metricOf(registry, ref);
  const out = {
    id: 'm:' + m.id, name: m.name, kind: m.kind, additivity: m.additivity,
    unit: m.unit == null ? '' : String(m.unit), decimals: m.decimals == null ? 2 : m.decimals,
  };
  const ps = registry.percentScaleOf ? registry.percentScaleOf('m:' + m.id) : null;
  if (ps) out.percent_scale = ps;
  return Object.assign(out, extra || {});
}
/** 没有行的组：可加聚合（sum/count/dcount）视为 0 笔，其它保持 null（不拿 0 冒充可比） */
function zeroWhenMissing(registry, ref) {
  try {
    const m = metricOf(registry, ref);
    return m.kind === 'simple' && ['sum', 'count', 'dcount'].includes(m.agg);
  } catch (_) { return false; }
}
/** 计划里出现的指标 → 叶子基表（粒度、来源都用它） */
function involvedDatasets(registry, refs) {
  const out = new Set();
  for (const ref of refs) {
    if (ref == null) continue;
    try {
      for (const leaf of registry.leaves(ref)) {
        const m = registry.metric(leaf);
        const ds = m.dataset || m.boundTo;
        if (ds) out.add(ds);
      }
    } catch (_) { /* 未绑定/未知指标交给编译器的错误 */ }
  }
  return [...out];
}

/**
 * 执行一个「已确定单指标（或已声明公式）」的计划。
 * @param {object} plan   plan-ir 计划（字段完整由调用方 / validatePlan 保证）
 * @param {{registry:object, cards:object, role?:object, shiftPeriod?:Function}} o
 */
async function execute(plan, o = {}) {
  const registry = o.registry;
  if (!registry) return fail('no_registry', 'execute 需要 registry');
  const cards = o.cards;
  if (!cards || !cards.worker || typeof cards.worker.call !== 'function') {
    return fail('no_executor', '这个会话没有 worker，不能走本机 SQL 执行路径');
  }
  if (!plan || typeof plan !== 'object') return fail('bad_plan', 'execute 需要一个计划对象');
  if (Object.keys(plan).some(k => k === 'sql')) return fail('unsupported_operator', '不接受 SQL；请用计划节点');

  const metricIds = Array.isArray(plan.metric_ids) ? plan.metric_ids : [];
  const formula = plan.formula && typeof plan.formula === 'object' && !Array.isArray(plan.formula) ? plan.formula : null;
  const fk = formula && formula.kind != null ? String(formula.kind) : null;
  const time = plan.time || {};
  const comparison = plan.comparison || { kind: 'none' };
  const comparisonKind = comparison.kind && comparison.kind !== 'none' ? String(comparison.kind) : null;
  const growthOutput = !!comparisonKind && String(comparison.output || '') === 'growth_rate';

  // ---- 模式与指标引用（pp 要两个指标；其它先把唯一指标确定下来）----
  let mode = 'plain';
  let numRef = metricIds[0] || null;
  let denRef = null;
  let leftRef = null, rightRef = null;
  if (fk === 'member_diff') {
    // 第三轮：同一指标在同一维度两个成员之间的差（如 Amazon 的退款率比独立站低多少个百分点）
    if (metricIds.length !== 1 || !formula.dim || formula.left == null || formula.right == null) return fail('plan_incomplete', '成员差要一个指标 + 维度 + 左右两个成员');
    numRef = metricIds[0];
    mode = 'member_diff';
  } else if (fk === 'pp') {
    leftRef = formula.left || formula.num || metricIds[0] || null;
    rightRef = formula.right || formula.den || metricIds[1] || null;
    if (!leftRef || !rightRef) return fail('plan_incomplete', '百分点比较要两个指标：formula.left / formula.right');
    mode = 'pp';
  } else {
    if (metricIds.length > 1) return fail('plan_incomplete', `执行器只执行已确定单个指标的计划（当前 ${metricIds.length} 个）`);
    if (fk === 'share') {
      mode = 'share';
      numRef = formula.base || formula.num || metricIds[0] || null;
      denRef = formula.den || numRef;
      if (!numRef) return fail('plan_incomplete', '占比公式缺分子指标');
    } else if (fk === 'ratio') {
      mode = 'ratio';
      numRef = formula.num || metricIds[0] || null;
      denRef = formula.den || (formula.den_expr && Array.isArray(formula.den_expr.args) && formula.den_expr.args.length ? formula.den_expr.args[0] : null);
      if (!numRef) return fail('plan_incomplete', '比值公式缺分子指标');
      if (!denRef) {
        const m = metricOf(registry, numRef);
        if (m.kind === 'ratio' && m.den) denRef = 'm:' + m.den;
      }
      if (!denRef) return fail('plan_incomplete', '比值公式缺分母指标');
    } else if (fk === 'derived' && formula && formula.expr) {
      mode = 'derived';
      numRef = metricIds[0] || null;
      // 第三轮：表达式就是某个已登记的派生指标（如 库存金额 = 可用库存 × 单价）→ 按那个指标整体编译
      // （行级乘积在语义编译器里逐行相乘再求和；不走「各自聚合再相乘」的近似）
      try {
        const canonExpr = x => typeof x === 'string' ? String(x).replace(/^m:/, '') : (x && Array.isArray(x.args) ? { op: String(x.op), args: x.args.map(canonExpr) } : x);
        const want = JSON.stringify(canonExpr(formula.expr));
        const hit = [...registry.semantic.metrics.values()].find(m => m.kind === 'derived' && !m.unbound && JSON.stringify(canonExpr(m.expr)) === want);
        if (hit) { mode = 'plain'; numRef = 'm:' + hit.id; }
      } catch (_) {}
    } else {
      if (metricIds.length !== 1) return fail('plan_incomplete', `执行器只执行已确定单个指标的计划（当前 ${metricIds.length} 个）`);
      numRef = metricIds[0];
    }
  }

  const applied = [];
  // ---- 时间角色 / 维度 / 过滤（结构化，不接收 SQL 片段）----
  const role = o.role !== undefined ? o.role
    : (time.role ? (registry.timeRoles() || []).find(r => r.id === time.role) || null : null);
  const dims = (Array.isArray(plan.dimensions) ? plan.dimensions : []).map(d => String(d).replace(/^d:/, ''));
  const filters = [];
  for (const e of plan.entities || []) {
    const d = registry.dim(e.dim);
    if (!d) return fail('unknown_dim', `没有维度：${e.dim}`);
    const field = (d.source && d.source.field) || d.field;
    if (!field) return fail('unknown_dim', `维度「${e.dim}」没有绑定字段`);
    const dim='d:'+String(e.dim).replace(/^d:/,'');
    const same=filters.find(f=>f.kind==='group'&&f.dim===dim&&f.field===field);
    if(same){if(!same.values.includes(String(e.value)))same.values.push(String(e.value));}
    else filters.push({field,values:[String(e.value)],kind:'group',dim});
  }
  for (const f of plan.filters || []) filters.push(Object.assign({ kind: 'group' }, f));

  // ---- 时间粒度：把 plan.grain 落成时间桶维度（语义包没有就从日期列派生）----
  let queryDims = dims;
  // 一整个期间恰好只装一个桶时（如只问 2026-09 却给 grain=month），不把时间桶当分组维度：
  // 否则「各渠道」会变成「渠道·月份」标签，时间序列只在跨多个桶时才需要桶维度。
  const singleBucketAtGrain = (() => {
    if (!plan.grain || !time.start) return false;
    const g = String(plan.grain);
    const s = String(time.start).slice(0, 10);
    const ex = time.endExclusive ? String(time.endExclusive).slice(0, 10) : null;
    try {
      const tc = require('./time-core');
      if (g === 'day') return !ex || tc.addDays(s, 1) === ex;
      if (g === 'week') return false;
      if (g === 'month') return /-01$/.test(s) && ex && new Date(ex + 'T00:00:00Z').getUTCDate() === 1 && ((new Date(ex).getUTCFullYear() - new Date(s).getUTCFullYear()) * 12 + new Date(ex).getUTCMonth() - new Date(s).getUTCMonth()) === 1;
      if (g === 'quarter') { const m = Number(s.slice(5, 7)); return [1, 4, 7, 10].includes(m) && ex && new Date(ex + 'T00:00:00Z').getUTCDate() === 1 && ((new Date(ex).getUTCFullYear() - new Date(s).getUTCFullYear()) * 12 + new Date(ex).getUTCMonth() - new Date(s).getUTCMonth()) === 3; }
      if (g === 'year') return /-01-01$/.test(s) && ex && /-01-01$/.test(ex);
    } catch (_) {}
    return false;
  })();
  if (plan.grain && !singleBucketAtGrain) {
    const g = String(plan.grain);
    const datasets = involvedDatasets(registry, [numRef, denRef, leftRef, rightRef, ...metricIds].filter(Boolean));
    if (datasets.length > 1) {
      return fail('unsupported_operator', `「${g}」分桶要求指标来自同一张表；这个计划跨 ${datasets.length} 张表（${datasets.join('、')}），暂不支持`);
    }
    if (!datasets.length) return fail('missing_binding', '这个指标没有绑定到用户表，无法按时间粒度分组');
    let picked = null;
    try { picked = registry.grainDim(g, datasets[0]); } catch (err) { return fail(err.code || 'unsupported_operator', String(err.message || err)); }
    if (!picked) return fail('unsupported_operator', `表「${datasets[0]}」没有日期列，不能按「${g}」分组`);
    if (!queryDims.some(d => 'd:' + String(d).replace(/^d:/, '') === picked.id)) queryDims = queryDims.concat([picked.id]);
    applied.push({ slot: 'grain', grain: g, dim: picked.id, created: !!picked.created, source: picked.source });
  }

  if (time.start) applied.push({ slot: 'time', start: time.start, endExclusive: time.endExclusive || null, end: time.end || null, role: time.role || null });
  if (filters.length) applied.push({ slot: 'filters', count: filters.length });
  if (queryDims.length) applied.push({ slot: 'dimensions', dims: queryDims });

  // ---- SQL 执行：唯一出口 compileSql + worker semanticQuery ----
  const runSql = async (ref, period, dimList, filterList) => {
    // 第三轮：「当前/最新」+ 快照类指标：取截至期末每个对象最近一次快照（期间起点放开），不要求那一天正好有快照
    if (time.as_of && period && period.to) {
      try { const mm = metricOf(registry, ref); if (mm.additivity === 'semiAdditive') period = { from: '1900-01-01', to: period.to }; } catch (_) {}
    }
    const { sql } = registry.compileSql('m:' + refId(ref), dimList, {}, {
      filters: filterList, period: period || null, roleDataset: role ? role.dataset : null,
    });
    if (typeof sql !== 'string' || !sql) throw Object.assign(new Error('语义编译器没有生成 SQL'), { code: 'compile_error' });
    const out = await cards.worker.call('semanticQuery', { sql }, WORKER_TIMEOUT_MS);
    const raw = Array.isArray(out && out.rows) ? out.rows : [];
    if (!dimList.length) {
      return { scalar: raw.length && raw[0].m != null ? Number(raw[0].m) : null, rows: [], rawCount: raw.length };
    }
    const rows = raw.map(r => {
      const keys = [];
      for (let i = 0; i < dimList.length; i++) keys.push(r['g' + i] == null ? null : r['g' + i]);
      return { keys, label: labelOf(keys), value: r.m == null ? null : Number(r.m) };
    });
    return { scalar: null, rows, rawCount: raw.length };
  };

  // ---- 公式参数（作用域 / 换算倍数都从计划读）----
  // 默认值对齐 main/plan-ir.computeFormula：mul 缺省 100（比率/占比都是百分数口径）；
  // 要「平均每个 X」这种倍数口径，计划里必须显式写 mul:1。
  const formulaScale = () => {
    if (formula && formula.mul != null) {
      const s = Number(formula.mul);
      if (!Number.isFinite(s) || s === 0) throw capabilityError('bad_plan', '公式的 mul 要是非零有限数字');
      return s;
    }
    // mul 没写：按指标定义自补（比值默认 1、占比/百分比默认 100）；不因为模型漏写整题拒答
    if (mode === 'ratio' || mode === 'share') {
      try {
        const inf = require('./plan-ir').inferFormulaScale;
        if (typeof inf === 'function') {
          return inf(registry, Object.assign({}, formula || {}, { kind: mode, num: numRef, den: denRef }), metricIds);
        }
      } catch (_) { /* 推断失败退回旧默认 */ }
      return 100;
    }
    return 1;
  };
  const scopeOf = () => {
    const raw = formula ? (formula.den_scope || formula.denominator_scope || formula.scope) : null;
    if (raw && typeof raw === 'object') {
      return { drop_group_filter: raw.drop_group_filter === true, keep: Array.isArray(raw.keep) ? raw.keep.slice() : ['period', 'user', 'permission'] };
    }
    if (typeof raw === 'string') {
      return { drop_group_filter: /remove_group_filter|drop_group|total/i.test(raw), keep: ['period', 'user', 'permission'] };
    }
    return { drop_group_filter: mode === 'share', keep: ['period', 'user', 'permission'] };
  };
  const totalFilters = scope => (scope.drop_group_filter ? filters.filter(f => f.kind !== 'group' && f.kind !== 'entity') : filters);

  // ---- T4：跨期比率 / 条件聚合 / 分母表达式 的期间与过滤换算 ----
  // num_period / den_period：same | previous_period | period_start | period_end；或用 num_window/den_window 给显式日期
  const { addDays: addDaysP } = require('./time-core');
  const formulaPeriod = (base, kind, win) => {
    if (win && win.start && win.end) {
      const st = String(win.start).slice(0, 10), ed = String(win.end).slice(0, 10);
      return st <= ed ? { from: st, to: ed } : base;
    }
    if (!kind || kind === 'same' || !base) return base;
    if (kind === 'period_start') return { from: base.from, to: base.from };
    if (kind === 'period_end') { const d = base.to || base.from; return { from: d, to: d }; }
    if (kind === 'previous_period') {
      try {
        const sh = shiftOf(o)({ start: base.from, end: base.to || base.from, endExclusive: addDaysP(base.to || base.from, 1), timezone: time.timezone, grain: time.grain }, 'previous_period');
        if (sh && sh.start) return { from: String(sh.start).slice(0, 10), to: String(sh.end || addDaysP(sh.endExclusive, -1)).slice(0, 10) };
      } catch (_) {}
      return base;
    }
    return base;
  };
  // 度量谓词 → SQL 过滤（只允许单叶子指标；field/table 从指标定义取，不猜业务口径）
  const metricFilterOf = (spec, fallbackRef) => {
    if (!spec || !spec.op) return null;
    const ref = spec.metric || fallbackRef;
    if (!ref) return null;
    let leaf = null;
    try {
      const leaves = registry.leaves('m:' + refId(ref));
      if (leaves.length !== 1) throw capabilityError('unsupported_operator', `筛选条件只能用在单叶子指标上：${ref}`);
      leaf = metricOf(registry, leaves[0]);
    } catch (err) { throw capabilityError(err.code || 'bad_plan', String(err.message || err)); }
    const field = leaf.field || (leaf.role && null);
    if (!field) throw capabilityError('bad_plan', `指标「${leaf.name}」没有可筛的列`);
    if (spec.value == null) throw capabilityError('bad_plan', '筛选条件缺 value');
    return { field, values: [spec.value], op: String(spec.op), table: leaf.dataset || leaf.boundTo, kind: 'metric' };
  };

  // ---- 一次「期间结果」：plain / ratio / share（pp 单独处理）----
  // 派生公式：每个引用指标先各自聚合（同一维度/期间/过滤），再按表达式四则运算。
  // 注意：这是「先聚合再相乘」，多实体行级乘积会偏（如多 SKU 库存金额），报告里单列能力缺口。
  const resolveDerived = async (period) => {
    const refs = [];
    const walk = x => { if (typeof x === 'string') refs.push(String(x).replace(/^m:/, '')); else if (x && Array.isArray(x.args)) x.args.forEach(walk); };
    walk(formula.expr);
    const vals = new Map();
    let rawCount = 0;
    for (const r of uniqLocal(refs)) {
      const res = await runSql(r, period, queryDims, filters);
      vals.set(r, res); rawCount += res.rawCount || 0;
    }
    const evalExpr = (x, pick) => {
      if (typeof x === 'string') return pick(vals.get(String(x).replace(/^m:/, '')));
      const a = evalExpr(x.args[0], pick), b = evalExpr(x.args[1], pick);
      if (a == null || b == null) return null;
      const op = { add: (p, q) => p + q, sub: (p, q) => p - q, mul: (p, q) => p * q, div: (p, q) => (q === 0 ? null : p / q) }[String(x.op)];
      return op ? op(a, b) : null;
    };
    if (!queryDims.length) {
      const scalar = evalExpr(formula.expr, r => r && r.scalar != null ? Number(r.scalar) : null);
      return { kind: 'derived', rows: [], scalar, rawCount };
    }
    const first = vals.get(uniqLocal(refs)[0]);
    const rows = [];
    for (const row of (first && first.rows) || []) {
      const key = JSON.stringify(row.keys);
      const pick = r => {
        if (!r) return null;
        const hit = (r.rows || []).find(x => JSON.stringify(x.keys) === key);
        return hit && hit.value != null ? Number(hit.value) : null;
      };
      const v = evalExpr(formula.expr, pick);
      rows.push({ label: row.label, value: v, keys: row.keys });
    }
    return { kind: 'derived', rows, scalar: null, rawCount };
  };
  const uniqLocal = a => [...new Set(a)];

  // 第三轮：可加指标（sum/count）在「这段时间表里确实有数据、只是筛选后没有匹配行」时，真实答案是 0（当天没卖 = 卖了 0 件）；
  // 表在这段时间根本没有数据时仍报「没有数据」，不拿 0 冒充（对应第一轮「查询成功但结果空不能渲染成零」的本意）。
  const periodCovered = async (ref, period) => {
    if (!period || !period.from) return false;
    try {
      const { sql } = registry.compileSql('m:' + refId(ref), [], {}, { filters: [], period, roleDataset: role ? role.dataset : null });
      const out = await cards.worker.call('semanticQuery', { sql }, WORKER_TIMEOUT_MS);
      const row = Array.isArray(out && out.rows) ? out.rows[0] : null;
      return !!(row && Number(row.n) > 0);
    } catch (_) { return false; }
  };
  const resolvePeriod = async (period) => {
    if (mode === 'plain') {
      const r = await runSql(numRef, period, queryDims, filters);
      // 仅在展示单个百分比指标时换成百分点；公式分子分母仍使用原聚合值，避免二次乘100。
      if (metricOf(registry,numRef).unit === '%') {
        const ps=registry.percentScaleOf('m:'+refId(numRef));
        if(ps && Number.isFinite(ps.scale)) {
          if(r.scalar!=null)r.scalar*=ps.scale;
          for(const row of r.rows)if(row.value!=null)row.value*=ps.scale;
          applied.push({slot:'percent_scale',scale:ps.scale,source:ps.source});
        }
      }

      if (!queryDims.length && r.scalar == null && filters.length && zeroWhenMissing(registry, numRef) && metricOf(registry, numRef).agg !== 'dcount'
        && await periodCovered(numRef, period)) {
        applied.push({ slot: 'zero_fill', reason: 'period_has_data_but_no_matching_rows' });
        return { kind: 'plain', rows: [], scalar: 0, rawCount: Math.max(1, r.rawCount || 0), zero_filled: true };
      }
      return { kind: 'plain', rows: r.rows.map(x => ({ label: x.label, value: x.value, keys: x.keys })), scalar: r.scalar, rawCount: r.rawCount };
    }
    if (mode === 'member_diff') {
      const dimId = String(formula.dim).replace(/^d:/, '');
      const dd = registry.dim(dimId);
      const field = dd && ((dd.source && dd.source.field) || dd.field);
      if (!field) throw capabilityError('unknown_dim', `维度「${dimId}」没有绑定字段`);
      const L = String(formula.left), R = String(formula.right);
      const r = await runSql(numRef, period, [dimId], filters.concat([{ field, values: [L, R], kind: 'group', dim: 'd:' + dimId }]));
      const pick = v => { const hit = r.rows.find(x => String((x.keys || [])[0]) === v); return hit && hit.value != null ? Number(hit.value) : (zeroWhenMissing(registry, numRef) ? 0 : null); };
      const ps = registry.percentScaleOf ? registry.percentScaleOf('m:' + refId(numRef)) : null;
      const k = ps && ps.scale ? Number(ps.scale) : 1;
      const lv = pick(L), rv = pick(R);
      const ok = lv != null && rv != null;
      return { kind: 'member_diff', rows: [], scalar: ok ? lv * k - rv * k : null, status: ok ? 'ok' : 'no_data', left: ok ? lv * k : null, right: ok ? rv * k : null, members: [L, R], percent: !!ps, rawCount: r.rawCount };
    }
    const scale = formulaScale();
    const scope = scopeOf();
    const numFilters = (() => { const f = metricFilterOf(formula && formula.num_filter, numRef); return f ? filters.concat([f]) : filters; })();
    const denFiltersBase = totalFilters(scope);
    const denFilters = (() => { const f = metricFilterOf(formula && formula.den_filter, denRef); return f ? denFiltersBase.concat([f]) : denFiltersBase; })();
    const pNum = formulaPeriod(period, formula && formula.num_period, formula && formula.num_window);
    const pDen = formulaPeriod(period, formula && formula.den_period, formula && formula.den_window);
    const numRes = await runSql(numRef, pNum, queryDims, numFilters);
    const denDims = mode === 'share' ? [] : (scope.drop_group_filter ? [] : queryDims);
    let denRes = await runSql(denRef, pDen, denDims, denFilters);
    // 分母 = 两个指标之和（den_expr）：各自算完再加；只支持 ratio
    if (mode === 'ratio' && formula && formula.den_expr && Array.isArray(formula.den_expr.args) && formula.den_expr.args.length) {
      const sign0 = formula.den_expr.op === 'sub' ? -1 : 1;
      let acc = denRes;
      for (let i = 1; i < formula.den_expr.args.length; i++) {
        const extra = await runSql(formula.den_expr.args[i], pDen, denDims, denFilters);
        if (acc.rows && acc.rows.length && extra.rows) {
          const map = new Map(acc.rows.map(r => [keyOf(r.keys), r]));
          for (const r of extra.rows) {
            const k = keyOf(r.keys);
            if (map.has(k)) map.get(k).value = (Number(map.get(k).value || 0) * sign0) + Number(r.value || 0);
            else map.set(k, { keys: r.keys, label: r.label, value: r.value });
          }
          acc = { scalar: null, rows: [...map.values()], rawCount: (acc.rawCount || 0) + extra.rawCount };
        } else {
          const a = acc.scalar == null ? null : Number(acc.scalar) * sign0;
          const b = extra.scalar == null ? null : Number(extra.scalar);
          acc = { scalar: a == null || b == null ? null : a + b, rows: [], rawCount: (acc.rawCount || 0) + extra.rawCount };
        }
      }
      denRes = acc;
    }
    if (!queryDims.length) {
      const a = numRes.scalar;
      const b = denRes.rawCount ? denRes.scalar : (zeroWhenMissing(registry, denRef) ? 0 : null);
      const st = rateStatus(a, b);
      return {
        kind: mode, rows: [], scalar: st === 'ok' ? (a / b) * scale : null, status: st,
        numerator: a, denominator: b, denominatorTotal: mode === 'share' ? b : null, scale,
        rawCount: numRes.rawCount + denRes.rawCount,
      };
    }
    const denMap = new Map();
    for (const r of denRes.rows) denMap.set(keyOf(r.keys), r.value);
    const merged = new Map();
    for (const r of numRes.rows) merged.set(keyOf(r.keys), { keys: r.keys, label: r.label, num: r.value });
    if (mode === 'ratio' && !scope.drop_group_filter) {
      for (const r of denRes.rows) if (!merged.has(keyOf(r.keys))) merged.set(keyOf(r.keys), { keys: r.keys, label: r.label, num: null });
    }
    const rows = [];
    for (const v of merged.values()) {
      let a = v.num;
      if (a == null && zeroWhenMissing(registry, numRef)) a = 0;
      const b = mode === 'share'
        ? (denRes.rawCount ? denRes.scalar : null)
        : (denMap.has(keyOf(v.keys)) ? denMap.get(keyOf(v.keys)) : null);
      const st = rateStatus(a, b);
      rows.push({ label: v.label, value: st === 'ok' ? (a / b) * scale : null, status: st, numerator: a, denominator: b, keys: v.keys });
    }
    rows.sort((x, y) => cmpLabel(x.label, y.label));
    return {
      kind: mode, rows, scalar: null,
      status: rows.length ? overallStatus(rows.map(r => r.status)) : 'no_data',
      scale, denominatorTotal: mode === 'share' ? (denRes.rawCount ? denRes.scalar : null) : null,
      rawCount: numRes.rawCount + denRes.rawCount,
    };
  };

  // ---- pp：两侧各自聚合 → 换算成百分点 → 相减 ----
  const resolvePp = async (period) => {
    const ls = registry.percentScaleOf ? registry.percentScaleOf(leftRef) : null;
    const rs = registry.percentScaleOf ? registry.percentScaleOf(rightRef) : null;
    if (!ls) throw capabilityError('unsupported_operator', `「${metricOf(registry, leftRef).name}」没有可判定的百分点换算（percent_scale / 单位 / 比率定义），不能做百分点比较`);
    if (!rs) throw capabilityError('unsupported_operator', `「${metricOf(registry, rightRef).name}」没有可判定的百分点换算（percent_scale / 单位 / 比率定义），不能做百分点比较`);
    const L = await runSql(leftRef, period, queryDims, filters);
    const R = await runSql(rightRef, period, queryDims, filters);
    const status = (l, r) => (l == null || r == null ? 'no_data' : 'ok');
    if (!queryDims.length) {
      const st = status(L.scalar, R.scalar);
      const lv = st === 'ok' ? L.scalar * ls.scale : null;
      const rv = st === 'ok' ? R.scalar * rs.scale : null;
      return { kind: 'pp', rows: [], scalar: st === 'ok' ? lv - rv : null, status: st, left: lv, right: rv, scales: { left: ls, right: rs }, rawCount: L.rawCount + R.rawCount };
    }
    const lmap = new Map(L.rows.map(r => [keyOf(r.keys), r]));
    const rmap = new Map(R.rows.map(r => [keyOf(r.keys), r]));
    const labels = new Map();
    for (const r of L.rows) labels.set(keyOf(r.keys), r.label);
    for (const r of R.rows) if (!labels.has(keyOf(r.keys))) labels.set(keyOf(r.keys), r.label);
    const rows = [];
    for (const [k, label] of labels) {
      const l = lmap.has(k) ? lmap.get(k).value : null;
      const r = rmap.has(k) ? rmap.get(k).value : null;
      const st = status(l, r);
      rows.push({ label, value: st === 'ok' ? l * ls.scale - r * rs.scale : null, status: st, left: st === 'ok' ? l * ls.scale : null, right: st === 'ok' ? r * rs.scale : null });
    }
    rows.sort((x, y) => cmpLabel(x.label, y.label));
    return {
      kind: 'pp', rows, scalar: null,
      status: rows.length ? overallStatus(rows.map(r => r.status)) : 'no_data',
      scales: { left: ls, right: rs }, rawCount: L.rawCount + R.rawCount,
    };
  };

  // ---- 主流程：当期 ----
  if (mode !== 'plain') applied.push({ slot: 'formula', kind: mode, num: numRef ? refId(numRef) : null, den: denRef ? refId(denRef) : null, scale: mode === 'pp' ? null : formulaScale(), scope: mode === 'pp' ? null : scopeOf() });
  if (mode === 'pp') applied.push({ slot: 'pp', left: refId(leftRef), right: refId(rightRef) });

  let cur;
  try {
    cur = mode === 'pp' ? await resolvePp(periodArg(time)) : mode === 'derived' ? await resolveDerived(periodArg(time)) : await resolvePeriod(periodArg(time));
  } catch (err) {
    return fail(err.code || 'execution_error', String(err && err.message || err).slice(0, 240));
  }

  // ---- T4 按指标筛选（having）：先聚合再筛组，不跨一对多放大 ----
  // count_groups=true 时输出「满足条件的组数」（两步聚合：先分组聚合，再数组）。
  let havingMeta = null, countGroups = false;
  if (plan.having && cur.rows && cur.rows.length) {
    const h = plan.having || {};
    const OPS = { eq: (a, b) => a === b, ne: (a, b) => a !== b, gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b };
    const fn = OPS[String(h.op)] || null;
    if (!fn) return fail('bad_plan', 'having.op 不支持：' + h.op);
    const before = cur.rows.length;
    cur.rows = cur.rows.filter(r => r.value != null && fn(Number(r.value), Number(h.value)));
    havingMeta = { op: String(h.op), value: Number(h.value), groups_before: before, groups_after: cur.rows.length, count_groups: !!h.count_groups };
    applied.push(Object.assign({ slot: 'having' }, havingMeta));
    if (h.count_groups) { cur = { kind: 'plain', rows: [], scalar: cur.rows.length, rawCount: cur.rawCount, count_groups: true }; countGroups = true; }
  }

  // ---- T4 累计（按时间桶顺序累加，只对可加指标）----
  let cumulativeMeta = null;
  if (plan.cumulative && cur.rows && cur.rows.length > 1) {
    const mk = metricOf(registry, numRef);
    if (mk.kind !== 'simple' || !['sum', 'count', 'dcount'].includes(mk.agg)) return fail('unsupported_operator', `「${mk.name}」不可加，不能做累计`);
    const sorted = [...cur.rows].sort((a, b) => cmpLabel(a.label, b.label));
    let acc = 0;
    for (const r of sorted) { if (r.value == null) { r.cumulative = null; continue; } acc += Number(r.value); r.cumulative = acc; }
    cur.rows = sorted;
    cumulativeMeta = { groups: sorted.length };
    applied.push({ slot: 'cumulative', groups: sorted.length });
  }

  // 排名：在当期结果上做（前 N 名 / 哪一天最多都走这里），并列 / null / 稳定次序在 rankRows 里
  let rankMeta = null;
  if (plan.rank && cur.rows && cur.rows.length) {
    const parts = Array.isArray(plan.rank.partition_by) ? plan.rank.partition_by.filter(Boolean) : [];
    if (parts.length) {
      // 组内排名：按 partition_by 维度分组后每组取前 N，再拼回（组内次序稳定）
      const idx = parts.map(pid => queryDims.findIndex(d => String(d).replace(/^d:/, '') === String(pid).replace(/^d:/, '')));
      if (idx.some(i => i < 0)) return fail('bad_plan', 'rank.partition_by 里的维度必须同时出现在分组维度里');
      const groups = new Map();
      for (const r of cur.rows) {
        const key = JSON.stringify(idx.map(i => ((r.keys || [])[i] == null ? null : String(r.keys[i]))));
        const arr = groups.get(key) || [];
        arr.push(r); groups.set(key, arr);
      }
      const outRows = [];
      let tiesInc = 0, droppedNulls = 0;
      for (const list of groups.values()) {
        const rk = rankRows(list, plan.rank);
        outRows.push(...rk.rows); tiesInc += rk.ties_included; droppedNulls += rk.dropped_nulls;
      }
      cur.rows = outRows;
      rankMeta = { top: plan.rank.top, direction: plan.rank.direction || 'desc', ties: plan.rank.ties || 'include', nulls: plan.rank.nulls || 'last',
        partition_by: parts, groups: groups.size, returned: outRows.length, ties_included: tiesInc, dropped_nulls: droppedNulls };
    } else {
      const rk = rankRows(cur.rows, plan.rank);
      cur.rows = rk.rows;
      rankMeta = { top: plan.rank.top, direction: plan.rank.direction || 'desc', ties: plan.rank.ties || 'include', nulls: plan.rank.nulls || 'last', returned: rk.rows.length, ties_included: rk.ties_included, dropped_nulls: rk.dropped_nulls };
    }
    applied.push(Object.assign({ slot: 'rank' }, rankMeta));
  }

  // 对比期：计划里给了显式基期（「相比 X，Y」里的 X）就照它执行；否则由 time-core 的声明策略生成。
  // 这里只执行，不改年份字符串；显式基期本身也是 {start,end,endExclusive,label} 的期间对象。
  const wantsComparison = !!comparisonKind && !!time.start;
  const explicitBase = wantsComparison && comparison.base && comparison.base.start
    ? { start: comparison.base.start, end: comparison.base.end, endExclusive: comparison.base.endExclusive, label: comparison.base.label || '基期', policy: comparison.base.policy || 'explicit_base' }
    : null;
  let shifted = null, prev = null;
  if (wantsComparison) {
    if (explicitBase) {
      shifted = explicitBase;
    } else {
      try {
        const per = { start: time.start, end: time.end, endExclusive: time.endExclusive, timezone: time.timezone, grain: time.grain };
        shifted = shiftOf(o)(per, comparisonKind) || null;
      } catch (_) { shifted = null; }
    }
    if (shifted) {
      try { prev = mode === 'pp' ? await resolvePp(periodArg(shifted)) : mode === 'derived' ? await resolveDerived(periodArg(shifted)) : await resolvePeriod(periodArg(shifted)); } catch (_) { prev = null; }
    }
  }

  // ---- 组织输出 ----
  let hasDims = queryDims.length > 0;
  if (countGroups) hasDims = false;   // 「满足条件的组数」输出的是标量（两步聚合的第二步）
  // 分组里有没有时间维度：timeBucket 直接看 grain；裸日期列按表结构（date 列）或列名识别成 day。
  // 同比靠这个决定「年份+1 对齐」还是「同 label 对齐」；环比遇到时间维度会明确报缺口（标签跨期不同）。
  const timeDimGrain = (() => {
    const dateColsOf = table => {
      const t = (registry.tables || []).find(x => x.name === table);
      return new Set(((t && t.columns) || []).filter(c => c.type === 'date').map(c => c.name));
    };
    for (const d of queryDims) {
      const dd = registry.dim(d);
      if (!dd) continue;
      if (dd.kind === 'timeBucket') return dd.grain || true;
      if (dd.kind === 'column' && dd.source) {
        const cols = dateColsOf(dd.source.table);
        if (cols.size ? cols.has(dd.source.field) : /日期|date|时间/i.test(String(dd.name) + ' ' + String(dd.id) + ' ' + String(dd.source.field))) return 'day';
      }
    }
    return null;
  })();
  const prevByLabel = () => {
    const m = new Map();
    if (!prev) return m;
    // 显式基期同一年（比如「相比 2026年8月」）不能把年份 +1；跨年（同比/相比去年同期）才做年份对齐
    const liftYear = !!timeDimGrain && comparisonKind === 'year_over_year'
      && (!explicitBase || Number(String(explicitBase.start).slice(0, 4)) < Number(String(time.start).slice(0, 4)));
    for (const r of prev.rows || []) m.set(liftYear ? liftYearLabel(r.label) : r.label, r);
    return m;
  };

  let rows = [];
  let resultKind = 'value';
  let metricMeta = null;
  let comparisonOut = null;
  let resultStatus = 'ok';
  let resultReason = null;

  if (growthOutput) {
    if (!time.start) return fail('plan_incomplete', '要算增长率，必须先有一段明确的时间（本期）');
    if (mode === 'pp') return fail('unsupported_operator', '百分点差值本身不是百分比指标，不能算增长率（百分点同比没有定义）');
    const growthMetric = metricOf(registry, numRef);
    if (!shifted) {
      const baseRows = (cur.rows && cur.rows.length ? cur.rows : [{ label: time.label || '全部', value: null }]);
      rows = baseRows.map(r => ({ label: r.label, value: null, current: r.value == null ? null : r.value, previous: null, status: 'missing_comparison' }));
      if (!hasDims) rows = [{ label: time.label || '全部', value: null, current: cur.scalar == null ? null : cur.scalar, previous: null, status: 'missing_comparison' }];
      resultStatus = 'missing_comparison'; resultReason = 'comparison_period_unavailable';
      comparisonOut = { kind: comparisonKind, period: null, policy: comparison.policy || null, output: 'growth_rate', scale: GROWTH_SCALE };
    } else {
      const st = (c, p) => (c == null ? 'no_data' : p == null ? 'missing_comparison' : Number(p) === 0 ? 'zero_denominator' : 'ok');
      const growth = (c, p) => ((c - p) / Math.abs(p)) * GROWTH_SCALE;
      if (!hasDims) {
        const c = cur.scalar, p = prev ? prev.scalar : null;
        const status = st(c, p);
        rows = [{ label: time.label || '全部', value: status === 'ok' ? growth(c, p) : null, current: c == null ? null : c, previous: p == null ? null : p, status }];
        comparisonOut = {
          kind: comparisonKind, period: shifted.label || null, policy: shifted.policy || comparison.policy || null,
          output: 'growth_rate', scale: GROWTH_SCALE,
          value: status === 'ok' ? growth(c, p) : null,   // growth 口径：value = 增长率数值（unit=%）
          current: c == null ? null : c, previous: p == null ? null : p,
          delta: c == null || p == null ? null : c - p,
        };
        resultStatus = status;
        resultReason = status === 'ok' ? null : (status === 'missing_comparison' ? 'previous_period_empty' : status === 'zero_denominator' ? 'previous_period_zero' : 'current_period_empty');
      } else {
        let singleBucket = false;
        if (!timeDimGrain) {
          // 非时间维度分组：同 label 对齐（环比/同比都成立）
        } else if (comparisonKind !== 'year_over_year') {
          // 只按时间粒度分了一个桶（本期只有一行）时，「环比上一季度/上个月」就是整期对整期：
          // 不需要标签对齐，直接用上一段的单个值比；只有真正按时间分组（多行）才报缺口。
          const onlyTimeBucket = !(plan.dimensions || []).length && queryDims.length === 1 && (!cur.rows || cur.rows.length <= 1);
          if (!onlyTimeBucket) {
            return fail('unsupported_operator', `按时间维度「${timeDimGrain}」做环比：分组标签跨期不同（本期 vs 上一段），无法稳定对齐；请按非时间维度分组，或改用同比`);
          }
          singleBucket = true;
          const cr = (cur.rows && cur.rows[0]) || { label: time.label || '全部', value: cur.scalar };
          const pr = (prev && prev.rows && prev.rows[0]) || { label: shifted.label || '基期', value: prev ? prev.scalar : null };
          const status = st(cr.value, pr.value);
          rows = [{ label: cr.label, value: status === 'ok' ? growth(cr.value, pr.value) : null, current: cr.value == null ? null : cr.value, previous: pr.value == null ? null : pr.value, status }];
          comparisonOut = {
            kind: comparisonKind, period: shifted.label || null, policy: shifted.policy || comparison.policy || null,
            output: 'growth_rate', scale: GROWTH_SCALE, per_group: false, single_bucket: true,
            value: status === 'ok' ? growth(cr.value, pr.value) : null,
            current: cr.value == null ? null : cr.value, previous: pr.value == null ? null : pr.value,
            delta: cr.value == null || pr.value == null ? null : cr.value - pr.value,
          };
          resultStatus = status;
          resultReason = status === 'ok' ? null : (status === 'missing_comparison' ? 'previous_period_empty' : status === 'zero_denominator' ? 'previous_period_zero' : 'current_period_empty');
          applied.push({ slot: 'comparison', kind: comparisonKind, output: 'growth_rate', single_bucket: true });
        }
        if (!singleBucket) {
          const pm = prevByLabel();
          rows = cur.rows.map(r => {
            const p = pm.has(r.label) ? pm.get(r.label).value : null;
            const status = st(r.value, p);
            return { label: r.label, value: status === 'ok' ? growth(r.value, p) : null, current: r.value == null ? null : r.value, previous: p == null ? null : p, status };
          });
          comparisonOut = {
            kind: comparisonKind, period: shifted.label || null, policy: shifted.policy || comparison.policy || null,
            output: 'growth_rate', scale: GROWTH_SCALE, per_group: true,
            aligned_by: timeDimGrain ? 'year_lift' : 'label', groups: rows.length,
          };
          resultStatus = overallStatus(rows.map(r => r.status));
          resultReason = resultStatus === 'ok' ? null : (resultStatus === 'missing_comparison' ? 'previous_period_empty' : resultStatus === 'zero_denominator' ? 'previous_period_zero' : 'current_period_empty');
          applied.push({ slot: 'comparison', kind: comparisonKind, output: 'growth_rate', per_group: true, aligned_by: comparisonOut.aligned_by });
        }
      }
    }
    resultKind = 'growth_rate';
    metricMeta = Object.assign(metricInfo(registry, numRef), { output: 'growth_rate', unit: '%', name: (growthMetric.name || '指标') + ' · 增长率' });
  } else {
    // 当期结果行（plain 只给 label/value，保持原有输出形状；公式类带 numerator/denominator/status）
    if (hasDims) {
      rows = cur.rows.map(r => {
        const row = { label: r.label, value: r.cumulative !== undefined ? r.cumulative : r.value };
        if (r.cumulative !== undefined) row.cumulative = r.cumulative;
        if (cur.kind !== 'plain') {
          row.status = r.status || (r.value == null ? 'no_data' : 'ok');
          if (r.numerator !== undefined) row.numerator = r.numerator;
          if (r.denominator !== undefined) row.denominator = r.denominator;
          if (r.left !== undefined) row.left = r.left;
          if (r.right !== undefined) row.right = r.right;
        }
        return row;
      });
    } else {
      rows = [{ label: time.label || '全部', value: cur.scalar }];
      if (cur.kind !== 'plain') {
        rows[0].status = cur.status || (cur.scalar == null ? 'no_data' : 'ok');
        if (cur.kind === 'share' || cur.kind === 'ratio') {
          rows[0].numerator = cur.numerator === undefined ? null : cur.numerator;
          rows[0].denominator = cur.denominator === undefined ? null : cur.denominator;
        }
        if (cur.kind === 'pp') {
          rows[0].left = cur.left === undefined ? null : cur.left;
          rows[0].right = cur.right === undefined ? null : cur.right;
        }
      }
    }

    // 对比期：补 previous/delta（不改变主值；growth 口径走上面分支）
    if (wantsComparison && prev) {
      if (!hasDims) {
        const pv = prev.scalar, cv = cur.scalar;
        comparisonOut = {
          kind: comparisonKind, period: shifted.label || null, policy: shifted.policy || comparison.policy || null,
          output: comparison.output || 'delta',
          value: pv == null ? null : pv,
          delta: pv == null || cv == null ? null : cv - pv,
          delta_ratio: pv == null || cv == null || Number(pv) === 0 ? null : (cv - pv) / Math.abs(pv) * GROWTH_SCALE,
        };
        applied.push({ slot: 'comparison', kind: comparisonKind, output: comparisonOut.output, per_group: false });
      } else {
        const pm = prevByLabel();
        for (const r of rows) {
          const p = pm.has(r.label) ? pm.get(r.label).value : null;
          r.previous = p == null ? null : p;
          r.delta = p == null || r.value == null ? null : r.value - p;
        }
        comparisonOut = {
          kind: comparisonKind, period: shifted.label || null, policy: shifted.policy || comparison.policy || null,
          output: comparison.output || 'delta', per_group: true, groups: rows.length,
          aligned_by: timeDimGrain === 'quarter' || timeDimGrain === 'month' || timeDimGrain === 'year' ? 'year_lift' : 'label',
        };
        applied.push({ slot: 'comparison', kind: comparisonKind, output: comparisonOut.output, per_group: true, aligned_by: comparisonOut.aligned_by });
      }
    }

    // 结果种类 / 单位 / 名称（口径来自指标定义或计划，不在这里猜）
    if (cur.kind === 'derived') {
      resultKind = 'value';
      metricMeta = { id: 'derived', name: plan.metric_name || '派生指标', kind: 'derived', unit: plan.unit || '', decimals: plan.decimals == null ? 2 : plan.decimals };
    } else if (cur.kind === 'plain') {
      resultKind = 'value';
      metricMeta = metricInfo(registry, numRef);
      if (formula && formula.unit != null) metricMeta.unit = String(formula.unit);
      if (countGroups) {
        // 第三轮 T4：按天 / 按月分组再数组数时，单位跟着粒度走（「有几天」= 天），按维度分组仍记「个」
        const gu = !(plan.dimensions || []).length && plan.grain === 'day' ? '天' : !(plan.dimensions || []).length && plan.grain === 'month' ? '个月' : !(plan.dimensions || []).length && plan.grain === 'week' ? '周' : '个';
        metricMeta = Object.assign({}, metricMeta, { name: (metricMeta.name || '指标') + ' · 满足条件的分组数', unit: gu, decimals: 0, output: 'group_count' }); resultKind = 'group_count';
      }
    } else if (cur.kind === 'member_diff') {
      resultKind = 'value';
      const mm = metricOf(registry, numRef);
      metricMeta = metricInfo(registry, numRef, { output: 'member_diff', unit: cur.percent ? '个百分点' : String(mm.unit || ''), name: `${mm.name}（${cur.members[0]} − ${cur.members[1]}）` });
      applied.push({ slot: 'member_diff', dim: formula.dim, left: cur.members[0], right: cur.members[1], left_value: cur.left, right_value: cur.right });
    } else if (cur.kind === 'pp') {
      resultKind = 'pp';
      metricMeta = metricInfo(registry, leftRef, {
        output: 'pp', unit: 'pp',
        name: `${metricOf(registry, leftRef).name} − ${metricOf(registry, rightRef).name}`,
      });
    } else {
      resultKind = cur.kind;
      metricMeta = metricInfo(registry, numRef, { output: cur.kind });
      const scale = cur.scale == null ? 1 : cur.scale;
      // 第三轮：比值单位按口径算，不信模型写的单位：×100 → %；分子分母同单位 → 倍；不同单位 → 分子单位（元/件 → 元）
      metricMeta.unit = require('./plan-ir').formulaUnitOf(registry, Object.assign({}, formula || {}, { kind: cur.kind, num: numRef, den: denRef, mul: scale }));
      // 比值/占比是算出来的小数：至少保留两位（分子是整数件数时，指标精度 0 位不适用于比值）
      metricMeta.decimals = Math.max(2, Number(metricMeta.decimals) || 0);
      metricMeta.scale = scale;
      applied.push({ slot: cur.kind, scale, denominator_total: cur.denominatorTotal == null ? null : cur.denominatorTotal });
    }

    // 状态：空数据 / 零分母 / 缺对比期分开报
    if (!hasDims) {
      if (cur.kind === 'plain') {
        const mk = metricOf(registry, numRef).kind;
        resultStatus = cur.rawCount === 0 ? 'no_data' : cur.scalar == null ? (mk === 'ratio' || mk === 'derived' ? 'zero_denominator' : 'no_data') : 'ok';
      } else {
        resultStatus = cur.rawCount === 0 ? 'no_data' : (cur.status || (cur.scalar == null ? 'no_data' : 'ok'));
      }
      resultReason = resultStatus === 'ok' ? null : resultStatus === 'zero_denominator' ? 'computed_null_for_ratio' : resultStatus === 'missing_comparison' ? 'previous_period_empty' : 'worker_no_rows';
    } else {
      resultStatus = cur.rows.length
        ? overallStatus(cur.rows.map(r => (cur.kind === 'plain' ? (r.value == null ? 'no_data' : 'ok') : (r.status || (r.value == null ? 'no_data' : 'ok')))))
        : 'no_data';
      if (cur.rawCount === 0) resultStatus = 'no_data';
      else if (resultStatus === 'no_data' && cur.kind === 'plain' && ['ratio', 'derived'].includes(metricOf(registry, numRef).kind)) resultStatus = 'zero_denominator';
      resultReason = resultStatus === 'ok' ? null : resultStatus === 'zero_denominator' ? 'computed_null_for_ratio' : resultStatus === 'missing_comparison' ? 'previous_period_empty' : 'no_rows_or_null_values';
    }
    if (wantsComparison && resultStatus === 'ok') {
      const missingPrev = !comparisonOut || (hasDims ? rows.every(r => r.previous == null) : comparisonOut.value == null);
      if (missingPrev) { resultStatus = 'missing_comparison'; resultReason = 'previous_period_empty'; }
    }
  }

  // 第三轮：是否类问题（「可用库存为 0 记 1，否则记 0」）：在算好的值上做本机比较，输出 1/0
  if (plan.indicator && plan.indicator.op) {
    const OPS = { eq: (a, b) => a === b, ne: (a, b) => a !== b, gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b };
    const fn = OPS[String(plan.indicator.op)];
    if (!fn) return fail('bad_plan', 'indicator.op 不支持：' + plan.indicator.op);
    const th = Number(plan.indicator.value);
    for (const r of rows) {
      if (r.value == null && zeroWhenMissing(registry, numRef) && resultStatus !== 'no_data') r.value = 0;
      if (r.value != null) r.value = fn(Number(r.value), th) ? 1 : 0;
    }
    metricMeta = Object.assign({}, metricMeta, { unit: '', decimals: 0, output: 'indicator', name: (metricMeta && metricMeta.name ? metricMeta.name : '指标') + ' · 是否满足（是=1，否=0）' });
    applied.push({ slot: 'indicator', op: String(plan.indicator.op), value: th });
    if (rows.some(r => r.value != null) && resultStatus === 'no_data') resultStatus = 'ok';
  }

  let stamp = null;
  try { stamp = typeof registry.stamp === 'function' ? registry.stamp() : null; } catch (_) { stamp = null; }
  const datasets = involvedDatasets(registry, [numRef, denRef, leftRef, rightRef, ...metricIds].filter(Boolean));
  const sourceMetric = metricOf(registry, numRef || metricIds[0] || leftRef);
  const source = { dataset: sourceMetric.dataset || sourceMetric.boundTo || datasets[0] || null, field: sourceMetric.field || null, stamp };
  if (datasets.length > 1) source.datasets = datasets;
  const out = {
    ok: true,
    plan_id: plan.id || null,
    metric: metricMeta,
    rows,
    result_kind: resultKind,
    comparison: comparisonOut,
    result_status: resultStatus,
    result_reason: resultReason,
    applied,
    source,
  };
  if (rankMeta) out.rank = rankMeta;
  if (mode === 'share' || mode === 'ratio') out.formula = { kind: mode, num: refId(numRef), den: refId(denRef), scale: cur.scale, scope: scopeOf() };
  if (mode === 'pp') out.formula = { kind: 'pp', left: refId(leftRef), right: refId(rightRef), scales: cur.scales };
  return out;
}

module.exports = { execute, rankRows, liftYearLabel };
