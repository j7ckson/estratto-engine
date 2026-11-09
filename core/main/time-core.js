'use strict';
// ================= 公共时间模块（TIME_CORE_VERSION = 1）=================
// 为什么需要它：日期合法性、月底、闰年、时区这几件事原来在 plan-ir.parsePeriod / harness.period /
// reports.rangeOf 里各写一套（直接拼年份/月份字符串），于是 2024-02-29 同比会变成 2023-02-29，
// 2026-02-31 也照收。这里收口成唯一实现：
//   1) 日历运算交给 @js-temporal/polyfill 的 PlainDate/ZonedDateTime（Node 22 无原生 Temporal），
//      不再用字符串改年份；非法日期（2026-02-31、2026-13-01、2025-02-29…）一律拒绝。
//   2) 区间内部统一为半开区间 [start, endExclusive)，start / endExclusive 是 timezone 下的本地日期。
//      旧调用方要的闭区间 end 只在 makePeriod 的 end 字段（适配层）里由 endExclusive 减一天得到，
//      转换只做这一次，其它地方不再拼闭区间。
//   3) 业务口径不猜：同比、上一整月、等长前移、本月至今、上月同期、月末对齐各有明确的 policy 字符串，
//      返回的 period.policy 就是这次实际采用的策略（闰日同比会标明 yoy_feb29_clamp_feb28）。
// 本模块只做日历与区间语义，不做 SQL、不知道表结构；调用方负责把 period.from/to 交给计算层。

const { Temporal } = require('@js-temporal/polyfill');

const TIME_CORE_VERSION = '1';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

const CODES = Object.freeze({
  INVALID_DATE: 'invalid_date',
  INVALID_RANGE: 'invalid_range',
  INVALID_PERIOD: 'invalid_period',
  INVALID_ANCHOR: 'invalid_anchor',
  INVALID_TIMEZONE: 'invalid_timezone',
  INVALID_POLICY: 'invalid_policy',
  UNKNOWN_PERIOD: 'unknown_period',
});

// 每个业务口径一个稳定字符串；调用方按字符串记录/比对，不要靠 label 猜。
const POLICIES = Object.freeze({
  EXPLICIT: 'explicit',                                        // 用户直接给了日期/月份
  ALL: 'all',                                                  // 全部数据
  DAYS_WINDOW: 'days_window',                                  // 最近 N 天（含锚点当天）
  MTD_TO_ANCHOR: 'mtd_to_anchor',                              // 本月/月初至今：本月 1 日到锚点
  LAST_MONTH: 'last_month',                                    // 上一个自然月（整月）
  PREV_WHOLE_MONTH: 'prev_whole_month',                        // 整月 → 上一整月
  PREV_CALENDAR_GRAIN: 'prev_calendar_grain',
  PREV_EQUAL_LENGTH: 'prev_equal_length',                      // 非整月 → 等长前移
  PREV_MONTH_SAME_DAYS_CLAMP_MONTH_END: 'prev_month_same_days_clamp_month_end', // 上月同期（超出上月天数则夹到上月末）
  MONTH_END_ALIGNED: 'month_end_aligned',                      // 上个完整月：锚点是月末就算锚点所在月，否则上一整月
  YOY_SAME_MONTH_DAY: 'yoy_same_month_day_prev_year',          // 同比 = 上年同月同日
  YOY_FEB29_CLAMP_FEB28: 'yoy_feb29_clamp_feb28',              // 闰日 2/29 → 上年 2/28
  PREV_YEAR: 'prev_year',                                      // 去年整年
  YEAR_TO_ANCHOR: 'year_to_anchor',                            // 今年至今
  WEEK_TO_ANCHOR: 'week_to_anchor',                            // 本周至今（周一开始）
  PREV_WEEK: 'prev_week',                                      // 上一自然周（周一到周日）
});

class TimeCoreError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'TimeCoreError';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
  }
}

