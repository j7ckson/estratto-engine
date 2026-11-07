// ================= 受限计划 IR（M1）=================
// 一句话 → 机器可检查的计算清单 → 校验 → 本机执行 → 事实编号。
//
// 复审的硬要求：
//   · 关键条件没落实就不执行（返回缺口短码，不返回一个看着合理的宽泛查询）；
//   · 模型置信度只是线索，不能替代槽位检查；
//   · 不把原句存下来就算「条件已落实」——时间角色 / 指标 / 维度 / 期间都要对应到计划节点；
//   · 不允许任意 SQL 绕过：执行只走 Semantic 的受限算子（sum/count/ratio/derived + 已声明的维度）。
//
// 错误短码（调用方只读 code）：missing_time_role / ambiguous_metric / ambiguous_entity /
// unsupported_operator / missing_binding / fanout / permission_denied / invalid_period / plan_incomplete
'use strict';
const crypto = require('node:crypto');
const { FactBook } = require('./facts');
const timeCore = require('./time-core');

// 区间语义版本：plan-ir/2 统一为 [start, endExclusive) 半开区间；plan-ir/1 的 end 是闭区间，
// 只在 normalizePlan（唯一适配边界）转换一次，并留下 compat 标记，旧计划/旧调用方仍可读。
const PLAN_SCHEMA = 'plan-ir/2';
const LEGACY_PLAN_SCHEMA = 'plan-ir/1';
const IR_SCHEMA = 'ir/1';
const INTERVAL_SCHEMA = '[start,endExclusive)';
const TIMEZONE_DEFAULT = 'Asia/Shanghai';
const TIME_CORE_VERSION = timeCore.TIME_CORE_VERSION;

const CODES = Object.freeze({
  MISSING_TIME_ROLE: 'missing_time_role',
  AMBIGUOUS_METRIC: 'ambiguous_metric',
  AMBIGUOUS_ENTITY: 'ambiguous_entity',
  ENTITY_NOT_FOUND: 'entity_not_found',
  UNKNOWN_METRIC: 'unknown_metric',
  UNKNOWN_DIM: 'unknown_dim',
  UNSUPPORTED_OPERATOR: 'unsupported_operator',
  MISSING_BINDING: 'missing_binding',
  FANOUT: 'fanout',
  PERMISSION_DENIED: 'permission_denied',
  INVALID_PERIOD: 'invalid_period',
  PLAN_INCOMPLETE: 'plan_incomplete',
  CAPABILITY_GAP: 'capability_gap',
  IR_INVALID: 'ir_invalid',
  BUDGET_EXCEEDED: 'budget_exceeded',
  NO_DATA: 'no_data',
  ZERO_DENOMINATOR: 'zero_denominator',
  MISSING_COMPARISON: 'missing_comparison',
});

const DAY = 864e5;
const iso = t => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => timeCore.addDays(d, n);
const monthEnd = d => timeCore.isMonthEnd(d);
const norm = s => String(s == null ? '' : s).replace(/\s+/g, '');

const uniq = a => [...new Set(a)];

/* ---------------- 时间解析 ---------------- */
const ROLE_WORDS = [
  { re: /退款(时间|日期|日)|退货(时间|日期)/, hint: /退款|refund/i, name: '退款' },
  { re: /下单(时间|日期)|订单(时间|日期)|成交(时间|日期)|销售(时间|日期)|卖掉|卖出/, hint: /订单|order|销售|sales/i, name: '下单' },
];

// 兼容契约：返回 start / end（inclusive，旧调用方）/ endExclusive / label / grain / timezone / policy。
// 内部计划只认 endExclusive；inclusive end 只在 adapter 返回时出现一次。
// 时间计算本身收口在 time-core（Temporal），这里只负责从整句话里取出时间短语。
const PERIOD_PHRASES = [
  [/(\d{4}-\d{2}-\d{2})[~～至到](\d{4}-\d{2}-\d{2})/, 2],
  [/(\d{4}年\d{1,2}月\d{1,2}日?)[~～至到](\d{4}年\d{1,2}月\d{1,2}日?)/, 2],
  [/(\d{4}年\d{1,2}月\d{1,2}日)/, 1],
  [/(\d{4}-\d{2}-\d{2})/, 1],
  [/(\d{4})\/(\d{1,2})(?!\/)/, 2],
  [/(\d{4})-(\d{2})(?!-)/, 2],
  [/(\d{4}年\d{1,2}月)/, 1],
  [/(?:最近|近)(\d{1,3})天/, 1],
  [/((?:最近|近|过去)(?:一|两|二|三|四|五|六|九|十二|\d{1,2})个?(?:月|周|星期))(?!份|前|底|初|末|完整)/, 1],
  [/(本月至今|月初至今|这个月|本月)/, 1],
  [/(上一个完整月|上个完整月|最近完整月|最近一个完整月)/, 1],
  [/(上个月|上月)/, 1],
  [/(上周|本周|这周)/, 1],
  [/(今年至今|今年)/, 1],
  [/(去年)/, 1],
  [/(\d{4}年)/, 1],
  [/(\d{1,2})月/, 1],
];
// 季度：2026-Q2 / 2026Q2 / 2026年第2季度 → 展开成该季度首日~末日（交给 time-core 的显式区间，不在 time-core 里加分支）
const QUARTER_PHRASES = [/(\d{4})\s*[-年]?\s*Q\s*([1-4])/i, /(\d{4})\s*年?\s*第\s*([1-4一二三四])\s*季度/];
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function quarterPhrase(s){
  for (const re of QUARTER_PHRASES) {
    const m = re.exec(s);
    if (!m) continue;
    const y = Number(m[1]), q = CN_NUM[m[2]] || Number(m[2]);
    if (!(y >= 1900 && y <= 2200) || !(q >= 1 && q <= 4)) continue;
    const startMonth = (q - 1) * 3 + 1;
    const start = y + '-' + String(startMonth).padStart(2, '0') + '-01';
    const endMonth = y + '-' + String(startMonth + 2).padStart(2, '0') + '-01';
    try { return start + '~' + timeCore.monthEnd(endMonth); } catch (_) { /* 落到别的规则 */ }
  }
  return null;
}
function periodPhrase(raw){
  const s = norm(raw);
  const quarter = quarterPhrase(s);
  if (quarter) return quarter;
  for (const [re, n] of PERIOD_PHRASES) {
    const m = re.exec(s);
    if (!m) continue;
    if (re.source === '(\\d{1,2})月' && /本月|这个月|上月|上个月|完整月/.test(s)) continue;
    if (n === 1) return m[0];
    // 年月对（2025/11、2025-11）拼成 time-core 认识的 YYYY-MM
    if (re.source.includes('\\/') || re.source.includes('-(\\d{2})')) return m[1] + '-' + String(m[2]).padStart(2, '0');
    return m[1] + '~' + m[2];
  }
  return null;
}
// 「2026年9月1日至19日」这类省略结束月的区间：别被 time-core 当成单日
function shorthandRange(raw){
  const s = norm(raw);
  const pad = n => String(n).padStart(2, '0');
  let m = /(\d{4})年(\d{1,2})月(\d{1,2})日?\s*[~～至到]\s*(\d{1,2})日/.exec(s);
  if (m) {
    // 完整的「2026年9月1日至19日」；如果结束处也带年份，交给 time-core 的完整区间规则
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}~${m[1]}-${pad(m[2])}-${pad(m[4])}`;
  }
  m = /(\d{4})-(\d{1,2})-(\d{1,2})\s*[~～至到]\s*(\d{1,2})日/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}~${m[1]}-${pad(m[2])}-${pad(m[4])}`;
  return null;
}
function cnDateRange(text){
  const t = String(text || '');
  const m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(?:到|至|—|－|-|~|～)\s*(?:(\d{4})\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号]/.exec(t);
  if (!m) return null;
  const pad = x => String(x).padStart(2, '0');
  const y1 = m[1], mo1 = pad(m[2]), d1 = pad(m[3]);
  const y2 = m[4] || y1, mo2 = pad(m[5] || m[2]), d2 = pad(m[6]);
  const a = `${y1}-${mo1}-${d1}`, b = `${y2}-${mo2}-${d2}`;
  if (!timeCore.isValidDate(a) || !timeCore.isValidDate(b) || a > b) return null;
  return `${a} 到 ${b}`;
}

function parsePeriod(text, anchor, opts){
  // 显示格式里的例子不是筛选期间；仅移除有明确格式提示的局部日期样例。
  text=String(text||'').replace(/(?:月份?|日期|时间)\s*(?:写成|写为|用|采用|显示为|格式为|格式用)\s*[0-9YyMmDd/\-]+\s*(?:这样|格式)?/g,'');
  const o = typeof anchor === 'object' && anchor ? anchor : { anchor, timezone: opts && opts.timezone };
  const anchorIso = o.anchor || (typeof anchor === 'string' ? anchor : null);
  const timezone = o.timezone || TIMEZONE_DEFAULT;
  const text0=norm(text), anchor0=anchorIso||timeCore.todayIn(timezone);
  const events=[...text0.matchAll(/(前年|去年|今年|明年|\d{4}年)?(双十一|双11|双十二|双12)(?:当天|当日)?/g)];
  if(events.length===1){const e=events[0],year=/^\d{4}/.test(e[1]||'')?Number(e[1].slice(0,4)):Number(anchor0.slice(0,4))+({前年:-2,去年:-1,今年:0,明年:1}[e[1]]||0),date=year+'-'+(/双十一|双11/.test(e[2])?'11-11':'12-12');return toCompatPeriod(timeCore.parsePeriod(date,{anchor:anchor0,timezone}));}
  const monthThrough=/(?:本月|这个月|当月)(?:从|自)?(月初|\d{1,2}[日号])(?:起)?(?:到|至|截至)(今天|今日|昨天|昨日|前天)/.exec(text0);
  if(monthThrough){const day=monthThrough[1]==='月初'?1:Number(monthThrough[1].replace(/[日号]/,'')),a=anchor0.slice(0,7)+'-'+String(day).padStart(2,'0'),b=timeCore.addDays(anchor0,/前天/.test(monthThrough[2])?-2:/昨/.test(monthThrough[2])?-1:0);if(timeCore.isValidDate(a)&&a<=b)return toCompatPeriod(timeCore.parsePeriod(a+'~'+b,{anchor:anchor0,timezone}));const error=new Error('非法日期或区间');error.code=CODES.INVALID_PERIOD;throw error;}
  const half=/(?:(今年|去年|本年|(?:19|20)\d{2}年))?([上下])半年/.exec(text0);
  if(half&&!(/上半年/.test(text0)&&/下半年/.test(text0))){const y=half[1]==='去年'?Number(anchor0.slice(0,4))-1:/^\d{4}/.test(half[1]||'')?Number(half[1].slice(0,4)):Number(anchor0.slice(0,4)),a=y+(half[2]==='上'?'-01-01':'-07-01');let b=y+(half[2]==='上'?'-06-30':'-12-31');if(/至今|截至(?:今天|今日)?|到今天|到今日/.test(text0)&&anchor0>=a&&anchor0<b)b=anchor0;return toCompatPeriod(timeCore.parsePeriod(a+'~'+b,{anchor:anchor0,timezone}));}
  const mdThrough=/(?:(今年|去年|(?:19|20)\d{2}年))?(\d{1,2})月(\d{1,2})[日号]?(?:到|至|截至)(今天|今日|昨天|昨日|前天)/.exec(text0);
  if(mdThrough){const y=mdThrough[1]==='去年'?Number(anchor0.slice(0,4))-1:/^\d{4}/.test(mdThrough[1]||'')?Number(mdThrough[1].slice(0,4)):Number(anchor0.slice(0,4)),a=y+'-'+String(mdThrough[2]).padStart(2,'0')+'-'+String(mdThrough[3]).padStart(2,'0'),b=timeCore.addDays(anchor0,/前天/.test(mdThrough[4])?-2:/昨/.test(mdThrough[4])?-1:0);if(timeCore.isValidDate(a)&&a<=b)return toCompatPeriod(timeCore.parsePeriod(a+'~'+b,{anchor:anchor0,timezone}));const error=new Error('非法日期或区间');error.code=CODES.INVALID_PERIOD;throw error;}
  if(!/(?:19|20)\d{2}年/.test(text0)){
    const rangeMD=/(\d{1,2})月(\d{1,2})[日号]?(?:到|至|~|～)(\d{1,2})月(\d{1,2})[日号]?/.exec(text0);
    if(rangeMD){const y=anchor0.slice(0,4),a=y+'-'+String(rangeMD[1]).padStart(2,'0')+'-'+String(rangeMD[2]).padStart(2,'0'),b=y+'-'+String(rangeMD[3]).padStart(2,'0')+'-'+String(rangeMD[4]).padStart(2,'0');if(timeCore.isValidDate(a)&&timeCore.isValidDate(b)&&a<=b)return toCompatPeriod(timeCore.parsePeriod(a+'~'+b,{anchor:anchor0,timezone}));}
    const md=/(\d{1,2})月(\d{1,2})[日号]/.exec(text0);
    if(md){const d=anchor0.slice(0,4)+'-'+String(md[1]).padStart(2,'0')+'-'+String(md[2]).padStart(2,'0');if(timeCore.isValidDate(d))return toCompatPeriod(timeCore.parsePeriod(d,{anchor:anchor0,timezone}));}
  }
  if(/库存|快照|盘点|日期/.test(text0)){
    const dr=/(?:从|由)(\d{1,2})[./](\d{1,2})(?:到|至|~|～)(\d{1,2})[./](\d{1,2})/.exec(text0);
    if(dr){const y=anchor0.slice(0,4),a=y+'-'+String(dr[1]).padStart(2,'0')+'-'+String(dr[2]).padStart(2,'0'),b=y+'-'+String(dr[3]).padStart(2,'0')+'-'+String(dr[4]).padStart(2,'0');if(timeCore.isValidDate(a)&&timeCore.isValidDate(b)&&a<=b)return toCompatPeriod(timeCore.parsePeriod(a+'~'+b,{anchor:anchor0,timezone}));}
  }
  const yrOf=w=>w==='去年'?Number(anchor0.slice(0,4))-1:/^\d{4}/.test(w)?Number(w.slice(0,4)):Number(anchor0.slice(0,4));
  const quarterCN=/(今年|去年|本年|(?:19|20)\d{2}年)第?([一二三四1-4])季度/.exec(text0);
  if(quarterCN){const y=yrOf(quarterCN[1]),q=CN_NUM[quarterCN[2]]||Number(quarterCN[2]),m=(q-1)*3+1,a=y+'-'+String(m).padStart(2,'0')+'-01',b=y+'-'+String(m+2).padStart(2,'0')+'-01';return toCompatPeriod({...timeCore.parsePeriod(a+'~'+timeCore.monthEnd(b),{anchor:anchor0,timezone}),grain:'quarter'});}
  const months=/(今年|去年|本年|(?:19|20)\d{2}年)(\d{1,2})月?[-~～至到](\d{1,2})月/.exec(text0);
  if(months&&Number(months[2])>=1&&Number(months[3])<=12&&Number(months[2])<=Number(months[3])){const y=yrOf(months[1]),a=y+'-'+String(months[2]).padStart(2,'0')+'-01',b=y+'-'+String(months[3]).padStart(2,'0')+'-01';return toCompatPeriod({...timeCore.parsePeriod(a+'~'+timeCore.monthEnd(b),{anchor:anchor0,timezone}),grain:'month'});}
  const singleYearMonth=/(今年|去年|本年)\s*(\d{1,2})月(?!\s*\d{1,2}[日号])/.exec(text0);
  if(singleYearMonth){const month=Number(singleYearMonth[2]);if(month<1||month>12){const error=new Error('非法月份');error.code=CODES.INVALID_PERIOD;throw error;}const start=yrOf(singleYearMonth[1])+'-'+String(month).padStart(2,'0')+'-01';return toCompatPeriod(timeCore.parsePeriod(start+'~'+timeCore.monthEnd(start),{anchor:anchor0,timezone}));}
  const through=/(本月|这个月|月初|今年|本年|年初|本周|这周|周初)(?:到|至|截至|截止|直到)?(目前|现在|今天|今日|昨天|昨日|前天)/.exec(text0);
  if(through){const baseWord=/月/.test(through[1])?'本月':/年/.test(through[1])?'今年':'本周';const base=timeCore.parsePeriod(baseWord,{anchor:anchor0,timezone});if(base){const offset=/前天/.test(through[2])?-2:/昨/.test(through[2])?-1:0,end=timeCore.addDays(anchor0,offset);if(end>=base.start)return toCompatPeriod({...base,end,endExclusive:timeCore.addDays(end,1),label:through[0]});}}
  const lastDay=/(?:(19\d{2}|20\d{2})年)?(\d{1,2})月(?:的)?(?:最后一天|末日)/.exec(text0);
  if(lastDay){const year=lastDay[1]||anchor0.slice(0,4),start=year+'-'+String(lastDay[2]).padStart(2,'0')+'-01';return toCompatPeriod(timeCore.parsePeriod(timeCore.monthEnd(start),{anchor:anchor0,timezone}));}
  const relative=/(今天|今日|昨天|昨日|前天)/.exec(text0);
  if(relative){const offset=/前天/.test(relative[0])?-2:/昨/.test(relative[0])?-1:0;const d=timeCore.addDays(anchor0,offset);return toCompatPeriod(timeCore.parsePeriod(d,{anchor:anchor0,timezone}));}
  const year=/((?:19|20)\d{2})年?全年/.exec(text0);
  if(year)return toCompatPeriod(timeCore.parsePeriod(year[1]+'年',{anchor:anchor0,timezone}));
  // 季度短语优先：整句里同时出现「2026年」和「第三季度」时，time-core 会先认年份
  const qtr = quarterPhrase(norm(text));
  if (qtr) {
    const qp = timeCore.parsePeriod(qtr, { anchor: anchorIso, timezone });
    if (qp) { const cp = toCompatPeriod(qp); cp.grain = 'quarter'; return cp; }
  }
  // 第三轮：中文日期区间「2026 年 10 月 1 日到 10 月 19 日」——后一段省略的年/月沿用前一段（原来只认到第一个日期）
  const cnr = cnDateRange(text);
  if (cnr) {
    const cp = timeCore.parsePeriod(cnr, { anchor: anchorIso, timezone });
    if (cp) return toCompatPeriod(cp);
  }
  const short = shorthandRange(text);
  if (short) {
    const sp = timeCore.parsePeriod(short, { anchor: anchorIso, timezone });
    if (sp) return toCompatPeriod(sp);
  }
  const exact = timeCore.parsePeriod(text, { anchor: anchorIso, timezone });
  if (exact) return toCompatPeriod(exact);
  const phrase = periodPhrase(text);
  if (!phrase) return null;
  const per = timeCore.parsePeriod(phrase, { anchor: anchorIso, timezone });
  if (per) return toCompatPeriod(per);
  // 语法上是显式日期/区间，但日历上不存在（如 2026-02-31）：必须拒绝，不能当成「没提时间」
  if (/^\d{4}-\d{2}-\d{2}/.test(phrase) || /^\d{4}年\d{1,2}月\d{1,2}日/.test(phrase)) {
    const err = new Error('非法日期或区间：' + phrase);
    err.code = CODES.INVALID_PERIOD;
    throw err;
  }
  return null;
}

function toCompatPeriod(per){
  if (!per) return null;
  return {
    start: per.start, end: per.end, endExclusive: per.endExclusive,
    label: per.label, grain: per.grain, timezone: per.timezone,
    explicit: per.explicit, relative: !!per.relative, policy: per.policy || null,
    interval: INTERVAL_SCHEMA, schema_version: PLAN_SCHEMA, time_core_version: TIME_CORE_VERSION,
    ...(per.clamped ? { clamped: true } : {}),
  };
}

// 业务同比/月末对齐策略由 time-core 统一声明（yoy_feb29_clamp_feb28 / prev_whole_month / equal_length_shift…）。
function shiftPeriod(per, kind, opts){
  if (!per) return null;
  const src = { start: per.start, endExclusive: per.endExclusive || (per.end ? timeCore.addDays(per.end, 1) : null), timezone: per.timezone || TIMEZONE_DEFAULT, end: per.end || null, grain: per.grain };
  const shifted = timeCore.shiftPeriod(src, kind, opts || {});
  if (!shifted) return null;
  return { start: shifted.start, end: shifted.end, endExclusive: shifted.endExclusive, label: shifted.label, policy: shifted.policy || null, timezone: shifted.timezone || null, interval: INTERVAL_SCHEMA, ...(shifted.clamped ? { clamped: true } : {}) };
}

/* ---------------- 「相比 X，Y」：Y 是本期的，X 是基期 ---------------- */
// 旧解析只取整句里第一个时间短语：像「相比 2026-03，2026-04 的退货 GMV 环比变化」会把基期当成本期（取反）。
// 这里按「相比 / 对比」这个词把期间分成两段：词在两段之前 = 先基期后本期；词在两段之间 = 先本期后基期。
// 只认语法上能解析的具体期间；「去年同季度」这种相对基期交给 comparison.kind=year_over_year，不硬编日期。
const CUE_RE = /(?:相比|对比|相比于|相较于|比起)/;
const PERIOD_TOKEN_RE = /(\d{4}-\d{2}-\d{2}\s*[~～至到]\s*\d{4}-\d{2}-\d{2}|\d{4}年\d{1,2}月\d{1,2}日?\s*[~～至到]\s*\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}\s*[~～至到]\s*\d{1,2}日|\d{4}年\d{1,2}月\d{1,2}日?|\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}|\d{4}-\d{2}|\d{4}年\d{1,2}月|\d{4}\s*[-年]?\s*Q\s*[1-4](?!\d)|\d{4}\s*年?\s*第\s*[1-4一二三四]\s*季度|(?:最近|近)\s*\d{1,3}\s*天|上个?完整月|本月至今|月初至今|这个月|本月|上个?月|上周|本周|这周|今年至今|今年|去年)/gi;
const REL_BASE_RE = /同季度|同季|同期|同月|同样的?季度/;
function periodMentions(raw){
  const s = String(raw == null ? '' : raw);
  const out = [];
  let m;
  PERIOD_TOKEN_RE.lastIndex = 0;
  while ((m = PERIOD_TOKEN_RE.exec(s))) {
    const end = m.index + m[0].length;
    if (out.some(x => m.index < x.end && end > x.index)) continue;   // 不重叠
    out.push({ start: m.index, end, text: m[0] });
  }
  return out;
}
/**
 * 解析「相比 X，Y」里的本期 / 基期。
 * @returns {{current:object|null, base:object|null, baseKind:'explicit'|'year_over_year'|null, spanCount:number, text:object|null}}
 */
