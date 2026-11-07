// ================= 统一语义注册表（M1）=================
// 唯一业务定义：main/semantic.js + main/semantic/*.json。
// 这个模块只做三件事：**加载**、**给稳定编号**、**按编号查**，不另建第二套口径。
//
// 为什么需要它：复审发现 Semantic 只被工作台和测试用，Harness 另建了一套地图（M1/D1 每次运行会变），
// 于是 UI、Agent、报告说的「同一个指标」可能不是同一个定义。这里给每个指标 / 维度 / 关系一个
// 稳定编号（m: / d: / r:），工作台、计划、Agent 工具、报告都按这个编号引用。
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Semantic } = require('./semantic');

const PACK_FILES = ['retail-core', 'ads', 'live', 'inventory', 'logistics', 'finance'];
const DEFAULT_PACK_DIR = path.join(__dirname, 'semantic');

const mid = id => 'm:' + id;
const did = id => 'd:' + id;
const rid = id => 'r:' + id;

class SemanticRegistry {
  constructor(o = {}){
    this.semantic = o.semantic || new Semantic();
    this.packIds = [];
    this.packDefs = [];       // 原始 pack 定义（工作台要按包统计指标数，不靠文件名猜）
    this.generated = [];      // 从 generatedDir 读进来的包（补丁确认后生成）
    this.generatedErrors = [];
    this.aliasApplied = []; this.aliasSkipped = [];
    this.packDir = o.packDir || DEFAULT_PACK_DIR;
    this.tables = o.tables || [];       // [{name, columns:[{name,type}]}]
    this.dict = o.dict || null;
    this.bound = false;
  }

  static load(o = {}){
    const r = new SemanticRegistry(o);
    const packs = o.packs || PACK_FILES.map(id => require(path.join(r.packDir, id + '.json')));
    for (const p of packs) { r.semantic.load(p); r.packIds.push(p.id); r.packDefs.push(p); }
    // 补丁确认后生成的语义包：只读目录里的 JSON，坏了就记一笔，不静默吞掉
    if (o.generatedDir) {
      let files = [];
      try { files = fs.existsSync(o.generatedDir) ? fs.readdirSync(o.generatedDir).filter(f => f.endsWith('.json')).sort() : []; } catch (err) { r.generatedErrors.push({ file: o.generatedDir, error: String(err.message || err) }); }
      const pendingAliases = [];
      for (const f of files) {
        const file = path.join(o.generatedDir, f);
        try {
          const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
          r.semantic.load(pack);
          r.packIds.push(pack.id); r.packDefs.push(pack);
          r.generated.push({ file, id: pack.id, name: pack.name, meta: pack._meta || {},
            counts: { metrics: (pack.metrics || []).length, dims: (pack.dims || []).length, relationships: (pack.relationships || []).length, aliases: (pack.aliases || []).length } });
          pendingAliases.push(...(pack.aliases || []));
        } catch (err) { r.generatedErrors.push({ file, error: String(err.message || err) }); }
      }
      // 先加载所有定义，再解析别名；文件名顺序不能决定前向引用是否生效。
      for (const a of pendingAliases) {
        const target = String(a.target || '');
        try {
          if (target.startsWith('m:')) {
            const m = r.semantic.metrics.get(target.slice(2));
            if (!m) { r.aliasSkipped.push({ ...a, why: 'unknown_metric' }); continue; }
            m.aliases = [...new Set([...(m.aliases || []), a.alias])];
            r.aliasApplied.push({ target, alias: a.alias, applies_to: 'metric', patch: a.patch || null });
          } else if (target.startsWith('d:')) {
            const d = r.semantic.dims.get(target.slice(2));
            if (!d) { r.aliasSkipped.push({ ...a, why: 'unknown_dim' }); continue; }
            d.match = [...new Set([...(d.match || []), a.alias])];
            d.aliases = [...new Set([...(d.aliases || []), a.alias])];
            r.aliasApplied.push({ target, alias: a.alias, applies_to: 'dim', patch: a.patch || null });
          } else r.aliasSkipped.push({ ...a, why: 'bad_target' });
        } catch (err) { r.aliasSkipped.push({ ...a, why: String(err && err.message || err) }); }
      }
    }
    if (o.tables) r.bind(o.tables, { partial: o.partial !== false });
    return r;
  }

