// ================= 关系 / 粒度能力（P1） =================
// 只做「关系怎么连、粒度对不对、能不能安全算」这一层，不自己取数、不估算。
//
// 支持：
//   · 基数 1:1 / N:1 / 1:N / N:N（声明 + 用真实行数据实测，声明与实测不一致就拒绝）
//   · 复合键（pairs 多对键）
//   · 桥表识别（一张表对两张实体各 N:1，且 grain 覆盖两侧连接键）：标识 N:N 归因缺口
//   · 扇出检查：沿 1:N / N:N 方向聚合可加/比率指标会放大多行 → fanout
//   · 期末快照预聚合：半可加快照表按 grain 取期间末最后一行后再 join / 聚合（SQL 由 semantic 发射）
//   · 跨表 grain：按声明的 grain 列实测唯一性，决定「直接 join」还是「先预聚合」
//
// 不支持的一律抛能力缺口（code=unsupported_operator / fanout），不返回估算值。
'use strict';

const CARDS = ['1:1', 'N:1', '1:N', 'N:N'];
const CARD_SET = new Set(CARDS);
const KEY = '\u0001';

function semErr(msg, code){ const err = new Error(msg); err.semantic = true; if (code) err.code = code; return err; }
function gap(msg, code){ return Object.assign(semErr(msg, code || 'unsupported_operator'), { capabilityGap: true }); }
// 基数写法统一：允许 "n:1" / "N：1" / 空格；其它一律短码 bad_cardinality，不猜。
function normCard(c){
  const s = String(c == null ? '' : c).replace(/\s+/g, '').replace(/：/g, ':').toUpperCase();
  if (!CARD_SET.has(s)) throw semErr(`基数无效：${c}（只认 ${CARDS.join(' / ')}）`, 'bad_cardinality');
  return s;
}
function pairOf(p){
  if (Array.isArray(p)) return [p[0], p[1]];
  if (p && typeof p === 'object') return [p.left != null ? p.left : p.baseKey, p.right != null ? p.right : p.oneKey];
  return [undefined, undefined];
}
const norm = v => v == null ? null : String(v);
function keyOf(row, cols){ return cols.map(c => norm(row ? row[c] : null)).join(KEY); }

/* ---------- 键唯一性实测（复合键按整组比） ---------- */
function keyStats(rows, cols){
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set(), dup = new Map();
  let nullKeys = 0;
  for (const r of list) {
    const vals = (cols || []).map(c => r ? r[c] : null);
    if (!vals.length || vals.some(v => v == null)) nullKeys++;
    const k = vals.map(norm).join(KEY);
    if (seen.has(k)) dup.set(k, (dup.get(k) || 1) + 1);
    else seen.add(k);
  }
  return {
    rows: list.length, keys: (cols || []).slice(), distinct: seen.size,
    unique: list.length > 0 && seen.size === list.length && !nullKeys,
    nullKeys,
    duplicates: [...dup.entries()].slice(0, 5).map(([k, n]) => ({ key: k.split(KEY).map(x => x), n })),
  };
}

/* 声明基数 vs 实测基数。N:1 / 1:N 允许实测退化为 1:1（多对一里的一对一也是多对一）。
   N:N 必须真 N:N；1:1 必须真 1:1；方向反了同样算不一致（fanout 方向必须由人确认）。 */
function compatible(declared, measured){
  if (!declared || !measured) return false;
  if (declared === measured) return true;
  if (declared === 'N:1' && measured === '1:1') return true;
  if (declared === '1:N' && measured === '1:1') return true;
  return false;
}
function measuredCardinality(L, R){
  if (!L || !R || !L.rows || !R.rows) return null;
  if (L.unique && R.unique) return '1:1';
  if (R.unique) return 'N:1';       // 左多右一
  if (L.unique) return '1:N';       // 左一右多
  return 'N:N';
}
/**
 * 实测一条关系：两侧键是否唯一、空键、重复样例。
 * @param {{declared?:string,pairs:Array,leftRows:Array,rightRows:Array,left?:string,right?:string}} o
 * @returns {{ok:boolean,declared:string|null,measured:string|null,code:string|null,left:object,right:object,message:string}}
 */
