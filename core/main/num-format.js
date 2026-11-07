// ================= 文本数字的写法识别（10-24）=================
// 为什么：英文导出（Google Ads / Shopify / Meta / GA4 / Amazon）里的数字常带修饰：
//   "$1,234.56"、"US$1,234"、"£12.30"、"€1.234,56"、"(123.45)"（会计负数）、"12.5%"、"−12"（Unicode 负号）、
//   "1.2E+3"、"--"（Google Ads 的空值）。以前只认 1,234.56，一遇到这些整列变成文本，不能求和。
// 做法：按列一次判定（不针对表名）。拿样本逐个试，≥95% 的非空样本能解析才认成数字（带修饰的列）；
//   写法记成 fmt = { cur, cur_guess, pct, eu, nulls, conv, scale }，导入时 sqlNumExpr 按它转，不再每格猜。
// 约定：
//   - 只有 $ 时币种记 'USD' 并标 cur_guess:true（也可能是加元澳元）；¥ 看表头有没有汉字：有记 CNY，没有记 JPY，都标 cur_guess。
//   - % 去掉后保留百分数的数值：12.5% → 12.5，pct:true 告诉后面「这列是百分数」，不会悄悄除以 100。
//   - 1.234,56 这种欧洲写法（点是千分位、逗号是小数点）整列统一判，不逐格猜；只有 1,234 / 1.234 这类两头都说得通的，按英文写法。
//   - "--" "-" "—" N/A null 空白，以及 GA4 的 "(not set)"（只在数字列里）当空。
//   - conv:false 表示列里全是普通数字（只是表头写了币种），导入走老路，不用转换。
// 不依赖任何别的模块（导入线程和主程序都要用）。
'use strict';

const NEED = 0.95;
const MAX_SAMPLES = 2000;

const SPACES = /[    ]/g;
const NULL_TOKENS = new Set(['--', '-', '—', '–', 'n/a', 'na', 'null', 'none', 'nan', '(not set)', '(none)', '#n/a', 'n.a.']);
const CUR_CODE = '(?:US\\$|CA\\$|AU\\$|A\\$|C\\$|USD|GBP|EUR|JPY|CNY|RMB|CAD|AUD)';
const CUR_RE = new RegExp(CUR_CODE + '|[$£€¥￥]', 'ig');

// 币种符号 / 代码 → 币种代码
function curOf(tok){
  const t = tok.toUpperCase();
  if (t === 'US$' || t === 'USD') return 'USD';
  if (t === 'CA$' || t === 'C$' || t === 'CAD') return 'CAD';
  if (t === 'AU$' || t === 'A$' || t === 'AUD') return 'AUD';
  if (t === 'GBP' || tok === '£') return 'GBP';
  if (t === 'EUR' || tok === '€') return 'EUR';
  if (t === 'JPY') return 'JPY';
  if (t === 'CNY' || t === 'RMB' || tok === '￥') return 'CNY';
  if (tok === '¥') return '¥';
  if (tok === '$') return '$';
  return null;
}

// 表头里的币种：(USD) / [GBP] / "Spend, £" / "Revenue (€)" / "Cost USD"
function headerCurrency(header){
  const h = String(header == null ? '' : header);
  let m = /[(\[](?:in\s+)?(US\$|USD|GBP|EUR|JPY|CNY|RMB|CAD|AUD|[$£€¥￥])[)\]]/i.exec(h)
    || /,\s*(US\$|USD|GBP|EUR|JPY|CNY|RMB|CAD|AUD|[$£€¥￥])\s*$/i.exec(h)
    || /(?:^|[\s_-])(USD|GBP|EUR|JPY|CNY|RMB|CAD|AUD)(?:$|[\s_-])/.exec(h)
    || /[£€￥]/.exec(h);
  if (!m) return null;
  return curOf(m[1] || m[0]);
}

const PLAIN_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;      // 和 parse.js 的老 NUM_RE 一样：1,234.56

/**
 * 拆一个格子（只看这个格子本身）。
 * shape = 数字本体的写法：int 1234 / us 1,234.56 / eu 1.234,56 / comma3 1,234（两头说得通）/ dot3 1.234（两头说得通）
 *         / decdot 12.5 / deccomma 12,5 / sp 1 234,56 / sci 1.2E+3
 * @returns {{kind:'null'}|{kind:'bad'}|{kind:'num', neg:boolean, cur:string|null, pct:boolean, shape:string, body:string, decimals:number}}
 */
