'use strict';
// rc.8 CLI helpers for choosing and describing data: used by `estratto init` and `estratto add`.
// The terminal prompts live here (plain Chinese; English with --language en); bin/estratto.js only wires them in.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('./workspace.js');
const { discover } = require('./discover.js');
const snapshot = require('./snapshot.js');

const S = {
  zh: {
    dbQ: '你有没有已经在用的数据库?',
    dbOpts: ['没有(用引擎自带的)', '有:SQLite 文件', '有:PostgreSQL', '有:MySQL', '有:DuckDB 文件'],
    choose: '请选(输入序号)', chooseBad: '没看懂,请输入列表里的序号。',
    whereDb: def => `引擎自带的数据库(DuckDB)放在哪?直接回车用默认位置`,
    whereBad: m => `这个位置不行:${m}`,
    dbCreated: f => `数据库放在:${f}(导入完成后生成)`,
    whereData: '数据在哪?把文件夹或文件路径给我(可以给多个,用逗号隔开)',
    onlyLook: '只会看你给的这些位置,不会去翻别的地方。',
    scanning: '正在看这些位置…',
    nothing: '没找到能用的数据(支持 csv、tsv、xlsx、parquet、SQLite、DuckDB)。换个位置再试?',
    skippedNote: n => `(有 ${n} 个位置按安全规则跳过了:隐藏文件夹、系统和密码相关文件夹等)`,
    truncated: '文件太多,只看了前一部分,可以给更具体的文件夹。',
    found: n => `找到 ${n} 个可以导入的数据:`,
    pickQ: '导入哪些?(all=全部,或序号如 1,3 / 1-3)', pickBad: '没看懂,请输入 all 或序号,例如 1,3 或 1-3。',
    duckMixed: 'DuckDB 文件只能单独用,不能和别的数据混着导入。请只选这一个,或者不选它。',
    tablesOf: f => `${f} 里有这些表:`, tablePick: '导入哪些表?(all=全部,或序号)',
    overLimit: n => `超过 ${n} 行上限,不能导入`,
    askPath: kind => kind === 'sqlite' ? 'SQLite 文件的路径(或它所在的文件夹)' : 'DuckDB 文件的路径(或它所在的文件夹)',
    connHost: '数据库地址', connPort: '端口', connDb: '数据库名', connUser: '用户名', connPass: '密码(输入时不显示)', connSchema: 'schema', connSsl: '用加密连接(SSL)吗?(y/n)',
    testing: '正在连接…', connOk: '连上了(只读方式,不会改你的数据库)。', connFail: m => `连不上:${m}`, retry: '再试一次?(y/n)', gaveUp: '没有连上,先停在这里。',
    tablesIn: db => `${db} 里有这些表:`,
    importing: '开始导入…', importStart: (t, n) => `  导入 ${t}${n != null ? `(${n.toLocaleString('en-US')} 行)` : ''}`, importProgress: (r, n) => `    已读 ${r.toLocaleString('en-US')}${n ? ' / ' + n.toLocaleString('en-US') : ''} 行`, importDone: (t, r) => `  完成 ${t}:${r.toLocaleString('en-US')} 行`,
    imported: n => `已导入 ${n} 张表:`, sumHead: ['表', '行数', '日期范围'], noDate: '(没有日期列)',
    rowsWord: '行', colsWord: '列', sheetsWord: '个工作表', tablesWord: '张表',
    ruleQ: '对吗?  y=对 / n=不对 / s=先跳过',
    provider: '模型服务商(deepseek / openai / custom)', baseURL: '服务地址', modelName: '模型名', apiKey: 'API key(输入时不显示,留空=不设)',
    wsName: '工作区名字',
  },
  en: {
    dbQ: 'Do you already use a SQL database?',
    dbOpts: ['No (use the engine\'s own)', 'Yes: a SQLite file', 'Yes: PostgreSQL', 'Yes: MySQL', 'Yes: a DuckDB file'],
    choose: 'Choose (number)', chooseBad: 'Not understood, please type a number from the list.',
    whereDb: def => 'Where should the engine\'s own database (DuckDB) live? Press Enter for the default',
    whereBad: m => `That location does not work: ${m}`,
    dbCreated: f => `The database will be at: ${f} (created when the import finishes)`,
    whereData: 'Where is your data? Give me folders or file paths (several allowed, separated by commas)',
    onlyLook: 'Only these locations are looked at; nothing else on this machine is read.',
    scanning: 'Looking…',
    nothing: 'No usable data found (csv, tsv, xlsx, parquet, SQLite and DuckDB are supported). Try another location?',
    skippedNote: n => `(${n} location(s) were skipped by the safety rules: hidden folders, system and credential folders, ...)`,
    truncated: 'Too many files: only the first part was looked at. Give a more specific folder.',
    found: n => `Found ${n} item(s) you can import:`,
    pickQ: 'Import which? (all, or numbers like 1,3 / 1-3)', pickBad: 'Not understood. Type all, or numbers like 1,3 or 1-3.',
    duckMixed: 'A DuckDB file can only be used on its own, not mixed with other data. Pick only that one, or leave it out.',
    tablesOf: f => `${f} has these tables:`, tablePick: 'Import which tables? (all, or numbers)',
    overLimit: n => `over the ${n}-row limit, cannot be imported`,
    askPath: kind => kind === 'sqlite' ? 'Path of the SQLite file (or the folder it is in)' : 'Path of the DuckDB file (or the folder it is in)',
    connHost: 'Database host', connPort: 'Port', connDb: 'Database name', connUser: 'User name', connPass: 'Password (hidden while typing)', connSchema: 'Schema', connSsl: 'Use an encrypted connection (SSL)? (y/n)',
    testing: 'Connecting…', connOk: 'Connected (read-only; your database is not changed).', connFail: m => `Could not connect: ${m}`, retry: 'Try again? (y/n)', gaveUp: 'Not connected, stopping here.',
    tablesIn: db => `${db} has these tables:`,
    importing: 'Importing…', importStart: (t, n) => `  importing ${t}${n != null ? ` (${n.toLocaleString('en-US')} rows)` : ''}`, importProgress: (r, n) => `    read ${r.toLocaleString('en-US')}${n ? ' / ' + n.toLocaleString('en-US') : ''} rows`, importDone: (t, r) => `  done ${t}: ${r.toLocaleString('en-US')} rows`,
    imported: n => `Imported ${n} table(s):`, sumHead: ['table', 'rows', 'date range'], noDate: '(no date column)',
    rowsWord: 'rows', colsWord: 'columns', sheetsWord: 'sheets', tablesWord: 'tables',
    ruleQ: 'Right?  y=right / n=not right / s=skip for now',
    provider: 'Model provider (deepseek / openai / custom)', baseURL: 'Base URL', modelName: 'Model name', apiKey: 'API key (hidden while typing; empty = none)',
    wsName: 'Workspace name',
  },
};
const strings = lang => S[lang === 'en' ? 'en' : 'zh'];