function measureRelation(o){
  const pairs = (o.pairs || []).map(pairOf);
  if (!pairs.length || pairs.some(([l, r]) => l == null || r == null))
    throw semErr('关系缺 pairs / keys（每对给 [左列, 右列]）', 'bad_relationship');
  for (const [l, r] of pairs) if (String(l).length === 0 || String(r).length === 0) throw semErr('关系键列名不能为空', 'bad_relationship');
  const declared = o.declared ? normCard(o.declared) : null;
  const leftRows = Array.isArray(o.leftRows) ? o.leftRows : null;
  const rightRows = Array.isArray(o.rightRows) ? o.rightRows : null;
  if (!leftRows || !rightRows) {
    return { ok: false, declared, measured: null, code: 'cardinality_unverified',
      message: `关系「${o.left || ''}→${o.right || ''}」基数未实测：需要两侧真实行（声明不能当实测）`,
      left: null, right: null };
  }
  const L = keyStats(leftRows, pairs.map(p => p[0]));
  const R = keyStats(rightRows, pairs.map(p => p[1]));
  const measured = measuredCardinality(L, R);
  if (!measured) {
    return { ok: false, declared, measured, code: 'cardinality_unverified',
      message: '任一侧没有行，基数无法实测（空表不推断）', left: L, right: R };
  }
  const ok = !declared || compatible(declared, measured);
  return {
    ok, declared, measured,
    code: ok ? null : 'fanout_risk',
    message: ok ? `声明 ${declared || '未声明'}，实测 ${measured}（${L.rows} 行 : ${R.rows} 行）`
      : `基数不符：声明 ${declared}，实测 ${measured}（声明方向会被拿去 join，方向错了会放大行）`,
    left: L, right: R,
  };
}

/* ---------- 关系图：安全路径（只走 N:1 / 1:1）与全路径（含扇出） ---------- */
class RelationGraph {
  constructor(rels){ this.rels = (rels || []).filter(r => r && r.left && r.right); }

  _pairs(r){ return (r.pairs || r.keys || []).map(pairOf); }

  // 安全跳：从 base（多侧）走到 one 侧；N:1 / 1:1 才允许，1:N / N:N 不算安全
  hops(t){
    const out = [];
    for (const r of this.rels) {
      if (r.unbound || r.unverified) continue;
      if (!['N:1', '1:N', '1:1'].includes(r.cardinality)) continue;
      const pairs = this._pairs(r);
      if (!pairs.length) continue;
      if (r.left === t && (r.cardinality === 'N:1' || r.cardinality === '1:1'))
        out.push({ from: t, to: r.right, rel: r, pairs: pairs.map(([l, rr]) => ({ baseKey: l, oneKey: rr })) });
      else if (r.right === t && (r.cardinality === '1:N' || r.cardinality === '1:1'))
        out.push({ from: t, to: r.left, rel: r, pairs: pairs.map(([l, rr]) => ({ baseKey: rr, oneKey: l })) });
    }
    return out;
  }

  safePath(from, to, depth = 5){
    if (from === to) return [];
    const q = [{ t: from, path: [] }], seen = new Set([from]);
    while (q.length) {
      const { t, path } = q.shift();
      if (path.length >= depth) continue;
      for (const hop of this.hops(t)) {
        if (seen.has(hop.to)) continue;
        const next = [...path, hop];
        if (hop.to === to) return next;
        seen.add(hop.to);
        q.push({ t: hop.to, path: next });
      }
    }
    return null;
  }

  // 任意路径（含 1:N / N:N），用于判定「有路但会扇出」还是「根本没声明关系」
  anyPath(from, to, depth = 6){
    if (from === to) return { path: [], fanout: false, unverified: false, cards: [] };
    const q = [{ t: from, path: [], fanout: false, unverified: false, cards: [] }], seen = new Set([from]);
    while (q.length) {
      const cur = q.shift();
      if (cur.path.length >= depth) continue;
      for (const e of this.edges(cur.t)) {
        if (seen.has(e.to)) continue;
        const fan = cur.fanout || e.fanout;
        const un = cur.unverified || !!e.rel.unverified;
        const cards = [...cur.cards, e.rel.cardinality];
        if (e.to === to) return { path: [...cur.path, e], fanout: fan, unverified: un, cards };
        seen.add(e.to);
        q.push({ t: e.to, path: [...cur.path, e], fanout: fan, unverified: un, cards });
      }
    }
    return null;
  }