const pad2 = n => String(n).padStart(2, '0');
const monthDay = iso => String(iso).slice(5);
const todayIso = timezone => Temporal.Now.plainDateISO(normalizeTimeZone(timezone)).toString();

function normalizeTimeZone(timezone) {
  const tz = timezone == null || timezone === '' ? DEFAULT_TIMEZONE : String(timezone).trim();
  try {
    // 用一个最小 ZonedDateTime 试建，非法时区会抛 RangeError。
    Temporal.ZonedDateTime.from({ timeZone: tz, year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
    return tz;
  } catch (e) {
    throw new TimeCoreError(CODES.INVALID_TIMEZONE, '未知时区：' + tz, String(e && e.message));
  }
}

/* ---------------- 日期合法性 / 基础日历运算 ---------------- */
// 接受 'YYYY-MM-DD'、{year,month,day} 或 (y,m,d)；不存在就抛 TimeCoreError(invalid_date)。
function toPlainDate(value, month, day) {
  try {
    if (value instanceof Temporal.PlainDate) return value;
    if (month !== undefined && month !== null) return Temporal.PlainDate.from({ year: Number(value), month: Number(month), day: Number(day) }, { overflow: 'reject' });
    if (value && typeof value === 'object' && 'year' in value) return Temporal.PlainDate.from(value, { overflow: 'reject' });
    const s = String(value == null ? '' : value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RangeError('日期要写成 YYYY-MM-DD：' + s);
    return Temporal.PlainDate.from(s, { overflow: 'reject' });   // 2026-02-31 / 2026-13-01 在这里被拒
  } catch (e) {
    if (e instanceof TimeCoreError) throw e;
    throw new TimeCoreError(CODES.INVALID_DATE, '日期不存在：' + String(value), String(e && e.message));
  }
}
const toIsoDate = (value, month, day) => toPlainDate(value, month, day).toString();
const isValidDate = (value, month, day) => { try { toPlainDate(value, month, day); return true; } catch (_) { return false; } };

function addDays(date, n) { const d = toPlainDate(date); return d.add({ days: Math.trunc(Number(n)) }).toString(); }
// 加月用 constrain：1/31 + 1 月 = 2/28（业务上比 3/3 更不易错），闰日同比由 shiftPeriod 单独声明策略。
function addMonths(date, n) { const d = toPlainDate(date); return d.add({ months: Math.trunc(Number(n)) }, { overflow: 'constrain' }).toString(); }
const nextDay = date => addDays(date, 1);
const prevDay = date => addDays(date, -1);
const monthStart = date => toPlainDate(date).with({ day: 1 }).toString();
const monthEnd = date => toPlainDate(date).with({ day: 1 }).add({ months: 1 }).subtract({ days: 1 }).toString();
const isMonthEnd = date => monthEnd(date) === toIsoDate(date);
const daysInMonth = date => toPlainDate(monthEnd(date)).day;
const daysBetween = (from, to) => toPlainDate(to).since(toPlainDate(from), { largestUnit: 'days' }).days;
const weekStart = date => { const d = toPlainDate(date); return d.subtract({ days: d.dayOfWeek - 1 }).toString(); };   // 周一为一周第一天

// 本地日期 → 该时区当天 00:00 的 ZonedDateTime（要实例/时间戳时用；计算层仍用本地日期）。
function startOfDay(date, timezone) {
  const tz = normalizeTimeZone(timezone);
  const d = toPlainDate(date);
  return Temporal.ZonedDateTime.from({ timeZone: tz, year: d.year, month: d.month, day: d.day, hour: 0, minute: 0, second: 0 });
}

/* ---------------- period 结构 ---------------- */
// 内部规范：{start, endExclusive} 半开；end 是适配旧调用的闭区间（= endExclusive - 1 天）。
function makePeriod(o) {
  const src = o || {};
  const start = src.start == null || src.start === '' ? null : toIsoDate(src.start);
  const endExclusive = src.endExclusive == null || src.endExclusive === '' ? null : toIsoDate(src.endExclusive);
  if ((start == null) !== (endExclusive == null)) throw new TimeCoreError(CODES.INVALID_PERIOD, '时间区间必须同时有 start 和 endExclusive（或都没有）');
  if (start && start >= endExclusive) throw new TimeCoreError(CODES.INVALID_RANGE, '开始日期晚于结束日期：' + start + ' > ' + endExclusive);
  const per = {
    version: TIME_CORE_VERSION,
    start,
    endExclusive,
    // inclusive end 仅适配层：旧调用方（plan-ir / harness）要闭区间；内部一律用 endExclusive。
    end: endExclusive ? prevDay(endExclusive) : null,
    timezone: src.timezone || DEFAULT_TIMEZONE,
    grain: src.grain || (start ? inferGrain(start, endExclusive) : 'all'),
    anchor: src.anchor || null,
    label: src.label != null ? String(src.label) : (start ? start + '~' + prevDay(endExclusive) : '全部数据'),
    policy: src.policy || POLICIES.EXPLICIT,
    explicit: !!src.explicit,
  };
  if (src.relative) per.relative = true;
  if (src.partial !== undefined) per.partial = !!src.partial;
  if (src.clamped !== undefined) per.clamped = !!src.clamped;
  return per;
}

function inferGrain(start, endExclusive) {
  if (!start || !endExclusive) return 'all';
  try {
    if (start === monthStart(start) && endExclusive === nextDay(monthEnd(start))) return 'month';
    if (start.slice(5) === '01-01' && endExclusive.slice(5) === '01-01' && Number(endExclusive.slice(0, 4)) - Number(start.slice(0, 4)) === 1) return 'year';
  } catch (_) { /* 落到 day */ }
  return 'day';
}

// 接受旧的 {start,end} 闭区间、新的 {start,endExclusive}，或 harness 的 {from,endExclusive}。
function normalizePeriod(per, opts) {
  if (!per) return null;
  const o = opts || {};
  const timezone = normalizeTimeZone(per.timezone || o.timezone || DEFAULT_TIMEZONE);
  const start = per.start != null && per.start !== '' ? per.start : (per.from != null && per.from !== '' ? per.from : null);
  let endExclusive = per.endExclusive != null && per.endExclusive !== '' ? per.endExclusive : null;
  if (!endExclusive && per.end != null && per.end !== '') endExclusive = nextDay(per.end);   // 旧闭区间：唯一一次转换
  if (start == null || endExclusive == null) throw new TimeCoreError(CODES.INVALID_PERIOD, '时间区间要有 start 和 end/endExclusive');
  const s = toIsoDate(start), e = toIsoDate(endExclusive);
  if (s >= e) throw new TimeCoreError(CODES.INVALID_RANGE, '开始日期晚于结束日期：' + s + ' > ' + e);
  return makePeriod({
    start: s, endExclusive: e, timezone,
    grain: per.grain || inferGrain(s, e),
    anchor: per.anchor || null,
    label: per.label != null ? per.label : s + '~' + prevDay(e),
    policy: per.policy || POLICIES.EXPLICIT,
    explicit: per.explicit,
    relative: per.relative,
    partial: per.partial,
  });
}

const inclusiveEnd = per => (per ? per.end : null);
const exclusiveEnd = per => (per ? per.endExclusive : null);

/* ---------------- 文本 → period ---------------- */
// text 认：全部 / YYYY-MM-DD~YYYY-MM-DD / 2026年9月1日~2026年9月30日 / 单日 / 2026-09 / 2026年9月 /
// 9月 / 最近N天 / 本月 / 本月至今 / 上月 / 上个完整月 / 本周 / 上周 / 今年 / 去年 / 2026年。
// 非法日期或反向区间：strict=false 返回 null（旧调用方兼容），strict=true 抛 TimeCoreError
// （code 会说明是 invalid_date / invalid_range / unknown_period，调用方可据此给用户提示）。
function parsePeriod(text, opts) {
  const o = opts || {};
  const timezone = normalizeTimeZone(o.timezone || DEFAULT_TIMEZONE);
  const anchor = resolveAnchor(o.anchor, timezone);
  const s = String(text == null ? '' : text).replace(/\s+/g, '');
  try {
    const per = parsePeriodInner(s, toPlainDate(anchor), anchor, timezone);
    if (per) return per;
    if (o.strict) throw new TimeCoreError(CODES.UNKNOWN_PERIOD, '认不出时间：' + String(text));
    return null;
  } catch (e) {
    if (e instanceof TimeCoreError) { if (o.strict) throw e; return null; }
    throw e;
  }
}

function parsePeriodInner(s, A, anchorIso, timezone) {
  if (!s) return null;
  if (s === '全部' || s === '全部数据' || s === 'all') return allPeriod(timezone);
  let m;
  // 1) 显式区间（闭区间输入 → 内部半开）
  if ((m = /(\d{4}-\d{2}-\d{2})[~～至到](\d{4}-\d{2}-\d{2})/.exec(s))) return explicitRange(m[1], m[2], timezone, anchorIso);
  if ((m = /(\d{4})年(\d{1,2})月(\d{1,2})日?[~～至到](\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(s)))
    return explicitRange(toIsoDate({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }), toIsoDate({ year: Number(m[4]), month: Number(m[5]), day: Number(m[6]) }), timezone, anchorIso);
  // 2) 显式单日
  if ((m = /^(\d{4}-\d{2}-\d{2})$/.exec(s))) return singleDay(m[1], timezone, anchorIso);
  if ((m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s))) return singleDay(toIsoDate({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }), timezone, anchorIso);
  // 3) 显式月
  if ((m = /^(\d{4})-(\d{2})$/.exec(s))) return monthPeriod(Number(m[1]), Number(m[2]), String(Number(m[1])) + '年' + Number(m[2]) + '月', timezone, anchorIso, false);
  if ((m = /^(\d{4})年(\d{1,2})月$/.exec(s))) return monthPeriod(Number(m[1]), Number(m[2]), Number(m[1]) + '年' + Number(m[2]) + '月', timezone, anchorIso, false);
  if ((m = /^(\d{1,2})月$/.exec(s))) {
    const mo = Number(m[1]);
    if (mo < 1 || mo > 12) throw new TimeCoreError(CODES.INVALID_DATE, '月份不存在：' + mo);
    const y = mo > A.month ? A.year - 1 : A.year;   // 没说年份就按锚点：还没到的月份算去年
    return monthPeriod(y, mo, y + '年' + mo + '月', timezone, anchorIso, true);
  }
  // 4) 相对期间
  if ((m = /^(?:最近|近)(\d{1,3})天$/.exec(s))) {
    const n = Number(m[1]);
    if (n < 1) throw new TimeCoreError(CODES.INVALID_RANGE, '最近N天的 N 要 ≥ 1');
    return makePeriod({ start: addDays(anchorIso, -(n - 1)), endExclusive: nextDay(anchorIso), timezone, grain: 'day', anchor: anchorIso, label: '最近' + n + '天', policy: POLICIES.DAYS_WINDOW, explicit: true, relative: true });
  }
  // 最近N个月 / 最近N周：滚动窗口（含锚点当天），与「上个月」（自然月）区分；标签写明滚动天数，避免和自然月混淆。
  if ((m = /^(?:最近|近|过去)(一|两|二|三|四|五|六|九|十二|\d{1,2})个?(月|周|星期)$/.exec(s))) {
    const CN = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 九: 9, 十二: 12 };
    const n = CN[m[1]] || Number(m[1]);
    if (!(n >= 1)) throw new TimeCoreError(CODES.INVALID_RANGE, '最近N个月/周的 N 要 ≥ 1');
    const week = m[2] !== '月';
    const start = week ? addDays(anchorIso, -(7 * n - 1)) : addDays(addMonths(anchorIso, -n), 1);
    const days = daysBetween(start, nextDay(anchorIso));
    return makePeriod({ start, endExclusive: nextDay(anchorIso), timezone, grain: 'day', anchor: anchorIso,
      label: '最近' + m[1] + (week ? '周' : '个月') + '（滚动' + days + '天）', policy: POLICIES.DAYS_WINDOW, explicit: true, relative: true });
  }
  if (s === '本月' || s === '这个月' || s === '本月至今' || s === '月初至今') {
    return makePeriod({ start: monthStart(anchorIso), endExclusive: nextDay(anchorIso), timezone, grain: 'month', anchor: anchorIso,
      label: s === '本月' || s === '这个月' ? '本月' : '本月至今', policy: POLICIES.MTD_TO_ANCHOR, explicit: true, relative: true,
      partial: !isMonthEnd(anchorIso) });
  }
  if (s === '上月' || s === '上个月') {
    const cur = monthStart(anchorIso);
    return makePeriod({ start: monthStart(prevDay(cur)), endExclusive: cur, timezone, grain: 'month', anchor: anchorIso, label: '上月', policy: POLICIES.LAST_MONTH, explicit: true, relative: true });
  }
  if (/^(?:上一个完整月|上个完整月|最近完整月|最近一个完整月)$/.test(s)) {
    return makePeriod(Object.assign({}, rangeOf('month', { anchor: anchorIso, timezone }), { label: '上个完整月', explicit: true, relative: true }));
  }
  if (s === '本周' || s === '这周') {
    const ws = weekStart(anchorIso);
    return makePeriod({ start: ws, endExclusive: nextDay(anchorIso), timezone, grain: 'day', anchor: anchorIso, label: '本周', policy: POLICIES.WEEK_TO_ANCHOR, explicit: true, relative: true });
  }
  if (s === '上周') {
    const ws = weekStart(anchorIso);
    return makePeriod({ start: addDays(ws, -7), endExclusive: ws, timezone, grain: 'day', anchor: anchorIso, label: '上周', policy: POLICIES.PREV_WEEK, explicit: true, relative: true });
  }
  if (s === '今年' || s === '今年至今') {
    return makePeriod({ start: anchorIso.slice(0, 4) + '-01-01', endExclusive: nextDay(anchorIso), timezone, grain: 'year', anchor: anchorIso, label: '今年', policy: POLICIES.YEAR_TO_ANCHOR, explicit: true, relative: true });
  }
  if (s === '去年') {
    const y = Number(anchorIso.slice(0, 4)) - 1;
    return makePeriod({ start: String(y).padStart(4, '0') + '-01-01', endExclusive: String(y + 1).padStart(4, '0') + '-01-01', timezone, grain: 'year', anchor: anchorIso, label: '去年', policy: POLICIES.PREV_YEAR, explicit: true, relative: true });
  }
  if ((m = /^(\d{4})年$/.exec(s))) {
    const y = Number(m[1]);
    return makePeriod({ start: String(y).padStart(4, '0') + '-01-01', endExclusive: String(y + 1).padStart(4, '0') + '-01-01', timezone, grain: 'year', anchor: anchorIso, label: y + '年', policy: POLICIES.EXPLICIT, explicit: true });
  }
  return null;
}

function resolveAnchor(anchor, timezone) {
  try {
    if (anchor == null || anchor === '') return todayIso(timezone);
    if (anchor instanceof Temporal.PlainDate || anchor instanceof Temporal.ZonedDateTime) return anchor.toPlainDate ? anchor.toPlainDate().toString() : anchor.toString();
    return toIsoDate(anchor);
  } catch (e) {
    if (e instanceof TimeCoreError) throw new TimeCoreError(CODES.INVALID_ANCHOR, '锚点日期不存在：' + String(anchor), e.detail);
    throw e;
  }
}

const allPeriod = timezone => makePeriod({ start: null, endExclusive: null, timezone, grain: 'all', label: '全部数据', policy: POLICIES.ALL });

function singleDay(iso, timezone, anchorIso) {
  const d = toIsoDate(iso);
  return makePeriod({ start: d, endExclusive: nextDay(d), timezone, grain: 'day', anchor: anchorIso, label: d, policy: POLICIES.EXPLICIT, explicit: true });
}

function explicitRange(a, b, timezone, anchorIso) {
  const start = toIsoDate(a), end = toIsoDate(b);
  if (start > end) throw new TimeCoreError(CODES.INVALID_RANGE, '开始日期晚于结束日期：' + start + ' > ' + end);
  return makePeriod({ start, endExclusive: nextDay(end), timezone, grain: 'day', anchor: anchorIso, label: start + '~' + end, policy: POLICIES.EXPLICIT, explicit: true });
}

function monthPeriod(year, month, label, timezone, anchorIso, relative) {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new TimeCoreError(CODES.INVALID_DATE, '月份不存在：' + month);
  const start = toIsoDate({ year, month, day: 1 });
  return makePeriod({ start, endExclusive: nextDay(monthEnd(start)), timezone, grain: 'month', anchor: anchorIso, label, policy: POLICIES.EXPLICIT, explicit: true, relative: !!relative });
}

/* ---------------- 向前 / 同比 ---------------- */
// kind：year_over_year（去年同期）/ previous_period（上一段：整月→上一整月，非整月→等长前移）
//       也可显式要 prev_whole_month / prev_month_same_days / equal_length；opts.policy 可强制同名策略。
// 输入可带 start+end（旧闭区间）或 start+endExclusive；输出一定有 start/end/endExclusive/label/grain/timezone/policy。
function shiftPeriod(per, kind, opts) {
  if (!per) return null;
  const o = opts || {};
  const k = shiftKind(kind);
  const timezone = normalizeTimeZone(per.timezone || o.timezone || DEFAULT_TIMEZONE);
  const base = normalizePeriod(per, { timezone });
  const start = base.start, endExclusive = base.endExclusive, endInclusive = base.end;
  const policy = o.policy ? String(o.policy) : null;
  if (policy && !Object.values(POLICIES).includes(policy)) throw new TimeCoreError(CODES.INVALID_POLICY, '不认识的时间策略：' + policy);
  const finish = patch => makePeriod(Object.assign({ timezone, anchor: base.anchor, grain: base.grain }, patch));

  // 同比：先按闭区间端点各减一年（闰日 2/29 constrain 到 2/28），再恢复半开上界；
  // 不能对半开上界减年，否则 2024-02-28~2024-02-28 会变成 2023-02-27。
  if (k === 'yoy' || policy === POLICIES.YOY_SAME_MONTH_DAY || policy === POLICIES.YOY_FEB29_CLAMP_FEB28) {
    const newStart = toIsoDate(toPlainDate(start).subtract({ years: 1 }, { overflow: 'constrain' }));
    const newEndInclusive = toIsoDate(toPlainDate(endInclusive).subtract({ years: 1 }, { overflow: 'constrain' }));
    const clamped = monthDay(start) === '02-29' || monthDay(endInclusive) === '02-29';
    return finish({ start: newStart, endExclusive: nextDay(newEndInclusive), label: '去年同期', policy: clamped ? POLICIES.YOY_FEB29_CLAMP_FEB28 : POLICIES.YOY_SAME_MONTH_DAY, clamped });
  }

  if(k==='prev'&&!policy&&['quarter','year'].includes(base.grain)){
    const months=base.grain==='year'?12:3,sd=toPlainDate(start);
    const aligned=sd.day===1&&(base.grain==='year'?sd.month===1:[1,4,7,10].includes(sd.month));
    if(aligned&&toIsoDate(sd.add({months}))===endExclusive)return finish({start:toIsoDate(sd.subtract({months})),endExclusive:start,label:'上一自然'+(base.grain==='year'?'年':'季度'),policy:POLICIES.PREV_CALENDAR_GRAIN});
  }
  const wholeMonth = start === monthStart(start) && endExclusive === nextDay(monthEnd(start));
  const sameMonth = start.slice(0, 7) === endInclusive.slice(0, 7);
  const choose = policy === POLICIES.PREV_WHOLE_MONTH ? 'whole'
    : policy === POLICIES.PREV_EQUAL_LENGTH ? 'equal'
    : policy === POLICIES.PREV_MONTH_SAME_DAYS_CLAMP_MONTH_END ? 'same_days'
    : k === 'prev_whole_month' ? 'whole'
    : k === 'prev_month_same_days' ? 'same_days'
    : k === 'equal_length' ? 'equal'
    : wholeMonth ? 'whole'
    : (start === monthStart(start) && sameMonth ? 'same_days' : 'equal');

  if (choose === 'whole') return finish({ start: monthStart(prevDay(start)), endExclusive: start, label: '上一段', policy: POLICIES.PREV_WHOLE_MONTH });
  if (choose === 'same_days') {
    // 本月至今 → 上月同期：上月 1 日到「同一天」，超过上月天数就夹到上月末。
    const prevStart = monthStart(prevDay(start));
    const last = monthEnd(prevStart);
    const want = Number(endInclusive.slice(8, 10));
    const day = Math.min(want, Number(last.slice(8, 10)));
    return finish({ start: prevStart, endExclusive: nextDay(prevStart.slice(0, 7) + '-' + pad2(day)), label: '上一段', policy: POLICIES.PREV_MONTH_SAME_DAYS_CLAMP_MONTH_END, clamped: day < want });
  }
  // 非整月：等长前移（半开区间天数 == 旧闭区间天数）
  const len = daysBetween(start, endExclusive);
  return finish({ start: addDays(start, -len), endExclusive: start, label: '上一段', policy: POLICIES.PREV_EQUAL_LENGTH });
}

function shiftKind(kind) {
  const s = String(kind == null ? '' : kind).trim();
  const map = {
    year_over_year: 'yoy', '去年同期': 'yoy', '同比': 'yoy', yoy: 'yoy',
    previous_period: 'prev', '上一段': 'prev', previous: 'prev', prev: 'prev',
    prev_whole_month: 'prev_whole_month', '上一整月': 'prev_whole_month',
    prev_month_same_days: 'prev_month_same_days', '上月同期': 'prev_month_same_days',
    equal_length: 'equal_length', '等长前移': 'equal_length',
  };
  if (!map[s]) throw new TimeCoreError(CODES.INVALID_POLICY, '不认识的向前/同比口径：' + String(kind));
  return map[s];
}

/* ---------------- 报表 / 看板用的相对区间 ---------------- */
// kind 认规范码（all/7d/30d/month/mtd/lastmonth）与中文（全部数据/最近7天/最近30天/上个完整月/本月/上月）；
// anchor 是数据最新一天（或调用方指定的锚点），不是机器今天。
const RANGE_LABELS = Object.freeze({ all: '全部数据', '7d': '最近 7 天', '30d': '最近 30 天', month: '上个完整月', mtd: '本月至今（不完整月）', lastmonth: '上一个自然月' });
function rangeOf(kind, opts) {
  const o = opts || {};
  const k = rangeKind(kind);
  if (!k) {
    if (o.strict) throw new TimeCoreError(CODES.UNKNOWN_PERIOD, '不认识的报告时间：' + String(kind));
    return null;
  }
  const timezone = normalizeTimeZone(o.timezone || DEFAULT_TIMEZONE);
  if (k === 'all') return allPeriod(timezone);
  const anchor = resolveAnchor(o.anchor, timezone);
  const a = toPlainDate(anchor);
  const base = { timezone, anchor, label: RANGE_LABELS[k], explicit: false, relative: true };
  if (k === '7d' || k === '30d') {
    const n = k === '7d' ? 7 : 30;
    return makePeriod(Object.assign({ start: addDays(anchor, -(n - 1)), endExclusive: nextDay(anchor), grain: 'day', policy: POLICIES.DAYS_WINDOW }, base));
  }
  if (k === 'mtd') {
    return makePeriod(Object.assign({ start: monthStart(anchor), endExclusive: nextDay(anchor), grain: 'month', policy: POLICIES.MTD_TO_ANCHOR, partial: !isMonthEnd(anchor) }, base));
  }
  if (k === 'lastmonth') {
    const cur = monthStart(anchor);
    return makePeriod(Object.assign({ start: monthStart(prevDay(cur)), endExclusive: cur, grain: 'month', policy: POLICIES.LAST_MONTH }, base));
  }
  // month（上个完整月）：锚点正好是月末 → 锚点所在整月；否则 → 上一整月。
  const cur = monthStart(anchor);
  const whole = isMonthEnd(anchor);
  return makePeriod(Object.assign({ start: whole ? cur : monthStart(prevDay(cur)), endExclusive: whole ? nextDay(anchor) : cur, grain: 'month', policy: POLICIES.MONTH_END_ALIGNED }, base));
}
function rangeKind(kind) {
  const s = String(kind == null ? '' : kind).trim();
  const map = {
    all: 'all', '全部': 'all', '全部数据': 'all',
    '7d': '7d', '最近7天': '7d', '最近 7 天': '7d',
    '30d': '30d', '最近30天': '30d', '最近 30 天': '30d',
    mtd: 'mtd', '本月': 'mtd', '本月至今': 'mtd', '本月至今（不完整月）': 'mtd', '月初至今': 'mtd',
    lastmonth: 'lastmonth', '上月': 'lastmonth', '上个月': 'lastmonth', '上一个自然月': 'lastmonth',
    month: 'month', '上个完整月': 'month', '上一个完整月': 'month', '最近完整月': 'month',
  };
  return map[s] || null;
}

/* ---------------- 明确业务口径的具名函数 ---------------- */
const monthToDate = (anchor, opts) => rangeOf('mtd', Object.assign({}, opts, { anchor }));
const monthEndAligned = (anchor, opts) => rangeOf('month', Object.assign({}, opts, { anchor }));
const lastMonth = (anchor, opts) => rangeOf('lastmonth', Object.assign({}, opts, { anchor }));
const yearOverYear = (per, opts) => shiftPeriod(per, 'year_over_year', opts);
const prevMonthSameDays = (per, opts) => shiftPeriod(per, 'prev_month_same_days', opts);

// 锚点所在月之前的最后一个完整自然月（不判断锚点是否月末，月末对齐请用 monthEndAligned）。
function prevWholeMonth(anchor, opts) {
  const o = opts || {};
  const timezone = normalizeTimeZone(o.timezone || DEFAULT_TIMEZONE);
  const a = resolveAnchor(anchor, timezone);
  const cur = monthStart(a);
  return makePeriod({ start: monthStart(prevDay(cur)), endExclusive: cur, timezone, grain: 'month', anchor: a, label: '上一整月', policy: POLICIES.PREV_WHOLE_MONTH, relative: true });
}

module.exports = {
  TIME_CORE_VERSION, DEFAULT_TIMEZONE, CODES, POLICIES, TimeCoreError, RANGE_LABELS,
  // 日期合法性 / 日历运算
  isValidDate, toIsoDate, parseDate: toIsoDate, toPlainDate,
  addDays, addMonths, nextDay, prevDay, monthStart, monthEnd, isMonthEnd, daysInMonth, daysBetween, weekStart,
  startOfDay, todayIn: todayIso,
  // period
  makePeriod, normalizePeriod, inclusiveEnd, exclusiveEnd,
  parsePeriod, shiftPeriod, shiftKind, rangeOf, rangeKind,
  // 具名业务口径
  monthToDate, monthEndAligned, lastMonth, prevWholeMonth, prevMonthSameDays, yearOverYear,
};
