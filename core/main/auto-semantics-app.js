// ================= 导入自动语义：接进 App 的导入流程（A7，10-23）=================
// auto-semantics.js 会「起名 + 生成语义包」，但以前只有评测在调。这里负责 App 里的这一圈：
//   导入完 → 从 worker 看当前有哪些业务表 → 生成 generated/auto_ws.json → 让语义层重新加载。
// 几条原则：
//   1) 失败不抛、不影响导入本身（最坏就是没有自动语义，问数走老路）；
//   2) 表结构没变（表名 + 列名 + 类型的指纹一样）就不重跑，不白花模型调用；
//   3) 没配模型也能跑：只用词典；有模型再起名，调用次数上限用 buildAutoPack 自己的默认值；
//   4) 表名对得上：库里能查到的是 v_<表id> 这种视图名（显示名只是文件名，库里没有这张表）。
//      包里的数据集一律用 v_<表id>，编译出来的 SQL / 问数兜底 SQL 才查得到；
//      给模型起名时再换成显示名（它才看得懂），拿到结果再换回 v_<表id>。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildAutoPack, AUTO_PACK_ID } = require('./auto-semantics');

const FILE = AUTO_PACK_ID + '.json';
const VIEW_RE = /^v_t[0-9a-f]+$/;

const rowsOf = r => Array.isArray(r) ? r : (r && r.rows) || [];
const packFile = semanticDir => path.join(semanticDir, 'generated', FILE);

function readPrevious(semanticDir){
  try {
    const p = JSON.parse(fs.readFileSync(packFile(semanticDir), 'utf8'));
    return p && p.id === AUTO_PACK_ID ? p : null;
  } catch (_) { return null; }
}

/** 表结构指纹：表名 + 列名 + 类型（不含任何数据）。顺序无关 */
function fingerprint(tables){
  // 10-24：日期写法也算指纹（用户确认了日期顺序要重跑一次）；没有 dfmt 的列和以前的指纹一样
  const s = require('./request-context').fingerprint(tables.map(t=>({name:t.name,columns:t.columns,currency:t.currency,dateCol:t.dateCol})).sort((a,b)=>a.name.localeCompare(b.name)));
  return crypto.createHash('sha1').update(s).digest('hex');
}

/**
 * 从 worker 的只读连接看当前有哪些业务表（v_<表id> 视图）和它们的列、类型。
 * stateTables（可选，一般是 cards.tables()）：只留里面还在用的表，显示名从这里取，标了「空列」的列不要。
 * 返回 [{ name:'v_t…', id, display, columns:[{name,type}] }]
 */
async function listTables(worker, stateTables){
  const out = await worker.call('semanticQuery', { sql: `SELECT table_name, column_name, data_type FROM information_schema.columns ORDER BY table_name, ordinal_position` }, 30000);
  const by = new Map();
  for (const r of rowsOf(out)) {
    const tn = String(r.table_name || '');
    if (!VIEW_RE.test(tn)) continue;
    const cn = String(r.column_name || '');
    if (!cn || ['_src','_row','_snap','_sheet'].includes(cn)) continue;       // _src / _row 是导入时塞的内部列
    if (!by.has(tn)) by.set(tn, []);
    by.get(tn).push({ name: cn, type: String(r.data_type || '') });
  }
  const st = Array.isArray(stateTables) ? new Map(stateTables.map(t => [t.id, t])) : null;
  const list = [];
  for (const [name, cols] of by) {
    const id = name.slice(2);
    let columns = cols, display = name;
    if (st) {
      const t = st.get(id); if (!t) continue;
      const empty = new Set((t.columns || []).filter(c => c.empty).map(c => c.name));
      const known = new Set((t.columns || []).map(c => c.name));
      const info = new Map((t.columns || []).map(c => [c.name, c]));
      // 日期列的写法（dfmt）和有没有人确认过（date_confirmed）一起带上：指纹要看它，包里要记它
      columns = cols.filter(c => !empty.has(c.name) && (known.has(c.name))).map(c => {
        const i = info.get(c.name) || {};
        return Object.assign({},i,c);
      });
      display = t.name || name;
    }
    if (columns.length) list.push({ name, id, display, columns, currency:st?.get(id)?.currency||null, dateCol:st?.get(id)?.dateCol||null });
  }
  return list;
}

