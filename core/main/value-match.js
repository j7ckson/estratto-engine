// ================= 取值匹配：用户 / 模型说的叫法 → 数据里真实写法（候选只给用户看，不给模型）=================
// 用途：限制级 SQL 兜底里「列 = 'xxx'」的 xxx 在列里不存在时，本机去这一列的不重复值里找最像的。
// 硬规矩：这里查到的真实取值只在本机用 / 给用户选，绝不放进任何发给模型的内容。
'use strict';

const SYM_RE = /[\s_\-.&/\\,，、]+/g;
const norm = s => String(s == null ? '' : s).toLowerCase().replace(SYM_RE, '');

/** 拆词：先按符号 / 空格切，再按驼峰（小写后面跟大写、字母数字交界不切）切 */
function words(s){
  const out = [];
  for (const part of String(s == null ? '' : s).split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue;
    for (const w of part.split(/(?<=[\p{Ll}])(?=[\p{Lu}])|(?<=[\p{Lu}])(?=[\p{Lu}][\p{Ll}])/u)) if (w) out.push(w);
  }
  return out;
}
/** 首字母缩写（至少两个词才算） */
function initials(s){
  const w = words(s);
  return w.length >= 2 ? w.map(x => x[0]).join('').toLowerCase() : '';
}
/** 短串的字母是否按顺序出现在长串里 */
function isSubseq(short, long){
  let i = 0;
  for (let j = 0; j < long.length && i < short.length; j++) if (long[j] === short[i]) i++;
  return i === short.length;
}
/** 编辑距离（超过 cap 就提前放弃，返回 cap+1） */
function editDist(a, b, cap){
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** 单向打分：short 当「简称 / 说法」，long 当「全称 / 数据里的写法」；两个方向由外层各算一次取大 */
function oneWay(qRaw, vRaw){
  const q = norm(qRaw), v = norm(vRaw);
  if (!q || !v) return 0;
  let best = 0;
  // 首字母缩写：value 拆词（空格 / 符号 / 驼峰）后的首字母 == query
  if (q.length >= 2 && initials(vRaw) === q) best = Math.max(best, 0.92);
  // 前缀：value 以 query 开头
  if (q.length >= 1 && v.length > q.length && v.startsWith(q)) best = Math.max(best, 0.82);
  // 字母按顺序出现且首字母相同
  if (q.length >= 2 && q.length < v.length && q[0] === v[0] && isSubseq(q, v)) {
    best = Math.max(best, q.length <= 2 ? 0.72 * 0.8 : 0.72);
  }
  // 包含
  if (q.length >= 2 && v.length > q.length && v.includes(q)) best = Math.max(best, 0.6);
  return best;
}

/** 候选打分 0..1（两个方向都算，取最大） */
function scoreCandidate(query, value){
  const q = norm(query), v = norm(value);
  if (!q || !v) return 0;
  if (q === v) return 1;
  let best = Math.max(oneWay(query, value), oneWay(value, query));
  // 编辑距离：长度≥4 允许差 1，≥8 允许差 2
  const m = Math.min(q.length, v.length);
  if (m >= 4) {
    const cap = m >= 8 ? 2 : 1;
    if (editDist(q, v, cap) <= cap) best = Math.max(best, 0.75);
  }
  return Math.min(1, best);
}

// ---------- 中文说法 → 英文 / 代码取值的「扩展说法」----------
// 数据里常是英文或代码（角色 PH、AG；状态 OOS），用户说中文（投保人、代理、断货）。
// 做法：中文说法先查出厂词典（dict.termsIn / identify：英文名、缩写、别名），再查下面这张很小的通用「角色 / 状态」说法表，
// 拿到的英文说法一起去比。扩展说法最高 0.8（走「让用户选」，不自动用）；扩展后和取值完全相等（词典 / 说法表里明写的英文名或缩写）才给 1。
// 英文名再拆成词取首字母（Policy Holder → PH）去对短代码：这种推出来的缩写一律封顶 0.8。
const hasCjk = x => /[\u4e00-\u9fff]/.test(String(x == null ? '' : x));
const CONCEPTS = [
  {literal_name:true,zh:['办公用品'],en:['Office Supplies','Office Products','Office Product','Office Supply']},
  {literal_name:true,zh:['亚马逊'],en:['Amazon']}, {literal_name:true,zh:['抖音海外版'],en:['TikTok']}, {literal_name:true,zh:['虾皮'],en:['Shopee']},
  {zh:['健康'],en:['Healthy']}, {zh:['严重'],en:['Critical','Severe']},
  { zh: ['投保人', '保单持有人', '投保客户'], en: ['Policyholder', 'Policy Holder', 'Applicant'] },
  { zh: ['被保险人', '被保人'], en: ['Insured', 'Insured Person'] },
  { zh: ['受益人'], en: ['Beneficiary'] },
  { zh: ['代理人', '保险代理', '代理'], en: ['Agent', 'Agency'] },
  { zh: ['经纪人', '经纪'], en: ['Broker'] },
  { zh: ['客户', '顾客'], en: ['Customer', 'Client'] },
  { zh: ['供应商', '供货商'], en: ['Supplier', 'Vendor'] },
  { zh: ['经销商', '分销商'], en: ['Distributor', 'Dealer'] },
  { zh: ['员工', '雇员'], en: ['Employee', 'Staff'] },
  { zh: ['断货', '缺货', '无货'], en: ['Out of Stock', 'Stockout', 'OOS', 'Sold Out'] },
  { zh: ['预警', '低库存'], en: ['Low Stock', 'Warning', 'Alert'] },
  { zh: ['已取消', '取消'], en: ['Cancelled', 'Canceled', 'Void'] },
  { zh: ['已完成', '完成'], en: ['Completed', 'Complete', 'Done', 'Closed'] },
  { zh: ['已退款', '退款'], en: ['Refunded', 'Refund'] },
  { zh: ['已发货', '发货'], en: ['Shipped', 'Dispatched'] },
  { zh: ['待处理', '待审核'], en: ['Pending'] },
  { zh: ['有效'], en: ['Active', 'Valid', 'In Force'] },
  { zh: ['失效', '无效'], en: ['Inactive', 'Invalid', 'Lapsed', 'Expired'] },
];
/** 中文说法的英文 / 代码扩展：返回 [{ q, derived }]（derived = 推出来的缩写，永远不给 1） */
function expandQuery(query, dictMod){
  const q = String(query == null ? '' : query);
  if (!hasCjk(q)) return [];
  const raw = new Map();   // 说法 → derived
  const add = (t, derived) => { const x = String(t || '').trim(); if (!x || hasCjk(x) || norm(x).length < 2) return; if (!raw.has(x) || !derived) raw.set(x, !!derived && (raw.get(x) !== false)); };
  for (const c of CONCEPTS) if (c.zh.some(z => q.includes(z))) for (const e of c.en) add(e, false);
  let dm = dictMod; if (dm === undefined) { try { dm = require('./dict'); } catch (_) { dm = null; } }
  if (dm) {
    try {
      const entries = [];
      for (const t of (dm.termsIn(q) || [])) for (const id of (t.ids || [])) { const e = dm.byId.get(id); if (e) entries.push(e); }
      for (const e of (dm.identify(q).entries || [])) entries.push(e);
      for (const e of entries.slice(0, 4)) {
        add(e.en, false);
        for (const a of (e.abbr || [])) add(a, false);
        for (const a of (e.alias || []).slice(0, 6)) add(a, false);
      }
    } catch (_) {}
  }
  for (const [t] of [...raw]) { const ini = initials(t); if (ini) add(ini.toUpperCase(), true); }
  return [...raw].map(([t, derived]) => ({ q: t, derived }));
}

const rowsOf = r => Array.isArray(r) ? r : (r && r.rows) || [];
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';

/**
 * 本机取这一列的不重复值（按出现次数排，最多 5000 个），对每个说法打分，取最大，返回前 limit 个。
 * vecScore(query, value)→0..1：以后接向量用；没给就不用。
 * vecBatch(queries, values)→Promise<number[][]>（每个说法 × 每个取值的像度）：10-23 接本机中英向量。
 *   只在字面打分没有「开头像」以上（<0.82）、且这一列不重复值 ≤ VEC_MAX 个时才用（取值多了算向量太慢）；失败就当没有。
 */
const VEC_MAX = 2000;
async function findValues({ run, table, col, queries, limit = 5, vecScore, vecBatch, dict } = {}){
  const qs = [...new Set((queries || []).map(x => String(x == null ? '' : x)).filter(x => norm(x)))];
  if (typeof run !== 'function' || !qs.length) return [];
  let rows = [];
  try {
    rows = rowsOf(await run(`SELECT CAST(${qi(col)} AS VARCHAR) AS v, COUNT(*) AS n FROM ${qi(table)} WHERE ${qi(col)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5000`));
  } catch (_) { return []; }
  const out = [];
  // 扩展说法（只对中文说法）：打折，最高 0.8；和取值完全相等且不是推出来的缩写才给 1
  const exps = [];
  for (const q of qs) for (const x of expandQuery(q, dict)) if (!qs.includes(x.q) && !exps.some(y => y.q === x.q)) exps.push(x);
  for (const r of rows) {
    const value = r.v != null ? String(r.v) : null;
    if (value == null) continue;
    let score = 0;
    for (const x of exps) {
      const s0 = scoreCandidate(x.q, value);
      const s = s0 >= 1 && !x.derived ? 1 : Math.min(0.8, s0);
      if (s > score) score = s;
    }
    for (const q of qs) {
      let s = scoreCandidate(q, value);
      if (typeof vecScore === 'function') { try { const x = Number(vecScore(q, value)); if (Number.isFinite(x)) s = Math.max(s, Math.min(1, Math.max(0, x))); } catch (_) {} }
      if (s > score) score = s;
    }
    if (score > 0) out.push({ value, score, n: Number(r.n) || 0 });
  }
  const best = out.reduce((m, x) => Math.max(m, x.score), 0);
  if (typeof vecBatch === 'function' && best < 0.82 && rows.length && rows.length <= VEC_MAX) {
    try {
      const vals = rows.map(r => r.v != null ? String(r.v) : '').filter(Boolean);
      const sims = await vecBatch(qs, vals);
      if (Array.isArray(sims)) {
        const byVal = new Map(out.map(x => [x.value, x]));
        const nOf = new Map(rows.map(r => [String(r.v), Number(r.n) || 0]));
        // 各模型的余弦高低不一样（e5 普遍 0.8 以上），只看排名：每个说法内按「最像 → 最不像」拉到 0..0.8
        // （最多给到 0.8，低于自动采用线，一律走「助手提问」让用户从前几个里选）
        const scaled = sims.map(row => {
          const xs = (row || []).map(Number).filter(Number.isFinite);
          if (!xs.length) return [];
          const hi = Math.max(...xs), lo = Math.min(...xs), span = hi - lo;
          return (row || []).map(x => Number.isFinite(Number(x)) && span > 1e-6 ? 0.8 * (Number(x) - lo) / span : 0);
        });
        vals.forEach((value, j) => {
          let s = 0;
          for (const row of scaled) { const x = Number(row && row[j]); if (Number.isFinite(x)) s = Math.max(s, x); }
          s = Math.min(0.8, Math.max(0, s));
          if (!(s > 0)) return;
          const hit = byVal.get(value);
          if (hit) { if (s > hit.score) { hit.score = s; hit.vec = true; } }
          else { const x = { value, score: s, n: nOf.get(value) || 0, vec: true }; out.push(x); byVal.set(value, x); }
        });
      }
    } catch (_) {}
  }
  out.sort((a, b) => b.score - a.score || b.n - a.n);
  return out.slice(0, limit);
}

/** 怎么处理：很像且明显领先 → 自动用；有点像 → 让用户选；不像 → 没有 */
function decide(cands){
  const c = Array.isArray(cands) ? cands : [];
  const top = c[0], second = c[1];
  if (!top) return { mode: 'none' };
  if (top.score >= 0.9 && (!second || second.score < top.score - 0.15)) return { mode: 'auto', value: top.value };
  if (top.score >= 0.5) return { mode: 'ask', options: c.slice(0, 5) };
  return { mode: 'none' };
}

module.exports = { scoreCandidate, findValues, decide, norm, expandQuery };

// 同一列只有一个在题面完整出现的真实值时，优先采用这条直接证据，不拿译名去模糊猜。
function exactQuestionValue({question,table,col,registry,lookup}={}){
 const q=String(question||'');if(!lookup?.resolve||/对比|相比|和|与|、|\bvs\b|\bversus\b/i.test(q))return null;
 const hits=new Set();for(const d of registry.semantic.dims.values()){
  if(d.unbound||d.kind!=='column'||d.source?.table!==table||d.source?.field!==col||lookup.coverage?.get(String(d.id))?.complete!==true)continue;
  let r;try{r=lookup.resolve(q,{dimIds:[String(d.id)]});}catch(_){continue;}
  if(r.status!=='matched')continue;
  const value=String(r.value),escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const present=/^[\x00-\x7f]+$/.test(value)?new RegExp('(?:^|[^A-Za-z0-9])'+escaped+'(?=$|[^A-Za-z0-9])','i').test(q):q.includes(value);
  if(present)hits.add(value);
 }
 return hits.size===1?[...hits][0]:null;
}
module.exports.exactQuestionValue=exactQuestionValue;

// 复用已声明的专名别名；仅在准许、可达、完整目录中唯一精确命中，不提升角色代码或模糊相似度。
function explicitNominalAlias(question,{lookup,dimIds}={}){
 const q=String(question||'');
 if(!lookup?.index||!Array.isArray(dimIds)||!dimIds.length||/[和及、与或]|不含|不包括|排除|剔除|除了|之外|以外|除外|非|不是|不属于|\b(?:not|exclude|except|without|versus|vs)\b/i.test(q))return null;
 const terms=CONCEPTS.filter(c=>c.literal_name).flatMap(c=>c.zh.filter(z=>q.includes(z)).map(literal=>({literal,en:c.en})));
 if(terms.length!==1)return null;
 const allowed=new Set(dimIds.map(String)),hits=[];
 for(const [dim,index]of lookup.index){
  if(!allowed.has(String(dim))||lookup.coverage?.get(String(dim))?.complete!==true||lookup.isTemporal?.(String(dim)))continue;
  for(const hit of index.values())if(terms[0].en.some(en=>norm(en)===norm(hit.value)))hits.push({dim:String(dim),value:String(hit.value),literal:terms[0].literal});
 }
 const unique=[...new Map(hits.map(h=>[h.dim+'\u0000'+h.value,h])).values()];return unique.length===1?unique[0]:null;
}
module.exports.explicitNominalAlias=explicitNominalAlias;

// 题面用引号或 exactly/恰好/完全等于 点名的取值 = 按原文精确匹配。
// 成熟做法:搜索引擎「加引号 = 逐字匹配」;SQL 字符串等值默认逐字(区分大小写)。
// 数据里没有完全一样的取值时,照原文算(计数就是 0),再把相近取值作为提示给用户,不拦下来让用户先选、也不悄悄换成相近值。
const QUOTE_PAIRS=[["'","'"],['"','"'],['‘','’'],['“','”'],['「','」'],['『','』'],['`','`']];
function quotedVerbatim(question,value){
 const q=String(question||''),v=String(value==null?'':value).trim();
 if(!v)return false;
 for(const [l,r] of QUOTE_PAIRS)if(q.includes(l+v+r))return true;
 const esc=v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp('(?:\\b[Ee]xactly|\\b[Pp]recisely|\\b[Ll]iterally|恰好(?:为|是|等于)?|完全等于|精确(?:为|是|等于|匹配))\\s*'+esc+'(?![\\p{L}\\p{N}])','u').test(q);
}
module.exports.quotedVerbatim=quotedVerbatim;