  bind(tables, opt = {}){
    this.tables = tables || this.tables;
    const formats = Object.assign({},...(this.packDefs||[]).map(p=>p._meta?.column_formats||{}));
    const business = Object.assign({},...(this.packDefs||[]).map(p=>p._meta?.business_columns||{}));
    this.tables = this.tables.map(t=>Object.assign({},t,{columns:(t.columns||[]).map(c=>Object.assign({},formats[t.name+'.'+c.name]||{},c,{system:c.system===true || (business[t.name] ? !business[t.name].includes(c.name) : /^v_t[a-f0-9]{16}$/.test(t.name) && ['_src','_row','_snap','_sheet'].includes(c.name))}))}));
    for (const m of this.semantic.metrics.values()) {
      const c=this.tables.find(t=>t.name===(m.dataset||m.boundTo))?.columns.find(c=>c.name===m.field);
      const table=this.tables.find(t=>t.name===(m.dataset||m.boundTo));
      const currency={USD:'美元',GBP:'英镑',EUR:'欧元',CNY:'元',JPY:'日元'};
      if(m.auto&&!m.confirmed&&!m.multi_currency&&['元','美元','英镑','欧元','日元'].includes(m.unit)&&currency[table?.currency]&&!c?.nfmt?.cur){m.unit=currency[table.currency];m.currency_source='table_confirmed';}
      if (m.kind==='simple' && m.unit==='%' && m.percent_scale==null && c && (c.percent_scale!=null || c.nfmt?.pct)) m.percent_scale=c.percent_scale??1;
    }
    for(const m of this.semantic.metrics.values())require('./auto-semantics').qualifyAutoMetric(m,this.tables.find(t=>t.name===(m.dataset||m.boundTo)));
    for(const m of this.semantic.metrics.values())if(m.kind==='simple'&&m.agg==='sum'&&m.auto&&!m.confirmed){
      const d=require('./auto-semantics').metricDefaultOfName(m.name);
      if(d){m.agg=d.agg;if(!m.unit)m.unit=d.unit;m.aliases=[...new Set([...(m.aliases||[]),d.alias].filter(Boolean))];}
    }
    for(const d of this.semantic.dims.values())if(d.auto&&!d.confirmed&&/^(?:l1|level_?1)$/i.test(d.source?.field||d.match?.[0]||d.role||'')){d.aliases=[...new Set([...(d.aliases||[]),'大类','一级类目','一级分类'])];}
    this.semantic.bind(this.tables, this.dict, { strict: opt.strict === true });
    this.bound = true;
    return this;
  }

  /* ---------- 稳定编号 ---------- */
  metric(id){ const raw = String(id).startsWith('m:') ? String(id).slice(2) : String(id); return this.semantic.metric(raw); }
  dim(id){ const raw = String(id).startsWith('d:') ? String(id).slice(2) : String(id); return this.semantic.dim(raw); }
  static idOfMetric(id){ return mid(String(id).replace(/^m:/, '')); }
  static idOfDim(id){ return did(String(id).replace(/^d:/, '')); }

  /** 接受 m:gmv / gmv / 指标中文名，返回规范编号；认不出返回 null（不抛错，给计划解析用） */
  resolveMetricId(x){
    if (x == null) return null;
    const s = String(x).trim();
    const raw = s.replace(/^m:/, '');
    if (this.semantic.metrics.has(raw)) return mid(raw);
    const byName = [...this.semantic.metrics.values()].filter(m => m.name === s || m.id === s);
    return byName.length === 1 ? mid(byName[0].id) : null;
  }
  resolveDimId(x){
    if (x == null) return null;
    const s = String(x).trim();
    const raw = s.replace(/^d:/, '');
    if (this.semantic.dims.has(raw)) return did(raw);
    const byName = [...this.semantic.dims.values()].filter(d => d.name === s || d.id === s);
    return byName.length === 1 ? did(byName[0].id) : null;
  }

  /* ---------- 查询 / 能力 ---------- */
  metrics(){ return [...this.semantic.metrics.values()].map(m => this.describeMetric(m)); }
  dims(){ return [...this.semantic.dims.values()].map(d => this.describeDim(d)); }
  describeMetric(m){
    return {
      id: mid(m.id), name: m.name, kind: m.kind, additivity: m.additivity, unit: m.unit || '', decimals: m.decimals,
      dataset: m.dataset || null, field: m.field || null, bound: this.bound ? !m.unbound && this.semantic.isBound(m.id) : true,
      formula: m.kind === 'ratio' ? { num: mid(m.num), den: mid(m.den), mul: m.mul || 1 } : m.kind === 'derived' ? { expr: m.expr } : null,
      depends_on: this.semantic.metrics.has(m.id) ? this.semantic.leaves(m.id).map(mid) : [],
      restrictions: m.additivity === 'semiAdditive' ? ['快照/存量：跨期不可相加；跨表分组 SQL 未实现'] : m.additivity === 'ratio' ? ['比率：分子分母各自聚合后再除，不能先算比率再平均'] : [],
    };
  }
  describeDim(d){
    return { id: did(d.id), name: d.name, kind: d.kind, dataset: (d.source && d.source.table) || d.dataset || null, field: (d.source && d.source.field) || null, bound: this.bound ? !d.unbound : true, grain: d.grain || null };
  }

