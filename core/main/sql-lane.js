// ================= 限制级 SQL 兜底（第三轮）=================
// 配置单表达不了时，让模型写一条 SQL；本机检查（DuckDB 自带 json_serialize_sql 拆语法树，不自己写解析器）+ 只读执行；
// 结果在本机变成事实编号回填答案；模型永远看不到查询结果（报错交回去前也去掉数据值）。
// 三条硬约束：只许 SELECT（禁 COPY / ATTACH / EXPORT / 读文件的表函数）；行数和时间预算（LIMIT 61、约 20 秒）；只读连接。
// 可信档：已核 verified / 待确认 pending / 未核 unverified —— 按「登记」规则判（tierOf）；只有未核不能进卡片、报告、口径（isPersistable）。
'use strict';

const { describeFormat } = require('./date-format');

const SQL_MARK = '【SQL兜底】';
const MAX_ROWS = 60;
const RUN_TIMEOUT_MS = 20000;

// 读文件 / 读系统 / 读配置的函数：一律不许（表函数另由 TABLE_FUNCTION 节点整类拦掉）
const FN_BLACKLIST = new Set([
  'getenv', 'read_text', 'read_blob', 'current_setting', 'getvariable', 'set_variable', 'glob', 'read_csv', 'read_csv_auto',
  'read_parquet', 'parquet_scan', 'read_json', 'read_json_auto', 'read_json_objects', 'read_ndjson', 'sqlite_scan', 'sqlite_attach',
  'query', 'query_table', 'duckdb_settings', 'duckdb_extensions', 'duckdb_secrets', 'which_secret', 'pragma_version',
  'current_database', 'current_schema', 'current_schemas', 'current_user', 'session_user', 'user', 'version', 'pg_typeof_internal',
]);
const AGG_FNS = new Set(['sum', 'count', 'count_star', 'avg', 'mean', 'min', 'max', 'median', 'mode', 'quantile', 'quantile_cont', 'quantile_disc',
  'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'string_agg', 'list', 'array_agg', 'arg_max', 'arg_min', 'max_by', 'min_by',
  'first', 'last', 'any_value', 'bool_and', 'bool_or', 'product', 'sumkahan', 'fsum', 'approx_count_distinct', 'count_if', 'countif', 'sum_no_overflow']);
const DATE_FNS = new Set(['dayofweek', 'isodow', 'dayname', 'dayofmonth', 'dayofyear', 'day', 'week', 'weekofyear', 'yearweek', 'month', 'monthname',
  'quarter', 'year', 'date_trunc', 'datetrunc', 'date_part', 'datepart', 'extract', 'strftime', 'strptime', 'try_strptime', 'date_diff', 'datediff', 'date_sub',
  'last_day', 'make_date', 'date_add', 'age', 'epoch', 'to_days', 'isoyear', 'weekday', 'time_bucket', 'generate_series', 'range']);
// 不改变口径的函数：取整、类型转换、空值处理、比较与四则运算
const NEUTRAL_FNS = new Set(['round', 'abs', 'coalesce', 'ifnull', 'nullif', '+', '-', '*', 'greatest', 'least', 'trunc', 'floor', 'ceil', 'ceiling',
  'upper', 'lower', 'trim', 'concat', '||', 'cast', 'try_cast']);

const sq = s => "'" + String(s).replace(/'/g, "''") + "'";
const isDateLit = s => /^\d{4}-\d{2}(-\d{2})?$/.test(String(s));

/* ---------- 语义包 → 兜底上下文（表结构、已登记指标、关系、时间口径；不含任何数据行或样例值） ---------- */
function contextFromRegistry(registry, opts = {}){
  const sem = registry && registry.semantic;
  // 列类型优先用数据库里的真实类型（opts.types：表 → 列 → 类型，来自 information_schema，只有名字和类型、没有数据）
  const realType = (t, c) => { const m = opts.types && opts.types[String(t).toLowerCase()]; return m && m[String(c).toLowerCase()] ? m[String(c).toLowerCase()] : null; };
  // 10-23：知道数据库里有哪些表时，只列库里真有的（真 App 里语义层的表名可能是文件显示名，库里实际叫 v_<表id>；查不到的名字不给模型）
  const known = opts.types && Object.keys(opts.types).length ? opts.types : null;
  const tables = ((registry && registry.tables) || []).filter(t => !known || known[String(t.name).toLowerCase()]).map(t => ({ name: String(t.name), columns: (t.columns || []).map(c => ({ name: String(c.name), type: String(realType(t.name, c.name) || c.type || 'text'), percent_scale:c.percent_scale??(c.nfmt?.pct?1:null), system:c.system===true })) }));
  const metrics = [], dims = [], rels = [], roles = [];
  const fields = new Map();   // 表 → 语义包里登记过的字段
  const autoFields = new Set();   // 10-23：导入时自动起名、还没确认的字段（表.列）
  const addField = (t, f) => { if (!t || !f) return; if (!fields.has(t)) fields.set(t, new Set()); fields.get(t).add(String(f)); };
  if (sem) {
    for (const m of sem.metrics.values()) {
      if (m.unbound) continue;
      metrics.push({ id: m.id, name: m.name, aliases:m.aliases||[], auto:!!m.auto, confirmed:!!m.confirmed, kind: m.kind || 'simple', dataset: m.dataset || m.boundTo || null, agg: m.agg || null, field: m.field || null,
        num: m.num || null, den: m.den || null, mul: m.mul || 1, expr: m.expr || null, additivity: m.additivity || null, unit: m.unit || '',
        percent_scale: m.percent_scale ?? null, multi_currency: !!m.multi_currency, currency_unknown: !!m.currency_unknown, platform_ratio: !!m.platform_ratio, note: m.note || null,
        // 10-23：行级乘积（数量 × 单价）在说明里写成「逐行相乘再求和」，不能让模型写成 SUM(数量) × AVG(单价)
        row_product: (() => { try { const rp = typeof sem.rowProductOf === 'function' ? sem.rowProductOf(m.id) : null; return rp ? { a: rp.fact.dataset + '.' + rp.fact.field, b: rp.attr.dataset + '.' + rp.attr.field } : null; } catch (_) { return null; } })() });
      if (m.field) addField(m.dataset || m.boundTo, m.field);
      if (m.auto && !m.confirmed && m.field) autoFields.add((m.dataset || m.boundTo) + '.' + m.field);
    }
    for (const d of sem.dims.values()) {
      if (d.unbound || !d.source || !d.source.table) continue;
      dims.push({ id: d.id, name: d.name, table: d.source.table, field: d.source.field, kind: d.kind || 'column', ...(d.valueAliases&&d.valueAliasSource?.confirmed?{valueAliases:d.valueAliases,valueAliasSource:d.valueAliasSource,subjectField:d.subjectField||null}:{}) });
      addField(d.source.table, d.source.field);
      if (d.auto && !d.confirmed) autoFields.add(d.source.table + '.' + d.source.field);
    }
    for (const r of (sem.rels ? sem.rels.values() : [])) {
      if (r.unbound) continue;
      rels.push({ left: r.left, right: r.right, pairs: (r.pairs || []).map(p => [String(p[0]), String(p[1])]), auto: !!(r.auto && !r.confirmed) });
      for (const p of r.pairs || []) { addField(r.left, p[0]); addField(r.right, p[1]); }
    }
    for (const [t, ds] of (sem.datasets ? sem.datasets.entries() : [])) for (const k of (ds && ds.keys) || []) addField(t, k);
    for (const [t, g] of (sem.grains ? sem.grains.entries() : [])) for (const k of (Array.isArray(g) ? g : (g && g.keys) || [])) addField(t, k);
  }
  try {
    for (const r of registry.timeRoles()) {
      let field = null;
      try { const d = registry.dim(r.dim); field = d && d.source && d.source.field; } catch (_) {}
      if (r.dataset && field) { roles.push({ table: r.dataset, field, name: r.name || '' }); addField(r.dataset, field); }
    }
  } catch (_) {}
  // 10-23：导入自动语义带的「每列中文名」和「子类型标记表」（只有名字和结构，没有数据）
  const colNames = {}, tableNames = {}, subtypes = [], bridges = [];
  try {
    for (const p of (registry.packDefs || [])) {
      const m = p && p._meta; if (!m || m.origin !== 'auto') continue;
      Object.assign(colNames, m.column_names || {});Object.assign(tableNames,m.table_names||{});
      for (const s of m.subtypes || []) subtypes.push(s);
      for (const b of m.bridges || []) bridges.push(b);
    }
  } catch (_) {}
  // 10-23：文本日期列的写法（"表.列" → { format, ambiguous }）；模型看不到数据，不告诉它就只会写 CAST(列 AS DATE) 然后报错
  const dateFormats = {};
  try {
    for (const p of (registry.packDefs || [])) Object.assign(dateFormats, (p && p._meta && p._meta.date_formats) || {});
    if (sem && sem.dateFormats) for (const [k, v] of Object.entries(sem.dateFormats)) if (!dateFormats[k]) dateFormats[k] = v;
  } catch (_) {}
  // 10-24：英文导出的币种 / 平台比率列 / 退货取消说明 / 完全重复行（都只是名字、结构和计数，没有数据值）
  const currency = {}, platformRatios = [], returnNotes = [], dupRows = {};
  try {
    for (const p of (registry.packDefs || [])) {
      const m = p && p._meta; if (!m || m.origin !== 'auto') continue;
      Object.assign(currency, m.currency || {});
      for (const x of m.platform_ratios || []) platformRatios.push(x);
      for (const x of m.return_notes || []) returnNotes.push(x);
      Object.assign(dupRows, m.dup_rows || {});
    }
    for (const t of ((registry && registry.tables) || [])) if (Number(t.dup_rows) > 0) dupRows[t.name] = Number(t.dup_rows);
  } catch (_) {}
  for(const t of registry.tables||[])if(CUR_NAME[t.currency]&&!currency[t.name]?.multi&&!(t.columns||[]).some(c=>c.nfmt?.cur))currency[t.name]={code:t.currency,multi:false,source:'用户表设置',zh_default:false};
  const names = new Set(tables.map(t=>t.name));
  const fieldAllowed = k => tables.some(t=>t.columns.some(c=>t.name+'.'+c.name===k));
  const keepFields = obj => Object.fromEntries(Object.entries(obj||{}).filter(([k])=>fieldAllowed(k)));
  return { tables, metrics, dims, rels, roles, fields, autoFields, colNames:keepFields(colNames),tableNames:Object.fromEntries(Object.entries(tableNames).filter(([t])=>names.has(t))),
    subtypes:subtypes.filter(x=>names.has(x.table)&&names.has(x.of)&&fieldAllowed(x.table+'.'+x.key)&&fieldAllowed(x.of+'.'+x.of_key)), bridges:bridges.filter(x=>names.has(x.table)&&fieldAllowed(x.table+'.'+x.role_col)&&(x.links||[]).every(l=>fieldAllowed(x.table+'.'+l.col)&&fieldAllowed(l.to))),
    dateFormats:keepFields(dateFormats), currency:Object.fromEntries(Object.entries(currency).filter(([t])=>names.has(t))),
    platformRatios:platformRatios.filter(x=>names.has(x.table)&&fieldAllowed(x.table+'.'+x.col)&&[...(x.num||[]),...(x.den||[])].every(k=>fieldAllowed(k)||fieldAllowed(x.table+'.'+k))), returnNotes:returnNotes.filter(x=>tables.some(t=>t.columns.some(c=>String(x).startsWith(t.name+'.'+c.name)))),
    dupRows:Object.fromEntries(Object.entries(dupRows).filter(([t])=>names.has(t))), scope:registry.requestScope || {}, deniedColumns:registry.deniedColumns || [] };
}

const sqlIdentifier=n=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(n))&&!/^(?:order|group|limit|select|from|where|by|desc|asc|user)$/i.test(String(n))?String(n):qid(n);
const sqlField=(t,f)=>sqlIdentifier(t)+'.'+sqlIdentifier(f);
function metricAlgo(m, byId){
  const ref = id => { const x = byId.get(String(id).replace(/^m:/, '')); return x ? metricAlgo(x, byId) : String(id); };
  if (m.kind === 'simple') {
    const t = m.dataset;
    if (m.agg === 'count') return `COUNT(*) FROM ${sqlIdentifier(t)}`;
    if (m.agg === 'dcount') return `COUNT(DISTINCT ${sqlField(t,m.field)})`;
    return `${String(m.agg || 'sum').toUpperCase()}(${sqlField(t,m.field)})`;
  }
  if (m.kind === 'ratio') return `${ref(m.num)} / ${ref(m.den)}${m.mul && m.mul !== 1 ? ' × ' + m.mul : ''}`;
  if (m.row_product) return `SUM(${m.row_product.a} × ${m.row_product.b})（逐行相乘再求和，不是两个合计相乘）`;
  if (m.kind === 'derived' && m.expr) { const op = { add: ' + ', sub: ' - ', mul: ' × ', div: ' / ' }[m.expr.op] || ' ? '; return (m.expr.args || []).map(ref).join(op); }
  return m.kind || '';
}

