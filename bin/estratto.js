#!/usr/bin/env node
'use strict';
// CLI shell. This is the only place that reads process.env / argv; the engine core never does.
//   estratto ask --data <file.duckdb | a.csv b.xlsx ...> [--rules pack.json ...] [--base-url URL] [--model NAME] ... "question"
//   estratto init | status | add | rules | config | doctor | usage | serve | mcp      (workspace commands, see USAGE)
// API key: ESTRATTO_API_KEY (ask; init --yes; config set-key without a terminal). Workspaces keep it in secrets.json (0600).
// rc.7: Node prints "ExperimentalWarning: SQLite is an experimental feature" the first time node:sqlite loads. It is expected here
// (the reuse cache uses it), so this one warning is dropped in the CLI. Every other warning is passed through untouched.
{
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] && typeof rest[0] === 'object' ? rest[0].type : undefined) || (warning && warning.name);
    const message = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (type === 'ExperimentalWarning' && /\bSQLite\b/.test(message)) return;
    return emitWarning.call(process, warning, ...rest);
  };
}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { createEngine, openaiCompatible } = require('../index.js');
const { makeRedactor } = require('../src/redact.js');
const W = require('../src/workspace.js');
const CD = require('../src/cli-data.js');
CD.setHome(require('os').homedir());
const { createLedger } = require('../src/ledger.js');

// last line of defence: nothing printed by the CLI may contain the api key or a bearer/sk- style token
const secretsSeen = [process.env.ESTRATTO_API_KEY, process.env.ESTRATTO_DB_PASSWORD];
let redactor = makeRedactor(secretsSeen);
let wsRedact = null;
const addSecret = k => { if (k) { secretsSeen.push(k); redactor = makeRedactor(secretsSeen); } };
const clean = s => { const a = redactor.str(s); return wsRedact ? wsRedact(a) : a; };
const fmtArg = a => typeof a === 'string' ? a : (a instanceof Error ? a.message : String(a));
let toStderr = false;   // `mcp`: stdout belongs to the protocol
console.log = (...a) => (toStderr ? process.stderr : process.stdout).write(clean(a.map(fmtArg).join(' ')) + '\n');
console.error = (...a) => process.stderr.write(clean(a.map(fmtArg).join(' ')) + '\n');

const FLAGS_WITH_LIST = new Set(['data', 'rules', 'scan']);
const FLAGS_WITH_VALUE = new Set(['base-url', 'model', 'data-dir', 'anchor', 'timezone', 'thinking', 'thinking-repair', 'models-dir', 'timeout-ms', 'name', 'home', 'duckdb', 'provider', 'port', 'pattern', 'daily-budget', 'language', 'token', 'print-config', 'db', 'warehouse', 'pick', 'pg-url', 'mysql-url', 'tables', 'sqlite', 'postgres', 'mysql']);
const BOOL_FLAGS = new Set(['no-vectors', 'json', 'raw', 'no-reuse', 'no-sql', 'help', 'yes', 'online', 'refresh']);

function parse(argv) {
  const out = { _: [] };
  let current = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2), eq = k.indexOf('=');
      const name = eq >= 0 ? k.slice(0, eq) : k;
      current = null;
      if (BOOL_FLAGS.has(name)) { out[name] = true; continue; }
      if (FLAGS_WITH_VALUE.has(name)) { out[name] = eq >= 0 ? k.slice(eq + 1) : argv[++i]; if (out[name] === undefined) throw new Error('missing value for --' + name); continue; }
      if (FLAGS_WITH_LIST.has(name)) { out[name] = out[name] || []; if (eq >= 0) out[name].push(k.slice(eq + 1)); else current = name; continue; }
      throw new Error('unknown option: ' + a);
    }
    if (current) out[current].push(a); else out._.push(a);
  }
  return out;
}

const USAGE = `usage:
  estratto init [--name N] [--language zh|en]            (interactive: asks about your database, scans the folders you name, lets you pick)
     data, no questions asked (with --yes):
       --db none|sqlite|postgres|mysql|duckdb   --warehouse <file.duckdb>   (where the engine's own DuckDB goes; default <home>/<name>/warehouse.duckdb)
       --data <path>... | --duckdb <file> | --scan <folder>... [--pick all|<globs>] [--tables a,b]
       --pg-url postgres://user@host:5432/db[?schema=public&sslmode=require] --tables a,b      --mysql-url mysql://user@host:3306/db --tables a,b
       (database password: env ESTRATTO_DB_PASSWORD; it is stored only in secrets.json, never in estratto.json)
     [--rules <pack.json>...] [--provider deepseek|openai|custom] [--base-url URL] [--model NAME] [--daily-budget USD] [--timezone TZ] [--no-vectors] [--yes]
  estratto status | usage | doctor [--online] [--name N] [--json]
  estratto add <path> [--name N]           estratto add --scan <folder>... [--pick all|<globs>]      estratto add --sqlite <file> [--tables a,b]
  estratto add --postgres <url> --tables a,b      estratto add --mysql <url> --tables a,b      estratto add --refresh   (take new snapshots of database sources now)
  estratto rules [list | preview [id] | confirm <id> | reject <id> | revert <id> | export <file> | import <file>] [--name N] [--json]
  estratto config [get [key] | set <key> <value> | set-key] [--name N]
  estratto serve [--name N] [--port P] [--token T] [--print-config json]          estratto mcp [--name N]
  estratto ask --data <file.duckdb | csv/xlsx/parquet ...> [--rules pack.json ...] [--base-url URL] [--model NAME]
               [--data-dir DIR] [--anchor YYYY-MM-DD] [--timezone TZ] [--thinking disabled|false_bool|low] [--models-dir DIR] [--no-vectors] [--json] [--raw] "question"
all workspace commands: --home DIR (default ~/.estratto). env: ESTRATTO_HOME, ESTRATTO_API_KEY (api key), ESTRATTO_DB_PASSWORD, ESTRATTO_BASE_URL, ESTRATTO_MODEL`;