function comparisonBaseOf(raw, o = {}){
  const s = String(raw == null ? '' : raw);
  const spans = periodMentions(s);
  const cue = CUE_RE.exec(s);
  const out = { current: null, base: null, baseKind: null, spanCount: spans.length, text: null };
  if (!spans.length || !cue) return out;
  const parse = sp => { try { return parsePeriod(sp.text, o.anchor, { timezone: o.timezone }); } catch (_) { return null; } };
  const relAt = i => !!spans[i] && REL_BASE_RE.test(s.slice(spans[i].start, spans[i].end + 6));
  const cueAt = cue.index;
  if (cueAt < spans[0].start) {
    // 「相比 X，Y」：X 是基期、Y 是本期；只点了一个相对基期（去年同季度）就按同比走
    if (spans.length >= 2) {
      out.base = parse(spans[0]); out.current = parse(spans[1]); out.text = spans[1];
      if (relAt(0)) { out.base = null; out.baseKind = 'year_over_year'; }
    } else if (relAt(0)) out.baseKind = 'year_over_year';
    else { out.current = parse(spans[0]); out.text = spans[0]; }
  } else {
    // 「A 相比 B」：A 是本期、B 是基期
    out.current = parse(spans[0]); out.text = spans[0];
    if (spans[1]) { out.base = parse(spans[1]); if (relAt(1)) { out.base = null; out.baseKind = 'year_over_year'; } }
    // 第三轮 T4：「A 与/和/跟 B 相比，变化了多少」是两段并列的日期、问的是变化 → 按时间先后：早的一段是基期、晚的一段是本期
    if (out.current && out.base && spans[1] && spans[1].end <= cueAt && /^\s*(?:与|和|跟|同)\s*$/.test(s.slice(spans[0].end, spans[1].start))
      && String(out.current.start || '') < String(out.base.start || '')) {
      const t = out.current; out.current = out.base; out.base = t; out.text = spans[1];
    }
  }
  if (out.base) out.baseKind = out.baseKind || 'explicit';
  return out;
}
/* ---------------- 指标 / 实体 / 维度识别 ---------------- */
const NAME_QUALIFIERS = ['期末', '平均', '累计', '总计', '合计', '月度', '当月', '本期', '全年', '年度', '单SKU', '单sku', '预聚合'];
const NAME_SUFFIXES = ['数量', '金额', '合计', '数量', '总量', '总量', '数目', '量', '数', '率', '额', '计', '值'];
function nameVariants(name){
  const out = new Set();
  const raw = norm(name);
  if (!raw) return out;
  const push = (x) => { const k = norm(x); if (k.length >= 2) out.add(k); };
  push(raw);
  let cur = raw;
  // 括号：整名去括号 / 括号里的内容
  const noParen = cur.replace(/[（(][^）)]*[）)]/g, '');
  push(noParen);
  for (const m of cur.matchAll(/[（(]([^）)]{2,})[）)]/g)) push(m[1]);
  cur = noParen;
  for (let round = 0; round < 2; round++) {
    const before = cur;
    for (const q of NAME_QUALIFIERS) if (cur.startsWith(q) && cur.length - q.length >= 2) cur = cur.slice(q.length);
    for (const suf of NAME_SUFFIXES) if (cur.endsWith(suf) && cur.length - suf.length >= 2) { push(cur.slice(0, -suf.length)); cur = cur.slice(0, -suf.length); break; }
    if (cur === before) break;
    push(cur);
  }
  return out;
}
function metricCandidates(registry, text){
  const raw = String(text == null ? '' : text);
  // 和维度同名的词（如「一级品类」）不是指标叫法，否则「品类数」类指标会抢走分组题
  const dimWords = new Set();
  try {
    for (const d of registry.semantic.dims.values()) {
      for (const k of [d.name, d.id, ...(d.match || []), ...(d.aliases || [])]) { const nk = norm(k).toLowerCase(); if (nk) dimWords.add(nk); }
    }
  } catch (_) {}
  // 括号里常是公式/口径说明（「退货率（退货 GMV ÷ GMV ×100）」），不是用户在问的指标
  const noParen = raw.replace(/[（(][^）)]*[）)]/g, ' ');
  const s = norm(noParen).toLowerCase();
  const hits = [];
  for (const m of registry.semantic.metrics.values()) {
    if (m.unbound) continue;
    // 名称 / 别名 = 这个指标自己叫什么（tier 2）；match = 它绑定的角色列还可能叫什么（tier 1）。
    // 「销售额」是 gmv 的名字、只是 ad_gmv 的角色别名 → 名字优先，不再三家平票。
    const named = uniq([...(nameVariants(m.name) || []), norm(m.id).toLowerCase(), ...(m.aliases || []).flatMap(a => [...nameVariants(a)])]
      .filter(Boolean)).filter(k => k.length >= 2 && !dimWords.has(k.toLowerCase()));
    const roleKeys = uniq([...(m.match || [])].flatMap(x => [...nameVariants(x)]).filter(Boolean)).filter(k => k.length >= 2);
    let best = 0, key = null, tier = 0;
    for (const k of named) if (s.includes(k) && k.length > best) { best = k.length; key = k; tier = 2; }
    for (const k of roleKeys) if (s.includes(k) && (k.length > best || (k.length === best && tier < 2))) { best = k.length; key = k; tier = k.length === best && tier === 2 ? 2 : 1; }
    if (best) hits.push({ id: 'm:' + m.id, key, len: best, tier });
  }
  if (!hits.length) return { candidates: [], key: null };
  const maxTier = Math.max(...hits.map(h => h.tier));
  const pool = hits.filter(h => h.tier === maxTier);
  const max = Math.max(...pool.map(h => h.len));
  // 最长命中优先：「金额退货率」不会再被「退货率」拉成两个候选
  const candidates=uniq(pool.filter(h => h.len === max).map(h => h.id)),key=pool.find(h => h.len === max).key;
  if(candidates.length>1){
    const units=uniq(candidates.map(id=>String(registry.metric(id).unit||'')).filter(Boolean));
    const requested=units.filter(unit=>new RegExp('(?:多少|几)\\s*'+unit.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:[？?。！!]|$)').test(raw));
    const mentioned=units.filter(unit=>new RegExp('(?:多少|几)\\s*'+unit.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).test(raw));
    if(requested.length===1&&mentioned.length===1){const matches=candidates.filter(id=>registry.metric(id).unit===requested[0]);if(matches.length===1)return {candidates:matches,key,unitEvidence:{unit:requested[0],selected:matches[0],options:candidates}};}
  }
  return {candidates,key};
}

function dimCandidates(registry, text){
  text=withoutDateFormatReading(text);
  const s = norm(text);
  const keysOf = d => uniq([d.name, d.id, ...(d.match || [])].filter(Boolean).map(norm)).filter(k => k.length >= 2);
  const all = [...registry.semantic.dims.values()].filter(d => !d.unbound);
  // 1) 明确的「按X / 各X / 分X / 每X」：分组对象由这个短语决定，而不是由句子里随便出现的词决定
  // 短语只取「按」后面那一段中文（「按店铺看销售额」→ 店铺；「各渠道GMV」→ 渠道）
  const phrases = [...s.matchAll(/(?:按|各|分|每)([^，,。；;？?的]{1,8})/g)]
    .map(m => (m[1].match(/^[\u4e00-\u9fff]+/) || [''])[0])
    .map(seg => seg.split(/看|查|算|统计|是|有|多少|怎么|呢|的|和|跟|与/)[0])   // 「按店铺看销售额」→ 店铺
    .filter(Boolean);
  for (const ph of phrases) {
    const scored = all.map(d => {
      const keys = keysOf(d);
      const hitKey = keys.filter(k => ph.includes(k)).sort((a, b) => b.length - a.length)[0];
      return { d, len: hitKey ? hitKey.length : 0, exact: keys.includes(ph) ? 1 : 0, nameExact: norm(d.name) === ph ? 1 : 0 };
    }).filter(x => x.len > 0).sort((a, b) => b.nameExact - a.nameExact || b.exact - a.exact || b.len - a.len);
    if (scored.length) {
      const top = scored[0];
      // 同一个短语命中两个不同维度且分不出高下：记成待定，不替用户选
      const rivals = scored.filter(x => x.nameExact === top.nameExact && x.exact === top.exact && x.len === top.len && x.d.id !== top.d.id);
      if (rivals.length) return { ambiguous: ['d:' + top.d.id, ...rivals.map(x => 'd:' + x.d.id)], phrase: ph };
      return ['d:' + top.d.id];
    }
  }
  // 2) 没有「按X」：只有唯一命中才用（宁可少分组，也不猜）
  //    「全渠道 / 所有渠道 / 全部品类 / 整体」是“不分组”的范围词，不是分组维度。
  const scopeWordOnly = (k) => {
    let idx = s.indexOf(k), seen = false;
    while (idx >= 0) {
      const before = s.slice(Math.max(0, idx - 2), idx);
      if (!/(全|所有|全部|整体|任何)$/.test(before)) return false;   // 至少出现一次不是在范围词里
      seen = true;
      idx = s.indexOf(k, idx + k.length);
    }
    return seen;
  };
  const hits = [];
  for (const d of all) {
    let best = 0, bestKey = null;
    for (const k of keysOf(d)) if (s.includes(k) && k.length > best) { best = k.length; bestKey = k; }
    if (best >= 2 && !(bestKey && scopeWordOnly(bestKey))) hits.push({ id: 'd:' + d.id, len: best });
  }
  if (!hits.length) return [];
  const max = Math.max(...hits.map(h => h.len));
  const top = uniq(hits.filter(h => h.len === max).map(h => h.id));
  return top.length === 1 ? top : { ambiguous: top, phrase: null };
}

/* ---------------- 解析 ---------------- */
/**
 * @param {string} text 用户原话
 * @param {{registry, anchor?, timezone?, entityLookup?, scope?, now?}} o
 */
function parsePlan(text, o = {}){
  const registry = o.registry;
  if (!registry) throw new Error('parsePlan 需要 registry');
  const raw = String(text == null ? '' : text);
  const s = norm(raw);
  const plan = {
    schema: PLAN_SCHEMA,
    question: raw,
    metric_ids: [], dimensions: [], entities: [], filters: [], negations: [],
    time: { role: null, anchor: null, start: null, end: null, endExclusive: null, timezone: o.timezone || TIMEZONE_DEFAULT, grain: null, label: null, interval: INTERVAL_SCHEMA, schema_version: PLAN_SCHEMA },
    comparison: { kind: 'none', explicit: false, base: null },
    grain: null, rank: null, formula: null, unit: '',
    permission_scope: { workspace: (o.scope && o.scope.workspace) || 'local', datasets: (o.scope && o.scope.datasets) || null },
    output_shape: 'scalar',
    unresolved: [],
  };

  // 1) 指标（歧义不猜）
  const mc = metricCandidates(registry, raw);
  if (!mc.candidates.length) {
    plan.unresolved.push({ code: CODES.UNKNOWN_METRIC, message: '这句话里没有可识别的语义指标', hint: '先用 discover_capabilities 看有哪些指标' });
  } else if (mc.candidates.length > 1) {
    plan.metric_ids = mc.candidates;
    plan.unresolved.push({ code: CODES.AMBIGUOUS_METRIC, message: `「${mc.key}」对应多个指标`, options: mc.candidates.map(id => ({ id, name: registry.metric(id).name })) });
  } else plan.metric_ids = mc.candidates;

  // 2) 时间（先看有没有期间表达；再看时间角色）
  // 「相比 X，Y」：Y 是本期、X 是基期。整句只取第一个时间短语会把基期当成本期（取反），
  // 所以先按对比词定位本期；定位到了就用它，定位不到才退回整句解析。
  let per = null;
  const cmpBase = comparisonBaseOf(raw, { anchor: o.anchor, timezone: o.timezone });
  try { per = (cmpBase.current && cmpBase.text) ? cmpBase.current : parsePeriod(raw, o.anchor); }
  catch (err) { plan.unresolved.push({ code: err.code || CODES.INVALID_PERIOD, message: err.message }); }
  const TIME_WORDS = /(\d{4}\s*[-年\/]\s*\d{1,2}|\d{1,2}\s*月|最近\s*\d{1,3}\s*天|近\s*\d{1,3}\s*天|本月|这个月|上月|上个月|本周|上周|今年|去年|季度|Q[1-4])/i;
  const timeMentioned = TIME_WORDS.test(s);
  if (!per && timeMentioned) plan.unresolved.push({ code: CODES.INVALID_PERIOD, message: '题面提到了时间，但没能解析成合法期间（不按「全部数据」处理）' });
  const roles = registry.timeRoles();
  if (per) {
    plan.time.start = per.start;
    plan.time.end = per.end;                    // 兼容字段（inclusive），不参与内部计算
    plan.time.endExclusive = per.endExclusive;  // 规范字段：半开区间
    plan.time.label = per.label;
    plan.time.anchor = o.anchor || timeCore.todayIn(o.timezone || TIMEZONE_DEFAULT);
    plan.time.grain = per.grain;
    plan.time.timezone = per.timezone || plan.time.timezone;
    plan.time.policy = per.policy || null;
    plan.time.interval = INTERVAL_SCHEMA;
    // 显式时间角色：话里点名「退款时间 / 下单时间」
    const named = ROLE_WORDS.find(r => r.re.test(s));
    // 这个计划真正涉及的数据集（指标叶子 + 维度）
    const datasets = uniq([
      ...plan.metric_ids.flatMap(id => registry.leaves(id).map(leaf => registry.metric(leaf).dataset || registry.metric(leaf).boundTo)),
      ...plan.dimensions.map(d => registry.dim(d).source && registry.dim(d).source.table),
    ].filter(Boolean));
    const usable = roles.filter(r => datasets.includes(r.dataset));
    if (named) {
      const hit = usable.find(r => named.hint.test(r.dataset)) || null;
      if (hit) plan.time.role = hit.id; else plan.unresolved.push({ code: CODES.MISSING_TIME_ROLE, message: `「${named.name}」这个口径在这份数据里没有日期列`, options: usable });
    } else if (usable.length > 1) {
      plan.unresolved.push({ code: CODES.MISSING_TIME_ROLE, message: '这个指标涉及多个日期口径，先确认按哪个时间统计', options: usable });
    } else if (usable.length === 1) plan.time.role = usable[0].id;
    else plan.unresolved.push({ code: CODES.MISSING_TIME_ROLE, message: '这些数据里没有可用的日期列', options: roles });
  }

  // 3) 维度 / 实体 / 否定
  // 「按退款时间看」里的「退款时间」是时间口径，不是分组维度：先把它从分组短语里剔掉
  const roleMatch = ROLE_WORDS.map(r => r.re.exec(s)).find(Boolean);
  const dimText = roleMatch ? raw.replace(roleMatch[0], ' ') : raw;
  const dc = dimCandidates(registry, dimText);
  if (Array.isArray(dc)) plan.dimensions = dc.filter(d => !(plan.time.role && plan.time.role.dim === d));
  else plan.unresolved.push({ code: 'ambiguous_dim', message: `分组对象「${dc.phrase || ''}」有多个候选`, options: dc.ambiguous });
  if (o.entityLookup) {
    const r = o.entityLookup.resolve(raw, { dimIds: plan.dimensions.length ? plan.dimensions.map(d => d.slice(2)) : undefined });
    if (r.status === 'matched') plan.entities.push({ dim: 'd:' + r.dim, value: r.value, how: r.how });
    else if (r.status === 'ambiguous') plan.unresolved.push({ code: CODES.AMBIGUOUS_ENTITY, message: '这句话里的实体有多个候选', options: r.candidates });
  }
  // 「不含 / 排除 / 除了 X」→ 否定条件（不静默丢掉）
  // 点名了一个具体对象（SKU 编码 / 单号 / 引号里的值），但本机没认出来：
  // 不能当成「没提」，否则会把「SKU ZZZ-9999 的库存」答成「全部库存」。
  const coded = /(?:SKU|sku|订单号|单号|编号|款号)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_\-]{2,})/.exec(raw);
  if (coded && !plan.entities.length) {
    const already = plan.unresolved.some(u => u.code === CODES.AMBIGUOUS_ENTITY);
    if (!already) plan.unresolved.push({ code: CODES.ENTITY_NOT_FOUND, message: `提到的「${coded[1]}」没有在本机实体目录里找到，不能当成「全部」来算`, options: [] });
  }
  const neg = /(?:排除|不含|不包括|除了|剔除)([^，,。；;？?]{1,20})/g;
  for (let m; (m = neg.exec(raw));) plan.negations.push({ text: m[1].trim() });
  if (plan.negations.length && !plan.entities.length) {
    plan.unresolved.push({ code: CODES.AMBIGUOUS_ENTITY, message: `否定条件「${plan.negations[0].text}」没有落实到具体实体`, options: [] });
  }

  // 4) 对比 / 粒度 / 排名 / 输出形状
  // 「相比 X，Y」的基期 X 落到 plan.comparison.base（显式期间）；相对基期（去年同季度）走同比策略。
  if (/同比|去年同期|去年同月|去年同季度|去年同季/.test(s) || (cmpBase && cmpBase.baseKind === 'year_over_year')) plan.comparison = { kind: 'year_over_year', explicit: true, base: null, output: 'delta' };
  else if (/环比|上一段|比上|跟.{0,6}比|增长|下滑|下降|上升|相比|对比/.test(s)) plan.comparison = { kind: 'previous_period', explicit: true, base: null, output: 'delta' };
  if (cmpBase && cmpBase.base && cmpBase.baseKind === 'explicit') plan.comparison = Object.assign(plan.comparison, { base: cmpBase.base, explicit: true });
  if (plan.comparison.kind !== 'none' && /增长|下降|上涨|下滑|增加|减少|变化/.test(s) && /(%|％|百分|百分点|多少个百分点|增长率)/.test(s)) plan.comparison.output = 'growth_rate';
  if (/每季|按季|季度|逐季/.test(s)) plan.grain = 'quarter';
  else if (/每年|按年|年度/.test(s)) plan.grain = 'year';
  else if (/每月|按月|逐月|月度/.test(s)) plan.grain = 'month';
  else if (/每周|按周|逐周|周度/.test(s)) plan.grain = 'week';
  else if (/每天|按天|逐日|日度|哪一天|哪天/.test(s)) plan.grain = 'day';

  plan.rank = rankOf(s);
  if(plan.rank)delete plan.rank.nulls;   // 保持既有parsePlan公开形状；执行器原有默认仍是nulls last。
  plan.output_shape = plan.rank ? 'table' : (plan.grain || plan.dimensions.length ? 'table' : 'scalar');

  // 5) 公式 / 单位（从指标定义里取，不在这里另写一套）
  if (plan.metric_ids.length === 1) {
    const m = registry.metric(plan.metric_ids[0]);
    plan.unit = m.unit || '';
    plan.formula = m.kind === 'ratio' ? { kind: 'ratio', num: 'm:' + m.num, den: 'm:' + m.den, mul: m.mul || 1, scope: 'keep_group_filter' }
      : m.kind === 'derived' ? { kind: 'derived', expr: m.expr }
        : { kind: 'simple', agg: m.agg, field: m.field, dataset: m.dataset };
    plan.metric_name = m.name;
  }
  plan.id = planHash(plan);
  return plan;
}

function planHash(plan){
  const t = plan.time || {};
  const core = {
    schema: PLAN_SCHEMA, interval: INTERVAL_SCHEMA,
    metric_ids: plan.metric_ids, dimensions: plan.dimensions, entities: plan.entities.map(e => [e.dim, e.value]),
    filters: plan.filters, negations: plan.negations,
    // 规范化：只认半开区间（endExclusive），旧 end 不参与 hash，避免同一计划两种 id
    time: { role: t.role || null, start: t.start || null, endExclusive: t.endExclusive || null, timezone: t.timezone || TIMEZONE_DEFAULT, grain: t.grain || null },
    // 显式基期也是参数：同一个「比上一期」换个基期必须是不同的计划 id
    comparison: [plan.comparison.kind, plan.comparison.output || 'delta', ...(plan.comparison.base && plan.comparison.base.start ? [plan.comparison.base.start, plan.comparison.base.endExclusive] : [])],
    grain: plan.grain, rank: plan.rank, formula: plan.formula, unit: plan.unit, output_shape: plan.output_shape,
    having: plan.having || null, cumulative: !!plan.cumulative, indicator: plan.indicator || null,
    permission_scope: plan.permission_scope,
  };
  return 'plan:' + crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 24);
}

/* ---------------- 校验 ---------------- */
function normalizePlan(plan){
  const p = plan && typeof plan === 'object' ? plan : {};
  const t0 = Object.assign({ role: null, anchor: null, start: null, end: null, endExclusive: null, timezone: TIMEZONE_DEFAULT, grain: null, label: null, interval: INTERVAL_SCHEMA, schema_version: PLAN_SCHEMA }, p.time || {});
  // 唯一适配边界：plan-ir/1（闭区间 end）→ plan-ir/2（半开 endExclusive），只在这里转换一次
  const compat = [];
  const legacyDeclared = p.schema === LEGACY_PLAN_SCHEMA || t0.schema_version === LEGACY_PLAN_SCHEMA;
  if (!t0.endExclusive && t0.end && timeCore.isValidDate(String(t0.end).slice(0, 10))) {
    t0.endExclusive = timeCore.addDays(String(t0.end).slice(0, 10), 1);
    compat.push({ from: LEGACY_PLAN_SCHEMA, rule: 'end_inclusive_to_exclusive' });
  }
  if (!t0.end && t0.endExclusive && timeCore.isValidDate(String(t0.endExclusive).slice(0, 10))) {
    t0.end = timeCore.addDays(String(t0.endExclusive).slice(0, 10), -1);   // 旧调用方兼容读
  }
  t0.interval = INTERVAL_SCHEMA;
  t0.schema_version = PLAN_SCHEMA;
  t0.timezone = t0.timezone || TIMEZONE_DEFAULT;
  if (legacyDeclared && !compat.length) compat.push({ from: LEGACY_PLAN_SCHEMA, rule: 'declared_only' });
  return Object.assign({
    schema: PLAN_SCHEMA, question: p.question || '', metric_ids: [], dimensions: [], entities: [], filters: [], negations: [],
    time: t0,
    comparison: { kind: 'none', explicit: false, base: null }, grain: null, rank: null, formula: null, unit: '',
    permission_scope: { workspace: 'local', datasets: null }, output_shape: 'scalar', unresolved: [],
  }, p, {
    schema: PLAN_SCHEMA,
    metric_ids: Array.isArray(p.metric_ids) ? p.metric_ids : [],
    dimensions: Array.isArray(p.dimensions) ? p.dimensions : [],
    entities: Array.isArray(p.entities) ? p.entities : [],
    filters: Array.isArray(p.filters) ? p.filters : [],
    negations: Array.isArray(p.negations) ? p.negations : [],
    unresolved: Array.isArray(p.unresolved) ? p.unresolved : [],
    time: t0,
    // 第三轮：旧的规范 IR 里 comparison 存的是字符串（只有 kind）——按 kind 读，不能把字符串逐字展开成对象
    comparison: Object.assign({ kind: 'none', explicit: false, base: null }, typeof p.comparison === 'string' ? { kind: p.comparison, explicit: p.comparison !== 'none' } : (p.comparison || {})),
    permission_scope: Object.assign({ workspace: 'local', datasets: null }, p.permission_scope || {}),
    ...(compat.length ? { compat } : {}),
  });
}

/**
 * 比率/占比的换算倍数：计划里没写 mul 时不整题拒答，按语义层的指标定义自己补。
 * 顺序：计划显式 mul > 已选指标的 mul/单位 > 分子指标的 mul/单位 > 占比默认 100、比值默认 1。
 * 只看指标定义，不猜业务口径（猜不出的写 1，单位仍按指标定义）。
 */
function inferFormulaScale(registry, formula, metricIds){
  const f = formula || {};
  if (f.mul != null && Number.isFinite(Number(f.mul)) && Number(f.mul) !== 0) return Number(f.mul);
  const refs = [...(Array.isArray(metricIds) ? metricIds : []), f.num, f.base].filter(Boolean).map(x => String(x).replace(/^m:/, ''));
  for (const ref of refs) {
    let m = null;
    try { m = registry.metric('m:' + ref); } catch (_) { m = null; }
    if (!m) continue;
    if (m.mul != null && Number.isFinite(Number(m.mul)) && Number(m.mul) !== 0) return Number(m.mul);
    if (String(m.unit || '') === '%') return 100;
    if (/率|占比|份额|rate|share|ratio|percent|pct/i.test(String(m.id) + ' ' + String(m.name || ''))) return 100;
    return 1;
  }
  return f.kind === 'share' ? 100 : 1;
}