/* 字段中文名那一段：同表同列的中文名如果已经是前面的指标名 / 维度名，就不再重复列；一张表一列不剩就整行不出，全都不剩连标题也不出 */
function colNameLines(c,question){
  if (!(c.colNames && Object.keys(c.colNames).length)) return [];
  const shown = new Set();   // "表|列|中文名"：前面指标 / 维度里已经出现过的
  for (const m of c.metrics || []) if (m.name && m.field && (m.dataset)) shown.add([m.dataset, m.field, m.name].join('|'));
  for (const d of c.dims || []) if (d.kind === 'column' && d.name && d.table && d.field) shown.add([d.table, d.field, d.name].join('|'));
  const rows = (c.tables || []).map(t => {
    const xs = t.columns.map(x => {
      const n = c.colNames[t.name + '.' + x.name];
      if (!n || !n.zh || shown.has([t.name, x.name, n.zh].join('|'))) return null;
      const aliases=(n.aliases||[]).filter(a=>String(a).length>=2&&(String(question||'').trim().length<2||String(question).toLowerCase().includes(String(a).toLowerCase())||String(question).toLowerCase().includes(String(n.zh).toLowerCase()))&&a!==n.zh).slice(0,2);
      return `${x.name}=${n.zh}${aliases.length ? '/' + aliases.join('/') : ''}`;
    }).filter(Boolean);
    return xs.length ? `${t.name}：${xs.join('，')}` : null;
  }).filter(Boolean);
  return rows.length ? ['字段中文名（导入时自动认的；意思相同、叫法不同的就是这个字段，直接用）：', ...rows] : [];
}

/* 文本日期列的写法：这些列存的是文字（如 10/21/2021），不能直接 CAST AS DATE，要按格式转 */
function dateFormatLines(c){
  const rows = Object.entries(c.dateFormats || {}).filter(([, v]) => v && v.format).map(([k, v]) =>
    `${k} = ${describeFormat(v.format)}（格式 ${v.format}${v.ambiguous ? '，月和日分不清、按月/日' : ''}）`);
  return rows.length ? ['文本日期列的格式（这些列存的是文字，不是日期类型）：', ...rows,
    '对这些列用 TRY_STRPTIME(列, \'格式\') 转成日期再比较 / 分组 / 取年月（如 TRY_STRPTIME("Campaign Date", \'%m/%d/%Y\')），不要直接 CAST(列 AS DATE)，也不要拿原文字当日期比较。'] : [];
}

/* 币种：每张表金额是什么币种（来自表头 / 币种列 / 导入识别）；多种币种不能直接相加；认不出就不写单位 */
const CUR_NAME = { USD: '美元', GBP: '英镑', EUR: '欧元', JPY: '日元', CNY: '元', RMB: '元' };
function currencyLines(c){
  const names = new Set((c.tables || []).map(t => t.name));
  const rows = [];
  for (const [t, v] of Object.entries(c.currency || {})) {
    if (!v || (names.size && !names.has(t))) continue;
    if (v.multi) rows.push(`${t}：含多种币种（${(v.codes || []).join(' / ')}）${v.col ? '，币种列 ' + v.col : ''}；没换汇，金额不能直接相加。问合计时按币种分组分别算（unit 留空，label 写明含多种币种、未换汇）`);
    else if (v.code) rows.push(`${t}：币种 ${CUR_NAME[v.code] || v.code}（unit 写 ${CUR_NAME[v.code] || v.code}）`);
    else if (!v.zh_default) rows.push(`${t}：币种数据未标明`);
  }
  return rows.length ? ['币种（仅金额适用；未标明者unit留空、label说明币种未标明；天数、件数、次数、比率不写币种）：', ...rows] : [];
}
/* 平台算好的比率列：不能 SUM / AVG，要用分子合计 ÷ 分母合计 */
function platformRatioLines(c){
  const names = new Set((c.tables || []).map(t => t.name));
  const xs = (c.platformRatios || []).filter(x => !names.size || names.has(x.table));
  if (!xs.length) return [];
  return ['平台算好的比率列（不能 SUM / AVG，也不能按行平均；要用分子合计 ÷ 分母合计，列出的就是能用的分子分母；问某一行自己的值才取原值）：',
    ...xs.map(x => x.computed && x.num.length && x.den.length
      ? `${x.table}.${x.col} = SUM(${x.num.join(' + ')}) / SUM(${x.den.join(' + ')})${x.mul && x.mul !== 1 ? ' × ' + x.mul : ''}${x.unit ? '（单位' + x.unit + '）' : ''}`
      : `${x.table}.${x.col}：${x.note || '平台口径，取原值，不跨行相加'}，没有可用的分子分母，不要 SUM / AVG`)];
}
function extraNoteLines(c){
  const names = new Set((c.tables || []).map(t => t.name));
  const out = [];
  const rn = (c.returnNotes || []).filter(x => !names.size || names.has(String(x).split('.')[0]));
  if (rn.length) out.push('退货 / 取消 / 退款（认出来了，销售额默认不扣退款）：', ...rn.slice(0, 6));
  const dr = Object.entries(c.dupRows || {}).filter(([t, n]) => n > 0 && (!names.size || names.has(t)));
  if (dr.length) out.push(...dr.map(([t, n]) => `${t} 这张表有 ${n} 行完全重复，默认照原样算（不去重），题目要求去重才去重。`));
  return out;
}


