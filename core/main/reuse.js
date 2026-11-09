// ================= 分层复用与失效（M3）=================
// 复审把「复用」拆成六层，因为它们的失效条件完全不同：
//   入口候选索引（问法 → 候选方法）→ 参数化计划 → 物理计划 → 聚合/事实 → 展示模板 → 前缀缓存
// 一个 L1 键（IR hash）管不住入口：自然语言还没被理解时没有 IR。所以入口层单独存在。
//
// 结果键必须覆盖：完整过滤 / 否定 / 实体 / 期间 / 时间角色 / 时区 / 比较 / 并列策略 / 公式 / 单位 /
// 工作区与授权范围 / 依赖的数据版本与语义版本。`intent+metric+dim+period` 不能安全标识结果。
'use strict';
const crypto = require('node:crypto');

const LAYERS = ['entry', 'plan', 'physical', 'result', 'presentation', 'prefix'];
const nowISO = () => new Date().toISOString();
const sha = o => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

const sortObj = v => Array.isArray(v) ? v.map(sortObj)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortObj(v[k])])) : v;

class ReuseCache {
  /**
   * @param {{codeVersion?:string, maxEntries?:number, now?:Function}} o
   */
  constructor(o = {}){
    this.codeVersion = o.codeVersion || 'compute/2';
    this.now = o.now || nowISO;
    this.max = o.maxEntries || 5000;
    // 可选持久化：SqliteReuseStore（计划/结果两层）。不传时完全保持内存模式。
    this.persist = o.store || null;
    this.store = { entry: new Map(), plan: new Map(), physical: new Map(), result: new Map(), presentation: new Map(), prefix: new Map(), skeleton: new Map() };
    this.skelList = [];                            // 骨架复用/相似例题（内存，最近 2000 条）
    this.stats = Object.fromEntries(LAYERS.map(l => [l, { hit: 0, miss: 0, invalidated: 0 }]));
    this.reasons = [];
    this.versions = { data: null, semantic: null, permission: o.permissionVersion || 'perm/1', code: this.codeVersion };
  }

  _note(layer, ok, reason){
    this.stats[layer][ok ? 'hit' : 'miss']++;
    if (!ok && reason) this.reasons.push({ layer, reason, at: this.now() });
    if (this.reasons.length > 2000) this.reasons = this.reasons.slice(-1000);
  }

