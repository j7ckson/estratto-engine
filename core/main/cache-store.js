// ================= 第6组：计划/结果缓存 SQLite 落盘 =================
// 只存两类可复用内容：参数化计划（执行规范结构 + 绑定要求）与结果（含来源版本）。
// 键必须能区分：规范计划、数据/口径/权限/代码版本、工作区、时区/锚点。
// 读回时逐项核对；版本变化即失效（返回 null，不返回旧数字）。不存密钥/PII。
'use strict';
const crypto = require('node:crypto');

const sha = o => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const nowISO = () => new Date().toISOString();

class SqliteReuseStore {
  /**
   * @param {{dbPath?:string, db?:object, namespace?:string}} o
   *   优先用调用方的 DatabaseSync；否则用 dbPath 自己开一个（读多写少）。
   */
  constructor(o = {}) {
    this.namespace = (o.namespace || 'default') + ':reuse/2';
    if (o.db) { this.db = o.db; this.owns = false; }
    else if (o.dbPath) {
      const { DatabaseSync } = require('node:sqlite');
      // 第三轮：先设等待时间再建表——多个进程同时打开同一个库时，不等就会报「database is locked」
      this.db = new DatabaseSync(o.dbPath, { timeout: 10000 }); this.owns = true;
      try { this.db.exec('PRAGMA busy_timeout=10000'); } catch (_) {}
      try { this.db.exec('PRAGMA journal_mode=WAL'); } catch (_) {}
    }
    else throw new Error('SqliteReuseStore 需要 db 或 dbPath');
    this.db.exec(`CREATE TABLE IF NOT EXISTS reuse_plan_cache(
      ns TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
      plan_sig TEXT, semantic TEXT, code TEXT, workspace TEXT, timezone TEXT, anchor TEXT, at TEXT NOT NULL,
      PRIMARY KEY(ns, key))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS reuse_result_cache(
      ns TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
      data_stamp TEXT, semantic TEXT, permission TEXT, code TEXT, workspace TEXT, timezone TEXT, anchor TEXT, at TEXT NOT NULL,
      PRIMARY KEY(ns, key))`);
    if (!this.db.prepare('PRAGMA table_info(reuse_result_cache)').all().some(c=>c.name==='result_sig')) {
      try { this.db.exec('ALTER TABLE reuse_result_cache ADD COLUMN result_sig TEXT'); }
      catch(error){if(!this.db.prepare('PRAGMA table_info(reuse_result_cache)').all().some(c=>c.name==='result_sig'))throw error;}
    }
    // 第三轮：问法入口 / 问法模板 / 骨架也落盘（原来只在内存里，新开对话就全没了 → 跨对话复用一直是 0）
    this.db.exec(`CREATE TABLE IF NOT EXISTS reuse_kv_cache(
      ns TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
      semantic TEXT, code TEXT, workspace TEXT, permission TEXT, at TEXT NOT NULL,
      PRIMARY KEY(ns, kind, key))`);
    try { this.db.exec('PRAGMA busy_timeout=5000'); } catch (_) {}
  }
  putKV(kind, k, payload, meta = {}) {
    return this._run(`INSERT OR REPLACE INTO reuse_kv_cache(ns,kind,key,payload,semantic,code,workspace,permission,at) VALUES(?,?,?,?,?,?,?,?,?)`,
      this.namespace, kind, k, JSON.stringify(payload), meta.semantic || null, meta.code || null, meta.workspace || null, meta.permission || null, nowISO());
  }
  getKV(kind, k, current = {}) {
    const r = this._row('SELECT * FROM reuse_kv_cache WHERE ns=? AND kind=? AND key=?', this.namespace, kind, k);
    if (!r) return null;
    if (r.semantic && current.semantic && r.semantic !== current.semantic) return { invalid: 'semantic_version_changed' };
    if (r.code && current.code && r.code !== current.code) return { invalid: 'code_version_changed' };
    if (r.workspace && current.workspace && r.workspace !== current.workspace) return { invalid: 'workspace_changed' };
    if (r.permission && current.permission && r.permission !== current.permission) return { invalid: 'permission_changed' };
    return { value: this._json(r.payload) };
  }
  putSkeleton(k, value, rec = {}) { return this.putKV('skeleton', k, { value, rec }, rec); }
  getSkeleton(k, current = {}) {
    const hit = this.getKV('skeleton', k, current);
    return hit && hit.value ? Object.assign({}, hit.value.rec || {}, { value: hit.value.value }) : null;
  }
  _json(s) { try { return JSON.parse(s); } catch (_) { return null; } }
  _row(sql, ...args) { try { return this.db.prepare(sql).get(...args); } catch (_) { return null; } }
  _all(sql, ...args) { try { return this.db.prepare(sql).all(...args); } catch (_) { return []; } }
  _run(sql, ...args) { try { this.db.prepare(sql).run(...args); return true; } catch (_) { return false; } }

