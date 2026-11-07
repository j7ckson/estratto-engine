// ================= 素材包 + 本机核对（10-11「认、选、取、对」里的「取」和「对」） =================
// 本机把要交给助手的数一条条编上号（F1、F2…）放进素材包；助手写话时写 {F3}，回到本机换成精确值。
// 助手自己写出来的数字也逐个核对：素材里对得上的留着；对不上的记下来，界面上标「没来源」。
'use strict';

// 从一段文字里找出「值得核对」的数字：带 % / 万 / 亿 / 货币符号的、有小数的、或者 ≥ 100 的。
// 不管：代号和编号里的数字（G3、F12、#5）、日期和时间（2026-07-01、7/3、7 月、3 日、9:30）、小的整数（前 3 名、2 笔）。
const NUM = /([¥£$€]\s?)?([+\-−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(万|亿|%|％)?/g;
function numbers(text){
  const s = String(text || ''), out = [];
  NUM.lastIndex = 0;
  for (let m; (m = NUM.exec(s));) {
    const i = m.index, j = i + m[0].length, before = s[i - 1] || '', after = s.slice(j, j + 2);
    if (/[A-Za-z0-9_#.\/:\-]/.test(before) && !m[1]) continue;            // 代号、编号、日期的后半截
    if (/^\s?[\/:\-]\d/.test(s.slice(j, j + 3)) || /^\s?(年|月|日|号|点|时|周|季度)/.test(after)) continue;   // 日期、时间
    const raw = m[0].trim();
    let v = Number((m[3] + (m[4] || '')).replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    if (m[5] === '万') v *= 1e4; else if (m[5] === '亿') v *= 1e8;
    const pct = m[5] === '%' || m[5] === '％';
    if (!pct && !m[1] && !m[4] && !m[5] && v < 100) continue;
    out.push({ raw, v: Math.abs(v), pct, at: i });
  }
  return out;
}
const near = (a, b) => a.pct === b.pct && (a.pct ? Math.abs(a.v - b.v) <= Math.max(0.6, 0.02 * b.v) : Math.abs(a.v - b.v) <= Math.max(0.5, 0.01 * b.v));

// ================= 事实记录 v2（10-22 能力终审） =================
// 旧记录只有 label/display：读出来只标 legacy（legacy:true、source_complete:false），不把显示文本猜成结构化值，
// 也不自动升级成「新证据标准下的合格事实」。新记录（schema_version=fb/2）保存：
//   value / unit / 维度键 dims / 半开期间 period / 过滤指纹 filter_fp / plan_id / qid /
//   公式 formula / 父事实 parents / 来源 source{table,field,stamp} / 状态 status。
// 期间只收半开区间 [start, endExclusive)：闭区间只在适配边界转换一次，不在事实本里混着存。
// 展示层统一由 renderFact 从结构化记录生成；value 缺失输出「无数据」，查询成功但空输出「查询成功，无匹配数据」，
// 绝不把空结果渲染成 0；派生事实输出公式和父事实编号。
const FACT_SCHEMA_VERSION = 'fb/2';
const LEGACY_SCHEMA_VERSION = 'fb/1-legacy';
const PERIOD_SCHEMA = 'fb/2-half-open';
const FACT_STATUS = new Set(['ok', 'empty', 'no_data', 'no_value', 'error', 'zero_denominator', 'missing_comparison']);
const CURRENCY_UNIT = new Set(['¥', '￥', '$', '€', '£']);

function isFiniteNumber(v){ return typeof v === 'number' && Number.isFinite(v); }
function sliceText(v, max){ return v == null ? null : String(v).slice(0, max); }

// 数字显示：不用本地化逗号，避免不同环境输出不同；默认 2 位并去掉多余的 0。
function fmtNumber(v, decimals){
  if (!isFiniteNumber(v)) return '';
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? decimals : 2;
  const p = Math.pow(10, d);
  let s = String(Math.round(v * p) / p);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}
function withUnit(text, unit){
  if (!unit) return text;
  if (unit === '%' || unit === '％') return text + '%';
  if (CURRENCY_UNIT.has(unit)) return unit + text;
  return text + unit;                       // 件 / 单 / 元 / 天 / 分 …
}
const STAT_EMPTY = '查询成功，无匹配数据';
const STAT_NO_DATA = '无数据';

// 本地渲染：只从结构化记录生成，不读素材包里别人的数字，也不做第二次模型润色。
// 约定：value 已按 unit 的数值口径存（unit='%' 时存百分点数值 23.81，不存 0.2381），
// 比率/派生指标的百分点换算在语义层完成（semantic.evalRatio），渲染层不猜、不乘 100。
function renderFact(record){
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('renderFact 需要结构化事实记录');
  if (record.legacy) return String(record.display == null ? '' : record.display);   // 旧记录照原值显示，不补结构化来源
  const status = record.status || (record.value == null ? 'no_data' : 'ok');
  let valueText;
  if (status === 'empty') valueText = STAT_EMPTY;
  else if (status === 'no_data' || status === 'no_value' || status === 'error') valueText = STAT_NO_DATA;
  else if (status === 'zero_denominator') valueText = '无法计算：分母为 0';
  else if (status === 'missing_comparison') valueText = '无法计算：缺对比期';
  else if (record.value == null) valueText = STAT_NO_DATA;          // 缺值绝不当 0
  else valueText = withUnit(fmtNumber(record.value, record.decimals), record.unit == null ? '' : String(record.unit));
  const notes = [];
  if (record.derived) {
    if (record.formula) notes.push(`公式：${record.formula}`);
    const parents = Array.isArray(record.parents) ? [...new Set(record.parents)] : [];
    if (parents.length) notes.push(`父事实：${parents.join('、')}`);
  }
  const src = record.source;
  if (src && src.table && src.field) notes.push(`来源：${src.table}.${src.field}`);
  return notes.length ? `${valueText}（${notes.join('；')}）` : valueText;
}

// 旧记录（facts 表 / 旧 JSON 素材串）：只读兼容视图。
function legacyRecord(id, x){
  x = x && typeof x === 'object' ? x : {};
  return {
    id, schema_version: LEGACY_SCHEMA_VERSION, legacy: true, source_complete: false,
    label: String(x.l == null ? '' : x.l), display: String(x.d == null ? '' : x.d),
    value: null, unit: null, dims: null, period: null, filter_fp: null,
    plan_id: null, qid: null, formula: null, parents: [], source: null,
    status: 'legacy', derived: false, decimals: null, origin: x.origin || null,
  };
}

function normalizePeriod(p){
  if (p == null) return null;
  if (typeof p !== 'object' || Array.isArray(p)) throw new TypeError('period 要是 {start, endExclusive, schema}');
  const start = String(p.start == null ? '' : p.start);
  const endExclusive = String(p.endExclusive == null ? '' : p.endExclusive);
  if (!start || !endExclusive) throw new TypeError('period 需要 start 与 endExclusive 两端（半开区间）');
  if (!(start < endExclusive)) throw new RangeError(`period 半开区间无效：${start} 不早于 ${endExclusive}`);
  const schema = p.schema == null ? PERIOD_SCHEMA : String(p.schema);
  if (/clos|闭/i.test(schema)) throw new RangeError('facts v2 只接受半开期间 [start, endExclusive)，闭区间请先在适配边界转换');
  return { start: start.slice(0, 40), endExclusive: endExclusive.slice(0, 40), schema: schema.slice(0, 40) };
}
function normalizeDims(dims){
  if (dims == null) return null;
  const list = [];
  const push = (dim, value) => {
    const d = String(dim == null ? '' : dim).slice(0, 64);
    if (!d) throw new TypeError('dims 的维度名不能为空');
    if (list.some(x => x.dim === d)) throw new TypeError(`dims 维度重复：${d}`);
    if (!(value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) throw new TypeError(`dims 值类型不支持：${d}`);
    list.push({ dim: d, value: value == null ? null : (typeof value === 'number' && !Number.isFinite(value) ? null : value) });
  };
  if (Array.isArray(dims)) {
    for (const x of dims) {
      if (Array.isArray(x)) push(x[0], x[1]);
      else if (x && typeof x === 'object') push(x.dim != null ? x.dim : x.key, x.value != null || 'value' in x ? x.value : x.v);
      else throw new TypeError('dims 数组项要 [维度, 值] 或 {dim, value}');
    }
  } else if (typeof dims === 'object') {
    for (const [k, v] of Object.entries(dims)) push(k, v);
  } else throw new TypeError('dims 要是对象或数组');
  if (list.length > 32) throw new RangeError('dims 最多 32 个维度');
  return list;
}
function normalizeParents(parents){
  if (parents == null) return [];
  const out = [];
  for (const p of (Array.isArray(parents) ? parents : [parents])) {
    const id = String(p == null ? '' : p);
    if (!/^F[1-9]\d{0,15}$/.test(id)) throw new TypeError(`父事实编号无效：${id}`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > 16) throw new RangeError('父事实最多 16 个');
  return out;
}
function normalizeSource(src){
  if (src == null) return null;
  if (typeof src !== 'object' || Array.isArray(src)) throw new TypeError('source 要是 {table, field, stamp}');
  const table = String(src.table == null ? '' : src.table);
  const field = String(src.field == null ? '' : src.field);
  if (!table || !field) throw new TypeError('source 需要 table 与 field；不知道来源就留空，不捏造');
  return { table: table.slice(0, 120), field: field.slice(0, 160), stamp: src.stamp == null ? null : String(src.stamp).slice(0, 40) };
}
// 把 spec 规范成可持久化的记录（id/display 由调用方补）。校验的是「证据标准」，不是显示文本。
function materializeTyped(spec){
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('addTyped 需要结构化 spec 对象');
  const value = spec.value == null ? null : spec.value;
  if (value != null && !isFiniteNumber(value)) throw new TypeError('value 要有限数字或 null（不把字符串/NaN 强转成数值）');
  let status = spec.status == null ? (spec.empty === true ? 'empty' : value == null ? 'no_data' : 'ok') : String(spec.status);
  if (!FACT_STATUS.has(status)) throw new TypeError(`status 无效：${status}`);
  if (status === 'ok' && value == null) throw new RangeError('status=ok 必须带有限数值');
  if (status === 'empty' && value != null) throw new RangeError('status=empty（查询成功但无匹配）不能带数值，绝不渲染成 0');
  if ((status === 'no_data' || status === 'no_value' || status === 'zero_denominator' || status === 'missing_comparison') && value != null) throw new RangeError(`status=${status} 不能带数值`);
  const parents = normalizeParents(spec.parents);
  const formula = spec.formula == null ? null : String(spec.formula).slice(0, 500);
  const derived = spec.derived === true || !!formula || spec.kind === 'derived' || parents.length > 0;
  if (derived) {
    if (!formula) throw new RangeError('派生事实缺公式 formula');
    if (!parents.length) throw new RangeError('派生事实必须指向父事实编号 parents');
  }
  const decimals = spec.decimals == null ? null : spec.decimals;
  if (decimals != null && !(Number.isInteger(decimals) && decimals >= 0 && decimals <= 8)) throw new TypeError('decimals 要是 0..8 的整数');
  const source = normalizeSource(spec.source);
  const record = {
    schema_version: FACT_SCHEMA_VERSION,
    legacy: false,
    label: String(spec.label == null ? '' : spec.label).slice(0, 80),
    value,
    unit: String(spec.unit == null ? '' : spec.unit).slice(0, 24),
    dims: normalizeDims(spec.dims),
    period: normalizePeriod(spec.period),
    filter_fp: sliceText(spec.filter_fp, 200),
    plan_id: sliceText(spec.plan_id, 120),
    qid: sliceText(spec.qid, 120),
    formula,
    parents,
    source,
    status,
    derived,
    decimals,
    source_complete: !!(source && source.table && source.field),
  };
  // 第三轮：兜底 SQL 的事实带可信档（verified / pending / unverified）与来源车道；存卡片 / 报告 / 口径前由 sql-lane.isPersistable 判断
  if (spec.tier != null) { if (!['verified', 'pending', 'unverified'].includes(String(spec.tier))) throw new TypeError('tier 只能是 verified / pending / unverified'); record.tier = String(spec.tier); }
  if (spec.lane != null) record.lane = String(spec.lane).slice(0, 16);
  if (spec.confirmed === true) record.confirmed = true;
  record.display = spec.display != null ? String(spec.display).slice(0, 120) : renderFact(record);
  return record;
}
function parseJsonOrNull(s){
  if (s == null || s === '') return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}
function recordFromV2Row(r){
  if (!r) return null;
  const dims = parseJsonOrNull(r.dims);
  const parents = parseJsonOrNull(r.parents);
  const period = r.period_start != null || r.period_end_exclusive != null
    ? { start: r.period_start || '', endExclusive: r.period_end_exclusive || '', schema: r.period_schema || PERIOD_SCHEMA } : null;
  const source = r.source_table != null || r.source_field != null
    ? { table: r.source_table || '', field: r.source_field || '', stamp: r.source_stamp || null } : null;
  return {
    id: 'F' + Number(r.n),
    schema_version: r.schema_version || FACT_SCHEMA_VERSION,
    legacy: false,
    label: String(r.l == null ? '' : r.l),
    display: String(r.d == null ? '' : r.d),
    value: r.value == null ? null : Number(r.value),
    unit: r.unit == null ? '' : String(r.unit),
    dims: Array.isArray(dims) ? dims : null,
    period,
    filter_fp: r.filter_fp == null ? null : String(r.filter_fp),
    plan_id: r.plan_id == null ? null : String(r.plan_id),
    qid: r.qid == null ? null : String(r.qid),
    formula: r.formula == null ? null : String(r.formula),
    parents: Array.isArray(parents) ? parents.map(String) : [],
    source,
    status: r.status || (r.value == null ? 'no_data' : 'ok'),
    derived: !!r.derived,
    decimals: r.decimals == null ? null : Number(r.decimals),
    source_complete: !!(source && source.table && source.field),
    origin: r.origin || null,
  };
}

// Persisted next is a strict Number, never coerced from a string. Keep the
// original book object: callers save that same mutable object back into state.
function normalizeNext(book){
  if (!book.items || typeof book.items !== 'object' || Array.isArray(book.items)) book.items = {};
  let max = 0;
  for (const id of Object.keys(book.items)) {
    if (!/^F[1-9]\d{0,15}$/.test(id)) continue;
    const n = Number(id.slice(1));
    if (Number.isSafeInteger(n)) max = Math.max(max, n);
  }
  if (max === Number.MAX_SAFE_INTEGER) throw new RangeError('素材编号已耗尽，无法分配安全的下一个 F 编号');
  const minimum = max + 1;
  if (!Number.isSafeInteger(book.next) || book.next < minimum) book.next = minimum;
  return book.next;
}
class FactBook {
  // fallback（10-16 第五批）：本子里没有的编号再去本机的编号表里找 { get(id), known() }；
  // 10-22：fallback 也可以带 getTyped(id)，结构化记录优先。
  constructor(data, fallback){
    this.d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    normalizeNext(this.d);
    this.fb = fallback || null;
  }
  json(){ return this.d; }
  // 分配编号（纯逻辑，add / addTyped 共用；耗尽时在写入前抛，不动已有记录）
  _alloc(){
    const next = normalizeNext(this.d);
    // Reserve MAX_SAFE_INTEGER as an exhausted next sentinel, so incrementing
    // never persists an unsafe integer or wraps/reuses an old identifier.
    if (next === Number.MAX_SAFE_INTEGER) throw new RangeError('素材编号已耗尽，无法分配安全的下一个 F 编号');
    this.d.next = next + 1;
    return 'F' + next;
  }
  _trim(){
    const ids = Object.keys(this.d.items);
    if (ids.length > 3000) for (const k of ids.slice(0, ids.length - 3000)) delete this.d.items[k];   // 对话里的素材只留最近 3000 条
  }
  add(label, display){
    const id = this._alloc();
    this.d.items[id] = { l: String(label == null ? '' : label).slice(0, 80), d: String(display == null ? '' : display).slice(0, 120) };
    this._trim();
    return id;
  }
  // 类型化事实：只接受结构化 spec；校验不通过就抛，不写一条只有显示文本的「伪结构」记录。
  addTyped(spec){
    const record = materializeTyped(spec);
    const id = this._alloc();
    record.id = id;
    this.d.items[id] = { l: record.label, d: record.display, v: record };
    this._trim();
    return id;
  }
  // get 只回显示视图 {l,d}（类型化记录额外字段走 getTyped）；旧调用方形状不变。
  get(id){ const x = this.d.items[id]; if (x && x.v) return { l: x.l, d: x.d }; return x || (this.fb && this.fb.get(id)) || null; }
  // 结构化记录：fb/2 返回完整对象；旧记录返回 legacy 视图（不捏造 value/source）；未知编号 null。
  getTyped(id){
    const key = String(id == null ? '' : id);
    const item = this.d.items[key];
    if (item && item.v && typeof item.v === 'object') return Object.assign({}, item.v, { id: key });
    if (item) return legacyRecord(key, item);
    const fb = this.fb;
    if (fb && typeof fb.getTyped === 'function') return fb.getTyped(key);
    if (fb && typeof fb.get === 'function') { const x = fb.get(key); if (x) return legacyRecord(key, x); }
    return null;
  }
  // 助手写的 → 你看到的：{F3}（或 F3）换成本机的精确值；其余数字逐个和素材核对，对不上的返回在 unsourced 里。
  // 本机没有的编号（不存在 / 已经过期）原样留着，并列在 missing 里 —— 谁用谁负责给提示，不要悄悄吞掉。
  fill(text){
    const src = String(text || '').replace(/\{(F\d{1,16}):label\}/g,(m,id)=>{const x=this.get(id);return x?x.l:m;});
    const ph = /\{{1,2}\s*(F\d{1,16})\s*\}{1,2}|〔(F\d{1,16})〕|【(F\d{1,16})】|\b(F\d{1,16})\b/g;
    const used = [], missing = [];
    const idOf = (a, b, c, d) => a || b || c || d;
    const hit = new Map(), look = id => { if (!hit.has(id)) hit.set(id, this.get(id)); return hit.get(id); };
    const masked = src.replace(ph, (m, a, b, c, d) => { const id = idOf(a, b, c, d); if (!look(id)) { missing.push(id); return m; } used.push(id); return ' '.repeat(m.length); });
    const known = Object.values(this.d.items).concat(this.fb ? this.fb.known() : []).flatMap(x => numbers(x.d));
    const unsourced = [...new Set(numbers(masked).filter(n => !known.some(k => near(n, k))).map(n => n.raw))];
    const out = src.replace(ph, (m, a, b, c, d) => { const id = idOf(a, b, c, d); const x = look(id); return x ? x.d : m; });
    return { text: out, unsourced, used, missing: [...new Set(missing)] };
  }
}

// ================= 本机的编号表（10-16 第五批；10-22 加 facts_v2）=================
// 以前对话和报告共用的编号（F1、F2…）存成 state 里一整串文字，只留最近 3000 条：一份报告就占几百个，早一点的编号会被挤掉、
// 回头翻旧对话取不到值；每加几个编号就把整串重写一遍。现在一行一条存进 facts 表：不再挤掉，加编号只写新加的那几行。
// 核对「没来源」照旧只和最近 3000 条比（不拿全部历史去碰运气）。第一次用时把原来那一串搬进来（原来那串不删，退回旧版还能用）。
// 10-22：结构化事实另存新表 facts_v2，旧 facts 表一个字节不改。facts_meta.schema_version 记版本；
// 回退 = 旧版忽略 / DROP facts_v2、facts_meta 两张新表即可，旧 facts 与旧 JSON 素材串仍然可读（旧记录显示原值）。
const pools = new WeakMap();
const inTx = (state, fn) => state.db.isTransaction === true ? fn() : state.tx(fn);     // 已经在别人的写操作里：直接写，不另开
class SharedFacts {
  static of(state){
    if (!state || !state.db) return null;                    // 测试里的假 state：照旧用那一串
    if (!pools.has(state)) pools.set(state, new SharedFacts(state));
    return pools.get(state);
  }
  constructor(state){
    this.state = state; this._known = null;
    state.db.exec(`CREATE TABLE IF NOT EXISTS facts(n INTEGER PRIMARY KEY, l TEXT NOT NULL, d TEXT NOT NULL, origin TEXT, at TEXT NOT NULL)`);
    this._ensureV2();
    const old = state.getJson('facts:dsh', null), now = new Date().toISOString();
    if (old && old.items && typeof old.items === 'object') inTx(state, () => {
      for (const [id, x] of Object.entries(old.items)) if (/^F[1-9]\d{0,15}$/.test(id) && x && Number.isSafeInteger(Number(id.slice(1))))
        state.run('INSERT OR IGNORE INTO facts(n, l, d, origin, at) VALUES(?, ?, ?, ?, ?)', Number(id.slice(1)), String(x.l == null ? '' : x.l).slice(0, 80), String(x.d == null ? '' : x.d).slice(0, 120), x.origin || null, now);
    });
    const max = (state.one('SELECT max(n) AS n FROM facts') || {}).n || 0;
    const max2 = (state.one('SELECT max(n) AS n FROM facts_v2') || {}).n || 0;
    this.next = Math.max(max + 1, max2 + 1, old && Number.isSafeInteger(old.next) ? old.next : 1);
  }
  // 新表只建不改：旧版程序不认这两张表，删掉就完全回退。
  _ensureV2(){
    if (this._v2) return;
    this.state.db.exec(`CREATE TABLE IF NOT EXISTS facts_meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.state.db.exec(`CREATE TABLE IF NOT EXISTS facts_v2(
      n INTEGER PRIMARY KEY, l TEXT NOT NULL, d TEXT NOT NULL, origin TEXT, at TEXT NOT NULL,
      schema_version TEXT NOT NULL, value REAL, unit TEXT, dims TEXT,
      period_start TEXT, period_end_exclusive TEXT, period_schema TEXT,
      filter_fp TEXT, plan_id TEXT, qid TEXT, formula TEXT, parents TEXT,
      source_table TEXT, source_field TEXT, source_stamp TEXT,
      status TEXT NOT NULL, derived INTEGER NOT NULL DEFAULT 0, decimals INTEGER)`);
    inTx(this.state, () => this.state.run(`INSERT OR IGNORE INTO facts_meta(k, v) VALUES('schema_version', ?)`, FACT_SCHEMA_VERSION));
    this._v2 = true;
  }
  alloc(){ if (this.next >= Number.MAX_SAFE_INTEGER) throw new RangeError('素材编号已耗尽，无法分配安全的下一个 F 编号'); return this.next++; }
  row(id){
    if (!/^F[1-9]\d{0,15}$/.test(String(id))) return null;
    const n = Number(String(id).slice(1));
    const v2 = this.state.one('SELECT l, d, origin FROM facts_v2 WHERE n = ?', n);
    if (v2) return v2.origin ? { l: v2.l, d: v2.d, origin: v2.origin } : { l: v2.l, d: v2.d };
    const r = this.state.one('SELECT l, d, origin FROM facts WHERE n = ?', n);
    return r ? (r.origin ? { l: r.l, d: r.d, origin: r.origin } : { l: r.l, d: r.d }) : null;
  }
  // 结构化记录优先；facts 表里的旧行 / 旧 JSON 串读成 legacy 视图，不捏造 value/source。
  rowTyped(id){
    if (!/^F[1-9]\d{0,15}$/.test(String(id))) return null;
    const n = Number(String(id).slice(1));
    const v2 = this.state.one('SELECT * FROM facts_v2 WHERE n = ?', n);
    if (v2) return recordFromV2Row(v2);
    const r = this.state.one('SELECT l, d, origin FROM facts WHERE n = ?', n);
    return r ? legacyRecord('F' + n, r) : null;
  }
  recent(noReport){
    if (!noReport && this._known) return this._known;
    const rows = this.state.all(`SELECT n, d, origin FROM facts UNION ALL SELECT n, d, origin FROM facts_v2 ORDER BY n DESC LIMIT 3000`)
      .filter(r => !noReport || !(r.origin === 'report')).map(r => ({ d: r.d }));
    if (!noReport) this._known = rows;
    return rows;
  }
  _write(plain, typed, origin){
    const now = new Date().toISOString();
    inTx(this.state, () => {
      for (const [id, x] of Object.entries(plain || {})) {
        const n = Number(String(id).slice(1));
        if (!Number.isSafeInteger(n)) continue;
        this.state.run('INSERT OR REPLACE INTO facts(n, l, d, origin, at) VALUES(?, ?, ?, ?, ?)', n, x.l, x.d, origin || x.origin || null, now);
      }
      for (const [id, x] of Object.entries(typed || {})) {
        const n = Number(String(id).slice(1));
        if (!Number.isSafeInteger(n)) continue;
        const rec = x.v && typeof x.v === 'object' ? x.v : x;
        const period = rec.period || {}, source = rec.source || {}, parents = Array.isArray(rec.parents) ? rec.parents : [];
        this.state.run(`INSERT OR REPLACE INTO facts_v2(n, l, d, origin, at, schema_version, value, unit, dims,
            period_start, period_end_exclusive, period_schema, filter_fp, plan_id, qid, formula, parents,
            source_table, source_field, source_stamp, status, derived, decimals)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          n, String(rec.label == null ? '' : rec.label).slice(0, 80), String(rec.display == null ? '' : rec.display).slice(0, 120),
          origin || x.origin || rec.origin || null, now, rec.schema_version || FACT_SCHEMA_VERSION,
          rec.value == null ? null : rec.value, rec.unit == null ? '' : String(rec.unit),
          rec.dims == null ? null : JSON.stringify(rec.dims),
          period.start || null, period.endExclusive || null, period.schema || null,
          rec.filter_fp == null ? null : String(rec.filter_fp), rec.plan_id == null ? null : String(rec.plan_id),
          rec.qid == null ? null : String(rec.qid), rec.formula == null ? null : String(rec.formula),
          parents.length ? JSON.stringify(parents) : null,
          source.table || null, source.field || null, source.stamp || null,
          rec.status || (rec.value == null ? 'no_data' : 'ok'), rec.derived ? 1 : 0,
          rec.decimals == null ? null : rec.decimals);
      }
    });
    this._known = null;
  }
  put(items, origin){
    const list = Object.entries(items || {});
    if (!list.length) return;
    const plain = {}, typed = {};
    for (const [id, x] of list) { if (x && x.v && typeof x.v === 'object') typed[id] = x; else plain[id] = x; }
    this._write(plain, typed, origin);
  }
  putTyped(items, origin){
    const list = Object.entries(items || {});
    if (!list.length) return;
    this._write({}, Object.fromEntries(list), origin);
  }
  // 对话 / 取数用的本子：新编号先记在本子里，save() 一次写进表；本子里没有的去表里找
  book(origin){
    const pool = this, b = new FactBook({ next: this.next, items: {} }, { get: id => pool.row(id), known: () => pool.recent(false), getTyped: id => pool.rowTyped(id) });
    b.add = function(label, display){
      const n = pool.alloc(), id = 'F' + n;
      this.d.next = n + 1;
      this.d.items[id] = { l: String(label == null ? '' : label).slice(0, 80), d: String(display == null ? '' : display).slice(0, 120) };
      return id;
    };
    b.addTyped = function(spec){
      const record = materializeTyped(spec), n = pool.alloc(), id = 'F' + n;
      record.id = id;
      this.d.next = n + 1;
      this.d.items[id] = { l: record.label, d: record.display, v: record };
      return id;
    };
    b.save = function(){ pool.put(this.d.items, origin); this.d = { next: this.d.next, items: {} }; };
    return b;
  }
  // 报告用：本报告素材 + 对话里的补查编号（报告自己打包的、别的报告的都不算）
  view(items, noReport){
    const pool = this;
    return new FactBook({ items: Object.assign({}, items || {}) }, {
      get: id => { const x = pool.row(id); return x && !(noReport && x.origin === 'report') ? x : null; },
      known: () => pool.recent(noReport),
      getTyped: id => { const x = pool.rowTyped(id); return x && !(noReport && x.origin === 'report') ? x : null; },
    });
  }
}
// 回退辅助：删掉 facts_v2 / facts_meta，让旧版程序（或旧读取路径）完全回到只有 facts 的状态。
// 旧的 facts 行、旧 JSON 素材串都不动；已写的结构化事实只在新表里，删表即视为未迁移。
function dropTypedSchema(state){
  if (!state || !state.db) return false;
  state.db.exec('DROP TABLE IF EXISTS facts_v2');
  state.db.exec('DROP TABLE IF EXISTS facts_meta');
  pools.delete(state);
  return true;
}

module.exports = {
  FactBook, SharedFacts, numbers, renderFact, dropTypedSchema,
  FACT_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, PERIOD_SCHEMA,
};

if (require.main === module) {          // 自检：node main/facts.js
  const assert = require('node:assert');
  const b = new FactBook();
  const f1 = b.add('家具退款', '¥2,600'), f2 = b.add('家具 · 比上一段', '+30.0%'), f3 = b.add('灯具退款', '¥310');
  let r = b.fill(`G3 退款最多，{${f1}}，比上一段多 ${f2}；G5 是 〔${f3}〕。`);
  assert.equal(r.text, 'G3 退款最多，¥2,600，比上一段多 +30.0%；G5 是 ¥310。'); assert.deepEqual(r.unsourced, []); assert.deepEqual(r.missing, []);
  r = b.fill('家具退款约 2600 元，涨了 30%，利润率 7.7%，7/3～8/2 前 3 名，2026-07-01 起，共 18 笔');
  assert.deepEqual(r.unsourced, ['7.7%']);
  r = b.fill('销售额 12.3万，SKU-12345 卖得好，F99 不存在');
  assert.deepEqual(r.unsourced, ['12.3万']); assert.ok(r.text.includes('F99'));
  // 取不到值的编号：原样留着，并报出来（同一个编号出现两次只报一次）；别的字一个不改
  r = b.fill(`{${f1}} 和 {F99999}，还有 {F99999}；这条 2600 元的没事`);
  assert.equal(r.text, '¥2,600 和 {F99999}，还有 {F99999}；这条 2600 元的没事');
  assert.deepEqual(r.missing, ['F99999']); assert.deepEqual(r.unsourced, []); assert.deepEqual(r.used, [f1]);
  r = b.fill('什么都没写');
  assert.deepEqual([r.missing, r.used, r.unsourced], [[], [], []]); assert.equal(r.text, '什么都没写');
  // v2 自检：结构化记录 / 渲染 / legacy
  const typed = b.addTyped({ label: '销售额', value: 210, unit: '¥', source: { table: '销售明细', field: '销售额' }, period: { start: '2026-10-01', endExclusive: '2026-11-01' }, plan_id: 'p1', qid: 'q1', filter_fp: 'fpx' });
  assert.equal(b.getTyped(typed).value, 210);
  assert.equal(b.getTyped(typed).period.endExclusive, '2026-11-01');
  assert.equal(renderFact(b.getTyped(typed)), '¥210（来源：销售明细.销售额）');
  const empty = b.addTyped({ label: '退款', value: null, empty: true, unit: '¥' });
  assert.equal(renderFact(b.getTyped(empty)), '查询成功，无匹配数据');
  assert.equal(renderFact(b.getTyped(f1)), '¥2,600');       // 旧 add() 记录：原值显示
  assert.equal(b.getTyped(f1).legacy, true);
  assert.equal(b.getTyped(f1).source_complete, false);
  const d1 = b.addTyped({ label: '毛利率', value: 0.5714, unit: '%', formula: 'gross_profit / gmv', parents: [typed], derived: true });
  assert.ok(renderFact(b.getTyped(d1)).includes('公式：gross_profit / gmv'));
  assert.ok(renderFact(b.getTyped(d1)).includes(`父事实：${typed}`));
  console.log('facts 自检通过');
}
