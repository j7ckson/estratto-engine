// 预览用假服务:node ui/mock-server.mjs [port]  → http://127.0.0.1:7318/preview.html
// 不依赖引擎,只假装 /api/*,数据是虚构的电商样例。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 7318);
const TOKEN = 'demo-token', OWNER = 'demo-owner';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.md': 'text/plain; charset=utf-8' };

const settings = {
  data: { refresh: 'auto', sources: [{ type: 'folder', path: '/Users/demo/exports', pattern: '*.csv' }, { type: 'file', path: '/Users/demo/refunds.csv' }], lastRefreshAt: new Date(Date.now() - 3600e3).toISOString(), updatedAt: new Date(Date.now() - 7200e3).toISOString() },
  rules: { mode: 'auto', packs: [] },
  model: { provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4.1-flash', thinking: 'disabled' },
  limits: { dailyBudgetUSD: 1.0, maxCallsPerQuestion: 2 },
  privacy: { hiddenColumns: ['orders.customer_email'] },
  behavior: { language: 'zh', timezone: 'Asia/Shanghai', reuse: true }
};
let apiKey = 'set';
const tables = [
  { name: 'orders', rows: 48213, columns: [{ name: 'order_id', type: 'VARCHAR' }, { name: 'order_date', type: 'DATE' }, { name: 'sku', type: 'VARCHAR' }, { name: 'amount', type: 'DOUBLE' }, { name: 'customer_email', type: 'VARCHAR' }, { name: 'country', type: 'VARCHAR' }] },
  { name: 'refunds', rows: 1920, columns: [{ name: 'refund_id', type: 'VARCHAR' }, { name: 'order_id', type: 'VARCHAR' }, { name: 'refund_amount', type: 'DOUBLE' }, { name: 'reason', type: 'VARCHAR' }] },
  { name: 'inventory', rows: 612, columns: [{ name: 'sku', type: 'VARCHAR' }, { name: 'on_hand', type: 'INTEGER' }, { name: 'warehouse', type: 'VARCHAR' }] }
];
const withHidden = () => tables.map(t => ({ name: t.name, columns: t.columns.map(c => ({ ...c, hidden: settings.privacy.hiddenColumns.includes(`${t.name}.${c.name}`) })) }));
const rules = [
  { id: 'm:au_orders_amount', name: '销售额', kind: 'simple', unit: '元', dataset: 'orders', field: 'amount', formula: 'orders 表 amount 合计', status: 'unconfirmed', recordId: null, auto: true },
  { id: 'm:au_orders_order_id', name: '订单数', kind: 'simple', unit: '单', dataset: 'orders', field: 'order_id', formula: 'orders 表 order_id 去重计数', status: 'unconfirmed', recordId: null, auto: true },
  { id: 'm:au_aov', name: '客单价', kind: 'ratio', unit: '元', dataset: 'orders', field: 'amount', formula: '销售额 ÷ 订单数', status: 'unconfirmed', recordId: null, auto: true },
  { id: 'm:au_refunds_amount', name: '退款额', kind: 'simple', unit: '元', dataset: 'refunds', field: 'refund_amount', formula: 'refunds 表 refund_amount 合计', status: 'unconfirmed', recordId: null, auto: true },
  { id: 'm:au_inventory_on_hand', name: '库存件数', kind: 'simple', unit: '件', dataset: 'inventory', field: 'on_hand', formula: 'inventory 表 on_hand 合计', status: 'unconfirmed', recordId: null, auto: true },
  { id: 'm:au_refund_rate', name: '退款率', kind: 'ratio', unit: '%', dataset: 'refunds', field: 'refund_amount', formula: '退款额 ÷ 销售额', status: 'unconfirmed', recordId: null, auto: true },
  { id: 'm:au_orders_shipping', name: '运费', kind: 'simple', unit: '元', dataset: 'orders', field: 'shipping', formula: 'orders 表 shipping 合计', status: 'confirmed', recordId: 'ac_1', auto: true },
  { id: 'm:pack_gmv', name: '毛销售额', kind: 'derived', unit: '元', dataset: 'orders', field: 'amount', formula: '销售额 + 运费', status: 'provided', recordId: null, auto: false },
  { id: 'm:au_orders_sku', name: 'SKU 数', kind: 'simple', unit: '个', dataset: 'orders', field: 'sku', formula: 'orders 表 sku 去重计数', status: 'rejected', recordId: null, auto: true }
];
const previews = {
  'm:au_orders_amount': { total: 18432650.4, lastMonth: { period: '2026-10', value: 1386420.8 }, decimals: 2 },
  'm:au_orders_order_id': { total: 48213, lastMonth: { period: '2026-10', value: 3611 }, decimals: 0 },
  'm:au_aov': { total: 382.3, lastMonth: { period: '2026-10', value: 383.9 }, decimals: 2 },
  'm:au_refunds_amount': { total: 612480.1, lastMonth: { period: '2026-10', value: 47210.5 }, decimals: 2 },
  'm:au_inventory_on_hand': { total: 23870, lastMonth: null, decimals: 0 },
  'm:au_refund_rate': { total: 3.32, lastMonth: { period: '2026-10', value: 3.4 }, decimals: 2 }
};
const meta = { dataStamp: 'ds_demo', ruleVersion: 'rv1', codeVersion: '1.0.0-rc.8', anchor: '2026-11-05', checks: [{ name: 'plan_validation', result: 'pass' }] };
const F = (id, label, value, unit, extra = {}) => ({ id, label, value, unit, display: Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 }), status: 'ok', period: null, tier: null, lane: null, source: { table: 'orders', field: 'amount' }, ...extra });

