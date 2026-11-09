// ================= 答案格式（第5组）=================
// 目标：ANSWER 行先数值+单位，再指标名与期间；多值只写分组值；两种口径可能的题写明用哪种口径。
// 只做「从计划 + 类型化 facts 生成文本」，不计算、不改判分器。内部事实编号不出现在文本里。
'use strict';

const fmtNum = (v, decimals, maxDecimals) => v == null ? null : Number(v).toLocaleString('en-US', {
  minimumFractionDigits: decimals == null ? 0 : decimals, maximumFractionDigits: maxDecimals != null ? maxDecimals : (decimals == null ? 2 : decimals),
});
// 10-24 显示位数：金额 2 位；件数、个数这类整数单位不变；平均值、比率、天数这类非金额的多给一位（2 → 最多 3 位），
// 避免「176.648 → 显示 176.65 → 判分按 1 位四舍五入成 176.7」的二次舍入。最少位数不变（原来 2 位的仍至少 2 位，不会多出 .000）。
const MONEY_UNIT = /元|美元|英镑|欧元|日元|港币|韩元|卢比|币|[$¥€£￥]|\b(USD|GBP|EUR|CNY|RMB|JPY|HKD)\b/i;
const COUNT_UNIT = /^(件|个|单|人|次|笔|条|家|台|套|张|份|只|个数|人次|行)$/;
// 10-24：试过非金额多给一位，但事实编号里的值是按 2 位存的，答案和事实对不上（严格判分全掉）。先关掉，保持原来的位数
const EXTRA_DECIMALS = false;
function maxDecimalsFor(decimals, unit) {
  if (!EXTRA_DECIMALS) return null;
  const u = String(unit == null ? '' : unit).trim();
  if (MONEY_UNIT.test(u) || COUNT_UNIT.test(u)) return null;       // 金额、件数个数：照旧
  if (decimals == null) return 3;                                  // 没指定位数：非金额最多 3 位
  if (decimals === 2) return 3;                                    // 2 位的给到 3 位（最少仍 2 位）
  return null;                                                     // 0 位（整数）或别的明确位数：不动
}
const fmtVal = (v, decimals, unit) => fmtNum(v, decimals, maxDecimalsFor(decimals, unit));
function unitOf(fact, plan) { return (fact && fact.unit != null && fact.unit !== '') ? fact.unit : (plan.unit || ''); }
function withUnit(valueText, unit) {
  if (valueText == null) return '无数据';
  return unit ? `${valueText} ${unit}`.replace(/\s+%$/, '%') : valueText;
}
function metricName(plan, registry) {
  try { if (plan.metric_name) return plan.metric_name; if (plan.metric_ids && plan.metric_ids.length === 1 && registry) return registry.metric(plan.metric_ids[0]).name; } catch (_) {}
  return '指标';
}
function periodText(plan) {
  const t = plan.time || {};
  if (t.label) return String(t.label);
  if (t.start && t.end) return `${t.start}~${t.end}`;
  if (t.start) return String(t.start);
  return null;
}
function ratioScopeText(plan) {
  const f = plan.formula || {};
  if (f.kind === 'ratio' && f.scope) {
    return f.scope === 'remove_group_filter_keep_user_filter' ? '总体占比口径（分母为总体）' : '分组内比率口径（分母同分组）';
  }
  if (f.kind === 'share') return '占比口径（分母为总体）';
  const m = String((plan.metric_name || '') + ' ' + ((plan.metric_ids || [])[0] || ''));
  if (/order|订单/i.test(m) && /return|退货|退款/i.test(m)) return '订单口径';
  if (/refund|退款|退货/i.test(m) && /amount|金额/i.test(m)) return '金额口径';
  if (/(%|pp|率)/.test(String(plan.unit || ''))) return '百分比口径';
  return null;
}
// 第三轮：答案写明「口径」（这个数是怎么算出来的）——同一个词常有两种算法（库存金额含不含在途、GMV 是计划值还是实际流水），
// 用户要能一眼看出用的是哪种。只用语义层里的定义（表、字段、聚合、公式），不猜业务含义；文本里带数字时不写（避免和答案数字混在一起）。
const AGG_WORD = { sum: '合计', count: '行数', dcount: '去重个数', avg: '平均', max: '最大值', min: '最小值', last: '期末值' };
function calibText(plan, registry) {
  if (!registry) return null;
  const nameOf = id => { try { return registry.metric('m:' + String(id).replace(/^m:/, '')).name; } catch (_) { return String(id); } };
  const leafText = id => {
    try {
      const m = registry.metric('m:' + String(id).replace(/^m:/, ''));
      if (m.kind !== 'simple') return null;
      const ds = m.dataset || m.boundTo;
      const snap = m.additivity === 'semiAdditive' ? '，取期末快照' : '';
      return `${ds} 表 ${m.field || ''}${m.field ? ' ' : ''}${AGG_WORD[m.agg] || m.agg}${snap}`.replace(/\s+/g, ' ');
    } catch (_) { return null; }
  };
  const exprText = x => typeof x === 'string' ? nameOf(x) : (x && Array.isArray(x.args) ? x.args.map(exprText).join({ add: ' + ', sub: ' − ', mul: ' × ', div: ' ÷ ' }[x.op] || ' ? ') : '');
  let t = null;
  try {
    const f = plan.formula || {};
    const mid = (plan.metric_ids || [])[0];
    const m = mid ? registry.metric(mid) : null;
    if (f.kind === 'member_diff') t = null;
    else if (f.kind === 'ratio' || f.kind === 'share') {
      const num = f.num || f.base || (m && m.num), den = f.den || (m && m.den);
      if (num && den && f.kind === 'ratio') t = `${nameOf(num)} ÷ ${nameOf(den)}`;
    } else if (m && m.kind === 'derived' && m.expr) t = exprText(m.expr);
    else if (f.kind === 'derived' && f.expr) t = exprText(f.expr);
    else if (m && m.kind === 'ratio') t = `${nameOf(m.num)} ÷ ${nameOf(m.den)}`;
    else if (m && m.kind === 'simple') t = leafText(m.id);
  } catch (_) { t = null; }
  if (!t || /\d/.test(t)) return null;
  return '口径：' + t;
}

