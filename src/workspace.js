'use strict';
// rc.6 workspace: <home>/<name>/ with estratto.json (config), secrets.json (api key, 0600), usage.jsonl, and the engine's own data.
// Everything here is library code: it never reads process.env. The CLI shell passes `home` in.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fsx = require('./fsx.js');
const { createEngine } = require('./engine.js');
const { openaiCompatible } = require('./openai.js');
const { makeRedactor } = require('./redact.js');
const { createLedger } = require('./ledger.js');

const DEFAULT_PORT = 7317;
const PROVIDERS = {
  deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', thinking: 'disabled' },
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', thinking: 'none' },
  custom: { baseURL: '', model: '', thinking: 'none' },
};
const THINKING = ['disabled', 'false_bool', 'low', 'none'];
const FILE_EXT = ['.csv', '.tsv', '.xlsx', '.parquet'];
const DUCK_EXT = ['.duckdb', '.db', '.ddb'];
const SRC_TYPES = ['file', 'folder', 'duckdb', 'sqlite', 'postgres', 'mysql'];   // rc.8: sqlite / postgres / mysql
const REMOTE = ['postgres', 'mysql'];
const DEFAULT_REFRESH_MINUTES = 15;
const DEFAULT_MAX_ROWS = 5000000;
const ID_RE = /^[a-z][a-z0-9_]{2,31}$/;
const HOST_RE = /^[A-Za-z0-9._:%\[\]-]{1,253}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class ConfigError extends Error { constructor(msg, code = 'bad_config') { super(msg); this.code = code; } }
const bad = (msg, code) => { throw new ConfigError(msg, code); };
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);

const needHome = h => { if (typeof h !== 'string' || !h) bad('home is required (the CLI passes ~/.estratto by default)', 'no_home'); return path.resolve(h); };
function checkName(name) { if (typeof name !== 'string' || !NAME_RE.test(name)) bad('workspace name must be 1-64 characters: letters, digits, dot, dash, underscore (not starting with a symbol)', 'bad_name'); return name; }
function workspaceDir(home, name) { return path.join(needHome(home), checkName(name)); }
function listWorkspaces(home) {
  const h = needHome(home);
  try { return fs.readdirSync(h, { withFileTypes: true }).filter(e => e.isDirectory() && NAME_RE.test(e.name) && fs.existsSync(path.join(h, e.name, 'estratto.json'))).map(e => e.name).sort(); } catch (_) { return []; }
}

// ---- config schema (version 1) ----
const num = (v, p, { min = 0, max = Infinity, int = false, nullable = false } = {}) => {
  if (v == null && nullable) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) bad(`${p} must be ${int ? 'an integer' : 'a number'} between ${min} and ${max === Infinity ? 'infinity' : max}`);
  return v;
};
const str = (v, p, { max = 2000, empty = false } = {}) => {
  if (typeof v !== 'string' || (!empty && !v.length) || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) bad(`${p} must be a text without control characters${empty ? '' : ' (not empty)'}`);
  return v;
};
const bool = (v, p) => { if (typeof v !== 'boolean') bad(`${p} must be true or false`); return v; };
function only(o, allowed, p) { for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`unknown setting: ${p ? p + '.' : ''}${k}`); }
function origin(v, p) {
  let u; try { u = new URL(v); } catch (_) { bad(`${p} must be an origin like https://example.com`); }
  if (!/^https?:$/.test(u.protocol) || u.origin !== v) bad(`${p} must be an origin like https://example.com (no path, no trailing slash)`);
  return v;
}

// rc.7: a stable session token for `estratto serve` (default stays random per start). 16-200 URL-safe characters.
function serveToken(v, p) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9._~-]{16,200}$/.test(v)) bad(`${p} must be 16-200 characters: letters, digits, . _ ~ -`);
  return v;
}