function answer(q, requestId) {
  const base = { requestId, route: 'plan', confirm: null, refusal: null, usage: { calls: 1, providerCalls: [], tokens: null }, meta };
  const lm = { period: { label: '2026-10' } };
  if (/各国|国家|分|对比/.test(q)) return { ...base, status: 'verified', answerLine: 'ANSWER: 上个月按国家分的销售额,英国最高(F1)', answer: 'ANSWER: 上个月按国家分的销售额,英国最高(F1)\n- 销售额按订单金额(orders.amount)合计,已排除取消的订单。\n- “上个月”指 2026-10-01 到 2026-10-31,时区 Asia/Shanghai。', facts: [
    F('F1', '英国', 612300.5, '元', lm), F('F2', '德国', 401280, '元', lm), F('F3', '法国', 198750.3, '元', lm), F('F4', '西班牙', 112340, '元', lm), F('F5', '其他', 61750, '元', lm)] };
  if (/确认|自动/.test(q)) return { ...base, status: 'needs_confirm', answerLine: '', answer: '', facts: [],
    confirm: { kind: 'plan', message: '这个问题用到一个自动认出的口径:销售额 = orders 表 amount 合计。要按它来吗?', options: [{ id: 'accept', label: '确认这个口径,并回答' }] } };
  if (/怎么算|口径/.test(q)) return { ...base, status: 'needs_confirm', route: 'sql', answerLine: '', answer: '', facts: [],
    confirm: { kind: 'value_choice', message: '“英国”在数据里有两种写法,你指的是哪一个?', options: [{ value: 'UK', literal: 'UK', dim: 'country', table: 'orders', column: 'country' }, { value: 'United Kingdom', literal: 'United Kingdom', dim: 'country', table: 'orders', column: 'country' }] } };
  if (/客户|邮箱/.test(q)) return { ...base, status: 'refused', route: 'local', answerLine: 'ANSWER: 客户邮箱已被屏蔽,所以没办法按它来统计。', answer: 'ANSWER: 客户邮箱已被屏蔽,所以没办法按它来统计。', facts: [], refusal: { code: 'outbound_blocked', reason: '涉及被屏蔽的列 orders.customer_email' } };
  if (/预算|花费/.test(q)) return { ...base, status: 'refused', route: 'local', answerLine: 'ANSWER: budget', answer: 'ANSWER: budget', facts: [], refusal: { code: 'daily_budget_exceeded', spentUSD: 1.02, limitUSD: 1, day: '2026-11-05' } };
  if (/库存|未核/.test(q)) return { ...base, status: 'unverified', answerLine: 'ANSWER: 目前库存一共 23,870 件(F1)', answer: 'ANSWER: 目前库存一共 23,870 件(F1)', facts: [F('F1', '库存件数', 23870, '件', { source: { table: 'inventory', field: 'on_hand' } })], meta: { ...meta, checks: [{ name: 'plan_validation', result: 'not_executed' }] } };
  if (/2019|没有|空/.test(q)) return { ...base, status: 'no_data', answerLine: 'ANSWER: 数据里没有 2019 年的订单。', answer: 'ANSWER: 数据里没有 2019 年的订单。', facts: [] };
  return { ...base, status: 'verified', answerLine: 'ANSWER: 上个月(2026-10)销售额是 1,386,420.8 元(F1)', answer: 'ANSWER: 上个月(2026-10)销售额是 1,386,420.8 元(F1)\n- 销售额按订单金额(orders.amount)合计,已排除取消的订单。\n- “上个月”指 2026-10-01 到 2026-10-31,时区 Asia/Shanghai。', facts: [F('F1', '上个月销售额', 1386420.8, '元', lm)] };
}