/** 已经被内置领域包 / 规则语义「实打实」绑定的表（不再重复建自动语义）。只看名字命中，弱绑定（只靠键列）不算 */
function boundByRules(stateTables){
  const bound = new Set();
  if (!Array.isArray(stateTables) || !stateTables.length) return bound;
  try {
    const { SemanticRegistry } = require('./semantic-registry');
    const reg = SemanticRegistry.load({ tables: stateTables.map(t => ({ name: t.name, columns: (t.columns || []).map(c => ({ name: c.name, type: c.type })) })) });
    const weak = new Set(reg.semantic.weakDatasets || []);
    const ds = reg.semantic._ds || {};
    const names = new Set(Object.entries(ds).filter(([k]) => !weak.has(k)).map(([, v]) => v));
    for (const t of stateTables) if (names.has(t.name)) bound.add(t.id);
  } catch (_) { /* 没有任何数据集能绑定 = 没有表被规则语义占用 */ }
  return bound;
}

/** 给模型看显示名：payload 里的 v_<id> 换成显示名，返回结果里的键再换回 v_<id> */
function wrapNamer(namer, tables){
  if (typeof namer !== 'function') return null;
  const label = new Map(), back = new Map();
  for (const t of tables) {
    let l = t.display, k = 2;
    while (back.has(l)) l = t.display + '_' + (k++);
    label.set(t.name, l); back.set(l, t.name);
  }
  const fix = key => {                     // "显示名.列名" → "v_id.列名"（列名里可能有点，从第一个点之前找显示名）
    const s = String(key);
    for (const [l, v] of back) if (s === l || s.startsWith(l + '.')) return v + s.slice(l.length);
    return s;
  };
  return async payload => {
    const p = Object.assign({}, payload, { tables: (payload.tables || []).map(t => Object.assign({}, t, { name: label.get(t.name) || t.name })) });
    const out = await namer(p);
    if (!out || typeof out !== 'object') return null;
    const map = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [fix(k), v]));
    return { tables: map(out.tables), columns: map(out.columns),
      links: (Array.isArray(out.links) ? out.links : []).map(l => Array.isArray(l) ? l.map(fix) : l) };
  };
}

/**
 * 导入后刷新一次自动语义。永远不抛。
 * @param {{worker, semanticDir:string, namer?:Function, state?, log?:Function, tables?:Array, reload?:Function, maxNamerCalls?:number, force?:boolean}} o
 *   tables：当前业务表（cards.tables()）。给了就只处理这里面的表、用显示名起名、并跳过规则语义已绑定的表
 *   reload：写完文件后让语义层重新加载（App 里是 agent.invalidateSemantics）
 * @returns {Promise<{ok:boolean, skipped?:string, report?:object, file?:string, error?:string}>}
 */
