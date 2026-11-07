// ================= 导入自动语义（10-23，jackson 定：英文表头也要能用中文问）=================
// 为什么：没有 ERP 的公司，数据多是独立站 / Google Ads / Shopify 导出的英文表；语义包里只有英文列名时，
// 中文提问对不上任何指标，只能每题都走兜底，也不会越用越省。
// 做法（jackson 10-23 定）：
//   1) 先查出厂词典（中英对照 436 条，0 token）：Ad Spend = 广告花费、Clicks = 点击……
//   2) 词典认不出的表 / 列：导入时把「表名 + 列名 + 类型」（不含任何数据值）发给模型一次，起中文名和常见叫法；
//      还让它指出「列名不同但指同一个对象」的列对（如 Agreement_Identifier ↔ Policy_Identifier）。
//   3) 表间关系一律用数据实测：同名列，或模型指出的列对，一边的值全部落在另一边里才算；基数按实测。
//   4) 中文名只用来「听懂中文提问 + 用中文回答」；计算过程（计划、SQL、复用记录）一律用原始字段名。
//   5) 自动起的名字不用先确认就能用，但用到它们的答案标「待确认」；用户觉得哪条不是这么算的，单独改那一条（沿用公式块）。
'use strict';
const dict = require('./dict');
const { detectDateFormat, describeFormat } = require('./date-format');

// 自动命名后用既有词典补默认聚合；只修未确认的默认SUM，不覆盖用户口径。
function metricDefaultOfName(name){
  const clean=String(name||'').replace(/^.*[·:：]/,'').replace(/(?:天数|数值)$/,'');
  try{const es=dict.identify(clean).entries||[];return es.length===1&&es[0].agg==='avg'?{agg:'avg',unit:es[0].unit||'',alias:es[0].zh}:null;}catch(_){return null;}
}
// 原字段的限定词比短词子串更具体。保留模型原名，修正未确认自动指标的明显误识别。
function qualifyAutoMetric(m,table){
 if(!m.auto||m.confirmed||m.kind!=='simple'||!m.field)return m;
 const f=words(m.field);let id=null;
 if(/^(?:return|refund|refunded) (?:gmv|amount|sales|revenue)$/.test(f))id='refund_amount';
 else if(/^(?:available|fulfillable) (?:qty|quantity|units?)$/.test(f))id='available_qty';
 else if(/^(?:transit|in transit|inbound) (?:qty|quantity|units?|inventory)$/.test(f))id='inbound_transit';
 else if(/^(?:age days|stock age|inventory age)$/.test(f))id='stock_age';
 const e=id&&dict.byId.get(id);if(!e)return m;
 const old=String(m.name||''),prefix=old.includes('·')?old.slice(0,old.lastIndexOf('·')+1):'';
 if(old!==prefix+e.zh)m.auto_original_name=m.auto_original_name||old;
 m.name=prefix+e.zh;m.qualification={field:m.field,dict_id:id,source:'qualified_source_field'};
 const prior=dict.identify(old.replace(/^.*·/,'')).entries||[];
 const wrong=new Set(prior.filter(x=>x.id!==id).flatMap(x=>[x.zh,x.en,...x.alias||[],...x.abbr||[]]).map(x=>String(x).toLowerCase()));
 m.aliases=[...new Set([...(m.aliases||[]).filter(a=>!wrong.has(String(a).toLowerCase())),e.zh,e.en,...e.alias||[],m.field,f])];
 if(!m.unit)m.unit=e.unit||'';
 if(e.agg==='avg'&&m.agg==='sum')m.agg='avg';
 if(e.agg==='stock'&&table?.columns?.some(c=>/^(date|timestamp)/i.test(String(c.type))||/(?:^|_)(?:snapshot_date|date)$|日期|盘点日/i.test(c.name)))m.additivity='semiAdditive';
 return m;
}
const AUTO_PACK_ID = 'auto_ws';
const sid = s => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x';
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';
const isNum = t => /^(number|int|integer|bigint|double|real|float|decimal|numeric|hugeint|smallint|tinyint|ubigint)/i.test(String(t || ''));
const isDateCol = c => /date|time|day|month|日期|时间/i.test(String(c.name)) || /^(date|timestamp)/i.test(String(c.type || ''));
const isIdName = n => /(编号|代码|单号)/.test(String(n)) || /^id_/i.test(String(n)) || ['id', 'identifier', 'no', 'number', 'code', 'key', 'sku'].includes(String(n).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().toLowerCase().split(/\s+/).pop());
// 列名拆成英文词（给模型 / 叫法用）：Policy_Amount → policy amount；campaignName → campaign name
const words = n => String(n).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().toLowerCase();

/* ---------- 10-24 英文导出：币种 / 平台比率 / 布尔 / 退货取消（只看列名、类型、导入给的格式标记和本机计数，值不出本机）---------- */
const hasCjk = x => /[一-鿿]/.test(String(x == null ? '' : x));
// 币种：代码 → 中文（只认这几个，其他直接写代码）
const CUR_ZH = { USD: '美元', GBP: '英镑', EUR: '欧元', JPY: '日元', CNY: '元', RMB: '元' };
const CUR_WORDS = new Set(['usd', 'gbp', 'eur', 'jpy', 'cny', 'rmb', 'hkd', 'aud', 'cad', 'chf', 'sgd', 'krw', 'inr', 'brl', 'mxn', 'sek', 'nok', 'dkk', 'pln', 'nzd', 'thb', 'twd', 'zar', 'aed', 'try', 'rub']);
const SYMBOL_CUR = { '$': 'USD', '£': 'GBP', '€': 'EUR' };
const curZh = code => CUR_ZH[String(code || '').toUpperCase()] || String(code || '');
const ISO_4217 = new Set('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL RMB'.split(' '));   // estratto-engine: whitelist so arbitrary 3-letter cell values never become a currency code (and reach prompts)
const normCur = v => { const s = String(v == null ? '' : v).trim(); if (SYMBOL_CUR[s]) return SYMBOL_CUR[s]; if (!/^[A-Za-z]{3}$/.test(s)) return null; const u = s.toUpperCase(); return ISO_4217.has(u) ? u : null; };
// 表头里写的币种："Cost (USD)"、"Spend, £"、"revenue_gbp"；认不出返回 null
function curFromHeader(name){
  const n = String(name);
  for (const sym of Object.keys(SYMBOL_CUR)) if (n.includes(sym)) return { code: SYMBOL_CUR[sym], guess: sym === '$', source: '表头' };   // $ 可能是美元也可能是别的元，标记为推测
  const w = words(n).split(/[^a-z]+/).filter(Boolean).find(x => CUR_WORDS.has(x));
  return w ? { code: w.toUpperCase(), guess: false, source: '表头' } : null;
}
// 列自己的币种：导入给的 nfmt.cur 优先，其次表头
const colCurOf = c => {
  const nf = c && c.nfmt;
  if (nf && nf.cur) { const code = normCur(nf.cur); if (code) return { code, guess: !!nf.cur_guess, source: '导入识别' }; }
  return curFromHeader(c.name);
};
const isCurrencyColName = n => /^(currency|currency (code|iso|iso code)|cur|ccy|currency_code)$/.test(words(n)) || /^currency\b/.test(words(n));
// 一眼看着是「钱」的列名（数量、比率不算）
const MONEY_RE = /\b(amount|amt|revenue|sales|total|subtotal|shipping|freight|tax|taxes|vat|discount|refund(ed)?|price|cost|spend|fee|fees|commission|profit|income|budget|payment|paid|balance|salary|gmv|value|cpc|cpm|cpa|net|gross|earnings|payouts?|proceeds)\b/;
const NOT_MONEY_RE = /\b(qty|quantity|units?|count|number|num|orders?|rate|share|percent|pct|ratio|ctr|roas|clicks?|impressions?|sessions?|conversions?)\b/;
const isMoneyName = c => { const w = words(c.name); return MONEY_RE.test(w) && !NOT_MONEY_RE.test(w.replace(/\bconv\w*\s*value\b/, 'convvalue')); };