const pending = new Map();
const progressLog = []; let progressSeq = 0;
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (u.pathname === '/__reset') {
    if (!globalThis.__t0) globalThis.__t0 = structuredClone(tables); // 预览用:?mode=empty 清空 / ?mode=many 造一长串 / 默认还原
    const mode = u.searchParams.get('mode') || '';
    settings.data.sources = [{ type: 'folder', path: '/Users/demo/exports', pattern: '*.csv' }, { type: 'file', path: '/Users/demo/refunds.csv' }];
    tables.splice(0, tables.length, ...structuredClone(globalThis.__t0));
    if (mode === 'empty') { settings.data.sources = []; tables.length = 0; }
    if (mode === 'many') {
      for (let i = 1; i <= 7; i++) settings.data.sources.push({ type: 'file', path: `/Users/demo/exports/orders-2026-0${i}.csv` });
      settings.data.sources.push({ type: 'postgres', host: 'db.example.com', port: 5432, database: 'shop', schema: 'public', id: 'shop', tables: ['orders', 'refunds', 'v_daily_sales'] }, { type: 'sqlite', path: '/Users/demo/shop.db', tables: ['customers', 'inventory', 'shipments'] });
      for (let i = 1; i <= 7; i++) tables.push({ name: `orders_2026_0${i}`, rows: 3000 + i * 111, columns: [{ name: 'amount', type: 'DOUBLE' }] });
      for (const n of ['orders', 'refunds', 'v_daily_sales']) tables.push({ name: `shop__${n}`, rows: 1000, columns: [{ name: 'amount', type: 'DOUBLE' }] });
      for (const n of ['customers', 'inventory', 'shipments']) tables.push({ name: `shop__${n}`, rows: 900, columns: [{ name: 'id', type: 'INTEGER' }] });
    }
    res.writeHead(200); return res.end('ok');
  }
  if (u.pathname.startsWith('/api/')) {
    if (req.headers['x-estratto-token'] !== TOKEN) return json(res, 401, { error: '令牌不对' });
    const owner = req.headers['x-estratto-owner'] === OWNER;
    const p = u.pathname, b = req.method === 'GET' ? {} : await body(req);
    const err = (code, status, message) => json(res, status, { error: { code, message } });
    const usage = { day: '2026-11-05', todayUSD: 0.62, dailyBudgetUSD: settings.limits.dailyBudgetUSD };
    if (p === '/api/status') return json(res, 200, { name: 'sales', version: '1.0.0-rc.8', engine: 'estratto-engine@1.0.0-rc.8', role: owner ? 'owner' : 'asker', language: 'zh', timezone: 'Asia/Shanghai', rules: 'auto',
      sources: owner ? settings.data.sources : settings.data.sources.map(x => ({ type: x.type, name: x.path ? x.path.split('/').pop() : (x.name || x.database) })),
      tables: (owner ? withHidden() : withHidden().map(t => ({ ...t, columns: t.columns.filter(c => !c.hidden) }))).map(t => ({ ...t, rows: tables.find(x => x.name === t.name).rows })),
      model: owner ? settings.model : { provider: settings.model.provider, model: settings.model.model }, apiKey, usage, lastDataRefresh: settings.data.lastRefreshAt, dataUpdatedAt: settings.data.updatedAt, dataRefresh: 'auto' });
    if (p === '/api/ask') {
      await sleep(/慢/.test(b.question) ? 8000 : 900);
      if (/报错|error/.test(b.question)) return err('internal', 500, '模型服务暂时连不上(演示用的假错误)');
      if (pending.get(b.requestId) === 'cancel') { pending.delete(b.requestId); return json(res, 200, { requestId: b.requestId, status: 'cancelled', answerLine: '', answer: '', facts: [], route: 'plan', confirm: null, refusal: null, meta, usage: { calls: 0 } }); }
      return json(res, 200, answer(b.question || '', b.requestId || 'r1'));
    }
    if (p === '/api/cancel') { pending.set(b.requestId, 'cancel'); return json(res, 200, { requestId: b.requestId, cancelled: true }); }
    if (p === '/api/confirm') {
      if (b.choice === 'accept' && !owner) return err('owner_only', 403, '只有口径负责人能这样确认');
      await sleep(500);
      const r = answer('上个月销售额', b.requestId); return json(res, 200, b.choice === 'UK' || b.choice === 'United Kingdom' ? { ...r, answerLine: `ANSWER: 上个月 ${b.choice} 的销售额是 612,300.5 元(F1)`, answer: `ANSWER: 上个月 ${b.choice} 的销售额是 612,300.5 元(F1)\n- 只统计 country = ${b.choice} 的订单。`, facts: [F('F1', `${b.choice} 销售额`, 612300.5, '元', { period: { label: '2026-10' } })] } : r);
    }
    if (p === '/api/rules') return json(res, 200, { mode: 'auto', metrics: rules, records: [], patches: [] });
    let m = p.match(/^\/api\/rules\/([^/]+)\/(preview|confirm|reject|revert)$/);
    if (m) {
      const id = decodeURIComponent(m[1]); const r = rules.find(x => x.id === id || x.id === 'm:' + id); if (!r) return err('unknown_metric', 404, '没有这个指标');
      if (m[2] === 'preview') { await sleep(300); return json(res, 200, { id: r.id, label: r.name, formula: r.formula, unit: r.unit, ...previews[r.id] }); }
      if (!owner) return err('owner_only', 403, '只有口径负责人能修改');
      if (m[2] === 'confirm') r.status = 'confirmed'; else if (m[2] === 'reject') r.status = r.status === 'confirmed' ? 'reverted' : 'rejected'; else r.status = r.status === 'rejected' ? 'unconfirmed' : 'reverted';
      return json(res, 200, { id: r.id, kind: 'metric', status: r.status });
    }
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, owner
      ? { role: 'owner', apiKey, data: settings.data, rules: settings.rules, model: settings.model, limits: settings.limits, privacy: { hiddenColumns: settings.privacy.hiddenColumns, tables: withHidden().map(t => ({ ...t, hidden: false, excluded: false })) }, behavior: settings.behavior, usage: { ...usage, callsToday: 7 }, editable: {} }
      : { role: 'asker', apiKey, model: { provider: settings.model.provider, model: settings.model.model }, behavior: { language: 'zh', timezone: 'Asia/Shanghai' }, limits: { dailyBudgetUSD: settings.limits.dailyBudgetUSD }, usage });
    if (p === '/api/settings' && req.method === 'PUT') { if (!owner) return err('owner_only', 403, '只有口径负责人能修改'); for (const k of ['model', 'limits']) if (b[k]) Object.assign(settings[k], b[k]); if (b.privacy) settings.privacy.hiddenColumns = b.privacy.hiddenColumns; return json(res, 200, { role: 'owner' }); }
    if (p === '/api/settings/key') { if (!owner) return err('owner_only', 403, '只有口径负责人能修改'); apiKey = b.apiKey ? 'set' : 'not set'; return json(res, 200, { apiKey }); }
    if (p === '/api/data/discover') {
      if (!owner) return err('owner_only', 403, '只有口径负责人能修改');
      const ps = Array.isArray(b.paths) ? b.paths : [];
      if (!ps.length) return err('bad_paths', 400, '请至少给一个路径');
      if (ps.every(x => /nothing|空/.test(x))) return json(res, 200, { candidates: [], skipped: [], truncated: false });
      const base = '/Users/demo/data';
      const sk = ps.some(x => /\.ssh|secret/.test(x)) ? [{ path: '/Users/demo/.ssh', reason: 'credential_folder' }] : [{ path: base + '/.cache', reason: 'hidden_folder' }, { path: base + '/node_modules', reason: 'ignored_folder' }];
      return json(res, 200, { skipped: sk, truncated: false, candidates: [
        { kind: 'csv', path: base + '/orders-2026.csv', name: 'orders-2026.csv', size: 5242880, mtime: new Date().toISOString(), tables: [{ name: 'orders-2026', rows: 48213, columns: ['order_id', 'order_date', 'amount'], rowsApprox: true }] },
        { kind: 'xlsx', path: base + '/refunds.xlsx', name: 'refunds.xlsx', size: 183000, mtime: new Date().toISOString(), tables: [{ name: '2026', rows: 1500, columns: 4, sheet: true }, { name: '2025', rows: 420, columns: 4, sheet: true }] },
        { kind: 'sqlite', path: base + '/shop.db', name: 'shop.db', size: 18874368, mtime: new Date().toISOString(), tables: [{ name: 'customers', rows: 9120, columns: ['id', 'name'] }, { name: 'inventory', rows: 612, columns: ['sku', 'on_hand'] }, { name: 'shipments', rows: 30244, columns: ['id', 'shipped_at'] }] },
        { kind: 'parquet', path: base + '/archive/clicks.parquet', name: 'clicks.parquet', size: 73400320, mtime: new Date().toISOString(), tables: [{ name: 'clicks', rows: 2100000, columns: ['ts', 'sku'] }] },
        { kind: 'duckdb', path: base + '/old-warehouse.duckdb', name: 'old-warehouse.duckdb', size: 262144000, mtime: new Date().toISOString(), tables: [{ name: 'sales', rows: 100, columns: ['d', 'amount'] }] }
      ] });
    }
    if (p === '/api/data/test-connection') {
      if (!owner) return err('owner_only', 403, '只有口径负责人能修改');
      const s = b.source || {};
      if (!s.host || !s.database || !s.user) return err('bad_config', 400, '地址、数据库名和用户名都要填');
      if (/^bad/.test(s.host)) return err('connection_failed', 400, '连不上 ' + s.host + ':' + (s.port || 5432) + '(演示用的假错误)');
      if (s.password === 'wrong') return err('connection_failed', 400, 'password authentication failed for user "' + s.user + '"');
      return json(res, 200, { ok: true, maxRowsPerTable: 5000000, tables: [
        { name: 'orders', kind: 'table', rows: 48213, approx: false, columns: new Array(8).fill({}), overLimit: false },
        { name: 'refunds', kind: 'table', rows: 1920, approx: false, columns: new Array(4).fill({}), overLimit: false },
        { name: 'web_events', kind: 'table', rows: 7200000, approx: true, columns: new Array(6).fill({}), overLimit: true },
        { name: 'v_daily_sales', kind: 'view', rows: 640, approx: false, columns: new Array(3).fill({}), overLimit: false }
      ] });
    }
    if (p === '/api/data/progress') { if (!owner) return err('owner_only', 403, '只有口径负责人能修改'); const since = Number(u.searchParams.get('since')) || 0; return json(res, 200, { events: progressLog.filter(e => e.seq > since), last: progressSeq }); }
    if (p === '/api/data/add') {
      if (!owner) return err('owner_only', 403, '只有口径负责人能修改');
      const items = b.sources || (b.source ? [b.source] : (b.path ? [{ type: 'file', path: b.path }] : []));
      const names = [];
      for (const it of items) {
        if (it.type === 'sqlite') { const all = [['customers', 9120], ['inventory', 612], ['shipments', 30244]]; for (const [n, r] of all) if (!it.tables || it.tables.includes(n)) names.push(['shop__' + n, r]); }
        else if (it.host) { const base = it.database || 'db'; for (const n of it.tables || []) names.push([base + '__' + n, n === 'orders' ? 48213 : n === 'refunds' ? 1920 : 640]); }
        else names.push([(String(it.path || 'data').split('/').pop() || 'data').replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_'), 48213]);
        const key = x => x.host ? `${x.type}://${x.host}/${x.database}` : `${x.type}:${x.path}`;
        const entry = it.host ? { type: it.type, host: it.host, port: it.port || (it.type === 'mysql' ? 3306 : 5432), database: it.database, schema: it.schema, id: it.database, tables: it.tables } : { ...it };
        if (!settings.data.sources.some(x => key(x) === key(entry))) settings.data.sources.push(entry);
      }
      for (const [n, total] of names) {
        progressLog.push({ seq: ++progressSeq, type: 'import_start', table: n, rows: null, rowsTotal: total });
        for (let k = 1; k <= 4; k++) { await sleep(450); progressLog.push({ seq: ++progressSeq, type: 'import_progress', table: n, rows: Math.round(total * k / 4), rowsTotal: total }); }
        progressLog.push({ seq: ++progressSeq, type: 'import_table', table: n, rows: total, rowsTotal: null });
      }
      const imported = names.map(([n, r]) => ({ name: n, rows: r, columns: 6, dateColumn: /customers|inventory/.test(n) ? null : 'order_date', from: /customers|inventory/.test(n) ? null : '2025-01-02', to: /customers|inventory/.test(n) ? null : '2026-10-31' }));
      for (const x of imported) { const i = tables.findIndex(t => t.name === x.name); const row = { name: x.name, rows: x.rows, columns: [{ name: 'order_date', type: 'DATE' }, { name: 'amount', type: 'DOUBLE' }] }; if (i >= 0) tables[i] = row; else tables.push(row); }
      return json(res, 200, { sources: settings.data.sources, tables: [], imported, summary: imported });
    }
    if (p === '/api/data/refresh') return json(res, 200, { refreshed: false, files: [], tables: [], lastDataRefresh: new Date().toISOString(), dataUpdatedAt: settings.data.updatedAt });
    if (p === '/api/usage') return json(res, 200, { ...usage, callsToday: 7, totalUSD: 3.4 });
    return err('not_found', 404, 'not found');
  }
  let f = u.pathname === '/' ? '/preview.html' : u.pathname.replace(/^\/ui\//, '/');
  const full = path.join(dir, path.normalize(f));
  if (!full.startsWith(dir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`预览:http://127.0.0.1:${port}/preview.html  (令牌 ${TOKEN},负责人令牌 ${OWNER})`));