class UsageError extends Error {}
const defaultHome = () => path.join(os.homedir(), '.estratto');
const home = args => path.resolve(args.home || process.env.ESTRATTO_HOME || defaultHome());
function wsName(args) {
  if (args.name) return args.name;
  const all = W.listWorkspaces(home(args));
  if (all.length === 1) return all[0];
  if (!all.length) throw new UsageError('no workspace yet: run "estratto init" first (home: ' + home(args) + ')');
  throw new UsageError('several workspaces here (' + all.join(', ') + '): pass --name');
}
async function openWs(args, overrides) {
  const ws = await W.openWorkspace({ home: home(args), name: wsName(args) }, { onEvent: warnEvent, ...(overrides || {}) });
  wsRedact = ws.redact.str;
  return ws;
}
function warnEvent(e) { if (e && e.level === 'warning') console.error('[warn] ' + e.type + ': ' + (e.reason || e.note || e.message || '')); }
const srcLabel = s => s.path ? s.type + ':' + s.path + (s.tables && s.tables.length ? ' (' + s.tables.join(',') + ')' : '') : `${s.type}://${s.user}@${s.host}:${s.port}/${s.database}${s.schema && s.schema !== 'public' ? '?schema=' + s.schema : ''} (${s.tables.length} tables)`;
const j = v => JSON.stringify(v, (k, x) => typeof x === 'bigint' ? Number(x) : x, 2);
const fmtNum = (v, dec) => v == null ? '-' : Number(v).toLocaleString('en-US', { maximumFractionDigits: dec == null ? 2 : Math.max(0, Math.min(6, dec)) });

// ---- terminal prompts ----
function makeRl(muteable) {
  const readline = require('node:readline');
  const mute = new Writable({ write(chunk, enc, cb) { if (!mute.muted) process.stdout.write(chunk, enc); cb(); } });
  mute.muted = false;
  const rl = readline.createInterface({ input: process.stdin, output: muteable ? mute : process.stdout, terminal: !!process.stdin.isTTY });
  return { rl, mute };
}
async function ask(rl, label, def) {
  const a = await new Promise(res => rl.question(label + (def ? ` [${def}]` : '') + ': ', res));
  return String(a).trim() || def || '';
}
function askHidden(label) {
  return new Promise(resolve => {
    const { rl, mute } = makeRl(true);
    rl.question(label + ': ', a => { mute.muted = false; process.stdout.write('\n'); rl.close(); resolve(String(a).trim()); });
    mute.muted = true;
  });
}
const isTTY = () => !!(process.stdin.isTTY && process.stdout.isTTY);

// ---- init ----
function mcpSnippet(name, args) {
  const a = [path.resolve(__filename), 'mcp', '--name', name];
  const h = home(args);
  if (h !== defaultHome()) a.push('--home', h);
  return { mcpServers: { ['estratto-' + name]: { command: process.execPath, args: a } } };
}
const serveCmd = (name, args) => 'estratto serve --name ' + name + (home(args) !== defaultHome() ? ' --home ' + home(args) : '');

// rc.8: which data? Resolve the command-line options into config sources (no questions asked).
function dbPassword(urlPassword) {
  const env = process.env.ESTRATTO_DB_PASSWORD;
  const pw = env != null && env !== '' ? env : (urlPassword || null);
  if (pw) addSecret(pw);
  if (!(env != null && env !== '') && urlPassword) console.error('[warn] the URL contained a password; it is used for this run and stored only in secrets.json, but shell history may keep it. Prefer ESTRATTO_DB_PASSWORD.');
  return pw;
}
const tableNames = a => (a ? String(a).split(',').map(x => x.trim()).filter(Boolean) : []);
async function remoteFromUrl(url, kind, args, W0) {
  let parsed; try { parsed = CD.parseDbUrl(url, kind); } catch (e) { throw new UsageError(e.message); }
  const pw = dbPassword(parsed.password);
  const wanted = tableNames(args.tables);
  let tables = wanted;
  if (!wanted.length || (wanted.length === 1 && wanted[0].toLowerCase() === 'all')) {
    let listing;
    try { listing = await require('../src/snapshot.js').listSource(W.normalizeSource({ ...parsed.spec, tables: ['_'] }), pw, {}); } catch (e) { throw new UsageError('could not connect: ' + String(e && e.message || e)); }
    if (wanted.length) tables = listing.tables.map(t => t.name);
    else throw new UsageError('pass --tables a,b (or --tables all). Tables found: ' + (listing.tables.map(t => t.name).join(', ') || '(none)'));
  }
  return { ...parsed.spec, tables, ...(pw ? { password: pw } : {}) };
}
async function sourcesFromArgs(args) {
  const out = { sources: [], warehouse: args.warehouse ? path.resolve(CD.expandHome(args.warehouse)) : undefined };
  const db = args.db;
  if (db != null && !['none', 'sqlite', 'postgres', 'mysql', 'duckdb'].includes(db)) throw new UsageError('--db must be none, sqlite, postgres, mysql or duckdb');
  const paths = [...(args.data || [])]; if (args.duckdb) paths.push(args.duckdb);
  for (const p of paths) out.sources.push(W.sourceFromPath(CD.expandHome(p)));
  if (args.scan && args.scan.length) {
    const kinds = db === 'sqlite' ? ['sqlite'] : db === 'duckdb' ? ['duckdb'] : null;
    const { found, picked } = await CD.scanAndPick(args.scan, args.pick, kinds ? { kinds } : {});
    if (!found.length) throw new UsageError('nothing usable found in: ' + args.scan.join(', '));
    if (!picked.length) throw new UsageError('--pick matched nothing. Found: ' + found.map(c => c.name).join(', '));
    out.sources.push(...CD.candidatesToSources(picked));
  }
  if (args.sqlite) out.sources.push(W.sourceFromPath(CD.expandHome(args.sqlite)));
  const tn = tableNames(args.tables);
  if (tn.length && !args['pg-url'] && !args['mysql-url'] && !args.postgres && !args.mysql) {
    const sq = out.sources.filter(s => s.type === 'sqlite');
    if (!sq.length) throw new UsageError('--tables only applies to a database source (SQLite file, --pg-url, --mysql-url)');
    for (const s of sq) s.tables = tn;
  }
  if (args['pg-url'] || args.postgres) out.sources.push(await remoteFromUrl(args['pg-url'] || args.postgres, 'postgres', args));
  if (args['mysql-url'] || args.mysql) out.sources.push(await remoteFromUrl(args['mysql-url'] || args.mysql, 'mysql', args));
  const has = t => out.sources.some(s => s.type === t);
  if (db === 'none' && (has('duckdb') || has('postgres') || has('mysql'))) throw new UsageError('--db none uses the engine\'s own database; remove the DuckDB file / database URL, or use another --db');
  if (db === 'sqlite' && !has('sqlite')) throw new UsageError('--db sqlite needs a SQLite file (--data file.db, or --scan <folder>)');
  if (db === 'postgres' && !has('postgres')) throw new UsageError('--db postgres needs --pg-url');
  if (db === 'mysql' && !has('mysql')) throw new UsageError('--db mysql needs --mysql-url');
  if (db === 'duckdb' && !has('duckdb')) throw new UsageError('--db duckdb needs --duckdb <file> (or --data file.duckdb)');
  if (out.warehouse && has('duckdb')) throw new UsageError('--warehouse is where the engine\'s own database goes; it cannot be combined with a DuckDB file');
  return out;
}