// 平台自己算好的比率列：CTR、Avg. CPC、Cost / conv.、Conv. rate、ROAS、Impr. share、Engagement rate、Bounce rate、AOV……（只认英文写法；中文表照老办法）
// 10-24：再加 CPE / CPV / CPCon 这类 cp 开头的单价、Average / Avg. / Daily average / per 开头的平均值（平均值同样不能跨行相加）
const RATIO_NAME_RE = /\b(ctr|cpc|cpm|cpa|cpl|cpo|cvr|roas|roi|acos|aov|arpu|rpv)\b|\bcp(e|v|v[a-z]|con|conv|i|r|s|lc)\b|\b(avg|average|mean|median)\b|\bper\b|\brate\b|\bshare\b|\bratio\b|\bpct\b|\bpercent(age)?\b|cost\s*\/\s*conv|\bper\s+(click|conv\w*|order|session|visit\w*|user|acquisition)\b|click[- ]?through|average order value|avg order value/;
const isPlatRatio = c => {
  if (!isNum(c.type) && !(c.nfmt && c.nfmt.pct)) return false;
  if (c.nfmt && c.nfmt.pct) return true;
  if (hasCjk(c.name)) return false;
  return RATIO_NAME_RE.test(words(c.name)) || /%/.test(String(c.name));
};
// 比率配方：分子 / 分母各是哪种「角色」的合计（候选按顺序试）。分子分母的具体列由表里的列名认
const RECIPES = [
  [/click[- ]?through|\bctr\b/, { zh: '点击率', pairs: [['clicks', 'impressions']], mul: 100, unit: '%' }],
  [/\bcpc\b|cost per click/, { zh: '单次点击成本', pairs: [['ad_spend', 'clicks']], money: true }],
  [/\bcpm\b|cost per (1000|thousand|mille)/, { zh: '千次展示成本', pairs: [['ad_spend', 'impressions']], mul: 1000, money: true }],
  [/cost\s*\/\s*conv|\bcpa\b|cost per (conv\w*|acq\w*)/, { zh: '单次转化成本', pairs: [['ad_spend', 'conversions']], money: true }],
  [/conv\w*\s*rate|\bcvr\b/, { zh: '转化率', pairs: [['conversions', 'clicks'], ['orders', 'sessions'], ['conversions', 'sessions']], mul: 100, unit: '%' }],
  [/\broas\b|return on ad spend/, { zh: '广告支出回报率', pairs: [['ad_sales', 'ad_spend']], unit: '倍' }],
  [/\baov\b|average order value|avg order value/, { zh: '客单价', pairs: [['sales', 'orders']], money: true }],
  [/engagement rate/, { zh: '互动率', pairs: [['engaged_sessions', 'sessions'], ['engagements', 'impressions']], mul: 100, unit: '%' }],
  [/bounce rate/, { zh: '跳失率', pairs: [['bounces', 'sessions']], mul: 100, unit: '%' }],
];
const recipeOf = c => { const w = words(c.name).replace(/\s*\/\s*/g, ' / '); const r = RECIPES.find(x => x[0].test(w)); return r ? r[1] : null; };

// 布尔列：取值只有 TRUE/FALSE/Yes/No/Y/N（导入给 bool:true 的直接认）
const BOOL_VALS = new Set(['true', 'false', 'yes', 'no', 'y', 'n', 't', 'f']);

// 英文表里常见的状态 / 币种列，词典认不出时按规则给中文名（不用问模型）
const EN_RULES = [
  [/^(financial|payment)\s*status$/, { zh: '付款状态', aliases: ['支付状态', '付款状态', '财务状态'] }],
  [/^fulfil+ment\s*status$/, { zh: '发货状态', aliases: ['履约状态', '配送状态'] }],
  [/^order\s*status$/, { zh: '订单状态', aliases: ['订单状态'] }],
  [/^cancel+ed\s*(at|date|time)$/, { zh: '取消时间', aliases: ['取消日期'] }],
  [/^(currency|currency\s*(code|iso))$|^ccy$/, { zh: '币种', aliases: ['货币', '币别'] }],
  [/^refund(ed)?\s*(amount|total|value)$/, { zh: '退款金额', aliases: ['退款额', '退款'], agg: 'sum', unit: '元' }],
];

// 「additivity: none」语义层认不认：认就写 none，不认退回 ratio（照样不会被当可加指标），免得整个包加载失败
let _platAdd = null;
function platAdditivity(){
  if (_platAdd) return _platAdd;
  _platAdd = 'ratio';
  try {
    const { Semantic } = require('./semantic');
    new Semantic().load({ id: 'probe_none', datasets: { x: { match: ['x'] } }, metrics: [{ id: 'p', name: 'p', kind: 'simple', dataset: 'x', agg: 'avg', field: 'f', additivity: 'none' }], dims: [] });
    _platAdd = 'none';
  } catch (_) {}
  return _platAdd;
}

/** 金额单位：列自己的币种 > 表的币种；表里有多种币种 → 不写单位并标 multi_currency；中文数据保持词典单位（元）；其他认不出 → 不写单位、标 currency_unknown */
function moneyUnit(ti, c, baseUnit){
  const cc = colCurOf(c);
  const tc = ti && ti.cur || {};
  let code = cc ? cc.code : null, guess = cc ? cc.guess : false;
  if (!code && !tc.multi && tc.code) code = tc.code;
  if (code) {
    const z = curZh(code);
    return { unit: /元/.test(baseUnit) ? baseUnit.replace(/元/, z) : (baseUnit || z), code, guess };
  }
  if (!cc && tc.multi) return { unit: '', multi: true, codes: tc.codes };
  if (ti && ti.zh) return { unit: baseUnit };
  return { unit: '', unknown: true };
}
const curFields = cu => {
  const o = {};
  if (cu && cu.code) { o.currency = cu.code; if (cu.guess) o.currency_guess = true; }
  if (cu && cu.multi) o.multi_currency = true;
  if (cu && cu.unknown) o.currency_unknown = true;
  return o;
};
const inheritCur = (to, ...from) => {
  for (const f of from) if (f) for (const k of ['currency', 'currency_guess', 'multi_currency', 'currency_unknown']) if (f[k] != null && to[k] == null) to[k] = f[k];
  return to;
};

/* ---------- 起名用的模型提示词（App 和评测共用；只给表名、列名、类型，没有任何数据值）---------- */
const NAMER_SYSTEM = [
  '【自动语义】你给业务数据表起中文名。只输出一个 JSON 对象，不要解释。',
  '输入只有表名、列名和类型（没有任何数据）。',
  '对每张表给 zh（中文业务名，2–6 个字，如「保单」「广告活动」「员工」）；对每个列给 zh（中文业务名）和 aliases（2–4 个中文常见叫法，口语也行）。',
  '编号类列（id、identifier、number、code）写成「X 编号」，如 Policy_Number → 保单号；不要把编号当金额。',
  '列名不同但指同一个对象的列（外键，如 Agreement_Identifier 其实是保单编号、Party_Identifier 是投保人编号）放进 links：[["表.列","表.列"]]；只写你有把握的，本机会用数据核实。',
  '格式：{"tables":{"表名":{"zh":"..."}},"columns":{"表名.列名":{"zh":"...","aliases":["..."]}},"links":[["表.列","表.列"]]}',
].join('\n');
function buildNamerMessages(payload){
  const p = payload || {};
  const input = { tables: (p.tables || []).map(t => ({ name: t.name, columns: (t.columns || []).map(c => [c.name, c.type || '']) })) };
  return { system: NAMER_SYSTEM, user: 'INPUT（JSON）:\n' + JSON.stringify(input) };
}

