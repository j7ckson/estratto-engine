// ================= 文本日期的格式识别（10-23）=================
// 为什么：英文导出（Facebook / Google Ads / Shopify / UCI Online Retail）里日期常是文字，而且不是 2021-10-21：
//   10/21/2021（月/日/年）、10/21/2021 3:45 PM、21/10/2021（日/月/年）、2021/10/21、Oct 21, 2021、12/1/2010 8:26。
//   直接 CAST(列 AS DATE) 会报错或变成空，导入也会把它们丢成 NULL。
// 做法：拿列里的样本（最多 2000 个非空值，只在本机看），把可能的写法一个个试，
//   ≥95% 的样本能按某个写法解析才算认出；某一位出现 >12 就能定下是日还是月；全都 ≤12 时按「月/日/年」并标 ambiguous。
// 不依赖任何别的模块（导入线程和主程序都要用）。
'use strict';

const MAX_SAMPLES = 2000;
const NEED = 0.95;

// 日期部分的写法（DuckDB strptime 格式串）。顺序就是「平手时谁优先」：月/日/年排在日/月/年前面
const BODIES = [];
for (const sep of ['/', '-', '.']) for (const y of ['%Y', '%y']) BODIES.push(`%m${sep}%d${sep}${y}`, `%d${sep}%m${sep}${y}`);
BODIES.push('%Y/%m/%d', '%Y.%m.%d',
  '%b %d, %Y', '%b %d %Y', '%B %d, %Y', '%B %d %Y', '%d %b %Y', '%d %B %Y', '%d %b, %Y',
  '%d-%b-%Y', '%d-%b-%y', '%d/%b/%Y', '%b-%d-%Y');
// 时间部分的写法（可以没有）
const TIMES = ['', ' %H:%M', ' %H:%M:%S', ' %I:%M %p', ' %I:%M:%S %p', ' %I:%M%p', ' %I:%M:%S%p'];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// 把格式串变成「正则 + 每个括号对应哪一项」
const compiled = new Map();
function compile(fmt){
  if (compiled.has(fmt)) return compiled.get(fmt);
  const order = []; let re = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '%') {
      const t = fmt[++i]; order.push(t);
      re += t === 'Y' ? '(\\d{4})' : t === 'y' ? '(\\d{2})' : t === 'm' || t === 'd' || t === 'H' || t === 'I' ? '(\\d{1,2})'
        : t === 'M' || t === 'S' ? '(\\d{2})' : t === 'p' ? '([AaPp][Mm])' : t === 'b' ? '([A-Za-z]{3})' : '([A-Za-z]{3,9})';
    } else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const out = { re: new RegExp('^' + re + '$'), order };
  compiled.set(fmt, out);
  return out;
}
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// 按格式把一个文字拆成 {y,m,d,H,M,S}；对不上或日期不存在（2 月 30 日）返回 null
function parts(s, fmt){
  const c = compile(fmt), m = c.re.exec(String(s).trim());
  if (!m) return null;
  const o = { y: null, m: null, d: null, H: 0, M: 0, S: 0, pm: null };
  for (let i = 0; i < c.order.length; i++) {
    const t = c.order[i], v = m[i + 1];
    if (t === 'Y') o.y = +v;
    else if (t === 'y') o.y = +v >= 69 ? 1900 + +v : 2000 + +v;   // 和 DuckDB 一样：69–99 算 19xx，00–68 算 20xx
    else if (t === 'm') o.m = +v;
    else if (t === 'd') o.d = +v;
    else if (t === 'H' || t === 'I') o.H = +v;
    else if (t === 'M') o.M = +v;
    else if (t === 'S') o.S = +v;
    else if (t === 'p') o.pm = /^p/i.test(v);
    else if (t === 'b') { const k = MONTHS.indexOf(v.toLowerCase()); if (k < 0) return null; o.m = k + 1; }
    else if (t === 'B') { const k = LONG.indexOf(v.toLowerCase()); if (k < 0) return null; o.m = k + 1; }
  }
  if (o.y == null || o.m == null || o.d == null) return null;
  if (o.m < 1 || o.m > 12 || o.d < 1 || o.d > daysIn(o.y, o.m)) return null;
  if (c.order.includes('I')) { if (o.H < 1 || o.H > 12) return null; o.H = (o.H % 12) + (o.pm ? 12 : 0); }
  if (o.H > 23 || o.M > 59 || o.S > 59) return null;
  return o;
}
const p2 = n => String(n).padStart(2, '0');
/** 按格式把文字转成 YYYY-MM-DD（导入时算日期范围用）；对不上返回 null */
function parseDate(s, fmt){
  const o = parts(s, fmt);
  return o ? `${String(o.y).padStart(4, '0')}-${p2(o.m)}-${p2(o.d)}` : null;
}

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
// 月和日换个位置（%m/%d/%Y ↔ %d/%m/%Y）；不是「月日」「日月」开头的返回 null
const swapMD = fmt => { const m = /^%([md])(.)%([md])(.*)$/s.exec(fmt); return m && m[1] !== m[3] ? `%${m[3]}${m[2]}%${m[1]}${m[4]}` : null; };

/**
 * 认一列文本日期的写法。
 * @param {string[]} samples 这一列的值（本机取的，最多看 2000 个非空值）
 * @returns {{format:string, iso:boolean, ambiguous:boolean, confidence:number, hasTime:boolean}|null} 认不出返回 null
 */
