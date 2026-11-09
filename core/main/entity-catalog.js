// ================= 实体目录：从本机 distinct 加载（M0.4 接线）=================
// 复审的反例：B-matched 只给 12 个值当"全集"，样例里没有就拒答。
// 这里把"值目录"真正接到本机数据上：全量 distinct + 完整性标记，交给 EntityLookup 判定
// matched / ambiguous / not_found / unknown。**目录不完整时永远不返回 not_found。**
'use strict';
const { EntityLookup } = require('./entity-lookup');

const DEFAULT_LIMIT = 50000;

/**
 * 从 worker 的 distinct 读一个维度的值目录。
 * 优先 distinctAll（完整目录）；老 worker 只有 distinct（最多 200 条），那就标 complete=false，
 * 除非导入画像里的 distinct 数 <= 返回条数（这时可以确定拿全了）。
 * @returns {Promise<{values:Array<{value,count}>, complete:boolean, source:string, scanned:number}>}
 */
async function workerCatalog({ worker, table, dim, limit = DEFAULT_LIMIT, timeoutMs = 120000 }){
  if (!worker) throw new Error('需要 worker');
  const field = dim.source && dim.source.field;
  if (!field) throw new Error(`维度「${dim.id}」还没有绑定列`);
  const args = { table: { id: table.id, columns: table.columns }, field, limit };
  try {
    const r = await worker.call('distinctAll', args, timeoutMs);
    if (r && Array.isArray(r.rows)) {
      return { values: r.rows.map(x => ({ value: x.v, count: x.n == null ? null : Number(x.n) })), complete: r.complete !== false, source: 'worker.distinctAll', scanned: r.rows.length };
    }
  } catch (_) { /* 老 worker 没有这个 op：退回 distinct */ }
  const rows = await worker.call('distinct', args, timeoutMs);
  const list = (rows || []).map(x => ({ value: x.v, count: x.n == null ? null : Number(x.n) }));
  const expected = table.stats && table.stats.cols && table.stats.cols[field] ? Number(table.stats.cols[field].distinct) : null;
  const complete = expected != null && Number.isFinite(expected) ? list.length >= expected : false;
  return { values: list, complete, source: complete ? 'worker.distinct(full-by-profile)' : 'worker.distinct(capped-200)', scanned: list.length };
}

/** SQLite 直连版（评测侧 B-matched 用；同样是全量 distinct + 完整性标记） */
function sqliteCatalog({ db, table, field, limit = 200000 }){
  const qi = s => '"' + String(s).replace(/"/g, '""') + '"';
  const cap = Math.max(1, Math.min(Number(limit) || 200000, 500000));
  const rows = db.prepare(`SELECT CAST(${qi(field)} AS TEXT) AS v, COUNT(*) AS n FROM ${qi(table)} WHERE ${qi(field)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT ${cap + 1}`).all();
  const complete = rows.length <= cap;
  return { values: rows.slice(0, cap).map(r => ({ value: r.v, count: Number(r.n) })), complete, source: complete ? 'sqlite.distinct(full)' : 'sqlite.distinct(capped)', scanned: Math.min(rows.length, cap) };
}

/**
 * 给一张表的所有可分组维度建目录，返回 EntityLookup。
 * @param {{semantic, tables, worker, dimIds?, limit?}} o
 */
async function buildLookup(o = {}){
  const { semantic, tables, worker, limit } = o;
  if (!semantic) throw new Error('需要 semantic');
  const lookup = new EntityLookup({ semantic });
  const dims = (o.dimIds && o.dimIds.length)
    ? o.dimIds.map(id => semantic.dim(String(id).replace(/^d:/, '')))
    : [...semantic.dims.values()].filter(d => !d.unbound && d.source && d.kind === 'column');
  const catalogs = {};
  for (const d of dims) {
    const table = (tables || []).find(t => t.name === d.source.table);
    if (!table) { catalogs[d.id] = { error: 'table_missing', table: d.source.table }; continue; }
    try {
      const c = await workerCatalog({ worker, table, dim: d, limit });
      await lookup.load(d.id, c);
      catalogs[d.id] = { complete: c.complete, size: c.values.length, source: c.source, scanned: c.scanned };
    } catch (err) {
      catalogs[d.id] = { error: String(err && err.message || err) };
    }
  }
  return { lookup, catalogs };
}

/** 一句话 → 实体解析结果。matched 才往下走；ambiguous / unknown / not_found 都要上层处理。 */
function resolveQuestion(lookup, question, dimIds){
  return lookup.resolve(question, dimIds ? { dimIds } : undefined);
}

/** B-matched 用的候选摘要：只给表 / 列 / 定义 / 维度名，**绝不给值列表**。 */
function candidateBrief(tables, semantic){
  return (tables || []).map(t => {
    const dims = [...semantic.dims.values()].filter(d => !d.unbound && d.source && d.source.table === t.name);
    return {
      table: t.name,
      columns: (t.columns || []).map(c => c.name),
      dimension_columns: dims.map(d => ({ dim: 'd:' + d.id, name: d.name, column: d.source.field })),
      row_count: (t.stats && t.stats.rows) || null,
      note: '值不在上下文里：实体由本机目录解析，解析结果见 entities；目录不完整时不会说「不存在」。',
    };
  });
}

module.exports = { workerCatalog, sqliteCatalog, buildLookup, resolveQuestion, candidateBrief, DEFAULT_LIMIT };