function cell(raw){
  let s = String(raw).replace(/^﻿/, '').replace(SPACES, ' ').trim();
  if (s === '' || NULL_TOKENS.has(s.toLowerCase())) return { kind: 'null' };
  s = s.replace(/[−–‒]/g, '-');            // Unicode 负号 / en dash → 普通减号
  let neg = false, pct = false, cur = null;
  // 会计括号：(123.45) / ($1,234) / $(1,234)
  const par = /^([^()\d.\-+]*)\(([^()]*)\)([^()\d.\-+]*)$/.exec(s);
  if (par) { neg = true; s = par[1] + par[2] + par[3]; }
  const found = s.match(CUR_RE);                          // 币种（前后都可能有）
  if (found) {
    const cs = new Set(found.map(curOf));
    if (cs.size > 1) return { kind: 'bad' };
    cur = [...cs][0];
    s = s.replace(CUR_RE, '');
  }
  s = s.trim();
  if (/%$/.test(s)) { pct = true; s = s.slice(0, -1).trim(); }
  const sg = /^([-+])\s*/.exec(s);                        // 符号可以在币种前（-$12）或后（$-12），去掉币种后都在开头
  if (sg) { if (sg[1] === '-') neg = true; s = s.slice(sg[0].length); }
  if (!s) return { kind: 'bad' };
  const num = shape => ({ kind: 'num', neg, cur, pct, shape, body: s });
  let m;
  if (/^\d+$/.test(s)) return num('int');
  if (/^\d+(?:[.,]\d+)?[eE][-+]?\d+$/.test(s)) return num('sci');
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) return /^\d{1,3},\d{3}$/.test(s) ? num('comma3') : num('us');
  if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(s) || /^\d{1,3}(?:\.\d{3}){2,}$/.test(s)) return num('eu');
  if (/^\d{1,3}\.\d{3}$/.test(s)) return /^0/.test(s) ? num('decdot') : num('dot3');
  if (/^\d*\.\d+$/.test(s)) return num('decdot');
  if ((m = /^(\d+),(\d+)$/.exec(s))) return num('deccomma');
  if (/^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/.test(s)) return num('sp');
  return { kind: 'bad' };
}
// 按列定下的写法（eu 与否）把一个拆好的数字格子变成「干净数字字符串」；这一格在该写法下读不了返回 null
function coreOf(c, eu){
  const b = c.body;
  switch (c.shape) {
    case 'int': return b;
    case 'sci': return b.replace(',', '.');
    case 'us': case 'decdot': return eu ? null : b.replace(/,/g, '');
    case 'eu': case 'deccomma': return eu ? b.replace(/\./g, '').replace(',', '.') : null;
    case 'comma3': return eu ? b.replace(',', '.') : b.replace(',', '');
    case 'dot3': return eu ? b.replace('.', '') : b;
    case 'sp': { const x = b.replace(/ /g, ''); return eu ? (/\.\d+$/.test(x) ? null : x.replace(',', '.')) : (/,\d+$/.test(x) ? null : x); }
    default: return null;
  }
}

/**
 * 认一列的数字写法。
 * @param {string[]} samples 这一列的值（本机取的，最多看 2000 个非空值）
 * @param {string} [header] 列名（用来认币种）
 * @returns {{cur:string|null, cur_guess?:boolean, pct:boolean, eu:boolean, nulls:string[], conv:boolean, scale:number}|null}
 *   不是数字返回 null；conv:false = 列里全是普通数字（只是表头写了币种），导入不用转换
 */