  putPlan(k, payload, meta = {}) {
    return this._run(`INSERT OR REPLACE INTO reuse_plan_cache(ns,key,payload,plan_sig,semantic,code,workspace,timezone,anchor,at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      this.namespace, k, JSON.stringify(payload), meta.plan_sig || null, meta.semantic || null, meta.code || null,
      meta.workspace || null, meta.timezone || null, meta.anchor || null, nowISO());
  }
  getPlan(k, current = {}) {
    const r = this._row('SELECT * FROM reuse_plan_cache WHERE ns=? AND key=?', this.namespace, k);
    if (!r) return null;
    if (r.semantic && current.semantic && r.semantic !== current.semantic) return { invalid: 'semantic_version_changed' };
    if (r.code && current.code && r.code !== current.code) return { invalid: 'code_version_changed' };
    if (r.workspace && current.workspace && r.workspace !== current.workspace) return { invalid: 'workspace_changed' };
    if (r.timezone && current.timezone && r.timezone !== current.timezone) return { invalid: 'timezone_changed' };
    if (r.anchor && current.anchor && r.anchor !== current.anchor) return { invalid: 'anchor_changed' };
    return { value: this._json(r.payload) };
  }
  putResult(k, payload, meta = {}) {
    return this._run(`INSERT OR REPLACE INTO reuse_result_cache(ns,key,payload,data_stamp,semantic,permission,code,workspace,timezone,anchor,at,result_sig) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.namespace, k, JSON.stringify(payload), meta.data || null, meta.semantic || null, meta.permission || null,
      meta.code || null, meta.workspace || null, meta.timezone || null, meta.anchor || null, nowISO(),meta.result_sig||null);
  }
  getResult(k, currentMeta = {}) {
    const r = this._row('SELECT * FROM reuse_result_cache WHERE ns=? AND key=?', this.namespace, k);
    if (!r) {
      const previous = currentMeta.result_sig && this._row('SELECT data_stamp FROM reuse_result_cache WHERE ns=? AND result_sig=? ORDER BY at DESC LIMIT 1',this.namespace,currentMeta.result_sig);
      return previous && previous.data_stamp !== (currentMeta.data||null) ? {invalid:'data_changed'} : null;
    }
    const stored = { data: r.data_stamp, semantic: r.semantic, permission: r.permission, code: r.code, workspace: r.workspace, timezone: r.timezone, anchor: r.anchor };
    if (stored.code !== (currentMeta.code || null)) return { invalid: 'code_version_changed' };
    if (stored.permission !== (currentMeta.permission || null)) return { invalid: 'permission_changed' };
    if (stored.semantic !== (currentMeta.semantic || null)) return { invalid: 'semantic_version_changed' };
    if (stored.data !== (currentMeta.data || null)) return { invalid: 'data_changed' };
    if (stored.workspace && currentMeta.workspace && stored.workspace !== currentMeta.workspace) return { invalid: 'workspace_changed' };
    if (stored.timezone && currentMeta.timezone && stored.timezone !== currentMeta.timezone) return { invalid: 'timezone_changed' };
    if (stored.anchor && currentMeta.anchor && stored.anchor !== currentMeta.anchor) return { invalid: 'anchor_changed' };
    return { value: this._json(r.payload) };
  }
  clear(kind) {
    let n = 0;
    if (kind === 'result' || kind === 'data' || kind === 'permission' || kind === 'semantic' || kind === 'code') n += this._all('SELECT key FROM reuse_result_cache WHERE ns=?', this.namespace).length, this._run('DELETE FROM reuse_result_cache WHERE ns=?', this.namespace);
    if (kind === 'plan' || kind === 'semantic') n += this._all('SELECT key FROM reuse_plan_cache WHERE ns=?', this.namespace).length, this._run('DELETE FROM reuse_plan_cache WHERE ns=?', this.namespace);
    if (kind === 'plan' || kind === 'semantic' || kind === 'code' || kind === 'permission') n += this._all('SELECT key FROM reuse_kv_cache WHERE ns=?', this.namespace).length, this._run('DELETE FROM reuse_kv_cache WHERE ns=?', this.namespace);
    return n;
  }
  count() {
    const p = this._row('SELECT COUNT(*) AS n FROM reuse_plan_cache WHERE ns=?', this.namespace);
    const r = this._row('SELECT COUNT(*) AS n FROM reuse_result_cache WHERE ns=?', this.namespace);
    return { plan: (p && p.n) || 0, result: (r && r.n) || 0 };
  }
  close() { if (this.owns) { try { this.db.close(); } catch (_) {} } }
}

module.exports = { SqliteReuseStore, sha };