/** 词典能认的列：返回 { zh, aliases, agg, unit, entry } */
function fromDict(colName){
  try {
    const r = dict.identify(colName);
    if (!r.entries.length || r.entries.length > 1) return null;   // 一词多义不替用户选
    const e = r.entries[0];
    return { zh: e.zh, aliases: [...new Set([e.zh, e.en, ...(e.abbr || []), ...(e.alias || []).slice(0, 6)].filter(Boolean))], agg: e.agg, unit: e.unit || '', entry: e.id };
  } catch (_) { return null; }
}

/**
 * @param {{tables:Array<{name,columns:Array<{name,type}>}>, run?:(sql)=>Promise<rows>, namer?:(payload)=>Promise<object|null>, skipBound?:Set<string>}} o
 *   run：只读执行（只跑计数 / 包含关系这类统计，结果不出本机）；namer：起名（只收表名、列名、类型）
 *   skipBound：已经被内置领域包绑定的 "表.列"，自动包不再重复建（避免两个指标抢同一列）
 *   previous：上一版包。里面 confirmed:true 的指标 / 维度，名字、叫法、确认状态、user_formula 原样保留；版本号 +1
 *   maxNamerCalls：起名最多问模型几批（默认 6），每批最多 40 列
 * @returns {Promise<{pack, report}>}
 */