  // 两个方向都要留：left→right 扇出与否取决于基数方向（见 with fanout 判定）
  edges(t){
    const out = [];
    for (const r of this.rels) {
      if (r.unbound) continue;
      const card = r.cardinality;
      if (!CARD_SET.has(card)) continue;
      const pairs = this._pairs(r);
      if (!pairs.length) continue;
      if (r.left === t) out.push({ from: t, to: r.right, rel: r, dir: 'L',
        fanout: card === '1:N' || card === 'N:N',
        pairs: pairs.map(([l, rr]) => ({ baseKey: l, oneKey: rr })) });
      else if (r.right === t) out.push({ from: t, to: r.left, rel: r, dir: 'R',
        fanout: card === 'N:1' || card === 'N:N',
        pairs: pairs.map(([l, rr]) => ({ baseKey: rr, oneKey: l })) });
    }
    return out;
  }

  // 桥表：一张表（left）对 ≥2 个不同实体各 N:1/1:1，且 grain 覆盖两侧连接键 → N:N 归因缺口
  bridges(grainCols, includeUncovered = false){
    const byLeft = new Map();
    for (const r of this.rels) {
      if (r.unbound || r.unverified) continue;
      if (!['N:1', '1:1'].includes(r.cardinality)) continue;
      const pairs = this._pairs(r);
      if (!pairs.length) continue;
      if (!byLeft.has(r.left)) byLeft.set(r.left, []);
      byLeft.get(r.left).push({ rel: r, keys: pairs.map(p => p[0]) });
    }
    const out = [];
    for (const [t, rs] of byLeft) {
      if (rs.length < 2) continue;
      const entities = [...new Set(rs.map(x => x.rel.right))];
      if (entities.length < 2) continue;
      const joinKeys = [...new Set(rs.flatMap(x => x.keys))];
      const g = grainCols && grainCols[t] ? grainCols[t] : null;
      const covers = g ? joinKeys.every(k => g.includes(k)) : null;
      // 只有「声明了 grain 且覆盖两侧连接键」才算桥表。
      // grain 缺失（null）时不能断言是桥表：明细事实表也常对两张维度表各 N:1，误判会让扇出报错点名错表。
      if (!includeUncovered && covers !== true) continue;
      out.push({ table: t, entities, joinKeys, grain: g, grainCoversKeys: covers, requiresAllocation: true });
    }
    return out;
  }
}

/* 粒度预聚合计划：给定 base 与目标表、grain，决定能不能直接 join / 要不要先按 grain 取期末快照。
   只给计划，不改口径；不支持就抛能力缺口。 */
function planGrainJoin(o){
  const graph = o.graph;
  const base = o.base, target = o.target;
  if (!graph) throw semErr('planGrainJoin 需要 RelationGraph', 'bad_arguments');
  if (base === target) return { mode: 'direct', reason: '同表，不需要 join' };
  const safe = graph.safePath(base, target);
  if (safe) return { mode: 'direct', hops: safe, reason: '沿 N:1 / 1:1 走，行数不放大' };
  const any = graph.anyPath(base, target);
  if (!any) throw gap(`表「${base}」和「${target}」之间没有声明关系，无法按目标表分组`, 'missing_relationship');
  if (any.unverified) throw gap(`表「${base}」→「${target}」路径上有关系未通过实测，不能当安全路径用`, 'relation_unverified');
  const n2n = any.cards.some(c => c === 'N:N');
  // 桥表：路径上经过一张「两侧各 N:1」的连接表，等价于 N:N（同一行会匹配多行）
  const bridge = (o.bridges || []).find(b => any.path.some(e => e.to === b.table || (e.rel && e.rel.left === b.table)));
  if (n2n || bridge) throw gap(`「${base}」→「${target}」经过 ${n2n ? 'N:N' : 'N:N 桥表'}${bridge ? '「' + bridge.table + '」' : ''}：同一事实行会匹配多行，归因/权重未声明，不能把可加指标直接分组（需要分配权重或改用去重计数）`, 'fanout');
  throw gap(`「${base}」→「${target}」要经过 1:N（会放大多行）：先按粒度预聚合到 1 侧，或改用 1 侧字段 / dcount，不能直接 SUM`, 'fanout');
}

module.exports = {
  CARDS, CARD_SET, normCard, pairOf, keyOf, keyStats, compatible, measuredCardinality,
  measureRelation, RelationGraph, planGrainJoin,
  semErr, gap, KEY,
};