/** 第三轮：比值/占比的输出单位按口径算（不信模型写的单位）：×100 → %；分子分母同单位 → 倍；不同单位 → 分子单位（元÷件 → 元） */
function formulaUnitOf(registry, formula){
  const f = formula || {};
  const mul = f.mul == null ? null : Number(f.mul);
  if (f.kind === 'share' || mul === 100) return '%';
  const unitOfRef = ref => { try { return String((registry.metric('m:' + String(ref).replace(/^m:/, '')) || {}).unit || ''); } catch (_) { return ''; } };
  const nu = f.num || f.base ? unitOfRef(f.num || f.base) : '';
  const den = f.den || (f.den_expr && Array.isArray(f.den_expr.args) ? f.den_expr.args[0] : null);
  const du = den ? unitOfRef(den) : '';
  if (nu === '%' && du === '%') return '倍';
  if (nu === du) return '倍';
  return nu;
}

function validatePlan(planIn, o = {}){
  const registry = o.registry;
  if (!registry) throw new Error('validatePlan 需要 registry');
  // 工具面会收到模型给的对象：先补默认值，任何畸形计划都返回缺口而不是抛异常
  const plan = normalizePlan(planIn);
  const errors = [];
  const push = (code, message, extra) => errors.push(Object.assign({ code, message }, extra || {}));
  if (planIn && planIn.schema && ![PLAN_SCHEMA, LEGACY_PLAN_SCHEMA].includes(planIn.schema)) push(CODES.IR_INVALID, `计划格式不对（需要 ${PLAN_SCHEMA}，兼容 ${LEGACY_PLAN_SCHEMA}）`);

  // 解析阶段已经记下的缺口（时间角色 / 指标 / 实体）原样带过来
  for (const u of (plan.unresolved || [])) errors.push({ code: u.code, message: u.message, options: u.options, from: 'parse' });

  if (plan.metric_ids.length > 1) push(CODES.AMBIGUOUS_METRIC, '指标还没确定', { options: plan.metric_ids.map(id => ({ id, name: registry.metric(id).name })) });
  for (const id of plan.metric_ids) {
    const m = registry.semantic.metrics.get(String(id).replace(/^m:/, ''));
    if (!m) { push(CODES.UNKNOWN_METRIC, `没有指标：${id}`); continue; }
    if (!registry.semantic.isBound(m.id)) push(CODES.MISSING_BINDING, `指标「${m.name}」没有绑定到用户表`, { metric: id });
  }
  // 时间：有期间就要有角色；对比必须有期间；非法日历日期（如 2026-02-31）必须拒绝
  if (plan.time && plan.time.start && !plan.time.role) push(CODES.MISSING_TIME_ROLE, '有时间范围，但没有确定按哪个日期口径统计', { options: registry.timeRoles() });
  if (plan.comparison?.kind === 'none' && plan.comparison.base?.start) push(CODES.IR_INVALID,'已有显式基期，但比较类型为none，不能忽略基期');
  if (plan.comparison && plan.comparison.kind !== 'none' && !plan.time.start) push(CODES.MISSING_TIME_ROLE, '要做对比，必须先有一段明确的时间');
  if (plan.time && plan.time.start) {
    const s = String(plan.time.start).slice(0, 10), e = plan.time.endExclusive ? String(plan.time.endExclusive).slice(0, 10) : null;
    if (!timeCore.isValidDate(s)) push(CODES.INVALID_PERIOD, `开始日期不是合法日历日期：${s}`);
    else if (e == null) push(CODES.INVALID_PERIOD, '缺少半开区间终点 endExclusive');
    else if (!timeCore.isValidDate(e)) push(CODES.INVALID_PERIOD, `区间终点不是合法日历日期：${e}`);
    else if (s >= e) push(CODES.INVALID_PERIOD, '开始日期必须早于区间终点');
  } else if (plan.time && plan.time.endExclusive) {
    push(CODES.INVALID_PERIOD, '有区间终点但没有开始日期');
  }

  // 维度：存在 + 能安全分组（扇出由 Semantic 判定）
  if (plan.metric_ids.length === 1) {
    for (const d of plan.dimensions) {
      if (!registry.semantic.dims.has(String(d).replace(/^d:/, ''))) { push(CODES.UNKNOWN_DIM, `没有维度：${d}`); continue; }
      // 第三轮：有公式时按公式真正参与计算的指标判扇出（比值的分子/分母、占比的基数），不拿「metric 槽」那个指标判
      const fx = plan.formula || {};
      const refsForJoin = (['ratio', 'share'].includes(fx.kind) ? [fx.num || fx.base, fx.den, ...((fx.den_expr && Array.isArray(fx.den_expr.args)) ? fx.den_expr.args : [])]
        : fx.kind === 'pp' ? [fx.left, fx.right] : [plan.metric_ids[0]])
        .filter(x => typeof x === 'string' && registry.semantic.metrics.has(String(x).replace(/^m:/, '')));
      for (const ref of (refsForJoin.length ? refsForJoin : [plan.metric_ids[0]])) {
        try { registry.semantic.checkJoin(String(ref).replace(/^m:/, ''), [String(d).replace(/^d:/, '')]); }
        catch (err) { push(err.code || CODES.FANOUT, err.message, { dim: d }); break; }
      }
    }
    // 能力缺口：跨表按时间分桶（每个叶子在不同表上，桶边界无法对齐）——不硬算，明确报缺口
    if (plan.grain) {
      const sets = uniq(plan.metric_ids.flatMap(id => { try { return registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo); } catch (_) { return []; } }).filter(Boolean));
      if (sets.length > 1) push(CODES.UNSUPPORTED_OPERATOR, `「${plan.grain}」分桶要求指标来自同一张表；这个指标跨 ${sets.length} 张表（${sets.join('、')}），暂不支持`, { metric: plan.metric_ids[0], datasets: sets });
    }

    // 能力缺口：半可加指标跨表分组 / 存量期末值
    const m = registry.metric(plan.metric_ids[0]);
    // 第三轮：快照类指标跨表分组已由语义编译器「先取期末快照再连表」实现（ops.semiadditive_cross_table）；
    // 编译器做不到时（基表没有日期列）会自己报缺口，这里不再一刀切拦掉。
    void m;
  }

  // 比率/公式：分子分母必须存在且一起计算；作用域必须显式（先聚合后相除）
  if (plan.formula && (plan.formula.kind === 'ratio' || plan.formula.kind === 'share')) {
    if (plan.formula.kind === 'ratio') for (const ref of [plan.formula.num, plan.formula.den]) {
      if (!ref) { push(CODES.MISSING_BINDING, '比率公式缺分子或分母'); continue; }
      const rid = String(ref).replace(/^m:/, '');
      if (!registry.semantic.metrics.has(rid)) push(CODES.UNKNOWN_METRIC, `比率公式引用了不存在的指标：${ref}`);
    }
    if (!plan.formula.scope && !plan.formula.denominator_scope) {
      // 分母作用域没写：按公式类型补默认（比值保留分组、占比去掉分组），并在 applied/trace 里可解释
      plan.formula.scope = plan.formula.kind === 'share' ? 'remove_group_filter_keep_user_filter' : 'keep_group_filter';
    }
    // 换算倍数没写：按指标定义自补（不因为模型漏写 mul 整题拒答）
    if (plan.formula.mul == null) plan.formula.mul = inferFormulaScale(registry, plan.formula, plan.metric_ids);
  }
  if (plan.formula && !['simple', 'ratio', 'share', 'pp', 'derived', 'member_diff'].includes(plan.formula.kind)) push(CODES.UNSUPPORTED_OPERATOR, `公式类型不支持：${plan.formula.kind}`);
  if (plan.formula && plan.formula.kind === 'derived') {
    const refs = [];
    const walk = x => { if (typeof x === 'string') refs.push(String(x).replace(/^m:/, '')); else if (x && Array.isArray(x.args)) x.args.forEach(walk); };
    walk(plan.formula.expr);
    if (!refs.length) push(CODES.PLAN_INCOMPLETE, '派生公式没有引用任何指标');
    for (const r of refs) if (!registry.semantic.metrics.has(r)) push(CODES.UNKNOWN_METRIC, `派生公式引用了不存在的指标：m:${r}`);
  }
  if (plan.formula && plan.formula.kind === 'pp') {
    for (const ref of [plan.formula.left, plan.formula.right]) {
      if (!ref) { push(CODES.MISSING_BINDING, '百分点公式缺 left/right'); continue; }
      const rid = String(ref).replace(/^m:/, '');
      if (!registry.semantic.metrics.has(rid)) push(CODES.UNKNOWN_METRIC, `百分点公式引用了不存在的指标：${ref}`);
    }
    if (!['pp'].includes(String(plan.unit))) { /* 单位由执行器按 percent_scale 给，不强制写死 */ }
  }
  // 时间粒度：允许 quarter/year（由时间桶维度或执行器派生）
  if (plan.grain != null && !['day', 'week', 'month', 'quarter', 'year'].includes(plan.grain)) push(CODES.UNSUPPORTED_OPERATOR, `时间粒度不支持：${plan.grain}`);
  if (plan.comparison && plan.comparison.output != null && !['delta', 'growth_rate'].includes(plan.comparison.output)) push(CODES.UNSUPPORTED_OPERATOR, `比较输出不支持：${plan.comparison.output}`);
  if (plan.rank) {
    for (const pid of (plan.rank.partition_by || [])) {
      if (!registry.semantic.dims.has(String(pid).replace(/^d:/, ''))) push(CODES.UNKNOWN_DIM, `组内排名的分组维度不存在：${pid}`);
    }
    if (!['asc', 'desc'].includes(plan.rank.direction)) push(CODES.UNSUPPORTED_OPERATOR, '排名方向只能是 asc/desc');
    if (!['include', 'exclude'].includes(plan.rank.ties)) push(CODES.UNSUPPORTED_OPERATOR, '并列策略只能是 include/exclude');
    if (plan.rank.nulls != null && !['last', 'first', 'drop'].includes(plan.rank.nulls)) push(CODES.UNSUPPORTED_OPERATOR, 'null 排序策略只能是 last/first/drop');
    if (!Number.isInteger(plan.rank.top) || plan.rank.top < 1) push(CODES.UNSUPPORTED_OPERATOR, '前 N 名必须是正整数');
  }
  if (plan.output_shape && !['scalar', 'table', 'series'].includes(plan.output_shape)) push(CODES.UNSUPPORTED_OPERATOR, `输出形状不支持：${plan.output_shape}`);
  // T4 新节点
  if (plan.having) {
    if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(String(plan.having.op))) push(CODES.UNSUPPORTED_OPERATOR, '按指标筛选的比较符不支持：' + plan.having.op);
    if (!Number.isFinite(Number(plan.having.value))) push(CODES.PLAN_INCOMPLETE, '按指标筛选缺阈值');
    if (!plan.having.count_groups && !(plan.dimensions || []).length && !(plan.grain && plan.grain !== 'none')) push(CODES.IR_INVALID, 'having 是「先分组再按指标值筛组」，没有分组维度或时间粒度时不能用；按行的条件（如库龄 ≥ X）请写进 num_filter');
    if (plan.having.count_groups && !(plan.dimensions || []).length && !(plan.grain && plan.grain !== 'none')) push(CODES.PLAN_INCOMPLETE, '「满足条件的组数」必须先有分组维度或时间粒度');
    // P78:按「分组对象自己的去重个数 / 行数」去筛组是退化条件(去重个数每组恒为 1)——题面阈值其实针对别的指标(如金额),配置单表达不了就交给 SQL
    try {
      const f = plan.formula && plan.formula.kind === 'simple' ? plan.formula : null;
      const keyFields = (plan.dimensions || []).map(d => { try { const x = registry.dim(String(d).replace(/^d:/, '')); return x && x.source ? x.source.table + '.' + x.source.field : null; } catch (_) { return null; } }).filter(Boolean);
      if (f && f.agg === 'dcount' && keyFields.includes(f.dataset + '.' + f.field)) push(CODES.PLAN_INCOMPLETE, '按指标筛组的指标是分组对象自己的去重个数（每组恒为1），题面阈值针对的应是另一指标；配置单表达不了这种「先按A合计筛组再数组」时交给只读SQL');
    } catch (_) {}
  }
  // P79:比率的分子是「按平均登记」的指标、分母是行数/去重个数 → AVG ÷ COUNT 没有业务含义(典型:题面写 sum(x)/count(*) 被算成 avg(x)/count);
  // 配置单表达不了「对平均型字段改用合计」时交给只读 SQL 按题面公式算。
  try {
    const fm = plan.formula && plan.formula.kind === 'ratio' ? plan.formula : null;
    if (fm && fm.num && fm.den) {
      const mOf = id => { try { return registry.metric('m:' + String(id).replace(/^m:/, '')); } catch (_) { return null; } };
      const num = mOf(fm.num), den = mOf(fm.den);
      if (num && den && num.kind === 'simple' && num.agg === 'avg' && (den.kind === 'count' || ['count', 'dcount'].includes(den.agg))) push(CODES.PLAN_INCOMPLETE, '比率分子按平均登记、分母是行数/个数（平均÷个数无业务含义）；题面要的是合计÷个数时交给只读 SQL 按题面公式算');
    }
  } catch (_) {}
  if (plan.cumulative) {
    if (!plan.grain) push(CODES.PLAN_INCOMPLETE, '累计需要时间粒度（day/week/month）分组');
    if (plan.comparison && plan.comparison.kind !== 'none') push(CODES.UNSUPPORTED_OPERATOR, '累计与对比期不能同时用');
  }
  if (plan.formula) {
    for(const k of ['num_period','den_period'])if(plan.formula[k]!=null&&!['same','previous_period','period_start','period_end'].includes(plan.formula[k]))push(CODES.INVALID_PERIOD,k+' 必须是已支持的相对期间，显式日期写入window');
    for (const k of ['num_window', 'den_window']) {
      const w = plan.formula[k];
      if (w && (!timeCore.isValidDate(String(w.start || '').slice(0, 10)) || !timeCore.isValidDate(String(w.end || '').slice(0, 10)))) push(CODES.INVALID_PERIOD, `${k} 不是合法日期区间`);
    }
    for (const k of ['num_filter', 'den_filter']) {
      const f = plan.formula[k];
      if (f && (!f.op || f.value == null)) push(CODES.PLAN_INCOMPLETE, `${k} 缺 op/value`);
      // 第三轮：条件聚合是「指标值满足阈值的行」，阈值必须是数；写成对象名（渠道、品类……）是把对象筛选塞错了地方
      else if (f && !Number.isFinite(Number(f.value))) push(CODES.IR_INVALID, `${k}.value 必须是数值阈值；按对象筛选不能写在 ${k} 里`);
      else if (f && !['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(String(f.op))) push(CODES.UNSUPPORTED_OPERATOR, `${k}.op 不支持：${f.op}`);
    }
    if (plan.formula.den_expr && (!Array.isArray(plan.formula.den_expr.args) || plan.formula.den_expr.args.length < 2)) push(CODES.PLAN_INCOMPLETE, 'den_expr 至少要两个指标');
  }

  // 权限范围：计划涉及的数据集必须在允许范围内
  const scope = plan.permission_scope || {};
  if (scope.datasets && scope.datasets.length) {
    const need = uniq(plan.metric_ids.flatMap(id => {
      try { return registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo); } catch (_) { return []; }
    }).filter(Boolean));
    const forbidden = need.filter(ds => !scope.datasets.includes(ds));
    if (forbidden.length) push(CODES.PERMISSION_DENIED, `计划要用到未授权数据集：${forbidden.join('、')}`, { datasets: forbidden });
  }
  if (!plan.metric_ids.length) push(CODES.PLAN_INCOMPLETE, '没有确定指标，不能执行');
  if (!plan.time || !plan.time.start) { /* 不带时间 = 全部数据，允许 */ }
  return { ok: errors.length === 0, errors, plan };
}

/* ---------------- 执行 ---------------- */
const round = (v, d) => v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10 ** d) / 10 ** d;
const fmtNum = (v, d) => v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });

function filterTablesByPeriod(tables, plan, registry){
  if (!plan.time || !plan.time.start) return { tables, applied: [], interval: INTERVAL_SCHEMA };
  const role = plan.time.role ? registry.timeRoles().find(r => r.id === plan.time.role) : null;
  if (!role) return { tables, applied: [], interval: INTERVAL_SCHEMA };
  const dim = registry.dim(role.dim);
  const field = dim.field || (dim.source && dim.source.field);
  const datasets = uniq(plan.metric_ids.flatMap(id => registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo)).filter(Boolean));
  // 半开区间 [start, endExclusive)：只在这里做一次日期比较；旧计划已在 normalizePlan 转过一次
  const start = plan.time.start, endExclusive = plan.time.endExclusive || (plan.time.end ? timeCore.addDays(plan.time.end, 1) : null);
  const applied = [];
  const out = Object.assign({}, tables);
  for (const ds of datasets) {
    const rows = tables[ds];
    if (!Array.isArray(rows)) continue;
    // 日期列：优先用计划选定的时间角色；否则找同表的时间桶/日期维度（timeBucket 的 source 就是日期列）
    let d = role && role.dataset === ds ? registry.dim(role.dim) : null;
    if (!d || !d.source || !d.source.field) {
      d = [...registry.semantic.dims.values()].find(x => x.source && x.source.table === ds &&
        (x.kind === 'timeBucket' || /日期|date|month|月份|时间/i.test(String(x.name) + ' ' + String(x.id) + ' ' + String(x.source.field))));
    }
    if (!d || !d.source || !d.source.field) continue;
    const f = d.source.field;
    out[ds] = rows.filter(r => { const v = String(r[f] || '').slice(0, 10); return v && v >= start && endExclusive != null && v < endExclusive; });
    applied.push({ dataset: ds, field: f, start, endExclusive, end: plan.time.end || (endExclusive ? timeCore.addDays(endExclusive, -1) : null),
      interval: INTERVAL_SCHEMA, matched: out[ds].length, total: rows.length });
  }
  return { tables: out, applied, interval: INTERVAL_SCHEMA };
}

function rankRows(rows, rank){
  const dir = rank.direction === 'asc' ? 1 : -1;
  const nulls = rank.nulls || 'last';
  // null 策略显式：默认排最后；并列边界全保留；非数值稳定按 label 次序，避免同值结果抖动
  const cmp = (a, b) => {
    const av = a.value, bv = b.value;
    if (av == null && bv == null) return String(a.label).localeCompare(String(b.label));
    if (av == null) return nulls === 'first' ? -1 : 1;
    if (bv == null) return nulls === 'first' ? 1 : -1;
    if (av === bv) return String(a.label).localeCompare(String(b.label));
    // 方向只在这里乘一次：desc → 大的在前，asc → 小的在前（旧实现多乘了一个 -1，desc 会排成升序）
    return dir * (av - bv);
  };
  const sorted = [...rows].sort(cmp);
  const filtered = nulls === 'drop' ? sorted.filter(r => r.value != null) : sorted;
  // ties=include：边界上的并列全保留（「前3」实际可能 4 条），不做任意截断
  const cut = filtered.length > rank.top ? filtered[rank.top - 1].value : null;
  const out = rank.ties === 'include' && cut != null ? filtered.filter((r, i) => i < rank.top || r.value === cut) : filtered.slice(0, rank.top);
  return { rows: out, ties_included: out.length - Math.min(rank.top, filtered.length) };
}

/**
 * 实体过滤：把「某维度 = 某值」落到基表行上。
 * 维度就在基表上 → 直接按值筛；维度在关联表上（如品类在 dim_sku、金额在 fact_sales）→
 * 复用 semantic 现有的关系路径 + 维度取值函数（_labelers）逐行取维度值再筛，不新写连接/检索服务。
 * 路径不存在或带扇出 → 明确报缺口（不静默按「全部」算，也不返回无数据的假空）。
 */
function scopeTablesByEntities(registry, tables, plan){
  const entities = plan.entities || [];
  if (!entities.length) return { tables, applied: [], errors: [] };
  const sem = registry.semantic;
  const datasets = uniq((plan.metric_ids || []).flatMap(id => {
    try { return registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo); } catch (_) { return []; }
  }).filter(Boolean));
  const out = Object.assign({}, tables);
  const applied = [], errors = [];
  let empty = false;
  for (const ds of datasets) {
    const rows = tables[ds];
    if (!Array.isArray(rows)) continue;
    let keep = rows;
    const grouped=new Map();for(const e of entities){const key=String(e.dim).replace(/^d:/,'');if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(String(e.value));}
    for (const [dim,values] of grouped) {
      const e={dim};const d = registry.dim(dim);
      if (!d || !d.source || !d.source.field) { errors.push({ code: CODES.UNKNOWN_DIM, message: `没有维度：${e.dim}` }); break; }
      let labeler = null;
      try { labeler = sem._labelers([String(d.id)], ds, tables)[0]; }
      catch (err) { errors.push({ code: err.code || CODES.MISSING_BINDING, message: err.message }); break; }
      const wants=values.map(String);
      const before = keep.length;
      keep = keep.filter(r => {
        let got;
        try { got = labeler(r); } catch (_) { got = null; }
        return got != null && wants.some(want=>String(got)===want||norm(String(got))===norm(want));
      });
      applied.push({ dataset: ds, dim: 'd:' + d.id, table: d.source.table, field: d.source.field, values: wants, matched: keep.length, before });
      if (!keep.length) empty = true;
    }
    if (errors.length) break;
    out[ds] = keep;
  }
  return { tables: out, applied, errors, empty };
}

/**
 * 执行一个已校验的计划。
 * @returns {{ok:boolean, errors?:Array, facts?:Array, rows?:Array, trace?:object, snapshot?:string}}
 */