async function buildAutoPack(o = {}){
  const tables = (o.tables || []).filter(t => t && t.name && Array.isArray(t.columns) && t.columns.length);
  const report = { tables: tables.length, dict_named: 0, model_named: 0, unnamed: 0, model_called: false, model_error: null, links_suggested: 0, relations: [], rejected_links: [],
    derived_added: [], kept_confirmed: 0, namer_calls: 0, namer_skipped_tables: [], date_formats: [],
    currency: {}, platform_ratios: [], bool_cols: [], return_notes: [] };
  const skip = o.skipBound instanceof Set ? o.skipBound : new Set();
  // 1) 词典先认
  const names = {};       // "表.列" → { zh, aliases, source }
  const tableZh = {};
  const need = [];
  for (const t of tables) for (const c of t.columns) {
    const d = fromDict(c.name);
    if (d) { names[t.name + '.' + c.name] = Object.assign({ source: 'dict' }, d); report.dict_named++; }
  }
  // 1b) 英文表的状态 / 币种 / 退款列：词典没认的，按规则给中文名（不问模型）
  for (const t of tables) for (const c of t.columns) {
    const key = t.name + '.' + c.name;
    if (names[key]) continue;
    const hit = EN_RULES.find(r => r[0].test(words(c.name)));
    if (hit) { names[key] = Object.assign({ source: 'rule', aliases: [] }, hit[1]); report.dict_named++; }
  }
  // 2) 模型起名（词典没认全的表，整表给，好让它看上下文）
  for (const t of tables) if (t.columns.some(c => !names[t.name + '.' + c.name]) || !/[一-鿿]/.test(t.name)) need.push(t);
  let links = [];
  if (need.length && typeof o.namer === 'function') {
    // 分批：每批最多 40 列，整张表不拆开；单表超过 40 列就自己一批；最多问 maxNamerCalls 批，超出的表不问模型、用原名
    const maxCalls = Number.isFinite(Number(o.maxNamerCalls)) && Number(o.maxNamerCalls) >= 0 ? Math.floor(Number(o.maxNamerCalls)) : 6;
    const batches = []; let cur = [], curCols = 0;
    for (const t of need) {
      const n = t.columns.length;
      if (n > 40) { if (cur.length) { batches.push(cur); cur = []; curCols = 0; } batches.push([t]); continue; }
      if (cur.length && curCols + n > 40) { batches.push(cur); cur = []; curCols = 0; }
      cur.push(t); curCols += n;
    }
    if (cur.length) batches.push(cur);
    for (const b of batches.slice(maxCalls)) for (const t of b) report.namer_skipped_tables.push(t.name);
    for (const batch of batches.slice(0, maxCalls)) {
      report.model_called = true; report.namer_calls++;
      try {
        const out = await o.namer({ lane: 'naming', tables: batch.map(t => ({ name: t.name, columns: t.columns.map(c => ({ name: c.name, type: c.type })) })) });
        const tz = (out && out.tables) || {}, cz = (out && out.columns) || {};
        for (const [k, v] of Object.entries(tz)) if (v && v.zh) tableZh[k] = String(v.zh).slice(0, 20);
        for (const [k, v] of Object.entries(cz)) {
          if (!v || !v.zh || names[k]) continue;
          names[k] = { zh: String(v.zh).slice(0, 20), aliases: (Array.isArray(v.aliases) ? v.aliases : []).map(x => String(x).slice(0, 20)).filter(Boolean).slice(0, 4), source: 'model' };
          report.model_named++;
        }
        const ls = Array.isArray(out && out.links) ? out.links.filter(x => Array.isArray(x) && x.length === 2) : [];
        links.push(...ls);
      } catch (err) { report.model_error = String(err && err.message || err).slice(0, 200); }   // 某一批失败不影响别的批
    }
    links = links.slice(0, 40);
    report.links_suggested = links.length;
  }
  for (const t of tables) for (const c of t.columns) if (!names[t.name + '.' + c.name]) report.unnamed++;

  // 2b) 实测每张表「每行都不重样」的编号列（只看计数）
  o.uniqueCols = {};
  if (typeof o.run === 'function') for (const t of tables) {
    o.uniqueCols[t.name] = [];
    for (const c of t.columns.filter(c => isIdName(c.name)).slice(0, 6)) {
      try { const r = await o.run(`SELECT COUNT(*) - COUNT(DISTINCT ${qi(c.name)}) AS d, COUNT(${qi(c.name)}) AS n FROM ${qi(t.name)}`); const row = (Array.isArray(r) ? r : (r && r.rows) || [])[0] || {}; if (Number(row.d) === 0 && Number(row.n) > 0) o.uniqueCols[t.name].push(c.name); } catch (_) {}
    }
  }
  const rowsOfR = r => Array.isArray(r) ? r : (r && r.rows) || [];
  // 2b2) 币种：列自己带的（导入识别 / 表头）→ 表里的币种列（本机取不同值，只在本机）→ 中文数据默认「元」→ 认不出就不写单位
  const tinfo = {};
  for (const t of tables) {
    const zh = hasCjk(t.name) || hasCjk(t.display) || t.columns.some(c => hasCjk(c.name));
    const cur = { code: null, multi: false, source: null, col: null, codes: [] };
    const curCol = t.columns.find(c => isCurrencyColName(c.name));
    if (curCol && typeof o.run === 'function') {
      try {
        const vals = rowsOfR(await o.run(`SELECT DISTINCT CAST(${qi(curCol.name)} AS VARCHAR) AS v FROM ${qi(t.name)} WHERE ${qi(curCol.name)} IS NOT NULL LIMIT 12`)).map(x => normCur(Object.values(x || {})[0])).filter(Boolean);
        const codes = [...new Set(vals)];
        cur.col = curCol.name;
        if (codes.length === 1) { cur.code = codes[0]; cur.source = '币种列'; } else if (codes.length > 1) { cur.multi = true; cur.codes = codes.slice(0, 8); cur.source = '币种列'; }
      } catch (_) {}
    }
    if (!cur.code && !cur.multi) {
      const heads = [...new Set(t.columns.map(colCurOf).filter(Boolean).map(x => x.code))];
      if (heads.length === 1) { cur.code = heads[0]; cur.source = '表头'; } else if (heads.length > 1) { cur.multi = true; cur.codes = heads.slice(0, 8); cur.source = '表头'; }
    }
    if(!cur.code&&!cur.multi&&CUR_ZH[t.currency]){cur.code=t.currency;cur.source='用户表设置';}
    tinfo[t.name] = { zh, cur };
    report.currency[t.name] = cur.multi ? '多种币种（' + cur.codes.join('/') + '）' : cur.code ? curZh(cur.code) + '（' + cur.source + '）' : zh ? '元（中文数据默认）' : '未标明';
  }
  // 2b3) 布尔列：导入标了 bool:true、类型是 boolean、或文本列取值只有 TRUE/FALSE/Yes/No/Y/N（本机取最多 4 个不同值看，不出本机）
  const boolCols = new Set();
  for (const t of tables) {
    let tried = 0;
    for (const c of t.columns) {
      const key = t.name + '.' + c.name;
      if (skip.has(key)) continue;
      if (c.bool === true || /^bool/i.test(String(c.type || ''))) { boolCols.add(key); continue; }
      if (typeof o.run !== 'function' || isNum(c.type) || isDateCol(c) || isIdName(c.name) || ++tried > 30) continue;
      try {
        const vals = rowsOfR(await o.run(`SELECT DISTINCT CAST(${qi(c.name)} AS VARCHAR) AS v FROM ${qi(t.name)} WHERE ${qi(c.name)} IS NOT NULL LIMIT 4`)).map(x => String(Object.values(x || {})[0]).trim().toLowerCase());
        if (vals.length && vals.length <= 2 && vals.every(v => BOOL_VALS.has(v))) boolCols.add(key);
      } catch (_) {}
    }
  }
  report.bool_cols = [...boolCols];
  // 2b4) 退货 / 取消 / 退款的英文写法：只记「有这种东西」和行数，写进说明；不改销售额口径（销售额默认不扣退款）
  const returnNotes = [];
  for (const t of tables) {
    for (const c of t.columns) {
      const w = words(c.name);
      if (/^(financial|payment)\s*status$/.test(w)) returnNotes.push(`${t.name}.${c.name} = 付款状态（取值里的退款 / 部分退款表示这单有退款）；销售额默认不扣退款，题目明确说扣退款才扣`);
      else if (/^refund(ed)?\s*(amount|total|value)$/.test(w)) returnNotes.push(`${t.name}.${c.name} = 退款金额（合计用 SUM）；销售额默认不扣退款，要净额才用 销售额 − 退款金额`);
      else if (/^order\s*status$/.test(w)) returnNotes.push(`${t.name}.${c.name} = 订单状态（里面可能有已取消的单）；取消的单默认照原样计入，题目说排除取消才排除`);
      else if (isNum(c.type) && isQtyCol(c) && typeof o.run === 'function') {
        try { const n = Number(Object.values(rowsOfR(await o.run(`SELECT COUNT(*) AS n FROM ${qi(t.name)} WHERE ${qi(c.name)} < 0`))[0] || {})[0]); if (n > 0) returnNotes.push(`${t.name}.${c.name} 有 ${n} 行负数 = 退货 / 冲减；默认照原样合计（含负数），题目说不含退货才排除`); } catch (_) {}
      } else if (!isNum(c.type) && isIdName(c.name) && /\b(invoice|order|transaction)\b/.test(w) && typeof o.run === 'function') {
        try {
          const q = x => o.run(`SELECT COUNT(*) AS n FROM ${qi(t.name)} WHERE ${x}`).then(r => Number(Object.values(rowsOfR(r)[0] || {})[0]));
          const nc = await q(`CAST(${qi(c.name)} AS VARCHAR) LIKE 'C%'`), nd = nc ? await q(`CAST(${qi(c.name)} AS VARCHAR) LIKE 'C%' AND SUBSTR(CAST(${qi(c.name)} AS VARCHAR), 2, 1) BETWEEN '0' AND '9'`) : 0;
          if (nc > 0 && nc === nd) returnNotes.push(`${t.name}.${c.name} 以 C 开头的 ${nc} 行是取消 / 退货单；默认照原样计入，题目说排除才排除`);
        } catch (_) {}
      }
    }
  }
  report.return_notes = returnNotes;
  // 2c) 文本类型、看着像日期的列：本机取样本认写法（英文导出的 10/21/2021、21/10/2021、Oct 21, 2021……），只在本机，样本不发给模型。
  //     ISO（2021-10-21）不用记，CAST 就能转；认不出的列保持原样
  const dateFmts = {};
  if (typeof o.run === 'function') for (const t of tables) {
    let tried = 0;
    for (const c of t.columns) {
      if (isNum(c.type) || /^(date|timestamp)/i.test(String(c.type || '')) || skip.has(t.name + '.' + c.name) || boolCols.has(t.name + '.' + c.name)) continue;
      const named = isDateCol(c);
      if (!named && ++tried > 40) continue;     // 名字不像日期的列只抽查，每张表最多 40 列，免得宽表拖慢导入
      try {
        const get = async n => { const r = await o.run(`SELECT DISTINCT CAST(${qi(c.name)} AS VARCHAR) AS v FROM ${qi(t.name)} WHERE ${qi(c.name)} IS NOT NULL LIMIT ${n}`); return (Array.isArray(r) ? r : (r && r.rows) || []).map(x => Object.values(x || {})[0]); };
        // 名字不像日期的列先看 50 个，认得出再取全；名字像的直接取 2000 个
        if (!named && !detectDateFormat(await get(50))) continue;
        const df = detectDateFormat(await get(2000));
        if (df && !df.iso) { dateFmts[t.name + '.' + c.name] = { format: df.format, ambiguous: !!df.ambiguous }; report.date_formats.push(t.name + '.' + c.name + ' = ' + describeFormat(df.format) + (df.ambiguous ? '（月日不能确定，按月/日）' : '')); }
      } catch (_) {}
    }
  }
  // 3) 生成包：原始字段名做 id / field；中文名做 name；英文原名和拆词都进叫法
  const pack = { id: AUTO_PACK_ID, name: '导入自动语义', datasets: {}, grain: {}, metrics: [], dims: [], relationships: [],
    _meta: { origin: 'auto', confirmed: false, generated_at: new Date().toISOString(), version: 1, date_formats: dateFmts } };
  const used = new Set();
  const colMetric = {};     // "表.列" → 这一列生成的简单指标（补派生指标时按它找腿）
  const uid = base => { let id = sid(base), k = 2; while (used.has(id)) id = sid(base) + '_' + (k++); used.add(id); return id; };
  for (const t of tables) {
    const tz = tableZh[t.name] || null;
    const keys = t.columns.filter(c => isIdName(c.name)).map(c => c.name);
    pack.datasets[t.name] = { match: [t.name], keys };
    pack.grain[t.name] = keys.length ? keys : t.columns.map(c => c.name);
    const tAliases = [...new Set([tz, words(t.name), t.name].filter(Boolean))];
    // 行数：只有「一行就是一个对象」（有一列每行都不重样）时才叫「X 数」；明细表（一单多行）只叫「X 记录数」，免得把行数当成订单数
    const rowIsEntity = !!(o.uniqueCols && o.uniqueCols[t.name] && o.uniqueCols[t.name].length);
    pack.metrics.push({ id: uid('au_' + t.name + '_rows'), name: (tz || t.name) + (rowIsEntity ? '数' : '记录数'), kind: 'simple', dataset: t.name, agg: 'count', additivity: 'additive', unit: '', decimals: 0,
      aliases: [...new Set([...(rowIsEntity ? tAliases.map(a => a + '数') : []), ...(rowIsEntity ? tAliases.map(a => a + '数量') : []), ...tAliases.map(a => a + '记录数'), ...tAliases.map(a => a + '行数')].filter(Boolean))].slice(0, 10),
      auto: true, name_source: tz ? 'model' : 'raw' });
    let dated = false;
    for (const c of t.columns) {
      const key = t.name + '.' + c.name;
      if (skip.has(key)) continue;
      const nm = names[key] || null;
      const zh = nm ? nm.zh : null;
      const al = [...new Set([zh, ...((nm && nm.aliases) || []), c.name, words(c.name)].filter(Boolean))].slice(0, 10);
      // 年份 / 月份 / 是否类的数字列是分组用的，不是可加的量
      const isBool = boolCols.has(key);
      const num = !isBool && isNum(c.type) && !/(^|_)(year|yr|month|week|quarter|level)(_|$)|^(is|has)_|_flag$/i.test(String(c.name));
      if (num && !isIdName(c.name) && isPlatRatio(c)) {
        // 平台算好的比率列：不按行相加、也不按行平均当总体比率；能找到分子分母的话 addDerived 会补「分子合计 ÷ 分母合计」，这里只登记原列（additivity: none）
        const rc = recipeOf(c);
        const dictUnit = (nm && nm.source === 'dict' && nm.unit) || '';
        const pct = !!(c.nfmt && c.nfmt.pct) || /%/.test(String(c.name)) || dictUnit === '%' || (rc && rc.unit === '%');
        const money = !pct && ((rc && rc.money) || /元/.test(dictUnit));
        const cu = money ? moneyUnit(tinfo[t.name], c, dictUnit || '元') : { unit: pct ? '%' : (rc && rc.unit) || (dictUnit === '倍' ? '倍' : '') };
        const pm = colMetric[key] = Object.assign({ id: uid('au_' + t.name + '_' + c.name), name: (zh || c.name) + '（平台值）', plat_zh: zh || c.name, kind: 'simple', dataset: t.name, agg: 'avg', field: c.name,
          additivity: platAdditivity(), platform_ratio: true, unit: cu.unit, decimals: 2, aliases: [(zh || c.name) + '（平台值）'],
          note: '平台口径，取原值，不跨行相加', plat_aliases: al, auto: true, name_source: nm ? nm.source : 'raw' }, curFields(cu));
        pack.metrics.push(pm);
        continue;
      }
      if (num && !isIdName(c.name)) {
        const agg = nm && nm.source === 'dict' ? nm.agg : (nm && nm.source === 'rule' && nm.agg) || 'sum';
        if (['sum', 'avg', 'stock'].includes(agg)) {
          const baseUnit = (nm && nm.unit) || '';
          const cu = (/元/.test(baseUnit) || colCurOf(c) || isMoneyName(c)) ? moneyUnit(tinfo[t.name], c, baseUnit) : { unit: baseUnit };
          colMetric[key] = { agg: agg === 'avg' ? 'avg' : 'sum' };
          pack.metrics.push(colMetric[key] = Object.assign(colMetric[key], { id: uid('au_' + t.name + '_' + c.name), name: zh || c.name, kind: 'simple', dataset: t.name, agg: agg === 'avg' ? 'avg' : 'sum', field: c.name,
            additivity: agg === 'stock' ? 'semiAdditive' : 'additive', unit: cu.unit, decimals: 2, aliases: al.concat(zh ? [zh + '合计', zh + '总额'] : []).slice(0, 12),
            auto: true, name_source: nm ? nm.source : 'raw' }, curFields(cu)));
        }
        continue;
      }
      if (isBool) {
        pack.dims.push({ id: uid('au_' + t.name + '_' + c.name), name: zh || c.name, kind: 'column', dataset: t.name, role: key, match: [c.name], aliases: [...new Set([...al, zh && '是否' + zh].filter(Boolean))].slice(0, 10), bool: true, auto: true, name_source: nm ? nm.source : 'raw' });
        continue;
      }
      if (isDateCol(c) || dateFmts[key]) {
        if (!dated) { dated = true; pack.dims.push({ id: uid('au_' + t.name + '_' + c.name + '_month'), name: (zh || c.name) + '（按月）', kind: 'timeBucket', dataset: t.name, role: key, match: [c.name], grain: 'month', auto: true, name_source: nm ? nm.source : 'raw' }); }
        continue;
      }
      pack.dims.push({ id: uid('au_' + t.name + '_' + c.name), name: zh || c.name, kind: 'column', dataset: t.name, role: key, match: [c.name], aliases: al, auto: true, name_source: nm ? nm.source : 'raw' });
      // 编号列：可以「数有多少个」（去重）
      if (isIdName(c.name)) pack.metrics.push(colMetric[key + '#n'] = { id: uid('au_' + t.name + '_' + c.name + '_n'), name: (zh || c.name) + '个数', kind: 'simple', dataset: t.name, agg: 'dcount', field: c.name,
        additivity: 'distinct', unit: '个', decimals: 0, aliases: [...new Set([zh && zh + '数', zh && '多少个' + zh, words(c.name) + ' count'].filter(Boolean))], auto: true, name_source: nm ? nm.source : 'raw' });
    }
  }

  // 3a) 导入时补常见算法（只看列结构 + 词典，不看表名；对应的列都在、表里又没有同义列才补）
  const platRatios = [];
  addDerived({ tables, pack, names, colMetric, skip, uid, report, tinfo, platRatios });
  pack._meta.currency = {};
  for (const t of tables) { const ti = tinfo[t.name]; pack._meta.currency[t.name] = { code: ti.cur.code, multi: ti.cur.multi, codes: ti.cur.codes, source: ti.cur.source, col: ti.cur.col, zh_default: !!ti.zh && !ti.cur.code && !ti.cur.multi }; }
  pack._meta.platform_ratios = platRatios;
  report.platform_ratios = platRatios.map(x => x.table + '.' + x.col + (x.computed ? ' → ' + x.computed : ' → 取原值'));
  pack._meta.return_notes = returnNotes;
  pack._meta.dup_rows = {};
  for (const t of tables) if (Number(t.dup_rows) > 0) pack._meta.dup_rows[t.name] = Number(t.dup_rows);

  pack._meta.column_formats = Object.fromEntries(tables.flatMap(t=>t.columns.map(c=>[t.name+'.'+c.name,{nfmt:c.nfmt||null,percent_scale:c.percent_scale??(c.nfmt?.pct?1:null),dfmt:c.dfmt||null,system:c.system===true}])));
  for (const m of pack.metrics) { const meta=pack._meta.column_formats[m.dataset+'.'+m.field]; if (m.kind==='simple' && m.unit==='%' && meta?.percent_scale!=null) m.percent_scale=meta.percent_scale; }
  pack._meta.business_columns = Object.fromEntries(tables.map(t=>[t.name,t.columns.filter(c=>!c.system).map(c=>c.name)]));
  for(const m of pack.metrics)qualifyAutoMetric(m,tables.find(t=>t.name===m.dataset));
  for(const m of pack.metrics)if(m.kind==='simple'&&m.agg==='sum'&&m.auto&&!m.confirmed){const d=metricDefaultOfName(m.name);if(d){m.agg=d.agg;if(!m.unit)m.unit=d.unit;m.aliases=[...new Set([...(m.aliases||[]),d.alias].filter(Boolean))];}}
  pack._meta.column_names = {};
  for (const [k, v] of Object.entries(names)) pack._meta.column_names[k] = { zh: v.zh, aliases: (v.aliases || []).slice(0, 4), source: v.source };
  pack._meta.table_names = Object.assign({}, tableZh);
  // 3b) 重名：同一个中文名出现在好几张表（外键列常见，如「赔案编号」）→ 名字前加表的中文名，原名留在叫法里，免得候选里分不清
  const tzOf = ds => tableZh[ds] || ds;
  for (const list of [pack.metrics, pack.dims]) {
    const cnt = new Map(); for (const x of list) cnt.set(x.name, (cnt.get(x.name) || 0) + 1);
    for (const x of list) if (cnt.get(x.name) > 1) { x.aliases = [...new Set([x.name, ...(x.aliases || [])])].slice(0, 12); x.name = tzOf(x.dataset) + '·' + x.name; }
  }
  // 3c) 更新时保留用户确认过的：上一版里 confirmed:true 的指标 / 维度，名字、叫法、确认状态、user_formula 不被新生成的覆盖
  const prev = o.previous && typeof o.previous === 'object' ? o.previous : null;
  if (prev) {
    pack._meta.version = (Number(prev._meta && prev._meta.version) || 1) + 1;
    const keepFrom = (list, prevList, isMetric) => {
      for (const p of (prevList || [])) {
        if (!p || p.confirmed !== true) continue;
        const pf = isMetric ? p.field : (p.role || (Array.isArray(p.match) ? p.dataset + '.' + p.match[0] : null));
        const hit = list.find(x => x.dataset === p.dataset && !x._kept && (
          (pf && (isMetric ? (x.field === pf && (x.agg === p.agg || !x.agg || !p.agg)) : (x.role === pf)))
          || (x.name === p.name)));
        if (!hit) continue;
        hit._kept = true;
        hit.name = p.name; if (p.aliases) hit.aliases = p.aliases; hit.confirmed = true;
        for (const k of Object.keys(p)) if (/^user_formula/.test(k)) hit[k] = p[k];
        report.kept_confirmed++;
      }
      for (const x of list) delete x._kept;
    };
    keepFrom(pack.metrics, prev.metrics, true);
    keepFrom(pack.dims, prev.dims, false);
  }
  // 4) 关系：同名列 + 模型指出的列对，一律用数据实测（只看计数，值不出本机）
  if (typeof o.run === 'function') {
    const cand = [];
    const has = (t, c) => { const tb = tables.find(x => x.name === t); return !!(tb && tb.columns.some(x => x.name === c)); };
    for (let i = 0; i < tables.length; i++) for (let j = i + 1; j < tables.length; j++) {
      for (const c of tables[i].columns) if (!isDateCol(c) && tables[j].columns.some(x => x.name === c.name)) cand.push([tables[i].name, c.name, tables[j].name, c.name, 'same_name']);
    }
    for (const [a, b] of links) {
      const [ta, ca] = String(a).split(/\.(?=[^.]+$)/), [tb, cb] = String(b).split(/\.(?=[^.]+$)/);
      if (ta && ca && tb && cb && ta !== tb && has(ta, ca) && has(tb, cb)) cand.push([ta, ca, tb, cb, 'model']);
      else report.rejected_links.push({ link: [a, b], why: 'not_found' });
    }
    const seen = new Set();
    for (const [ta, ca, tb, cb, why] of cand) {
      const k = [ta, ca, tb, cb].join('|'); if (seen.has(k)) continue; seen.add(k);
      try {
        const one = async sql => { const r = await o.run(sql); const row = (Array.isArray(r) ? r : (r && r.rows) || [])[0] || {}; return Number(Object.values(row)[0]); };
        const da = await one(`SELECT COUNT(DISTINCT CAST(${qi(ca)} AS VARCHAR)) AS n FROM ${qi(ta)} WHERE ${qi(ca)} IS NOT NULL`);
        const db = await one(`SELECT COUNT(DISTINCT CAST(${qi(cb)} AS VARCHAR)) AS n FROM ${qi(tb)} WHERE ${qi(cb)} IS NOT NULL`);
        if (!da || !db) { report.rejected_links.push({ link: [ta + '.' + ca, tb + '.' + cb], why: 'empty' }); continue; }
        const aInB = await one(`SELECT COUNT(DISTINCT CAST(x.${qi(ca)} AS VARCHAR)) AS n FROM ${qi(ta)} x WHERE CAST(x.${qi(ca)} AS VARCHAR) IN (SELECT CAST(${qi(cb)} AS VARCHAR) FROM ${qi(tb)})`);
        if (aInB !== da && aInB !== db) { report.rejected_links.push({ link: [ta + '.' + ca, tb + '.' + cb], why: 'values_do_not_match' }); continue; }
        const dupA = await one(`SELECT COUNT(*) - COUNT(DISTINCT ${qi(ca)}) AS d FROM ${qi(ta)} WHERE ${qi(ca)} IS NOT NULL`);
        const dupB = await one(`SELECT COUNT(*) - COUNT(DISTINCT ${qi(cb)}) AS d FROM ${qi(tb)} WHERE ${qi(cb)} IS NOT NULL`);
        const ua = dupA === 0, ub = dupB === 0;
        // 左边是「多」的一侧
        const [L, Lc, R, Rc, card] = ua && !ub ? [tb, cb, ta, ca, 'N:1'] : !ua && ub ? [ta, ca, tb, cb, 'N:1'] : ua && ub ? [ta, ca, tb, cb, '1:1'] : [ta, ca, tb, cb, 'N:N'];
        pack.relationships.push({ id: uid('au_rel_' + L + '_' + Lc + '_' + R + '_' + Rc), left: L, right: R, pairs: [[Lc, Rc]], cardinality: card, auto: true, found_by: why });
        report.relations.push({ left: L + '.' + Lc, right: R + '.' + Rc, cardinality: card, found_by: why });
      } catch (err) { report.rejected_links.push({ link: [ta + '.' + ca, tb + '.' + cb], why: 'measure_error' }); }
    }
  }
  // 5) 子类型标记表：一张表只有一个编号列，而且这些编号全部是另一张表的主键（1:1）→ 它表示「那张表里属于这一类的行」
  //    （如 Premium 只记 Policy_Amount 的编号 = 这些金额是保费）。这是通用的建表方式，本机按结构和实测认，不看表名
  pack._meta.subtypes = [];
  for (const r of pack.relationships) {
    if (r.cardinality !== '1:1') continue;
    for (const [sub, of, subCol, ofCol] of [[r.left, r.right, r.pairs[0][0], r.pairs[0][1]], [r.right, r.left, r.pairs[0][1], r.pairs[0][0]]]) {
      const st = tables.find(t => t.name === sub), ot = tables.find(t => t.name === of);
      if (!st || !ot || st.columns.length !== 1 || ot.columns.length < 2) continue;
      if (pack._meta.subtypes.some(x => x.table === sub)) continue;
      pack._meta.subtypes.push({ table: sub, of, key: subCol, of_key: ofCol, zh: tableZh[sub] || null });
    }
  }
  report.subtypes = pack._meta.subtypes.map(x => x.table + '⊂' + x.of);
  // 6) 桥表（角色表）：一张表里 ≥2 列分别连到别的表（包含率实测已经认出的关系），外加一列取值很少的明确角色列
  //    （如 保单号 + 当事人编号 + 角色代码：同一个当事人在不同保单里可以是投保人、被保人、受益人）。只记结构和个数，不记取值。
  pack._meta.bridges = [];
  report.bridges = [];
  if (typeof o.run === 'function') {
    for (const t of tables) {
      const links = [];
      for (const r of pack.relationships) for (const [Lc, Rc] of (r.pairs || [])) {
        if (r.left === t.name && r.right !== t.name) links.push({ col: Lc, to: r.right + '.' + Rc });
        else if (r.right === t.name && r.left !== t.name) links.push({ col: Rc, to: r.left + '.' + Lc });
      }
      const uniq = []; const seenL = new Set();
      for (const l of links) { const k = l.col + '>' + l.to; if (!seenL.has(k)) { seenL.add(k); uniq.push(l); } }
      const linkCols = new Set(uniq.map(l => l.col));
      const targets = new Set(uniq.map(l => l.to.split('.')[0]));
      if (linkCols.size < 2 || targets.size < 2) continue;
      // 角色列：不是连接列、不是数值 / 日期、列名明确表示角色，实测不同的值 ≤ 20 个
      // 低基数类型码不一定是参与方角色（也可能是金额类型），只认明确命名的角色列。
      const cands = t.columns.filter(c => !linkCols.has(c.name) && !isNum(c.type) && !isDateCol(c) && /(role|角色)/i.test(String(c.name)));
      cands.sort((a, b) => (/(role|角色)/i.test(b.name) ? 1 : 0) - (/(role|角色)/i.test(a.name) ? 1 : 0));
      for (const c of cands) {
        let n = NaN;
        try { const r = await o.run(`SELECT COUNT(DISTINCT CAST(${qi(c.name)} AS VARCHAR)) AS n FROM ${qi(t.name)} WHERE ${qi(c.name)} IS NOT NULL`); const row = (Array.isArray(r) ? r : (r && r.rows) || [])[0] || {}; n = Number(Object.values(row)[0]); } catch (_) {}
        if (Number.isFinite(n) && n >= 1 && n <= 20) {
          pack._meta.bridges.push({ table: t.name, links: uniq, role_col: c.name, n_roles: n });
          report.bridges.push(t.name + '(' + uniq.map(l => l.col).join(',') + ' | ' + c.name + ')');
          break;
        }
      }
    }
  }
  return { pack, report };
}


