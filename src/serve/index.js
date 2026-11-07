'use strict';
// rc.6 `estratto serve`: a small local HTTP service (127.0.0.1 only) over one workspace.
// Defences, in order, on every request: Host header (DNS rebinding) -> Origin -> (for /api) session token -> role (owner / asker).
// Bodies are never logged; error messages never echo request bodies; every response goes through the workspace redactor.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ConfigError } = require('../workspace.js');
const pkg = require('../../package.json');

const MAX_BODY = 64 * 1024;
const MAX_QUESTION = 2000;
const RID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.map': 'application/json; charset=utf-8' };
const EDITABLE = {
  data: ['refresh', 'refreshMinutes', 'maxRowsPerTable'],
  model: ['provider', 'baseURL', 'model', 'thinking'],
  limits: ['maxCallsPerQuestion', 'maxCallsTotal', 'maxTokensPerQuestion', 'maxOutputTokens', 'dailyBudgetUSD', 'price'],
  privacy: ['hiddenColumns'],
  behavior: ['reuse', 'sqlFallback', 'vectors', 'timezone', 'anchor', 'language'],
};

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(sha(a), sha(b));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonSafe = (k, v) => typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v;
const isAccept = c => c === true || c === 'accept' || (c && typeof c === 'object' && c.id === 'accept');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_BODY) { reject(new HttpError(413, 'too_large', 'request body too large')); req.resume(); return; }
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new HttpError(413, 'too_large', 'request body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new HttpError(400, 'bad_request', 'could not read the request')));
  });
}
async function jsonBody(req, { required = true } = {}) {
  const raw = await readBody(req);
  if (!raw.trim()) { if (required) throw new HttpError(400, 'bad_json', 'a JSON body is required'); return {}; }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'unsupported_media_type', 'send Content-Type: application/json');
  let v; try { v = JSON.parse(raw); } catch (_) { throw new HttpError(400, 'bad_json', 'the body is not valid JSON'); }   // never echo the text (it may hold a key)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad_json', 'the body must be a JSON object');
  return v;
}