function detectNumberFormat(samples, header){
  const vals = [];
  for (const x of (Array.isArray(samples) ? samples : [])) {
    if (x == null) continue;
    const s = String(x).trim();
    if (s) vals.push(s);
    if (vals.length >= MAX_SAMPLES) break;
  }
  if (!vals.length) return null;
  const hcur = headerCurrency(header);
  const hasHdrCur = !!hcur;
  const mk = (cur, guess, o) => { const f = { cur, pct: false, eu: false, nulls: [], conv: false, scale: 0, ...o }; if (guess) f.cur_guess = true; return f; };
  const hdrOnly = () => { if (!hasHdrCur) return null; const g = hcur === '$' || hcur === '¥'; return mk(hcur === '$' ? 'USD' : hcur === '¥' ? 'JPY' : hcur, g, { scale: Math.min(10, Math.max(0, ...vals.map(v => (v.split('.')[1] || '').length))) }); };
  if (vals.every(v => PLAIN_RE.test(v))) return hdrOnly();            // 全是普通数字：老路；只有表头写了币种时记下币种
  const cells = vals.map(v => ({ v, c: cell(v) }));
  const nums = cells.filter(x => x.c.kind === 'num');
  if (!nums.length) return null;
  // 整列统一判：欧洲独有写法（1.234,56 / 12,5 / 1.234.567）对英文独有写法（1,234.56 / 12.5）；两头都说得通的（1,234 / 1.234）跟着多数
  let eu = 0, us = 0;
  for (const { c } of nums) {
    if (c.shape === 'eu' || c.shape === 'deccomma') eu++;
    else if (c.shape === 'us' || c.shape === 'decdot') us++;
    else if (c.shape === 'sp') { if (/,\d+$/.test(c.body)) eu++; else if (/\.\d+$/.test(c.body)) us++; }
  }
  const useEu = eu > us;
  let ok = 0, scale = 0, pctN = 0;
  const cur = new Map(), nulls = new Set();
  for (const { v, c } of cells) {
    if (c.kind === 'null') { ok++; nulls.add(v.trim()); continue; }
    if (c.kind !== 'num') continue;
    const core = coreOf(c, useEu);
    if (core == null) continue;
    ok++;
    if (c.cur) cur.set(c.cur, (cur.get(c.cur) || 0) + 1);
    if (c.pct) pctN++;
    if (c.shape === 'sci') { const mt = /^(\d+)(?:\.(\d+))?[eE]([-+]?\d+)$/.exec(core); scale = Math.max(scale, Math.min(10, Math.max(0, (mt && mt[2] ? mt[2].length : 0) - Number(mt ? mt[3] : 0)))); }
    else { const d = core.split('.')[1]; if (d) scale = Math.max(scale, d.length); }
  }
  if (ok / cells.length < NEED) return null;
  // 币种：列里的符号 ≥95% 同一个才认；没有符号再看表头
  let code = null, guess = false;
  if (cur.size) {
    const tot = [...cur.values()].reduce((a, b) => a + b, 0), [top, n] = [...cur.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n / tot >= NEED) {
      if (top === '$') { const h = hcur && hcur !== '$' && hcur !== '¥' ? hcur : null; code = h || 'USD'; guess = !h; }
      else if (top === '¥') { const h = hcur && hcur !== '$' && hcur !== '¥' ? hcur : null; code = h || (/[一-鿿]/.test(String(header || '')) ? 'CNY' : 'JPY'); guess = !h; }
      else code = top;
    }
  } else if (hasHdrCur) { code = hcur === '$' ? 'USD' : hcur === '¥' ? 'JPY' : hcur; guess = hcur === '$' || hcur === '¥'; }
  // 百分数：带 % 的格子占多数（表头写了 % 也算一票）
  const pct = pctN > 0 && (pctN / nums.length >= 0.5 || /%/.test(String(header || '')));
  return mk(code, guess, { pct, eu: useEu, nulls: [...nulls].slice(0, 6), conv: true, scale: Math.min(scale, 10) });
}

/**
 * 把一列文本写成 DuckDB 的「干净数字字符串」表达式（外面再 TRY_CAST 成小数）。
 * 解析不了的格子（含 "--" "N/A" "(not set)" 空白）给 NULL。
 * @param {string} colSql 已经加好引号的列名
 * @param {object} fmt detectNumberFormat 的结果
 */
function sqlNumExpr(colSql, fmt){
  const f = fmt || {};
  const t = `replace(replace(replace(replace(replace(trim(CAST(${colSql} AS VARCHAR)), '−', '-'), '–', '-'), ' ', ' '), ' ', ' '), ' ', ' ')`;
  // 去币种符号 / 代码、百分号、括号、空格
  const strip = `regexp_replace(${t}, '(?i)US\\$|CA\\$|AU\\$|A\\$|C\\$|USD|GBP|EUR|JPY|CNY|RMB|CAD|AUD|[$£€¥￥%() ]', '', 'g')`;
  // 欧洲写法：点是千分位去掉，逗号变小数点；英文写法：逗号去掉
  const swapped = f.eu ? `replace(replace(${strip}, '.', ''), ',', '.')` : `replace(${strip}, ',', '')`;
  const paren = `regexp_matches(${t}, '^[^()0-9.,+-]*\\([^()]*\\)[^()0-9.,+-]*$')`;
  const core = `CASE WHEN ${paren} THEN '-' || regexp_replace(${swapped}, '^[-+]', '') ELSE ${swapped} END`;
  // 先按整列的写法核对一遍原样（英文：千分位逗号 + 小数点；欧洲：千分位点 + 小数逗号），对不上的格子给 NULL，不硬转成错的数
  const shapeOk = f.eu
    ? `regexp_full_match(${strip}, '[-+]?(?:[0-9]{1,3}(?:[.][0-9]{3})+|[0-9]+)?(?:,[0-9]+)?(?:[eE][-+]?[0-9]+)?')`
    : `regexp_full_match(${strip}, '[-+]?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)?(?:[.][0-9]+)?(?:[eE][-+]?[0-9]+)?')`;
  const parenOk = `(${paren} OR NOT contains(${t}, '('))`;
  const valid = `${shapeOk} AND ${parenOk} AND regexp_matches(${strip}, '[0-9]')`;
  return `(CASE WHEN ${valid} THEN ${core} END)`;
}

module.exports = { detectNumberFormat, sqlNumExpr, headerCurrency, cell, PLAIN_RE };