/* ---------- 导入时补常见算法 ---------- */
const entIds = name => { try { return dict.identify(name).entries.map(e => e.id); } catch (_) { return []; } };
const hasWord = (name, re) => re.test(words(name));
// 数量 / 单价 / 金额 / 花费 这些「角色」，按词典条目 id 或列名词来认
const isQtyCol = c => { const ids = entIds(c.name); return ids.some(i => ['quantity', 'units', 'sales_qty'].includes(i)) || hasWord(c.name, /\b(qty|quantity|units)\b/); };
const isPriceCol = c => { const ids = entIds(c.name); return ids.some(i => ['unit_price', 'avg_price'].includes(i)) || hasWord(c.name, /\bprice\b/); };
const isAmountCol = c => {
  if (isQtyCol(c) || isPriceCol(c)) return false;
  try { const r = dict.identify(c.name); if (r.entries.length === 1 && r.entries[0].agg === 'sum' && /元/.test(r.entries[0].unit || '')) return true; } catch (_) {}
  return hasWord(c.name, /\b(amount|revenue|sales|total)\b/);
};
// 比率里要的角色 → 这一列算哪个角色（花费类要在，才把销售 / 收入类当成「广告销售额」）
const roleOf = (c, hasSpend) => {
  const ids = entIds(c.name);
  const w = x => hasWord(c.name, x);
  if (ids.includes('clicks') || w(/\bclicks?\b/)) return 'clicks';
  if (ids.includes('impressions') || w(/\bimpressions?\b/)) return 'impressions';
  if (ids.includes('ad_orders')) return 'ad_orders';
  if (ids.includes('conversions') || w(/\bconversions?\b/) || w(/^conv$/)) return 'conversions';
  if (ids.some(i => ['cost', 'ad_spend', 'spend'].includes(i)) || w(/\b(cost|spend)\b/)) return 'ad_spend';
  if (hasSpend && (ids.some(i => ['ad_sales', 'sales', 'revenue', 'gmv', 'conv_value'].includes(i)) || w(/\b(revenue|sales|gmv)\b/) || w(/\bconv\w*\s*value\b/))) return 'ad_sales';
  return null;
};
function addDerived({ tables, pack, names, colMetric, skip, uid, report, tinfo, platRatios }){
  const add = m => { pack.metrics.push(Object.assign({ auto: true, name_source: 'derived', decimals: 2 }, m)); report.derived_added.push(m.name); return m; };
  const dedupAlias = (...xs) => [...new Set(xs.flat().filter(Boolean))].slice(0, 12);
  for (const t of tables) {
    const nameTaken = n => pack.metrics.some(m => m.dataset === t.name && m.name === n);
    const numCols = t.columns.filter(c => isNum(c.type) && !skip.has(t.name + '.' + c.name));
    // (a) 数量 × 单价 → 销售额（逐行相乘再求和）；表里已有金额类列就不补
    let salesMetric = null, ordersMetric = null;
    const qty = numCols.find(isQtyCol), price = numCols.find(isPriceCol);
    const hasAmount = t.columns.some(isAmountCol) || nameTaken('销售额') || nameTaken('销售金额');
    if (qty && price && qty !== price && !hasAmount) {
      const qm = colMetric[t.name + '.' + qty.name];
      let pm = colMetric[t.name + '.' + price.name];
      if (qm && qm.agg === 'sum') {
        if (!pm) {   // 词典里「均价」是比率，常规流程不建指标；这里单价那一腿需要一个 avg 指标
          const nm = names[t.name + '.' + price.name];
          const cu = moneyUnit(tinfo && tinfo[t.name], price, (nm && nm.unit) || '元');
          pm = Object.assign({ id: uid('au_' + t.name + '_' + price.name), name: (nm && nm.zh) || price.name, kind: 'simple', dataset: t.name, agg: 'avg', field: price.name, additivity: 'additive', unit: cu.unit, decimals: 2,
            aliases: dedupAlias(nm && nm.aliases, price.name, words(price.name)), auto: true, name_source: nm ? nm.source : 'raw' }, curFields(cu));
          pack.metrics.push(pm);
        }
        if (pm.agg === 'avg') {
          salesMetric = add(inheritCur({ id: uid('au_' + t.name + '_sales_amount'), name: '销售额', kind: 'derived', dataset: t.name, expr: { op: 'mul', args: [qm.id, pm.id] },
            additivity: 'additive', unit: pm.unit != null ? pm.unit : '元', aliases: ['销售额', '销售金额', '营业额', '收入', 'GMV', 'Revenue', 'Sales'] }, pm));
        }
      }
    }
    // (b) 订单 / 发票编号列的去重计数 → 订单数
    const idCol = t.columns.find(c => isIdName(c.name) && hasWord(c.name, /\b(order|invoice|transaction|receipt)\b/) && colMetric[t.name + '.' + c.name + '#n']);
    if (idCol && !nameTaken('订单数')) {
      const m = colMetric[t.name + '.' + idCol.name + '#n'];
      m.aliases = dedupAlias('订单量', '单数', '多少单', '订单个数', m.aliases);
      m.name = '订单数'; ordersMetric = m; m.name_source = 'derived';
    }
    // (c) 客单价 = 销售额 ÷ 订单数（10-24：语义层的比率已支持「逐行相乘」的分子，派生的销售额也能直接补）
    if (salesMetric && ordersMetric && !nameTaken('客单价')) {
      add(inheritCur({ id: uid('au_' + t.name + '_aov'), name: '客单价', kind: 'ratio', dataset: t.name, num: salesMetric.id, den: ordersMetric.id, mul: 1,
        additivity: 'ratio', unit: salesMetric.unit, aliases: ['客单价', '平均订单金额', 'AOV', '每单金额'] }, salesMetric));
    }
    // (d) 花费类 + 点击 / 曝光 / 转化 / 收入类 → CTR、CPC、CPM、转化率、ROAS……（分子分母角色取自词典里 R(...) 的定义）
    const hasSpend = numCols.some(c => roleOf(c, false) === 'ad_spend' && colMetric[t.name + '.' + c.name] && !colMetric[t.name + '.' + c.name].platform_ratio);
    if (hasSpend) {
      const role = {};   // 角色 → 指标（同角色取第一个 sum 指标）
      for (const c of numCols) {
        const m = colMetric[t.name + '.' + c.name]; if (!m || m.agg !== 'sum') continue;
        const r = roleOf(c, true); if (r && !role[r]) role[r] = m;
      }
      const want = [['ctr', null], ['cpc', null], ['cpm', null], ['ad_cvr', '转化率'], ['roas', null], ['cpa', null], ['cpo', null], ['acos', null]];
      for (const [eid, rename] of want) {
        const e = dict.byId.get(eid); if (!e) continue;
        const pick = r => role[r] || (r === 'ad_orders' ? role.conversions : null);
        const nu = pick(e.num), de = pick(e.den);
        if (!nu || !de || nu === de) continue;
        const nm = rename || e.zh;
        if (nameTaken(nm)) continue;
        // 转化数 / 广告订单数 同时有时，转化率、单次转化成本只按一个口径补，不重复
        if (eid === 'cpo' && role.ad_orders === undefined) continue;
        if (eid === 'cpa' && role.conversions === undefined) continue;
        add(inheritCur({ id: uid('au_' + t.name + '_' + eid), name: nm, kind: 'ratio', dataset: t.name, num: nu.id, den: de.id, mul: e.mul || 1,
          additivity: 'ratio', unit: /元/.test(e.unit || '') ? (nu.unit || '') : (e.unit || ''), aliases: dedupAlias(nm, e.zh, e.en, e.abbr || [], (e.alias || []).slice(0, 5)) }, /元/.test(e.unit || '') ? nu : null));
      }
    }
    // (e) 平台算好的比率列（CTR、Avg. CPC、Cost / conv.、Conv. rate、ROAS、AOV、Engagement rate、Bounce rate……）
    //     不能按行相加，也不能按行平均当总体比率：找得到分子分母列，就补「分子合计 ÷ 分母合计」；找不到，原列取原值
    {
      const hasSp = numCols.some(c => roleOf(c, false) === 'ad_spend');
      const role = {};
      for (const c of numCols) {
        const m = colMetric[t.name + '.' + c.name]; if (!m || m.agg !== 'sum' || m.platform_ratio) continue;
        const w = words(c.name);
        const r = roleOf(c, hasSp) || (/\bengaged sessions?\b/.test(w) ? 'engaged_sessions' : /\bengagements?\b/.test(w) ? 'engagements' : /\bbounces\b/.test(w) ? 'bounces'
          : /\b(sessions?|visits?)\b/.test(w) ? 'sessions' : /\borders?\b/.test(w) && !isIdName(c.name) ? 'orders' : isAmountCol(c) && !/refund/.test(w) ? 'sales' : null);
        if (r && !role[r]) role[r] = m;
      }
      const ordM = pack.metrics.find(m => m.dataset === t.name && m.name === '订单数' && m.agg === 'dcount');
      if (!role.orders && ordM) role.orders = ordM;
      if (!role.sales) { const sm = pack.metrics.find(m => m.dataset === t.name && m.name === '销售额' && m.kind === 'derived'); if (sm) role.sales = sm; }
      for (const c of t.columns) {
        const om = colMetric[t.name + '.' + c.name];
        if (!om || !om.platform_ratio) continue;
        const rc = recipeOf(c);
        let done = null;
        if (rc) for (const [rn, rd] of rc.pairs) {
          const nu = role[rn], de = role[rd];
          if (!nu || !de || nu === de) continue;
          const mul = rc.mul || 1;
          let ex = pack.metrics.find(m => m.dataset === t.name && m.kind === 'ratio' && m.num === nu.id && m.den === de.id && (m.mul || 1) === mul);
          if (!ex) {
            let nm = rc.zh; if (nameTaken(nm)) nm = rc.zh + '（合计口径）';
            if (nameTaken(nm)) continue;
            ex = add(inheritCur({ id: uid('au_' + t.name + '_' + sid(c.name) + '_ratio'), name: nm, kind: 'ratio', dataset: t.name, num: nu.id, den: de.id, mul,
              additivity: 'ratio', unit: rc.money ? (nu.unit || '') : (rc.unit || ''), aliases: dedupAlias(nm, rc.zh, c.name, words(c.name), om.plat_aliases || []) }, rc.money ? nu : null));
          }
          done = { metric: ex, num: nu, den: de, mul };
          break;
        }
        if (done) {
          om.computed_by = done.metric.id;
          om.note = `平台算好的比率，不跨行相加；总体比率用「${done.metric.name}」= ${done.num.field || done.num.name} 合计 ÷ ${done.den.field || done.den.name} 合计${done.mul !== 1 ? ' × ' + done.mul : ''}`;
          platRatios.push({ table: t.name, col: c.name, num: [done.num.field || done.num.name], den: [done.den.field || done.den.name], mul: done.mul, unit: om.unit || '', computed: done.metric.name });
        } else {
          om.name = om.plat_zh; om.aliases = dedupAlias(om.plat_zh, om.plat_aliases || []);
          platRatios.push({ table: t.name, col: c.name, num: [], den: [], mul: 1, unit: om.unit || '', computed: null, note: '平台口径，取原值，不跨行相加' });
        }
        delete om.plat_aliases;
      }
    }
  }
}

