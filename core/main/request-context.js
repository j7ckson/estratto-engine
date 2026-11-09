'use strict';
const crypto = require('node:crypto');
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
const fingerprint = x => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
const copy = x => JSON.parse(JSON.stringify(x));
// 客户端只能缩小范围；空数组表示没有可用表。
function intersectScope(trusted = {}, requested = {}) {
  const out = Object.assign({}, trusted);
  if (Array.isArray(trusted.datasets)) out.datasets = trusted.datasets.filter(t => !Array.isArray(requested.datasets) || requested.datasets.includes(t));
  else if (Array.isArray(requested.datasets)) out.datasets = requested.datasets.slice();
  const columns = {};
  for (const t of new Set([...Object.keys(trusted.columns || {}), ...Object.keys(requested.columns || {})])) {
    const a = trusted.columns && trusted.columns[t], b = requested.columns && requested.columns[t];
    columns[t] = Array.isArray(a) ? a.filter(c => !Array.isArray(b) || b.includes(c)) : b.slice();
  }
  if (Object.keys(columns).length) out.columns = columns;
  return out;
}
function scopedRegistry(registry, scope = {}) {
  if (!registry || !registry.semantic) return registry;
  const r = Object.create(registry), sem = Object.create(registry.semantic);
  const tables = Array.isArray(scope.datasets) ? new Set(scope.datasets) : null;
  const allow = (t, c) => (!tables || tables.has(t)) && (!scope.columns || !Array.isArray(scope.columns[t]) || c == null || scope.columns[t].includes(c));
  r.tables = copy((registry.tables || []).filter(t => allow(t.name)).map(t => Object.assign({}, t, { columns: (t.columns || []).filter(c => allow(t.name, c.name)) })));
  sem.metrics = new Map([...registry.semantic.metrics].filter(([id, m]) => {
    try { return registry.semantic.leaves(id).every(k => { const l = registry.semantic.metrics.get(String(k).replace(/^m:/, '')); return l && allow(l.dataset || l.boundTo, l.field); }); } catch (_) { return false; }
  }).map(([k,v]) => [k,copy(v)]));
  sem.dims = new Map([...registry.semantic.dims].filter(([,d]) => d.source ? allow(d.source.table,d.source.field) : allow(d.dataset)).map(([k,v])=>[k,copy(v)]));
  sem.rels = new Map([...registry.semantic.rels].filter(([,v])=>allow(v.left)&&allow(v.right)&&(v.pairs||[]).every(p=>allow(v.left,p[0])&&allow(v.right,p[1]))).map(([k,v])=>[k,copy(v)]));
  for (const key of ['datasets','grains']) if (registry.semantic[key] instanceof Map) sem[key] = new Map([...registry.semantic[key]].filter(([t])=>allow(t)).map(([k,v])=>[k,copy(v)]));
  r.semantic = sem;
  r.packDefs = copy(registry.packDefs || []);
  r.requestScope = copy(scope);
  // P79d:裁剪要幂等——第二次裁剪时 registry.tables 已经是裁过的,只按它算会把第一次的禁止列弄丢(Codex 端到端复现:未限定列/CTE 可读禁止列)。
  // 禁止列始终按最初的完整表结构计算,并与上一次的禁止列取并集;完整表结构只留在本机对象上,不进提示词。
  const base = registry.baseTables || registry.tables || [];
  r.baseTables = base;
  const denied = new Map();
  for (const x of registry.deniedColumns || []) denied.set(x.table + '\u0000' + x.col, x);
  for (const t of base) for (const c of (t.columns || [])) if (!allow(t.name, c.name)) denied.set(t.name + '\u0000' + c.name, { table: t.name, col: c.name });
  r.deniedColumns = [...denied.values()];
  return r;
}
function assertCurrent(o) {
  if (o?.snapshot?.mutationInProgress) throw Object.assign(new Error('表格正在更新，请稍后重试'),{code:'data_changing'});
  if (o && o.signal && o.signal.aborted) throw Object.assign(new Error('请求已取消'), { code: 'cancelled' });
  if (o && typeof o.isCurrent === 'function' && !o.isCurrent()) throw Object.assign(new Error('工作区、权限或数据版本已变化，请重试'), { code: 'stale_request' });
}
// 自检证明绑定实际运行代码和用户目录，同一版本号的重装也不能沿用旧证明。
function isolationProof(appDir, context) {
  const fs = require('node:fs'), path = require('node:path');
  const files = ['main/main.js','main/workers.js','main/ask-service.js','main/request-context.js','worker/engine.js','broker/broker.js'];
  return fingerprint({ context, files: files.map(file => {
    try { return [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(appDir,file))).digest('hex')]; }
    catch (_) { return [file, 'missing']; }
  }) });
}
module.exports = { isolationProof, fingerprint, stable, intersectScope, scopedRegistry, assertCurrent };