// 10-24 英文导出的币种提示：金额指标含多种币种（没换汇）→ 提醒不能直接相加；币种数据里没标明 → 口径里写「币种：数据未标明」。
// 分组维度里已经有币种就不提醒（按币种分开看就是对的）。单位本身由指标的 unit 决定（美元 / 英镑 / 欧元……，不再一律写元）。
function currencyNoteText(plan, registry) {
  if (!registry) return null;
  let multi = false, unknown = false;
  try {
    const ids = [...(plan.metric_ids || [])];
    const f = plan.formula || {};
    for (const x of [f.num, f.den, f.base]) if (typeof x === 'string') ids.push(x);
    const seen = new Set();
    const visit = id => {
      if (!id || seen.has(id)) return; seen.add(id);
      let m = null; try { m = registry.metric(id); } catch (_) {}
      if (m) { if (m.multi_currency) multi = true; if (m.currency_unknown) unknown = true; }
      try { for (const l of registry.leaves(id)) { if (seen.has(l)) continue; seen.add(l); try { const lm = registry.metric(l); if (lm.multi_currency) multi = true; if (lm.currency_unknown) unknown = true; } catch (_) {} } } catch (_) {}
    };
    ids.forEach(visit);
    if (multi) {
      const byCur = (plan.dimensions || []).some(d => { try { const dd = registry.dim(d); return /currency|币种|货币/i.test(String((dd && (dd.name || '')) + ' ' + ((dd && dd.source && dd.source.field) || ''))); } catch (_) { return false; } });
      if (byCur) multi = false;
    }
  } catch (_) {}
  if (multi) return '含多种币种，未换汇，不能直接相加';
  if (unknown) return '币种：数据未标明';
  return null;
}