  /* ---------- 键 ---------- */
  /** 入口层：问法归一化（去掉空白/标点/大小写），不带业务参数 */
  static entryKey(question, scope = {}){
    const q = String(question || '').toLowerCase().replace(/[\s，,。？?！!、；;：:"'「」『』（）()]/g, '');
    return sha({ schema:'reuse/2', q, scope });
  }
  /** 计划层：用计划的内容（含时间角色/公式/维度），不含具体起止日期（那是参数） */
  static planKey(plan){
    return sha(sortObj({
      schema: 'reuse/2', metric_ids: plan.metric_ids, dimensions: plan.dimensions,
      entities_dims: plan.entities.map(e => e.dim), negations: plan.negations.map(n => n.text || n),
      filters_dims: (plan.filters || []).map(f => f.field),
      comparison: plan.comparison && {kind: plan.comparison.kind, output: plan.comparison.kind === 'none' ? null : plan.comparison.output || 'delta'}, grain: plan.grain,
      cumulative: !!plan.cumulative, having: plan.having || null, indicator: plan.indicator || null,
      rank: plan.rank, formula: plan.formula, unit: plan.unit,
      time_role: plan.time && plan.time.role, timezone: plan.time && plan.time.timezone,
      output_shape: plan.output_shape,
    }));
  }
  /** 物理计划层：编译产物 + 依赖的 schema/执行器版本 */
  static physicalKey(plan, ctx = {}){
    return sha(sortObj({ plan: ReuseCache.planKey(plan), schema: ctx.schemaStamp || null, executor: ctx.executorVersion || 'local/1' }));
  }
  /**
   * 结果层：完整条件。少一个字段就可能把「9月上海」的答案拿去回答「10月北京」。
   */
  static resultKey(plan, ctx = {}){
    return sha(sortObj({
      plan: ReuseCache.planKey(plan),
      time: {
        role: plan.time && plan.time.role, start: plan.time && plan.time.start,
        endExclusive: plan.time && (plan.time.endExclusive || plan.time.end),
        tz: plan.time && plan.time.timezone, anchor: plan.time && plan.time.anchor,
        interval: (plan.time && plan.time.interval) || (plan.time && plan.time.endExclusive ? '[start,endExclusive)' : 'legacy'),
      },
      entities: plan.entities.map(e => [e.dim, String(e.value)]).sort(),
      filters: (plan.filters || []).map(f => [f.field, [...(f.values || [])].map(String).sort()]).sort(),
      negations: plan.negations.map(n => String(n.value == null ? (n.text || '') : n.value)).sort(),
      comparison: plan.comparison && {kind:plan.comparison.kind,output:plan.comparison.kind === 'none' ? null : plan.comparison.output||'delta',base:plan.comparison.base||null},
      data: ctx.dataStamp || null,
      tie_policy: plan.rank && plan.rank.ties,
      rank_top: plan.rank && plan.rank.top, rank_dir: plan.rank && plan.rank.direction,
      formula: plan.formula, unit: plan.unit,
      workspace: plan.permission_scope && plan.permission_scope.workspace,
      scope_datasets: (plan.permission_scope && plan.permission_scope.datasets) || null,
      permission: ctx.permissionVersion || 'perm/1',
      datasets: ctx.datasetStamps || null,
      semantic: ctx.semanticStamp || null,
      code: ctx.codeVersion || 'compute/1',
    }));
  }

  /* ---------- 入口候选索引 ---------- */
  putEntry(question, value, scope, meta = {}){
    const k = ReuseCache.entryKey(question, scope);
    this.store.entry.set(k, { value, at: this.now(), validated: false });
    if (this.persist && typeof this.persist.putKV === 'function') { try { this.persist.putKV('entry', k, value, meta); } catch (_) {} }
    return k;
  }
  getEntry(question, scope, current = {}){
    const k = ReuseCache.entryKey(question, scope);
    let e = this.store.entry.get(k);
    if (!e && this.persist && typeof this.persist.getKV === 'function') {
      try { const hit = this.persist.getKV('entry', k, current); if (hit && hit.value) e = { value: hit.value }; } catch (_) {}
    }
    if (!e) { this._note('entry', false, 'no_candidate'); return null; }
    this._note('entry', true);
    return e.value;      // 只是候选：调用方必须自己验证槽位完整
  }

  /* ---------- 问法模板层（第三轮）：同一句话只换了日期 / 具体对象（渠道、品类、SKU…）→ 复用已验证计划，参数重绑 ---------- */
  static templateKey(template, scope = {}){ return sha({ schema:'reuse/2', t: String(template || ''), scope }); }
  putTemplate(template, value, scope, meta = {}){
    if (!template) return null;
    const k = ReuseCache.templateKey(template, scope);
    const rec = { value, template, at: this.now(), semantic: meta.semantic || null, code: meta.code || this.codeVersion, workspace: (scope && scope.workspace) || 'local', permission: meta.permission || this.versions.permission };
    this.store.template = this.store.template || new Map();
    this.store.template.set(k, rec);
    if (this.persist && typeof this.persist.putKV === 'function') { try { this.persist.putKV('template', k, value, rec); } catch (_) {} }
    return k;
  }
  getTemplate(template, scope, current = {}){
    if (!template) return null;
    const k = ReuseCache.templateKey(template, scope);
    this.store.template = this.store.template || new Map();
    let rec = this.store.template.get(k) || null;
    if (rec && current.semantic && rec.semantic && rec.semantic !== current.semantic) rec = null;
    if (rec && current.code && rec.code !== current.code) rec = null;
    if (rec && current.permission && rec.permission !== current.permission) rec = null;
    if (!rec && this.persist && typeof this.persist.getKV === 'function') {
      try { const hit = this.persist.getKV('template', k, current); if (hit && hit.value) rec = { value: hit.value }; } catch (_) {}
    }
    if (!rec) { this._note('entry', false, 'no_template'); return null; }
    this._note('entry', true);
    return rec.value;
  }

  /* ---------- 骨架层（T8：改写重问按「指标/维度/实体/期间角色/条件」骨架复用） ---------- */
  static skeletonKey(skel){ return sha(sortObj(skel || {})); }
  /**
   * 存一条已验证的骨架 → 计划候选（参数不存进键：期间/实体值由 matchConfirmedPlan 重绑）。
   * meta 记口径/代码/工作区/权限版本：任何一项变了条目作废。
   */
  putSkeleton(skel, value, meta = {}){
    if (!skel) return null;
    const k = ReuseCache.skeletonKey(skel);
    const rec = { skel, value, question: meta.question || '', at: this.now(),
      semantic: meta.semantic || this.versions.semantic, code: meta.code || this.codeVersion,
      workspace: meta.workspace || 'local', permission: meta.permission || this.versions.permission };
    this.store.skeleton.set(k, rec);
    this.skelList.push(rec);
    if (this.skelList.length > 2000) this.skelList = this.skelList.slice(-2000);
    if (this.persist && typeof this.persist.putSkeleton === 'function') { try { this.persist.putSkeleton(k, value, rec); } catch (_) {} }
    return k;
  }
  getSkeleton(skel, current = {}){
    if (!skel) return null;
    const k = ReuseCache.skeletonKey(skel);
    let rec = this.store.skeleton.get(k) || null;
    if (!rec && this.persist && typeof this.persist.getSkeleton === 'function') {
      try { const hit = this.persist.getSkeleton(k, current); if (hit && hit.value) rec = hit; } catch (_) {}
    }
    const why = this.checkSkeleton(rec, current);
    if (why) { this._note('entry', false, 'skeleton_' + why); return null; }
    return rec ? rec.value : null;
  }
  checkSkeleton(rec, current){
    if (!rec) return 'no_skeleton';
    const cur = current || {};
    if (rec.semantic !== (cur.semantic || this.versions.semantic)) return 'semantic_version_changed';
    if (rec.code !== (cur.code || this.codeVersion)) return 'code_version_changed';
    if (rec.workspace !== (cur.workspace || 'local')) return 'workspace_changed';
    if (rec.permission !== (cur.permission || this.versions.permission)) return 'permission_changed';
    return null;
  }
  /** 相似例题（参考用，不直接当答案）：同一主题内按字符二元组 Jaccard 取 0–2 条 */
  similarEntries(question, { metric = null, limit = 2, threshold = 0.6 } = {}){
    const bigrams = t => { const s = String(t || '').replace(/[\s\p{P}]/gu, ''); const out = new Set(); for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2)); return out; };
    const qa = bigrams(question);
    if (!qa.size) return [];
    const scored = [];
    for (const rec of this.skelList) {
      if (!rec || !rec.value) continue;
      if (metric && rec.skel && rec.skel.metric !== metric) continue;
      if (this.checkSkeleton(rec, { semantic: this.versions.semantic, code: this.codeVersion, workspace: 'local', permission: this.versions.permission })) continue;
      const rb = bigrams(rec.question);
      if (!rb.size) continue;
      let inter = 0; for (const x of qa) if (rb.has(x)) inter++;
      const sim = inter / (qa.size + rb.size - inter);
      if (sim >= threshold) scored.push({ sim, rec });
    }
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, limit).map(x => ({ sim: Math.round(x.sim * 1000) / 1000, question: x.rec.question, value: x.rec.value, skel: x.rec.skel }));
  }

  /* ---------- 计划层 ---------- */
  _persistMeta(plan){
    const t = (plan && plan.time) || {};
    return {
      plan_sig: ReuseCache.planKey(plan), semantic: this.versions.semantic, code: this.codeVersion,
      workspace: (plan && plan.permission_scope && plan.permission_scope.workspace) || 'local',
      timezone: t.timezone || null, anchor: t.anchor || null,
    };
  }
  putPlan(plan, value){
    const k = ReuseCache.planKey(plan);
    this.store.plan.set(k, { value, semantic: this.versions.semantic, at: this.now() });
    if (this.persist) { try { this.persist.putPlan(k, value, this._persistMeta(plan)); } catch (_) {} }
    return k;
  }
  getPlan(plan){
    const k = ReuseCache.planKey(plan), e = this.store.plan.get(k);
    if (e) {
      if (e.semantic !== this.versions.semantic) { this._note('plan', false, 'semantic_version_changed'); return null; }
      this._note('plan', true);
      return e.value;
    }
    // 持久层回填（重启后仍可读计划，但绑定要求仍要重新校验）
    if (this.persist) {
      let hit = null;
      try { hit = this.persist.getPlan(k, this._persistMeta(plan)); } catch (_) {}
      if (hit && hit.invalid) { this._note('plan', false, hit.invalid); return null; }
      if (hit && hit.value) {
        this.store.plan.set(k, { value: hit.value, semantic: this.versions.semantic, at: this.now() });
        this._note('plan', true);
        return hit.value;
      }
    }
    this._note('plan', false, 'no_plan');
    return null;
  }

  /* ---------- 物理计划层 ---------- */
  putPhysical(plan, ctx, value){
    const k = ReuseCache.physicalKey(plan, ctx);
    this.store.physical.set(k, { value, schema: ctx.schemaStamp || null, executor: ctx.executorVersion || 'local/1', at: this.now() });
    return k;
  }
  getPhysical(plan, ctx){
    const k = ReuseCache.physicalKey(plan, ctx), e = this.store.physical.get(k);
    if (!e) { this._note('physical', false, 'no_compiled'); return null; }
    this._note('physical', true);
    return e.value;
  }

  /* ---------- 结果层 ---------- */
  _resultPersistMeta(plan, ctx){
    const m = this._meta(plan, ctx);
    return { data: m.data, semantic: m.semantic, permission: m.permission, code: m.code,
      result_sig: ReuseCache.resultKey(plan,Object.assign({},ctx,{dataStamp:null,datasetStamps:null})),
      workspace: (plan.permission_scope && plan.permission_scope.workspace) || 'local',
      timezone: plan.time && plan.time.timezone, anchor: plan.time && plan.time.anchor };
  }
  putResult(plan, ctx, value){
    const k = ReuseCache.resultKey(plan, ctx);
    this.store.result.set(k, { value, meta: this._meta(plan, ctx), at: this.now() });
    if (this.persist) { try { this.persist.putResult(k, value, this._resultPersistMeta(plan, ctx)); } catch (_) {} }
    return k;
  }
  getResult(plan, ctx){
    const k = ReuseCache.resultKey(plan, ctx), e = this.store.result.get(k);
    if (e) {
      // 命中前再核一遍：数据/口径/权限/代码任何一项变了都不读
      const why = this.checkResult(e.meta, this._meta(plan, ctx));
      if (why) { this._note('result', false, why); return null; }
      this._note('result', true);
      return e.value;
    }
    if (this.persist) {
      let hit = null;
      try { hit = this.persist.getResult(k, this._resultPersistMeta(plan, ctx)); } catch (_) {}
      if (hit && hit.invalid) { this._note('result', false, hit.invalid); return null; }
      if (hit && hit.value) {
        this.store.result.set(k, { value: hit.value, meta: this._meta(plan, ctx), at: this.now() });
        this._note('result', true);
        return hit.value;
      }
    }
    this._note('result', false, 'no_result');
    return null;
  }
  _meta(plan, ctx){
    return {
      data: ctx.dataStamp || this.versions.data,
      semantic: ctx.semanticStamp || this.versions.semantic,
      permission: ctx.permissionVersion || this.versions.permission,
      code: ctx.codeVersion || this.codeVersion,
      datasetStamps: ctx.datasetStamps || null,
      timeRole: plan.time && plan.time.role,
    };
  }
  /** 返回 null = 可读；否则是失效原因（单词，可直接进 trace） */
  checkResult(stored, current){
    if (!stored) return 'no_meta';
    if (stored.code !== current.code) return 'code_version_changed';
    if (stored.permission !== current.permission) return 'permission_changed';
    if (stored.semantic !== current.semantic) return 'semantic_version_changed';
    if (JSON.stringify(stored.datasetStamps) !== JSON.stringify(current.datasetStamps)) return 'data_changed';
    if (stored.data !== current.data) return 'data_changed';
    return null;
  }

  /* ---------- 展示模板层 ---------- */
  putPresentation(key, tpl){ this.store.presentation.set(key, { tpl, at: this.now() }); }
  getPresentation(key){
    const e = this.store.presentation.get(key);
    this._note('presentation', !!e, e ? null : 'no_template');
    return e ? e.tpl : null;      // 模板里不能带旧数字：渲染时必须绑当前事实编号
  }

  /* ---------- 前缀缓存（只降前缀成本） ---------- */
  putPrefix(prefixKey, meta){ this.store.prefix.set(prefixKey, { ...meta, at: this.now() }); }
  getPrefix(prefixKey){
    const e = this.store.prefix.get(prefixKey);
    this._note('prefix', !!e, e ? null : 'no_prefix');
    return e || null;
  }

  /* ---------- 失效 ---------- */
  /**
   * 按变化类型失效。返回被清掉的条目数。
   * kind: data | schema | semantic | permission | code | period
   */
  invalidate(kind, o = {}){
    let n = 0;
    if (this.persist) { try { n += this.persist.clear(kind); } catch (_) {} }
    if (kind === 'data') {
      // 普通事实刷新：计划保留，结果作废（重算即可）
      this.versions.data = o.stamp || this.now();
      n += this.store.result.size; this.store.result.clear();
      n += this.store.presentation.size; this.store.presentation.clear();   // 模板可留，但里面绑的是旧事实
    } else if (kind === 'schema') {
      // 字段改名/类型变化：物理计划与结果都要重绑，参数化计划保留
      this.versions.data = o.stamp || this.now();
      n += this.store.physical.size; this.store.physical.clear();
      n += this.store.result.size; this.store.result.clear();
    } else if (kind === 'semantic') {
      // 指标口径变化：依赖它的计划 / 物理计划 / 结果全部失效
      this.versions.semantic = o.stamp || this.now();
      n += this.store.plan.size; this.store.plan.clear();
      n += this.store.physical.size; this.store.physical.clear();
      n += this.store.result.size; this.store.result.clear();
      n += this.store.presentation.size; this.store.presentation.clear();
    } else if (kind === 'permission') {
      // 权限撤回：先挡住访问；缓存不得绕过 Gate
      this.versions.permission = o.stamp || ('perm/' + this.now());
      n += this.store.entry.size; this.store.entry.clear();
      n += this.store.result.size; this.store.result.clear();
    } else if (kind === 'code') {
      this.versions.code = o.version || this.codeVersion;
      n += this.store.physical.size; this.store.physical.clear();
      n += this.store.result.size; this.store.result.clear();
    } else if (kind === 'period') {
      // 「本月 / 最近7天」按最新数据日期重解析：只清结果，不动计划
      n += this.store.result.size; this.store.result.clear();
    }
    return n;
  }

  /** 复用诊断：每层命中，分开报告；不合并成一个「命中率」 */
  report(){
    const max = this.max;
    return {
      layers: Object.fromEntries(LAYERS.map(l => [l, { ...this.stats[l], size: this.store[l].size }])),
      versions: { ...this.versions },
      invalidation_reasons: this.reasons.slice(-50),
      oversize: Object.fromEntries(LAYERS.filter(l => this.store[l].size > max).map(l => [l, this.store[l].size])),
    };
  }
}

module.exports = { ReuseCache, LAYERS };
