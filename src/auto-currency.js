'use strict';
// rc.7, auto-rules mode only. The core's auto semantics find a currency column only by its English name (currency / ccy / cur).
// Tables with a Chinese one (币种 / 货币 / 币别 ...) were therefore treated as "yuan by default" and amounts in several currencies were
// added up without a word. This pass runs after buildAutoPack, looks at the distinct values of such a column on this machine (only
// the set of currency codes is kept; nothing leaves the machine) and writes the SAME fields the core writes for an English column:
//   pack._meta.currency[table] = { code | multi + codes, col, source }    -> SQL lane prompt lines ("含多种币种 ... 不能直接相加")
//   metric.multi_currency / metric.unit / metric.currency                  -> answer note "含多种币种，未换汇，不能直接相加"
const CUR_COL_RE = /^(币种|货币|币别|货币代码|币种代码|货币种类|结算币种|交易币种|计价币种)$/;
const CODES = new Set('CNY RMB USD EUR GBP JPY HKD AUD CAD CHF SGD KRW INR BRL MXN SEK NOK DKK PLN NZD THB TWD ZAR AED TRY RUB MYR IDR PHP VND CZK HUF ILS SAR'.split(' '));
const NAMES = { '人民币': 'CNY', '元': 'CNY', '人民币元': 'CNY', '美元': 'USD', '美金': 'USD', '英镑': 'GBP', '欧元': 'EUR', '日元': 'JPY', '港币': 'HKD', '港元': 'HKD', '澳元': 'AUD', '加元': 'CAD', '韩元': 'KRW', '新加坡元': 'SGD' };
const SYMBOLS = { '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': null };
const CUR_ZH = { USD: '美元', GBP: '英镑', EUR: '欧元', JPY: '日元', CNY: '元', RMB: '元' };
const MONEY_NAME_RE = /金额|销售额|成交|营业额|收入|费用|运费|成本|利润|货款|佣金|税|花费|支出|售价|价格|付款|支付|退款|GMV|amount|revenue|sales|cost|price|fee|refund/i;
const NOT_MONEY_RE = /数量|件数|个数|次数|天数|率|占比|比例|单数|订单数/;
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';

function normCode(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (NAMES[s]) return NAMES[s] === 'RMB' ? 'CNY' : NAMES[s];
  if (Object.prototype.hasOwnProperty.call(SYMBOLS, s)) return SYMBOLS[s];
  const u = s.toUpperCase();
  if (/^[A-Z]{3}$/.test(u) && CODES.has(u)) return u === 'RMB' ? 'CNY' : u;
  return null;
}

async function applyChineseCurrency(pack, rawTables, run) {
  const changed = [];
  if (!pack || !pack._meta || typeof run !== 'function') return changed;
  pack._meta.currency = pack._meta.currency || {};
  for (const t of rawTables || []) {
    const col = (t.columns || []).find(c => CUR_COL_RE.test(String(c.name).trim()));
    if (!col) continue;
    const cur = pack._meta.currency[t.name] || {};
    if (cur.col || cur.code || cur.multi) continue;   // the core already found a currency for this table
    let rows;
    try { rows = await run(`SELECT DISTINCT CAST(${qi(col.name)} AS VARCHAR) AS v FROM ${qi(t.name)} WHERE ${qi(col.name)} IS NOT NULL LIMIT 40`); } catch (_) { continue; }
    const codes = [...new Set((rows || []).map(r => normCode(Object.values(r || {})[0])).filter(Boolean))];
    if (!codes.length) continue;
    const multi = codes.length > 1;
    pack._meta.currency[t.name] = { code: multi ? null : codes[0], multi, codes: codes.slice(0, 8), source: '币种列', col: col.name, zh_default: false };
    for (const m of pack.metrics || []) {
      if (m.dataset !== t.name || m.kind !== 'simple' || !['sum', 'avg', 'min', 'max'].includes(m.agg)) continue;
      const label = String(m.name || '') + ' ' + String(m.field || '');
      const money = m.unit === '元' || (!m.unit && MONEY_NAME_RE.test(label) && !NOT_MONEY_RE.test(label));
      if (!money || m.unit === '件' || m.unit === '个') continue;
      if (multi) { m.unit = ''; m.multi_currency = true; delete m.currency; }
      else { m.unit = CUR_ZH[codes[0]] || codes[0]; m.currency = codes[0]; delete m.multi_currency; }
      changed.push(t.name + '.' + (m.field || m.id));
    }
  }
  return changed;
}

module.exports = { applyChineseCurrency, normCode, CUR_COL_RE };