function executePlan(plan, o = {}){
  const registry = o.registry;
  const v = validatePlan(plan, { registry });
  if (!v.ok) return { ok: false, errors: v.errors, plan_id: plan && plan.id };
  plan = v.plan;                                     // 规范化（含 plan-ir/1→2 的唯一转换）
  const m = registry.metric(plan.metric_ids[0]);
  const tables = o.tables || {};
  const { tables: filtered, applied } = filterTablesByPeriod(tables, plan, registry);
  const dims = [...plan.dimensions];
  // 粒度：把期间细分成时间桶时，用对应的 timeBucket 维度（没有就不硬造）
  if (plan.grain) {
    const leafSets = uniq(registry.leaves(m.id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo).filter(Boolean));
    const baseTable = leafSets.length === 1 ? leafSets[0] : null;
    const tb = [...registry.semantic.dims.values()].find(d => !d.unbound && d.kind === 'timeBucket' && d.grain === plan.grain && baseTable && d.source && d.source.table === baseTable);
    if (tb && !dims.includes('d:' + tb.id)) dims.push('d:' + tb.id);
  }
  // 实体过滤：先按「关联表里的维度值」把基表行筛出来，再计算；filters 只用于指纹/追踪，不重复作用一次。
  const ent = scopeTablesByEntities(registry, filtered, plan);
  if (ent.errors.length) return { ok: false, errors: ent.errors, plan_id: plan.id };
  const scoped = ent.tables;
  const filters = [];
  for (const e of plan.entities) {
    const d = registry.dim(e.dim);
    filters.push({ dim: e.dim, table: d.source && d.source.table, field: d.source.field, values: [String(e.value)] });
  }
  for (const f of (plan.filters || [])) filters.push(f);
  const planFilters = (plan.filters || []);

  let base, prev = null;
  let formulaMeta = null;
  // 显式基期（「相比 X，Y」里的 X）优先：不再按 kind 自动往前推
  const basePer = plan.comparison && plan.comparison.base && plan.comparison.base.start ? plan.comparison.base : null;
  try {
    const fx = computeFormula(registry, plan, m, dims, scoped, planFilters);
    if (fx) { base = { scalar: fx.scalar, rows: fx.rows }; formulaMeta = fx.meta; }
    else base = computeMetric(registry, m.id, dims, scoped, planFilters);
    if (plan.comparison && plan.comparison.kind !== 'none') {
      // 对比期由 time-core 按声明策略生成（同比/上一段/整月对齐），不在这里改年份字符串；
      // 题面点名的基期（相比 X）直接用 X。
      const shifted = basePer || shiftPeriod({ start: plan.time.start, endExclusive: plan.time.endExclusive, end: plan.time.end, timezone: plan.time.timezone, grain: plan.time.grain }, plan.comparison.kind);
      if (!shifted) {
        prev = { period: { label: '对比期不可用' }, scalar: null, rows: null, status: 'missing_comparison' };
      } else {
        const prevPlan = JSON.parse(JSON.stringify(plan));
        prevPlan.time.start = shifted.start; prevPlan.time.endExclusive = shifted.endExclusive; prevPlan.time.end = shifted.end;
        const pf = filterTablesByPeriod(tables, prevPlan, registry);
        const pent = scopeTablesByEntities(registry, pf.tables, plan);
        const pfx = computeFormula(registry, prevPlan, m, dims, pent.tables, planFilters);
        prev = { period: shifted, ...(pfx ? { scalar: pfx.scalar, rows: pfx.rows } : computeMetric(registry, m.id, dims, pent.tables, planFilters)) };
      }
    }
  } catch (err) {
    return { ok: false, errors: [{ code: err.code || 'execution_error', message: err.message }], plan_id: plan.id };
  }

  // 结果状态：查询成功但空数据 ≠ 0；零分母、缺对比期分别输出不同原因（§4.1）
  const metaDatasets = uniq(registry.leaves(m.id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo).filter(Boolean));
  const matchedRows = applied.length ? applied.reduce((a, x) => a + (x.matched || 0), 0) : metaDatasets.reduce((a, ds) => a + (Array.isArray(filtered[ds]) ? filtered[ds].length : 0), 0);
  let result_status = 'ok';
  let result_reason = null;
  if (ent.empty) { result_status = 'no_data'; result_reason = 'entity_filter_empty'; }
  if (m.kind === 'ratio' && !dims.length) {
    try {
      const a = registry.eval('m:' + m.num, dims, scoped), b = registry.eval('m:' + m.den, dims, scoped);
      if (a.scalar == null && b.scalar == null) { result_status = 'no_data'; result_reason = 'numerator_and_denominator_empty'; }
      else if (b.scalar === 0 && a.scalar != null) { result_status = 'zero_denominator'; result_reason = 'denominator_zero'; }
    } catch (_) {}
  }
  if (m.kind === 'ratio' && dims.length && base.rows && base.rows.every(r => r.value == null)) { result_status = 'no_data'; result_reason = 'all_groups_null'; }
  if (result_status === 'ok' && base.scalar == null && !base.rows && matchedRows === 0) { result_status = 'no_data'; result_reason = 'no_rows_in_scope'; }
  if (result_status === 'ok' && plan.comparison && plan.comparison.kind !== 'none' && prev && prev.scalar == null) { result_status = 'missing_comparison'; result_reason = 'previous_period_empty'; }

  // 事实：类型化 value/unit/维度键/期间/过滤指纹/计划标识/版本；派生事实指父事实与公式
  const book = o.facts || new FactBook();
  const facts = [];
  const filter_fp = 'fp:' + crypto.createHash('sha256').update(JSON.stringify({ entities: plan.entities, filters, negations: plan.negations, interval: [plan.time.start, plan.time.endExclusive], role: plan.time.role })).digest('hex').slice(0, 16);
  const addFact = (label, value, unit, extra = {}) => {
    const d = m.decimals == null ? 2 : m.decimals;
    const v = round(value, d);
    const display = v == null ? '—' : `${fmtNum(v, d)}${unit || ''}`;
    // 来源只写真实存在的表/字段；派生指标（多表/公式）不捏造单一来源
    const dataset = m.dataset || m.boundTo || null, field = m.field || null;
    const source = dataset && field ? { table: dataset, field, stamp: registry.stamp() } : null;
    const derived = !!(extra.formula && extra.parents && extra.parents.length);
    const spec = {
      schema_version: 'fb/2', kind: extra.kind || 'metric',
      label, value: v, unit: unit || '', display,
      status: v == null ? (result_status === 'no_data' ? 'empty' : 'no_data') : 'ok',
      dims: extra.dims || null,
      period: plan.time && plan.time.start ? { start: plan.time.start, endExclusive: plan.time.endExclusive, interval: INTERVAL_SCHEMA, timezone: plan.time.timezone || TIMEZONE_DEFAULT } : null,
      filter_fp, plan_id: plan.id || null, qid: plan.qid || null,
      formula: derived ? extra.formula : null,
      parents: derived ? extra.parents : null,
      source,
      data_version: o.dataStamp || plan.data_stamp || null, semantic_version: registry.stamp(), permission_version: (plan.permission_scope && plan.permission_scope.permission_version) || null,
    };
    let id;
    if (typeof book.addTyped === 'function') {
      try { id = book.addTyped(spec); }
      catch (err) {
        // 结构不满足证据标准时退回旧编号，但不把失败伪装成成功：记在备注里
        (o.noteFactError || (() => {}))(err, spec);
        id = book.add(label, display);
      }
    } else id = book.add(label, display);
    facts.push(Object.assign({ id }, spec));
    return id;
  };
  const rows = [];
  if (base.rows) {
    for (const r of base.rows) {
      const label = r.label.filter(x => x !== null && x !== undefined).join(' · ') || '（空）';
      rows.push({ label, value: round(r.value, m.decimals == null ? 2 : m.decimals), fact: addFact(`${m.name} · ${label}`, r.value, plan.unit, { dims: r.label.filter(x => x !== null && x !== undefined) }) });
    }
    if (plan.rank) {
      const rk = rankRows(rows, plan.rank);
      rows.length = 0; rows.push(...rk.rows);
      facts.length = 0;
      for (const r of rows) r.fact = addFact(`${m.name} · ${r.label}`, r.value, plan.unit);
      if (rk.ties_included > 0) base.tie_note = `边界并列，实际返回 ${rows.length} 条（要求前 ${plan.rank.top}）`;
    }
  } else {
    addFact(`${m.name}${plan.time && plan.time.label ? ' · ' + plan.time.label : ''}`, base.scalar, plan.unit);
  }
  let growth = null, comparison = null;
  if (prev && plan.comparison && plan.comparison.output === 'growth_rate') {
    const pv = prev.scalar != null ? prev.scalar : null;
    const cur = base.scalar != null ? base.scalar : null;
    growth = cur == null || pv == null || pv === 0 ? null : round(((cur - pv) / Math.abs(pv)) * 100, m.decimals == null ? 2 : m.decimals);
    const curFact = facts.find(f => f.kind === 'metric') || facts[0];
    const prevFact0 = addFact(`${m.name} · ${prev.period.label}`, pv, plan.unit, { kind: 'parent_period' });
    facts.length = 0;
    const growthUnit = plan.unit === '%' ? 'pp' : '%';
    const gid = addFact(`${m.name} · 增长率`, growth, growthUnit, { kind: 'derived', formula: '(本期−上期)/|上期|×100', parents: [curFact && curFact.id, prevFact0].filter(Boolean) });
    comparison = { kind: plan.comparison.kind, period: prev.period, value: round(pv, m.decimals), delta: round(cur != null && pv != null ? cur - pv : null, m.decimals), fact: prevFact0,
      status: growth == null ? 'missing_comparison' : 'ok', growth, growth_fact: gid, growth_unit: growthUnit, output: 'growth_rate', policy: plan.comparison.policy || null };
  }
  if (prev && !(plan.comparison && plan.comparison.output === 'growth_rate')) {
    const pv = prev.scalar != null ? prev.scalar : null;
    const cur = base.scalar != null ? base.scalar : null;
    const delta = cur != null && pv != null ? cur - pv : null;
    const prevFact = addFact(`${m.name} · ${prev.period.label}`, pv, plan.unit, { kind: 'parent_period' });
    comparison = {
      kind: plan.comparison.kind, period: prev.period, value: round(pv, m.decimals), delta: round(delta, m.decimals), fact: prevFact,
      status: pv == null ? 'missing_comparison' : (delta == null ? 'no_data' : 'ok'),
      // 同比/环比：百分比指标的变化用百分点（pp），普通金额用 %
      delta_unit: plan.unit === '%' ? 'pp' : '%',
      delta_ratio: pv != null && pv !== 0 && delta != null ? round(delta / Math.abs(pv) * 100, 2) : null,
      policy: plan.comparison.policy || (prev.period && prev.period.policy) || null,
    };
  }
  if (o.book) { try { book.save(); } catch (_) {} }

  return {
    ok: true, plan_id: plan.id, metric: { id: 'm:' + m.id, name: m.name, unit: plan.unit },
    facts, rows, comparison, result_status, result_reason, formula_meta: formulaMeta,
    trace: {
      executor: 'local_semantic_eval', schema: PLAN_SCHEMA, interval: INTERVAL_SCHEMA,
      metric: 'm:' + m.id, dims, filters: filters.length,
      time_role: plan.time.role, time_applied: applied, time_semantics: 'per_dataset_half_open',
      time_policy: plan.time.policy || null, comparison_policy: comparison && comparison.policy || null,
      snapshot: registry.stamp(), rows_scanned: Object.values(filtered).reduce((a, r) => a + (Array.isArray(r) ? r.length : 0), 0),
      matched_rows: matchedRows, result_status, result_reason,
      tie_note: base.tie_note || null,
    },
  };
}

/* 公式执行（公共计算路径）：ratio = 分子/分母；share = 分组值/总体值（分母去掉分组过滤）；都先聚合后相除 */
function computeFormula(registry, plan, m, dims, tables, filters){
  const f = plan.formula || {};
  const mul = f.mul == null ? 100 : f.mul;
  const evalMetric = (id, dimIds) => registry.eval('m:' + String(id).replace(/^m:/, ''), dimIds, tables);
  if (f.kind === 'ratio') {
    const A = evalMetric(f.num, dims);
    // 比率默认分母跟随分组（按店铺的退货率 = 店铺内退货/店铺内GMV）；
    // 只有把分组过滤显式去掉（share）才用总体做分母。
    const keepGroup = f.scope !== 'remove_group_filter_keep_user_filter' && f.scope !== 'total';
    const B = evalMetric(f.den, keepGroup ? dims : []);
    const asMap = r => { const map = new Map(); for (const x of (r.rows || [])) map.set(labelKey(x.label), x.value); return map; };
    if (!dims.length) {
      const a = A.scalar, b = B.scalar;
      const v = a == null || b == null || b === 0 ? null : (a / b) * mul;
      return { scalar: v, rows: null, meta: { kind: 'ratio', num: f.num, den: f.den, mul, scope: f.scope || 'remove_group_filter_keep_user_filter', denominator_scalar: b, numerator_scalar: a } };
    }
    const am = asMap(A), bm = asMap(B);
    const numId = String(f.num).replace(/^m:/, '');
    let numMetric = null;
    try { numMetric = registry.metric(numId); } catch (_) {}
    // 分子是 sum/count 这类可加聚合时，某个分组没有行 = 0 笔，不是「无法计算」
    const zeroWhenMissing = !!(numMetric && (numMetric.kind === 'simple' || numMetric.kind === 'count') && ['sum', 'count', 'dcount'].includes(numMetric.agg));
    const labels = new Map();
    for (const x of (A.rows || [])) labels.set(labelKey(x.label), x.label);
    for (const x of (B.rows || [])) if (!labels.has(labelKey(x.label))) labels.set(labelKey(x.label), x.label);
    const rows = [];
    for (const [k, label] of labels) {
      const b = keepGroup ? bm.get(k) : B.scalar;
      let a = am.has(k) ? am.get(k) : null;
      if (a == null && zeroWhenMissing) a = 0;
      rows.push({ label, value: a == null || b == null || b === 0 ? null : (a / b) * mul });
    }
    rows.sort((x, y) => labelKey(x.label).localeCompare(labelKey(y.label)));
    return { scalar: null, rows: rows.length ? rows : null, meta: { kind: 'ratio', num: f.num, den: f.den, mul, scope: f.scope || 'keep_group_filter', denominator_scope: keepGroup ? 'group' : 'total' } };
  }
  if (f.kind === 'share') {
    const baseId = (f.base || m.id);
    const A = evalMetric(baseId, dims);
    const Total = evalMetric(baseId, []);
    if (!dims.length) {
      const v = A.scalar == null || Total.scalar == null || Total.scalar === 0 ? null : (A.scalar / Total.scalar) * mul;
      return { scalar: v, rows: null, meta: { kind: 'share', base: baseId, mul, denominator_scalar: Total.scalar } };
    }
    const total = Total.scalar;
    const rows = (A.rows || []).map(x => ({ label: x.label, value: x.value == null || total == null || total === 0 ? null : (x.value / total) * mul }));
    return { scalar: null, rows: rows.length ? rows : null, meta: { kind: 'share', base: baseId, mul, denominator_scope: 'total' } };
  }
  return null;
}
const labelKey = l => (Array.isArray(l) ? l.filter(x => x != null && x !== '').join('\u0001') : String(l == null ? '' : l));

function computeMetric(registry, metricRaw, dims, tables, filters){
  let t = tables;
  if (filters && filters.length) {
    t = Object.assign({}, tables);
    const m = registry.metric(metricRaw);
    const base = m.dataset || m.boundTo;
    for (const f of filters) {
      const rows = t[base];
      if (!Array.isArray(rows)) continue;
      t[base] = rows.filter(r => f.values.includes(String(r[f.field])));
    }
  }
  const r = registry.eval('m:' + metricRaw, dims, t);
  return { scalar: r.scalar, rows: r.rows && r.rows.length ? r.rows.map(x => ({ label: x.label, value: x.value })) : null, records: r.records };
}


/* ---------------- 约束信号 / IR 通道（一次短结构化调用） ---------------- */
const GRAIN_WORDS = [
  [/每(?:一|个)?季|按季|逐季|各(?:个)?季|[一二三四\d]+个季度|Q[1-4]\s*[~～至到-]\s*Q[1-4]/i,'quarter'],
  [/每(?:一|个)?年|按年|逐年|各年/, 'year'],
  [/每月|按月|逐月|月度/, 'month'], [/每周|按周|逐周|周度/, 'week'], [/每天|按天|逐日|日度/, 'day'],
];
function rankTopOf(s){
  const top = /(?:前|top\s?)(\d{1,2})/i.exec(s) || /(?:前)([一二两三四五六七八九十])\s*(?:的\s*)?(?:名|个|家|条|款|位|种|类|年|月|SKU|货号|商品|产品|渠道|供应商|客户)/i.exec(s)
    || /(?:最高|最低|最多|最少|最大|最小)的?\s*([一二两三四五六七八九十]|\d{1,2})\s*(?:名|个|家|条|款|位|种|类|年|月)/.exec(s);
  if (!top) return null;
  const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return Math.max(1, Math.min(Number(top[1]) || CN[top[1]] || 1, 100));
}
function rankOf(s){
  const top = rankTopOf(s);
  if (top != null) {
    return { top, direction: /最低|最少|最小|最差|倒数/.test(s) ? 'asc' : 'desc', ties: 'include', nulls: 'last' };
  }
  if (/最高|最低|最多|最少|最大|最小|最好|最差|排名|排行|哪个|哪些/.test(s)) return { top: 1, direction: /最低|最少|最小|最差|倒数/.test(s) ? 'asc' : 'desc', ties: 'include', nulls: 'last' };
  return null;
}
function comparisonOf(s){
  if (/同比|去年同期|去年同月|去年同季度|去年同季/.test(s)) return 'year_over_year';
  if (/环比|上一段|比上|跟.{0,6}比|增长|下滑|下降|上升|相比|对比/.test(s)) return 'previous_period';
  return 'none';
}
function withoutDateFormatReading(text){return String(text==null?'':text).replace(/按\s*(?:月\s*[/／-]\s*日\s*[/／-]\s*年|日\s*[/／-]\s*月\s*[/／-]\s*年|年\s*[/／-]\s*月\s*[/／-]\s*日)\s*(?:来)?(?:读取|解析|读)/g,' ');}
function extractSignals(text, o = {}){
  const registry = o.registry || null;
  const raw = String(text == null ? '' : text);
  const s = norm(withoutDateFormatReading(raw));
  const out = { text: raw, metricCandidates: [], metricKey: null, dimensions: [], ambiguousDims: null, entities: [], negations: [], period: null, namedTimeRole: null, comparisonKind: 'none', grain: null, rank: null };
  if (registry) {
    try { const mc = metricCandidates(registry, raw); out.metricCandidates = mc.candidates; out.metricKey = mc.key; if(mc.unitEvidence)out.metricUnitEvidence=mc.unitEvidence; } catch (_) {}
    try {
      // 时间口径短语（如「退款时间」）不是分组维度：先从分组文本里剔掉
      const roleMatch = ROLE_WORDS.map(r => r.re.exec(raw)).find(Boolean);
      const dimText = roleMatch ? raw.replace(roleMatch[0], ' ') : raw;
      const dc = dimCandidates(registry, dimText);
      if (Array.isArray(dc)) out.dimensions = dc;
      else { out.ambiguousDims = dc.ambiguous; }
    } catch (_) {}
    try {
      // 「相比 X，Y」里信号要跟计划一样认 Y 为本期：否则整句第一个时间短语（基期）会被当成本期
      const cb = comparisonBaseOf(raw, { anchor: o.anchor, timezone: o.timezone });
      out.period = cb.current || parsePeriod(raw, o.anchor, { timezone: o.timezone });
      if (cb.base) out.comparisonBase = cb.base;
      if (cb.baseKind) out.comparisonBaseKind = cb.baseKind;
    }
    catch (err) { out.period = null; out.periodError = { code: err.code || CODES.INVALID_PERIOD, message: err.message }; }
    out.periodMissing = !out.period && /(\d{4}\s*[-年\/]\s*\d{1,2}|\d{1,2}\s*月|最近\s*\d{1,3}\s*天|近\s*\d{1,3}\s*天|本月|这个月|上月|上个月|本周|上周|今年|去年|季度|Q[1-4])/i.test(raw);
    const named = ROLE_WORDS.find(r => r.re.test(s));
    out.namedTimeRole = named ? named.name : null;
    if (o.entityLookup) {
      // 候选排序可以截断，但“这些成员分别”不能只留下最长的一个；仅在本机保留题面原词的完整枚举。
      if(/、/.test(raw)&&/各|分别/.test(raw)&&o.entityLookup.index instanceof Map){
        out.literalGroups=[];
        for(const [dim,index]of o.entityLookup.index){
          let declared;try{declared=registry.dim(dim);}catch(_){continue;}if(!declared||declared.unbound||o.entityLookup.isTemporal?.(dim))continue;
          const values=[...index.values()].map(x=>String(x.value)).filter(v=>v.length>=2&&raw.toLowerCase().includes(v.toLowerCase()));
          if(values.length>=2)out.literalGroups.push({dim,values});
        }
      }
      try {
        const r = o.entityLookup.resolve(raw, { dimIds: out.dimensions.length ? out.dimensions.map(d => String(d).slice(2)) : undefined });
        if (r.status === 'matched') out.entities = [{ dim: 'd:' + r.dim, value: r.value }];
        else if (r.status === 'ambiguous') {
          // 只有“像真对象”的歧义才算约束（精确/包含命中）；纯编辑距离模糊命中当噪声，不阻断零调用
          const real = (r.candidates || []).filter(c => (c.options || []).some(o => o.how && o.how !== 'fuzzy'));
          if (real.length) out.ambiguousEntities = real.slice(0, 6);
        }
      } catch (_) {}
    }
  }
  const neg = /(?:排除|不含|不包括|除了|剔除)([^，,。；;？?]{1,20})/g;
  for (let m; (m = neg.exec(raw));) out.negations.push({ text: m[1].trim() });
  out.comparisonKind = comparisonOf(s);
  out.comparisonOutput = out.comparisonKind !== 'none' && /增长|下降|上涨|下滑|增加|减少|变化/.test(s) && /(%|％|百分|百分点|增长率)/.test(s) ? 'growth_rate' : 'delta';
  for (const [re, g] of GRAIN_WORDS) if (re.test(s)) { out.grain = g; break; }
  out.rank = rankOf(s);
  return out;
}

/* ---------------- 条件词 → 计划节点：没有落实就禁止零调用（第 4 组） ---------------- */
// 根因（本轮 r4 错题）：零调用快路只看「有没有 unresolved / 覆盖是否齐」，但覆盖率信号本身也只认
// 它自己那几类条件，于是「占比 / 退货 / 前N / 哪一天 / 平均每 / SKU / 品类 / 相比的基期 / 合计」
// 这些条件词在题面里出现、计划里却没有对应节点时，快路仍然零调用并给出一个看着合理的宽泛答案。
// 这里把条件词逐类对到计划节点上：任一条没对上就返回缺口，调用方据此改走那一次模型调用。
const CONDITION_SLOTS = ['share', 'return', 'rank', 'day', 'avg_per', 'sku', 'category', 'comparison_base', 'sum'];

function dayBucketOf(registry, metricIds){
  const datasets = uniq((metricIds || []).flatMap(id => {
    try { return registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo); } catch (_) { return []; }
  }).filter(Boolean));
  try {
    for (const d of registry.semantic.dims.values()) {
      if (d.unbound || d.kind !== 'timeBucket' || d.grain !== 'day') continue;
      if (!d.source || !d.source.table) continue;
      if (!datasets.length || datasets.includes(d.source.table)) return d;
    }
  } catch (_) {}
  return null;
}

/**
 * 题面里出现了条件词、但没有落到计划节点 → 返回缺口清单（空数组 = 全部落实）。
 * 只判断「有没有节点」，不替用户选口径；调用方拿它决定是否允许零调用 / 是否要求模型补。
 * @param {string} question
 * @param {object} plan 已解析的计划（parsePlan 或 irToPlan 的结果）
 * @param {{registry}} o
 * @returns {Array<{slot:string, word:string, message:string}>}
 */