function makePrompter() {
  let rl = null;
  const get = () => rl || (rl = makeRl(false).rl);
  return {
    ask: (label, def) => ask(get(), label, def),
    hidden: async label => { if (rl) { rl.close(); rl = null; } return askHidden(label); },
    say: l => console.log(l),
    close() { if (rl) { rl.close(); rl = null; } },
  };
}

async function confirmMetrics(ws, p, interactive, zhOut) {
  const tables = ws.engine.tables().filter(t => !t.excluded);
  console.log((zhOut ? '表: ' : 'Tables: ') + tables.map(t => t.name + '(' + t.columns.length + ')').join(', '));
  const todo = ws.engine.rules.metrics().filter(m => m.status === 'unconfirmed');
  if (!todo.length) return;
  console.log(zhOut ? '\n从你的列里认出了这些指标(还没确认):' : '\nMetrics recognised from your columns (not confirmed yet):');
  for (const m of todo) {
    let pv = null; try { pv = await ws.engine.rules.preview(m.id); } catch (_) {}
    console.log(`  ${m.id}  ${m.name}  = ${m.formula}${pv ? `   ${zhOut ? '全部数据' : 'all data'}: ${fmtNum(pv.total, pv.decimals)}${pv.lastMonth ? `   ${pv.lastMonth.period}: ${fmtNum(pv.lastMonth.value, pv.decimals)}` : ''}` : ''}`);
    if (interactive) {
      const a = (await p.ask('    ' + CD.strings(zhOut ? 'zh' : 'en').ruleQ, 's')).toLowerCase();
      if (a.startsWith('y')) { await ws.engine.rules.confirm(m.id, { by: 'host' }); console.log(zhOut ? '    已确认' : '    confirmed'); }
      else if (a.startsWith('n')) { await ws.engine.rules.reject(m.id, { by: 'host' }); console.log(zhOut ? '    已标为不对(不进口径)' : '    marked not right (left out of the rules)'); }
    }
  }
  if (!interactive) console.log('\nCheck them with "estratto rules preview <id>", then "estratto rules confirm <id>" or "estratto rules reject <id>".');
}

