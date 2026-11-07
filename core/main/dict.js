// ================= 出厂词典：查找 + 自检（10-16 第四批）=================
// 词典内容在 main/dict/metrics.js。这里：① 名字 / 缩写 / 别名精确查（不分大小写、全半角、空格横线）；
// ② 表头认词典（去掉单位、币种后缀再查，缩写按整词认）；③ 自检（node main/dict.js）：比率的分子分母都要在词典里、合计方法和单位对得上、缩写撞车要标「一词多义」。
'use strict';
const D = require('./dict/metrics');
const C = require('./dict/contracts');       // 指标契约（第二轮 T2）：说明/计算方式/单位/时间角色/易错点 + 候选卡片短版
const AGGS = new Set(['sum', 'ratio', 'stock', 'dcount', 'avg', 'none', 'count']);
const byId = new Map(D.map(e => [e.id, e]));

// 全角转半角、去空白和常见连接符、转小写
const norm = s => String(s == null ? '' : s).replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ')
  .trim().toLowerCase().replace(/[\s_\-·.、]+/g, '');
// 表头去单位 / 币种：「广告花费(USD)」「GMV/RMB」「销售额_元」「Sales £」→ 广告花费 / GMV / 销售额 / Sales
const CUR = '(rmb|cny|usd|gbp|eur|jpy|aud|cad|hkd|元|美元|英镑|欧元|万元|千元|万|件|个|次|%|￥|¥|\\$|£|€)';
const strip = s => String(s == null ? '' : s).replace(/[（(\[【][^）)\]】]*[）)\]】]/g, ' ').replace(new RegExp('[\\/_\\-\\s]*' + CUR + '\\s*$', 'i'), '').replace(new RegExp('^\\s*' + CUR + '[\\/_\\-\\s]*', 'i'), '').trim();

const index = new Map();          // 规范化的名字 → [条目 id]
const put = (k, id) => { const n = norm(k); if (!n) return; const a = index.get(n) || []; if (!a.includes(id)) a.push(id); index.set(n, a); };
for (const e of D) { put(e.zh, e.id); put(e.en, e.id); for (const a of e.abbr) put(a, e.id); for (const a of e.alias) put(a, e.id); }

// 精确查：返回所有对得上的条目（一个以上 = 一词多义，要给选项）
function lookup(name){
  const ids = index.get(norm(name)) || index.get(norm(strip(name))) || [];
  return ids.map(id => byId.get(id));
}
// 表头认词典：先整名精确，再去单位，再按缩写整词（「7天ROAS」「ROAS-7d」→ ROAS；「CTR(%)」→ CTR）
const ABBR = [...new Set(D.flatMap(e => e.abbr.filter(a => /^[A-Za-z][A-Za-z0-9:\/&]{1,9}$/.test(a)).map(a => a.toLowerCase())))].sort((a, b) => b.length - a.length);
function identify(col){
  const raw = String(col || '');
  let hit = lookup(raw);
  if (hit.length) return { entries: hit, how: 'name' };
  const low = raw.toLowerCase();
  for (const a of ABBR) {
    const re = new RegExp('(^|[^a-z])' + a.replace(/[\/&]/g, m => '\\' + m) + '([^a-z]|$)');
    if (re.test(low)) { hit = lookup(a); if (hit.length) return { entries: hit, how: 'abbr', token: a }; }
  }
  return { entries: [], how: '' };
}
// 话里出现了哪些词典里的词（最长的优先、不重叠）：用来挡「获客成本」里的「成本」被认成成本列这种
const TERMS = [...new Set(D.flatMap(e => [e.zh, e.en, ...e.abbr, ...e.alias]).filter(t => t && (/[\u4e00-\u9fff]/.test(t) ? t.length >= 2 : t.length >= 2)))]
  .map(t => ({ t, low: t.toLowerCase(), en: /^[A-Za-z][A-Za-z0-9 \/&:%-]*$/.test(t), ids: (index.get(norm(t)) || []) })).sort((a, b) => b.t.length - a.t.length);
function termsIn(text){
  const s = String(text || ''), low = s.toLowerCase(), out = [], used = [];
  for (const x of TERMS) {
    let from = 0, i;
    while ((i = (x.en ? low : s).indexOf(x.en ? x.low : x.t, from)) >= 0) {
      const j = i + x.t.length; from = i + 1;
      if (x.en && ((i > 0 && /[a-z0-9]/.test(low[i - 1])) || (j < low.length && /[a-z0-9]/.test(low[j])))) continue;   // 英文按整词
      if (used.some(([a, b]) => i < b && j > a)) continue;
      used.push([i, j]); out.push({ term: x.t, start: i, end: j, ids: x.ids });
    }
  }
  return out;
}
// 给向量用的文字：名字 + 别名 + 说明
const textOf = e => [e.zh, e.en, ...e.abbr, ...e.alias.slice(0, 6)].filter(Boolean).join(' / ') + '：' + e.desc;