/** 一个计划 / 一条 SQL 用到的东西里，有没有自动起名、还没确认的（返回中文名 = 原字段的说明，最多 3 条） */
function autoUsedInPlan(plan, registry){
  const out = [];
  const add = (x) => { if (x && x.auto && !x.confirmed) { const f = x.field || (x.source && x.source.field) || (Array.isArray(x.match) ? x.match[0] : null) || ''; const s = `${x.name} = ${x.dataset || x.boundTo || (x.source && x.source.table) || ''}${f ? '.' + f : ''}`; if (!out.includes(s)) out.push(s); } };
  try {
    for (const id of (plan.metric_ids || [])) { try { for (const l of registry.leaves(id)) add(registry.metric(l)); } catch (_) {} try { add(registry.metric(id)); } catch (_) {} }
    for (const d of [...(plan.dimensions || []), ...(plan.entities || []).map(e => e.dim), ...(plan.negations || []).map(e => e.dim)]) { try { add(registry.dim(d)); } catch (_) {} }
  } catch (_) {}
  return out.slice(0, 3);
}

module.exports = { qualifyAutoMetric, metricDefaultOfName, buildAutoPack, buildNamerMessages, autoUsedInPlan, fromDict, AUTO_PACK_ID, NAMER_SYSTEM };