async function cmdInit(args) {
  const interactive = !args.yes && isTTY();
  if (!args.yes && !interactive) throw new UsageError('not a terminal: pass --yes together with --data/--duckdb/--scan/--pg-url/--mysql-url (and optionally --provider/--base-url/--model; the key is read from ESTRATTO_API_KEY, the database password from ESTRATTO_DB_PASSWORD)');
  const lang = interactive ? (args.language === 'en' ? 'en' : 'zh') : (args.language === 'zh' ? 'zh' : 'en');
  const zhOut = lang === 'zh';
  const t = CD.strings(lang);
  const p = interactive ? makePrompter() : null;
  let madeDir = null;
  try {
    let name = args.name, provider = args.provider, baseURL = args['base-url'] || (args.yes ? process.env.ESTRATTO_BASE_URL : undefined), model = args.model || (args.yes ? process.env.ESTRATTO_MODEL : undefined);
    if (interactive && !name) name = await p.ask(t.wsName, 'default');
    name = name || 'default';
    W.checkName(name);

    // ---- data: from the options, or (interactive) by asking ----
    const dataGiven = (args.data && args.data.length) || args.duckdb || (args.scan && args.scan.length) || args['pg-url'] || args['mysql-url'] || args.postgres || args.mysql || args.sqlite;
    let chosen;
    if (dataGiven) chosen = await sourcesFromArgs(args);
    else if (interactive) {
      const defaultWh = path.join(home(args), name, 'warehouse.duckdb');
      chosen = await CD.runDataWizard(p, { lang, name, defaultWarehouse: defaultWh, maxRows: W.DEFAULT_MAX_ROWS, onSecret: addSecret });
      if (!chosen) return 1;
    } else throw new UsageError('missing data: pass --data <path>..., --duckdb <file>, --scan <folder>..., --pg-url or --mysql-url');
    if (!chosen.sources.length) throw new UsageError('missing data');

    // ---- create the workspace (the key and database passwords go to secrets.json only) ----
    const config = {
      data: { sources: chosen.sources, ...(chosen.warehouse ? { warehouse: chosen.warehouse } : {}) },
      ...(args.rules && args.rules.length ? { rules: { packs: args.rules.map(f => path.resolve(f)) } } : {}),
      ...(interactive ? { model: { provider: 'custom' } } : { model: { provider: provider || (baseURL ? 'custom' : 'deepseek'), ...(baseURL ? { baseURL } : {}), ...(model ? { model } : {}), ...(args.thinking ? { thinking: args.thinking } : {}) } }),
      ...(args['daily-budget'] != null ? { limits: { dailyBudgetUSD: Number(args['daily-budget']) } } : {}),
      behavior: { ...(args['no-vectors'] ? { vectors: false } : {}), ...(args.timezone ? { timezone: args.timezone } : {}), ...(args.language ? { language: args.language } : {}), ...(args.anchor ? { anchor: args.anchor } : {}) },
      ...(args.port != null ? { surfaces: { serve: { port: Number(args.port) } } } : {}),
    };
    if (!interactive && provider && !W.PROVIDERS[provider]) throw new UsageError('--provider must be deepseek, openai or custom');
    if (!interactive && !W.PROVIDERS[config.model.provider]) throw new UsageError('--provider must be deepseek, openai or custom');
    let key = null;
    if (!interactive) { key = process.env.ESTRATTO_API_KEY || null; if (key) addSecret(key); }
    const made = await W.initWorkspace({ home: home(args), name, config, apiKey: key || null });
    madeDir = made.dir;
    console.log((zhOut ? '工作区已建好: ' : 'Workspace created: ') + made.dir);

    // ---- import (progress lines), then show what is in there ----
    console.log(t.importing);
    const prog = CD.progressPrinter(lang, l => console.log(l));
    let ws;
    try { ws = await W.openWorkspace({ home: home(args), name }, { onEvent: e => { warnEvent(e); prog(e); } }); }
    catch (e) { try { fs.rmSync(made.dir, { recursive: true, force: true }); } catch (_) {} madeDir = null; throw new UsageError((zhOut ? '导入没成功,工作区没有保留: ' : 'The import failed; the workspace was not kept: ') + String(e && e.message || e)); }
    wsRedact = ws.redact.str;
    try {
      const sum = await ws.dataSummary();
      console.log(t.imported(sum.length));
      for (const l of CD.summaryLines(sum, lang)) console.log(l);

      // ---- model ----
      if (interactive) {
        provider = provider || await p.ask(t.provider, 'deepseek');
        const pd = W.PROVIDERS[provider] || W.PROVIDERS.custom;
        if (!W.PROVIDERS[provider]) throw new UsageError('--provider must be deepseek, openai or custom');
        baseURL = baseURL || await p.ask(t.baseURL, pd.baseURL || undefined);
        model = model || await p.ask(t.modelName, pd.model || undefined);
        key = await p.hidden(t.apiKey);
        if (key) { addSecret(key); await ws.setApiKey(key); }
        await ws.saveConfig({ model: { provider, ...(baseURL ? { baseURL } : {}), ...(model ? { model } : {}), thinking: args.thinking || pd.thinking } });
      }
      console.log(zhOut ? 'API key: ' + (key ? '已设置(存在 secrets.json,权限 0600)' : '未设置') : 'API key: ' + (key ? 'set (stored in secrets.json, mode 0600)' : 'not set' + (args.yes ? ' (ESTRATTO_API_KEY was empty)' : '')));
      const cur = ws.config;
      if (!cur.model.baseURL || !cur.model.model) console.log('Model is not complete yet: estratto config set model.baseURL <url> ; estratto config set model.model <name>');

      // ---- rules ----
      await confirmMetrics(ws, p, interactive, zhOut);
    } finally { await ws.close(); }
    console.log(zhOut ? '\nMCP 配置(粘贴到你的 agent 的 MCP 设置里;这台机器上别的东西都没改):' : '\nMCP config (paste into your agent\'s MCP settings; nothing else was changed on this machine):');
    console.log(j(mcpSnippet(name, args)));
    console.log((zhOut ? '\n本地页面:  ' : '\nLocal page:  ') + serveCmd(name, args));
    madeDir = null;
    return 0;
  } finally {
    if (p) p.close();
    void madeDir;
  }
}

