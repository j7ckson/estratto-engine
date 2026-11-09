// ================= 本机实体查找（M0.4）=================
// 复审发现的问题：B-matched 只给 12 个样例值，却要求「样例里没出现就拒答」——这是把抽样当全集，
// 至少 15 个可答题被误拒。正确做法是：值目录在本机，问「这个值存不存在」时查目录，不靠样例。
//
// 本模块只回答三种事实：
//   matched   找到唯一确定的值（附匹配方式与计数）
//   ambiguous 命中多个候选（把候选列出来，让上层决定问用户还是按范围）
//   not_found 目录是完整的，且确实没有
// 目录不完整时**不返回 not_found**，返回 unknown + 原因——「没查到」不等于「不存在」。
'use strict';

const norm = s => String(s == null ? '' : s)
  .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .toLowerCase()
  .replace(/[\s,_，]/g, '')
  .replace(/(人民币|元|美元|英镑|欧元|港币|gbp|usd|cny|rmb|eur|%|％|件|个|次|单)$/u, '');

// 保留空格/下划线容错，但ASCII实体不能从较长单词或数字中截取。
function containsMention(text, key){
  const folded=String(text).replace(/[！-～]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0)).toLowerCase();
  const body=[...key].map(c=>c.replace(/[.*+?^{}()|[\]\\$]/g,'\\$&')).join('[\\s,_，]*');
  const left=/^[a-z0-9]/i.test(key)?'(?<![a-z0-9])':'',right=/[a-z0-9]$/i.test(key)?'(?![a-z0-9])':'';
  return new RegExp(left+body+right,'i').test(folded);
}