  /** 时间粒度维度：优先领域包已声明的 timeBucket；没有就按同一张表的日期列派生一个（id 稳定、幂等）。
   *  只做日历分组，不改指标口径、不改数据。返回 null = 这张表没有可用日期列（调用方按能力缺口处理）。 */
  grainDim(grain, table){
    const g = String(grain || '');
    const NAME = { day: '日', week: '周', month: '月', quarter: '季度', year: '年' };
    if (!NAME[g]) throw Object.assign(new Error(`不支持的时间粒度：${g}`), { code: 'unsupported_operator' });
    const onTable = d => d && !d.unbound && d.source && d.source.table === table;
    for (const d of this.semantic.dims.values()) {
      if (onTable(d) && d.kind === 'timeBucket' && d.grain === g) {
        return { id: did(d.id), dim: this.describeDim(d), created: false, source: 'pack' };
      }
    }
    const cols = ((this.tables || []).find(t => t.name === table) || {}).columns || [];
    const dateCols = new Set(cols.filter(c => c.type === 'date').map(c => c.name));
    // 同表日期列：优先 column 维度（就是那一天），其次无更细粒度的 timeBucket
    let base = null;
    for (const d of this.semantic.dims.values()) {
      if (!onTable(d) || (d.kind !== 'column' && d.kind !== 'timeBucket')) continue;
      const isDate = dateCols.size
        ? dateCols.has(d.source.field)
        : /日期|date|时间/i.test(String(d.name) + ' ' + String(d.id) + ' ' + String(d.source.field));
      if (!isDate) continue;
      if (!base || (d.kind === 'column' && base.kind !== 'column')) base = d;
    }
    if (!base) return null;
    // 日粒度：column 类型的日期列本身就一天一行；换成 timeBucket(day) 保证 SQL 输出统一成 'YYYY-MM-DD'
    // 从更粗/其它粒度的日期维度派生目标粒度时，必须新建 id（不能复用月/年桶当「日」用）
    const id = base.kind === 'column' ? base.id + '_' + g : (base.grain === g ? base.id : base.id + '_' + g);
    if (this.semantic.dims.has(id)) {
      const d = this.semantic.dims.get(id);
      return { id: did(d.id), dim: this.describeDim(d), created: false, source: 'derived' };
    }
    const dim = { id, name: g === 'day' ? base.name : NAME[g], kind: 'timeBucket', grain: g, source: { table: base.source.table, field: base.source.field }, derived: true, from_dim: did(base.id) };
    this.semantic.dims.set(id, dim);
    return { id: did(id), dim: this.describeDim(dim), created: true, source: 'derived_from:' + did(base.id) };
  }

  /** 百分比指标 → 百分点换算倍数（结构化可判定的才给；null = 需要业务口径） */
  percentScaleOf(metricId){ return this.semantic.percentScaleOf(String(metricId).replace(/^m:/, '')); }

  /** 单位审计：只报告能确定/不能确定与依据，不改定义、不猜业务口径 */
  unitAudit(){ return this.semantic.unitAudit(); }

  /** 这个指标能按哪些维度安全分组（沿用扇出规则，不另写一套） */
  groupableDims(metricId){
    const out = [];
    for (const d of this.semantic.dims.values()) {
      if (d.unbound) continue;
      try { this.semantic.checkJoin(String(metricId).replace(/^m:/, ''), [d.id]); out.push(this.describeDim(d)); } catch (_) {}
    }
    return out;
  }

  /** 时间角色：每个有日期维度的数据集一个角色。计划里说「按退款时间」还是「按下单时间」要靠它。 */
  timeRoles(){
    const out = [];
    for (const d of this.semantic.dims.values()) {
      if (d.unbound || !d.source) continue;
      const isDate = d.kind === 'timeBucket' || /日期|date|时间/i.test(String(d.name) + ' ' + String(d.id));
      if (!isDate) continue;
      const role = d.source.table;
      const exist = out.find(x => x.dataset === role);
      const item = { id: 't:' + role, dataset: role, dim: did(d.id), name: (exist && exist.name) || d.name };
      if (!exist) out.push(item);
    }
    return out;
  }