// ---- other workspace commands ----
async function cmdStatus(args) {
  const ws = await openWs(args);
  try {
    const cfg = ws.config, e = ws.engine, info = e.info(), u = ws.usage.today();
    const st = { name: cfg.name, dir: ws.dir, sources: cfg.data.sources, refresh: cfg.data.refresh, tables: e.tables().filter(t => !t.excluded).map(t => ({ name: t.name, columns: t.columns.length, hidden: !!t.hidden })), rules: info.rules, metrics: e.rules.metrics().reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {}), model: { provider: cfg.model.provider, baseURL: cfg.model.baseURL, model: cfg.model.model }, apiKey: ws.keyStatus(), usage: u, hiddenColumns: cfg.privacy.hiddenColumns, lastRefreshAt: info.lastRefreshAt || null, version: info.version };
    if (args.json) { console.log(j(st)); return 0; }
    console.log(`workspace   ${st.name}  (${st.dir})`);
    console.log(`version     ${st.version}`);
    console.log(`data        ${st.sources.map(srcLabel).join(', ')}   refresh=${st.refresh}`);
    console.log(`tables      ${st.tables.map(t => t.name + '(' + t.columns + ')').join(', ')}`);
    console.log(`rules       ${st.rules}; metrics ${Object.entries(st.metrics).map(([k, v]) => k + ' ' + v).join(', ') || 'none'}`);
    console.log(`model       ${st.model.provider} ${st.model.model || '(not set)'} @ ${st.model.baseURL || '(no url)'}`);
    console.log(`api key     ${st.apiKey}`);
    console.log(`spend today ${u.spentUSD.toFixed(4)} USD${u.limitUSD != null ? ' of ' + u.limitUSD : ' (no daily limit)'}   calls ${u.calls}`);
    if (st.hiddenColumns.length) console.log(`hidden      ${st.hiddenColumns.join(', ')}`);
    return 0;
  } finally { await ws.close(); }
}

async function cmdAdd(args) {
  const p = args._[1];
  const hasNew = (args.scan && args.scan.length) || args.sqlite || args.postgres || args.mysql || args['pg-url'] || args['mysql-url'];
  if (!p && !hasNew && !args.refresh) throw new UsageError('usage: estratto add <path> | --scan <folder>... [--pick all|globs] | --sqlite <file> [--tables a,b] | --postgres <url> --tables a,b | --mysql <url> --tables a,b | --refresh');
  const items = [];
  if (p) items.push(CD.expandHome(p));
  if (hasNew) {
    const picked = await sourcesFromArgs({ ...args, data: [], duckdb: undefined, db: undefined });
    items.push(...picked.sources);
  }
  for (const it of items) if (it && it.password) addSecret(it.password);
  const ws = await openWs(args, { onEvent: e => { warnEvent(e); progressLine(e); } });
  try {
    if (items.length) {
      await ws.addSources(items);
      console.log('Added. Tables: ' + ws.engine.tables().filter(t => !t.excluded).map(t => t.name).join(', '));
      const sum = await ws.dataSummary();
      for (const l of CD.summaryLines(sum, args.language === 'zh' ? 'zh' : 'en')) console.log(l);
    }
    if (args.refresh) {
      const r = await ws.refreshData();
      console.log(r.refreshed ? 'Refreshed: ' + r.tables.join(', ') : 'Nothing changed.');
      if (r.failed && r.failed.length) { for (const f of r.failed) console.error(`[error] ${f.file || 'refresh'}: ${f.message}`); return 1; }
    }
    return 0;
  } finally { await ws.close(); }
}
const progressLine = (() => { const pr = CD.progressPrinter('en', l => console.log(l)); return e => pr(e); })();

async function cmdRules(args) {
  const sub = args._[1] || 'list', id = args._[2];
  const ws = await openWs(args);
  try {
    const e = ws.engine;
    if (sub === 'list') {
      const ms = e.rules.metrics(), ds = e.rules.dimensions();
      if (args.json) { console.log(j({ mode: e.info().rules, metrics: ms, dimensions: ds, records: e.rules.list({ kind: 'auto_confirm' }) })); return 0; }
      for (const m of ms) console.log(`${m.id}  ${m.name}  [${m.status}]  metric/${m.kind}  ${m.formula}${m.unit ? '  (' + m.unit + ')' : ''}${m.recordId ? '  record ' + m.recordId : ''}`);
      for (const d of ds) console.log(`${d.id}  ${d.name}  [${d.status}]  dimension/${d.kind}  ${d.formula}${d.recordId ? '  record ' + d.recordId : ''}`);
      if (!ms.length && !ds.length) console.log('(no metrics)');
      return 0;
    }
    if (sub === 'preview') {
      const ids = id ? [id] : e.rules.metrics().filter(m => m.status === 'unconfirmed' || m.status === 'reverted').map(m => m.id);
      const outs = [];
      for (const x of ids) outs.push(await e.rules.preview(x));
      if (args.json) { console.log(j(id ? outs[0] : outs)); return 0; }
      for (const p of outs) {
        if (p.kind === 'dimension') { console.log(`${p.id}  ${p.label}  = ${p.dataset}.${p.field}\n   ${p.distinct} distinct values${p.nullCount ? ', ' + p.nullCount + ' empty rows' : ''}   top 5 by rows: ${p.top.map(x => x.value + ' (' + x.count + ')').join(', ') || '-'}\n   (shown on this machine only; never sent to the model)`); continue; }
        console.log(`${p.id}  ${p.label}  = ${p.formula}\n   all data: ${fmtNum(p.total, p.decimals)}${p.unit ? ' ' + p.unit : ''}   last full month: ${p.lastMonth ? p.lastMonth.period + ' ' + fmtNum(p.lastMonth.value, p.decimals) : '-'}${p.note ? '   (' + p.note + ')' : ''}${p.currencyNote ? '\n   note: ' + p.currencyNote + (p.byCurrency && p.byCurrency.length ? ' -- ' + p.byCurrency.map(x => x.currency + ' ' + fmtNum(x.value, p.decimals)).join(', ') : '') : ''}`);
      }
      return 0;
    }
    if (['confirm', 'reject', 'revert'].includes(sub)) {
      if (!id) throw new UsageError('usage: estratto rules ' + sub + ' <id>');
      const r = await e.rules[sub](id, { by: 'host' });
      console.log(sub + ' ok: ' + (r.id || id) + (r.status ? ' (' + r.status + ')' : ''));
      return 0;
    }
    if (sub === 'export') {
      if (!id) throw new UsageError('usage: estratto rules export <file>');
      const data = { schema: 'estratto-rules-export/1', workspace: ws.config.name, exportedAt: new Date().toISOString(), mode: e.info().rules, metrics: e.rules.metrics(), dimensions: e.rules.dimensions(), records: e.rules.list({ kind: 'auto_confirm' }), patches: e.rules.list().filter(x => x.kind !== 'auto_confirm') };
      const f = path.resolve(id);
      fs.writeFileSync(f, clean(JSON.stringify(data, null, 2)) + '\n', { mode: 0o600 });
      console.log('Exported ' + data.metrics.length + ' metrics to ' + f);
      return 0;
    }
    if (sub === 'import') {
      if (!id) throw new UsageError('usage: estratto rules import <file>');
      let data; try { data = JSON.parse(fs.readFileSync(path.resolve(id), 'utf8')); } catch (_) { throw new UsageError('cannot read ' + id + ' as JSON'); }
      if (!data || data.schema !== 'estratto-rules-export/1' || !Array.isArray(data.metrics)) throw new UsageError('not an estratto rules export (schema estratto-rules-export/1)');
      const here = new Map([...e.rules.metrics(), ...e.rules.dimensions()].map(m => [m.id, m]));
      const res = { confirmed: 0, rejected: 0, skipped: 0 };
      for (const m of [...data.metrics, ...(Array.isArray(data.dimensions) ? data.dimensions : [])]) {
        const cur = here.get(m.id);
        if (!cur || !m.auto || cur.status === m.status) { res.skipped++; continue; }
        try {
          if (m.status === 'confirmed' && cur.status !== 'confirmed') { await e.rules.confirm(m.id, { by: 'host' }); res.confirmed++; }
          else if (m.status === 'rejected' && cur.status === 'unconfirmed') { await e.rules.reject(m.id, { by: 'host' }); res.rejected++; }
          else res.skipped++;
        } catch (_) { res.skipped++; }
      }
      console.log(`Imported: ${res.confirmed} confirmed, ${res.rejected} marked not right, ${res.skipped} skipped. (Patches in the file are not imported.)`);
      return 0;
    }
    throw new UsageError('unknown rules command: ' + sub);
  } finally { await ws.close(); }
}