// 只对长度 ≥4 的串做一次编辑距离（短串上模糊匹配几乎必然误配）
function editDistance(a, b){
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

class EntityLookup {
  /**
   * @param {{semantic: import('./semantic').Semantic, valueProvider?: Function, maxFuzzyDistance?: number}} o
   * valueProvider(dim) → { values: [{value, count}], complete: boolean, source?: string }
   *   complete=false 表示目录只覆盖了一部分（例如只取了前 N 个），此时不返回 not_found。
   */
  constructor(o = {}){
    this.semantic = o.semantic || null;
    this.valueProvider = o.valueProvider || null;
    this.maxFuzzyDistance = o.maxFuzzyDistance == null ? 1 : o.maxFuzzyDistance;
    this.index = new Map();       // dimId → Map(normValue → {value, count})
    this.coverage = new Map();    // dimId → {complete, size, source, loadedAt, isDate, type, kind}
    this.flags = new Map();       // dimId → {isDate, type, kind}：日期/时间维度不是实体
  }

  /**
   * 加载一个维度的值目录。可重复调用（数据变了重新加载）。
   * @param {string} dimId
   * @param {object|Array} catalog
   * @param {{isDate?:boolean, type?:string, kind?:string}} [opt]
   *   isDate/type/kind 标记「日期/时间维度」：目录可以加载（coverage 仍可查），但 resolve()/has() 不把它当实体。
   *   时间桶（month/quarter/week/year 等）由调用方决定不调用 load；即使调用，标成 kind:'time_bucket' 也会被跳过。
   */
  async load(dimId, catalog, opt = {}){
    const dim = this.semantic ? this.semantic.dim(dimId) : null;
    if (!dim) throw new Error(`没有维度：${dimId}`);
    let c = catalog;
    if (!c && this.valueProvider) c = await this.valueProvider(dim);
    if (!c) throw new Error(`维度「${dimId}」没有值目录（需要 catalog 或 valueProvider）`);
    const values = Array.isArray(c) ? c : (c.values || []);
    const complete = Array.isArray(c) ? true : c.complete !== false;
    const o = opt || {};
    const flags = {
      isDate: !!o.isDate,
      type: o.type == null ? null : String(o.type),
      kind: o.kind == null ? null : String(o.kind),
    };
    this.flags.set(dimId, flags);
    const m = new Map();
    for (const it of values) {
      const value = it && typeof it === 'object' ? it.value : it;
      const count = it && typeof it === 'object' ? it.count : null;
      if (value == null) continue;
      const k = norm(value);
      if (!k) continue;
      // 同一归一化值出现两次：保留计数并起来，避免后写覆盖前写
      const prev = m.get(k);
      m.set(k, { value: String(value), count: (prev && prev.count != null && count != null) ? prev.count + count : (count != null ? count : (prev ? prev.count : null)) });
    }
    this.index.set(dimId, m);
    this.coverage.set(dimId, { complete, size: m.size, source: (c && c.source) || 'catalog', loadedAt: new Date().toISOString(), isDate: flags.isDate, type: flags.type, kind: flags.kind });
    return this.coverage.get(dimId);
  }

  /** 该维度是否是日期/时间维度（不是实体：值是时间点/时间桶，例如 2026-09-19、2026-08）。 */
  isTemporal(dimId){
    const f = this.flags.get(dimId) || {};
    const type = String(f.type || '').toLowerCase();
    const kind = String(f.kind || '').toLowerCase();
    return !!f.isDate
      || ['date', 'datetime', 'timestamp', 'time', 'month', 'year', 'quarter', 'week', 'date_range', 'time_bucket'].includes(type)
      || ['date', 'time', 'time_bucket', 'temporal'].includes(kind);
  }

  /** 值目录里到底有没有这个值；没加载目录时返回 unknown，不猜。日期/时间维度不参与实体判定。 */
  has(dimId, value){
    if (this.isTemporal(dimId)) return { status: 'unknown', reason: 'date_dimension', dim: dimId };
    const m = this.index.get(dimId);
    if (!m) return { status: 'unknown', reason: 'index_not_loaded', dim: dimId };
    const k = norm(value);
    const hit = m.get(k);
    if (hit) return { status: 'matched', dim: dimId, value: hit.value, count: hit.count, how: 'exact' };
    const cov = this.coverage.get(dimId) || { complete: false };
    if (!cov.complete) return { status: 'unknown', reason: 'index_incomplete', dim: dimId, value: String(value), coverage: cov };
    return { status: 'not_found', dim: dimId, value: String(value), coverage: cov };
  }

  /**
   * 在一句话里找实体。dimIds 不给就查所有已加载目录。
   * 返回 {status, matches:[{dim,value,count,how,score}], candidates, coverage, why}
   */
  resolve(text, o = {}){
    const s = String(text || '');
    const normText = norm(s);
    // 日期/时间维度不是实体：2026-09-19、2026-08 这类值不参与实体匹配（否则问题里的期间会被当成实体值 → ambiguous）
    const dimIds = (o.dimIds || [...this.index.keys()]).filter(d => !this.isTemporal(d));
    const found = [];
    for (const dimId of dimIds) {
      const m = this.index.get(dimId);
      if (!m) continue;
      for (const [k, hit] of m) {
        if (!k) continue;
        let how = null, score = 0;
        if (normText === k) { how = 'exact'; score = 100; }
        else if (normText.includes(k) && k.length >= 2 && containsMention(s, k)) { how = 'contains'; score = 60 + Math.min(k.length, 20); }
        else if (k.length >= 4 && normText.split(/[，,。？?！!、\s]/).some(tok => tok.length >= 3 && editDistance(tok, k) <= this.maxFuzzyDistance)) { how = 'fuzzy'; score = 30; }
        if (how) found.push({ dim: dimId, value: hit.value, count: hit.count, how, score, len: k.length });
      }
    }
    // 同一维度里更长的命中压过更短的（「旗舰店A」不该同时命中「旗舰店」和「旗舰店A」）
    const byDim = new Map();
    for (const f of found) {
      const cur = byDim.get(f.dim);
      if (!cur) { byDim.set(f.dim, [f]); continue; }
      // 精确命中压过同长度的其它命中（否则 GRY-1005 会被 GRY-1001… 的编辑距离模糊命中拖成歧义）
      if (f.how === 'exact') { byDim.set(f.dim, [f]); continue; }
      if (cur.some(x => x.how === 'exact')) continue;
      const longer = cur[0] && f.len > cur[0].len;
      const shorter = cur[0] && f.len < cur[0].len;
      if (longer) byDim.set(f.dim, [f]);
      else if (!shorter) cur.push(f);
    }
    // 同一维度内只保留最高分的一档（exact>contains>fuzzy），低分候选不算歧义
    for (const [dim, list] of byDim) {
      const best = Math.max(...list.map(x => x.score));
      byDim.set(dim, list.filter(x => x.score === best));
    }
    const perDim = [...byDim.entries()].map(([dim, list]) => ({ dim, list: list.sort((a, b) => b.score - a.score || (b.count || 0) - (a.count || 0)) }));
    const cov = Object.fromEntries([...this.index.keys()].map(d => [d, this.coverage.get(d)]));
    if (!dimIds.length) return { status: 'unknown', reason: 'no_entity_dimension', coverage: cov, matches: [] };
    if (!perDim.length) {
      const incomplete = dimIds.filter(d => (this.coverage.get(d) || {}).complete === false);
      if (incomplete.length) return { status: 'unknown', reason: 'index_incomplete', dims: incomplete, coverage: cov, matches: [] };
      return { status: 'not_found', matches: [], coverage: cov };
    }
    const exact = perDim.filter(p => p.list.length === 1 && p.list[0].how === 'exact');
    const matched = perDim.filter(p => p.list.length === 1);
    if (matched.length === 1 && perDim.length === 1) {
      const m = matched[0];
      return { status: 'matched', dim: m.dim, value: m.list[0].value, count: m.list[0].count, how: m.list[0].how, coverage: cov, matches: [m.list[0]] };
    }
    // 多维度命中同一个词，或者同一维度多个候选：都算歧义，交给上层问一句，不赌
    return {
      status: 'ambiguous', coverage: cov,
      candidates: perDim.map(p => ({ dim: p.dim, options: p.list.slice(0, 8).map(x => ({ value: x.value, count: x.count, how: x.how })) })),
      matches: perDim.flatMap(p => p.list.slice(0, 8)),
      why: perDim.length > 1 ? '同一句话命中多个维度' : '同一维度里有多个候选',
      exact_dim: exact.length === 1 ? exact[0].dim : null,
    };
  }

  /** 给上层/报告用的一句话结论：不把「样例里没有」说成「不存在」。 */
  describe(dimId){
    const cov = this.coverage.get(dimId);
    if (!cov) return '目录未加载';
    if (this.isTemporal(dimId)) return `日期/时间维度（kind=${cov.kind || cov.type || 'date'}，${cov.size} 个值），不参与实体匹配`;
    return `目录${cov.complete ? '完整' : '不完整（只有一部分，不能据此判定「不存在」）'}，共 ${cov.size} 个值，来源 ${cov.source}`;
  }
}

module.exports = { EntityLookup, norm };