function unmappedConditions(question, plan, o = {}){
  const registry = o.registry;
  const raw = String(question == null ? '' : question);
  const s = norm(withoutDateFormatReading(raw));
  const p = plan || {};
  const metricIds = p.metric_ids || [];
  const dims = p.dimensions || [];
  const entities = p.entities || [];
  const formula = p.formula || null;
  const comparison = p.comparison || { kind: 'none' };
  const out = [];
  const push = (slot, word, message, extra) => { if (!out.some(x => x.slot === slot)) out.push(Object.assign({ slot, word, message }, extra || {})); };
  const metricObj = id => { try { return registry.metric(id); } catch (_) { return null; } };
  // 10-23：用户在公式块里确认 / 改过的口径说明（confirmed + user_formula）也算这个指标的口径（如「含退货冲减」）
  const metricText = metricIds.map(id => { const m = metricObj(id); return m ? [m.id, m.name, ...(m.aliases || []), m.confirmed && m.user_formula ? String(m.user_formula) : ''].join(' ') : String(id); }).join(' ');
  const leafText = metricIds.flatMap(id => { try { return registry.leaves(id).map(l => { const m = metricObj(l); return m ? m.id + ' ' + m.name : l; }); } catch (_) { return []; } }).join(' ');
  const allMetricText = (metricText + ' ' + leafText).toLowerCase();
  const dimText = id => { try { const d = registry.dim(id); return [d.id, d.name, ...(d.match || []), ...(d.aliases || [])].join(' '); } catch (_) { return String(id); } };
  const isCategoryDim = id => /品类|类目|分类|category|l1|l2|l3/i.test(dimText(id));
  const isSkuDim = id => /sku|货号|款号/i.test(dimText(id));

  const sourceChecks=require('./sql-constraints');
  if(sourceChecks.rowCountShareQuestion(raw)&&['ratio','share'].includes(formula?.kind)){
    const measures=(formula.kind==='ratio'?[formula.num,formula.den]:[formula.base]).map(metricObj).filter(Boolean);
    if(measures.some(m=>m.kind==='simple'&&(m.agg!=='count'||m.field)))push('row_count_share','行数占比','row_count_share_measure: 行数占比的分子分母须为行计数；条件字段只作num_filter筛行，不能把金额或件数当作行数');
  }
  if(sourceChecks.automaticSummarySourceGaps(raw,registry,metricIds).length)
    push('metric_source','指标来源','metric_source_not_equivalent: 未确认的同名自动汇总不能替代明细口径；按原题选择已登记明细指标，用户明确点名或确认汇总来源时保留');
  const role=registry?.timeRoles?.().find(r=>r.id===p.time?.role);
  if(sourceChecks.monthKeySourceGaps(p.time,registry,role?[role.dataset]:[]).length)
    push('period_granularity','日级期间','period_granularity: 所选月份键不能按日边界裁出部分月；保留用户期间并核对真实日期来源，不能把整月当日级明细');

  // 1) 占比 / 份额：必须有占比（share）节点
  if (/占比|份额|比重|占.{0,14}?比例|构成比|占.{0,16}?的\s*(?:多少|几)\s*[%％]|占.{0,16}?百分之?/.test(s)) {
    const ok = !!(formula && (formula.kind === 'share'
      || (formula.kind === 'ratio' && (/占比|份额|比重|share/.test(allMetricText) || formula.num_filter || formula.num_window || formula.den_expr
        // 第三轮：「X 占 Y 的多少%」= 两个不同指标相除，本身就是占比口径（如 退款金额 ÷ 净销售额）
        || (formula.num && formula.den && String(formula.num).replace(/^m:/, '') !== String(formula.den).replace(/^m:/, ''))))));
    if (!ok) push('share', '占比', '话里要的是占比/份额，计划没有占比（share）节点');
  }
  // 2) 退货 / 退款：指标必须是退货口径（含比率指标的分子/分母叶子）
  if (/退货|退款/.test(s.replace(/不扣(?:除)?(?:退货|退款|退)/g,''))) {
    const conditionText=sourceChecks.rowCountShareQuestion(raw)?[formula?.num_filter?.metric,formula?.den_filter?.metric].filter(Boolean).map(id=>{const m=metricObj(id);return m?[m.name,m.field,...m.aliases||[]].join(' '):'';}).join(' '):'';
    if (!/退货|退款|refund|return/.test(allMetricText+' '+conditionText)) push('return', '退货', '话里点了退货/退款口径，计划里的指标或条件不是退货口径');
  }
  // 3) 前N / 最高 / 排名：要有 rank 节点，且 N 要和话里一致
  if (/(?:前|top)\s*\d{1,2}|最高|最低|最多|最少|最差|排名|排行|倒数|哪几个|哪些/i.test(s)) {
    const want = rankTopOf(s);
    const rk = p.rank;
    if (!rk) push('rank', '排名', '话里要排名/前N/最高，计划没有 rank 节点');
    else if (want != null && rk.top !== want) push('rank', '前N', `话里要前 ${want} 名，计划 rank.top=${rk.top}`);
  }
  // 合法IR节点仍须落实当前排名；按全部分组再次分区会把每区缩成一行。
  if (rankTopOf(s) != null && p.rank && !p.grain && dims.length && (p.rank.partition_by || []).length) {
    const parts = new Set(p.rank.partition_by.map(id => String(id).replace(/^d:/, '')));
    if (dims.every(id => parts.has(String(id).replace(/^d:/, ''))))
      push('rank_partition', '组内排名', 'rank_partition_all_groups: partition_by覆盖全部输出分组，每个分区只有一行，不能完成当前前N要求；全局排名省略partition_by，真实组内排名补全题面要求的对象或时间分组');
  }
  // 3b) 第三轮防答错：「第 N 名 / 第二高 / 第四到第六」——现在的排名节点只会取前 N 名，表达不了「恰好第 N 名」，
  //     不能拿第一名或前 N 名的数冒充（盲测里这类题给出过错数）。N=1 等于前 1 名，不拦。
  const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const nth = /第\s*([0-9]{1,2}|[一二两三四五六七八九十])\s*(?:名|高|低|大|小|多|少|位)|排(?:名|在)?第\s*([0-9]{1,2}|[一二两三四五六七八九十])|第\s*([0-9]{1,2}|[一二两三四五六七八九十])\s*(?:到|至|-|~)\s*第/.exec(s);
  if (nth) {
    const t = nth[1] || nth[2] || nth[3];
    const n = /^\d+$/.test(t) ? Number(t) : CN_NUM[t];
    if (n && n > 1) push('rank_nth', '第' + t, `话里要的是「第 ${n} 名」这一位（或第几到第几），现在的排名只能取前 N 名，表达不了`, { unrepresentable: true });
  }
  {
    // 第三轮：「第一与第十」「第二和第五」：并列点了两个名次，同样是「恰好第 N 名」
    const pair = /第\s*([0-9]{1,2}|[一二两三四五六七八九十])\s*(?:名|高|低)?\s*(?:与|和|跟|、|及)\s*第\s*([0-9]{1,2}|[一二两三四五六七八九十])/.exec(s);
    if (pair) {
      const ns = [pair[1], pair[2]].map(t => /^\d+$/.test(t) ? Number(t) : CN_NUM[t]);
      if (ns.some(n => n && n > 1)) push('rank_nth', '第' + pair[1] + '与第' + pair[2], '话里要的是两个指定名次（如第一与第十），现在的排名只能取前 N 名，表达不了', { unrepresentable: true });
    }
  }
  // 第三轮：按星期几 / 工作日 / 周末——配置单没有这个节点，表达不了（交给兜底）
  if (/星期[一二三四五六日天几]|周[一二三四五六](?![期度年内])|周日(?!均)|周几|工作日|周末|双休/.test(s)) {
    push('weekday', '星期几', '话里要按星期几 / 工作日 / 周末区分，配置单没有这个节点，表达不了', { unrepresentable: true });
  }
  // 4) 哪一天 / 单日：要有按天粒度，而且这份数据里真的能按天分桶
  if (/哪一天|哪天|单日|逐日/.test(s)) {
    let bucket = registry ? dayBucketOf(registry, metricIds) : null;
    // 第三轮：语义包没声明「按天」时间桶时，执行器会从日期列派生（registry.grainDim）；能派生就算有
    if (!bucket && registry && p.grain === 'day') {
      try {
        const ds = uniq(metricIds.flatMap(id => registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo)).filter(Boolean));
        if (ds.length === 1 && registry.grainDim('day', ds[0])) bucket = { derived: true };
      } catch (_) {}
    }
    if (!(p.grain === 'day' && bucket)) push('day', '哪一天', '话里要「哪一天/单日」，计划没有落到按天分桶（或这份数据没有按天时间桶）');
    if (/最多|最高|最大/.test(s) && !p.rank) push('rank', '哪一天卖得最多', '话里要「哪一天卖得最多」，计划没有排名节点');
  }
  // 5) 平均每 X：必须落到比率（num/den）节点
  if (/平均每(?:个|家|件|条|单|天|人)?|平均单(?:个|件|条|人)|人均|每(?:个|家|件|条)平均/.test(s)) {
    if (!(formula && formula.kind === 'ratio')) push('avg_per', '平均每', '话里要「平均每个/每单」，计划没有比率（ratio）节点（不能拿合计当平均）');
  }
  // 6) SKU：点到具体 SKU 编码必须有 SKU 实体；按 SKU 排名/分组/哪几个要有 SKU 维度。
  //    「平均每 SKU」「每个 SKU 贡献」里的 SKU 是分母口径，不是筛选/分组对象，不在这里卡。
  const skuCode = /(?:SKU|sku|款号|货号)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_-]{2,})/.exec(raw);
  const skuAsObject = /SKU|sku|款号|货号/.test(raw) && /(?:哪个|哪些|哪几|各|按|分)\s*(?:SKU|sku)|每(?:个|件)?\s*(?:SKU|sku)|(?:最高|最低|排名|排行|前\s*\d+|top\s*\d+).{0,10}(?:SKU|sku)|(?:SKU|sku).{0,10}(?:最高|最低|排名|排行|哪几)/i.test(raw);
  if (skuCode || skuAsObject) {
    const skuEntities = entities.filter(e => e && e.dim && isSkuDim(e.dim));
    // 第三轮：「有多少个 SKU / 平均每个 SKU」——计划用的是按 SKU 去重计数的指标（分子或分母），SKU 已经落实
    const countsSku = [...metricIds, formula && formula.num, formula && formula.den].filter(Boolean).some(id => {
      try { const m = registry.metric('m:' + String(id).replace(/^m:/, '')); return m && m.kind === 'simple' && m.agg === 'dcount' && /sku|货号|款号/i.test(String(m.field || '') + ' ' + String(m.name || '')); } catch (_) { return false; }
    });
    const ok = skuCode
      ? skuEntities.some(e => String(e.value).toUpperCase() === skuCode[1].toUpperCase())
      : (skuEntities.length > 0 || dims.some(isSkuDim) || countsSku);
    if (!ok) push('sku', skuCode ? 'SKU ' + skuCode[1] : 'SKU', '话里点了 SKU（筛选/分组/排名），计划没有落到 SKU 值或维度（不能按「全部」算）');
  }
  // 7) 品类：要有品类维度，或落到品类的分组值
  if (/品类|类目|一级分类|二级分类|三级分类/.test(s)) {
    const ok = dims.some(isCategoryDim) || entities.some(e => e && e.dim && isCategoryDim(e.dim)) || /品类|类目|分类/.test(allMetricText);
    if (!ok) push('category', '品类', '话里限定了品类，计划里没有品类维度/分组值');
  }
  // 8) 相比 X：显式基期要落到 comparison.base；相对基期（去年同季度）要有对比节点
  const cb = comparisonBaseOf(raw, { anchor: o.anchor, timezone: o.timezone });
  if (/相比|对比/.test(s)) {
    const hasBase = !!(comparison && comparison.base && comparison.base.start);
    // 计划没写显式基期时，允许对比策略自己推出来的基期和「X」一致（IR 通道表达不了显式基期）
    const cur = p.time && p.time.start ? p.time : null;
    let derived = null;
    if (!hasBase && cur && comparison && comparison.kind !== 'none') {
      try { derived = shiftPeriod({ start: cur.start, endExclusive: cur.endExclusive, end: cur.end, timezone: cur.timezone, grain: cur.grain }, comparison.kind); } catch (_) { derived = null; }
    }
    const baseOk = hasBase || !!(cb && cb.base && derived && String(derived.start).slice(0, 10) === String(cb.base.start).slice(0, 10));
    if (cb && cb.base && cb.baseKind === 'explicit' && !baseOk) push('comparison_base', '相比X的基期', '话里「相比 X，Y」的基期没有落到计划（不能拿 X 当本期）');
    else if (!cb.base && !(comparison && comparison.kind !== 'none')) push('comparison_base', '相比', '话里要对比，计划没有对比节点');
  }
  // 9) 加起来 / 合计 / 一共：要落到可加的聚合节点（合计不能落到比率或分组行）。
  //    括号里常是校验说明（「（合计应为 100）」），不是用户要的合计，先去掉再判。
  const outer = norm(raw.replace(/[（(][^）)]*[）)]/g, ' '));
  if (/加起来|合计|一共|总共|总计|总和|累计|加总/.test(outer)) {
    // 「合计」= 跨组算总量：可加聚合（simple/derived），或比率/占比在整段期间上先聚合再相除（无分组维度）
    const additive = !!(formula && (formula.kind === 'simple' || formula.kind === 'derived'));
    const aggregateOverAll = !!(formula && (formula.kind === 'ratio' || formula.kind === 'share') && !dims.length && !p.grain);
    if (!additive && !aggregateOverAll) push('sum', '合计', '话里要「加起来/合计」，计划没有落到可加的聚合节点');
  }
  return out;
}

/* ---------------- 10-24 结构核对：题面要的结构，计划里漏了就不许给数 ----------------
 * 根子（第四轮新盲测答错 27 题里 18 题）：题面要「按月列」「比去年同期多多少」「占比」「日均」「去重计数」「点名的对象」，
 * 计划里没有对应结构，本机检查没拦住，直接给了一个合计数。这里把题面说法对到计划结构上，缺了返回缺口 {slot, word, message}。
 * 原则：只在很确定时才拦（说法表写具体；「各」「每」单独出现不算；「月度目标」「每件」不算）；
 * unrepresentable:true = 现在的计划结构表达不了（分段 / 上中下旬 / 日均），不用修配置单，直接交兜底。 */
const STRUCT_CMP_RE = /同比|环比|比去年|比上年|比上个?月|比上期|比上周|比上季|比前一[期个]|较去年|较上年|较上个?月|较上期|相比去年|相比上[个]?[月年期周季]|[与和跟]去年同期(?:相比|比较|对比|比|差)|比同期|后减前|前减后|两期[^，。；]{0,8}(?:差|相差|变化|增减)|(?:增长|增加|减少|下降|降低|变化)了多少|增长额|增加额|增长量/;
const STRUCT_MONTH_RE = /每个月|各个月|各月|每月|按月|逐月|哪个月|哪几个月|哪些月|各个月份|每个月份|按月份|月度(?!目标|计划|预算|指标|考核|kpi|完成|任务)[^，。；]{0,6}(?:列|各|明细|趋势|走势|分布)|(?:\d{1,2}月?[、，,和及与]){1,}\d{1,2}月?[^，。；]{0,4}(?:三|两|四|五|六)?个?月?各|[二两三四五六七八九十]个月各/;
const STRUCT_DAY_RE = /每天|每日|每一天|逐日|按天|按日(?!期)|各天|哪一天|哪天(?!猫)|哪日/;
const STRUCT_WEEK_RE = /每周|每个?星期(?!几)|各周|按周|逐周|哪一周|哪周|哪个星期(?!几)/;
const STRUCT_QUARTER_RE = /各季度|每个?季度|按季度|分季度|逐季|哪个季度|哪季度|哪几个季度/;
const STRUCT_SNAP_RE = /[二两三四五六七八九十\d]期[^，。；]{0,4}(?:快照|库存|数据)?[^，。；]{0,4}各|每期[^，。；]{0,4}快照|各期[^，。；]{0,4}快照|快照[^，。；]{0,6}各是多少/;
const STRUCT_HALF_RE = /上半年[^，。；]{0,6}(?:和|与|跟|及|、)[^，。；]{0,2}下半年[^，。；]{0,8}(?:各|分别)|上下半年(?:各|分别)|(?:各|分别)[^，。；]{0,6}上半年[^，。；]{0,3}下半年/;
const STRUCT_XUN_RE = /上中下旬|上旬[^，。；]{0,6}中旬[^，。；]{0,6}下旬/;
const STRUCT_AVGDAY_RE = /日均|平均每天|平均一天|每天平均|平均每日|天均|平均到每天|平均每个?自然日/;
const STRUCT_SHARE_RE = /占(?!用)[^，。；]{0,16}?(?:多少|几)[%％成]?|占.{0,8}几成|占.{0,8}百分之|百分之几|多大比例|多少比例|什么比例|贡献.{0,10}(?:比例|占比|几成|百分)|(?:比例|占比)是多少/;
const STRUCT_DCOUNT_RE = /(?:多少|几)个?\s*(?:SKU|sku|货号|款号)|(?:SKU|sku|货号|款号)\s*(?:的?数量|数|个数|有多少个|有几个)|动过销的\s*(?:SKU|sku|货号|款号)|有[多少几]*个(?:不同的)?\s*(?:SKU|sku|货号|款号)/;

function structureGaps(question, plan, o = {}){
  const registry = o.registry;
  const raw = String(question == null ? '' : question);
  const p = plan || {};
  // 括号里是校验说明，不是用户要的结构；「平均每月/月均」是日均那一类，不是按月拆
  const s0 = norm(raw.replace(/[（(][^）)]*[）)]/g, ' '));
  const s = s0.replace(/平均每个?月|月均|平均每个?[周天日]|每月平均|每个月平均/g, '');
  const out = [];
  const push = (slot, word, message, extra) => { if (!out.some(x => x.slot === slot)) out.push(Object.assign({ slot, word, message }, extra || {})); };
  const metricIds = p.metric_ids || [];
  const formula = p.formula || null;
  const cmp = typeof p.comparison === 'string' ? { kind: p.comparison } : (p.comparison || { kind: 'none' });
  const grain = p.grain && p.grain !== 'none' ? p.grain : null;
  const metricObj = id => { try { return registry.metric(String(id).startsWith('m:') ? id : 'm:' + id); } catch (_) { return null; } };
  const allMetrics = () => {
    const ids = [...metricIds, formula && formula.num, formula && formula.den, formula && formula.base, formula && formula.left, formula && formula.right].filter(Boolean);
    const res = [];
    for (const id of ids) {
      const m = metricObj(id); if (m) res.push(m);
      try { for (const l of registry.leaves(String(id).startsWith('m:') ? id : 'm:' + id)) { const lm = metricObj(l); if (lm) res.push(lm); } } catch (_) {}
    }
    return res;
  };
  // 有没有「按时间拆」：grain，或一个对得上粒度的时间类分组维度（按月的桶 / 日期列……）
  const timeDimIs = re => (p.dimensions || []).some(id => { try { const d = registry.dim(id); return d && (d.kind === 'timeBucket' || /日期|date/i.test(String(d.name) + String(d.id))) && re.test([d.id, d.name, d.grain].join(' ')); } catch (_) { return false; } });
  const hasSplit = (g, re) => grain === g || (!grain && timeDimIs(re));
  const anyTimeDim = () => (p.dimensions || []).some(id => { try { const d = registry.dim(id); return d && (d.kind === 'timeBucket' || /日期|期|快照|date|snapshot/i.test(String(d.name) + String(d.id))); } catch (_) { return false; } });

  // 1) 按时间拆
  const mon = STRUCT_MONTH_RE.exec(s);
  if (mon && !hasSplit('month', /月|month/i)) push('grain_month', mon[0], '话里要按月拆开（每个月各一个数），计划没有按月分组（grain=month），给的是一个合计');
  const day = STRUCT_DAY_RE.exec(s);
  if (day && !hasSplit('day', /日|day|date/i)) push('grain_day', day[0], '话里要按天拆开，计划没有按天分组（grain=day），给的是一个合计');
  const wk = STRUCT_WEEK_RE.exec(s);
  if (wk && !hasSplit('week', /周|week/i)) push('grain_week', wk[0], '话里要按周拆开，计划没有按周分组（grain=week），给的是一个合计');
  const qt = STRUCT_QUARTER_RE.exec(s);
  if (qt && !hasSplit('quarter', /季|quarter/i)) push('grain_quarter', qt[0], '话里要按季度拆开，计划没有按季度分组（grain=quarter），给的是一个合计');
  const snap = STRUCT_SNAP_RE.exec(s);
  if (snap && !(grain || anyTimeDim())) push('grain_periods', snap[0], '话里要每一期各一个数，计划没有按期分组，给的是一个合计');
  const half = STRUCT_HALF_RE.exec(s);
  if (half) push('segments', half[0], '话里要上半年、下半年各一个数，配置单没有分段节点，表达不了', { unrepresentable: true });
  const xun = STRUCT_XUN_RE.exec(s);
  if (xun) push('segments', xun[0], '话里要上旬、中旬、下旬各一个数，配置单没有分段节点，表达不了', { unrepresentable: true });

  // 2) 对比
  const cm = STRUCT_CMP_RE.exec(s) || /比[^，。；比]{0,6}多(?:卖|了|出)?(?:多少|几)|比[^，。；比]{0,6}少(?:卖|了)?(?:多少|几)/.exec(s);
  if (cm) {
    const periodWord = /去年|上年|上个?月|上期|上周|上季|前一[期个]|同期|环比|同比|[后前]减[前后]|两期|增长|增加|减少|下降|降低|变化/.test(cm[0]);
    const has = (cmp && cmp.kind && cmp.kind !== 'none') || (formula && (formula.kind === 'diff' || formula.kind === 'pp')) || !!(cmp && cmp.base && cmp.base.start);
    if (periodWord && !has) push('comparison', cm[0], '话里要和另一期比（比去年同期 / 环比 / 差多少），计划没有对比（comparison）节点，给的只是本期数');
  }

  // 3) 占比（新增说法；老说法在 unmappedConditions 里，同一个 slot 不重复报）
  const sh = STRUCT_SHARE_RE.exec(s);
  if (sh && !/涨|跌|增长|下降|增幅|降幅|幅度|变动|变化/.test(s)) {   // 「涨了百分之几」是增长率，归对比那一条
    const ratioLike = allMetrics().some(m => m && (m.kind === 'ratio' || m.unit === '%' || /率|占比|比例|份额|share|rate|ratio/i.test(String(m.id) + ' ' + String(m.name || ''))));
    const has = !!(formula && (formula.kind === 'ratio' || formula.kind === 'share')) || ratioLike;
    if (!has) push('share', sh[0], '话里要占比 / 比例 / 百分之几，计划没有比率或占比（ratio / share）节点，给的是一个金额或一张清单');
  }

  // 4) 日均：合计 ÷ 天数。计划里要有「分母是天数」的比率；没有就是配置单表达不了
  const av = STRUCT_AVGDAY_RE.exec(s0);
  if (av) {
    const denIds = [formula && formula.den].filter(Boolean);
    const daysDen = formula && formula.kind === 'ratio' && denIds.some(id => {
      const m = metricObj(id);
      return m && (/天数|日数|days?|day_count|活跃天/i.test(String(m.id) + ' ' + String(m.name || '')) || (m.agg === 'dcount' && /date|day|日期|日$/i.test(String(m.field || ''))));
    });
    // 「日均销量」这种本身就是指标名（语义包里有这个指标，题面也点了它）→ 不是「合计 ÷ 天数」
    let isMetricName = false;
    try { for (const m of registry.semantic.metrics.values()) if (!m.unbound && m.name && String(m.name).includes(av[0]) && s0.includes(norm(m.name))) isMetricName = true; } catch (_) {}
    if (!daysDen && !isMetricName) push('avg_daily', av[0], '话里要日均（合计 ÷ 天数），计划里没有「分母是天数」的比率，配置单表达不了', { unrepresentable: true });
  }

  // 5) 多少个 SKU：要去重计数，不是行数
  const dc = STRUCT_DCOUNT_RE.exec(s0);
  if (dc) {
    const isD = allMetrics().some(m => m && m.agg === 'dcount') || !!(p.having && p.having.count_groups);
    if (!isD) push('dcount', dc[0], '话里问「多少个 SKU / 货号」，计划的指标不是去重计数（dcount），数出来的会是行数');
  }

  // 6) 点名的对象：本机已认出它属于哪个维度、而计划里没有对应筛选
  if (o.entityLookup && registry) {
    try {
      const sig = extractSignals(raw, { registry, anchor: o.anchor, timezone: o.timezone, entityLookup: o.entityLookup }) || {};
      for (const e of (sig.entities || [])) {
        const v = e && e.value != null ? String(e.value) : '';
        if (!e.dim || v.length < 2 || !raw.includes(v)) continue;
        const dimKey = x => String(x || '').replace(/^d:/, '');
        const inEnt = (p.entities || []).some(x => x && String(x.value) === v);
        const inFilter = (p.filters || []).concat(p.negations || []).some(f => f && JSON.stringify(f).includes(v));
        const grouped = (p.dimensions || []).some(d => dimKey(d) === dimKey(e.dim));   // 按这个维度分组 = 点名的那一个也在结果里
        // 10-24：「A 渠道比 B 渠道高多少」这类，点名的对象在 formula（diff 的左右成员）或对比里也算落了
        const inFormula = !!(p.formula && JSON.stringify(p.formula).includes(v)) || !!(p.comparison && typeof p.comparison === 'object' && JSON.stringify(p.comparison).includes(v));
        if (!inEnt && !inFilter && !grouped && !inFormula) { push('entity', v, `话里点名了「${v}」（${dimKey(e.dim)}），计划里没有对应的筛选（entities），给的是全部的数`); }
      }
    } catch (_) {}
  }
  return out;
}