const ARRAY_KEYS = new Set(['privacy.hiddenColumns', 'rules.packs', 'surfaces.serve.allowedOrigins']);
const SETTABLE = ['model', 'limits', 'privacy', 'behavior', 'rules', 'surfaces', 'data.refresh', 'data.refreshMinutes', 'data.maxRowsPerTable'];
function getPath(o, k) { return k.split('.').reduce((x, p) => (x && typeof x === 'object' ? x[p] : undefined), o); }
async function cmdConfig(args) {
  const sub = args._[1] || 'get';
  if (sub === 'set-key') {
    const ws = await openWs(args);
    try {
      let key = interactiveKey();
      key = await key;
      if (!key) throw new UsageError('no key given (set ESTRATTO_API_KEY, or run in a terminal)');
      addSecret(key);
      console.log('api key: ' + await ws.setApiKey(key));
      return 0;
    } finally { await ws.close(); }
  }
  const dir = W.workspaceDir(home(args), wsName(args));
  const { config } = W.readConfig({ dir });
  if (sub === 'get') {
    const view = JSON.parse(JSON.stringify(config)); view.access = { ownerToken: '(set)' }; if (view.surfaces && view.surfaces.serve && view.surfaces.serve.token) view.surfaces.serve.token = '(set)';
    const k = args._[2];
    const v = k ? (k === 'access.ownerToken' || k === 'surfaces.serve.token' ? '(hidden)' : getPath(view, k)) : view;
    if (v === undefined) throw new UsageError('no such setting: ' + k);
    console.log(typeof v === 'string' ? v : j(v));
    return 0;
  }
  if (sub === 'set') {
    const k = args._[2]; const raw = args._.slice(3).join(' ');
    if (!k || args._.length < 4) throw new UsageError('usage: estratto config set <key> <value>');
    if (!SETTABLE.some(p => k === p || k.startsWith(p + '.'))) throw new UsageError('cannot set ' + k + ' here (data sources: "estratto add"; the key: "estratto config set-key")');
    let v; try { v = JSON.parse(raw); } catch (_) { v = raw; }
    if (ARRAY_KEYS.has(k) && !Array.isArray(v)) v = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    const patch = {}; let cur = patch; const parts = k.split('.');
    parts.forEach((p, i) => { if (i === parts.length - 1) cur[p] = v; else { cur[p] = {}; cur = cur[p]; } });
    const ws = await openWs(args);
    try { const c = await ws.saveConfig(patch); const nv = k === 'surfaces.serve.token' ? '(set)' : getPath(c, k); console.log(k + ' = ' + (typeof nv === 'string' ? nv : JSON.stringify(nv))); return 0; } finally { await ws.close(); }
  }
  throw new UsageError('unknown config command: ' + sub);
}
async function interactiveKey() {
  if (isTTY()) return askHidden('API key (input hidden)');
  return process.env.ESTRATTO_API_KEY || '';
}