const safeName = (v, fallback) => {
  let n = String(v == null ? '' : v).replace(/\.[^.]+$/, '').normalize('NFKC').replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
  if (!n) n = fallback || 'src';
  if (/^\d/.test(n)) n = 's_' + n;
  return Array.from(n).slice(0, 32).join('');
};
const tableList = (v, p, { required }) => {
  if (v == null) { if (required) bad(`${p} must list at least one table`); return null; }
  if (!Array.isArray(v) || (required && !v.length) || v.length > 2000) bad(`${p} must be a list of table names${required ? ' (not empty)' : ''}`);
  return [...new Set(v.map((t, i) => str(t, `${p}[${i}]`, { max: 200 })))];
};
/** one entry of data.sources; remote sources need an id (the key of their password in secrets.json) and never carry a password here */
function validateSource(s, p) {
  if (!isObj(s)) bad(`${p} must be an object`);
  if (!SRC_TYPES.includes(s.type)) bad(`${p}.type must be file, folder, duckdb, sqlite, postgres or mysql`);
  if (s.type === 'sqlite') {
    only(s, ['type', 'path', 'tables', 'name'], p);
    const f = str(s.path, `${p}.path`); if (!path.isAbsolute(f)) bad(`${p}.path must be an absolute path`);
    const o = { type: 'sqlite', path: f, name: s.name == null ? safeName(path.basename(f), 'sqlite') : safeName(str(s.name, `${p}.name`, { max: 64 })) };
    const t = tableList(s.tables, `${p}.tables`, { required: false }); if (t && t.length) o.tables = t;
    return o;
  }
  if (REMOTE.includes(s.type)) {
    only(s, s.type === 'postgres' ? ['type', 'id', 'name', 'host', 'port', 'database', 'user', 'schema', 'tables', 'ssl'] : ['type', 'id', 'name', 'host', 'port', 'database', 'user', 'tables', 'ssl'], p);
    if (s.id == null) bad(`${p}.id is required for a database source`);
    const id = str(s.id, `${p}.id`, { max: 32 }); if (!ID_RE.test(id)) bad(`${p}.id must be 3-32 characters: lowercase letters, digits, underscore`);
    const host = str(s.host, `${p}.host`, { max: 253 }); if (!HOST_RE.test(host)) bad(`${p}.host is not a valid host name or address`);
    const database = str(s.database, `${p}.database`, { max: 128 });
    const o = { type: s.type, id, name: s.name == null ? safeName(database, s.type) : safeName(str(s.name, `${p}.name`, { max: 64 })), host,
      port: s.port == null ? (s.type === 'postgres' ? 5432 : 3306) : num(s.port, `${p}.port`, { min: 1, max: 65535, int: true }), database, user: str(s.user, `${p}.user`, { max: 128 }) };
    if (s.type === 'postgres') o.schema = s.schema == null ? 'public' : str(s.schema, `${p}.schema`, { max: 128 });
    o.tables = tableList(s.tables, `${p}.tables`, { required: true });
    if (s.ssl != null && s.ssl !== false) { if (s.ssl !== true && s.ssl !== 'no-verify') bad(`${p}.ssl must be true, false or "no-verify"`); o.ssl = s.ssl; }
    return o;
  }
  only(s, ['type', 'path', 'pattern'], p);
  const f = str(s.path, `${p}.path`);
  if (!path.isAbsolute(f)) bad(`${p}.path must be an absolute path`);
  const o = { type: s.type, path: f };
  if (s.pattern != null) { if (s.type !== 'folder') bad(`${p}.pattern only applies to folders`); o.pattern = str(s.pattern, `${p}.pattern`, { max: 200 }); }
  return o;
}