function check(){
  const errors = [], notes = [];
  const ids = new Set();
  for (const e of D) {
    if (ids.has(e.id)) errors.push(`重复的 id：${e.id}`); ids.add(e.id);
    if (!e.zh || !e.desc || !e.ind.length) errors.push(`${e.id}：缺中文名 / 说明 / 行业`);
    if (!AGGS.has(e.agg)) errors.push(`${e.id}：合计方法「${e.agg}」不认识`);
    if (e.agg === 'ratio') {
      if (!byId.has(e.num) || !byId.has(e.den)) errors.push(`${e.id}：比率的分子「${e.num}」/ 分母「${e.den}」不在词典里`);
      if (![1, 100, 1000].includes(e.mul)) errors.push(`${e.id}：倍数只能是 1 / 100 / 1000`);
      if (e.mul === 100 && e.unit !== '%') errors.push(`${e.id}：乘 100 的比率单位应该是 %`);
      if (e.unit === '%' && e.mul !== 100) errors.push(`${e.id}：单位是 % 但没乘 100`);
      const n = byId.get(e.num), d = byId.get(e.den);
      if (n && n.agg === 'ratio') errors.push(`${e.id}：分子不能又是比率（${e.num}）`);
      if (d && d.agg === 'ratio') errors.push(`${e.id}：分母不能又是比率（${e.den}）`);
    } else if (e.num || e.den) errors.push(`${e.id}：不是比率却写了分子分母`);
    if (e.agg === 'stock' && e.unit === '%') errors.push(`${e.id}：存量的单位不该是 %`);
    if (e.agg === 'sum' && e.unit === '%') errors.push(`${e.id}：能直接加的指标单位不该是 %`);
  }
  // 缩写 / 名字撞车：要么条目自己标了「一词多义」，要么只是别名重了（记下来，查的时候会给选项）
  for (const [k, list] of index) if (list.length > 1) {
    const es = list.map(id => byId.get(id));
    const isAbbr = es.some(e => e.abbr.some(a => norm(a) === k));
    (isAbbr && !es.some(e => e.ambiguous) ? notes : notes).push(`「${k}」对上 ${list.length} 条：${list.join('、')}${es.some(e => e.ambiguous) ? '（已标一词多义）' : ''}`);
  }
  return { errors, notes, count: D.length };
}

module.exports = { D, byId, lookup, identify, norm, strip, textOf, check, termsIn,
  // ---- 指标契约（main/dict/contracts.js；纯函数，不读档、不改词典定义）----
  contractOf: C.contractOf, specOf: C.specOf, shortSpec: C.shortSpec, cardOf: C.cardOf, cardLine: C.cardLine, defaultFor: C.defaultFor, defaultBrief: C.defaultBrief,
  cardFields: C.cardFields, auditContracts: C.auditContracts, pendingList: C.pendingList, CONTRACT_PENDING: C.PENDING };

if (require.main === module) {                // 自检：node main/dict.js
  const assert = require('node:assert');
  const r = check();
  console.log(`词典 ${r.count} 条；错误 ${r.errors.length} 条；同名 ${r.notes.length} 处`);
  for (const x of r.errors) console.log('  ✗ ' + x);
  if (process.argv.includes('--notes')) for (const x of r.notes) console.log('  · ' + x);
  assert.strictEqual(lookup('roas')[0].id, 'roas'); assert.strictEqual(lookup('ＲＯＡＳ')[0].id, 'roas'); assert.strictEqual(lookup('营业额')[0].id, 'sales');
  assert.strictEqual(identify('广告花费(USD)').entries[0].id, 'ad_spend'); assert.strictEqual(identify('7天ROAS').entries[0].id, 'roas'); assert.strictEqual(identify('CTR(%)').entries[0].id, 'ctr');
  assert.strictEqual(identify('GMV/RMB').entries[0].id, 'gmv'); assert.strictEqual(identify('一级分类').entries.length, 0);
  assert.ok(lookup('CR').length >= 2, 'CR 一词多义');
  // ---- 指标契约自检：词典 436 + 语义包 60 条都要有五字段；候选卡片短版要能取 ----
  const audit = C.auditContracts();
  assert.strictEqual(audit.dict.total, D.length, '契约条数要和词典一致');
  assert.strictEqual(audit.semantic.total, 60, '语义包 60 条都要有契约');
  for (const f of ['desc', 'calc', 'unit', 'time_role', 'caveats']) {
    assert.strictEqual(audit.overall.by_field[f].missing, 0, `五字段「${f}」有缺项：` + audit.overall.missing.filter(x => x.field === f).map(x => x.id).join(','));
  }
  assert.strictEqual(C.cardOf('aov').spec.calc, '销售额 ÷ 订单数');
  assert.deepStrictEqual(Object.keys(C.cardOf('aov')), ['id', 'name', 'unit', 'spec']);
  assert.strictEqual(C.cardOf('m:gmv').spec.calc, 'Σ 销售金额（orders 表逐行求和）');
  assert.ok(C.cardLine('roas').includes('易错:'));
  assert.ok(C.pendingList().length >= 20 && C.pendingList().length <= 30, '口径待定清单 20–30 条');
  const pct = (audit.overall.five_field_rate * 100).toFixed(2);
  console.log(`指标契约 ${audit.overall.total} 条（词典 ${audit.dict.total} + 语义包 ${audit.semantic.total}）；五字段齐全 ${audit.overall.complete}/${audit.overall.total}（${pct}%）；业务口径已确定 ${audit.overall.business_certain} 条、挂待定 ${audit.overall.pending_entries} 条（清单 ${audit.pending_total} 项）`);
  if (r.errors.length) process.exit(1);
  console.log('词典自检通过');
}