async function cmdUsage(args) {
  const { dir, config } = W.readConfig({ dir: W.workspaceDir(home(args), wsName(args)) });
  const l = createLedger({ file: path.join(dir, 'usage.jsonl'), timezone: config.behavior.timezone, price: config.limits.price, dailyBudgetUSD: config.limits.dailyBudgetUSD });
  const t = l.today(), recent = l.list(10);
  if (args.json) { console.log(j({ today: t, totalUSD: l.totalUSD(), recent })); return 0; }
  console.log(`today ${t.day}: ${t.spentUSD.toFixed(4)} USD in ${t.calls} calls${t.limitUSD != null ? ' (limit ' + t.limitUSD + ')' : ' (no daily limit)'}`);
  console.log(`all time: ${l.totalUSD().toFixed(4)} USD`);
  if (!config.limits.price) console.log('note: no price configured (limits.price), costs show as 0');
  for (const r of recent) console.log(`  ${r.at}  ${String(r.requestId || '').slice(0, 24).padEnd(24)}  ${r.costUSD.toFixed(6)} USD  tokens ${r.usage ? (r.usage.total_tokens ?? ((r.usage.prompt_tokens || 0) + (r.usage.completion_tokens || 0))) : '-'}`);
  return 0;
}

async function cmdDoctor(args) {
  const checks = [];
  const add = (level, name, detail) => checks.push({ level, name, detail });
  const [maj, min] = process.versions.node.split('.').map(Number);
  add(maj > 22 || (maj === 22 && min >= 5) ? 'ok' : 'fail', 'node', 'v' + process.versions.node + ' (needs >= 22.5)');
  const h = home(args);
  let name = null; try { name = wsName(args); } catch (e) { add('fail', 'workspace', e.message); }
  let dir = null, config = null;
  if (name) {
    dir = W.workspaceDir(h, name);
    if (!fs.existsSync(dir)) add('fail', 'workspace', 'missing: ' + dir);
    else {
      add('ok', 'workspace', dir);
      const mode = f => { try { return fs.statSync(f).mode & 0o777; } catch (_) { return null; } };
      const dm = mode(dir); add(dm != null && (dm & 0o077) === 0 ? 'ok' : 'warn', 'directory permissions', dm == null ? 'unreadable' : dm.toString(8) + (dm & 0o077 ? ' (should be 700)' : ''));
      for (const f of ['estratto.json', 'secrets.json']) { const m = mode(path.join(dir, f)); add(m == null ? (f === 'secrets.json' ? 'warn' : 'fail') : ((m & 0o077) === 0 ? 'ok' : 'fail'), f + ' permissions', m == null ? 'missing' : m.toString(8) + ((m & 0o077) ? ' (should be 600)' : '')); }
      try { config = W.readConfig({ dir }).config; add('ok', 'config', 'valid'); } catch (e) { add('fail', 'config', e.message); }
    }
  }
  if (config) {
    const dbPw = W.readSecrets(dir).connections || {};
    for (const s of config.data.sources) {
      if (s.path) { add(fs.existsSync(s.path) ? 'ok' : 'fail', 'source ' + s.type, s.path); continue; }
      add('ok', 'source ' + s.type, srcLabel(s));
      const pw = dbPw[s.id] && dbPw[s.id].password;
      if (pw) addSecret(pw);
      add(pw ? 'ok' : 'warn', 'database password', pw ? 'set (secrets.json)' : 'not set (fine only if the server needs no password)');
      if (args.online) {
        try { const r = await require('../src/snapshot.js').listSource(s, pw || null, {}); add('ok', 'database ' + s.name, `connected read-only; ${r.tables.length} table(s) visible`); }
        catch (e) { add('fail', 'database ' + s.name, 'not reachable: ' + String(e && e.message || e).slice(0, 160)); }
      }
    }
    const files = W.expandSources(config.data.sources.filter(s => s.type !== 'duckdb'));
    if (config.data.sources.some(s => s.type === 'folder')) add(files.length ? 'ok' : 'fail', 'folder files', files.length + ' file(s) match');
    for (const p of config.rules.packs) add(fs.existsSync(p) ? 'ok' : 'fail', 'rules pack', p);
    let key = null; try { key = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).apiKey || null; } catch (_) {}
    if (key) addSecret(key);
    add(key ? 'ok' : 'warn', 'api key', key ? 'set' : 'not set (fine for a local model server without a key)');
    add(config.model.baseURL && config.model.model ? 'ok' : 'fail', 'model', `${config.model.provider} ${config.model.model || '(no model)'} @ ${config.model.baseURL || '(no url)'}`);
    if (config.behavior.vectors) add(fs.existsSync(path.join(dir, 'models', 'multilingual-e5-small')) ? 'ok' : 'warn', 'vector model', fs.existsSync(path.join(dir, 'models', 'multilingual-e5-small')) ? 'present' : 'not installed (value matching runs without vectors; see scripts/fetch-model.js)');
    try { const f = path.join(dir, 'usage.jsonl'); fs.accessSync(fs.existsSync(f) ? f : dir, fs.constants.W_OK); add('ok', 'usage log', 'writable'); } catch (_) { add('fail', 'usage log', 'not writable'); }
    try {
      const ws = await W.openWorkspace({ dir }, { onEvent: () => {} });
      wsRedact = ws.redact.str;
      const t = ws.engine.tables().filter(x => !x.excluded);
      add('ok', 'engine', t.length + ' table(s): ' + t.map(x => x.name).join(', '));
      await ws.close();
    } catch (e) { add('fail', 'engine', String(e && e.message || e).slice(0, 200)); }
    if (args.online && config.model.baseURL) {
      try {
        const r = await fetch(config.model.baseURL.replace(/\/+$/, '') + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {}, signal: AbortSignal.timeout(8000) });
        add(r.ok ? 'ok' : 'warn', 'model server', 'GET /models -> HTTP ' + r.status);
      } catch (e) { add('fail', 'model server', 'not reachable: ' + String(e && e.cause && e.cause.code || e && e.message || e).slice(0, 120)); }
    }
  }
  if (args.json) console.log(j(checks));
  else for (const c of checks) console.log(`[${c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'warn' : 'FAIL'}] ${c.name}: ${c.detail}`);
  return checks.some(c => c.level === 'fail') ? 1 : 0;
}