async function startServe(ws, opts = {}) {
  const cfg0 = ws.config;
  const wantPort = opts.port != null ? Number(opts.port) : cfg0.surfaces.serve.port;
  const uiDir = path.resolve(opts.uiDir || path.join(__dirname, '..', '..', 'ui'));
  const sessionToken = opts.sessionToken || crypto.randomBytes(24).toString('base64url');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  let port = 0;
  // rc.8: import progress for the settings page (owner polls /api/data/progress while an add / refresh request is running)
  const progress = []; let progressSeq = 0;
  const offProgress = typeof ws.on === 'function' ? ws.on(e => {
    if (!e || !['import_start', 'import_progress', 'import_table', 'import_warning', 'data_refreshed'].includes(e.type)) return;
    progress.push({ seq: ++progressSeq, type: e.type, table: e.table || null, rows: e.rows == null ? null : e.rows, rowsTotal: e.rowsTotal == null ? null : e.rowsTotal, reason: e.reason || null, column: e.column || null, note: e.type === 'import_warning' ? (e.note || null) : null });
    if (progress.length > 500) progress.shift();
  }) : () => {};

  const selfOrigins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const allowedOrigins = () => selfOrigins().concat(ws.config.surfaces.serve.allowedOrigins || []).concat(opts.allowedOrigins || []);
  const hostOk = h => { const x = String(h || '').toLowerCase(); return x === `127.0.0.1:${port}` || x === `localhost:${port}`; };

  function baseHeaders(res, type, extra = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (type) res.setHeader('Content-Type', type);
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }
  function cors(req, res) {
    const o = req.headers.origin;
    if (o && allowedOrigins().includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-estratto-token, x-estratto-owner');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }
  function send(res, status, obj) {
    const body = JSON.stringify(ws.redact.deep(obj), jsonSafe);
    if (!res.headersSent) { baseHeaders(res, 'application/json; charset=utf-8'); res.statusCode = status; }
    res.end(body);
  }
  const sendErr = (res, e) => {
    if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    if (e instanceof ConfigError) return send(res, 400, { error: { code: e.code || 'bad_config', message: e.message } });
    log('internal error: ' + String(e && e.message || e).slice(0, 200));
    return send(res, 500, { error: { code: 'internal', message: 'internal error' } });
  };

  // ---- pages ----
  const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  function page(res, { title, tag, script, attrs, lang }) {
    const have = fs.existsSync(path.join(uiDir, script)) && fs.statSync(path.join(uiDir, script)).isFile();
    const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const html = `<!doctype html>\n<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title>\n<style>:root{color-scheme:light dark}body{margin:0;padding:16px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#111418;color:#e8eaed}}main{max-width:880px;margin:0 auto}</style></head>\n<body><main>${have ? `<${tag}${a}></${tag}>` : `<p>The page component <code>/ui/${esc(script)}</code> is not installed in this build, so there is nothing to show here yet. The JSON API under <code>/api</code> still works.</p>`}</main>${have ? `\n<script type="module" src="/ui/${esc(script)}"></script>` : ''}</body></html>\n`;
    baseHeaders(res, 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
    res.statusCode = 200; res.end(html);
  }
  function plainPage(res, status, text) {
    baseHeaders(res, 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
    res.statusCode = status;
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Estratto</title><body style="font:15px system-ui;padding:16px"><p>${esc(text)}</p></body>`);
  }
  function staticFile(req, res, pathname) {
    let name = pathname.slice('/ui/'.length);
    try { name = decodeURIComponent(name); } catch (_) { return send(res, 404, { error: { code: 'not_found', message: 'not found' } }); }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return send(res, 404, { error: { code: 'not_found', message: 'not found' } });
    const type = TYPES[path.extname(name).toLowerCase()];
    if (!type) return send(res, 404, { error: { code: 'not_found', message: 'not found' } });
    let real;
    try {
      real = fs.realpathSync(path.join(uiDir, name));
      const rootReal = fs.realpathSync(uiDir);
      if (path.dirname(real) !== rootReal || !fs.statSync(real).isFile()) throw new Error('outside');
    } catch (_) { return send(res, 404, { error: { code: 'not_found', message: 'not found' } }); }
    cors(req, res);
    baseHeaders(res, type, { 'Cache-Control': 'no-cache' });
    res.statusCode = 200;
    res.end(fs.readFileSync(real));
  }

  // ---- API helpers ----
  const askShape = r => ({ requestId: r.requestId, status: r.status, answer: r.answer, answerLine: r.answerLine, facts: r.facts, route: r.route, confirm: r.confirm || null, refusal: r.refusal || null, meta: r.meta, usage: r.usage });
  const mapRuleErr = e => {
    if (e instanceof HttpError) return e;
    const code = e && e.code;
    if (code === 'already_confirmed' || code === 'not_confirmed' || code === 'already_rejected') return new HttpError(409, code, e.message);
    if (code === 'unknown_metric' || /no such patch|unknown/i.test(String(e && e.message))) return new HttpError(404, code || 'not_found', String(e.message).slice(0, 200));
    if (code === 'no_decider') return new HttpError(400, code, e.message);
    return new HttpError(400, code || 'rule_error', String(e && e.message || e).slice(0, 300));
  };
  function sourcesView(cfg, role) { return cfg.data.sources.map(s => role === 'owner' ? { ...s } : { type: s.type, name: s.path ? path.basename(s.path) : (s.name || s.database) }); }
  function tablesView(e, role) {
    const t = e.tables();
    if (role === 'owner') return t;
    return t.filter(x => !x.hidden && !x.excluded).map(x => ({ name: x.name, columns: x.columns.filter(c => !c.hidden && !c.excluded) }));
  }
  function usageView() { const u = ws.usage.today(); return { day: u.day, todayUSD: u.spentUSD, dailyBudgetUSD: u.limitUSD, callsToday: u.calls }; }
  function settingsView(cfg, role) {
    const e = ws.engine;
    const common = { role, apiKey: ws.keyStatus(), model: { provider: cfg.model.provider, model: cfg.model.model }, behavior: { language: cfg.behavior.language, timezone: cfg.behavior.timezone }, limits: { dailyBudgetUSD: cfg.limits.dailyBudgetUSD }, usage: usageView() };
    if (role !== 'owner') return common;
    return {
      ...common,
      data: { refresh: cfg.data.refresh, refreshMinutes: cfg.data.refreshMinutes, maxRowsPerTable: cfg.data.maxRowsPerTable, sources: sourcesView(cfg, role), lastRefreshAt: e.info().lastRefreshAt || null, updatedAt: e.info().dataUpdatedAt || null },
      rules: { mode: e.info().rules, packs: cfg.rules.packs },
      model: { ...cfg.model },
      limits: { ...cfg.limits },
      privacy: { hiddenColumns: cfg.privacy.hiddenColumns, tables: e.tables().map(t => ({ name: t.name, hidden: !!t.hidden, excluded: !!t.excluded, columns: t.columns.filter(c => !c.excluded).map(c => ({ name: c.name, type: c.type, hidden: !!c.hidden })) })).filter(t => !t.excluded) },
      behavior: { ...cfg.behavior },
      surfaces: { serve: { port: cfg.surfaces.serve.port, allowedOrigins: cfg.surfaces.serve.allowedOrigins }, mcp: { allowRuleChanges: cfg.surfaces.mcp.allowRuleChanges } },
      editable: EDITABLE,
    };
  }

  async function api(req, res, url, role) {
    const p = url.pathname, m = req.method;
    const owner = () => { if (role !== 'owner') throw new HttpError(403, 'owner_only', 'this needs the owner'); };
    const want = (method, pathname) => { if (p === pathname) { if (m !== method) throw new HttpError(405, 'method_not_allowed', 'use ' + method); return true; } return false; };

    if (want('GET', '/api/status')) {
      const cfg = ws.config, e = ws.engine, info = e.info();
      const u = ws.usage.today();
      return send(res, 200, { name: cfg.name, version: pkg.version, engine: info.version, role, language: cfg.behavior.language, timezone: cfg.behavior.timezone, rules: info.rules, sources: sourcesView(cfg, role), tables: tablesView(e, role), model: role === 'owner' ? { provider: cfg.model.provider, model: cfg.model.model, baseURL: cfg.model.baseURL } : { provider: cfg.model.provider, model: cfg.model.model }, apiKey: ws.keyStatus(), usage: { day: u.day, todayUSD: u.spentUSD, dailyBudgetUSD: u.limitUSD }, lastDataRefresh: info.lastRefreshAt || null, dataUpdatedAt: info.dataUpdatedAt || null, dataRefresh: cfg.data.refresh });
    }
    if (want('POST', '/api/ask')) {
      const b = await jsonBody(req);
      const q = typeof b.question === 'string' ? b.question.trim() : '';
      if (!q) throw new HttpError(400, 'bad_question', 'question must be a non-empty string');
      if (q.length > MAX_QUESTION) throw new HttpError(400, 'bad_question', 'question is too long (max ' + MAX_QUESTION + ' characters)');
      if (b.requestId != null && !(typeof b.requestId === 'string' && RID_RE.test(b.requestId))) throw new HttpError(400, 'bad_request_id', 'requestId must be 1-80 characters: letters, digits, _ . : -');
      const rid = b.requestId || 'req_' + crypto.randomUUID();
      res.on('close', () => { if (!res.writableEnded) ws.cancel(rid); });   // the caller went away: stop the model call and the SQL
      const r = await ws.ask(q, { requestId: rid });
      return send(res, 200, askShape(r));
    }
    if (want('POST', '/api/cancel')) {
      const b = await jsonBody(req);
      if (typeof b.requestId !== 'string' || !RID_RE.test(b.requestId)) throw new HttpError(400, 'bad_request_id', 'requestId is required');
      return send(res, 200, { requestId: b.requestId, cancelled: !!ws.cancel(b.requestId) });
    }
    if (want('POST', '/api/confirm')) {
      const b = await jsonBody(req);
      if (typeof b.requestId !== 'string' || !RID_RE.test(b.requestId)) throw new HttpError(400, 'bad_request_id', 'requestId is required');
      if (!('choice' in b)) throw new HttpError(400, 'bad_choice', 'choice is required');
      if (isAccept(b.choice)) owner();   // accepting a plan can confirm auto-generated rules: that is a rule change
      let r; try { r = await ws.confirm(b.requestId, b.choice); } catch (e) { throw new HttpError(400, 'confirm_failed', String(e && e.message || e).slice(0, 300)); }
      return send(res, 200, askShape(r));
    }
    if (want('GET', '/api/rules')) {
      return send(res, 200, await ws.use(async e => {
        const all = e.rules.list();
        return { mode: e.info().rules, metrics: e.rules.metrics(), dimensions: e.rules.dimensions(), records: all.filter(x => x.kind === 'auto_confirm'), patches: all.filter(x => x.kind !== 'auto_confirm') };
      }));
    }
    let mt;
    if ((mt = /^\/api\/rules\/([^/]+)\/(preview|confirm|reject|revert)$/.exec(p))) {
      let id; try { id = decodeURIComponent(mt[1]); } catch (_) { throw new HttpError(400, 'bad_id', 'bad id'); }
      if (id.length > 200 || /[\u0000-\u001f]/.test(id)) throw new HttpError(400, 'bad_id', 'bad id');
      const act = mt[2];
      if (act === 'preview') {
        if (m !== 'GET') throw new HttpError(405, 'method_not_allowed', 'use GET');
        let pv; try { pv = await ws.use(e => e.rules.preview(id)); } catch (e) { throw mapRuleErr(e); }
        if (pv && pv.kind === 'dimension') owner();   // rc.7: a dimension preview lists real values (top 5): the owner's eyes only
        return send(res, 200, pv);
      }
      if (m !== 'POST') throw new HttpError(405, 'method_not_allowed', 'use POST');
      owner();
      await jsonBody(req, { required: false });
      try { return send(res, 200, await ws.use(e => e.rules[act](id, { by: 'host' }))); } catch (e) { throw mapRuleErr(e); }
    }
    if (p === '/api/settings/key') {
      if (m !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'use PUT');
      owner();
      const b = await jsonBody(req);
      if (Object.keys(b).some(k => k !== 'apiKey')) throw new HttpError(400, 'bad_settings', 'only apiKey is accepted here');
      if (typeof b.apiKey !== 'string') throw new HttpError(400, 'bad_key', 'apiKey must be a string (empty clears it)');
      return send(res, 200, { apiKey: await ws.setApiKey(b.apiKey) });
    }
    if (p === '/api/settings') {
      if (m === 'GET') return send(res, 200, settingsView(ws.config, role));
      if (m !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'use GET or PUT');
      owner();
      const b = await jsonBody(req);
      for (const k of Object.keys(b)) {
        if (!EDITABLE[k]) throw new HttpError(403, 'not_editable', `settings.${k} cannot be changed here`);
        if (!b[k] || typeof b[k] !== 'object' || Array.isArray(b[k])) throw new HttpError(400, 'bad_settings', `${k} must be an object`);
        for (const kk of Object.keys(b[k])) if (!EDITABLE[k].includes(kk)) throw new HttpError(403, 'not_editable', `settings.${k}.${kk} cannot be changed here`);
      }
      await ws.saveConfig(b);
      return send(res, 200, settingsView(ws.config, role));
    }
    if (want('POST', '/api/data/discover')) {
      owner();
      const b = await jsonBody(req);
      if (!Array.isArray(b.paths) || !b.paths.length || b.paths.length > 20 || b.paths.some(x => typeof x !== 'string' || !x || x.length > 1000)) throw new HttpError(400, 'bad_paths', 'paths must be a list of 1-20 folder or file paths');
      const clamp = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
      const found = await ws.discover(b.paths, { maxDepth: clamp(b.maxDepth, 0, 6, 4), maxFiles: clamp(b.maxFiles, 1, 5000, 5000) });
      return send(res, 200, { candidates: found, skipped: found.skipped.slice(0, 100), truncated: found.truncated });
    }
    if (want('POST', '/api/data/test-connection')) {
      owner();
      const b = await jsonBody(req);
      if (!b.source || typeof b.source !== 'object' || Array.isArray(b.source)) throw new HttpError(400, 'bad_source', 'source is required');
      let r;
      try { r = await ws.listSourceTables(b.source); }
      catch (e) { if (e instanceof ConfigError) throw e; throw new HttpError(400, 'connection_failed', String(e && e.message || e).slice(0, 400)); }
      return send(res, 200, { ok: true, tables: r.tables, maxRowsPerTable: ws.config.data.maxRowsPerTable });
    }
    if (want('GET', '/api/data/progress')) {
      owner();
      const since = Number(url.searchParams.get('since')) || 0;
      return send(res, 200, { events: progress.filter(x => x.seq > since), last: progressSeq });
    }
    if (want('POST', '/api/data/add')) {
      owner();
      const b = await jsonBody(req);
      let items;
      if (b.source != null) items = [b.source];
      else if (Array.isArray(b.sources) && b.sources.length) items = b.sources;
      else if (typeof b.path === 'string' && b.path) items = [b.path];
      else throw new HttpError(400, 'bad_path', 'path or source is required');
      if (items.length > 50) throw new HttpError(400, 'too_many', 'at most 50 sources at once');
      const before = new Set(ws.config.data.sources.map(x => JSON.stringify(x)));
      await ws.addSources(items);
      const cfg = ws.config;
      const changed = cfg.data.sources.filter(x => !before.has(JSON.stringify(x)));
      const owns = t => changed.some(x => x.path ? (t.source === x.path || String(t.source).startsWith(x.path + '#') || String(t.source).startsWith(x.path + path.sep)) : String(t.source).includes(path.sep + x.id + '.source'));
      const summary = await ws.dataSummary();
      return send(res, 200, { sources: sourcesView(cfg, role), tables: tablesView(ws.engine, role), imported: summary.filter(owns).map(({ source, ...t }) => t), summary: summary.map(({ source, ...t }) => t) });
    }
    if (want('POST', '/api/data/refresh')) {
      owner();   // rc.8: a refresh can snapshot remote Postgres/MySQL sources: owner only
      await jsonBody(req, { required: false });
      const r = await ws.refreshData();
      return send(res, 200, { ...r, lastDataRefresh: ws.engine.info().lastRefreshAt || null, dataUpdatedAt: ws.engine.info().dataUpdatedAt || null });
    }
    if (want('GET', '/api/usage')) {
      const u = ws.usage.today();
      const out = { day: u.day, todayUSD: u.spentUSD, dailyBudgetUSD: u.limitUSD, callsToday: u.calls, totalUSD: ws.usage.totalUSD() };
      if (role === 'owner') out.entries = ws.usage.list(50).map(x => ({ at: x.at, requestId: x.requestId, model: x.model, usage: x.usage, costUSD: x.costUSD }));
      return send(res, 200, out);
    }
    throw new HttpError(404, 'not_found', 'not found');
  }

  async function handler(req, res) {
    try {
      // 1. Host: only the loopback name with our port (blocks DNS rebinding)
      if (!hostOk(req.headers.host)) return send(res, 403, { error: { code: 'bad_host', message: 'host not allowed' } });
      if (!req.url || req.url[0] !== '/') return send(res, 400, { error: { code: 'bad_request', message: 'bad request target' } });
      let url; try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return send(res, 400, { error: { code: 'bad_request', message: 'bad request target' } }); }
      const isApi = url.pathname.startsWith('/api/');
      const isUi = url.pathname.startsWith('/ui/');
      // 2. Origin: absent, or one we allow
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins().includes(origin)) return send(res, 403, { error: { code: 'bad_origin', message: 'origin not allowed' } });
      if (isApi) cors(req, res);
      if (req.method === 'OPTIONS') {
        if (!isApi && !isUi) return send(res, 404, { error: { code: 'not_found', message: 'not found' } });
        baseHeaders(res); res.statusCode = 204; return res.end();
      }
      if (isUi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: { code: 'method_not_allowed', message: 'use GET' } });
        return staticFile(req, res, url.pathname);
      }
      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: { code: 'method_not_allowed', message: 'use GET' } });
        if (origin !== undefined && !selfOrigins().includes(origin)) return send(res, 403, { error: { code: 'bad_origin', message: 'origin not allowed' } });   // pages are never shared cross-origin
        const cfg = ws.config;
        if (url.pathname === '/') return page(res, { title: 'Estratto', tag: 'estratto-ask', script: 'estratto-ask.js', lang: cfg.behavior.language, attrs: { endpoint: 'http://' + req.headers.host, token: sessionToken, lang: cfg.behavior.language } });
        if (url.pathname === '/settings') {
          if (!same(url.searchParams.get('owner') || '', cfg.access.ownerToken)) return plainPage(res, 403, cfg.behavior.language === 'en' ? 'Open the settings link printed by "estratto serve" (it carries the owner key).' : '请使用 estratto serve 启动时打印的设置链接打开（链接里带有所有者密钥）。');
          return page(res, { title: 'Estratto', tag: 'estratto-settings', script: 'estratto-settings.js', lang: cfg.behavior.language, attrs: { endpoint: 'http://' + req.headers.host, token: sessionToken, 'owner-token': cfg.access.ownerToken, lang: cfg.behavior.language } });
        }
        return send(res, 404, { error: { code: 'not_found', message: 'not found' } });
      }
      // 3. token
      if (!same(String(req.headers['x-estratto-token'] || ''), sessionToken)) return send(res, 401, { error: { code: 'bad_token', message: 'missing or wrong X-Estratto-Token' } });
      // 4. role
      const oh = req.headers['x-estratto-owner'];
      const role = typeof oh === 'string' && same(oh, ws.config.access.ownerToken) ? 'owner' : 'asker';
      await api(req, res, url, role);
    } catch (e) {
      if (!res.headersSent) sendErr(res, e); else try { res.end(); } catch (_) {}
    } finally {
      log(`${req.method} ${String(req.url || '').split('?')[0].slice(0, 120)} -> ${res.statusCode}`);
    }
  }

  const server = http.createServer(handler);
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(wantPort, '127.0.0.1', resolve); });
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    port, url: base, sessionToken, server,
    settingsUrl: `${base}/settings?owner=${encodeURIComponent(ws.config.access.ownerToken)}`,
    close: () => new Promise(resolve => { try { offProgress(); } catch (_) {} server.close(() => resolve()); try { server.closeAllConnections(); } catch (_) {} }),
  };
}

module.exports = { startServe, EDITABLE };