/* ---------- 10-24 提示词补充：词典算法 / 星期几写法 / 类别列取值 / 目标计划表 ---------- */
// a. 题面点到出厂词典里有算法的指标（动销率、售罄率、客单价……）：只取 1–3 条，把算法 + 默认口径写进提示词。
//    算法只来自词典 desc 里「= 公式」那段，默认口径来自 dict.defaultFor；表里已登记同名指标的不重复（下面「已登记指标」已有算法）。
function dictAlgoLines(question, registeredNames){
  let dict = null;
  try { dict = require('./dict'); } catch (_) { return []; }
  if (!dict || typeof dict.termsIn !== 'function' || !question) return [];
  const seen = new Set(), out = [];
  const have = new Set((registeredNames || []).map(x => String(x)));
  let terms = [];
  try { terms = dict.termsIn(String(question)); } catch (_) { return []; }
  for (const t of terms) for (const id of t.ids || []) {
    if (seen.has(id) || out.length >= 3) continue;
    const e = dict.byId && dict.byId.get(id);
    if (!e || have.has(e.zh)) continue;
    const m = String(e.desc || '').match(/=\s*(.+)$/);
    if (!m) continue;
    seen.add(id);
    let def = '';
    try { def = (dict.defaultFor(id) || []).filter(x => !['P01', 'P06', 'P10', 'P29'].includes(x.id)).slice(0, 2).map(x => x.default).join('；'); } catch (_) {}
    out.push(`${e.zh} = ${m[1].trim()}${def ? '（默认口径：' + def.slice(0, 80) + '）' : ''}`);
  }
  return out.length ? ['题面里的指标，出厂词典有算法（按这个算，字段从上面的表里找；缺字段才说没有，输出 abstain）：', ...out] : [];
}
// b. 按星期几：DuckDB 写法 + 中文标签
const WEEKDAY_Q = /星期|周[一二三四五六日天末]|礼拜|工作日|周末|weekday|day of week/i;
function weekdayLines(question){
  if (!WEEKDAY_Q.test(String(question || ''))) return [];
  return ['按星期几统计：日期列先转成日期（日期类型直接用；文本日期列先 TRY_STRPTIME(列, \'格式\') 或 CAST(列 AS DATE)）。',
    '星期编号用 isodow(日期)（周一=1 … 周日=7；dayofweek / strftime(日期, \'%w\') 是周日=0），英文名用 dayname(日期)。',
    '输出的标签列写成中文：CASE isodow(d) WHEN 1 THEN \'周一\' WHEN 2 THEN \'周二\' WHEN 3 THEN \'周三\' WHEN 4 THEN \'周四\' WHEN 5 THEN \'周五\' WHEN 6 THEN \'周六\' WHEN 7 THEN \'周日\' END，并按星期编号排序。'];
}
// c. 类别列取值：模型看不到数据、也只能写一条 SELECT（没有「先查一下有哪些取值」的第二步）。
//    做法：本机提前统计「状态 / 类型 / 等级 / 渠道 / 国家」这类取值很少的类别列，把取值清单（≤ 20 个、每个 ≤ 30 字）放进上下文。
//    金额、编号、人名、自由文本、数字列一律不放。清单由 collectCategoryValues 在本机查出来放进 context.catValues。
const CAT_COL = /状态|类型|等级|级别|渠道|国家|地区|区域|类别|分类|平台|方式|status|state|type|kind|level|grade|tier|channel|country|region|category|class|platform|method|priority|severity/i;
const NOT_CAT_COL = /金额|价格|单价|amount|price|cost|revenue|salary|id$|_id|编号|单号|号码|名称|姓名|name|描述|备注|说明|原因|note|comment|desc|remark|email|邮箱|phone|电话|地址|address|url|sku|code$/i;
const MAX_CAT_VALUES = 20, MAX_CAT_LEN = 30, MAX_CAT_COLS = 40;
function catColumnCandidates(tables){
  const out = [];
  for (const t of tables || []) for (const col of t.columns || []) {
    if (!CAT_COL.test(col.name) || NOT_CAT_COL.test(col.name)) continue;
    if (!/char|text|string|varchar|enum/i.test(String(col.type || 'text'))) continue;
    out.push({ table: t.name, col: col.name });
    if (out.length >= MAX_CAT_COLS) return out;
  }
  return out;
}
const qid = s => '"' + String(s).replace(/"/g, '""') + '"';
function okCatValue(v){
  const x = String(v);
  return x.length > 0 && x.length <= MAX_CAT_LEN && !/^[-+¥$€£\d.,%\s]+$/.test(x) && !/@/.test(x) && !/https?:|\//.test(x);
}
async function collectCategoryValues(run, tables){
  const out = {};
  if (typeof run !== 'function') return out;
  for (const c of catColumnCandidates(tables)) {
    try {
      const rows = await run(`SELECT DISTINCT ${qid(c.col)} AS v FROM ${qid(c.table)} WHERE ${qid(c.col)} IS NOT NULL ORDER BY 1 LIMIT ${MAX_CAT_VALUES + 1}`);
      const list = (Array.isArray(rows) ? rows : (rows && rows.rows) || []).map(r => r && r.v).filter(v => v != null);
      if (!list.length || list.length > MAX_CAT_VALUES || !list.every(okCatValue)) continue;   // 取值多 / 像编号金额文本的整列不放
      out[c.table + '.' + c.col] = list.map(String);
    } catch (_) {}
  }
  return out;
}
function catValueLines(c){
  const e = Object.entries((c && c.catValues) || {}).filter(([k, vs]) => { const cn = k.slice(k.indexOf('.') + 1); return CAT_COL.test(cn) && !NOT_CAT_COL.test(cn); }).filter(([, vs]) => Array.isArray(vs) && vs.length && vs.length <= MAX_CAT_VALUES && vs.every(okCatValue));
  if (!e.length) return [];
  return ['类别列的取值清单（本机统计，只列状态 / 类型 / 等级 / 渠道 / 国家这类取值很少的列；题面的中文说法如断货、预警、严重，可能对应这些列里的英文或代码取值，字面值按这里的写法写）：',
    ...e.map(([k, vs]) => `${k} ∈ {${vs.map(v => "'" + String(v).replace(/'/g, "''") + "'").join(', ')}}`)];
}
// d. 目标 / 计划类表：表名或列名里有 target / goal / plan / budget / 目标 / 计划 / 预算
const TARGET_NAME = /(^|[^a-z])(target|goal|plan|budget)s?([^a-z]|$)|目标|计划|预算/i;
function targetLines(c){
  const hit = [];
  for (const t of (c && c.tables) || []) {
    const tn = String(t.name || '').replace(/([a-z])([A-Z])/g, '$1_$2');
    const cols = (t.columns || []).filter(x => TARGET_NAME.test(String(x.name).replace(/([a-z])([A-Z])/g, '$1_$2'))).map(x => x.name);
    if (TARGET_NAME.test(tn)) hit.push(`${t.name}（表）`);
    else if (cols.length) hit.push(`${t.name}.${cols.slice(0, 3).join(' / ')}`);
  }
  return hit.length ? [`这是目标 / 计划数据：${hit.slice(0, 5).join('、')}。达成率 = 实际 ÷ 目标，期间按目标表的粒度（多为按月）对齐：目标按它自己的月份取，再和实际同月份比；不要把目标跨月份直接相加后和别的期间比。`] : [];
}

/* ---------- T1.1 提示词：不随题变化的放 system（吃前缀缓存），每题变的放 user ---------- */
/** 桥表（角色表）一行：A 和 B 通过 T 连接（T.x = A.x，T.y = B.y），T.role_col 区分角色…… 只有表名 / 列名，没有任何取值 */
function bridgeLines(c){
  const out = [];
  for (const b of (c.bridges || [])) {
    const ls = (b.links || []).filter(l => l && l.col && l.to);
    if (ls.length < 2 || !b.role_col) continue;
    const names = [...new Set(ls.map(l => String(l.to).split('.')[0]))];
    const linksAlreadyDeclared = ls.every(l => {
      const dot=String(l.to).lastIndexOf('.'),table=String(l.to).slice(0,dot),field=String(l.to).slice(dot+1);
      return (c.rels||[]).some(r => (r.pairs||[]).some(pair =>
        r.left===b.table&&r.right===table&&pair[0]===l.col&&pair[1]===field ||
        r.right===b.table&&r.left===table&&pair[1]===l.col&&pair[0]===field));
    });
    if (largeCatalog(c) && linksAlreadyDeclared) {
      out.push(`${b.table}是${names.join('/')}之间的角色桥，连接键已列于登记关系；${b.table}.${b.role_col}区分角色，题面原词由本机映射代码`);
      continue;
    }
    out.push(`${names.join(' 和 ')} 通过 ${b.table} 连接（${ls.map(l => `${b.table}.${l.col} = ${l.to}`).join('，')}），${b.table}.${b.role_col} 区分角色；角色值照题面原话写（如『投保人』），本机会对到真实代码`);
  }
  return out.length ? ['桥表（多对多关系 + 角色列）：', ...out] : [];
}
const largeCatalog=c=>(c.fields instanceof Map?c.fields.size:c.tables.length)>=8;
function catalogLines(c, byId){
  const metricLine=m=>`${m.name} = ${metricAlgo(m, byId)}${m.additivity === 'semiAdditive' ? '（semiAdditive）' : ''}${m.unit ? ' 单位' + m.unit : ''}${m.multi_currency ? '（含多种币种，不能直接相加）' : m.currency_unknown&&!c.currency?.[m.dataset] ? '（币种未标明）' : ''}${m.platform_ratio ? '（平台算好的比率，不能 SUM / AVG）' : ''}`;
  const dimensions=(c.dims||[]).filter(d=>d.kind==='column');
  const compact=largeCatalog(c);
  if(!compact)return {metrics:(c.metrics||[]).map(metricLine),dims:dimensions.map(d=>`${d.name} = ${sqlField(d.table,d.field)}`),rels:(c.rels||[]).map(r=>r.pairs.map(pp=>`${sqlField(r.left,pp[0])} = ${sqlField(r.right,pp[1])}`).join(' AND '))};
  // 大目录只合并可以从已有维度定义精确展开的自动去重计数；手工/确认/特殊口径仍逐条原样列出。
  const covered=new Set(),eligible=[];
  for(const m of c.metrics||[]){
    if(!m.auto||m.confirmed||m.kind!=='simple'||m.agg!=='dcount'||m.unit!=='个'||m.additivity==='semiAdditive'||m.multi_currency||m.platform_ratio||m.percent_scale!=null||m.note)continue;
    const matches=dimensions.filter(d=>d.table===m.dataset&&d.field===m.field&&m.name===d.name+'个数');
    if(matches.length===1&&dimensions.filter(d=>d.name===matches[0].name).length===1){covered.add(m.id);eligible.push(matches[0]);}
  }
  const names=new Set(eligible.map(d=>d.name)),excluded=dimensions.filter(d=>!names.has(d.name)).map(d=>d.name);
  const generic=eligible.length?['自动去重指标：'+(excluded.length<eligible.length?'维度除【'+excluded.join('、')+'】外':'仅维度【'+eligible.map(d=>d.name).join('、')+'】')+'，完整维度名+“个数”=COUNT(DISTINCT其绑定表.列)，单位个；NULL不计。']:[];
  const dimLines=[];
  for(const t of c.tables){const ds=dimensions.filter(d=>d.table===t.name);if(ds.length)dimLines.push(`${sqlIdentifier(t.name)} 内：${ds.map(d=>d.name+' = '+sqlIdentifier(d.field)).join('；')}`);}
  const relLines=[],seen=new Set();
  for(const r of c.rels||[]){const pairs=r.pairs.map(p=>[sqlField(r.left,p[0]),sqlField(r.right,p[1])]);const key=JSON.stringify(pairs.map(p=>p.slice().sort()).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));if(seen.has(key))continue;seen.add(key);relLines.push(r.pairs.every(p=>p[0]===p[1])?`${r.left} = ${r.right}，同名连接键(${r.pairs.map(p=>sqlIdentifier(p[0])).join(',')})`:pairs.map(p=>p.join(' = ')).join(' AND '));}
  const rowCounts=(c.metrics||[]).filter(m=>!covered.has(m.id)&&m.auto&&!m.confirmed&&m.kind==='simple'&&m.agg==='count'&&!m.unit&&!m.note&&!m.multi_currency&&!m.platform_ratio&&m.additivity!=='semiAdditive');
  rowCounts.forEach(m=>covered.add(m.id));const countLine=rowCounts.length?['自动行数（COUNT(*)含NULL行，未声明单位）：'+rowCounts.map(m=>m.name+'='+sqlIdentifier(m.dataset)).join('；')]:[];
  return {metrics:[...generic,...countLine,...(c.metrics||[]).filter(m=>!covered.has(m.id)).map(metricLine)],dims:dimLines,rels:relLines};
}
function compactStructure(c,question){
  if(!largeCatalog(c))return null;
  return c.tables.map(t=>`${t.name}${c.tableNames?.[t.name]?'（'+c.tableNames[t.name]+'）':''}(${t.columns.map(col=>{
    const names=(c.dims||[]).filter(d=>d.kind==='column'&&d.table===t.name&&d.field===col.name).map(d=>d.name),n=c.colNames?.[t.name+'.'+col.name];
    if(n?.zh&&!names.includes(n.zh))names.push(n.zh);
    for(const a of n?.aliases||[])if(String(a).length>=2&&(String(question||'').trim().length<2||String(question).toLowerCase().includes(String(a).toLowerCase())||String(question).toLowerCase().includes(String(n.zh).toLowerCase()))&&!names.includes(a)&&names.length<4)names.push(a);
    const zh=String(c.tableNames?.[t.name]||'').split('；').at(-1),shortName=n=>zh&&n.startsWith(zh+'·')?'·'+n.slice(zh.length+1):n;
    return sqlIdentifier(col.name)+' '+col.type+(names.length?'〈'+[...new Set(names.map(shortName))].join('/')+'〉':'');
  }).join(', ')})`);
}
function buildSqlMessages(payload){
  const p = payload || {};
  // P79:只随题面出现的规则行放到表结构之后,让同一数据集的提示词前缀尽量一致,提高前缀缓存命中(静态在前、可变在后)。
  const baseLines = p.__base ? null : new Set(buildSqlMessages(Object.assign({}, p, { question: '', previous_errors: null, entities: null, period: null, __base: true })).lines);
  const c = p.sql_context || { tables: [], metrics: [], rels: [], roles: [], dims: [] };
  const byId = new Map((c.metrics || []).map(m => [m.id, m]));
  const catalog=catalogLines(c,byId);
  const structure=compactStructure(c,p.question);
  const aliasHits=new Map(),questionText=String(p.question||'');
  for(const m of c.metrics||[])for(const a of m.aliases||[]){const term=String(a);if(term.length<2)continue;const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const hit=/^[A-Za-z0-9_]+$/.test(term)?new RegExp('(?:^|[^A-Za-z0-9_])'+escaped+'(?=$|[^A-Za-z0-9_])','i').test(questionText):questionText.toLowerCase().includes(term.toLowerCase());if(hit){const key=term.toLowerCase();if(!aliasHits.has(key))aliasHits.set(key,[]);aliasHits.get(key).push(m);}}
  const declaredAliases=[...aliasHits].filter(([,ms])=>ms.length===1).sort((a,b)=>b[0].length-a[0].length).slice(0,4).map(([a,ms])=>a+' = '+ms[0].name+' = '+metricAlgo(ms[0],byId));
  const columns=(c.tables||[]).flatMap(t=>t.columns||[]);
  const percentRule=/率|比例|占|份额|比重|倍|百分|%|ratio|rate|share|ROAS|ROI|CTR|CVR/i.test(questionText)||columns.some(x=>x.percent_scale!=null)||(c.metrics||[]).some(m=>m.unit==='%'||m.kind==='ratio'||m.platform_ratio);
  const businessNumberRule=columns.some(x=>/Identifier|(?:^|_)id(?:_|$)|内部ID/i.test(x.name))&&columns.some(x=>/Number|(?:^|_)no(?:_|$)|业务编号/i.test(x.name))&&!require('./sql-constraints').requiredRoleMappings(questionText,c).some(r=>r.subjectField);
  const businessNumberBindings=c.tables.flatMap(t=>t.columns.filter(x=>/_Identifier$/i.test(x.name)).flatMap(id=>t.columns.filter(x=>new RegExp('^(?:Company_)?'+id.name.replace(/_Identifier$/i,'')+'_Number$','i').test(x.name)).map(no=>t.name+'.'+id.name+'只作内部连接，显示或按业务编号分组用'+t.name+'.'+no.name)));
  const lines = [
    SQL_MARK + ' 只读DuckDB SQL编写器：仅有表结构，无数据或结果；生成一条本机SELECT。',
    '规则：',
    '- 仅一条SELECT，可用WITH，无分号；禁文件/系统/外部访问，只用下列授权表。',
    '- 输出=题面分组标签+唯一数值列v；总计仅v一行，排名排序后LIMIT N，其他不LIMIT。只问分组金额不额外附商品编号；问具体商品/货号才保留其标识。',
    ...(/第\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:名|高|低|位)/.test(String(p.question))?['- 第N名只取恰好第N个：ROW_NUMBER后筛序号或排序后LIMIT 1 OFFSET N-1；不能在前N名中再取第一。']:[]),
    ...(/断货|缺货|状态|转为|变成|恢复/.test(questionText)&&/到|变|恢复|已经|这期|现在/.test(questionText)?['- 跨快照状态转移：每期的状态/数量条件只用于对应日期的CASE或子查询，再按业务标识连接；不得把早期状态放入同时筛两期的公共WHERE。']:[]),
    ...(percentRule?[require('./sql-constraints').decimalRatioOutput(questionText)?'- 百分数：本题明确以小数表示；无量纲比值不乘100，unit空。登记比率若已是百分点，结果除100一次；源列仍按percent_scale解释（1百分点、100 fraction），不凭数值猜。单价/天数等有量纲结果保留登记单位。':'- 百分数：分子/分母的无量纲分数 ×100 一次；原列按 percent_scale 换成百分点（scale=1 已是百分点，scale=100 是 fraction）；尺度未知不得按数值大小猜。倍数、天数、件数、金额不换算。']:[]),
    '- anchor 仅用于解释相对日期；题目未指定期间时不添加日期条件。总计只给一个数；累计序列仅在明确要求按期逐步累计时使用。NULL/空文本与数值0不同。',
    ...(/最早|最晚|覆盖|缺.*(?:天|日)/.test(String(p.question))?['- 数据的最早/最晚/覆盖范围由本机SQL的MIN/MAX日期列取得；自然日含首尾用DATE_DIFF加一，缺失日再减COUNT(DISTINCT日期)。不能用anchor或自填日期常量替代数据边界。']:[]),
    '- 每个对象累计合计，未要求时间序列时只按对象分组SUM。按款/货号/SKU排名须保留款号或商品标识作标签，不能用类目替代。',
    '- 金额unit依币种说明，未知留空，不默认元；标签优先姓名、名称或描述，能沿已登记关系取名称时不只拼内部ID，仅有编号时保留编号。',
    ...(businessNumberRule?['- 同时有内部ID/Identifier和业务Number/No时，标签优先业务编号，内部键仅连接；题目点名内部ID则保留。'+(largeCatalog(c)&&/编号|号码|单号/.test(questionText)?' '+businessNumberBindings.join('；')+'；CTE名勿与实际表同名（忽略大小写），避免遮蔽原表。':'')]:[]),
    '- 类型为真实类型；文本日期按声明格式转换，不猜日/月；DATE直接比较，期间为[开始,结束次日)。',
    ...(require('./sql-constraints').dateDifferenceRoles(p.question,c)?["- 题面要求两日期的间隔/平均天数，且结构已有两个日期字段：可用DATE_DIFF('day',开始日期,结束日期)再AVG；文本按已声明格式转日期，无需另登记一个日期差指标。字段真缺才abstain。"]:[]),
    ...(/平均|均值|日均|月均|年均|average|mean/i.test(questionText)?['- 题目明确要平均值而默认指标是SUM时，使用原字段AVG并说明新聚合，不能拿SUM代替平均。']:[]),
    ...(require('./sql-constraints').explicitSumAvgDefaults(questionText,c).length?['- 题目明确要合计/求和而该字段默认按平均登记时，按题面对原字段SUM并说明新聚合，不能拿AVG代替合计。']:[]),
    ...((()=>{const plans=(c.metrics||[]).filter(m=>m.confirmed&&!m.auto&&/计划|目标|预算/.test([m.name,...(m.aliases||[])].join(' ')));if(!plans.length||!/达成|完成率|完成了|(?:占|是)[^，。；]{0,12}(?:计划|目标|预算)|计划(?:的)?(?:百分|多少)/.test(questionText))return [];const actual=(c.metrics||[]).filter(m=>m.kind==='simple'&&plans.some(p=>p.field===m.field&&p.dataset!==m.dataset));return ['- 用户已确认：'+plans.map(p=>p.name+'='+metricAlgo(p,byId)).join('、')+' 是计划(目标)值。达成率/完成率 = 实际 ÷ 计划 × 100；实际取 '+(actual.length?actual.map(m=>m.name+'='+metricAlgo(m,byId)).join('、'):'明细表的已登记实际指标')+'，两边各按自己的日期/月份列取同一期间，再按共同维度(如一级类目)对齐。']})()),
    ...(require('./sql-constraints').rowNumericFilter(questionText)?['- 「…大于/超过N的记录」「单笔…大于N」是逐行条件：放WHERE逐行判断（比率条件也逐行算），再分组汇总；只有「合计/总额大于N的组」才用HAVING。']:[]),
    '- 已登记指标必须用其绑定的数据集和字段；未经登记等价证明的同名汇总表不能代替明细口径。',
    '- 已登记指标按下面的算法算；semiAdditive（库存类快照）指标不跨快照日相加：问某段时间取期末那一天的快照，问某一天就取那一天。',
    ...(require('./sql-constraints').rawSnapshotSum(questionText,c).length?['- 本题点名了快照表的原始字段并要求汇总、且没有指定快照日期：按题面对全部快照记录逐条SUM（跨快照相加），label写明“全部快照逐条相加”。']:[]),
    ...(/当前|最新/.test(String(p.question||''))?['- 当前/最新库存：未指定快照日期时，用不晚于anchor的MAX快照日期；不能假设anchor当天一定有快照，也不能把不同日期的快照相加。']:[]),
    ...(/快照|历史|各期|三期|多期|每期/.test(questionText)&&/最多|最少|最大|最小|最高|最低/.test(questionText)?['- 跨期库存极值：先按每次快照聚合数量，再按该数量求极值或排序；历史最多的一次不是最新那次，不能改成MAX快照日期。']:[]),
    '- 表与表只按下面登记的关系连接（哪两张表、哪一列对上）。',
    ...(require('./sql-constraints').completeSnapshotCountQuestion(questionText)?['- 各期快照对象计数保留实际日期域：状态条件用COUNT CASE/FILTER，零事件期返回COUNT的0；不要用外层WHERE状态删日期，期间/实体/权限范围保留，不将未知SUM/AVG空值改0。']:[]),
    '- params 列出 SQL 里出现的每个日期和对象字面值（原样），role 取 period_start|period_end|period_end_exclusive|month|entity，entity 再写 dim（所属字段 表.列）。',
    '- 必要字段缺失输出{"abstain":"缺什么"}，不得用其他字段顶替、近似或估算。',
    '- 取值可为英文/代码；不知道真实写法就用题面原词，本机核对、匹配或询问用户。你看不到实际取值。',
    '- previous_errors是本次修复约束；据此返回完整新SQL。',
    ...(/加权/.test(String(p.question))&&/展示|显示|不是.*(?:精确|真实)/.test(String(p.question))?['- 题面明确要求展示率加权重算时按其权重公式，不称真实总体率；原列若已是百分数数值，加权平均后不再乘100，fraction转百分点才乘100。']:[]),
    '输出只是一个 JSON：{"sql":"...","unit":"元|美元|英镑|欧元|件|%|倍|天|个|","label":"一句话说明算的是什么","params":[{"role":"...","value":"...","dim":"..."}]}',
    ...(structure?['表结构（列后〈名字〉是维度/字段叫法；·开头的名字须补该表中文名前缀）：']:['表结构：']),
    ...(structure|| (c.tables || []).map(t => `${t.name}${c.tableNames?.[t.name]?'（'+c.tableNames[t.name]+'）':''}(${t.columns.map(x => sqlIdentifier(x.name) + ' ' + x.type).join(', ')})`)),
    '指标算法：',
    ...(declaredAliases.length?['题面精确命中的已登记叫法（复用其计算定义，不替换成同名预聚合来源）：',...declaredAliases]:[]),
    ...catalog.metrics,
    '维度（名称=表.列）：',
    ...(structure?[]:catalog.dims),
    '已登记连接：',
    ...catalog.rels,
    '时间口径：',
    ...(c.roles || []).map(r => `${r.table}.${r.field}${r.name ? '（' + r.name + '）' : ''}`),
    ...dateFormatLines(c),
    ...currencyLines(c),
    ...platformRatioLines(c),
    ...extraNoteLines(c),
    ...c.tables.flatMap(t=>t.columns.filter(x=>x.percent_scale!=null).map(x=>`${t.name}.${x.name}: percent_scale=${x.percent_scale}`)),
    ...(/去重|重复|整行|相同|唯一|distinct|duplicat/i.test(String(p.question))?c.tables.map(t=>`${t.name}业务列（全行去重仅用这些列，保留来源追溯列不参与去重）：${t.columns.filter(x=>!x.system).map(x=>x.name).join(', ')}`):[]),
    ...(structure?[]:colNameLines(c,p.question)),
    ...catValueLines(c),
    ...targetLines(c),
    ...dictAlgoLines(p.question, (c.metrics || []).map(m => m.name)),
    ...weekdayLines(p.question),
    ...bridgeLines(c),
    ...(c.subtypes && c.subtypes.length ? ['子类型标记表（这张表只记另一张表的编号，表示那张表里属于这一类的行；问这一类就用它连过去筛）：',
      ...c.subtypes.map(s => `${s.table}${s.zh ? '（' + s.zh + '）' : ''} ⊂ ${s.of}（${s.table}.${s.key} = ${s.of}.${s.of_key}）`)] : []),
    ...require('./sql-constraints').requiredSubtypes(p.question,c).map(s=>'- 本题子类型约束：'+s.zh+'须用标记表'+s.table+'按'+s.key+'限定'+s.of+'，不能直接汇总父表全部；其他明确总体分母照题意保留。'),
    ...require('./sql-constraints').requiredRoleMappings(p.question,c).map(r=>'- 本题已确认角色定义：'+r.name+' 对应 '+r.table+'.'+r.field+' = '+sq(r.value)+'（来源字典已核验）'+(r.subjectField?'；label与GROUP BY用该角色的 '+r.table+'.'+r.subjectField+'，不要按被统计对象或协议的编号分组':'')+'；必须落实角色条件，不能混入其他角色。'),
    ...(/哪[两几一二三四五六七八九十\d]*(?:个|位)?人|哪[两几一二三四五六七八九十\d]+位|谁|姓名|人名|which people|which persons?|who\b/i.test(questionText)&&!/(?:人员|员工|person|employee).{0,6}(?:编号|id)|内部.?id|person_id/i.test(questionText)?['- 本题人员标签：沿登记关系取姓名列作label，不能拼内部人员ID；同时保留所问数量/次数为独立数值列v，姓名不能放v。',...(/合作|共同参与|cooperat|collaborat/i.test(questionText)&&/两个人|两位|two people|two persons/i.test(questionText)?['- 本题人员组合：两个人是一个人员对，不是排名前两对；问合作最多的两个人时取共同数量最多的一对，label含两人姓名，v为共同数量。']:[])]:[]),
  ];
  const input = { question: p.question, anchor: p.anchor || null };
  if (p.period) input.period = p.period;
  if (Array.isArray(p.entities) && p.entities.length) input.entities = p.entities;
  if (Array.isArray(p.previous_errors) && p.previous_errors.length) input.previous_errors = p.previous_errors.slice(0, 3).map(e => String(e).slice(0, 240));
  // 可变规则与题面命中叫法置于稳定表结构/算法之后，避免在前缀缓存块前分叉。
  const dynamicPrefixes=['- 各期快照','- 第N名','- 跨快照','- 百分数','- 数据的最早','- 同时有内部ID','- 题目明确要平均','- 当前/最新库存','- 题面明确要求展示率','- 题面要求两日期','- 本题子类型约束','- 本题人员标签','- 本题人员组合','- 本题已确认角色定义'];
  if (p.__base) return { lines };
  const variable=line=>dynamicPrefixes.some(prefix=>line.startsWith(prefix))||line.startsWith('题面精确命中的已登记叫法')||declaredAliases.includes(line)||(baseLines&&line.startsWith('- ')&&!baseLines.has(line));
  const concise=structure?new Map([
    ['输出只是一个 JSON：{"sql":"...","unit":"元|美元|英镑|欧元|件|%|倍|天|个|","label":"一句话说明算的是什么","params":[{"role":"...","value":"...","dim":"..."}]}','Return JSON {"sql":"SELECT...","unit":"","label":"口径","params":[{"role":"...","value":"...","dim":"..."}]}'],
    ['- 仅一条SELECT，可用WITH，无分号；禁文件/系统/外部访问，只用下列授权表。','- One SELECT/WITH, no semicolon. Authorized tables only; no files, system tables or external access.'],
    ['- 输出=题面分组标签+唯一数值列v；总计仅v一行，排名排序后LIMIT N，其他不LIMIT。只问分组金额不额外附商品编号；问具体商品/货号才保留其标识。','- Return requested group labels plus one numeric v; scalar total=v only. Rank: ORDER BY then LIMIT N; otherwise no LIMIT. Include product/SKU IDs only when requested.'],
    ['- anchor 仅用于解释相对日期；题目未指定期间时不添加日期条件。总计只给一个数；累计序列仅在明确要求按期逐步累计时使用。NULL/空文本与数值0不同。','- anchor resolves relative dates only; no date filter unless requested. Total is scalar; cumulative series only if explicit. NULL/blank is not zero.'],
    ['- 每个对象累计合计，未要求时间序列时只按对象分组SUM。按款/货号/SKU排名须保留款号或商品标识作标签，不能用类目替代。','- Object totals: GROUP BY object, SUM, no time series unless requested. SKU rankings keep SKU labels, not categories.'],
    ['- 金额unit依币种说明，未知留空，不默认元；标签优先姓名、名称或描述，能沿已登记关系取名称时不只拼内部ID，仅有编号时保留编号。','- Money unit follows declared currency, unknown="". Labels use registered reachable names/descriptions; IDs only if no name.'],
    ['- 类型为真实类型；文本日期按声明格式转换，不猜日/月；DATE直接比较，期间为[开始,结束次日)。','- Use actual types and declared text-date format, never guess day/month. DATE compares directly; interval [start,end+1day).'],
    ['- 已登记指标必须用其绑定的数据集和字段；未经登记等价证明的同名汇总表不能代替明细口径。','- Use registered metric source/algorithm; no aggregate-for-detail substitution without declared equivalence.'],
    ['- 已登记指标按下面的算法算；semiAdditive（库存类快照）指标不跨快照日相加：问某段时间取期末那一天的快照，问某一天就取那一天。','- semiAdditive snapshots: never SUM across dates; period=end snapshot, specific day=that snapshot.'],
    ['- 表与表只按下面登记的关系连接（哪两张表、哪一列对上）。','- JOIN only declared table/key relations.'],
    ['- 必要字段缺失输出{"abstain":"缺什么"}，不得用其他字段顶替、近似或估算。','- Missing required input: {"abstain":"缺哪个概念"}, no substitution/approximation/guess.'],
    ['- 取值可为英文/代码；不知道真实写法就用题面原词，本机核对、匹配或询问用户。你看不到实际取值。','- Values may be codes/English: use question literals only; local matching/confirmation handles them. No data values supplied.'],
    ['- previous_errors是本次修复约束；据此返回完整新SQL。','- Obey previous_errors; return complete repaired SQL.']
  ]):new Map();
  const stable=lines.filter(line=>!variable(line)).map(line=>concise.get(line)||line),dynamic=lines.filter(variable);
  return { system: [...stable,...dynamic].join('\n'), user: 'INPUT（JSON）:\n' + JSON.stringify(input) };
}