/** @returns normalized config with defaults filled in; throws ConfigError naming the bad field */
function validateConfig(c0) {
  if (!isObj(c0)) bad('config must be an object');
  const c = c0;
  only(c, ['version', 'name', 'data', 'rules', 'model', 'limits', 'privacy', 'behavior', 'access', 'surfaces'], '');
  if (c.version !== 1) bad('config.version must be 1');
  const out = { version: 1, name: checkName(c.name) };

  const d = c.data == null ? {} : (isObj(c.data) ? c.data : bad('data must be an object'));
  only(d, ['sources', 'refresh', 'refreshMinutes', 'maxRowsPerTable', 'warehouse'], 'data');
  const sources = (d.sources == null ? [] : d.sources);
  if (!Array.isArray(sources)) bad('data.sources must be a list');
  const srcs = sources.map((s, i) => validateSource(s, `data.sources[${i}]`));
  const taken = new Set();
  for (const s of srcs) if (s.name) { let n = s.name, k = 2; while (taken.has(n.toLowerCase())) n = s.name + '_' + (k++); taken.add(n.toLowerCase()); s.name = n; }
  const ids = srcs.filter(s => s.id).map(s => s.id);
  if (new Set(ids).size !== ids.length) bad('data.sources: two sources share the same id');
  const duck = srcs.filter(s => s.type === 'duckdb');
  if (duck.length && srcs.length > 1) bad('A workspace uses either ONE DuckDB file or any number of files/folders/databases. You cannot mix a DuckDB file with other sources, and only one DuckDB file is allowed.', 'mixed_sources');
  const refresh = d.refresh == null ? 'auto' : d.refresh;
  if (!['auto', 'manual'].includes(refresh)) bad('data.refresh must be "auto" or "manual"');
  out.data = { sources: srcs, refresh,
    refreshMinutes: d.refreshMinutes == null ? DEFAULT_REFRESH_MINUTES : num(d.refreshMinutes, 'data.refreshMinutes', { min: 1, max: 10080, int: true }),
    maxRowsPerTable: d.maxRowsPerTable == null ? DEFAULT_MAX_ROWS : num(d.maxRowsPerTable, 'data.maxRowsPerTable', { min: 1, max: 2e9, int: true }) };
  if (d.warehouse != null) {
    const w = str(d.warehouse, 'data.warehouse');
    if (!path.isAbsolute(w)) bad('data.warehouse must be an absolute path');
    if (duck.length) bad('data.warehouse is the engine\'s own database; it cannot be combined with a DuckDB file source', 'mixed_sources');
    out.data.warehouse = w;
  }

  const r = c.rules == null ? {} : (isObj(c.rules) ? c.rules : bad('rules must be an object'));
  only(r, ['packs'], 'rules');
  const packs = r.packs == null ? [] : r.packs;
  if (!Array.isArray(packs)) bad('rules.packs must be a list of file paths');
  out.rules = { packs: packs.map((p, i) => { const v = str(p, `rules.packs[${i}]`); if (!path.isAbsolute(v)) bad(`rules.packs[${i}] must be an absolute path`); return v; }) };

  const m = c.model == null ? {} : (isObj(c.model) ? c.model : bad('model must be an object'));
  only(m, ['provider', 'baseURL', 'model', 'thinking'], 'model');
  const provider = m.provider == null ? 'custom' : m.provider;
  if (!PROVIDERS[provider]) bad('model.provider must be deepseek, openai or custom');
  const pd = PROVIDERS[provider];
  const baseURL = m.baseURL == null ? pd.baseURL : str(m.baseURL, 'model.baseURL', { empty: true });
  if (baseURL && !/^https?:\/\//i.test(baseURL)) bad('model.baseURL must start with http:// or https://');
  const thinking = m.thinking == null ? pd.thinking : m.thinking;
  if (!THINKING.includes(thinking)) bad('model.thinking must be one of ' + THINKING.join(', '));
  out.model = { provider, baseURL, model: m.model == null ? pd.model : str(m.model, 'model.model', { max: 200, empty: true }), thinking };

  const l = c.limits == null ? {} : (isObj(c.limits) ? c.limits : bad('limits must be an object'));
  only(l, ['maxCallsPerQuestion', 'maxCallsTotal', 'maxTokensPerQuestion', 'maxOutputTokens', 'dailyBudgetUSD', 'price'], 'limits');
  const lim = {
    maxCallsPerQuestion: l.maxCallsPerQuestion == null ? 2 : num(l.maxCallsPerQuestion, 'limits.maxCallsPerQuestion', { min: 1, max: 20, int: true }),
    maxCallsTotal: l.maxCallsTotal == null ? 4 : num(l.maxCallsTotal, 'limits.maxCallsTotal', { min: 1, max: 40, int: true }),
    maxTokensPerQuestion: l.maxTokensPerQuestion == null ? 2000 : num(l.maxTokensPerQuestion, 'limits.maxTokensPerQuestion', { min: 100, max: 1e6, int: true }),
    maxOutputTokens: l.maxOutputTokens == null ? 400 : num(l.maxOutputTokens, 'limits.maxOutputTokens', { min: 16, max: 64000, int: true }),
    dailyBudgetUSD: l.dailyBudgetUSD == null ? null : num(l.dailyBudgetUSD, 'limits.dailyBudgetUSD', { min: 0, max: 1e6 }),
    price: null,
  };
  if (l.price != null) {
    if (!isObj(l.price)) bad('limits.price must be an object');
    only(l.price, ['inputPerM', 'cachedInputPerM', 'outputPerM'], 'limits.price');
    lim.price = {
      inputPerM: num(l.price.inputPerM, 'limits.price.inputPerM', { max: 1e6 }),
      cachedInputPerM: l.price.cachedInputPerM == null ? num(l.price.inputPerM, 'limits.price.inputPerM', { max: 1e6 }) : num(l.price.cachedInputPerM, 'limits.price.cachedInputPerM', { max: 1e6 }),
      outputPerM: num(l.price.outputPerM, 'limits.price.outputPerM', { max: 1e6 }),
    };
  }
  out.limits = lim;

  const pv = c.privacy == null ? {} : (isObj(c.privacy) ? c.privacy : bad('privacy must be an object'));
  only(pv, ['hiddenColumns'], 'privacy');
  const hc = pv.hiddenColumns == null ? [] : pv.hiddenColumns;
  if (!Array.isArray(hc)) bad('privacy.hiddenColumns must be a list of "table.column"');
  out.privacy = { hiddenColumns: [...new Set(hc.map((x, i) => { const v = str(x, `privacy.hiddenColumns[${i}]`, { max: 300 }); if (!v.includes('.')) bad(`privacy.hiddenColumns[${i}] must look like table.column`); return v; }))] };

  const b = c.behavior == null ? {} : (isObj(c.behavior) ? c.behavior : bad('behavior must be an object'));
  only(b, ['reuse', 'sqlFallback', 'vectors', 'timezone', 'anchor', 'language'], 'behavior');
  const tz = b.timezone == null ? 'Asia/Shanghai' : str(b.timezone, 'behavior.timezone', { max: 64 });
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (_) { bad('behavior.timezone is not a valid time zone name'); }
  const anchor = b.anchor == null ? 'today' : b.anchor;
  if (anchor !== 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(String(anchor))) bad('behavior.anchor must be "today" or YYYY-MM-DD');
  const language = b.language == null ? 'zh' : b.language;
  if (!['zh', 'en'].includes(language)) bad('behavior.language must be zh or en');
  out.behavior = { reuse: b.reuse == null ? true : bool(b.reuse, 'behavior.reuse'), sqlFallback: b.sqlFallback == null ? true : bool(b.sqlFallback, 'behavior.sqlFallback'), vectors: b.vectors == null ? true : bool(b.vectors, 'behavior.vectors'), timezone: tz, anchor, language };

  const a = c.access == null ? {} : (isObj(c.access) ? c.access : bad('access must be an object'));
  only(a, ['ownerToken'], 'access');
  out.access = { ownerToken: a.ownerToken == null ? crypto.randomBytes(24).toString('base64url') : str(a.ownerToken, 'access.ownerToken', { max: 200 }) };
  if (out.access.ownerToken.length < 16) bad('access.ownerToken must be at least 16 characters');

  const sf = c.surfaces == null ? {} : (isObj(c.surfaces) ? c.surfaces : bad('surfaces must be an object'));
  only(sf, ['serve', 'mcp'], 'surfaces');
  const sv = sf.serve == null ? {} : (isObj(sf.serve) ? sf.serve : bad('surfaces.serve must be an object'));
  only(sv, ['port', 'allowedOrigins', 'token'], 'surfaces.serve');
  const mc = sf.mcp == null ? {} : (isObj(sf.mcp) ? sf.mcp : bad('surfaces.mcp must be an object'));
  only(mc, ['allowRuleChanges'], 'surfaces.mcp');
  const ao = sv.allowedOrigins == null ? [] : sv.allowedOrigins;
  if (!Array.isArray(ao)) bad('surfaces.serve.allowedOrigins must be a list');
  out.surfaces = {
    serve: { port: sv.port == null ? DEFAULT_PORT : num(sv.port, 'surfaces.serve.port', { min: 0, max: 65535, int: true }), allowedOrigins: [...new Set(ao.map((o, i) => origin(o, `surfaces.serve.allowedOrigins[${i}]`)))], token: sv.token == null ? null : serveToken(sv.token, 'surfaces.serve.token') },
    mcp: { allowRuleChanges: mc.allowRuleChanges == null ? false : bool(mc.allowRuleChanges, 'surfaces.mcp.allowRuleChanges') },
  };
  return out;
}

function deepMerge(base, patch) {
  if (!isObj(patch)) return patch;
  const out = { ...(isObj(base) ? base : {}) };
  for (const k of Object.keys(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(patch[k]) && isObj(out[k]) ? deepMerge(out[k], patch[k]) : patch[k];
  }
  return out;
}

// ---- data sources ----
const globRe = pat => new RegExp('^' + String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
/** concrete file list for a set of file/folder sources (folders are re-read every call) */
function expandSources(sources) {
  const out = [], seen = new Set();
  const add = f => { const r = path.resolve(f); if (!seen.has(r)) { seen.add(r); out.push(r); } };
  for (const s of sources) {
    if (s.type === 'file' || s.type === 'sqlite') { add(s.path); continue; }
    if (s.type !== 'folder') continue;
    const pat = s.pattern || '*';
    const re = globRe(pat);
    let ents = [];
    try { ents = fs.readdirSync(s.path, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents.sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (!e.isFile() || e.name.startsWith('.') || e.name.startsWith('~$') || !re.test(e.name)) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (FILE_EXT.includes(ext) || (ext === '.txt' && s.pattern && /\.txt$/i.test(s.pattern))) add(path.join(s.path, e.name));
    }
  }
  return out;
}
/** classify a path the user gave: file / folder / duckdb / sqlite (databases are recognised by their first bytes, then by extension) */
function sourceFromPath(p) {
  const abs = path.resolve(String(p));
  let st; try { st = fs.statSync(abs); } catch (_) { bad('path not found: ' + abs, 'not_found'); }
  if (st.isDirectory()) return { type: 'folder', path: abs, pattern: '*' };
  const { sniffHeader } = require('./discover.js');
  const head = sniffHeader(abs);
  if (head === 'sqlite') return { type: 'sqlite', path: abs };
  if (head === 'duckdb') return { type: 'duckdb', path: abs };
  const ext = path.extname(abs).toLowerCase();
  if (DUCK_EXT.includes(ext)) return { type: 'duckdb', path: abs };
  if (!FILE_EXT.includes(ext)) bad('unsupported file type (use csv, tsv, xlsx, parquet, or a SQLite / DuckDB database file): ' + path.basename(abs), 'unsupported');
  return { type: 'file', path: abs };
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fsx.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
  fsx.secureFile(file);
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readSecrets(dir) { try { const j = readJson(path.join(dir, 'secrets.json')); return isObj(j) ? j : {}; } catch (_) { return {}; } }
function writeSecrets(dir, obj) {
  const o = { ...obj };
  if (o.connections && !Object.keys(o.connections).length) delete o.connections;
  writeJsonAtomic(path.join(dir, 'secrets.json'), o);
}
function secretKeyOf(dir) { const j = readSecrets(dir); return typeof j.apiKey === 'string' && j.apiKey ? j.apiKey : null; }
const connPasswords = dir => { const c = readSecrets(dir).connections; const out = {}; if (isObj(c)) for (const [id, v] of Object.entries(c)) if (isObj(v) && typeof v.password === 'string' && v.password) out[id] = v.password; return out; };
function validPassword(k) { return typeof k === 'string' && k.length >= 1 && k.length <= 512 && !/[\u0000-\u001f\u007f]/.test(k); }
const newSourceId = type => (type === 'postgres' ? 'pg' : 'my') + '_' + crypto.randomBytes(4).toString('hex');
/** Splits passwords off source objects: {sources (no password, remote ones with an id), passwords: {id: password}}. Passwords never reach estratto.json. */
function takePasswords(list) {
  const passwords = {};
  const sources = (Array.isArray(list) ? list : []).map(s => {
    if (!isObj(s)) return s;
    const { password, ...rest } = s;
    if (REMOTE.includes(rest.type) && rest.id == null) rest.id = newSourceId(rest.type);
    if (password != null) {
      if (!REMOTE.includes(rest.type)) bad('only database sources (postgres, mysql) take a password');
      if (!validPassword(password)) bad('the password must be 1-512 characters without control characters', 'bad_password');
      passwords[rest.id] = password;
    }
    return rest;
  });
  return { sources, passwords };
}
function validKey(k) { return typeof k === 'string' && k.length >= 1 && k.length <= 512 && !/[\s\u0000-\u001f\u007f]/.test(k); }

async function initWorkspace({ home, name, config = {}, apiKey = null } = {}) {
  const dir = workspaceDir(home, name);
  if (fs.existsSync(path.join(dir, 'estratto.json'))) bad('workspace already exists: ' + dir, 'exists');
  const prep = takePasswords(config.data && config.data.sources);
  const cfg = validateConfig({ ...config, version: 1, name, ...(config.data ? { data: { ...config.data, sources: prep.sources } } : {}) });
  if (!cfg.data.sources.length) bad('at least one data source is required (a file, a folder, a database, or one DuckDB file)', 'no_sources');
  if (apiKey != null && !validKey(apiKey)) bad('the api key must be a single token without spaces or control characters', 'bad_key');
  if (cfg.data.warehouse && fs.existsSync(cfg.data.warehouse)) bad('the database file already exists: ' + cfg.data.warehouse + ' (the engine would overwrite it; pick a new location)', 'warehouse_exists');
  fsx.ensureDir(dir);
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  const connections = {};
  for (const [id, password] of Object.entries(prep.passwords)) connections[id] = { password };
  writeSecrets(dir, { ...(apiKey ? { apiKey } : {}), connections });
  writeJsonAtomic(path.join(dir, 'estratto.json'), cfg);
  return { dir, config: cfg };
}

async function openWorkspace(where, overrides = {}) {
  if (!where || (typeof where !== 'object')) bad('openWorkspace needs { home, name } or { dir }');
  const dir = where.dir ? path.resolve(where.dir) : workspaceDir(where.home, where.name);
  const cfgFile = path.join(dir, 'estratto.json');
  if (!fs.existsSync(cfgFile)) bad('no workspace here (estratto.json missing): ' + dir, 'not_found');
  let config;
  try { config = validateConfig(readJson(cfgFile)); } catch (e) { if (e instanceof ConfigError) throw e; bad('estratto.json is not valid JSON: ' + path.basename(dir)); }
  fsx.ensureDir(dir);

  // ---- secrets / redaction (the key lives only here and in secrets.json) ----
  let apiKey = secretKeyOf(dir);
  const seenKeys = new Set([...(apiKey ? [apiKey] : []), ...Object.values(connPasswords(dir))]);   // rc.8: database passwords are redacted from every output too
  let redactor = makeRedactor([...seenKeys]);
  const redact = { str: s => redactor.str(s), deep: v => redactor.deep(v) };

  // ---- model (key, base URL and thinking mode are read per call, so they change without rebuilding the engine) ----
  let inner = null;
  const makeInner = () => openaiCompatible({ baseURL: config.model.baseURL || 'http://invalid.local', apiKey: apiKey || undefined, model: config.model.model || 'unset', thinking: config.model.thinking, providerName: config.model.provider, ...(overrides.fetch ? { fetch: overrides.fetch } : {}), ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}) });
  const remakeModel = () => { inner = makeInner(); };
  remakeModel();
  const model = {
    kind: 'workspace', providerName: config.model.provider, modelName: config.model.model,
    async generate(req, signal) {
      if (!config.model.baseURL || !config.model.model) throw new Error('model is not configured (set model.baseURL and model.model)');
      return inner.generate(req, signal);
    },
    redact: s => redactor.str(inner.redact(s)),
  };

  const ledger = createLedger({ file: path.join(dir, 'usage.jsonl'), timezone: config.behavior.timezone, price: config.limits.price, dailyBudgetUSD: config.limits.dailyBudgetUSD });
  if (!fs.existsSync(path.join(dir, 'usage.jsonl'))) fsx.writeFile(path.join(dir, 'usage.jsonl'), '');
  const listeners = new Set();
  const onEvent = e => { for (const f of listeners) { try { f(e); } catch (_) {} } if (typeof overrides.onEvent === 'function') overrides.onEvent(e); };

  const duckSrc = c => c.data.sources.find(s => s.type === 'duckdb') || null;
  // rc.8: sqlite files and database snapshots. A database source is represented by a small marker file in <workspace>/sources/;
  // its mtime is "when the snapshot was last asked for", so the engine's normal file-change logic does the refreshing.
  const markerDir = path.join(dir, 'sources');
  const markerOf = s => path.join(markerDir, s.id + '.source');
  const remoteSources = () => config.data.sources.filter(s => REMOTE.includes(s.type));
  let forceRemote = false;
  const ensureMarker = s => {
    const f = markerOf(s);
    if (!fs.existsSync(f)) { fsx.ensureDir(markerDir); fsx.writeFile(f, JSON.stringify({ schema: 'estratto-source-marker/1', id: s.id, type: s.type }) + '\n'); }
    return f;
  };
  const touchMarker = f => { const cur = fs.statSync(f).mtimeMs; const t = new Date(Math.max(Date.now(), cur + 1)); fs.utimesSync(f, t, t); };
  /** every file the engine should watch; `touch` = start a new snapshot of database sources that are due (or forced) */
  function resolveInputs(touch) {
    const files = expandSources(config.data.sources);
    const dueMs = config.data.refreshMinutes * 60000;
    for (const s of remoteSources()) {
      const f = ensureMarker(s);
      if (touch && (forceRemote || (config.data.refresh === 'auto' && Date.now() - fs.statSync(f).mtimeMs >= dueMs))) touchMarker(f);
      files.push(f);
    }
    return files;
  }
  const sigOf = s => crypto.createHash('sha256').update(JSON.stringify({ t: s.type, tables: s.tables || null, h: s.host || null, p: s.port || null, d: s.database || null, u: s.user || null, sc: s.schema || null, ssl: s.ssl || null, n: s.name })).digest('hex').slice(0, 12);
  /** what a path stands for: a sqlite source file, a database marker, or (null) an ordinary data file */
  function planFor(f) {
    const abs = path.resolve(f);
    for (const s of config.data.sources) {
      if (s.type === 'sqlite' && path.resolve(s.path) === abs) return { name: s.name, spec: s, password: null, sig: sigOf(s) };
      if (REMOTE.includes(s.type) && markerOf(s) === abs) return { name: s.name, spec: s, password: connPasswords(dir)[s.id] || null, sig: sigOf(s) };
    }
    return null;
  }
  async function buildEngine() {
    const c = config;
    const dk = duckSrc(c);
    if (!c.data.sources.length) bad('this workspace has no data sources; add one with "estratto add"', 'no_sources');
    let data;
    if (dk) {
      data = { duckdb: dk.path, refresh: c.data.refresh === 'auto' ? 'auto' : 'off' };
    } else {
      const files = resolveInputs(false);
      if (!files.length) bad('no data files found in the configured sources', 'no_files');
      data = { files, resolveFiles: () => resolveInputs(true), plan: planFor, get maxRows() { return config.data.maxRowsPerTable; }, ...(c.data.warehouse ? { warehouse: c.data.warehouse } : {}), refresh: c.data.refresh === 'auto' ? 'auto' : 'off' };
    }
    if (overrides.refreshIntervalMs != null) data.refreshIntervalMs = overrides.refreshIntervalMs;
    const rules = c.rules.packs.length ? c.rules.packs.map(f => { try { return readJson(f); } catch (e) { bad('cannot read rules pack: ' + f, 'bad_pack'); } }) : undefined;
    const l = c.limits;
    return createEngine({
      dataDir: dir, data, ...(rules ? { rules } : {}), model,
      limits: { maxCallsPerQuestion: l.maxCallsPerQuestion, maxCallsTotal: l.maxCallsTotal, maxTokensPerQuestion: l.maxTokensPerQuestion, maxOutputTokens: l.maxOutputTokens },
      ledger, language: c.behavior.language,
      ...(c.privacy.hiddenColumns.length ? { privacy: { hiddenColumns: c.privacy.hiddenColumns } } : {}),
      vectors: c.behavior.vectors, reuse: c.behavior.reuse, sqlFallback: c.behavior.sqlFallback,
      timezone: c.behavior.timezone, ...(c.behavior.anchor !== 'today' ? { anchor: c.behavior.anchor } : {}),
      ...(overrides.modelsDir ? { modelsDir: overrides.modelsDir } : {}),
      onEvent,
    });
  }

  let engine = await buildEngine();
  let active = 0, lock = null, closed = false, chain = Promise.resolve();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const use = async fn => { while (lock) await lock; if (closed) throw new Error('workspace is closed'); active++; try { return await fn(engine); } finally { active--; } };

  async function rebuild() {
    let release; const mine = new Promise(r => { release = r; }); lock = mine;
    try {
      for (let i = 0; active && i < 2400; i++) await sleep(25);
      await engine.close();
      engine = await buildEngine();
    } finally { lock = null; release(); }
  }
  const rebuildKey = c => JSON.stringify([c.rules, c.privacy, c.behavior, [c.limits.maxCallsPerQuestion, c.limits.maxCallsTotal, c.limits.maxTokensPerQuestion, c.limits.maxOutputTokens], [c.model.provider, c.model.model], c.data.refresh, c.data.warehouse || null, duckSrc(c) ? c.data.sources : 'files']);

  function saveConfig(patch) {
    const run = async () => {
      if (closed) throw new Error('workspace is closed');
      const prev = config;
      const next = validateConfig(deepMerge(prev, patch || {}));
      if (!next.data.sources.length) bad('a workspace needs at least one data source', 'no_sources');
      const needRebuild = rebuildKey(prev) !== rebuildKey(next);
      const sourcesChanged = JSON.stringify(prev.data.sources) !== JSON.stringify(next.data.sources);
      config = next;
      remakeModel(); model.providerName = next.model.provider; model.modelName = next.model.model;
      ledger.configure({ timezone: next.behavior.timezone, price: next.limits.price, dailyBudgetUSD: next.limits.dailyBudgetUSD });
      try {
        if (needRebuild) await rebuild();
        else if (sourcesChanged) {
          const r = await use(e => e.refreshData());
          // a source that was just added or changed and could not be imported is an error for the caller (the config is rolled back below)
          if (r && r.failed && r.failed.length) { const f0 = r.failed[0]; bad(`could not import ${f0.file ? f0.file.replace(/\.source$/, '') : 'the data'}: ${f0.message}`, f0.code === 'row_cap_exceeded' ? 'row_cap_exceeded' : 'import_failed'); }
        }
      } catch (err) {
        config = prev; remakeModel(); model.providerName = prev.model.provider; model.modelName = prev.model.model;
        ledger.configure({ timezone: prev.behavior.timezone, price: prev.limits.price, dailyBudgetUSD: prev.limits.dailyBudgetUSD });
        if (needRebuild) { try { await rebuild(); } catch (_) {} }
        throw err;
      }
      writeJsonAtomic(cfgFile, config);
      return JSON.parse(JSON.stringify(config));
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  async function setApiKey(key) {
    if (key == null || key === '') { apiKey = null; const sec = readSecrets(dir); delete sec.apiKey; writeSecrets(dir, sec); remakeModel(); return 'not set'; }
    if (!validKey(key)) bad('the api key must be a single token without spaces or control characters', 'bad_key');
    apiKey = key; seenKeys.add(key); redactor = makeRedactor([...seenKeys]);
    writeSecrets(dir, { ...readSecrets(dir), apiKey: key });
    remakeModel();
    return 'set';
  }

  const sameRemote = (a, b) => a.type === b.type && a.host === b.host && a.port === b.port && a.database === b.database && a.user === b.user && (a.schema || null) === (b.schema || null);
  /** add several sources in one step (one import). Items: a path string, or a source object; database sources may carry `password` (stored only in secrets.json). */
  async function addSources(items) {
    let cur = config.data.sources.slice();
    const written = [];
    try {
      for (const it of items) {
        let src, pw = null;
        if (typeof it === 'string') src = sourceFromPath(it);
        else if (isObj(it)) {
          const prep = takePasswords([it]);
          src = prep.sources[0];
          if (REMOTE.includes(src.type)) {
            const same = cur.find(x => sameRemote(x, src));
            if (same) src.id = same.id;   // re-adding the same database with other tables: the same source
          }
          pw = prep.passwords[src.id] || null;
          src = validateSource(src, 'source');
          if (src.type === 'file' || src.type === 'folder' || src.type === 'duckdb') src = sourceFromPath(src.path);
        } else bad('a source must be a path or an object');
        if (src.type === 'sqlite') { try { fs.statSync(src.path); } catch (_) { bad('path not found: ' + src.path, 'not_found'); } }
        if (pw != null) {
          const sec = readSecrets(dir); sec.connections = { ...(isObj(sec.connections) ? sec.connections : {}), [src.id]: { password: pw } };
          written.push([src.id, (readSecrets(dir).connections || {})[src.id] || null]);
          writeSecrets(dir, sec); seenKeys.add(pw); redactor = makeRedactor([...seenKeys]);
        }
        const i = cur.findIndex(x => REMOTE.includes(src.type) ? x.id === src.id : (x.type === src.type && x.path === src.path));
        if (i >= 0) { if (JSON.stringify(cur[i]) === JSON.stringify(src)) continue; cur[i] = src; } else cur.push(src);
      }
      if (JSON.stringify(cur) === JSON.stringify(config.data.sources)) return JSON.parse(JSON.stringify(config));
      return await saveConfig({ data: { sources: cur } });
    } catch (e) {
      // roll the passwords back so a failed add leaves no orphan secrets
      const sec = readSecrets(dir);
      for (const [id, prev] of written) { if (!sec.connections) break; if (prev) sec.connections[id] = prev; else delete sec.connections[id]; }
      if (written.length) writeSecrets(dir, sec);
      throw e;
    }
  }
  async function addSource(p, opts = {}) {
    if (typeof p === 'string') return addSources([p]);
    return addSources([opts.password != null ? { ...p, password: opts.password } : p]);
  }
  const maxRowsNow = () => config.data.maxRowsPerTable;
  /** connect read-only and list the tables (with row counts) of a sqlite / postgres / mysql source; nothing is imported or saved */
  async function listSourceTables(spec, password) {
    const { password: inlinePw, ...rest } = spec;
    const norm = normalizeSource({ ...rest, ...(REMOTE.includes(rest.type) && !(rest.tables && rest.tables.length) ? { tables: ['_'] } : {}) });
    const pw = password != null ? password : (inlinePw != null ? inlinePw : (REMOTE.includes(norm.type) ? connPasswords(dir)[norm.id] || null : null));
    if (pw) { seenKeys.add(pw); redactor = makeRedactor([...seenKeys]); }
    return require('./snapshot.js').listSource(norm, pw, { maxRows: maxRowsNow() });
  }

  const ws = {
    dir,
    get config() { return JSON.parse(JSON.stringify(config)); },
    get engine() { return engine; },
    use,
    ask: (q, o) => use(e => e.ask(q, o)),
    confirm: (rid, choice) => use(e => e.confirm(rid, choice)),
    cancel: rid => engine.cancel(rid),
    saveConfig, setApiKey, addSource, addSources, listSourceTables,
    discover: (paths, o) => require('./discover.js').discover(paths, o),
    dataSummary: () => use(e => e.dataSummary()),
    keyStatus: () => apiKey ? 'set' : 'not set',
    redact,
    usage: { today: () => ledger.today(), list: n => ledger.list(n), totalUSD: () => ledger.totalUSD() },
    /** re-check every source now; database sources are snapshotted again (this is the manual refresh) */
    refreshData: async () => { forceRemote = true; try { return await use(e => e.refreshData()); } finally { forceRemote = false; } },
    expandSources: () => expandSources(config.data.sources),
    on: f => { listeners.add(f); return () => listeners.delete(f); },
    async close() { if (closed) return; closed = true; try { await engine.close(); } catch (_) {} },
  };
  return ws;
}

/** read and validate estratto.json without opening the engine */
function readConfig(where) {
  const dir = where.dir ? path.resolve(where.dir) : workspaceDir(where.home, where.name);
  const f = path.join(dir, 'estratto.json');
  if (!fs.existsSync(f)) bad('no workspace here (estratto.json missing): ' + dir, 'not_found');
  let raw; try { raw = readJson(f); } catch (_) { bad('estratto.json is not valid JSON: ' + path.basename(dir)); }
  return { dir, config: validateConfig(raw) };
}

/** validate one source object on its own (used by the HTTP API and the CLI); database sources get an id if they have none */
function normalizeSource(s) {
  const { sources } = takePasswords([s]);
  return validateSource(sources[0], 'source');
}

module.exports = { readConfig, initWorkspace, openWorkspace, validateConfig, workspaceDir, listWorkspaces, sourceFromPath, expandSources, normalizeSource, readSecrets, ConfigError, PROVIDERS, DEFAULT_PORT, DEFAULT_MAX_ROWS, DEFAULT_REFRESH_MINUTES, checkName, deepMerge };