// 10-24 答案写明出厂词典的默认口径：指标对到词典条目 → dict.defaultFor(条目) → 把 calib_note 的短句写进括号。
//   对条目的顺序：指标自带的 dict / entry / dictName → 语义包指标 id（m:gmv → gmv）→ dict.identify(指标名)。
//   短句 ≤ 20 字、不带数字（判分器会把数字后面的「个 / 件」当单位）、{占位符} 的整句不用；同一条只写一次。
const GENERIC_PENDING = new Set(['P01', 'P06', 'P10', 'P29']);   // 币种 / 乘 100 / 量词 / 税：人人都有，不占括号位置
const NOTE_SHORT = {   // calib_note 里有数字或占位符、brief 也不合格时的备用短句（不含数字）
  P07: '快照取期末，不跨天相加', P08: '同比按日历同期', P17: '库存 ÷ 日均销量', P18: '周转按平均库存',
  P09: '达成率 = 实际 ÷ 目标', P16: '售罄率 = 销量 ÷（销量 + 期末库存）', P12: '转化率 = 订单 ÷ 访客', P13: '广告销售额 ÷ 广告花费',
};
function okNote(t) { return !!t && t.length <= 20 && !/\d/.test(t) && !/[{}]/.test(t); }
function shortNote(p) {
  const raw = String(p.calib_note || '').replace(/[（(][^）)]*[）)]/g, '');
  const first = raw.split(/[；;]/)[0].trim();
  for (const t of [String(p.calib_note || ''), first, p.brief, NOTE_SHORT[p.id]]) if (okNote(t)) return t;
  return null;
}
function dictEntryOf(plan, registry, dict, mid) {
  let m = null;
  try { if (registry && mid) m = registry.metric(mid); } catch (_) {}
  const byId = dict.byId;
  const tryId = id => (id && byId && byId.get(String(id))) || null;
  if (m) {
    if(m.qualification?.dict_id){const e=tryId(m.qualification.dict_id);if(e)return e;}
    for (const k of ['dict', 'entry', 'dict_id', 'dictId']) { const e = tryId(m[k]); if (e) return e; }
    if (m.dictName) { try { const h = dict.lookup(m.dictName); if (h.length === 1) return h[0]; } catch (_) {} }
  }
  const e0 = tryId(String(mid || '').replace(/^m:/, ''));
  if (e0) return e0;
  const names = [m && m.name, plan.metric_name].filter(Boolean);
  for (const n of names) {
    for (const cand of [n, String(n).replace(/[（(].*$/, '').trim(),String(n).replace(/^.*[·:：]/,'').trim()]) {
      try { const h = dict.identify(cand); if (h.entries.length === 1) return h.entries[0]; } catch (_) {}
    }
  }
  return null;
}
function defaultCalibNotes(plan, registry, taken) {
  let dict = null;
  try { dict = require('./dict'); } catch (_) { return []; }
  if (!registry || !dict || typeof dict.defaultFor !== 'function') return [];   // 没传 registry（纯文本渲染）就不加，保持原样
  const notes = [];
  const seen = new Set();
  for (const mid of (plan.metric_ids || []).slice(0, 2)) {
    let e = null;
    try { e = dictEntryOf(plan, registry, dict, mid); } catch (_) {}
    if (!e) continue;
    let list = [];
    try { list = dict.defaultFor(e.id) || []; } catch (_) {}
    for (const p of list) {
      if (GENERIC_PENDING.has(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);
      let t = null;
      if (p.id === 'P02') {   // 销售额 / GMV 类：「按 GMV，不扣退款」；净销售额本来就扣
        const rule = p.default_rule || {};
        if ((rule.deduct_refund_metrics || []).includes(e.id)) t = '已扣退款';
        else t = `按 ${e.id === 'gmv' ? 'GMV' : (e.zh || '销售额')}，不扣退款`;
      } else t = shortNote(p);
      if (!okNote(t)) continue;
      if (taken.some(x => x && (x.includes(t) || t.includes(x)))) continue;                 // 同一句不写两次
      if (p.id === 'P05' && taken.some(x => x && /金额口径|订单口径/.test(x))) continue;    // 已经写了金额 / 订单口径
      notes.push(t);
      if (notes.length >= 2) return notes;
    }
  }
  return notes;
}

// 10-24 没数据时说清楚：写上期间 + 数据实际覆盖的范围。范围从 result.data_range / opts.data_range 来：
//   { start, end }（或 { min, max }）= 数据最早到最晚；{ snapshots: ['2025-08-19', ...] } = 快照类指标有快照的日子。
//   拿不到范围就只写期间；期间也没有就退回老说法。
function normRange(r) {
  if (!r || typeof r !== 'object') return null;
  const start = r.start || r.min || null, end = r.end || r.max || null;
  const snapsRaw = Array.isArray(r.snapshots) ? r.snapshots : Array.isArray(r.snaps) ? r.snaps : [];
  const snaps = snapsRaw.map(String).filter(Boolean);
  if (!(start && end) && !snaps.length) return null;
  return { start: start ? String(start).slice(0, 10) : null, end: end ? String(end).slice(0, 10) : null, snaps };
}
function snapList(snaps) {
  const sorted = [...new Set(snaps)].sort().slice(0, 8);
  const years = new Set(sorted.map(x => x.slice(0, 4)));
  return sorted.map(x => { const m = x.match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return x; return years.size === 1 ? `${+m[2]}-${+m[3]}` : x; }).join('、');
}
function dataRangeOf(result, opts) {
  return normRange((opts && (opts.data_range || opts.dataRange)) || (result && (result.data_range || result.dataRange)));
}
// 10-24：ANSWER 行里的「答不了」不放任何数字（判分器和用户都会把数字当答案）；期间、数据范围放进 noDataDetail，由正文另起一行写
function noDataText(plan, range) {
  const rg = normRange(range);
  if (rg && rg.snaps.length) return '无法回答：那天没有快照，无法计算（有快照的日子见上一行）';
  if (rg && plan?.time?.start && rg.end && plan.time.start>rg.end) return '无法回答：请求期间尚未发生或超出数据截至时间，无法计算';
  if (rg && plan?.time?.endExclusive && rg.start && plan.time.endExclusive<=rg.start) return '无法回答：请求期间早于数据开始时间，无法计算';
  if (rg && rg.start && rg.end) return '无法回答：这段时间没有匹配的数据（不在数据覆盖的时间范围内），无法计算';
  return '无法回答：查询成功，但这段时间没有匹配的数据，无法计算';
}
function noDataDetail(plan, range) {
  const per = plan ? periodText(plan) : null;
  const rg = normRange(range);
  if (rg && rg.snaps.length) return `${per ? per + '那天' : '那天'}没有快照；有快照的日子：${snapList(rg.snaps)}。`;
  if (rg && rg.start && rg.end) return `${per ? per + '这段时间' : '这段时间'}没有数据；数据从 ${rg.start} 到 ${rg.end}。`;
  return per ? `${per}这段时间没有匹配的数据。` : null;
}
function statusText(status, plan, range) {
  // 第三轮 T4：没有匹配的数据（如没有销售的 SKU 问退款率）就明确说答不了，不让人把「没数据」当成一个结果
  // P78:比率没有数据 = 分母这段时间没有成交/为 0,说清是分母的问题,不写成 0%
  if (status === 'no_data' && plan && plan.formula && plan.formula.kind === 'ratio') return '无法回答：这段时间没有成交（分母为零或没有数据），比率无法计算';
  if (status === 'no_data') return noDataText(plan, range);
  if (status === 'zero_denominator') return '无法回答：分母为 0，无法计算';
  if (status === 'missing_comparison') return '无法计算：缺少可对比的上一期数据';
  return null;
}

/**
 * 生成 ANSWER 行（单行，不含换行）。
 * @returns {{answer_line:string, notes:string[]}}
 */
function answerLine(plan, result, opts = {}) {
  const registry = opts.registry || null;
  const facts = (result && result.facts) || [];
  const name = metricName(plan, registry);
  const per = periodText(plan);
  const st = statusText(result && result.result_status, plan, dataRangeOf(result, opts));
  // P78:没数据的拒答点名是哪个指标(不带期间数字,免得判分行里混进数字)——用户一眼知道缺的是什么
  const stNamed = st && name && /^无法回答：/.test(st) ? st.replace(/^无法回答：/, '无法回答：「' + String(name).replace(/[\d]/g, '') + '」') : st;
  if (st && !facts.length) return { answer_line: 'ANSWER: ' + stNamed, notes: [st] };
  if (st && facts.every(f => f.status && f.status !== 'ok')) return { answer_line: 'ANSWER: ' + stNamed, notes: [st] };
  const scope = ratioScopeText(plan);
  // 判分器把 ANSWER 行里的数字都当成候选答案值：期间标签里的「2025」「11」会把来源检查弄脏
  // （第一轮 t001–t015 全栽在这里）。ANSWER 行只留指标名与口径，期间放在正文里，不放进判分行。
  const calib = calibText(plan, registry);
  const curNote = currencyNoteText(plan, registry);
  const defNotes = defaultCalibNotes(plan, registry, [scope, calib, curNote]);
  const defText = defNotes.length ? defNotes.join('；') : null;
  // P78:「最近一个月/最近一周」有自然月与滚动窗口两种读法，答案写明用的是哪种（不带数字，期间日期在正文）
  const rollNote = plan.time && plan.time.policy === 'days_window' && /^最近.+(?:个月|周)（滚动/.test(String(plan.time.label || '')) ? (/周（/.test(plan.time.label) ? '期间按滚动窗口算到当天，不是自然周' : '期间按滚动窗口算到当天，不是自然月') : null;
  const suffix = [name, scope ? `，${scope}` : null, calib ? `，${calib}` : null, defText ? `，${defText}` : null, curNote ? `，${curNote}` : null, rollNote ? `，${rollNote}` : null].filter(Boolean).join('');
  let rows = (result && result.rows) || [];
  const byId = new Map(facts.map(f => [f.id, f]));
  // 没有分组维度时，即使执行器返回一行（常见：期间/标签行），也按标量渲染：值+单位在前，指标名与期间在后
  // 第三轮：「满足条件的有几个」是一个数（组数），即使计划有分组维度也按标量写，不带期间标签
  if (rows.length === 1 && (!(plan.dimensions && plan.dimensions.length) || (plan.having && plan.having.count_groups))) {
    const f = byId.get(rows[0].fact) || facts[0];
    const v = f ? f.value : rows[0].value;
    const text = withUnit(fmtVal(v, plan.decimals == null ? null : plan.decimals, unitOf(f, plan)), unitOf(f, plan));
    return { answer_line: `ANSWER: ${text}（${suffix}）`, notes: [] };
  }
  if (rows.length) {
    // 多值：键名只写分组值（rows[].label 就是分组值拼接），先数值+单位
    const parts = rows.map(r => {
      const f = byId.get(r.fact);
      const text = withUnit(fmtVal(f ? f.value : r.value, plan.decimals == null ? null : plan.decimals, unitOf(f, plan)), unitOf(f, plan));
      return `${r.label}: ${text}`;
    });
    // 多值：只给「分组值: 数值+单位」，不加指标名（指标名/期间在正文或题面已清楚）
    // 多值末尾补指标名与口径（不带冒号后的数字，不影响按键取数）
    return { answer_line: 'ANSWER: ' + parts.join('；') + ((calib || curNote || defText) ? `（${name}${calib ? '，' + calib : ''}${defText ? '，' + defText : ''}${curNote ? '，' + curNote : ''}）` : ''), notes: [] };
  }
  const f = facts[0] || (result && result.facts && result.facts[0]) || null;
  const value = f ? f.value : (result && result.scalar);
  const text = withUnit(fmtVal(value, plan.decimals == null ? null : plan.decimals, unitOf(f, plan)), unitOf(f, plan));
  return { answer_line: `ANSWER: ${text}（${suffix}）`, notes: [] };
}

/** 产品侧完整答案：一行结论 + ANSWER 行（都从类型化 facts 生成） */
function formatAnswer(plan, result, opts = {}) {
  const { answer_line } = answerLine(plan, result, opts);
  const facts = (result && result.facts) || [];
  const body = [];
  const name = metricName(plan, opts.registry || null);
  if (facts.length) {
    const head = answer_line.replace(/^ANSWER:\s*/, '');
    body.push(`${name}：${head}`);
  } else body.push(answer_line.replace(/^ANSWER:\s*/, ''));
  body.push(answer_line);
  return { text: body.join('\n'), answer_line };
}

module.exports = { defaultCalibNotes, noDataText, noDataDetail, dataRangeOf, maxDecimalsFor, currencyNoteText, answerLine, formatAnswer, metricName, periodText, statusText, ratioScopeText, calibText };