/* ---------- T1.2 检查：json_serialize_sql 拆语法树 → 只许一条 SELECT、只许已登记的表、不许表函数和系统函数 ---------- */
function walkAst(node, visit, parent){
  if (Array.isArray(node)) { for (const x of node) walkAst(x, visit, parent); return; }
  if (!node || typeof node !== 'object') return;
  visit(node, parent);
  for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === 'object') walkAst(v, visit, node); }
}
async function checkSql(sql, ctx = {}){
  const errors = [];
  const out = { ok: false, errors, tables: [], functions: [], joins: [], aggregates: [], columns: [], divisions: [], literals: [], windows: 0, cases: 0, ast: null };
  let s = String(sql == null ? '' : sql).trim().replace(/;+\s*$/, '');
  if (!s) { errors.push('SQL 是空的'); return out; }
  if (s.length > 20000) { errors.push('SQL 太长'); return out; }
  out.sql = s;
  const run = ctx.run;
  if (typeof run !== 'function') { errors.push('本机没有可用的只读执行通道'); return out; }
  let ast;
  try {
    const r = await run('SELECT json_serialize_sql(' + sq(s) + ') AS j');
    ast = JSON.parse(String((r && r[0] && (r[0].j != null ? r[0].j : Object.values(r[0])[0])) || '{}'));
  } catch (err) { errors.push('语法检查失败：' + String(err && err.message || err)); return out; }
  if (ast.error) {
    const m = String(ast.error_message || ast.error_type || '');
    errors.push(/Only SELECT/i.test(m) ? '只允许一条 SELECT 查询（不许 COPY / ATTACH / EXPORT / INSERT / DELETE 等）' : '语法错误：' + m);
    return out;
  }
  const stmts = ast.statements || [];
  if (stmts.length !== 1) { errors.push('只允许一条语句'); return out; }
  out.ast = stmts[0];
  let contradictoryJoin=false;
  walkAst(out.ast,n=>{
    if(n.type!=='SELECT_NODE')return;
    const equalities=new Set(),pair=x=>{if(x?.left?.class!=='COLUMN_REF'||x?.right?.class!=='COLUMN_REF'||(x.left.column_names||[]).length<2||(x.right.column_names||[]).length<2)return null;return [x.left.column_names.join('.').toLowerCase(),x.right.column_names.join('.').toLowerCase()].sort().join('=');};
    const conditions=(x,visit)=>{if(!x)return;if(x.type==='CONJUNCTION_AND')return (x.children||[]).forEach(c=>conditions(c,visit));visit(x);};
    const joins=x=>{if(x?.type!=='JOIN')return;conditions(x.condition,c=>{const k=pair(c);if(c.type==='COMPARE_EQUAL'&&k)equalities.add(k);});joins(x.left);joins(x.right);};joins(n.from_table);
    conditions(n.where_clause,c=>{const k=pair(c);if(c.type==='COMPARE_NOTEQUAL'&&k&&equalities.has(k))contradictoryJoin=true;});
  });
  if(contradictoryJoin){errors.push('contradictory_column_predicate: 同一组连接列同时要求相等和不等，核对连接字段；共同属性应连接不同实体，不能把自身连接后又排除自身');return out;}
  let expanded = false;
  const business = new Map(((ctx.context||{}).tables||[]).map(t=>[t.name.toLowerCase(),t.columns.filter(c=>!c.system).map(c=>c.name)]));
  walkAst(stmts[0],n=>{
    if(n.type!=='SELECT_NODE' || n.from_table?.type!=='BASE_TABLE' || (n.cte_map?.map||[]).length || !(n.modifiers||[]).some(m=>m.type==='DISTINCT_MODIFIER')) return;
    const names=business.get(String(n.from_table.table_name).toLowerCase());
    if(!names?.length) return;
    n.select_list=(n.select_list||[]).flatMap(x=>{if(x.class!=='STAR'||x.columns||x.exclude_list?.length||x.replace_list?.length)return [x];expanded=true;return names.map(col=>({class:'COLUMN_REF',type:'COLUMN_REF',alias:'',column_names:[n.from_table.alias||n.from_table.table_name,col]}));});
  });
  if(expanded){
    walkAst(ast,n=>{if(n.query_location>Number.MAX_SAFE_INTEGER)n.query_location=0;});
    try { const rr=await run('SELECT json_deserialize_sql('+sq(JSON.stringify(ast))+') AS s');out.sql=String(rr[0].s);out.distinct_business_expanded=true; } catch(_){ errors.push('业务列去重展开失败');return out; }
  }
  const c = ctx.context || {};
  const known = new Map((c.tables || []).map(t => [String(t.name).toLowerCase(), t]));
  const ctes = new Set();
  walkAst(stmts[0], n => { if (n.cte_map && Array.isArray(n.cte_map.map)) for (const e of n.cte_map.map) if (e && e.key) ctes.add(String(e.key).toLowerCase()); });
  const alias = new Map();   // 别名/表名 → 已登记表名
  walkAst(stmts[0], (n, parent) => {
    if (n.type === 'TABLE_FUNCTION') errors.push('不许用表函数（读文件 / 生成表）');
    if (n.type === 'BASE_TABLE') {
      const name = String(n.table_name || '').toLowerCase();
      if (n.catalog_name || (n.schema_name && !/^main$/i.test(n.schema_name))) errors.push('只能查本工作区里的表');
      else if (known.has(name)) { const real = known.get(name).name; if (!out.tables.includes(real)) out.tables.push(real); alias.set(name, real); if (n.alias) alias.set(String(n.alias).toLowerCase(), real); }
      else if (!ctes.has(name)) errors.push('用到了不认识的表');
    }
    if (n.class === 'FUNCTION' || n.class === 'AGGREGATE' || n.class === 'WINDOW') {
      const fn = String(n.function_name || '').toLowerCase();
      if (fn) out.functions.push(fn);
      if (FN_BLACKLIST.has(fn) || /^(read_|duckdb_|pragma_|sqlite_|parquet_|pg_)/.test(fn)) errors.push('不许用系统 / 读文件函数');
    }
    if (n.class === 'WINDOW') out.windows++;
    if (n.class === 'CASE') out.cases++;
  });
  if (errors.length) { out.errors = [...new Set(errors)]; return out; }
  // 列引用 → 已登记表
  const colTable = (names) => {
    const arr = (names || []).map(String);
    if (arr.length >= 2) { const t = alias.get(arr[arr.length - 2].toLowerCase()); return t ? { table: t, col: arr[arr.length - 1] } : null; }
    const col = arr[0]; if (!col) return null;
    const hits = out.tables.filter(t => ((known.get(t.toLowerCase()) || {}).columns || []).some(x => x.name.toLowerCase() === col.toLowerCase()));
    return hits.length ? { table: hits.length === 1 ? hits[0] : hits, col } : null;
  };
  const orGroups=new Map();
  const equalLiteral=n=>{if(n?.class!=='COMPARISON'||n.type!=='COMPARE_EQUAL')return null;const [col,lit]=n.left?.class==='COLUMN_REF'?[n.left,n.right]:[n.right,n.left];if(col?.class!=='COLUMN_REF'||lit?.class!=='CONSTANT'||lit.value?.type?.id!=='VARCHAR'||lit.value.is_null)return null;const r=colTable(col.column_names);return r&&typeof r.table==='string'?{...r,value:String(lit.value.value)}:null;};
  walkAst(stmts[0], (n,parent) => {
    if (n.class === 'COLUMN_REF') {
      const r = colTable(n.column_names);
      if (r) {
        out.columns.push(r);
        const ts = Array.isArray(r.table) ? r.table : [r.table];
        if (ts.some(t=>!((known.get(t.toLowerCase())||{}).columns||[]).some(c=>c.name.toLowerCase()===r.col.toLowerCase()))){
          const places=[...known.values()].filter(t=>t.columns.some(c=>c.name.toLowerCase()===r.col.toLowerCase())).map(t=>{const names=[...alias].filter(([k,v])=>v===t.name&&k!==t.name.toLowerCase()).map(([k])=>k);return (names.at(-1)||t.name)+'.'+t.columns.find(c=>c.name.toLowerCase()===r.col.toLowerCase()).name;});
          errors.push(places.length?'column_source_mismatch: 当前别名没有引用的列；已授权声明位置 '+places.slice(0,6).join('、')+'；保留原连接与条件，修正列所属别名':'无权访问该列');
        }
      }
      if (!r && (c.deniedColumns||[]).some(x=>x.col===String((n.column_names||[]).at(-1)||''))) errors.push('无权访问该列');
      if (!r && c.scope && c.scope.columns) {
        const col = String((n.column_names||[]).at(-1)||'');
        const qualified = (n.column_names||[]).length>1 ? alias.get(String(n.column_names.at(-2)).toLowerCase()) : null;
        if (qualified && Array.isArray(c.scope.columns[qualified]) && !c.scope.columns[qualified].includes(col)) errors.push('无权访问该列');
      }
    }
    if (n.class === 'STAR' && c.scope && c.scope.columns && Object.keys(c.scope.columns).length) errors.push('列权限受限时必须显式列出允许的列，不能使用星号');
    if (n.class === 'COMPARISON' && n.type === 'COMPARE_EQUAL' && n.left && n.right && n.left.class === 'COLUMN_REF' && n.right.class === 'COLUMN_REF') {
      const a = colTable(n.left.column_names), b = colTable(n.right.column_names);
      if (a && b && typeof a.table === 'string' && typeof b.table === 'string' && !(a.table === b.table && a.col === b.col && n.left.column_names.length < 2)) out.joins.push([a, b]);
    }
    if (n.class === 'COMPARISON' && n.type === 'COMPARE_EQUAL' && n.left && n.right) {
      const [colN, litN] = n.left.class === 'COLUMN_REF' && n.right.class === 'CONSTANT' ? [n.left, n.right] : n.right.class === 'COLUMN_REF' && n.left.class === 'CONSTANT' ? [n.right, n.left] : [null, null];
      if (colN && litN && litN.value && litN.value.type && litN.value.type.id === 'VARCHAR' && !litN.value.is_null) { const r = colTable(colN.column_names); if (r && typeof r.table === 'string') {
        let group=null;if(parent?.type==='CONJUNCTION_OR'){
          const terms=(parent.children||[]).map(equalLiteral);if(terms.length>1&&terms.every(x=>x&&x.table===r.table&&x.value===String(litN.value.value))){if(!orGroups.has(parent))orGroups.set(parent,orGroups.size+1);group=orGroups.get(parent);}
        }
        out.literals.push({ table: r.table, col: r.col, value: String(litN.value.value),...(group?{or_group:group}:{}) });
      } }
    }
    if (n.class === 'OPERATOR' && n.type === 'COMPARE_IN' && Array.isArray(n.children) && n.children[0] && n.children[0].class === 'COLUMN_REF') {
      const r = colTable(n.children[0].column_names);
      if (r && typeof r.table === 'string') for (const k of n.children.slice(1)) if (k.class === 'CONSTANT' && k.value && k.value.type && k.value.type.id === 'VARCHAR' && !k.value.is_null) out.literals.push({ table: r.table, col: r.col, value: String(k.value.value) });
    }
    if (n.type === 'JOIN' && Array.isArray(n.using_columns) && n.using_columns.length) {
      const tabsOf = side => { const ts = []; walkAst(side, x => { if (x.type === 'BASE_TABLE') { const t = alias.get(String(x.table_name).toLowerCase()); if (t) ts.push(t); } }); return ts; };
      const L = tabsOf(n.left), R = tabsOf(n.right);
      for (const col of n.using_columns) {
        const lt = L.find(t => ((known.get(t.toLowerCase()) || {}).columns || []).some(x => x.name === col));
        const rt = R.find(t => ((known.get(t.toLowerCase()) || {}).columns || []).some(x => x.name === col));
        if (lt && rt) out.joins.push([{ table: lt, col }, { table: rt, col }]);
      }
    }
    if (n.class === 'FUNCTION' || n.class === 'AGGREGATE') {
      const fn = String(n.function_name || '').toLowerCase();
      if (AGG_FNS.has(fn) && !n.is_operator) {
        const ch = (n.children || [])[0];
        const arg = ch && ch.class === 'COLUMN_REF' ? colTable(ch.column_names) : null;
        out.aggregates.push({ fn: fn === 'count_star' || (fn === 'count' && !ch) || (fn === 'count' && ch && ch.class === 'STAR') ? 'count' : fn, distinct: !!n.distinct,
          col: arg, expr: ch && ch.class !== 'COLUMN_REF' && ch.class !== 'STAR' ? (ch.class || ch.type) : null, filter: !!n.filter, node: n });
      }
      if (fn === '/' || fn === '//' ) out.divisions.push(n);
    }
  });
  out.ok = errors.length === 0;
  out.errors = [...new Set(errors)];
  return out;
}