/* ---------------- 零调用精度：题面里还有本机计划没覆盖的说法，就不许零调用 ---------------- */
// 第一轮盲测 26 题零调用只对 2 题：条件词门槛只覆盖了 9 类条件，题目里的「周六/工作日/超过/第二高/日均/
// 相差/占…多少%」等说法全被当成普通描述，计划给一个看着合理的宽泛答案。这里做一次「残留说法」检查：
// 把题面里能对上计划节点/指标/维度/实体/时间/词典的说法全部消掉，剩下还有实词就不许零调用（改走模型）。
// 只做保守判断：拿不准就不零调用；不替模型选口径。
const RESIDUAL_STOP = [
  '多少','什么','哪些','哪个','哪几','分别','分渠道','分品类','按','各','的','是','在','里','时','快照','数据','请问','帮我','麻烦',
  '看一下','查一下','查查','看看','一下','呢','吗','吧','请','帮我看看','给出','列出','显示','输出','告诉我','告诉我一下','统计','计算',
  '情况','表现','怎么样','如何','咋样','为啥','为什么','原因','结果','值','数字','保留','两位','小数','百分','百分点','金额','数量','多少元','多少件','口径',
  '所有','全渠道','全站','全店','整体','全部','每','每个','各自','这个','那个','时候','盘点','时点','名下','商品','一共','总共','以及','还有',
  '期间','和','与','跟','比','对','于','为','以','从','到','由','把','将','给','并','且','而','或','者','也','都','还','又','再','更','很','太','比较',
  '能否','可否','是否','有没有','是不是','需要','想要','想看','查看','了解','知道','告诉','其中','这些','那些','其','之','上下','左右','约','大约',
  '天','周','月','年','日','件','元','单','人','次','个','条','家','款','位','名','百','千','万','亿','一','二','三','四','五','六','七','八','九','十',
  '当前','目前','现在','截止','截至','以来','之间','以内','以外','的','了','着','过','地','得',
];
const NODE_WORDS = {
  rank: ['最高','最低','最多','最少','最大','最小','最差','最好','倒数','排名','排行','前','名','位','top'],
  comparison: ['相比','对比','相比于','相较于','比起','环比','同比','增长','上涨','下降','下滑','变化','增加','减少','涨了','跌了','掉了','多多少','少多少','高多少','低多少','差多少'],
  share: ['占比','份额','比重','比例','构成','占'],
  avg: ['平均','人均','每单','每个','每件','每家','每条'],
  sum: ['合计','加起来','一共','总共','总计','总和','累计','加总'],
  grain: ['每天','每周','每月','按月','逐月','逐周','按天','逐日','日度','月度','周度'],
};
function residualConcepts(question, plan, o = {}){
  const registry = o.registry;
  const raw = String(question == null ? '' : question);
  if (!raw) return [];
  const p = plan || {};
  const f = p.formula || {};
  const known = [];                          // 长词优先消去
  const push = x => { const v = String(x == null ? '' : x).trim(); if (v.length >= 2) known.push(v); };
  try {
    for (const id of (p.metric_ids || [])) {
      const m = registry.metric(id);
      push(m.id); push(m.name); (m.aliases || []).forEach(push); (m.match || []).forEach(push);
      for (const l of registry.leaves(id)) { const lm = registry.metric(l); push(lm.id); push(lm.name); (lm.aliases || []).forEach(push); }
    }
    for (const d of (p.dimensions || [])) { const dd = registry.dim(d); push(dd.id); push(dd.name); (dd.match || []).forEach(push); (dd.aliases || []).forEach(push); }
    for (const e of [...(p.entities || []), ...(p.negations || [])]) push(e && e.value);
    if (f.num || f.den) { for (const ref of [f.num, f.den]) { try { push(registry.metric(ref).name); } catch (_) {} } }
  } catch (_) {}
  try { for (const sp of periodMentions(raw)) push(sp.text); } catch (_) {}
  // 时间口径说法（「按退款时间看」）：已落到计划时间角色时算已知说法
  if (p.time && p.time.role) {
    try { const role = registry.timeRoles().find(r => r.id === p.time.role); if (role) { push(role.name); push(role.id); if (role.dim) { const rd = registry.dim(role.dim); push(rd.name); (rd.match || []).forEach(push); } } } catch (_) {}
    for (const rw of ROLE_WORDS) { const m = rw.re.exec(raw); if (m) push(m[0]); }
  }
  try { if (o.dict && typeof o.dict.termsIn === 'function') for (const t of o.dict.termsIn(raw)) push(t.term); } catch (_) {}
  if (p.rank) NODE_WORDS.rank.forEach(push);
  if (p.comparison && p.comparison.kind !== 'none') NODE_WORDS.comparison.forEach(push);
  if (f.kind === 'share') NODE_WORDS.share.forEach(push);
  if (f.kind === 'ratio') NODE_WORDS.avg.forEach(push);
  if (f.kind === 'simple' || f.kind === 'derived') NODE_WORDS.sum.forEach(push);
  if (p.grain) NODE_WORDS.grain.forEach(push);
  // 无害虚词也当已知说法（只用于消去，不参与选口径）
  RESIDUAL_STOP.forEach(push);
  // 先在原句上消去已知说法（含时间短语），再去掉数字/标点：先剥数字会把「2026年10月」拆坏
  let s = raw;
  for (const k of known.sort((a, b) => b.length - a.length)) { if (s.includes(k)) s = s.split(k).join(' '); }
  s = s.replace(/[0-9０-９.,%％\-+~～\/()（）\[\]【】「」『』《》：:；;、，。！？?！'"“”‘’\s]+/g, ' ');
  // 单字虚词再消一遍，避免「品类的」这种把 的 粘在实词上导致误判
  s = s.replace(/[的了着过地得是在和与跟比按各每]|[个条家人次天年月日件元单]/g, ' ');
  const vocab = known.join(' ');            // 已知词汇文本：用来放过「可用库存」这种长名的一部分
  const covered = tok => {
    if (tok.length <= 3) return vocab.includes(tok);   // 短词：整词在已知词汇里才算
    for (let i = 0; i + 2 <= tok.length; i++) if (!vocab.includes(tok.slice(i, i + 2))) return false;
    return true;
  };
  const out = [];
  for (const m of s.matchAll(/[\u4e00-\u9fff]{2,}|[A-Za-z][A-Za-z0-9_.\-]{1,}/g)) {
    const tok = m[0];
    if (tok.length < 2 || RESIDUAL_STOP.includes(tok) || covered(tok)) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out.slice(0, 6);
}

// 条件类别（计划当前还没有节点表达）：命中即不许零调用。都是通用说法，不按题号/题面写特例。
const LOCAL_CONDITION_GAPS = [
  ['avg_daily', /日均|平均每天|每天平均|平均每月|月均|平均到每天/, p => false],
  ['day_of_week', /工作日|周末|星期[一二三四五六日天]|周[一二三四五六日天]/, p => false],
  ['metric_filter', /(?:超过|低于|高于|大于|小于|至少|最多|不超过|不少于|以上|以下)\s*[\d一二三四五六七八九十百千万]/, p => false],
  ['pair_diff', /相差|差多少|高多少|低多少|多多少|少多少|高出|低于多少/, p => !(p.comparison && p.comparison.kind !== 'none')],
  ['nth_rank', /第[二三四五六七八九十]高|第[二三四五六七八九十]名|排第[一二三四五六七八九十]|正数第|倒数第/, p => false],
  ['offset_window', /最后\s*\d+\s*天|前\s*\d+\s*天|当月前|上月最后|月初|月末|最后一天|第一天/, p => false],
  ['count_groups', /共有几|有几条|有几个(?!SKU)|几个(?:品类|渠道|SKU|供应商)|几款|几条/, p => false],
];
function localConditionGaps(question, plan, o = {}){
  const q = String(question == null ? '' : question);
  const p = plan || {};
  const out = [];
  for (const [slot, re, modeled] of LOCAL_CONDITION_GAPS) {
    let hit = false;
    try { hit = re.test(q) && !(modeled ? modeled(p) : false); } catch (_) { hit = re.test(q); }
    if (hit) out.push(slot);
  }
  return out;
}

/**
 * 问法骨架（T8）：只看「问的是哪个指标 + 按什么维度/实体/时间角色/比较/粒度/条件」，参数（期间、实体值）不进来。
 * 用途：改写重问时按骨架找到已确认计划，再由 matchConfirmedPlan 逐项重绑参数并重新校验；对不上就不用。
 * 指标不唯一 / 计划解析不出 → 返回 null（不做骨架复用）。
 */
function skeletonOf(question, o = {}){
  const registry = o.registry;
  const raw = String(question == null ? '' : question);
  if (!registry || !raw) return null;
  let plan = null;
  try { plan = parsePlan(raw, o); } catch (_) { plan = null; }
  let sig = {};
  try { sig = extractSignals(raw, o); } catch (_) { sig = {}; }
  const metric = plan && (plan.metric_ids || []).length === 1 ? String(plan.metric_ids[0])
    : ((sig.metricCandidates || []).length === 1 ? String(sig.metricCandidates[0]) : null);
  if (!metric) return null;
  const dims = uniq((plan && plan.dimensions || []).map(d => String(d).replace(/^d:/, ''))).sort();
  const ents = uniq((plan && plan.entities || []).map(e => String(e.dim).replace(/^d:/, ''))).sort();
  const cond = {};
  try {
    const empty = normalizePlan({ schema: PLAN_SCHEMA });
    for (const u of unmappedConditions(raw, empty, o)) cond[u.slot] = true;
  } catch (_) {}
  const skel = {
    v: 1, metric, dims, ents,
    neg: !!(plan && (plan.negations || []).length),
    // 时间角色不进骨架键（题面这两种说法不一定都能本地认出角色）；复用前单独核对「题面点名的口径 vs 计划角色」
    comparison: (plan && plan.comparison && plan.comparison.kind) || 'none',
    grain: (plan && plan.grain) || null,
    rank: plan && plan.rank ? { top: plan.rank.top, direction: plan.rank.direction } : null,
    formula: plan && plan.formula ? String(plan.formula.kind) : null,
    cond,
  };
  // 占位：不同条件的题不能共用骨架（cond 已含）；输出形状不参与参数替换，不放进键
  return skel;
}

/** 生成本题候选 enum（含明确 none）；none 表示候选缺失/无法匹配，不代表没有业务条件。 */
function buildIRSchema(o = {}){
  const c = o.candidates || {};
  const metricIds = uniq((c.metrics || []).map(m => m.id));
  const dimIds = uniq((c.dimensions || []).map(d => d.id));
  const roleIds = uniq((c.time_roles || []).map(r => r.id));
  const nullableDate = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'StudioQueryIR',
    type: 'object', additionalProperties: false,
    required: ['metric', 'output_shape'],
    properties: {
      metric: { type: 'string', enum: [...metricIds, 'none'], description: '只选候选里的指标 id；无法匹配填 none' },
      metric_ambiguous: { type: 'boolean' },
      time_role: { type: 'string', enum: [...roleIds, 'none'] },
      period: {
        type: 'object', additionalProperties: false, required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['explicit', 'relative', 'none'] },
          start: nullableDate, end: nullableDate, label: { type: ['string', 'null'] },
          grain: { type: 'string', enum: ['day', 'week', 'month', 'year', 'none'] },
        },
      },
      dimensions: { type: 'array', maxItems: 4, items: { type: 'string', enum: [...dimIds, 'none'] } },
      entities: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['dim', 'value'], properties: { dim: { type: 'string' }, value: { type: 'string' } } } },
      negations: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['dim', 'value'], properties: { dim: { type: 'string' }, value: { type: 'string' } } } },
      comparison: { type: 'string', enum: ['none', 'previous_period', 'year_over_year'] },
      comparison_output: { type: 'string', enum: ['delta', 'growth_rate'], description: '问题问「增长/下降百分之多少」时给 growth_rate；问「差多少」时给 delta' },
      comparison_policy: { type: ['string', 'null'], enum: ['equal_length_shift', 'prev_whole_month', 'yoy_calendar', 'yoy_feb29_clamp_feb28', null] },
      rank: { type: ['object', 'null'], additionalProperties: false, properties: {
        top: { type: 'integer', minimum: 1, maximum: 100 }, direction: { type: 'string', enum: ['asc', 'desc'] },
        ties: { type: 'string', enum: ['include', 'exclude'] }, nulls: { type: 'string', enum: ['last', 'first', 'drop'] },
        partition_by: { type: 'array', maxItems: 2, items: { type: 'string', enum: dimIds }, description: '组内排名：先按这些维度分组再取前 N' },
      } },
      having: { type: ['object', 'null'], additionalProperties: false, description: '按指标筛选：先聚合再筛组；count_groups=true 时输出满足条件的组数',
        properties: { op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, value: { type: 'number' }, count_groups: { type: 'boolean' } } },
      cumulative: { type: 'boolean', description: '按时间桶顺序累加（累计）；只用于可加指标 + 时间粒度分组' },
      grain: { type: 'string', enum: ['none', 'day', 'week', 'month', 'quarter', 'year'] },
      formula: { type: ['object', 'null'], additionalProperties: false, properties: {
        kind: { type: 'string', enum: ['simple', 'ratio', 'share', 'pp', 'derived', 'diff'] },
        dim: { type: 'string' },
        num: { type: 'string' }, den: { type: 'string' }, base: { type: 'string' }, left: { type: 'string' }, right: { type: 'string' },
        mul: { type: 'number' }, scope: { type: 'string', enum: ['remove_group_filter_keep_user_filter', 'keep_group_filter', 'keep_user_filter'] }, expr: { type: ['string', 'null'] },
        num_period: { type: 'string', enum: ['same', 'previous_period', 'period_start', 'period_end'] }, den_period: { type: 'string', enum: ['same', 'previous_period', 'period_start', 'period_end'] },
        num_window: { type: ['object', 'null'], additionalProperties: false, properties: { start: { type: 'string' }, end: { type: 'string' } } },
        den_window: { type: ['object', 'null'], additionalProperties: false, properties: { start: { type: 'string' }, end: { type: 'string' } } },
        num_filter: { type: ['object', 'null'], additionalProperties: false, properties: { metric: { type: 'string' }, op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, value: { type: 'number' } } },
        den_filter: { type: ['object', 'null'], additionalProperties: false, properties: { metric: { type: 'string' }, op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, value: { type: 'number' } } },
        den_expr: { type: ['object', 'null'], additionalProperties: false, properties: { op: { type: 'string', enum: ['add', 'sub'] }, args: { type: 'array', maxItems: 3, items: { type: 'string' } } } },
      } },
      comparison_base: { type: ['object', 'null'], additionalProperties: false, properties: { start: nullableDate, end: nullableDate, label: { type: ['string', 'null'] } } },
      indicator: { type: ['object', 'null'], additionalProperties: false, properties: { op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, value: { type: 'number' } } },
      unit: { type: ['string', 'null'], enum: ['', '元', '件', '天', '个', '%', '元/件', '元/SKU', '元/个', '件/天', null] },
      output_shape: { type: 'string', enum: ['scalar', 'table', 'series'] },
      unresolved: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['slot', 'reason'], properties: { slot: { type: 'string', enum: ['metric', 'time_role', 'period', 'dimension', 'entity', 'negation', 'comparison', 'rank', 'formula', 'unit', 'output_shape'] }, reason: { type: 'string', enum: ['ambiguous', 'capability_gap', 'clarify', 'candidate_miss'] }, options: { type: 'array', items: { type: 'string' } } } } },
    },
  };
}

/** 本地校验 IR 形状（provider 严格模式不保证字段依赖/数组长度/作用域；这些必须本地验） */
// P79:模型 IR 的常见非致命写法差异在本机归一,不再为此多花一次修复调用(成熟做法:宽松解析 + 严格校验)。
// 只做语义不变的归一:unresolved 的子路径槽位归到所属槽位、近义原因归到合法原因;标量问法里 top 为空的 rank 删除。
function normalizeIRLoose(ir){
  if (!ir || typeof ir !== 'object') return ir;
  const SLOTS = ['metric','time_role','period','dimension','entity','negation','comparison','rank','formula','unit','output_shape'];
  const ALIAS = { dimensions: 'dimension', entities: 'entity', negations: 'negation', having: 'comparison', filter: 'comparison', filters: 'comparison', condition: 'comparison', conditions: 'comparison', time: 'time_role', grain: 'period', den: 'formula', num: 'formula', denominator: 'formula', numerator: 'formula' };
  const REASON = { missing: 'capability_gap', not_found: 'candidate_miss', unknown: 'capability_gap', unsupported: 'capability_gap', unclear: 'clarify', ask: 'clarify', multiple: 'ambiguous' };
  // 注:unresolved 槽位不归一——非法槽位原本会触发一次修复,模型常在修复里去掉不成立的歧义;归一成合法歧义会变成追问用户(P79 正式旧题回归里 5 题因此丢分,已撤回)
  void SLOTS; void ALIAS; void REASON;
  if (ir.rank && typeof ir.rank === 'object' && (ir.rank.top == null || ir.rank.top === 0) && ir.output_shape === 'scalar') delete ir.rank;
  return ir;
}
function validateIRShape(ir){
  normalizeIRLoose(ir);
  const errors = [];
  const bad = (message) => errors.push({ code: CODES.IR_INVALID, message });
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) { bad('IR 不是一个对象'); return errors; }
  if (typeof ir.metric !== 'string') bad('metric 必须是字符串');
  // 第三轮：output_shape 漏写不算结构错（按有没有分组/排名/粒度自动补）；写了非法值才算
  if (ir.output_shape != null && !['scalar', 'table', 'series'].includes(ir.output_shape)) bad('output_shape 必须是 scalar/table/series');
  if (ir.dimensions != null && (!Array.isArray(ir.dimensions) || ir.dimensions.length > 4)) bad('dimensions 必须是最多 4 项的数组');
  if (ir.entities != null && (!Array.isArray(ir.entities) || ir.entities.length > 6)) bad('entities 必须是最多 6 项的数组');
  if (ir.negations != null && (!Array.isArray(ir.negations) || ir.negations.length > 6)) bad('negations 必须是最多 6 项的数组');
  if (ir.unresolved != null && (!Array.isArray(ir.unresolved) || ir.unresolved.length > 4)) bad('unresolved 必须是最多 4 项的数组');
  if (Array.isArray(ir.unresolved) && ir.unresolved.some(u=>!u || !['metric','time_role','period','dimension','entity','negation','comparison','rank','formula','unit','output_shape'].includes(u.slot) || !['ambiguous','capability_gap','clarify','candidate_miss'].includes(u.reason))) bad('unresolved 槽位或原因非法');
  if (ir.period != null) {
    if (ir.period.kind === 'explicit') {
      if (!isIsoDate(ir.period.start) || !isIsoDate(ir.period.end)) bad('explicit 期间必须有合法 start/end');
    } else if (!['relative', 'none'].includes(ir.period.kind)) bad('period.kind 非法');
  }
  if (ir.rank != null) {
    if (!Number.isInteger(ir.rank.top) || ir.rank.top < 1 || ir.rank.top > 100) bad('rank.top 必须是 1..100 的整数');
    if (!['asc', 'desc'].includes(ir.rank.direction)) bad('rank.direction 非法');
  }
  if (ir.formula != null && ir.formula.kind === 'ratio') {
    if (!ir.formula.num || (!ir.formula.den && !(ir.formula.den_expr && Array.isArray(ir.formula.den_expr.args) && ir.formula.den_expr.args.length))) bad('ratio 公式缺 num/den（或用 den_expr 给分母）');
    // mul / scope 允许模型不写：由 irToPlan 按指标定义与公式类型自补（漏写不算结构错）
  }
  if (ir.formula != null && ir.formula.kind === 'share') {
    // 同上：mul 缺省由语义层补齐
  }
  if (ir.formula != null && ir.formula.kind === 'pp') {
    if (!ir.formula.left || !ir.formula.right) bad('pp 公式缺 left/right');
  }
  return errors;
}
const isIsoDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && timeCore.isValidDate(s);

/**
 * IR → 计划。适配边界只在这里把「用户可读的闭区间 end」转成半开 endExclusive 一次。
 * 返回 { plan, errors }：errors 只含可恢复的结构/引用错误；口径未决写进 plan.unresolved（要澄清）。
 */