let HOME_DIR = '';
const setHome = h => { HOME_DIR = h; };   // the CLI shell passes the home folder in; src/ never reads it itself
const expandHome = p => HOME_DIR ? String(p).replace(/^~(?=$|[\\/])/, HOME_DIR) : String(p);
const fmtN = n => n == null ? '?' : Number(n).toLocaleString('en-US');
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i];
}

/** "all" / "全部" / "1,3" / "1-3" -> sorted unique 0-based indices, or null when it cannot be understood */
function parsePick(input, n, def = 'all') {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) s = def;
  if (['all', '全部', 'a', '*', '所有'].includes(s)) return Array.from({ length: n }, (_, i) => i);
  const out = new Set();
  for (const tok of s.split(/[\s,，、]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(tok);
    if (!m) return null;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > n) return null;
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

const globRe = pat => new RegExp('^' + String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
/** non-interactive --pick: "all" or comma-separated globs against the file name or the full path */
function pickByGlobs(cands, spec) {
  const s = String(spec == null ? 'all' : spec).trim();
  if (!s || s.toLowerCase() === 'all') return cands.slice();
  const res = s.split(',').map(x => x.trim()).filter(Boolean).map(globRe);
  return cands.filter(c => res.some(re => re.test(c.name) || re.test(c.path)));
}

function describeCandidate(c, lang) {
  const t = strings(lang);
  const tabs = c.tables || [];
  let extra = '';
  if (c.kind === 'csv' || c.kind === 'tsv' || c.kind === 'parquet') extra = tabs[0] && tabs[0].rows != null ? `${fmtN(tabs[0].rows)} ${t.rowsWord}` : '';
  else if (c.kind === 'xlsx') extra = tabs.length ? `${tabs.length} ${t.sheetsWord}: ${tabs.slice(0, 4).map(x => x.name + (x.rows != null ? ` ${fmtN(x.rows)}` : '')).join(', ')}${tabs.length > 4 ? ' …' : ''}` : '';
  else extra = tabs.length ? `${tabs.length} ${t.tablesWord}: ${tabs.slice(0, 4).map(x => x.name + (x.rows != null ? ` ${fmtN(x.rows)}` : '')).join(', ')}${tabs.length > 4 ? ' …' : ''}` : '';
  if (c.error) extra = c.error === 'file_in_use' ? (lang === 'en' ? 'in use by another program' : '正在被别的程序占用') : (lang === 'en' ? 'cannot be read' : '读不了');
  if (c.note === 'too_large_for_preview') extra = (lang === 'en' ? 'large file, not previewed' : '文件很大,没做预览') + (extra ? '; ' + extra : '');
  return { kind: c.kind, name: c.name, size: fmtSize(c.size), extra };
}
function candidateLines(cands, lang) {
  const rows = cands.map((c, i) => ({ i: i + 1, ...describeCandidate(c, lang), dir: path.dirname(c.path) }));
  const w = k => Math.max(...rows.map(r => String(r[k]).length));
  const wk = w('kind'), wn = Math.min(40, w('name')), ws = w('size');
  return rows.map(r => `  ${String(r.i).padStart(2)}. ${r.kind.padEnd(wk)}  ${r.name.padEnd(wn)}  ${r.size.padStart(ws)}  ${r.extra}   [${r.dir}]`);
}

/** candidates -> config sources. tables: optional {path: [names]} restricting sqlite files */
function candidatesToSources(cands, tablesFor = {}) {
  return cands.map(c => {
    if (c.kind === 'sqlite') return { type: 'sqlite', path: c.path, ...(tablesFor[c.path] && tablesFor[c.path].length ? { tables: tablesFor[c.path] } : {}) };
    if (c.kind === 'duckdb') return { type: 'duckdb', path: c.path };
    return { type: 'file', path: c.path };
  });
}
function checkMixed(sources, lang) {
  const duck = sources.filter(s => s.type === 'duckdb');
  if (duck.length && sources.length > 1) return strings(lang).duckMixed;
  return null;
}

// ---- database URLs (passwords are never kept) ----
/** @returns {{ spec, password: string|null }} spec has no password; a password inside the URL is returned separately and only as a fallback */
function parseDbUrl(url, kind) {
  let u; try { u = new URL(String(url)); } catch (_) { throw new Error('the database URL is not valid (example: postgres://user@host:5432/dbname)'); }
  const proto = u.protocol.replace(/:$/, '').toLowerCase();
  const type = proto === 'postgres' || proto === 'postgresql' ? 'postgres' : (proto === 'mysql' || proto === 'mariadb' ? 'mysql' : null);
  if (!type) throw new Error('the database URL must start with postgres:// or mysql://');
  if (kind && kind !== type) throw new Error(`this option takes a ${kind} URL`);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Error('the database URL needs a database name (…/dbname)');
  const spec = { type, host: u.hostname.replace(/^\[|\]$/g, ''), database, user: decodeURIComponent(u.username || '') };
  if (!spec.user) throw new Error('the database URL needs a user name (user@host)');
  if (u.port) spec.port = Number(u.port);
  const q = u.searchParams;
  if (type === 'postgres' && q.get('schema')) spec.schema = q.get('schema');
  const ssl = (q.get('sslmode') || q.get('ssl') || '').toLowerCase();
  if (['require', 'verify-ca', 'verify-full', 'true', '1'].includes(ssl)) spec.ssl = true;
  else if (ssl === 'no-verify') spec.ssl = 'no-verify';
  return { spec, password: u.password ? decodeURIComponent(u.password) : null };
}

// ---- discovery from the command line (non-interactive) ----
async function scanAndPick(paths, pickSpec, { kinds = null } = {}) {
  const found = await discover(paths.map(expandHome), kinds ? { kinds } : {});
  return { found, picked: pickByGlobs(found, pickSpec) };
}

// ---- the interactive wizard -----------------------------------------------------------------------------------------
/**
 * p: { ask(label, def), hidden(label), say(line) }.  Returns { sources, warehouse?, wantsDefault } or null when the user gave up.
 * Database passwords come back inside the source object (`password`); initWorkspace moves them into secrets.json.
 */
async function runDataWizard(p, { lang, name, defaultWarehouse, maxRows, onSecret }) {
  const t = strings(lang);
  const say = l => p.say(l);

  // (2) do you already have a database?
  say(t.dbQ);
  t.dbOpts.forEach((o, i) => say(`  ${i + 1}) ${o}`));
  let choice;
  for (;;) { const a = (await p.ask(t.choose, '1')).trim(); if (/^[1-5]$/.test(a)) { choice = Number(a); break; } say(t.chooseBad); }
  const kind = ['none', 'sqlite', 'postgres', 'mysql', 'duckdb'][choice - 1];

  const out = { sources: [] };
  if (kind === 'none') {
    for (;;) {
      const w = path.resolve(expandHome((await p.ask(t.whereDb(defaultWarehouse), defaultWarehouse)).trim() || defaultWarehouse));
      const why = checkWarehousePath(w);
      if (why) { say(t.whereBad(why)); continue; }
      if (w !== path.resolve(defaultWarehouse)) out.warehouse = w;
      say(t.dbCreated(w));
      break;
    }
  }

  if (kind === 'postgres' || kind === 'mysql') {
    const src = await askConnection(p, t, kind, maxRows, say);
    if (!src) { say(t.gaveUp); return null; }
    if (src.password && onSecret) onSecret(src.password);
    out.sources.push(src);
    return out;
  }

  // (3) scan ONLY the places the user names
  say(t.onlyLook);
  const kinds = kind === 'sqlite' ? ['sqlite'] : kind === 'duckdb' ? ['duckdb'] : null;
  for (;;) {
    const raw = kind === 'sqlite' || kind === 'duckdb' ? await p.ask(t.askPath(kind)) : await p.ask(t.whereData);
    const paths = raw.split(/[,，]/).map(x => x.trim()).filter(Boolean);
    if (!paths.length) continue;
    say(t.scanning);
    const found = await discover(paths.map(expandHome), kinds ? { kinds } : {});
    if (found.skipped.length) say(t.skippedNote(found.skipped.length));
    if (found.truncated) say(t.truncated);
    if (!found.length) { say(t.nothing); continue; }
    say(t.found(found.length));
    for (const l of candidateLines(found, lang)) say(l);
    // (4) pick
    let picked;
    for (;;) {
      const idx = parsePick(await p.ask(t.pickQ, 'all'), found.length);
      if (!idx) { say(t.pickBad); continue; }
      picked = idx.map(i => found[i]);
      const mixed = checkMixed(candidatesToSources(picked), lang);
      if (mixed) { say(mixed); continue; }
      break;
    }
    // which tables of a database file
    const tablesFor = {};
    for (const c of picked.filter(c => c.kind === 'sqlite' && c.tables && c.tables.length > 1)) {
      say(t.tablesOf(c.name));
      c.tables.forEach((x, i) => say(`  ${String(i + 1).padStart(2)}. ${x.name}  ${fmtN(x.rows)} ${t.rowsWord}${x.rows != null && maxRows && x.rows > maxRows ? '  (' + t.overLimit(fmtN(maxRows)) + ')' : ''}`));
      for (;;) {
        const idx = parsePick(await p.ask(t.tablePick, 'all'), c.tables.length);
        if (!idx) { say(t.pickBad); continue; }
        if (idx.length < c.tables.length) tablesFor[c.path] = idx.map(i => c.tables[i].name);
        break;
      }
    }
    out.sources = candidatesToSources(picked, tablesFor);
    return out;
  }
}

function checkWarehousePath(w) {
  try {
    if (fs.existsSync(w)) return fs.statSync(w).isDirectory() ? 'that is a folder; give a file path such as …/warehouse.duckdb' : 'a file is already there';
    const dir = path.dirname(w);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
    return null;
  } catch (e) { return String(e && e.message || e).slice(0, 120); }
}

async function askConnection(p, t, type, maxRows, say) {
  const isPg = type === 'postgres';
  let d = { host: 'localhost', port: String(isPg ? 5432 : 3306), database: '', user: '', schema: 'public', ssl: 'n' };
  for (;;) {
    const host = await p.ask(t.connHost, d.host);
    const port = await p.ask(t.connPort, d.port);
    const database = await p.ask(t.connDb, d.database || undefined);
    const user = await p.ask(t.connUser, d.user || undefined);
    const password = await p.hidden(t.connPass);
    const schema = isPg ? await p.ask(t.connSchema, d.schema) : null;
    const ssl = /^y/i.test(await p.ask(t.connSsl, d.ssl));
    d = { host, port, database, user, schema: schema || 'public', ssl: ssl ? 'y' : 'n' };
    let spec;
    try { spec = W.normalizeSource({ type, host, port: Number(port), database, user, ...(isPg ? { schema } : {}), ...(ssl ? { ssl: true } : {}), tables: ['_'] }); }
    catch (e) { say(t.connFail(e.message)); if (!/^y/i.test(await p.ask(t.retry, 'y'))) return null; continue; }
    say(t.testing);
    let listing;
    try { listing = await snapshot.listSource(spec, password || null, { maxRows }); }
    catch (e) { say(t.connFail(String(e && e.message || e))); if (!/^y/i.test(await p.ask(t.retry, 'y'))) return null; continue; }
    say(t.connOk);
    if (!listing.tables.length) { say(t.connFail(isPg ? `no tables in schema "${spec.schema}"` : 'no tables')); if (!/^y/i.test(await p.ask(t.retry, 'y'))) return null; continue; }
    say(t.tablesIn(isPg ? `${database}.${spec.schema}` : database));
    listing.tables.forEach((x, i) => say(`  ${String(i + 1).padStart(2)}. ${x.name}${x.kind === 'view' ? ' (view)' : ''}  ${x.approx ? '~' : ''}${fmtN(x.rows)} ${t.rowsWord}, ${x.columns.length} ${t.colsWord}${x.overLimit ? '  (' + t.overLimit(fmtN(maxRows)) + ')' : ''}`));
    let chosen;
    for (;;) {
      const idx = parsePick(await p.ask(t.tablePick, 'all'), listing.tables.length);
      if (!idx) { say(t.pickBad); continue; }
      chosen = idx.map(i => listing.tables[i]);
      break;
    }
    const { tables: _drop, ...rest } = spec;
    return { ...rest, tables: chosen.map(x => x.name), ...(password ? { password } : {}) };
  }
}

/** result lines for step 5: what was imported (table, rows, date range) */
function summaryLines(summary, lang) {
  const t = strings(lang);
  const rows = summary.map(s => [s.name, fmtN(s.rows), s.from ? `${s.from} ~ ${s.to}${s.dateColumn ? ` (${s.dateColumn})` : ''}` : t.noDate]);
  const head = t.sumHead;
  const w = i => Math.max(String(head[i]).length, ...rows.map(r => String(r[i]).length));
  const w0 = Math.min(44, w(0)), w1 = w(1);
  return [`  ${head[0].padEnd(w0)}  ${head[1].padStart(w1)}  ${head[2]}`, ...rows.map(r => `  ${r[0].padEnd(w0)}  ${r[1].padStart(w1)}  ${r[2]}`)];
}

/** an onEvent that prints import progress lines */
function progressPrinter(lang, write) {
  const t = strings(lang); let last = 0;
  return e => {
    if (!e) return;
    if (e.type === 'import_start') write(t.importStart(e.table, e.rowsTotal));
    else if (e.type === 'import_progress') { const now = Date.now(); if (now - last > 800) { last = now; write(t.importProgress(e.rows, e.rowsTotal)); } }
    else if (e.type === 'import_table') write(t.importDone(e.table, e.rows));
  };
}

module.exports = { strings, parsePick, pickByGlobs, parseDbUrl, scanAndPick, candidatesToSources, checkMixed, candidateLines, summaryLines, progressPrinter, runDataWizard, expandHome, setHome, fmtSize, fmtN, checkWarehousePath };