// 只有无来源的「日期列和日期字面值」过滤才删除；保留时间运算、Join条件和所有其他筛选。
async function removeUnsupportedDates(check, ctx) {
  const ast={error:false,statements:[JSON.parse(JSON.stringify(check.ast))]};
  const dateCols=new Set((ctx.context.tables||[]).flatMap(t=>t.columns.filter(c=>/date|time/i.test(c.type)||/date|日期/i.test(c.name)).map(c=>c.name.toLowerCase())));
  const unwrap=x=>x?.class==='CAST'?unwrap(x.child):x;
  const isCol=x=>{const u=unwrap(x);return u?.class==='COLUMN_REF'&&dateCols.has(String(u.column_names?.at(-1)).toLowerCase());};
  const isDate=x=>{const u=unwrap(x);return u?.class==='CONSTANT'&&/^\d{4}-\d{2}(?:-\d{2})?$/.test(String(u.value?.value||''));};
  let changed=false;
  const prune=x=>{if(!x)return x;if(x.class==='COMPARISON'&&((isCol(x.left)&&isDate(x.right))||(isCol(x.right)&&isDate(x.left)))){changed=true;return null;}if(x.class==='CONJUNCTION'&&x.type==='CONJUNCTION_AND'){const cs=(x.children||[]).map(prune).filter(Boolean);return cs.length>1?Object.assign({},x,{children:cs}):cs[0]||null;}return x;};
  walkAst(ast,n=>{if(n.type==='SELECT_NODE'&&n.where_clause)n.where_clause=prune(n.where_clause);if(n.query_location>Number.MAX_SAFE_INTEGER)n.query_location=0;});
  if(!changed)return check;
  const rs=await ctx.run('SELECT json_deserialize_sql('+sq(JSON.stringify(ast))+') AS s');
  const revised=await checkSql(String(rs[0].s),ctx);revised.removed_unsupported_date_filter=true;return revised;
}