function irToPlan(ir, o = {}){
  const registry = o.registry;
  const signals = o.signals || null;
  const errors = validateIRShape(ir);
  if (errors.length) return { plan: normalizePlan({ schema: PLAN_SCHEMA, question: o.question || '' }), errors };
  const rejected = (code, message, extra) => errors.push(Object.assign({ code, message }, extra || {}));
  if(ir.formula?.kind==='share'&&ir.metric&&ir.metric!=='none'&&ir.formula.base&&String(ir.metric).replace(/^m:/,'')!==String(ir.formula.base).replace(/^m:/,'')){
    rejected(CODES.IR_INVALID,'share的base与metric必须是同一被分组指标；若表达两个不同指标相除，应使用ratio并保留题面分母');
  }
  const plan = normalizePlan({
    schema: PLAN_SCHEMA, question: o.question || '',
    time: { role: null, anchor: o.anchor || timeCore.todayIn(o.timezone || TIMEZONE_DEFAULT), start: null, end: null, endExclusive: null, timezone: o.timezone || TIMEZONE_DEFAULT, grain: null, label: null, interval: INTERVAL_SCHEMA, schema_version: PLAN_SCHEMA },
    permission_scope: { workspace: (o.scope && o.scope.workspace) || 'local', datasets: (o.scope && o.scope.datasets) || null },
  });

  // 第三轮：模型写了公式、却把 metric 填成 none（或漏写）——公式里的分子/基数指标就是主指标；
  // 同时去掉它自己写的「metric candidate_miss」未决项（指标其实已在公式里落实）。
  if ((!ir.metric || ir.metric === 'none') && ir.formula && typeof ir.formula === 'object') {
    const f0 = ir.formula;
    let firstRef = f0.num || f0.base || null;
    if (!firstRef && f0.expr && typeof f0.expr === 'object') { const w = x => typeof x === 'string' ? x : (x && Array.isArray(x.args) ? w(x.args[0]) : null); firstRef = w(f0.expr); }
    if (!firstRef && (f0.kind === 'diff' || f0.kind === 'pp') && f0.num) firstRef = f0.num;
    if (firstRef && registry.semantic.metrics.has(String(firstRef).replace(/^m:/, ''))) {
      ir = Object.assign({}, ir, { metric: String(firstRef).startsWith('m:') ? String(firstRef) : 'm:' + String(firstRef),
        unresolved: (ir.unresolved || []).filter(u => !(String(u && u.slot) === 'metric' && ['candidate_miss', 'ambiguous'].includes(String(u && u.reason)))) });
    }
  }
  // 1) 指标：none 明确表示候选缺失/无法匹配，不代表没有业务条件
  if (ir.metric && ir.metric !== 'none') {
    const mid = String(ir.metric).replace(/^m:/, '');
    if (!registry.semantic.metrics.has(mid)) rejected(CODES.UNKNOWN_METRIC, `IR 选了不存在的指标：${ir.metric}`);
    else plan.metric_ids = ['m:' + mid];
  }
  if ((!plan.metric_ids.length || ir.metric_ambiguous) && signals && signals.metricCandidates && signals.metricCandidates.length) {
    plan.unresolved.push({ code: CODES.AMBIGUOUS_METRIC, message: '指标有多个候选', options: signals.metricCandidates.map(id => { let name = id; try { name = (registry.metric(id) || {}).name || id; } catch (_) {} return { id, name }; }) });
  } else if (!plan.metric_ids.length && (signals == null || !(signals.metricCandidates || []).length)) {
    rejected(CODES.UNKNOWN_METRIC, 'IR 没给指标，题面也没有可识别指标');
  }

  // 2) 期间：explicit=用户可读日期（闭区间）→ 半开；relative=按锚点解析；none=全部数据
  const per = ir.period || { kind: 'none' };
  if (per.kind === 'explicit') {
    const start = String(per.start).slice(0, 10), endIncl = String(per.end).slice(0, 10);
    if (!timeCore.isValidDate(start) || !timeCore.isValidDate(endIncl)) rejected(CODES.INVALID_PERIOD, 'IR 的期间不是合法日历日期');
    else if (start > endIncl) rejected(CODES.INVALID_PERIOD, 'IR 的开始日期晚于结束日期');
    else {
      const endExclusive = timeCore.addDays(endIncl, 1);   // 唯一转换点：闭区间 → 半开
      plan.time.start = start; plan.time.end = endIncl; plan.time.endExclusive = endExclusive;
      plan.time.grain = per.grain && per.grain !== 'none' ? per.grain : timeCore.isMonthEnd(endIncl) && start.slice(8) === '01' ? 'month' : (start === endIncl ? 'day' : 'day');
      plan.time.label = per.label || (start === endIncl ? start : `${start}~${endIncl}`);
      plan.time.interval = INTERVAL_SCHEMA;
      plan.time.compat = [{ from: 'ir/explicit_inclusive_end', rule: 'end_inclusive_to_exclusive' }];
    }
  } else if (per.kind === 'relative') {
    const label = per.label || (signals && signals.period && signals.period.label) || null;
    const specificMonth=signals?.period&&/(今年|去年|本年)\s*\d{1,2}月/.test(String(signals.text||''))&&(!ir.comparison||ir.comparison==='none');
    const parsed = specificMonth?signals.period:label ? parsePeriod(label, o.anchor, { timezone: o.timezone }) : (signals && signals.period) || null;
    if (!parsed) rejected(CODES.INVALID_PERIOD, 'IR 说的是相对期间，但没有可解析的 label');
    else {
      plan.time.start = parsed.start; plan.time.end = parsed.end; plan.time.endExclusive = parsed.endExclusive;
      plan.time.label = parsed.label; plan.time.grain = parsed.grain; plan.time.policy = parsed.policy || 'relative';
    }
  }

  // 3) 时间角色：IR 明确 none 时，只有唯一可用角色才自动定；否则留缺口
  if (per.kind !== 'none' || (plan.time && plan.time.start)) {
    const leaves = plan.metric_ids.length ? registry.leaves(plan.metric_ids[0]) : [];
    const datasets = uniq([...leaves.map(l => registry.metric(l).dataset || registry.metric(l).boundTo),
      ...(plan.dimensions || []).map(d => { try { const dd = registry.dim(d); return dd.source && dd.source.table; } catch (_) { return null; } })].filter(Boolean));
    const usable = registry.timeRoles().filter(r => !datasets.length || datasets.includes(r.dataset));
    const roleId = ir.time_role && ir.time_role !== 'none' ? String(ir.time_role) : null;
    if (roleId) {
      if (!registry.timeRoles().some(r => r.id === roleId)) rejected(CODES.MISSING_TIME_ROLE, `IR 选了不存在的时间角色：${roleId}`);
      else if (usable.length && !usable.some(r => r.id === roleId)) rejected(CODES.MISSING_TIME_ROLE, `时间角色 ${roleId} 不适用于这个指标的数据集`);
      else plan.time.role = roleId;
    } else if (ir.time_role === 'none') {
      if (usable.length === 1) plan.time.role = usable[0].id;
      else plan.unresolved.push({ code: CODES.MISSING_TIME_ROLE, message: '这个指标涉及多个日期口径，先确认按哪个时间统计', options: usable.length ? usable : registry.timeRoles() });
    } else if (usable.length > 1) plan.unresolved.push({ code: CODES.MISSING_TIME_ROLE, message: '这个指标涉及多个日期口径，先确认按哪个时间统计', options: usable });
    else if (usable.length === 1) plan.time.role = usable[0].id;
    else rejected(CODES.MISSING_TIME_ROLE, '这些数据里没有可用的日期列');
  }

  // 4) 维度：本地验存在 + 能安全连接（扇出）；数组项 none 丢掉
  for (const d of (ir.dimensions || [])) {
    if (!d || d === 'none') continue;
    const did = String(d).replace(/^d:/, '');
    if (!registry.semantic.dims.has(did)) { rejected(CODES.UNKNOWN_DIM, `IR 选了不存在的维度：${d}`); continue; }
    if (!plan.dimensions.includes('d:' + did)) plan.dimensions.push('d:' + did);
  }
  if (signals && signals.ambiguousDims) plan.unresolved.push({ code: 'ambiguous_dim', message: '分组对象有多个候选', options: signals.ambiguousDims });

  // 5) 实体/否定：维度与值都要本地核对；值在实体目录里找不到 → 明确找不到，不当「全部」
  const resolveEntity = (e) => {
    const dimId = String(e && e.dim || '').replace(/^d:/, '');
    let dim = dimId && dimId !== 'none' ? registry.semantic.dims.get(dimId) : null;
    // 模型可能用键列名（sku）而不是维度 id：按名字/别名找同一数据集上绑定的维度，
    // 只在唯一候选时采用；找不到或有歧义就明确报缺口，不静默忽略。
    if (!dim && dimId) {
      const hint = norm(dimId).toLowerCase();
      const metricDss = uniq((plan.metric_ids || []).flatMap(id => { try { return registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo); } catch (_) { return []; } }).filter(Boolean));
      const cands = [...registry.semantic.dims.values()].filter(d => !d.unbound && d.source &&
        (norm(d.id).toLowerCase() === hint || norm(d.name).toLowerCase().includes(hint) || (d.match || []).some(k => norm(k).toLowerCase() === hint) || (d.aliases || []).some(k => norm(k).toLowerCase() === hint)));
      let same = cands.filter(d => metricDss.includes(d.source.table));
      // 指标跨表（如 库存金额 = 可用库存×单价）时，优先落到主指标所在表的键维度（库存 SKU，而不是目录 SKU）
      if (same.length > 1) {
        try {
          const primaryLeaf = registry.leaves(plan.metric_ids[0])[0];
          const primaryDs = registry.metric(primaryLeaf).dataset || registry.metric(primaryLeaf).boundTo;
          const primary = same.filter(d => d.source.table === primaryDs);
          if (primary.length === 1) same = primary;
        } catch (_) {}
      }
      const pick = same.length === 1 ? same[0] : (cands.length === 1 ? cands[0] : null);
      if (pick) dim = pick;
    }
    if (!dim) return { error: { code: CODES.UNKNOWN_DIM, message: `实体维度不存在：${e && e.dim}` } };
    const value = String(e && e.value == null ? '' : e.value);
    if (!value) return { error: { code: CODES.AMBIGUOUS_ENTITY, message: '实体的值为空' } };
    const resolvedDimId = String(dim.id);
    if (o.entityLookup) {
      try {
        const hit = o.entityLookup.resolve(value, { dimIds: [resolvedDimId] });
        if (hit.status === 'matched') return { dim: 'd:' + hit.dim, value: hit.value };
        // 模型可能把值挂到错维度（例：SKU 值挂到「三级品类」）。值本身是实体，按全量维度再找一次；
        // 只有精确命中且维度唯一才采用，仍歧义/找不到就如实报缺口，不猜。
        const all = o.entityLookup.resolve(value, {});
        if (all.status === 'matched' && all.how === 'exact') {
          return { dim: 'd:' + all.dim, value: all.value, how: 'value_lookup', note: `模型给的维度 ${resolvedDimId} 与值不匹配，按值精确命中 ${all.dim}` };
        }
        // 同值挂在多张表的键列（如 inv_sku/sale_sku/catalog_sku）：用指标所在数据集收窄，唯一才采用
        if (all.status === 'ambiguous') {
          const metricDss = uniq((plan.metric_ids || []).flatMap(id => { try { return registry.leaves(id).map(l => registry.metric(l).dataset || registry.metric(l).boundTo); } catch (_) { return []; } }).filter(Boolean));
          const exactHits = (all.candidates || []).map(c => {
            const opt = (c.options || []).find(o2 => o2.how === 'exact' && String(o2.value) === value);
            return opt ? { dim: String(c.dim).replace(/^d:/, ''), value: opt.value } : null;
          }).filter(Boolean);
          const sameDs = exactHits.filter(h => { try { const dd = registry.dim(h.dim); return dd && dd.source && metricDss.includes(dd.source.table); } catch (_) { return false; } });
          // 多个表的同名键都命中：优先「分组/过滤时不会放大行」的维度（如跨表派生指标选目录 SKU，而不是库存 SKU）
          if (sameDs.length > 1) {
            let safe = sameDs;
            try {
              const mid0 = String((plan.metric_ids || [])[0] || '').replace(/^m:/, '');
              if (mid0) safe = sameDs.filter(h => { try { registry.semantic.checkJoin(mid0, [h.dim]); return true; } catch (_) { return false; } });
            } catch (_) {}
            const pool = safe.length ? safe : sameDs;
            if (pool.length === 1) return { dim: 'd:' + pool[0].dim, value: pool[0].value, how: 'value_lookup_dataset', note: `按值与安全连接唯一收敛到 ${pool[0].dim}` };
            try {
              const primaryLeaf = registry.leaves(plan.metric_ids[0])[0];
              const primaryDs = registry.metric(primaryLeaf).dataset || registry.metric(primaryLeaf).boundTo;
              const prim = pool.filter(h => { try { const dd = registry.dim(h.dim); return dd && dd.source && dd.source.table === primaryDs; } catch (_) { return false; } });
              if (prim.length === 1) return { dim: 'd:' + prim[0].dim, value: prim[0].value, how: 'value_lookup_dataset', note: `按值与主指标数据集唯一收敛到 ${prim[0].dim}` };
            } catch (_) {}
          }
          if (sameDs.length === 1) return { dim: 'd:' + sameDs[0].dim, value: sameDs[0].value, how: 'value_lookup_dataset', note: `按值与指标数据集唯一收敛到 ${sameDs[0].dim}` };
        }
        if (hit.status === 'ambiguous') return { ambiguous: { dim: 'd:' + resolvedDimId, value, options: hit.candidates } };
        return { notFound: true };
      } catch (_) { return { dim: 'd:' + resolvedDimId, value }; }
    }
    return { dim: 'd:' + resolvedDimId, value };
  };
  for (const e of (ir.entities || [])) {
    const r = resolveEntity(e);
    if (r.error) rejected(r.error.code, r.error.message);
    else if (r.ambiguous) plan.unresolved.push({ code: CODES.AMBIGUOUS_ENTITY, message: `实体「${r.ambiguous.value}」有多个候选`, options: r.ambiguous.options });
    else if (r.notFound) rejected(CODES.ENTITY_NOT_FOUND, `提到的「${e && e.value}」没有在本机实体目录里找到`);
    else plan.entities.push({ dim: r.dim, value: String(r.value), how: 'ir' });
  }
  for (const n of (ir.negations || [])) {
    const r = resolveEntity(n);
    if (r.error || r.ambiguous || r.notFound) { plan.unresolved.push({ code: CODES.CAPABILITY_GAP, message: '否定/排除条件没有可表示的计划节点', slot: 'negation' }); continue; }
    plan.negations.push({ dim: r.dim, value: String(r.value), text: String(n.value) });
  }
  // 第三轮 T4：题面同时点了两个维度的具体对象（如「某品类 + 某渠道」）时，本机会把它记成「分组对象有多个候选」；
  // 计划里这些候选维度已经各自落成了筛选对象（或已选定分组维度）→ 歧义已经消掉，不再拦
  {
    const used = new Set([...plan.dimensions, ...plan.entities.map(e => String(e.dim)), ...plan.negations.map(e => String(e.dim))].map(d => 'd:' + String(d).replace(/^d:/, '')));
    plan.unresolved = plan.unresolved.filter(u => !(u && u.code === 'ambiguous_dim' && Array.isArray(u.options) && u.options.length
      && (u.options.every(x => used.has('d:' + String(x).replace(/^d:/, ''))) || plan.dimensions.some(d => u.options.map(x => 'd:' + String(x).replace(/^d:/, '')).includes(d)))));
  }

  // 6) 比较/排序/粒度/公式/输出形状
  const kind = ir.comparison || 'none';
  if (!['none', 'previous_period', 'year_over_year'].includes(kind)) rejected(CODES.UNSUPPORTED_OPERATOR, `比较类型不支持：${kind}`);
  else plan.comparison = { kind, explicit: kind !== 'none', base: ir.comparison_base && ir.comparison_base.start ? { start: ir.comparison_base.start, end: ir.comparison_base.end, label: ir.comparison_base.label || null } : null, output: ir.comparison_output || 'delta', policy: ir.comparison_policy || (kind === 'year_over_year' ? 'yoy_calendar' : kind === 'previous_period' ? 'equal_length_shift' : null) };
  if (ir.rank != null) plan.rank = { top: ir.rank.top, direction: ir.rank.direction, ties: ir.rank.ties || 'include', nulls: ir.rank.nulls || 'last' };
  if (plan.rank && Array.isArray(ir.rank && ir.rank.partition_by) && ir.rank.partition_by.length) {
    plan.rank.partition_by = ir.rank.partition_by.map(x => String(x)).filter(x => x && x !== 'none').slice(0, 2);
  }
  if (ir.having && ir.having.op && ir.having.value != null) {
    plan.having = { op: String(ir.having.op), value: Number(ir.having.value), count_groups: ir.having.count_groups === true };
    // 第三轮 T4：「单日低于 X 的有几天 / 有多少个渠道超过 X」问的是满足条件的组数：有分组（维度或时间粒度）、要一个数 → 数组数
    const qtext = String((signals && signals.text) || '');
    if (!plan.having.count_groups && ir.output_shape !== 'table' && /(?:多少|几)\s*(?:天|个月|周|个|家|款|种|条)/.test(qtext)
      && ((ir.grain && ir.grain !== 'none') || (Array.isArray(ir.dimensions) && ir.dimensions.some(d => d && d !== 'none')))) plan.having.count_groups = true;
  }
  if (ir.cumulative === true) plan.cumulative = true;
  if (signals && signals.rank) plan.rank = Object.assign({},plan.rank||{},signals.rank);   // 题面明确要排名但 IR 漏了：由本地补，不静默丢
  if (ir.grain && ir.grain !== 'none') plan.grain = ir.grain;
  else if (signals && signals.grain) plan.grain = signals.grain;

  if (ir.formula != null && ir.formula.kind === 'ratio') {
    // 接口偶尔把分支期间放在根节点；保留它们，冲突则拒绝，不能静默算成同一期间。
    const branchKeys=['num_period','den_period','num_window','den_window'];
    const formula={...ir.formula};
    for(const key of branchKeys)if(ir[key]!=null){
      if(formula[key]!=null&&JSON.stringify(formula[key])!==JSON.stringify(ir[key]))rejected(CODES.INVALID_PERIOD,'同一公式分支给了冲突期间');
      else formula[key]=ir[key];
    }
    ir={...ir,formula};
    const denRef0 = ir.formula.den ? String(ir.formula.den) : (ir.formula.den_expr && Array.isArray(ir.formula.den_expr.args) ? String(ir.formula.den_expr.args[0]) : '');
    plan.formula = { kind: 'ratio', num: String(ir.formula.num), den: denRef0, mul: ir.formula.mul, scope: ir.formula.scope || 'keep_group_filter' };
    for (const k of ['num_period', 'den_period', 'num_window', 'den_window', 'num_filter', 'den_filter', 'den_expr']) {
      if (ir.formula[k] != null) {
        if((k==='num_period'||k==='den_period')&&typeof ir.formula[k]==='object') {
          const target=k.replace('_period','_window');
          if(ir.formula[target]&&JSON.stringify(ir.formula[target])!==JSON.stringify(ir.formula[k]))rejected(CODES.INVALID_PERIOD,'同一公式分支给了冲突期间');
          else plan.formula[target]=ir.formula[k];
        } else plan.formula[k] = ir.formula[k];
      }
    }
    if (plan.formula.mul == null) plan.formula.mul = inferFormulaScale(registry, plan.formula, plan.metric_ids);
  } else if (ir.formula != null && ir.formula.kind === 'pp') {
    plan.formula = { kind: 'pp', left: String(ir.formula.left), right: String(ir.formula.right), scope: 'keep_group_filter', mul: 1 };
  } else if (ir.formula != null && ir.formula.kind === 'share') {
    const base = String(ir.formula.base || (plan.metric_ids[0] || '')).replace(/^m:/, '');
    plan.formula = { kind: 'share', base, mul: ir.formula.mul == null ? 100 : ir.formula.mul, scope: 'remove_group_filter_keep_user_filter' };
  } else if (ir.formula != null && ir.formula.kind === 'derived' && ir.formula.expr
    && (typeof ir.formula.expr !== 'object' || (() => { const bad = []; const w = x => { if (typeof x === 'string') { if (!registry.semantic.metrics.has(String(x).replace(/^m:/, ''))) bad.push(x); } else if (x && Array.isArray(x.args) && ['add', 'sub', 'mul', 'div'].includes(String(x.op))) x.args.forEach(w); else bad.push(JSON.stringify(x)); }; w(ir.formula.expr); return bad.length > 0; })())) {
    // 第三轮：派生表达式写成了 SQL 片段 / 引用了不存在的指标 → 结构错误（可修一次），不再抛异常导致空答案
    rejected(CODES.IR_INVALID, '派生公式 expr 必须是 {op:add|sub|mul|div, args:[候选指标 id…]} 结构，不能写 SQL 片段或不存在的指标');
  } else if (ir.formula != null && ir.formula.kind === 'derived' && ir.formula.expr) {
    // 派生指标：表达式引用若干个已有指标（执行器按「先各自聚合再四则运算」；行级乘积另记能力缺口）
    const refs = [];
    const walk = x => { if (typeof x === 'string') refs.push(String(x).replace(/^m:/, '')); else if (x && Array.isArray(x.args)) x.args.forEach(walk); };
    walk(ir.formula.expr);
    if (refs.length) plan.metric_ids = ['m:' + refs[0]];
    plan.formula = { kind: 'derived', expr: ir.formula.expr };
    plan.unit = plan.unit || '';
  } else if (plan.metric_ids.length === 1) {
    const m = registry.metric(plan.metric_ids[0]);
    plan.metric_name = m.name; plan.unit = m.unit || '';
    plan.formula = m.kind === 'ratio' ? { kind: 'ratio', num: 'm:' + m.num, den: 'm:' + m.den, mul: m.mul || 1, scope: 'keep_group_filter' }
      : m.kind === 'derived' ? { kind: 'derived', expr: m.expr } : { kind: 'simple', agg: m.agg, field: m.field, dataset: m.dataset };
  }
  if (ir.unit != null && ir.unit !== '') plan.unit = ir.unit;
  if (plan.metric_ids.length === 1) plan.metric_name = (registry.metric(plan.metric_ids[0]) || {}).name || plan.metric_name;
  plan.output_shape = ir.output_shape || (plan.rank || plan.grain || plan.dimensions.length ? 'table' : 'scalar');

  // 7) IR 自己报的未决项：明确映射为澄清缺口，不当作「没有条件」
  for (const u of (ir.unresolved || [])) {
    const slot = String(u.slot || ''), reason = String(u.reason || '');
    if (reason === 'capability_gap') plan.unresolved.push({ code: CODES.CAPABILITY_GAP, message: `系统表达能力不足：${slot}`, slot });
    else if (slot==='metric'&&reason==='ambiguous'&&signals?.metricUnitEvidence&&plan.metric_ids[0]===signals.metricUnitEvidence.selected&&(!ir.formula||ir.formula.kind==='simple')&&(u.options||[]).length>1&&(u.options||[]).every(id=>signals.metricUnitEvidence.options.includes(id))) continue;
    else if (slot === 'metric') plan.unresolved.push({ code: CODES.AMBIGUOUS_METRIC, message: '指标需要确认', options: (u.options || []).map(id => { let name = id; try { name = (registry.metric(id) || {}).name || id; } catch (_) {} return { id, name }; }) });
    else if (slot === 'time_role') plan.unresolved.push({ code: CODES.MISSING_TIME_ROLE, message: '时间口径需要确认', options: (u.options || []).length ? u.options : (signals && signals.namedTimeRole ? registry.timeRoles() : registry.timeRoles()) });
    else if (slot === 'entity') plan.unresolved.push({ code: CODES.AMBIGUOUS_ENTITY, message: '对象需要确认', options: u.options || [] });
    else if (slot === 'dimension') plan.unresolved.push({ code: 'ambiguous_dim', message: '分组对象需要确认', options: u.options || [] });
    else if (slot === 'period') rejected(CODES.INVALID_PERIOD, '期间表达无法解析');
    else plan.unresolved.push({ code: reason === 'candidate_miss' ? CODES.UNKNOWN_METRIC : CODES.PLAN_INCOMPLETE, message: `未决项：${slot}`, slot });
  }
  // 已明确选定唯一候选，模型却重复报告同一槽位只有这一个候选：消除结构自相矛盾，不新增口径。
  plan.unresolved=plan.unresolved.filter(u=>!(u.code===CODES.AMBIGUOUS_METRIC&&u.options?.length===1&&String(u.options[0]?.id||u.options[0])===String(plan.metric_ids[0])));
  // 模型把其他表的日期也列为候选，但已选公式只有一个合法日期角色时，不要求用户替目录去歧义。
  if (plan.time.role && !signals?.namedTimeRole && ['simple','ratio','share'].includes(plan.formula?.kind) && !plan.formula.den_expr && !plan.formula.num_filter && !plan.formula.den_filter) {
    try {
      const refs=[...plan.metric_ids,plan.formula?.num,plan.formula?.den,plan.formula?.base].filter(Boolean);
      const dims=[...plan.dimensions,...plan.entities.map(x=>x.dim),...plan.filters.map(x=>x.dim)].filter(Boolean);
      const datasets=new Set([...refs.flatMap(id=>registry.leaves(id).map(leaf=>{const m=registry.metric(leaf);return m.dataset||m.boundTo;})),...dims.map(id=>registry.dim(id).source?.table)].filter(Boolean));
      const usable=registry.timeRoles().filter(role=>datasets.has(role.dataset));
      if(usable.length===1 && usable[0].id===plan.time.role)plan.unresolved=plan.unresolved.filter(u=>u.code!==CODES.MISSING_TIME_ROLE);
    } catch (_) {}
  }
  normalizeIRPlan(plan, ir, registry, signals && signals.text);
  plan.id = planHash(plan);
  return { plan, errors };
}