function detectDateFormat(samples){
  const vals = [];
  for (const x of (Array.isArray(samples) ? samples : [])) {
    if (x == null) continue;
    const s = String(x).trim();
    if (s) vals.push(s);
    if (vals.length >= MAX_SAMPLES) break;
  }
  if (!vals.length) return null;
  const n = vals.length;
  // 1) 标准写法（2021-10-21 / 2021-10-21 15:45:00）：保持现状，CAST 就能转
  let iso = 0, isoTime = 0;
  for (const s of vals) { const m = ISO_RE.exec(s); if (m && parts(`${m[1]}-${m[2]}-${m[3]}`, '%Y-%m-%d')) { iso++; if (m[4] != null) isoTime++; } }
  if (iso / n >= NEED) {
    const hasTime = isoTime / n >= 0.5;
    return { format: hasTime ? '%Y-%m-%d %H:%M:%S' : '%Y-%m-%d', iso: true, ambiguous: false, confidence: iso / n, hasTime };
  }
  // 2) 别的写法：逐个试，≥95% 能解析的留下；解析得最多的优先，平手取排在前面的（月/日/年优先于日/月/年）
  const need = Math.ceil(n * NEED), allowBad = n - need;
  const good = [];
  for (const body of BODIES) for (const tm of TIMES) {
    const fmt = body + tm;
    let ok = 0, bad = 0;
    for (const s of vals) { if (parts(s, fmt)) ok++; else if (++bad > allowBad) break; }
    if (bad <= allowBad && ok >= need) good.push({ fmt, body, ok });
  }
  if (!good.length) return null;
  good.sort((a, b) => b.ok - a.ok);     // 稳定排序：平手保持上面的优先顺序
  let pick = good[0];
  // 歧义：「月/日」和「日/月」两种读法一样好 = 每个值的前两位都 ≤12，没有哪位 >12 帮着定下来
  const sw = swapMD(pick.fmt), twin = sw ? good.find(g => g.fmt === sw && g.ok === pick.ok) : null;
  // 点号分隔（21.10.2021）在欧洲是日.月.年：真有歧义时偏向日/月/年
  if (twin && /^%m\./.test(pick.fmt)) pick = twin;
  return { format: pick.fmt, iso: false, ambiguous: !!twin, confidence: pick.ok / n, hasTime: /%[HI]/.test(pick.fmt) };
}

/**
 * 把一列文本日期写成 DuckDB 的日期表达式。
 * fmt：detectDateFormat 的结果，或直接是格式串；iso / 没有格式 → 保持现状（CAST）。
 * opts.asDate：true 时不论带不带时间都给 DATE（按天比较、分桶用）。
 */
function sqlDateExpr(colSql, fmt, opts){
  const o = opts || {};
  const f = fmt && typeof fmt === 'object' ? fmt : { format: fmt || null, iso: !fmt };
  const hasTime = /%[HI]/.test(String(f.format || ''));
  if (!f.format || f.iso) return o.asDate || !hasTime ? `CAST(${colSql} AS DATE)` : `CAST(${colSql} AS TIMESTAMP)`;
  const t = `TRY_STRPTIME(CAST(${colSql} AS VARCHAR), '${String(f.format).replace(/'/g, "''")}')`;
  return o.asDate || !hasTime ? `CAST(${t} AS DATE)` : t;
}

// 格式串 → 一句大白话（给提示词和界面用）：%m/%d/%Y → 月/日/年
function describeFormat(fmt){
  const f = fmt && typeof fmt === 'object' ? fmt.format : fmt;
  if (!f) return '';
  const date = String(f).split(' %H')[0].split(' %I')[0];
  const names = { '%m': '月', '%d': '日', '%Y': '年', '%y': '年', '%b': '月', '%B': '月' };
  return (date.match(/%[mdYybB]/g) || []).map(t => names[t]).join('/') + (/%[HI]/.test(f) ? '（带时间）' : '');
}

// 10-24 日期顺序确认：从本列样本里挑一个最能说明问题的（前两位不一样的，月日对调才看得出区别），没有就取第一个能按格式解析的
function pickDateSample(samples, fmt){
  let first = null;
  for (const x of (Array.isArray(samples) ? samples : [])) {
    if (x == null) continue;
    const s = String(x).trim(); if (!s) continue;
    const o = parts(s, fmt); if (!o) continue;
    if (first == null) first = s;
    if (o.m !== o.d) return s;
  }
  return first;
}
// 一句大白话 + 用本列真实样本举例：「按 月/日/年 理解：10/21/2021 = 2021 年 10 月 21 日」。只在本机界面用，样本不发给模型
function describeDateFormat(fmt, sample){
  const f = fmt && typeof fmt === 'object' ? fmt.format : fmt;
  if (!f) return '';
  const head = `按 ${describeFormat(f).replace('（带时间）', '')} 理解`;
  const o = sample != null && String(sample).trim() ? parts(sample, f) : null;
  if (!o) return head;
  return `${head}：${String(sample).trim()} = ${o.y} 年 ${o.m} 月 ${o.d} 日`;
}
// 月/日 ↔ 日/月 互换后的另一种读法；不是「月日」「日月」开头的（年月日、英文月份）没有另一种读法，返回 null
function alternativeFormat(fmt){
  const f = fmt && typeof fmt === 'object' ? fmt.format : fmt;
  return f ? swapMD(String(f)) : null;
}
// 给界面的一道题：{ sample, options:[{fmt, text}, {fmt, text}] }；没有另一种读法就只有一个选项
function dateQuestionOptions(fmt, sample){
  const f = fmt && typeof fmt === 'object' ? fmt.format : fmt;
  if (!f) return { sample: sample || null, options: [] };
  const alt = alternativeFormat(f);
  const options = [{ fmt: f, text: describeDateFormat(f, sample) }];
  if (alt) options.push({ fmt: alt, text: describeDateFormat(alt, sample) });
  return { sample: sample || null, options };
}

module.exports = { detectDateFormat, sqlDateExpr, parseDate, describeFormat, describeDateFormat, alternativeFormat, pickDateSample, dateQuestionOptions, MAX_SAMPLES };
