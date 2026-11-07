// ================= 补丁确认服务（M2 接线：确认 API + 热加载）=================
// PatchStore 负责"补丁是什么/怎么落盘"；这个模块负责"谁来确认、确认后什么时候生效"。
//
// 三条硬要求：
//   1) 确认/驳回/撤销都要有人（或明确策略）作为来源，并记录 decided_by / evidence / at / map_version / patch_id；
//   2) 确认后立刻重新加载语义包（不需要重启 App）——同一进程里通过 onReload 通知上层清缓存；
//   3) 别人（CLI）在磁盘上改了补丁，下一次调用 ensureFresh() 能发现并热加载。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PatchStore, PatchError } = require('./semantic-patch');
const { SemanticRegistry } = require('./semantic-registry');

const fingerprint = dir => {
  const parts = [];
  try { const s = fs.statSync(path.join(dir, 'patches.json')); parts.push(['p', s.mtimeMs, s.size]); } catch (_) { parts.push(['p', 0, 0]); }
  const gen = path.join(dir, 'generated');
  try {
    for (const f of fs.readdirSync(gen).sort()) {
      const s = fs.statSync(path.join(gen, f));
      parts.push([f, s.mtimeMs, s.size]);
    }
  } catch (_) {}
  return JSON.stringify(parts);
};

class PatchService {
  /**
   * @param {{dir:string, tables?:Function|Array, onReload?:Function, now?:Function}} o
   */
  constructor(o = {}){
    if (!o.dir) throw new Error('PatchService 需要 dir');
    this.dir = o.dir;
    this.tablesProvider = typeof o.tables === 'function' ? o.tables : () => (o.tables || []);
    this.onReload = o.onReload || null;
    this.now = o.now || (() => new Date().toISOString());
    this.store = new PatchStore({ dir: this.dir, tables: this.tablesProvider(), now: this.now });
    this._registry = null;
    this._fp = fingerprint(this.dir);
    this._tablesFp = JSON.stringify(this.tables());
    this.reloads = [];
  }

  tables(){ return this.tablesProvider() || []; }
  packsDir(){ return path.join(this.dir, 'generated'); }

  /** 当前注册表（含生成的包）。第一次调用时构建。 */
  registry(){
    if (!this._registry) {
      try { this._registry = SemanticRegistry.load({ tables: this.tables(), generatedDir: this.packsDir() }); }
      catch (err) {
        // 工作区还没导入数据 / 没有能绑定的表：CLI 仍然要能 list 和确认，所以返回一个「带错误的空注册表」
        this._registry = { error: String(err && err.message || err), generated: [], generatedErrors: [{ error: String(err && err.message || err) }], aliasApplied: [], aliasSkipped: [], semantic: null };
      }
    }
    return this._registry;
  }

  /** 别人改了磁盘上的补丁：发现变化就重新读 store + 重建注册表，并通知上层清缓存。 */
  ensureFresh(){
    const fp = fingerprint(this.dir);
    const tfp = JSON.stringify(this.tables());
    if (fp === this._fp && tfp === this._tablesFp) return false;
    this._fp = fp; this._tablesFp = tfp;
    this.store = new PatchStore({ dir: this.dir, tables: this.tables(), now: this.now });
    this._reload('external_change');
    return true;
  }

  _reload(reason){
    try { this._registry = SemanticRegistry.load({ tables: this.tables(), generatedDir: this.packsDir() }); }
    catch (err) { this._registry = { error: String(err && err.message || err), generated: [], generatedErrors: [{ error: String(err && err.message || err) }], aliasApplied: [], aliasSkipped: [], semantic: null }; }
    this.reloads.push({ at: this.now(), reason, map_version: this.store.mapVersion, packs: this._registry.generated.length });
    try { if (this.onReload) this.onReload({ reason, map_version: this.store.mapVersion, registry: this._registry }); } catch (_) {}
    return this._registry;
  }
  _after(kind){
    this._fp = fingerprint(this.dir);
    this._tablesFp = JSON.stringify(this.tables());
    this._reload(kind);
    return this.store;
  }

  /* ---------- 确认 API ---------- */
  snapshot(){
    const reg = this.registry();
    return Object.assign(this.store.snapshot(), {
      packs_dir: this.packsDir(),
      registry_error: reg.error || null,
      generated: (reg.generated || []).map(g => ({ id: g.id, name: g.name, version: (g.meta && g.meta.version) || 1, map_version: (g.meta && g.meta.map_version) || null, metrics: (g.counts && g.counts.metrics) || 0, dims: (g.counts && g.counts.dims) || 0, relationships: (g.counts && g.counts.relationships) || 0, aliases: (g.counts && g.counts.aliases) || 0 })),
      alias_applied: reg.aliasApplied || [], alias_skipped: reg.aliasSkipped || [],
    });
  }
  confirm(id, o = {}){
    const rec = this.store.confirm(id, o);
    this._after('confirm');
    return rec;
  }
  reject(id, o = {}){
    const rec = this.store.reject(id, o);
    this._after('reject');
    return rec;
  }
  revert(id, o = {}){
    const r = this.store.revert(id, o);
    this._after('revert');
    return r;
  }
  propose(patch){ const rec = this.store.propose(patch); this._after('propose'); return rec; }
  verifyRelation(id, o = {}){ const v = this.store.verifyRelation(id, Object.assign({ tables: this.tables() }, o)); this._after('verify'); return v; }
  decide(o){ const d = this.store.decide(o); this._after('decide'); return d; }
  freeze(o){ const f = this.store.freeze(o); this._after('freeze'); return f; }
  unfreeze(o){ const f = this.store.unfreeze(o); this._after('unfreeze'); return f; }

  /** 本次会话里发生过哪些热加载（测试/诊断用） */
  reloadLog(){ return this.reloads.slice(); }
}

/** 用只读 worker 实测「这一组键在表里是否唯一」（复合键按整组比）。CLI / 确认 API 用。 */
async function measureUniqueness({ ws, appDir, table, fields }){
  const pathm = require('node:path');
  const { Rpc } = require('./workers');
  const worker = new Rpc('worker', pathm.join(appDir || pathm.join(__dirname, '..'), 'worker', 'engine.js'), { ws, appDir: appDir || pathm.join(__dirname, '..'), profile: 'worker' });
  try {
    const res = await worker.call('countGroups', { table: { id: table.id, columns: table.columns }, fields, limit: 5 }, 120000);
    return { unique: res.duplicates === 0, duplicates: res.duplicates, rows: res.rows && res.rows[0] ? res.rows[0].n : null, source: 'worker.countGroups' };
  } finally {
    try { if (worker.proc) worker.proc.kill(); } catch (_) {}
  }
}

/** 从工作区 state.db 只读读出表结构（CLI 用；不启动 App 也能校验关系） */
function tablesFromState(ws){
  const { DatabaseSync } = require('node:sqlite');
  const f = path.join(ws, 'state.db');
  if (!fs.existsSync(f)) return [];
  const db = new DatabaseSync(f, { readOnly: true });
  try {
    const rows = db.prepare("SELECT * FROM tables WHERE state = 'active' ORDER BY name").all();
    return rows.map(t => ({
      id: t.id, name: t.name, dateCol: t.date_col, currency:t.currency||null, revision:t.revision??null,
      columns: JSON.parse(t.columns || '[]').filter(c => !c.empty),
      stats: JSON.parse(t.stats || '{}'),
    }));
  } finally { db.close(); }
}

module.exports = { PatchService, PatchError, tablesFromState, fingerprint, measureUniqueness };