/**
 * 第三轮：「合计 / 全X」范围词规整（本机、确定性）。
 * 「四个渠道加起来 / 全渠道退货率」要的是总量：计划里却按渠道分了组 → 去掉这个分组维度。
 * 只在题面没有任何「按/各/分/每/分别/哪个…」分组说法、也没有排名时才去掉；有疑问就保持原样（交给后面的校验）。
 */
function scopeNormalize(question, plan, registry){
  try {
    if (!plan) return plan;
    normalizeSnapshotDelta(plan,registry,question);
    const text = String(question||'');
    const timeGroups=/(?:按|逐|每(?:一|个)?|各(?:个)?)(?:日|天|月|周|年|季)/.test(text);
    if(plan.grain&&(plan.dimensions||[]).length&&!timeGroups&&!/哪天|哪一天|单日|哪月|哪个月|走势|趋势|序列|时间分布|\b(?:daily|weekly|monthly|yearly|trend|series|per\s+(?:day|week|month|year)|by\s+(?:day|week|month|year))\b/i.test(text)&&/[\u3400-\u9fff]/.test(text)){
      const timeDim=plan.dimensions.some(id=>{try{return registry.dim(id).kind==='timeBucket';}catch(_){return true;}});
      if(!timeDim)plan.grain=null;
    }
    const explicitSequence=/序列|走势|趋势|逐[日月周年季]|每(?:一|个)?(?:天|日|月|周|年)|分别|各[日月周年季]|按[日月周年季].{0,4}(?:列出|展示|显示)/.test(text);
    if(/累计.{0,8}(?:多少|几)/.test(text)&&!explicitSequence&&!plan.rank&&!plan.having){plan.cumulative=false;plan.grain=null;plan.dimensions=(plan.dimensions||[]).filter(id=>{try{return registry.dim(id).kind!=='timeBucket';}catch(_){return true;}});plan.output_shape=plan.dimensions.length?'table':'scalar';}
    if(plan.output_shape==='scalar'&&!plan.rank&&!plan.having&&(!timeGroups||(/累计.{0,8}(?:多少|几)/.test(text)&&!explicitSequence))){plan.grain=null;if(plan.cumulative&&!explicitSequence)plan.cumulative=false;}
    const series = /逐[日月周年季]|每[日天月周年季]|按[日天月周年季]|各[日月周年季]|running|cumulative\s+(?:by|per|over)/i.test(text);
    if (plan.cumulative && !series) {
      plan.cumulative = false;
      const sig=extractSignals(question,{registry});
      if (!sig.grain && !plan.rank && !plan.having) {plan.grain=null;plan.dimensions=(plan.dimensions||[]).filter(id=>{try{return registry.dim(id).kind!=='timeBucket';}catch(_){return true;}});}
      if (!plan.grain && !plan.dimensions.length && !plan.rank) plan.output_shape='scalar';
      plan.id=planHash(plan);
    }
    if (!Array.isArray(plan.dimensions) || !plan.dimensions.length || plan.rank || plan.having) return plan;
    const outer = norm(String(question || '').replace(/[（(][^）)]*[）)]/g, ' '));
    const total = /加起来|合计|一共|总共|总计|总和|加总/.test(outer);
    if (/分别|各自|各个|逐个|明细/.test(outer)) return plan;
    const keep = [];
    for (const d of plan.dimensions) {
      let dd = null; try { dd = registry.dim(d); } catch (_) { dd = null; }
      if (!dd || dd.kind === 'timeBucket') { keep.push(d); continue; }
      // 同一维度上还挂着具体对象（供应商「义乌杂品」）：本来就只剩一组，不动
      if ((plan.entities || []).some(e => String(e.dim).replace(/^d:/, '') === String(dd.id))) { keep.push(d); continue; }
      const keys = uniq([dd.name, dd.id, ...(dd.match || []), ...(dd.aliases || [])].filter(Boolean).map(norm)).filter(k => k.length >= 2);
      const grouped = keys.some(k => new RegExp('(?:按|各|分|每(?:个|家|种|项)?|哪个|哪些|哪几个|哪一个)\\s*' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(outer));
      if (grouped) { keep.push(d); continue; }
      if(timeGroups&&!keys.some(k=>outer.includes(k))){(plan.scope_notes=plan.scope_notes||[]).push({dropped_dim:d,why:'unrequested_time_series_dimension'});continue;}
      // 总体占比按成员分别算；范围词不能把已选分组变成总体除以自身。
      if (!total && plan.formula?.kind === 'share') { keep.push(d); continue; }
      const mentioned = keys.filter(k => outer.includes(k));
      const scopeOnly = mentioned.length > 0 && mentioned.every(k => {
        let idx = outer.indexOf(k), ok = true;
        while (idx >= 0) {
          const before = outer.slice(Math.max(0, idx - 3), idx);
          if (!/(全|所有|全部|整体|[两三四五六七八九十几]个)$/.test(before)) { ok = false; break; }
          idx = outer.indexOf(k, idx + k.length);
        }
        return ok;
      });
      if (total || scopeOnly) { (plan.scope_notes = plan.scope_notes || []).push({ dropped_dim: d, why: total ? 'total_words' : 'scope_words' }); continue; }
      keep.push(d);
    }
    if (keep.length !== plan.dimensions.length) {
      plan.dimensions = keep;
      if (!keep.length && plan.output_shape === 'table' && !plan.grain) plan.output_shape = 'scalar';
      plan.id = planHash(plan);
    }
  } catch (_) {}
  return plan;
}

/**
 * 第三轮：模型计划的确定性规整（只做「同义改写」，不改口径）：
 *  1) 比值公式的分子/分母恰好等于某个已登记的比率指标 → 用那个指标（名称、单位、精度都按定义）；
 *     比值公式里「metric 槽」挂着与分子分母无关的指标时，不让它参与扇出判断。
 *  2) 比值/占比单位按口径算（formulaUnitOf），不信模型写的「件/件」。
 *  3) 是否类问题：indicator {op, value} 原样带进计划，由执行器在算好的值上本机比较。
 *  4) 「A 比 B 高/低多少」：pp/diff 的 left/right 不是指标、而是同一维度的两个成员 → member_diff。
 */
function normalizeSnapshotDelta(plan,registry,questionText){
  try{
    // 快照起止日变化量使用已有双期差值节点，不能只取期间末值。
    if(plan.comparison?.kind==='none'&&plan.metric_ids?.length===1&&!plan.rank&&!(plan.dimensions||[]).length&&/(?:从|由).+(?:到|至).*(?:变了?多少|变化|多了?多少|少了?多少)/.test(String(questionText||''))){
      const metric=registry.metric(plan.metric_ids[0]),p=parsePeriod(questionText,plan.time.anchor);
      if(metric.additivity==='semiAdditive'&&p?.start&&p.end&&p.start!==p.end&&plan.time.role){plan.time={...plan.time,start:p.end,end:p.end,endExclusive:timeCore.addDays(p.end,1),grain:'day',label:p.end};plan.grain=null;plan.comparison={kind:'previous_period',explicit:true,base:{start:p.start,end:p.start,endExclusive:timeCore.addDays(p.start,1)},output:'delta',policy:null};}
    }
  }catch(_){}
  return plan;
}

function normalizeIRPlan(plan, ir, registry, questionText){
  try {
    normalizeSnapshotDelta(plan,registry,questionText);
    const f0 = plan.formula;
    // 第三轮：「平均每个 SKU」的分母写成了维度编号（d:sale_sku）——意思是这个维度的去重个数：换成同表同字段的去重计数指标（唯一时）
    if (f0 && typeof f0 === 'object') for (const k of ['num', 'den', 'base']) {
      const ref = f0[k];
      if (typeof ref !== 'string' || !/^d:/.test(ref)) continue;
      let dim = null; try { dim = registry.dim(ref); } catch (_) { dim = null; }
      if (!dim || !dim.source || !dim.source.table) continue;
      const hits = [...registry.semantic.metrics.values()].filter(m => !m.unbound && m.kind === 'simple' && m.agg === 'dcount' && (m.dataset || m.boundTo) === dim.source.table && m.field === dim.source.field);
      if (hits.length === 1) f0[k] = 'm:' + hits[0].id;
    }
    // growth_rate节点已经完成(本期-基期)/|基期|；同指标跨期ratio不能再套一层比较。
    const cf=plan.formula;
    const windowMatches=(w,p)=>w&&p&&w.start===p.start&&w.end===p.end;
    const sameComparisonWindows=windowMatches(cf?.num_window,plan.time)&&windowMatches(cf?.den_window,plan.comparison?.base);
    const trivialSelfRatio=!!questionText&&!/比值|相除|除以|[\/÷]/.test(String(questionText))&&!cf?.num_window&&!cf?.den_window&&['period','same',undefined].includes(cf?.num_period)&&['period','same',undefined].includes(cf?.den_period);
    if(plan.comparison?.kind!=='none'&&plan.comparison?.output==='growth_rate'&&cf?.kind==='ratio'&&String(cf.num).replace(/^m:/,'')===String(cf.den).replace(/^m:/,'')
       &&(trivialSelfRatio||sameComparisonWindows||((['period','same',undefined].includes(cf.num_period)||cf.num_period==='period_start'&&!/期初|月初|年初|首日/.test(String(questionText||''))||cf.num_period==='period_end'&&!/期末|月末|季末|年末|月底|季底|年底|末日|最后[一1](?:天|日)|end.of|closing/i.test(String(questionText||'')))
       &&[plan.comparison.kind,'previous_period'].includes(cf.den_period)&&!cf.num_window&&!cf.den_window))&&!cf.den_expr&&!cf.num_filter&&!cf.den_filter){
      const m=registry.metric(cf.num);plan.metric_ids=['m:'+m.id];plan.formula=m.kind==='ratio'?{kind:'ratio',num:'m:'+m.num,den:'m:'+m.den,mul:m.mul??1}:{kind:'simple',field:m.field,agg:m.agg,dataset:m.dataset};
    }
    const f = plan.formula;
    const isMetric = x => typeof x === 'string' && registry.semantic.metrics.has(String(x).replace(/^m:/, ''));
    if (f && f.kind === 'ratio' && isMetric(f.num) && isMetric(f.den) && !f.den_expr && !f.num_filter && !f.den_filter && !f.num_window && !f.den_window
      && (!f.num_period || f.num_period === 'same') && (!f.den_period || f.den_period === 'same')) {
      const nid = String(f.num).replace(/^m:/, ''), did = String(f.den).replace(/^m:/, '');
      const canon = [...registry.semantic.metrics.values()].find(m => m.kind === 'ratio' && String(m.num) === nid && String(m.den) === did && !m.unbound);
      if (canon) {
        plan.metric_ids = ['m:' + canon.id];
        plan.metric_name = canon.name;
        if (f.mul == null || Number(f.mul) === Number(canon.mul || 1)) f.mul = canon.mul || f.mul;
      } else if (plan.metric_ids.length === 1 && ![nid, did].includes(String(plan.metric_ids[0]).replace(/^m:/, ''))) {
        plan.metric_ids = ['m:' + nid];
        plan.metric_name = (registry.metric('m:' + nid) || {}).name || plan.metric_name;
      }
    }
    if (f && (f.kind === 'ratio' || f.kind === 'share')) plan.unit = formulaUnitOf(registry, f);
    if (ir && ir.indicator && ir.indicator.op && ir.indicator.value != null && Number.isFinite(Number(ir.indicator.value))) {
      plan.indicator = { op: String(ir.indicator.op), value: Number(ir.indicator.value) };
      plan.unit = '';
    }
    const rf = ir && ir.formula;
    const dateDiff=rf&&rf.kind==='diff'&&timeCore.isValidDate(String(rf.left))&&timeCore.isValidDate(String(rf.right))&&plan.metric_ids.length===1;
    if(dateDiff){
      const m=registry.metric(plan.metric_ids[0]),roles=registry.timeRoles().filter(r=>r.dataset===(m.dataset||m.boundTo));
      if(plan.time.role||roles.length===1){plan.time={...plan.time,role:plan.time.role||roles[0].id,start:rf.left,end:rf.left,endExclusive:timeCore.addDays(rf.left,1),grain:'day',label:rf.left};plan.grain=null;plan.comparison={kind:'previous_period',explicit:true,base:{start:rf.right,end:rf.right},output:'delta',policy:null};plan.formula=m.kind==='ratio'?{kind:'ratio',num:'m:'+m.num,den:'m:'+m.den,mul:m.mul??1}:{kind:'simple',agg:m.agg,field:m.field,dataset:m.dataset};plan.unit=m.unit||'';}
    }

    if (!dateDiff && rf && (rf.kind === 'pp' || rf.kind === 'diff') && rf.left != null && rf.right != null && !isMetric(rf.left) && !isMetric(rf.right) && plan.metric_ids.length === 1) {
      const L = String(rf.left), R = String(rf.right);
      // 两个成员属于哪个维度：先看 IR 给的 dim，再看实体里挂的维度，再看分组维度
      const cand = [rf.dim, ...((plan.entities || []).filter(e => [L, R].includes(String(e.value))).map(e => e.dim)), ...(plan.dimensions || [])]
        .filter(Boolean).map(d => String(d).replace(/^d:/, ''));
      const dimId = cand.find(d => registry.semantic.dims.has(d));
      if (dimId) {
        // 第三轮 T4：「A 比 B 低 / 少 / 小多少」问的是低了多少（正数）= B − A；「高 / 多 / 大多少」= A − B
        const qt = String(questionText || '');
        const iL = qt.indexOf(L), iR = qt.indexOf(R);
        const lower = /比.{0,24}?(?:低|少|小|差|下降|减少)(?:了)?(?:多少|几)/.test(qt);
        let LL = L, RR = R;
        if (iL >= 0 && iR >= 0) { const first = iL < iR ? L : R, second = iL < iR ? R : L; LL = lower ? second : first; RR = lower ? first : second; }
        plan.formula = { kind: 'member_diff', dim: 'd:' + dimId, left: LL, right: RR, mul: 1, scope: 'keep_group_filter' };
        plan.entities = (plan.entities || []).filter(e => !(String(e.dim).replace(/^d:/, '') === dimId && [L, R].includes(String(e.value))));
        plan.dimensions = (plan.dimensions || []).filter(d => String(d).replace(/^d:/, '') !== dimId);
        plan.output_shape = 'scalar';
        let ps = null; try { ps = registry.percentScaleOf ? registry.percentScaleOf(plan.metric_ids[0]) : null; } catch (_) {}
        plan.unit = ps ? '个百分点' : String((registry.metric(plan.metric_ids[0]) || {}).unit || '');
      }
    }
  } catch (_) { /* 规整失败不影响原计划 */ }
  return plan;
}

/**
 * 已确认计划的精确参数匹配：只换参数（期间/实体/排名/对比），不换主题。
 * 每个约束都要重新映射；有任何新条件未覆盖就返回 null（走一次 IR 调用）。
 */
function matchConfirmedPlan(question, confirmed, o = {}){
  const registry = o.registry;
  if (!confirmed || typeof confirmed !== 'object') return { ok: false, reason: 'no_confirmed' };
  const signals = extractSignals(question, o);
  let plan;
  try {
    if (confirmed.schema && String(confirmed.schema).startsWith('ir/') && !confirmed.metric_ids) {
      const conv = irToPlan(confirmed, Object.assign({}, o, { signals }));
      if (conv.errors.length) return { ok: false, reason: 'confirmed_ir_invalid' };
      plan = conv.plan;
    } else plan = normalizePlan(confirmed);
  } catch (_) { return { ok: false, reason: 'confirmed_unreadable' }; }
  if (!plan.metric_ids || plan.metric_ids.length !== 1) return { ok: false, reason: 'confirmed_metric_not_fixed' };
  // 精确入口已核对语义/代码/权限版本；题面、锚点、时区都没变时不再让规则改写模型已验证的参数。
  if(o.sameQuestion===true&&(plan.time?.anchor||null)===(o.anchor||null)&&(plan.time?.timezone||TIMEZONE_DEFAULT)===(o.timezone||TIMEZONE_DEFAULT)){const checked=validatePlan(plan,{registry});if(!checked.ok)return {ok:false,reason:'validate_failed:'+checked.errors[0].code,errors:checked.errors};plan=checked.plan;plan.id=planHash(plan);return {ok:true,plan,signals};}

  // 新话题：题面点了别的指标 → 不拿旧计划重放
  if ((signals.metricCandidates || []).length && !signals.metricCandidates.some(id => String(id).replace(/^m:/, '') === String(plan.metric_ids[0]).replace(/^m:/, ''))) {
    return { ok: false, reason: 'new_topic_metric' };
  }
  // 新条件：题面有否定/维度而旧计划没有 → 精确参数匹配不成立
  if ((signals.negations || []).length && !(plan.negations || []).length) return { ok: false, reason: 'new_constraint_negation' };
  for (const d of (signals.dimensions || [])) {
    const did = String(d).replace(/^d:/, '');
    // 第三轮：「Amazon 渠道」里的「渠道」是对象所属的维度，不是新的分组要求——旧计划在这个维度上有对象筛选就算覆盖
    const asEntity = (plan.entities || []).some(e => String(e.dim).replace(/^d:/, '') === did) && (signals.entities || []).some(e => e && String(e.dim).replace(/^d:/, '') === did);
    if (!asEntity && !(plan.dimensions || []).some(x => String(x).replace(/^d:/, '') === did)) return { ok: false, reason: 'new_topic_dimension' };
  }
  for (const e of (signals.entities || [])) {
    if (!e || !e.dim) continue;
    const hit = (plan.entities || []).some(x => String(x.dim).replace(/^d:/, '') === String(e.dim).replace(/^d:/, ''));
    if (!hit) return { ok: false, reason: 'new_entity_dimension' };
  }

  // 参数替换：期间/实体/排名/对比/粒度
  const oldTime = Object.assign({}, plan.time || {});
  const oldEntities = (plan.entities || []).slice();
  if (signals.period) {
    if((plan.formula?.num_window||plan.formula?.den_window)&&oldTime.start&&
       (signals.period.start!==oldTime.start||signals.period.endExclusive!==oldTime.endExclusive))return {ok:false,reason:'formula_windows_need_explicit_rebind'};
    plan.time = Object.assign({}, plan.time, {
      start: signals.period.start, end: signals.period.end, endExclusive: signals.period.endExclusive,
      label: signals.period.label, grain: signals.period.grain, policy: signals.period.policy || 'relative',
      anchor: o.anchor || plan.time.anchor, timezone: signals.period.timezone || plan.time.timezone,
    });
  }
  if ((signals.entities || []).length) {
    const fresh = signals.entities.filter(e => e && e.dim && e.value != null).map(e => ({ dim: e.dim, value: String(e.value), how: 'confirmed_param' }));
    // 第三轮：本机没认出的那一维对象（模型认出来的，如二级品类「床品」）不能在重绑时丢掉；
    // 题面原句一字不差（入口精确命中）时保留旧计划里本机这次没认出的维度上的对象；换了说法的模板复用另有「对象换全」的检查
    const sameText = String(confirmed.question || '') === String(question || '') || o.sameQuestion === true;
    const freshDims = new Set(fresh.map(e => String(e.dim).replace(/^d:/, '')));
    plan.entities = sameText ? [...oldEntities.filter(e => !freshDims.has(String(e.dim).replace(/^d:/, ''))), ...fresh] : fresh;
  }
  if (signals.comparisonKind && signals.comparisonKind !== 'none') {
    plan.comparison = Object.assign({}, plan.comparison, { kind: signals.comparisonKind, explicit: true, policy: signals.comparisonKind === 'year_over_year' ? 'yoy_calendar' : 'equal_length_shift' });
  }
  // 第三轮：基期跟着新问题走（「2026-04 相比 2026-03」换成「2026-06 相比 2026-05」）；新问题没点基期就按对比口径自己推
  if (plan.comparison && plan.comparison.kind && plan.comparison.kind !== 'none') {
    const cb = signals.comparisonBase;
    let base = cb && cb.start ? { start: cb.start, end: cb.end, endExclusive: cb.endExclusive, label: cb.label || null } : null;
    // 新问题没点基期、旧计划有基期（「相比上季度」由模型算出的基期）：按本期的移动月数平移旧基期；同一句话不动
    const ob = plan.comparison.base;
    if (!base && ob && ob.start && oldTime.start && plan.time && plan.time.start) {
      try {
        const ym = x => { const [y, m] = String(x).slice(0, 7).split('-').map(Number); return y * 12 + m; };
        const dm = ym(plan.time.start) - ym(oldTime.start);
        const monthAligned = String(oldTime.start).slice(8, 10) === '01' && String(plan.time.start).slice(8, 10) === '01' && String(ob.start).slice(8, 10) === '01';
        if (dm === 0 && plan.time.start === oldTime.start) base = ob;
        else if (monthAligned) {
          const s0 = timeCore.addMonths(String(ob.start).slice(0, 10), dm);
          const ex0 = ob.endExclusive ? timeCore.addMonths(String(ob.endExclusive).slice(0, 10), dm) : timeCore.addMonths(timeCore.addDays(String(ob.end).slice(0, 10), 1), dm);
          base = { start: s0, end: timeCore.addDays(ex0, -1), endExclusive: ex0, label: null };
        }
      } catch (_) { base = null; }
    }
    plan.comparison = Object.assign({}, plan.comparison, { base });
  }
  if (signals.rank) plan.rank = Object.assign({}, plan.rank || {}, signals.rank);
  if (signals.grain) plan.grain = signals.grain;

  // 旧计划里的时间角色在新参数下仍然要成立
  if (plan.time && plan.time.start) {
    const usable = registry.timeRoles();
    if (plan.time.role && !usable.some(r => r.id === plan.time.role)) return { ok: false, reason: 'time_role_not_usable' };
    if (!plan.time.role) return { ok: false, reason: 'missing_time_role' };
  }
  const v = validatePlan(plan, { registry });
  if (!v.ok) return { ok: false, reason: 'validate_failed:' + v.errors[0].code, errors: v.errors };
  plan = v.plan;
  plan.id = planHash(plan);
  return { ok: true, plan, signals };
}

module.exports = { parsePlan, validatePlan, executePlan, normalizePlan, planHash, parsePeriod, shiftPeriod,
  extractSignals, buildIRSchema, irToPlan, validateIRShape, formulaUnitOf, normalizeIRPlan, scopeNormalize, matchConfirmedPlan, inferFormulaScale, residualConcepts, localConditionGaps, skeletonOf,
  metricCandidates, dimCandidates, comparisonBaseOf, periodMentions, unmappedConditions, structureGaps, rankTopOf, CONDITION_SLOTS,
  CODES, PLAN_SCHEMA, LEGACY_PLAN_SCHEMA, IR_SCHEMA, INTERVAL_SCHEMA, TIME_CORE_VERSION };

