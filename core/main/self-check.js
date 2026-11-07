// ================= 结果自查（T6）=================
// 边界：只做「结果形状/口径自洽」的本机检查，不重新算数、不猜业务口径、不改数字。
// 依据 agentic-data-contracts 的结果检查思路（分项=合计、比率范围、非空、期间对齐、单位一致）。
// 检查不过 → 调用方可以把原因交给模型修一次（共用那一次额外调用额度），仍不过就明确说「自查没过、不给数」。
'use strict';

const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= eps;
function enumeratedMembers(plan,o={}){
  if(plan?.dimensions?.length!==1||!/、/.test(String(o.question||''))||!/各|分别/.test(String(o.question||'')))return [];
  const dim=String(plan.dimensions[0]).replace(/^d:/,''),q=String(o.question).toLowerCase();
  const candidates=(o.signals?.ambiguousEntities||[]).filter(g=>String(g.dim).replace(/^d:/,'')===dim).flatMap(g=>(g.options||[]).filter(x=>['exact','contains'].includes(x.how)).map(x=>x.value));
  candidates.push(...(o.signals?.literalGroups||[]).filter(g=>String(g.dim).replace(/^d:/,'')===dim).flatMap(g=>g.values));
  const values=[...new Set(candidates.map(String).filter(v=>v.length>=2&&q.includes(v.toLowerCase())).map(v=>v.toLowerCase()))];
  return values.length>=2?values:[];
}

/**
 * @param {object} plan 已校验计划
 * @param {object} r executor 结果（ok/rows/facts/scalar/comparison/result_status/result_kind）
 * @param {{registry?:object}} o
 * @returns {Array<{code:string,message:string,slot?:string}>} 空数组 = 自查通过
 */
function selfCheck(plan, r, o = {}){
  const issues = [];
  const push = (code, message, slot) => { if (!issues.some(x => x.code === code)) issues.push({ code, message, slot: slot || null }); };
  const p = plan || {};
  const res = r || {};
  const rows = Array.isArray(res.rows) ? res.rows : [];
  const facts = Array.isArray(res.facts) ? res.facts : [];
  const status = res.result_status || 'ok';
  const formulaKind = p.formula && p.formula.kind ? String(p.formula.kind) : null;
  // 1) 结果不为空：说 ok 却既没有行也没有标量 = 自相矛盾
  if (status === 'ok' && !rows.length && res.scalar == null && !(res.comparison && res.comparison.value != null)
    && !facts.some(f => f.value != null)) {
    push('empty_result', '自查：状态说成功，但结果既没有行也没有值');
  }
  // 2) 比率范围：占比类必须 0–100（增长率不在此列）；比值类不能是 NaN
  const vals = rows.length ? rows.map(x => num(x.value)).filter(v => v != null) : (num(res.scalar) != null ? [num(res.scalar)] : []);
  if (formulaKind === 'share' && vals.length) {
    const bad = vals.filter(v => v < -0.001 || v > 100.001);
    if (bad.length) push('share_range', `自查：占比出现超出 0–100 的值（${bad.slice(0, 3).join('、')}）`);
    // 分组占比分项加起来应约等于 100（只有一行时是 100 本身）；留 0.5 的舍入余量
    const total = vals.reduce((a, b) => a + b, 0);
    if (vals.length > 1 && !near(total, 100, 0.5)) push('share_sum', `自查：各分组占比合计=${Math.round(total * 100) / 100}，不等于 100`);
  }
  // 3) 期间对齐：facts 的期间必须等于计划期间（期间错位是典型的把基期当本期）
  if (p.time && p.time.start) {
    const want = String(p.time.start).slice(0, 10);
    const wrong = facts.filter(f => f.period && f.period.start && String(f.period.start).slice(0, 10) !== want);
    if (wrong.length) push('period_mismatch', `自查：有 ${wrong.length} 个事实的期间不是计划的 ${want}`);
  }
  // 4) 单位一致：计划给了单位时，事实单位必须对得上（增长率/百分点按输出口径，不参与）
  const planUnit = p.unit == null ? '' : String(p.unit);
  if (planUnit && res.result_kind !== 'growth_rate' && res.result_kind !== 'pp') {
    const mismatch = facts.filter(f => f.unit != null && String(f.unit) !== '' && String(f.unit) !== planUnit);
    if (mismatch.length) push('unit_mismatch', `自查：事实单位（${String(mismatch[0].unit)}）与计划单位（${planUnit}）不一致`);
  }
  // 5) 排名上限：返回行数不能明显超过 top（并列保留留 2 倍余量）
  if (p.rank && p.rank.top && rows.length > Math.max(p.rank.top * 2, p.rank.top + 3)) {
    push('rank_overflow', `自查：前 ${p.rank.top} 名却返回了 ${rows.length} 行`);
  }
  const members=enumeratedMembers(p,o);
  if(members.length&&rows.some(row=>row.label!=null&&!members.includes(String(row.label).trim().toLowerCase())))push('group_member_subset','自查：结果含题面枚举之外的分组；需要把指定对象落实为过滤条件');
  return issues;
}

module.exports = { selfCheck, enumeratedMembers };