async function refreshAutoSemantics(o = {}){
  const log = typeof o.log === 'function' ? o.log : () => {};
  try {
    if (!o.worker || !o.semanticDir) return { ok: false, skipped: 'no_worker_or_dir' };
    const all = await listTables(o.worker, o.tables);
    const bound = boundByRules(o.tables);
    const tables = all.filter(t => !bound.has(t.id));
    if (!tables.length) return { ok: true, skipped: 'no_tables' };
    const fp = fingerprint(tables);
    const prev = readPrevious(o.semanticDir);
    const pm = (prev && prev._meta) || {};
    // 表结构没变就不重跑；例外：上次没有模型、词典又没认全，这次有模型了 → 补跑一次起名
    const wantNaming = typeof o.namer === 'function' && pm.namer_used === false && Number(pm.unnamed || 0) > 0;
    if (!o.force && prev && pm.schema_fp === fp && !wantNaming) return { ok: true, skipped: 'unchanged' };

    const run = async sql => rowsOf(await o.worker.call('semanticQuery', { sql }, 30000));
    const namer = wrapNamer(o.namer, tables);
    const build = { tables: tables.map(t => ({ name: t.name, columns: t.columns, currency:t.currency, dateCol:t.dateCol })), run, namer, previous: prev };
    if (o.maxNamerCalls != null) build.maxNamerCalls = o.maxNamerCalls;
    const { pack, report } = await buildAutoPack(build);

    pack._meta.schema_fp = fp;
    pack._meta.namer_used = !!report.model_called;
    pack._meta.unnamed = report.unnamed;
    // 库里实际的名字 ↔ 显示名：语义层绑定时按这个给表起一个 v_<id> 的别名（agent.js 的表清单会读）
    // 10-24：日期列怎么读的、有没有人确认过（date_confirmed:false = 月/日/年是默认值，答案里要标「日期顺序待确认」，那边读这里）
    const dateCols = {};
    for (const t of tables) for (const c of t.columns) if (c.dfmt) dateCols[t.name + '.' + c.name] = { format: c.dfmt, confirmed: c.date_confirmed !== false };
    if (Object.keys(dateCols).length) pack._meta.date_columns = dateCols;
    pack._meta.physical = tables.map(t => ({ name: t.name, id: t.id, display: t.display }));
    report.physical_tables = tables.length;

    const dir = path.join(o.semanticDir, 'generated');
    fs.mkdirSync(dir, { recursive: true });
    const file = packFile(o.semanticDir), tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(pack, null, 2));
    fs.renameSync(tmp, file);                         // 先写临时文件再改名，读的人不会读到半截
    try { if (o.state && typeof o.state.event === 'function') o.state.event('auto_semantics', report); } catch (_) {}
    try { if (typeof o.reload === 'function') o.reload(); } catch (err) { log('auto-semantics reload', err && err.message); }
    return { ok: true, report, file, pack };
  } catch (err) {
    log('auto-semantics', err && err.message);
    return { ok: false, error: String(err && err.message || err).slice(0, 200) };
  }
}

/** 语义层绑定用：自动语义包里登记的 v_<id> 表，补成和原表同 id / 同列的别名表（原表不动） */
function physicalAliases(semanticDir, tables){
  try {
    const meta = (readPrevious(semanticDir) || {})._meta || {};
    const byId = new Map((tables || []).map(t => [t.id, t]));
    return (meta.physical || []).filter(p => byId.has(p.id)).map(p => Object.assign({}, byId.get(p.id), { name: p.name }));
  } catch (_) { return []; }
}

/**
 * 模型起名：包一层 AgentHub 的 resolveIR（lane:'naming' → ir-prompt 会走 auto-semantics.buildNamerMessages）。
 * 没配 / 没连接模型返回 null（refreshAutoSemantics 会只用词典）。
 */
function makeHubNamer(agentHub){
  try {
    if (!agentHub) return null;
    const { createHubResolver, activeHubTarget } = require('./ask-service');
    const t = activeHubTarget(agentHub);
    if (!t.agentId || !t.model) return null;
    // 起名一次要输出一批列名，默认的 320 字太短；其余（超时、不开长思考）沿用问数的设置
    const resolve = createHubResolver({ agentHub, agentId: t.agentId, model: t.model, maxOutputTokens: 4000 });
    const av = resolve.available && resolve.available();
    if (av && av.ok === false) return null;
    return async payload => {
      const r = await resolve(Object.assign({}, payload, { lane: 'naming' }));
      if (!r || !r.ok) throw new Error((r && r.message) || '起名失败');
      return r.ir;
    };
  } catch (_) { return null; }
}

/**
 * 导入完成后的触发器：短时间内多次调用只跑最后一次（去抖），正在跑时再来的合并成下一次。
 * @param {Function} fn 每次要做的事（返回 Promise）
 */
function makeDebouncedRunner(fn, { wait = 3000 } = {}){
  let timer = null, running = null, again = false;
  const fire = async () => {
    timer = null;
    if (running) { again = true; return; }
    running = Promise.resolve().then(fn).catch(() => {}).finally(() => { running = null; if (again) { again = false; schedule(); } });
    return running;
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(fire, wait); if (timer.unref) timer.unref(); };
  return { trigger: schedule, flush: async () => { if (timer) { clearTimeout(timer); timer = null; } await fire(); return running; } };
}

module.exports = { refreshAutoSemantics, makeHubNamer, makeDebouncedRunner, physicalAliases, listTables, fingerprint, boundByRules, wrapNamer };