async function cmdServe(args) {
  const { startServe } = require('../src/serve/index.js');
  const ws = await openWs(args);
  const token = args.token != null ? args.token : (ws.config.surfaces.serve.token || undefined);
  if (token !== undefined && !/^[A-Za-z0-9._~-]{16,200}$/.test(String(token))) throw new UsageError('--token must be 16-200 characters: letters, digits, . _ ~ -');
  const pc = args['print-config'];
  if (pc !== undefined && pc !== 'json') throw new UsageError('--print-config supports only: json');
  const srv = await startServe(ws, { port: args.port != null ? Number(args.port) : undefined, sessionToken: token, log: s => console.error('[serve] ' + s) });
  if (pc === 'json') {
    // one JSON line on stdout for hosts: no text to parse (stable token: --token or surfaces.serve.token; otherwise random per start)
    console.log(JSON.stringify({ name: ws.config.name, endpoint: srv.url, port: srv.port, token: srv.sessionToken, tokenStable: token !== undefined, settingsUrl: srv.settingsUrl, ownerKey: ws.config.access.ownerToken }));
    await new Promise(resolve => { for (const s of ['SIGINT', 'SIGTERM']) process.once(s, resolve); });
    await srv.close(); await ws.close();
    return 0;
  }
  console.log(`Estratto is serving workspace "${ws.config.name}" on this machine only.`);
  console.log('Ask page:       ' + srv.url + '/');
  console.log('Settings page:  ' + srv.settingsUrl + '   (the link carries the owner key; keep it private)');
  console.log('Session token:  ' + srv.sessionToken + '   (embedders send it as X-Estratto-Token; ' + (token !== undefined ? 'fixed by --token / surfaces.serve.token' : 'it changes on every start; pin it with --token') + ')');
  console.log('Press Ctrl+C to stop.');
  await new Promise(resolve => { for (const s of ['SIGINT', 'SIGTERM']) process.once(s, resolve); });
  await srv.close(); await ws.close();
  return 0;
}

async function cmdMcp(args) {
  toStderr = true;
  const { runMcp } = require('../src/mcp.js');
  const ws = await openWs(args);
  try { await runMcp(ws); } finally { await ws.close(); }
  return 0;
}

// ---- ask (unchanged) ----
async function cmdAsk(args) {
  const question = args._.slice(1).join(' ').trim();
  if (!question) { console.error('missing question\n' + USAGE); return 2; }
  if (!args.data || !args.data.length) { console.error('missing --data\n' + USAGE); return 2; }
  const baseURL = args['base-url'] || process.env.ESTRATTO_BASE_URL;
  const modelName = args.model || process.env.ESTRATTO_MODEL;
  if (!baseURL || !modelName) { console.error('--base-url and --model (or ESTRATTO_BASE_URL / ESTRATTO_MODEL) are required'); return 2; }

  const isDuck = args.data.length === 1 && /\.(duckdb|db|ddb)$/i.test(args.data[0]);
  const data = isDuck ? { duckdb: path.resolve(args.data[0]) } : { files: args.data.map(f => path.resolve(f)) };
  const rules = (args.rules || []).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  const dataDir = path.resolve(args['data-dir'] || '.estratto');
  const engine = await createEngine({
    dataDir, data, ...(rules.length ? { rules } : {}),
    model: openaiCompatible({ baseURL, apiKey: process.env.ESTRATTO_API_KEY, model: modelName, thinking: args.thinking || 'false_bool', thinkingRepair: args['thinking-repair'], timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined }),
    vectors: !args['no-vectors'], modelsDir: args['models-dir'] ? path.resolve(args['models-dir']) : undefined,
    anchor: args.anchor, timezone: args.timezone, reuse: !args['no-reuse'], sqlFallback: !args['no-sql'],
    onEvent: warnEvent,
  });
  try {
    const r = await engine.ask(question);
    if (args.json || args.raw) {
      const { raw, ...rest } = r;
      console.log(JSON.stringify(args.raw ? r : rest, (k, v) => typeof v === 'bigint' ? Number(v) : v, 2));
    } else {
      console.log(r.answerLine || '(no answer)');
      console.error('[status] ' + r.status + '  route=' + r.route + '  calls=' + r.usage.calls);
      if (r.confirm) console.error('[confirm] ' + r.confirm.kind + (r.confirm.options && r.confirm.options.length ? ' options=' + JSON.stringify(r.confirm.options) : ''));
    }
    return r.status === 'verified' ? 0 : (r.status === 'needs_confirm' || r.status === 'unverified' || r.status === 'no_data') ? 3 : 1;
  } finally { await engine.close(); }
}

const COMMANDS = { init: cmdInit, status: cmdStatus, add: cmdAdd, rules: cmdRules, config: cmdConfig, doctor: cmdDoctor, usage: cmdUsage, serve: cmdServe, mcp: cmdMcp, ask: cmdAsk };

async function main() {
  let args;
  try { args = parse(process.argv.slice(2)); } catch (e) { console.error(e.message + '\n' + USAGE); return 2; }
  const cmd = args._[0];
  if (args.help || !cmd || cmd === 'help') { console.log(USAGE); return cmd || args.help ? 0 : 2; }
  const fn = COMMANDS[cmd];
  if (!fn) { console.error('unknown command: ' + cmd + '\n' + USAGE); return 2; }
  try { return await fn(args); }
  catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
}

main().then(code => { process.exitCode = code; }, err => { console.error(String(err && err.message || err)); process.exitCode = 1; });