/* ---------- T1.3 只读执行：外包 LIMIT 61；超过 60 行不当答案；单条约 20 秒超时 ---------- */
async function runSql(sql, ctx = {}){
  const run = ctx.run;
  if (typeof run !== 'function') return { ok: false, error: '本机没有可用的只读执行通道' };
  const s = String(sql).trim().replace(/;+\s*$/, '');
  // 只读连接：在这条连接上关掉外部文件访问（单向开关，关了就打不开；正式 App 的 worker 建连接时已经关了，这里失败就跳过）
  if (!ctx._lockedDown) { ctx._lockedDown = true; try { await run('SET enable_external_access = false'); } catch (_) {} }
  const wrapped = `SELECT * FROM (${s}) AS _sql_lane LIMIT ${MAX_ROWS + 1}`;
  let timer = null, previousOptimizers = null;
  try {
    // SQLite扫描的隐藏绑定未参与common_subplan等价判断；多CTE会误合并不同子类型扫描。
    // 仅此类查询临时跳过该优化，SQL功能、权限和其他优化均保留，执行后还原连接设置。
    if(ctx.sqliteMultiCte){
      const setting=await run("SELECT current_setting('disabled_optimizers') AS value");
      previousOptimizers=String(setting[0]?.value||'');
      const disabled=[...new Set([...previousOptimizers.split(',').filter(Boolean),'common_subplan'])].join(',');
      await run('SET disabled_optimizers = '+sq(disabled));
    }
    const rows = await Promise.race([
      Promise.resolve(run(wrapped)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`执行超过 ${Math.round((ctx.timeoutMs || RUN_TIMEOUT_MS) / 1000)} 秒，停止等待`), { code: 'timeout' })), ctx.timeoutMs || RUN_TIMEOUT_MS); }),
    ]);
    const list = Array.isArray(rows) ? rows : (rows && rows.rows) || [];
    if (list.length > MAX_ROWS) return { ok: false, error: `结果超过 ${MAX_ROWS} 行`, code: 'too_many_rows' };
    return { ok: true, rows: list, columns: list.length ? Object.keys(list[0]) : [] };
  } catch (err) {
    let terminated = false;
    if (err && (err.code === 'timeout' || ctx.signal?.aborted) && typeof ctx.cancel === 'function') { try { terminated = (await ctx.cancel()) === true; } catch (_) {} }
    return { ok: false, error: String(err && err.message || err), code: err && err.code === 'timeout' ? 'timeout' : 'exec_error', terminated, resource_state:terminated?'released':'unknown' };
  } finally { if (timer) clearTimeout(timer); if(previousOptimizers!==null)await run('SET disabled_optimizers = '+sq(previousOptimizers)); }
}