  /** 相关能力：按文本给候选指标 / 维度 / 时间角色 / 限制，不返回全量 schema */
  capabilities(text, o = {}){
    const q = String(text || '');
    const limit = o.limit || 8;
    const score = (names) => {
      let s = 0;
      for (const n of names) {
        if (!n || String(n).length < 2) continue;
        if (q.includes(String(n))) s += Math.min(String(n).length, 6);
      }
      return s;
    };
    const metrics = this.metrics().map(m => {
      const raw = this.semantic.metrics.get(m.id.slice(2));
      const names = [m.name, ...(raw.match || []), ...(raw.aliases || []), m.id.slice(2)];
      return { ...m, _s: score(names) };
    }).filter(m => m._s > 0 || o.all).sort((a, b) => b._s - a._s);
    const dims = this.dims().map(d => {
      const raw = this.semantic.dims.get(d.id.slice(2));
      const names = [d.name, ...(raw.match || []), d.id.slice(2)];
      return { ...d, _s: score(names) };
    }).filter(d => d._s > 0 || o.all).sort((a, b) => b._s - a._s);
    const pick = (arr, n) => arr.slice(0, n).map(({ _s, ...x }) => x);
    return {
      metrics: pick(metrics, limit), dims: pick(dims, limit * 2), time_roles: this.timeRoles(),
      operations: this.semantic.capabilities().ops,
      unbound: (this.semantic.unbound || []).slice(),
      note: metrics.length ? null : '没有匹配的语义指标；可以先用 inspect_semantics 按编号查，或提出语义补丁',
    };
  }

  /** 按编号读完整定义（口径 / 输入输出 / 依赖 / 验证状态） */
  inspect(id){
    const s = String(id || '');
    if (s.startsWith('m:')) {
      const m = this.semantic.metrics.get(s.slice(2));
      if (!m) return { ok: false, code: 'unknown_metric', id: s };
      return { ok: true, entity: 'metric', ...this.describeMetric(m), groupable_dims: this.groupableDims(s), status: m.unbound ? 'unbound' : 'bound' };
    }
    if (s.startsWith('d:')) {
      const d = this.semantic.dims.get(s.slice(2));
      if (!d) return { ok: false, code: 'unknown_dim', id: s };
      return { ok: true, entity: 'dim', ...this.describeDim(d), status: d.unbound ? 'unbound' : 'bound' };
    }
    if (s.startsWith('r:')) {
      const r = this.semantic.rels.get(s.slice(2));
      if (!r) return { ok: false, code: 'unknown_relationship', id: s };
      return { ok: true, entity: 'relationship', id: s, left: r.left, right: r.right, cardinality: r.cardinality, pairs: r.pairs, bound: !r.unbound };
    }
    return { ok: false, code: 'bad_id', message: '编号要以 m: / d: / r: 开头' };
  }

  eval(metricId, dimIds, tables){
    return this.semantic.eval(String(metricId).replace(/^m:/, ''), dimIds.map(x => String(x).replace(/^d:/, '')), tables);
  }
  compileSql(metricId, dimIds, map, opts){
    return this.semantic.compileSql(String(metricId).replace(/^m:/, ''), dimIds.map(x => String(x).replace(/^d:/, '')), map, opts);
  }
  leaves(metricId){ return this.semantic.leaves(String(metricId).replace(/^m:/, '')).map(mid); }

  /** 生成的包（补丁确认后）单独列出来，UI / 报告能区分「内置」与「补丁生成」 */
  generatedPacks(){ return this.generated.slice(); }

  /** 口径指纹：语义定义 + 绑定 + 数据表版本，一起算。缓存/复用都按它失效。 */
  stamp(extra){
    const { fingerprint } = require('./request-context');
    const computation = x => Object.fromEntries(Object.entries(x).filter(([k]) => !['name','aliases','match','description'].includes(k)));
    const m = [...this.semantic.metrics.values()].map(computation).sort((a,b)=>a.id.localeCompare(b.id));
    const d = [...this.semantic.dims.values()].map(computation).sort((a,b)=>a.id.localeCompare(b.id));
    const r = [...this.semantic.rels.values()].map(computation).sort((a,b)=>a.id.localeCompare(b.id));
    const t = (this.tables || []).map(x => ({name:x.name,columns:x.columns,dateCol:x.dateCol,currency:x.currency})).sort((a,b)=>a.name.localeCompare(b.name));
    return fingerprint({m,d,r,t,formats:this.semantic.dateFormats,scope:this.requestScope,extra:extra||null});
  }
}

module.exports = { SemanticRegistry, PACK_FILES, mid, did, rid };