/* ---------- 10-23 字面值核对：SQL 里「列 = 'xxx'」的 xxx 在那一列里存不存在（只回答存在 / 不存在，不告诉模型实际有哪些值）---------- */
async function checkLiterals(check, ctx = {}){
  const missing = [];
  const seen = new Map(),presentGroups=new Set();
  const known = new Map(((ctx.context && ctx.context.tables) || []).map(t => [t.name, new Map(t.columns.map(c => [c.name.toLowerCase(), c]))]));
  for (const l of ((check && check.literals) || []).slice(0, 8)) {
    const k = l.table + '.' + l.col + '=' + l.value;if(seen.has(k)){if(l.or_group&&seen.get(k))presentGroups.add(l.or_group);continue;}
    if (/^\d{4}-\d{2}(-\d{2})?/.test(l.value)) continue;        // 日期不核
    const col = known.get(l.table) && known.get(l.table).get(String(l.col).toLowerCase());
    if (!col) continue;
    try {
      const r = await ctx.run(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${qiL(l.table)} WHERE CAST(${qiL(col.name)} AS VARCHAR) = ${sq(l.value)} LIMIT 1) AS _x`);
      const n = Number(Object.values((Array.isArray(r) ? r : (r && r.rows) || [])[0] || {})[0]);
      seen.set(k,n>0);if(n>0&&l.or_group)presentGroups.add(l.or_group);
      if (!n) missing.push(l);
    } catch (_) {}
  }
  return missing.filter(l=>!l.or_group||!presentGroups.has(l.or_group)||(check.literals||[]).some(x=>x.table===l.table&&x.col===l.col&&x.value===l.value&&(!x.or_group||!presentGroups.has(x.or_group))));
}
const qiL = s => '"' + String(s).replace(/"/g, '""') + '"';

/* ---------- T1.4 报错去值：引号里的值（日期除外）、长数字 → 占位 ---------- */
function sanitizeError(msg){
  let s = String(msg == null ? '' : msg);
  s = s.replace(/'((?:[^']|'')*)'/g, (_, v) => isDateLit(v) ? `'${v}'` : "'‹值›'");
  s = s.replace(/"([^"]*)"/g, (_, v) => isDateLit(v) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? `"${v}"` : '"‹值›"');
  s = s.replace(/\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d+(?:\.\d+)?/g, m => (/-/.test(m) || m.length < 4 || /^(?:19|20)\d{2}$/.test(m)) ? m : '‹数›');
  return s.replace(/\n{2,}/g, '\n').slice(0, 400);
}

// 执行错误可能夹带数据库中的小数、日期或ASCII标签；只返回修复类别，不转发错误原文。
function executionRepairError(msg,context,check){
  const s=String(msg||'');
  if(/convert|conversion|parse|strptime|timestamp|date field/i.test(s))return 'conversion_error: 字段值不能按目标类型或日期格式转换；核对声明的类型和格式，必要时用TRY_CAST或TRY_STRPTIME，不能猜测日期边界';
  if(/^(?:Binder|Catalog|Parser|Syntax) Error/i.test(s)){
    const allowed=new Set((context?.tables||[]).flatMap(t=>[t.name,...t.columns.map(c=>c.name)]).map(x=>String(x).toLowerCase()));
    const aliases=x=>{if(Array.isArray(x))return x.forEach(aliases);if(!x||typeof x!=='object')return;if(typeof x.alias==='string')allowed.add(x.alias.toLowerCase());Object.values(x).forEach(aliases);};aliases(check?.ast);
    const first=s.split('\n')[0],identifiers=[...first.matchAll(/"([^"]*)"/g)].map(x=>x[1]).filter(x=>allowed.has(x.toLowerCase()));
    const reason=/group by|aggregate/i.test(first)?'核对分组与聚合':/table.*not found|table.*does not exist/i.test(first)?'核对表与CTE引用':/column|referenced|binding/i.test(first)?'核对列引用、别名和CTE投影':/function/i.test(first)?'核对函数签名与参数类型':'核对SQL语法、表列引用与类型';
    return 'sql_binding_error: '+reason+(identifiers.length?'；相关声明标识='+JSON.stringify([...new Set(identifiers)].slice(0,8)):'');
  }
  if(/结果超过|too many rows/i.test(s))return 'too_many_rows: 结果超过允许行数；核对是否把总计误写成时间序列，按题意分组和汇总';
  if(/interrupt|cancel|timeout|超时/i.test(s))return 'execution_timeout: 本机查询未在时间预算内完成；简化重复扫描并先聚合再连接';
  if(/overflow|out of range/i.test(s))return 'numeric_range: 数值运算超出类型范围；核对类型、分母和转换';
  return 'execution_error: 本机查询执行失败；核对字段类型、聚合、连接与SQL结构，不替换成常数结果';
}

/* ---------- T1.5 可信档（按「登记」规则） ---------- */
function tierOf(check, registry){
  const c = registry && registry.fields ? registry : contextFromRegistry(registry);
  const why = { new_algos: [], unregistered_fields: [], bad_joins: [] };
  const inSem = (t, f) => !!(c.fields.get(t) && [...c.fields.get(t)].some(x => x.toLowerCase() === String(f).toLowerCase()));
  for (const ref of (check && check.columns) || []) {
    const ts = Array.isArray(ref.table) ? ref.table : [ref.table];
    if (!ts.some(t => inSem(t, ref.col))) why.unregistered_fields.push(ts[0] + '.' + ref.col);
  }
  const relOk = (a, b) => (c.rels || []).some(r => r.pairs.some(p =>
    (r.left === a.table && r.right === b.table && p[0] === a.col && p[1] === b.col) || (r.left === b.table && r.right === a.table && p[0] === b.col && p[1] === a.col)));
  for (const [a, b] of (check && check.joins) || []) {
    if (a.table === b.table) { if (a.col === b.col) why.new_algos.push('同表自连接'); else why.bad_joins.push(`${a.table}.${a.col} = ${b.table}.${b.col}`); continue; }
    if (!relOk(a, b)) why.bad_joins.push(`${a.table}.${a.col} = ${b.table}.${b.col}`);
  }
  const matchMetric = (ag) => {
    if (!ag || ag.expr || ag.filter) return null;
    const tbls = ag.col ? (Array.isArray(ag.col.table) ? ag.col.table : [ag.col.table]) : ((check && check.tables) || []);
    return (c.metrics || []).find(m => m.kind === 'simple' && tbls.includes(m.dataset) && (
      (ag.fn === 'count' && !ag.col && m.agg === 'count') ||
      (ag.fn === 'count' && ag.distinct && ag.col && m.agg === 'dcount' && m.field === ag.col.col) ||
      (!ag.distinct && ag.col && ['sum', 'avg', 'min', 'max'].includes(ag.fn) && m.agg === ag.fn && m.field === ag.col.col))) || null;
  };
  for (const ag of (check && check.aggregates) || []) {
    if (ag.expr === 'CASE' || ag.filter) why.new_algos.push('条件聚合');
    else if (ag.expr) why.new_algos.push('对算式做聚合');
    else if (!matchMetric(ag)) why.new_algos.push('未登记的聚合 ' + ag.fn.toUpperCase());
  }
  for (const d of (check && check.divisions) || []) {
    const kids = d.children || [];
    const ms = kids.map(k => (k && (k.class === 'FUNCTION' || k.class === 'AGGREGATE')) ? matchMetric((check.aggregates || []).find(a => a.node === k)) : null);
    const ok = ms[0] && ms[1] && (c.metrics || []).some(m => m.kind === 'ratio' && String(m.num).replace(/^m:/, '') === ms[0].id && String(m.den).replace(/^m:/, '') === ms[1].id);
    if (!ok) why.new_algos.push('两个数相除（未登记的比率）');
  }
  if (check && check.cases && !((check.aggregates || []).some(a => a.expr === 'CASE'))) why.new_algos.push('条件判断');
  if (check && check.windows) why.new_algos.push('窗口 / 排名函数');
  for (const fn of new Set((check && check.functions) || [])) if (DATE_FNS.has(fn)) why.new_algos.push('日期函数 ' + fn);
  for (const fn of new Set((check && check.functions) || [])) if (!AGG_FNS.has(fn) && !DATE_FNS.has(fn) && !NEUTRAL_FNS.has(fn) && !/^[<>=!~]/.test(fn) && fn !== '/' && fn !== '//') why.new_algos.push('函数 ' + fn);
  if (!((check && check.aggregates) || []).length) why.new_algos.push('直接取字段值');
  why.new_algos = [...new Set(why.new_algos)]; why.unregistered_fields = [...new Set(why.unregistered_fields)]; why.bad_joins = [...new Set(why.bad_joins)];
  // 10-23：用到自动起名、还没确认的字段或关系 → 最多算「待确认」
  why.auto_names = [];
  if (c.autoFields && c.autoFields.size) for (const ref of (check && check.columns) || []) { const ts = Array.isArray(ref.table) ? ref.table : [ref.table]; for (const t of ts) if (c.autoFields.has(t + '.' + ref.col)) why.auto_names.push(t + '.' + ref.col); }
  for (const [a, b] of (check && check.joins) || []) if ((c.rels || []).some(r => r.auto && r.pairs.some(p => (r.left === a.table && r.right === b.table && p[0] === a.col && p[1] === b.col) || (r.left === b.table && r.right === a.table && p[0] === b.col && p[1] === a.col)))) why.auto_names.push(a.table + '.' + a.col + '=' + b.table + '.' + b.col);
  why.auto_names = [...new Set(why.auto_names)].slice(0, 3);
  const tier = (why.unregistered_fields.length || why.bad_joins.length) ? 'unverified' : ((why.new_algos.length || why.auto_names.length) ? 'pending' : 'verified');
  if (check && typeof check === 'object') check.tier_why = why;
  return tier;
}

/* ---------- T1.6 能不能存进卡片 / 报告 / 口径 ---------- */
function isPersistable(x){
  if (x == null || typeof x !== 'object') return true;
  if (Array.isArray(x)) return x.every(isPersistable);
  if (Array.isArray(x.facts) && x.facts.length && !x.facts.every(isPersistable)) return false;
  const tier = x.tier || null;
  if (!tier) return true;                       // 配置单产生的事实（没有 tier）
  if (tier === 'unverified') return false;
  if (tier === 'pending') return x.confirmed === true;
  return tier === 'verified';
}
function persistRefusal(x){
  if (isPersistable(x)) return null;
  const t = (x && x.tier) || ((x && Array.isArray(x.facts) && (x.facts.find(f => !isPersistable(f)) || {}).tier)) || '';
  return t === 'pending' ? '这条结果含一处新算法，还没经你确认，先确认口径再保存' : '这条结果用到了未登记的字段或连接（未核），不能存成卡片、写进报告或记成口径';
}

function tierSentence(tier, why){
  const w = why || {};
  if (tier === 'verified') return '按已登记口径计算';
  if (tier === 'pending') return (w.new_algos || []).length ? '含一处新算法：' + (w.new_algos || []).slice(0, 3).join('、') + '，待你确认' : '字段名是导入时自动认的，待你确认';
  return '用到了未登记的字段：' + [...(w.unregistered_fields || []), ...(w.bad_joins || [])].slice(0, 3).join('、');
}

/* ---------- 结果 → 数值 ---------- */
function toNum(v){
  if (v == null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && typeof v.toDouble === 'function') { const n = v.toDouble(); return Number.isFinite(n) ? n : null; }
  const n = Number(String(v)); return String(v).trim() !== '' && Number.isFinite(n) ? n : null;
}
// unit 可选：传了且不是金额（元 / 美元 / 英镑……）、不是件数个数类，就最多多给到 3 位（至少 2 位），避免二次舍入；不传 = 老行为（2 位）。
const MONEY_U = /元|美元|英镑|欧元|日元|港币|韩元|币|[$¥€£￥]|USD|GBP|EUR|CNY|RMB|JPY/i;
const COUNT_U = /^(件|个|单|人|次|笔|条|家|台|套|张|份|只|行)$/;
function fmtValue(v, unit){
  const u = unit == null ? null : String(unit).trim();
  // 10-24：多给一位的做法先关掉（和事实编号里存的位数对不上），统一 2 位
  const maxD = 2; void u;
  const r = Math.round(v * 100) / 100;
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  if (Math.abs(v) < 0.1 && v !== 0) return Number(v.toFixed(4)).toString();
  return (maxD === 3 ? v : r).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maxD });
}

/* ---------- 10-24 兜底结果 → 事实：label + v 多行，每一行都挂 F 编号 ----------
 * 和配置单那路一样：每个分组行一条类型化事实（有 book 就走 book.addTyped，编号是真的、能查回来）；
 * 值为空的行也挂编号（状态 no_data），不丢行。book 不可用时才用本次内的顺序编号（不会没有编号）。
 * 返回 { facts, rows, lines }：lines 每行形如「- 标签：显示值（F3）」。 */
function rowsToFacts(ran, vcol, outp, env){
  const e = env || {};
  const cols = (ran && ran.columns) || [];
  const labels = cols.filter(c => c !== vcol);
  const unit = String((outp && outp.unit) || '').slice(0, 4);
  const book = e.book || null;
  const facts = [], rows = [];
  for (const row of (ran && ran.rows) || []) {
    const v = vcol ? toNum(row[vcol]) : null;
    const lab = labels.map(c => row[c] == null ? '（空）' : String(row[c])).join(' · ');
    const display = v == null ? '—' : fmtValue(v, unit) + unit;
    const spec = { schema_version: 'fb/2', kind: 'metric', label: ((outp && outp.label) ? String(outp.label).slice(0, 40) : '兜底查询') + (lab ? ' · ' + lab : ''),
      value: v, unit, display, status: v == null ? 'no_data' : 'ok', dims: labels.length ? labels.map(c => row[c] == null ? null : String(row[c])) : null,
      period: e.period ? { start: e.period.start, endExclusive: e.period.endExclusive, interval: '[start,endExclusive)', timezone: e.tz } : null,
      source: { table: e.table || 'sql', field: 'sql:v' }, tier: e.tier, lane: 'sql' };
    let id = null;
    if (book) { try { id = typeof book.addTyped === 'function' ? book.addTyped(spec) : book.add(spec.label, spec.display); } catch (_) { try { id = book.add(spec.label, spec.display); } catch (__) {} } }
    if (!id) id = 'F' + (facts.length + 1);
    facts.push(Object.assign({ id }, spec));
    rows.push({ label: lab || null, value: v, fact: id, status: v == null ? 'no_data' : 'ok' });
  }
  const lines = rows.map(x => `- ${x.label ? x.label + '：' : ''}${(facts.find(f => f.id === x.fact) || {}).display}（${x.fact}）`);
  return { facts, rows, lines };
}

/* ---------- 兜底模板：日期 / 对象字面值 → 参数 ---------- */
// 只按本机认出的期间和对象推参数（模型给的 params 只做核对，对不上就不存模板）；SQL 里还有对不上的日期 / 对象字面值 → 换不全，不存
function templateParams(sql, period, entities, modelParams){
  const lits = [...String(sql).matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
  const params = [];
  const P = period || null;
  const map = P ? { [P.start]: 'period_start', [P.end]: 'period_end', [P.endExclusive]: 'period_end_exclusive', [String(P.start || '').slice(0, 7)]: 'month' } : {};
  for (const v of new Set(lits)) {
    if (isDateLit(v)) {
      const role = map[v];
      if (!role || (role === 'month' && String(P.end || '').slice(0, 7) !== v)) return null;   // 日期换不全
      params.push({ role, value: v });
      continue;
    }
    const e = (entities || []).filter(x => String(x.value) === v);
    if (e.length > 1) return null;
    if (e.length === 1) params.push({ role: 'entity', value: v, dim: e[0].dim });
  }
  // SQL 里没用到的对象（值不在 SQL 里）不算换全
  for (const e of entities || []) if (!params.some(p => p.role === 'entity' && p.value === String(e.value))) return null;
  if (Array.isArray(modelParams)) for (const mp of modelParams) {
    if (!mp || mp.value == null) continue;
    const mine = params.find(p => p.value === String(mp.value));
    if (mine && mp.role && mine.role !== mp.role && !(mine.role === 'month' || mp.role === 'month')) return null;
  }
  return params;
}
function rebindSql(sql, params, period, entities){
  let s = String(sql);
  const P = period || {};
  const val = { period_start: P.start, period_end: P.end, period_end_exclusive: P.endExclusive, month: String(P.start || '').slice(0, 7) };
  const swaps = [];
  for (const p of params || []) {
    let nv;
    if (p.role === 'entity') { const e = (entities || []).filter(x => String(x.dim) === String(p.dim)); if (e.length !== 1) return null; nv = String(e[0].value); }
    else { nv = val[p.role]; if (!nv) return null; if (p.role === 'month' && String(P.end || '').slice(0, 7) !== nv) return null; }
    swaps.push([sq(p.value), sq(nv)]);
  }
  // 先换成占位再换新值，避免新旧值互相覆盖
  swaps.forEach(([a], i) => { if (!s.includes(a)) s = null; else s = s.split(a).join(`\u0000${i}\u0000`); });
  if (s == null) return null;
  swaps.forEach(([, b], i) => { s = s.split(`\u0000${i}\u0000`).join(b); });
  return s;
}

module.exports = {
  dictAlgoLines, weekdayLines, catValueLines, targetLines, collectCategoryValues, catColumnCandidates, rowsToFacts,
  SQL_MARK, MAX_ROWS, buildSqlMessages, checkSql, removeUnsupportedDates, runSql, checkLiterals, sanitizeError, executionRepairError, tierOf, isPersistable, persistRefusal,
  contextFromRegistry, tierSentence, toNum, fmtValue, templateParams, rebindSql,
};

// DuckDB SQLite适配器的CTE内联会触发SqliteBind内部错误；只在已确认SQLite目录上物化CTE，保持只读语义。
async function prepareSqliteCtes(check,ctx){
 ctx.sqliteMultiCte=false;
 let count=0;walkAst(check.ast,n=>{count+=(n.cte_map?.map||[]).length;});if(!count)return check;
 let sqlite=false;try{sqlite=(await ctx.run("SELECT type FROM duckdb_databases() WHERE NOT internal AND type='sqlite' LIMIT 1")).length>0;}catch(_){return check;}if(!sqlite)return check;
 ctx.sqliteMultiCte=count>1;
 const ast={error:false,statements:[JSON.parse(JSON.stringify(check.ast))]};walkAst(ast,n=>{for(const c of n.cte_map?.map||[])c.value.materialized='CTE_MATERIALIZE_ALWAYS';if(n.query_location>Number.MAX_SAFE_INTEGER)n.query_location=0;});
 const sql=String((await ctx.run('SELECT json_deserialize_sql('+sq(JSON.stringify(ast))+') AS s'))[0].s),out=await checkSql(sql,ctx);out.sqlite_ctes_materialized=true;return out;
}
module.exports.prepareSqliteCtes=prepareSqliteCtes;

// 直接复用手工或已确认COUNT算法时，单位也来自定义；未确认自动单位仍按原路径处理。
function registeredCountUnit(check,context){
 const root=check.ast?.node||check.ast,projected=(root?.select_list||[]).filter(x=>String(x.alias||'').toLowerCase()==='v');if(projected.length!==1)return null;
 const ag=(check.aggregates||[]).find(a=>a.node===projected[0]&&a.fn==='count'&&!a.expr&&!a.filter);if(!ag)return null;
 const tables=ag.col?(Array.isArray(ag.col.table)?ag.col.table:[ag.col.table]):check.tables;
 const units=new Set((context.metrics||[]).filter(m=>m.kind==='simple'&&(!m.auto||m.confirmed)&&tables.includes(m.dataset)&&(ag.distinct?ag.col&&m.agg==='dcount'&&m.field===ag.col.col:!ag.col&&m.agg==='count')).map(m=>m.unit).filter(Boolean));
 return units.size===1?String([...units][0]):null;
}
module.exports.registeredCountUnit=registeredCountUnit;

// 只纠正主投影中确定的逐行均价，完整保留原查询的连接、筛选、日期和分组。
async function normalizePerUnitAverage(check, ctx) {
  const ast={error:false,statements:[JSON.parse(JSON.stringify(check.ast))]},root=ast.statements[0]?.node;
  if(root?.type!=='SELECT_NODE')return check;
  const copy=x=>JSON.parse(JSON.stringify(x));let changed=false;
  for(const node of root.select_list||[]){
    if(String(node.alias||'').toLowerCase()!=='v'||node.class!=='FUNCTION'||String(node.function_name).toLowerCase()!=='avg'||node.distinct||node.filter||node.order_bys?.orders?.length||node.children?.length!==1)continue;
    const div=node.children[0];if(div.class!=='FUNCTION'||!['/','divide'].includes(String(div.function_name).toLowerCase())||div.children?.length!==2)continue;
    const num=div.children[0],rawDen=div.children[1],den=rawDen.class==='COLUMN_REF'?rawDen:rawDen.class==='FUNCTION'&&String(rawDen.function_name).toLowerCase()==='nullif'&&rawDen.children?.length===2&&rawDen.children[1]?.class==='CONSTANT'&&rawDen.children[1].value?.value===0?rawDen.children[0]:null;
    if(num.class!=='COLUMN_REF'||den?.class!=='COLUMN_REF')continue;
    const sum=col=>({...copy(node),alias:'',query_location:0,function_name:'sum',children:[copy(col)]});
    const zero={class:'CONSTANT',type:'VALUE_CONSTANT',alias:'',query_location:0,value:{type:{id:'INTEGER',type_info:null},is_null:false,value:0}};
    const nullif={...copy(div),alias:'',query_location:0,function_name:'nullif',is_operator:false,children:[sum(den),zero]};
    const replacement={...copy(div),alias:node.alias,children:[sum(num),nullif]};for(const k of Object.keys(node))delete node[k];Object.assign(node,replacement);changed=true;
  }
  if(!changed)return check;
  walkAst(ast,n=>{if(n.query_location>Number.MAX_SAFE_INTEGER)n.query_location=0;});
  const rows=await ctx.run('SELECT json_deserialize_sql('+sq(JSON.stringify(ast))+') AS s'),sql=String(rows[0].s),out=await checkSql(sql,ctx);out.per_unit_weighting_normalized=true;return out;
}
module.exports.normalizePerUnitAverage=normalizePerUnitAverage;

// 复用已有AST重写和重新检查入口，只替换首个排序表达式，展示/筛选/并列规则全部保留。
async function normalizeUnroundedRank(check,ctx,question){
 const raw=require('./sql-constraints').rawRankOrderExpression(question,check);if(!raw)return check;
 const ast={error:false,statements:[JSON.parse(JSON.stringify(check.ast))]},root=ast.statements[0].node;
 const expression=JSON.parse(JSON.stringify(raw));
 if(expression.class==='COLUMN_REF'&&expression.column_names?.length===1&&String(expression.column_names[0]).toLowerCase()==='v'){
  const from=root.from_table,name=from?.alias||from?.table_name;
  if(!name||!['BASE_TABLE','SUBQUERY'].includes(from.type))return check;
  expression.column_names=[name,...expression.column_names];
 }
 root.modifiers.find(m=>String(m.type).includes('ORDER')).orders[0].expression=expression;
 walkAst(ast,n=>{if(n.query_location>Number.MAX_SAFE_INTEGER)n.query_location=0;});
 const rows=await ctx.run('SELECT json_deserialize_sql('+sq(JSON.stringify(ast))+') AS s'),out=await checkSql(String(rows[0].s),ctx);
 out.raw_rank_normalized=true;return out;
}
module.exports.normalizeUnroundedRank=normalizeUnroundedRank;
