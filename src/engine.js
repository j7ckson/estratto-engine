'use strict';
// estratto-engine: the arm-public.mjs wiring turned into a library. One engine = one dataDir.
// No module-level state is shared between engines; the engine never reads process.env or any credential file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const pkg = require('../package.json');
const { SemanticRegistry } = require('../core/main/semantic-registry.js');
const { EntityLookup } = require('../core/main/entity-lookup.js');
const { ask: coreAsk } = require('../core/main/ask.js');
const { ReuseCache } = require('../core/main/reuse.js');
const { SqliteReuseStore } = require('../core/main/cache-store.js');
const { FactBook } = require('../core/main/facts.js');
const planExecutor = require('../core/main/plan-executor.js');
const { buildIRMessages } = require('../core/main/ir-prompt.js');
const { buildAutoPack } = require('../core/main/auto-semantics.js');
const { applyChineseCurrency } = require('./auto-currency.js');
const rateGuard = require('./rate-guard.js');
const { PatchService } = require('../core/main/patch-service.js');
const { todayIn } = require('../core/main/time-core.js');

const { openDb, loadMeta } = require('./duck.js');
const { screenMeta, redactName } = require('./hostile.js');
const { importFiles } = require('./import.js');
const { protect, OutboundBlocked } = require('./privacy.js');
const { createLedger } = require('./ledger.js');
const { createVecBatch } = require('./vectors.js');
const fsx = require('./fsx.js');
const { makeRedactor } = require('./redact.js');
const { mapStatus, routeOf, confirmOf, checksOf } = require('./status.js');

const CODE_VERSION = 'estratto-engine@' + pkg.version;
const DEFAULT_LIMITS = { maxCallsPerQuestion: 2, maxCallsTotal: 4, maxTokensPerQuestion: 2000, maxOutputTokens: 400, memoryLimit: '2GB' };
const PENDING_MAX = 200;
const qid = s => '"' + String(s).replace(/"/g, '""') + '"';
const MAX_IR_ENTITIES = 200, MAX_IR_ITEMS = 2000, MAX_IR_JSON = 1000000, MAX_USAGE_BYTES = 16384;

// control characters (incl. CR/LF, C1, U+2028/2029) -> space, in every string of the model's IR
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// SQL text keeps \n \r \t (a `--` comment must still end at the line break, otherwise the rest of the
// query would be swallowed and the SQL lane would behave differently from P80); the ANSWER-line rule
// (first ANSWER line wins) covers spoofing through SQL text.
const CTRL_RE_SQL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;
function scrubControl(v, depth = 0, key = '') {
  if (typeof v === 'string') return v.replace(/^sql$/i.test(key) ? CTRL_RE_SQL : CTRL_RE, ' ');
  if (depth > 40 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => scrubControl(x, depth + 1, key));
  const out = {};
  for (const k of Object.keys(v)) out[k.replace(CTRL_RE, ' ')] = scrubControl(v[k], depth + 1, k);
  return out;
}
function countItems(v, depth = 0) {
  if (v == null || typeof v !== 'object' || depth > 40) return 0;
  if (Array.isArray(v)) return v.length + v.reduce((n, x) => n + countItems(x, depth + 1), 0);
  return Object.values(v).reduce((n, x) => n + countItems(x, depth + 1), 0);
}
function irTooLarge(ir) {
  if (Array.isArray(ir && ir.entities) && ir.entities.length > MAX_IR_ENTITIES) return 'more than ' + MAX_IR_ENTITIES + ' entities';
  if (countItems(ir) > MAX_IR_ITEMS) return 'more than ' + MAX_IR_ITEMS + ' array items';
  return null;
}
const USAGE_NUM_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cache_read_tokens', 'cache_write_tokens'];
function capUsage(u) {
  if (!u || typeof u !== 'object') return u || null;
  let size = 0; try { size = JSON.stringify(u).length; } catch (_) { size = Infinity; }
  if (size <= MAX_USAGE_BYTES) return u;
  const out = {};
  for (const k of USAGE_NUM_KEYS) if (typeof u[k] === 'number') out[k] = u[k];
  for (const dk of ['completion_tokens_details', 'prompt_tokens_details']) if (u[dk] && typeof u[dk] === 'object') { const d = {}; for (const k of ['reasoning_tokens', 'cached_tokens']) if (typeof u[dk][k] === 'number') d[k] = u[dk][k]; out[dk] = d; }
  return out;
}

// SQL written by the model must not read engine/catalog metadata. Shadowing a catalog name with a CTE slips past the AST table check,
// so the statement text is checked for the names themselves (bare or quoted, any case).
const CATALOG_RE = /(^|[^a-z0-9_$])(duckdb_[a-z0-9_]*|information_schema|pg_catalog|pg_[a-z0-9_]*|sqlite_[a-z0-9_]*|pragma_[a-z0-9_]*)(?![a-z0-9_$])/i;
function modelSqlOf(sql) {   // statements that carry model-written SQL: the runSql wrapper and the parse step
  const t = String(sql);
  if (/^\s*SELECT \* FROM \([\s\S]*\) AS _sql_lane LIMIT \d+\s*$/.test(t)) return true;
  if (/^\s*SELECT\s+json_serialize_sql\(/i.test(t)) return true;
  return false;
}
function assertSqlAllowed(sql) {
  if (modelSqlOf(sql) && CATALOG_RE.test(String(sql))) throw Object.assign(new Error('SQL 检查未通过：不许访问系统目录 / 元数据（duckdb_*、information_schema、pg_catalog、sqlite_*、pragma_*）'), { code: 'sql_catalog_blocked' });
}

// ---- helpers (copied from arm-public.mjs where noted) ----
// arm-public.mjs parseJsonLoose, verbatim
function parseJsonLoose(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_) {} }
  return null;
}
const jsonSafe = (k, v) => typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v;
const clone = x => JSON.parse(JSON.stringify(x, jsonSafe));

// arm-public.mjs: ANSWER line extraction
function answerLineOf(answer) {
  const a = answer == null ? '' : String(answer);
  const mLine = /^\s*ANSWER\s*[:：].*$/m.exec(a);
  return mLine ? mLine[0].replace(/（F\d+）/g, '') : ('ANSWER: ' + a.replace(/（F\d+）/g, '').replace(/\s*\n+\s*/g, '；').trim());
}

// Only the first line that starts with ANSWER counts. Any later such line (which could only come from text that originated in the
// model or in data labels) is demoted so it can neither be extracted nor mistaken for the verified answer.
function neutralizeExtraAnswerLines(answer) {
  const lines = String(answer).split(/\r\n|\r|\n|\u2028|\u2029/);
  let seen = false;
  const out = lines.map(l => { if (/^\s*ANSWER\s*[:：]/.test(l)) { if (!seen) { seen = true; return l; } return '- ' + l.trim(); } return l; });
  return out.join('\n');
}

// A SqliteReuseStore view that stops writing once the request was cancelled/refused: a late result must not reach reuse.db.
class GatedStore {
  constructor(inner, signal) { this.inner = inner; this.signal = signal; }
  _ok() { return !this.signal.aborted; }
  putKV(...a) { return this._ok() ? this.inner.putKV(...a) : false; }
  putSkeleton(...a) { return this._ok() ? this.inner.putSkeleton(...a) : false; }
  putPlan(...a) { return this._ok() ? this.inner.putPlan(...a) : false; }
  putResult(...a) { return this._ok() ? this.inner.putResult(...a) : false; }
  getKV(...a) { return this.inner.getKV(...a); }
  getSkeleton(...a) { return this.inner.getSkeleton(...a); }
  getPlan(...a) { return this.inner.getPlan(...a); }
  getResult(...a) { return this.inner.getResult(...a); }
  clear(...a) { return this.inner.clear(...a); }
  count() { return this.inner.count(); }
}

function normalizeModel(model) {
  if (!model || typeof model.generate !== 'function') throw new Error('createEngine: `model` must be openaiCompatible(...) or { generate(req, signal) }');
  return {
    generate: model.generate.bind(model),
    provider: model.providerName || model.provider || 'custom',
    name: model.modelName || model.model || 'custom',
  };
}

async function build(opts, res) {
  if (!opts || typeof opts !== 'object') throw new Error('createEngine: options required');
  if (!opts.dataDir || typeof opts.dataDir !== 'string') throw new Error('createEngine: dataDir is required');
  if (!opts.data || (!opts.data.duckdb && !(Array.isArray(opts.data.files) && opts.data.files.length))) throw new Error('createEngine: data.duckdb or data.files is required');
  const model = normalizeModel(opts.model);
  const dataDir = path.resolve(opts.dataDir);
  fsx.ensureDir(dataDir);
  const timezone = opts.timezone || 'Asia/Shanghai';
  const { dailyBudgetUSD: budgetIn, price: priceIn, ...limitsIn } = opts.limits || {};   // rc.6: budget keys are not engine limits
  const limits = { ...DEFAULT_LIMITS, ...limitsIn };
  const sqlFallback = opts.sqlFallback !== false;
  const workspace = opts.workspace || 'engine';
  const emitRaw = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const redactor = makeRedactor([]);
  const modelRedact = typeof opts.model.redact === 'function' ? opts.model.redact : (x => x);
  const redactAll = (v) => redactor.deep(typeof v === 'string' ? modelRedact(v) : JSON.parse(JSON.stringify(v, (k, x) => typeof x === 'bigint' ? (Number.isSafeInteger(Number(x)) ? Number(x) : x.toString()) : (typeof x === 'string' ? modelRedact(x) : x))));
  const emit = (e) => { if (!emitRaw) return; try { emitRaw(redactAll({ at: new Date().toISOString(), ...e })); } catch (_) {} };
  let closed = false;

  // ---- rc.6: usage ledger / daily budget (absent unless configured: the request path is untouched) ----
  const ledger = opts.ledger || ((budgetIn != null || priceIn) ? createLedger({ file: opts.usageFile === undefined ? path.join(dataDir, 'usage.jsonl') : opts.usageFile, timezone, price: priceIn || null, dailyBudgetUSD: budgetIn == null ? null : Number(budgetIn) }) : null);
  const language = opts.language === 'en' ? 'en' : 'zh';

  // ---- rc.6: hidden columns ('table.column', case-insensitive) ----
  const hiddenSpec = (opts.privacy && Array.isArray(opts.privacy.hiddenColumns)) ? [...new Set(opts.privacy.hiddenColumns.map(x => String(x).trim().toLowerCase()).filter(Boolean))] : [];
  let hiddenCols = [];   // [{table, column, type, tableHidden}]
  const hiddenNames = new Set(hiddenSpec.map(x => x.slice(x.lastIndexOf('.') + 1)).filter(Boolean));   // for the SQL guard
  function applyHidden(m0, r0, warnUnknown) {
    if (!hiddenSpec.length) return { meta: m0, raw: r0, hidden: [] };
    const hs = new Set(hiddenSpec), found = new Set(), hidden = [], outMeta = [], outRaw = [];
    const rawBy = new Map(r0.map(t => [t.name, t]));
    for (const t of m0) {
      const rt = rawBy.get(t.name) || { name: t.name, columns: [] };
      const isHid = c => hs.has((t.name + '.' + c.name).toLowerCase());
      const gone = t.columns.filter(isHid);
      for (const c of gone) { found.add((t.name + '.' + c.name).toLowerCase()); const rc = rt.columns.find(x => x.name === c.name); hidden.push({ table: t.name, column: c.name, type: rc ? rc.type : null, tableHidden: gone.length === t.columns.length }); }
      if (!gone.length) { outMeta.push(t); outRaw.push(rt); continue; }
      const keep = t.columns.filter(c => !isHid(c));
      if (!keep.length) continue;   // every column hidden: the table is not described at all
      outMeta.push({ ...t, columns: keep });
      outRaw.push({ ...rt, columns: rt.columns.filter(c => !isHid(c)) });
    }
    if (warnUnknown) for (const k of hs) if (!found.has(k)) emit({ type: 'warning', level: 'warning', code: 'hidden_column_not_found', message: 'hidden column not found: ' + k });
    return { meta: outMeta, raw: outRaw, hidden };
  }

  // ---- data ----
  let dbFile, readOnly = true, importInfo = null;
  if (opts.data.duckdb) {
    dbFile = path.resolve(opts.data.duckdb);
    if (!fs.existsSync(dbFile)) throw new Error('createEngine: duckdb file not found: ' + dbFile);
    readOnly = opts.data.readOnly !== false;
  } else {
    importInfo = await importFiles(opts.data.files, dataDir, { onEvent: emit, plan: opts.data.plan, warehouse: opts.data.warehouse, maxRows: opts.data.maxRows });
    dbFile = importInfo.file;
  }
  const autoRulesMode = !(Array.isArray(opts.rules) && opts.rules.length);   // rc.7: auto-rules mode (no supplied pack) gets the new column-type and currency handling
  let db, meta, rawMeta, excludedNames, dataStamp, privacySchema;
  const computeStamp = async () => {
    const st = fs.statSync(dbFile);
    const rows = [];
    for (const t of meta) rows.push([t.name, await db.rowCount(t.name).catch(() => null)]);
    const h = crypto.createHash('sha256').update(JSON.stringify({ size: st.size, mtimeMs: Math.round(st.mtimeMs), rows, cols: meta })).digest('hex').slice(0, 8);
    return path.basename(dbFile) + ':' + h;
  };
  // opens dbFile and (re)builds everything derived from its metadata; on refresh the old state stays if this throws
  async function openAndScreen(first) {
    const newDb = await openDb(dbFile, { readOnly, memoryLimit: limits.memoryLimit || '2GB', autoTypes: autoRulesMode });
    res.db = newDb;
    try {
      const loaded = await loadMeta(newDb);
      // rc.4: tables / columns whose names are unsafe to send to a model (control chars, > 64 chars) are left out of all metadata
      const screened = screenMeta(loaded.meta, loaded.raw, first ? emit : null);
      const hid = applyHidden(screened.meta, screened.raw, first);
      if (!hid.meta.length) throw new Error('createEngine: the database has no usable tables');
      db = newDb; meta = hid.meta; rawMeta = hid.raw; excludedNames = screened.excluded; hiddenCols = hid.hidden; privacySchema = { tables: meta };
      dataStamp = await computeStamp();
    } catch (err) {
      if (!first) { try { newDb.close(); } catch (_) {} res.db = db; }
      throw err;
    }
  }
  await openAndScreen(true);

  // ---- rules ----
  const rulesDir = path.join(dataDir, 'rules');
  fsx.ensureDir(rulesDir);
  const autoPackFile = path.join(rulesDir, 'auto-pack.json');
  let basePacks;
  let rulesMode;
  // Best effort: the app's import-time auto semantics (dictionary names, no model naming), see README "limits".
  async function generateAutoPack() {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(autoPackFile, 'utf8')); } catch (_) {}
    const { pack, report } = await buildAutoPack({ tables: rawMeta.map(t => ({ name: t.name, columns: t.columns.map(c => ({ name: c.name, type: c.type })) })), run: (sql) => db.adminRun(sql), namer: null, previous });
    // Auto-semantics notes embed row counts measured on the data ("有 3 行负数"). Counts are computed values: scrub them so the
    // notes that reach a model prompt (SQL fallback) describe structure only.
    if (pack._meta && Array.isArray(pack._meta.return_notes)) pack._meta.return_notes = pack._meta.return_notes.map(n => String(n).replace(/\d[\d,]*\s*行/g, '若干行'));
    // "not right" marks survive a regeneration
    if (previous) for (const kind of ['metrics', 'dims']) {
      const was = new Map((previous[kind] || []).filter(x => x && x.rejected).map(x => [x.id, x]));
      for (const x of pack[kind] || []) { const w = was.get(x.id); if (w) { x.rejected = true; x.rejected_at = w.rejected_at; x.rejected_by = w.rejected_by; } }
    }
    try { await applyChineseCurrency(pack, rawMeta, (sql) => db.adminRun(sql)); } catch (_) { /* best effort: without it the core's own reading stays */ }   // rc.7
    fsx.writeFile(autoPackFile, JSON.stringify(pack, null, 1));
    return { pack, report };
  }
  if (Array.isArray(opts.rules) && opts.rules.length) {
    basePacks = opts.rules.map(clone);
    rulesMode = 'provided';
  } else {
    const gen = await generateAutoPack();
    basePacks = [gen.pack];
    rulesMode = 'auto';
    emit({ type: 'rules_auto_generated', level: 'warning', tables: gen.report.tables, dictNamed: gen.report.dict_named, unnamed: gen.report.unnamed, note: 'auto-generated rules are unconfirmed; answers that depend on them report needs_confirm' });
  }

  // rc.4: every confirmation of auto-generated items is a listable, revertible record (dataDir/rules/auto-confirms.json)
  const confirmsFile = path.join(rulesDir, 'auto-confirms.json');
  let autoConfirms = [];
  try { const j = JSON.parse(fs.readFileSync(confirmsFile, 'utf8')); if (j && Array.isArray(j.records)) autoConfirms = j.records; } catch (_) {}
  const saveConfirms = () => { fsx.writeFile(confirmsFile, JSON.stringify({ schema: 'estratto-auto-confirms/1', records: autoConfirms }, null, 1)); };
  const bareId = x => String(x == null ? '' : x).replace(/^[md]:/, '');
  const liveConfirm = rec => rec.status === 'confirmed';

  // user-confirmed value readings ("Amazon" -> "Amazon US"), persisted next to the other engine state
  const aliasFile = path.join(dataDir, 'value-aliases.json');
  let valueAliases = {};
  try { valueAliases = JSON.parse(fs.readFileSync(aliasFile, 'utf8')) || {}; } catch (_) {}
  const aliasKey = (literal, table, col) => [table, col, String(literal).trim().toLowerCase()].join('\u0000');
  const rememberValue = (literal, { table, col, value }) => { valueAliases[aliasKey(literal, table, col)] = String(value); try { fsx.writeFile(aliasFile, JSON.stringify(valueAliases, null, 1)); } catch (_) {} };
  const lookupValueAlias = (literal, { table, col }) => valueAliases[aliasKey(literal, table, col)] || null;

  // vectors
  let vec = { vecBatch: undefined, status: 'disabled', reason: 'vectors:false' };
  if (opts.vectors !== false) {
    const modelsDir = opts.modelsDir || path.join(dataDir, 'models');
    vec = await createVecBatch({ modelsDir, onEvent: emit });
  }

  // reuse store
  if (opts.reuse !== false) for (const x of ['reuse.db', 'reuse.db-wal', 'reuse.db-shm']) fsx.touch(path.join(dataDir, x));   // created 0600 up front: SQLite gives -wal/-shm the db file's mode
  const reuseStore = opts.reuse === false ? null : new SqliteReuseStore({ dbPath: path.join(dataDir, 'reuse.db'), namespace: 'estratto' });
  res.reuseStore = reuseStore;

  // rc.6: auto items the owner marked "not right" (rejected:true) are left out of the registry; packs without such items are untouched
  function dropRejected(p) {
    if (!p || !((p.metrics || []).some(x => x && x.rejected) || (p.dims || []).some(x => x && x.rejected))) return p;
    return { ...p, metrics: (p.metrics || []).filter(x => !(x && x.rejected)), dims: (p.dims || []).filter(x => !(x && x.rejected)) };
  }
  // rc.6: a rule that is built on a hidden column is left out (its definition would name the column in the prompts); no-op without hiddenColumns
  function dropHidden(p) {
    if (!hiddenSpec.length || !p) return p;
    const hs = new Set(hiddenSpec), isHid = (t, c) => t != null && c != null && hs.has((String(t) + '.' + String(c)).toLowerCase());
    const dimHidden = d => {
      if (!d) return false;
      if (d.source && isHid(d.source.table, d.source.field)) return true;
      if (typeof d.role === 'string' && hs.has(d.role.toLowerCase())) return true;
      return (d.kind === 'column' || d.kind === 'timeBucket') && Array.isArray(d.match) && d.match.length === 1 && isHid(d.dataset, d.match[0]) && !d.role;
    };
    const gone = new Set();
    let metrics = (p.metrics || []).filter(m => { const h = m && m.kind !== 'ratio' && m.kind !== 'derived' && isHid(m.dataset, m.field); if (h) gone.add(m.id); return !h; });
    for (let again = true; again;) {   // ratio / derived metrics that use a removed metric go too
      again = false;
      metrics = metrics.filter(m => {
        const refs = m.kind === 'ratio' ? [m.num, m.den] : m.kind === 'derived' ? [...JSON.stringify(m.expr || '').matchAll(/"(?:m:)?([A-Za-z0-9_\-.]+)"/g)].map(x => x[1]) : [];
        const dead = refs.some(r => gone.has(String(r).replace(/^m:/, '')));
        if (dead) { gone.add(m.id); again = true; }
        return !dead;
      });
    }
    const dims = (p.dims || []).filter(d => !dimHidden(d));
    const relationships = (p.relationships || []).filter(r => !(r.pairs || []).some(pr => isHid(r.left, pr[0]) || isHid(r.right, pr[1])));
    if (metrics.length === (p.metrics || []).length && dims.length === (p.dims || []).length && relationships.length === (p.relationships || []).length) return p;
    return { ...p, metrics, dims, relationships };
  }
  // ---- runtime (registry + entity lookup); rebuilt after rule patches ----
  async function buildRuntime() {
    const registry = SemanticRegistry.load({ packs: basePacks.map(p => dropHidden(dropRejected(clone(p)))), tables: meta, partial: true, generatedDir: path.join(rulesDir, 'generated') });
    const lookup = new EntityLookup({ semantic: registry.semantic });
    const dims = [...registry.semantic.dims.values()].filter(d => !d.unbound && d.source && d.source.table && d.source.field);
    for (const d of dims) {
      if (String(d.kind || 'column') !== 'column') continue;
      if (/日期|date|month|时间/i.test(String(d.name) + ' ' + String(d.id) + ' ' + String(d.source.field))) continue;
      let vals = [];
      try { vals = await db.distinct(d.source.table, d.source.field); } catch (_) { continue; }
      if (!vals.length || vals.length > 2000) continue;
      await lookup.load(String(d.id).replace(/^d:/, ''), vals.map(r => ({ value: r.v, count: Number(r.n) })), { kind: d.kind });
    }
    return { registry, lookup };
  }
  let runtime = await buildRuntime();

  const patchService = new PatchService({ dir: rulesDir, tables: () => meta.map(t => ({ name: t.name, columns: t.columns.map(c => ({ ...c })) })) });

  const secureState = () => {
    for (const x of ['reuse.db', 'reuse.db-wal', 'reuse.db-shm', 'warehouse.duckdb', 'warehouse.duckdb.wal', 'import.json', 'value-aliases.json']) fsx.secureFile(path.join(dataDir, x));
    if (opts.data.warehouse) for (const x of [opts.data.warehouse, opts.data.warehouse + '.wal']) fsx.secureFile(x);
    fsx.secureTree(rulesDir);
  };
  secureState();

  // ---- request bookkeeping ----
  const inflight = new Map();     // requestId -> { ctrl, question }
  const pending = new Map();      // requestId -> { question, anchor, result }  (needs_confirm results awaiting engine.confirm)
  const rememberPending = (rid, rec) => { pending.delete(rid); pending.set(rid, rec); while (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value); };

  // ---- rc.6: data auto-refresh -------------------------------------------------------------------------------------------
  // files: size+mtime per file (new / removed files too, when data.resolveFiles is given); duckdb: size+mtime of the file.
  // Checked before an ask, at most every data.refreshIntervalMs (default 5000). A changed file re-imports only its own tables
  // (rules kept; dataStamp changes so cached answers do not outlive the old data). An unreadable file keeps its old tables.
  const dataRefreshOn = opts.data.refresh === 'auto';
  const refreshEvery = Number(opts.data.refreshIntervalMs) >= 0 ? Number(opts.data.refreshIntervalMs) : 5000;
  const resolveFiles = typeof opts.data.resolveFiles === 'function' ? opts.data.resolveFiles : null;
  const planSig = f => { try { const pl = typeof opts.data.plan === 'function' ? opts.data.plan(f) : null; return pl && pl.sig ? '|' + pl.sig : ''; } catch (_) { return ''; } };   // rc.8: which tables / which database a path stands for
  const statKey = f => { const st = fs.statSync(f); return st.size + ':' + Math.round(st.mtimeMs) + planSig(f); };
  const fileStamps = new Map();      // abs file -> key at the time its tables were built
  const failedStamps = new Map();    // abs file -> key of a version that could not be imported (not retried until it changes)
  let dbStampKey = null, lastCheck = Date.now(), refreshing = null, lastRefreshAt = null;
  if (importInfo) for (const e of (importInfo.manifest.stamp || [])) fileStamps.set(e.path, e.size + ':' + e.mtimeMs + (e.sig ? '|' + e.sig : ''));
  else { try { dbStampKey = statKey(dbFile); } catch (_) {} }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const schemaSig = () => JSON.stringify(rawMeta.map(t => [t.name, t.columns.map(c => [c.name, c.type])]));

  async function doRefresh() {
    let changedFiles = [], removedFiles = [], list = null, keys = new Map(), dbChanged = false;
    if (importInfo) {
      list = (resolveFiles ? resolveFiles() : (opts.data.files || [])).map(f => path.resolve(f));
      const present = [];
      for (const f of list) { try { keys.set(f, statKey(f)); present.push(f); } catch (_) { /* missing for now: keep its tables */ } }
      for (const f of present) { const k = keys.get(f); if (fileStamps.get(f) !== k && failedStamps.get(f) !== k) changedFiles.push(f); }
      if (resolveFiles) removedFiles = [...fileStamps.keys()].filter(f => !list.includes(f));
    } else {
      let k = null; try { k = statKey(dbFile); } catch (_) {}
      dbChanged = k != null && k !== dbStampKey;
      if (dbChanged) dbStampKey = k;
    }
    if (!changedFiles.length && !removedFiles.length && !dbChanged) return { refreshed: false, files: [], tables: [] };

    for (let i = 0; inflight.size && i < 1200; i++) await sleep(25);   // never swap the database under a running question
    if (inflight.size) { lastCheck = 0; return { refreshed: false, files: [], tables: [], busy: true }; }

    const sigBefore = schemaSig();
    const oldDb = db;
    const doneFiles = [], failures = [];
    if (importInfo) {
      try { oldDb.close(); } catch (_) {}
      const order = removedFiles.length ? [null, ...changedFiles] : changedFiles;
      for (const f of order) {
        const existing = list.filter(x => keys.has(x));
        try {
          importInfo = await importFiles(existing, dataDir, { onEvent: emit, plan: opts.data.plan, warehouse: opts.data.warehouse, maxRows: opts.data.maxRows, update: { changed: f ? [f] : [], removed: f ? [] : removedFiles } });
          if (f) { fileStamps.set(f, keys.get(f)); doneFiles.push(f); } else for (const r of removedFiles) { fileStamps.delete(r); doneFiles.push(r); }
        } catch (err) {
          if (f) failedStamps.set(f, keys.get(f));
          failures.push({ file: f ? path.basename(f) : null, message: String(err && err.message || err).slice(0, 600), code: err && err.code || null });
          emit({ type: 'warning', level: 'warning', code: 'data_refresh_failed', file: f ? path.basename(f) : null, message: 'could not refresh: ' + String(err && err.message || err).slice(0, 160) + ' (the previous data stays in use)' });
        }
      }
      await openAndScreen(false);
    } else {
      await openAndScreen(false);
      try { oldDb.close(); } catch (_) {}
      doneFiles.push(dbFile);
    }
    if (!doneFiles.length) return { refreshed: false, files: [], tables: [], ...(failures.length ? { failed: failures } : {}) };

    if (rulesMode === 'auto' && schemaSig() !== sigBefore) {   // columns changed: re-derive the auto rules, keeping what was confirmed
      const gen = await generateAutoPack();
      basePacks = [gen.pack];
    }
    runtime = await buildRuntime();
    secureState();
    lastRefreshAt = new Date().toISOString();
    const names = importInfo ? (importInfo.tables || []).filter(t => doneFiles.some(f => t.source === f || String(t.source).startsWith(f + '#'))).map(t => t.name) : meta.map(t => t.name);
    emit({ type: 'data_refreshed', files: doneFiles.map(f => path.basename(f)), tables: names, dataStamp });
    return { refreshed: true, files: doneFiles.map(f => path.basename(f)), tables: names, ...(failures.length ? { failed: failures } : {}) };
  }

  /** check now (force) or at most every refreshIntervalMs; concurrent callers share one refresh */
  async function refreshData({ force = false } = {}) {
    if (closed) return { refreshed: false, files: [], tables: [] };
    if (refreshing) return refreshing;
    const now = Date.now();
    if (!force && now - lastCheck < refreshEvery) return { refreshed: false, files: [], tables: [] };
    lastCheck = now;
    refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function run(question, o = {}) {
    if (closed) throw new Error('engine is closed');
    const t0 = Date.now();
    const rid = o.requestId != null ? String(o.requestId) : 'req_' + crypto.randomUUID();
    const q = typeof question === 'string' ? question.trim() : '';
    const baseAnchor = o.anchor || opts.anchor || todayIn(timezone);
    const errorResult = (code, message) => finalize({ status: 'error', code, message, llm_calls: 0, tokens: null }, { rid, question: q, anchor: baseAnchor, callLog: [], irCall: null, blocked: null, t0, ctrl: null });
    if (!q) return errorResult('bad_question', 'question must be a non-empty string');
    if (inflight.has(rid)) return errorResult('duplicate_request_id', 'a request with this requestId is already in flight');

    if (dataRefreshOn) { try { await refreshData(); } catch (err) { emit({ type: 'warning', level: 'warning', requestId: rid, message: 'data refresh failed: ' + String(err && err.message || err).slice(0, 160) }); } }
    try { if (patchService.ensureFresh()) runtime = await buildRuntime(); } catch (err) { emit({ type: 'warning', requestId: rid, message: 'rules hot reload failed: ' + String(err && err.message || err).slice(0, 160) }); }
    const rt = runtime;

    const ctrl = new AbortController();
    let onExternalAbort = null;
    if (o.signal) {
      if (o.signal.aborted) ctrl.abort(); else { onExternalAbort = () => ctrl.abort(); o.signal.addEventListener('abort', onExternalAbort, { once: true }); }
    }
    const st = { blocked: null, cancelRequested: false, budget: null };
    inflight.set(rid, { ctrl, question: q, st });
    emit({ type: 'ask_start', requestId: rid });

    const sess = await db.session();
    const callLog = [];
    const audit = [];
    let irCall = null;

    const executor = {
      async execute(plan, ctx) { return planExecutor.execute(plan, { registry: (ctx && ctx.registry) || rt.registry, cards: sess.cards }); },
    };
    const cache = reuseStore ? new ReuseCache({ store: new GatedStore(reuseStore, ctrl.signal) }) : new ReuseCache();
    const book = new FactBook();

    const resolveIR = async (payload) => {
      if (st.blocked) throw Object.assign(new Error('outbound_blocked: ' + st.blocked), { code: 'cancelled', outbound_blocked: true });
      if (ledger && ledger.exceeded()) {   // rc.6: daily budget reached -> no model call; cache hits never get here
        st.budget = ledger.today();
        emit({ type: 'budget_exceeded', requestId: rid, spentUSD: st.budget.spentUSD, limitUSD: st.budget.limitUSD });
        ctrl.abort();
        throw Object.assign(new Error('daily_budget_exceeded'), { code: 'cancelled', budget_exceeded: true });
      }
      const repair = !!(payload && payload.previous_errors && payload.previous_errors.length);
      const mm = buildIRMessages(Object.assign({}, payload, { question: q }));
      const messages = [{ role: 'system', content: mm.system }, { role: 'user', content: mm.user }];
      const g = protect({ messages }, q, privacySchema);
      if (!g.ok) {
        st.blocked = g.reason;
        emit({ type: 'outbound_blocked', requestId: rid, reason: g.reason });
        ctrl.abort();
        throw Object.assign(new Error('outbound_blocked: ' + g.reason), { code: 'cancelled', outbound_blocked: true });
      }
      if (g.changes.entitiesDropped || g.changes.errorsReduced) emit({ type: 'outbound_filtered', requestId: rid, entitiesDropped: g.changes.entitiesDropped, errorsReduced: g.changes.errorsReduced });
      const req = { messages: g.body.messages, maxOutputTokens: limits.maxOutputTokens, temperature: 0, purpose: 'ir', repair };
      emit({ type: 'model_request', requestId: rid, purpose: req.purpose, repair, messageChars: messages[0].content.length + messages[1].content.length });
      const r0 = await model.generate(req, ctrl.signal);
      const r = r0 && typeof r0 === 'object' ? r0 : { text: '' };
      if (ledger) { try { ledger.record({ requestId: rid, providerRequestId: r.request_id || null, model: r.model || model.name, usage: capUsage(r.usage) || null }); } catch (_) {} }
      const rec = {
        text: r.text == null ? '' : String(r.text), reasoning: r.reasoning == null ? null : String(r.reasoning),
        usage: capUsage(r.usage) || null, finish_reason: r.finish_reason || null, request_id: r.request_id || ('req_' + crypto.randomUUID()),
        provider: r.provider || model.provider, model: r.model || model.name,
        content_len: r.content_len != null ? r.content_len : (r.text == null ? 0 : String(r.text).length),
        reasoning_len: r.reasoning_len != null ? r.reasoning_len : (r.reasoning == null ? 0 : String(r.reasoning).length),
        request_params: r.request_params ?? null, concurrency: 1,
      };
      irCall = rec;
      callLog.push({ provider: rec.provider, model: rec.model, request_id: rec.request_id, at: new Date().toISOString(), usage: rec.usage, finish_reason: rec.finish_reason, purpose: 'ir', purpose_note: 'engine_provider_request', content_len: rec.content_len, reasoning_len: rec.reasoning_len, request_params: rec.request_params, concurrency: 1 });
      emit({ type: 'model_response', requestId: rid, finishReason: rec.finish_reason, usage: rec.usage });
      const ir0 = parseJsonLoose(rec.text);
      if (ir0) {
        let big = irTooLarge(ir0);
        if (!big && String(rec.text).length > MAX_IR_JSON) big = 'plan larger than ' + MAX_IR_JSON + ' characters';
        if (big) return { ok: false, code: 'model_error', message: 'IR refused (resource cap): ' + big, usage: rec.usage, provider: rec.provider, model: rec.model, finish_reason: rec.finish_reason, request_id: rec.request_id };
      }
      const ir = ir0 ? scrubControl(ir0) : ir0;
      if (!ir) return { ok: false, code: 'model_error', message: '模型没有返回合法 JSON：' + String(rec.text).slice(0, 160), usage: rec.usage, provider: rec.provider, model: rec.model, finish_reason: rec.finish_reason, request_id: rec.request_id };
      return { ok: true, ir, usage: rec.usage, provider: rec.provider, model: rec.model, finish_reason: rec.finish_reason, request_id: rec.request_id, reasoning: rec.reasoning };
    };

    const askOpts = {
      ...(vec.vecBatch ? { vecBatch: vec.vecBatch } : {}),
      registry: rt.registry, cache, facts: book, book, entityLookup: rt.lookup, executor,
      anchor: baseAnchor, timezone, scope: { workspace },
      dataStamp, permissionVersion: 'perm/engine', codeVersion: CODE_VERSION,
      resolveIR, callLog, maxCallsPerQuestion: limits.maxCallsPerQuestion, maxTokensPerQuestion: limits.maxTokensPerQuestion,
      provider: model.provider, model: model.name,
      allowLocalZeroCall: false,
      sqlLane: sqlFallback,
      sqlRunner: async (sql) => { assertSqlAllowed(sql); if (hiddenNames.size) assertNoHidden(sql); return sess.run(sql); },
      cancelSql: async () => sess.interrupt(),
      audit: (e) => { audit.push(e); emit({ type: 'sql_audit', requestId: rid, kind: e && e.kind, ok: e && e.ok, tier: e && e.tier || null }); },
      maxCallsTotal: limits.maxCallsTotal,
      rememberValue, lookupValueAlias,
      signal: ctrl.signal,
      ...(o.valueChoice ? { valueChoice: o.valueChoice } : {}),
      ...(o.confirmedPlan ? { confirmedPlan: o.confirmedPlan } : {}),
    };

    const aborted = new Promise(resolve => { if (ctrl.signal.aborted) resolve('aborted'); else ctrl.signal.addEventListener('abort', () => resolve('aborted'), { once: true }); });
    let result;
    const work = (async () => {
      try { return await coreAsk(q, askOpts); }
      catch (err) { return { status: 'error', code: 'arm_exception', message: String(err && err.stack || err).slice(0, 600), llm_calls: callLog.length, tokens: null, _threw: err }; }
    })();
    try {
      const winner = await Promise.race([work, aborted]);
      if (winner === 'aborted') {
        sess.interrupt();
        result = null;
        work.catch(() => {}).finally(() => sess.close());
      } else {
        result = winner;
        sess.close();
      }
    } finally {
      if (o.signal && onExternalAbort) o.signal.removeEventListener('abort', onExternalAbort);
      inflight.delete(rid);
    }

    if (st.blocked) {
      emit({ type: 'ask_end', requestId: rid, status: 'refused' });
      return finalize({ status: 'refused', code: 'outbound_blocked', message: 'outbound request blocked by the privacy transport: ' + st.blocked, facts: [], answer: '', llm_calls: callLog.length, tokens: null }, { rid, question: q, anchor: baseAnchor, callLog, irCall, blocked: st.blocked, t0, ctrl, audit, rt });
    }
    if (st.budget) {
      emit({ type: 'ask_end', requestId: rid, status: 'refused' });
      const b = st.budget;
      const msg = language === 'en'
        ? 'Today\'s model spending has reached the daily limit (' + b.spentUSD.toFixed(4) + ' of ' + b.limitUSD + ' USD). Questions answered from saved results still work; try again tomorrow or raise the limit.'
        : '今天的模型花费已达每日上限（已花 ' + b.spentUSD.toFixed(4) + ' 美元，上限 ' + b.limitUSD + ' 美元）。已有缓存结果的问题仍可回答；明天再问，或调高上限。';
      return finalize({ status: 'refused', code: 'daily_budget_exceeded', message: msg, facts: [], answer: 'ANSWER: ' + msg, llm_calls: callLog.length, tokens: null }, { rid, question: q, anchor: baseAnchor, callLog, irCall, blocked: null, budget: b, t0, ctrl, audit, rt });
    }
    if (!result || ctrl.signal.aborted) {
      emit({ type: 'ask_end', requestId: rid, status: 'cancelled' });
      return finalize({ status: 'cancelled', code: 'cancelled', message: 'request cancelled', facts: [], answer: '', llm_calls: callLog.length, tokens: null }, { rid, question: q, anchor: baseAnchor, callLog, irCall, blocked: null, t0, ctrl, audit, rt });
    }
    if (rulesMode === 'auto') {   // rc.7: a rate / share / average question is never answered with a plain total (all routes); pack mode is untouched
      try { const g = rateGuard.guard(q, result, rt.registry, language); if (g) result = g; } catch (_) { /* the guard is best effort: the answer stands */ }
      try { result = currencyGuard(result, rt.registry); } catch (_) {}
    }
    const out = finalize(result, { rid, question: q, anchor: baseAnchor, callLog, irCall, blocked: null, t0, ctrl, audit, rt, picked: o.valueChoice || null });
    if (out.status === 'needs_confirm') rememberPending(rid, { question: q, anchor: baseAnchor, result });
    else pending.delete(rid);
    emit({ type: 'ask_end', requestId: rid, status: out.status, route: out.route });
    return out;
  }


  // ---- rc.7: amounts in several currencies (auto rules) --------------------------------------------------------------------------
  // The plan route already appends "含多种币种，未换汇，不能直接相加" (the metric carries multi_currency). The SQL lane writes its own SQL: if that SQL
  // reads a multi-currency money column and does not split by the currency column, the same note is appended here.
  const CUR_NOTE = { zh: '含多种币种，未换汇，不能直接相加', en: 'mixed currencies, not converted, cannot be added up directly' };
  function currencyGuard(result, registry) {
    if (!result || result.status !== 'ok' || result.lane !== 'sql' || !result.sql || !Array.isArray(result.facts) || !result.facts.length) return result;
    const pack = basePacks[0];
    if (!pack || pack.id !== 'auto_ws' || !pack._meta || !pack._meta.currency) return result;
    const sql = String(result.sql).toLowerCase();
    let hit = false;
    for (const [table, cur] of Object.entries(pack._meta.currency)) {
      if (!cur || !cur.multi || !sql.includes(String(table).toLowerCase())) continue;
      if (cur.col && sql.includes(String(cur.col).toLowerCase())) continue;   // split by (or filtered on) the currency column: fine
      for (const m of pack.metrics || []) if (m.dataset === table && m.multi_currency && !m.rejected && m.field && sql.includes(String(m.field).toLowerCase())) hit = true;
    }
    if (!hit) return result;
    const note = CUR_NOTE[language] || CUR_NOTE.zh;
    const answer = String(result.answer == null ? '' : result.answer);
    if (answer.includes(note)) return result;
    const lines = answer.split('\n');
    let i = lines.findIndex(l => /^\s*ANSWER\s*[:：]/.test(l));
    if (i < 0) i = lines.length - 1;
    lines[i] = /[）)]\s*$/.test(lines[i]) ? lines[i].replace(/[）)]\s*$/, '；' + note + '）') : lines[i] + '（' + note + '）';
    return { ...result, answer: lines.join('\n'), currency_note: note };
  }

  // ---- rc.7: answers that cannot be turned into "verified" by a click ----------------------------------------------------------------
  const NOT_CONFIRMABLE = {
    sql_not_confirmable: { zh: '这类新算法 1.0 还不能一键确认，请在口径里把它定义成指标。', en: 'This kind of new calculation cannot be confirmed with one click in 1.0. Define it as a metric in the rules instead.' },
    no_such_metric: { zh: '数据里还没有对应的指标，没有可以确认的答案。请先在口径里定义这个指标（例如 分子 ÷ 分母），再重新提问。', en: 'The data has no such metric yet, so there is no answer to confirm. Define the metric in the rules (for example numerator ÷ denominator) and ask again.' },
  };
  function notConfirmable(rid, pend, kind) {
    const msg = (NOT_CONFIRMABLE[kind] || NOT_CONFIRMABLE.sql_not_confirmable)[language] || NOT_CONFIRMABLE[kind].zh;
    const out = finalize({ status: 'capability_gap', code: kind, answer: 'ANSWER: ' + msg, message: msg, facts: [], rows: [], llm_calls: 0, calls_this_turn: 0, tokens: null, zero_llm: true, route: (pend.result && pend.result.lane === 'sql') ? 'sql_not_confirmable' : 'not_confirmable', lane: pend.result && pend.result.lane || undefined },
      { rid, question: pend.question, anchor: pend.anchor, callLog: [], irCall: null, blocked: null, t0: Date.now(), ctrl: null, rt: runtime });
    out.refusal = { code: kind, reason: msg };
    if (pend.result && pend.result.lane === 'sql') out.route = 'sql';
    return out;
  }

  // ---- rc.6: explicit rule items (auto metrics / dimensions) and the "look at the numbers" preview ----
  const AGG_WORDS = { zh: { sum: '合计', dcount: '去重个数', avg: '平均值', min: '最小值', max: '最大值' }, en: { sum: 'sum', dcount: 'distinct count', avg: 'average', min: 'minimum', max: 'maximum' } };
  function formulaText(m, reg) {
    if (!m) return '';
    const nameOf = id => { try { const x = reg.metric(id); return x ? x.name : String(id); } catch (_) { return String(id); } };
    if (m.kind === 'ratio') return nameOf(m.num) + ' ÷ ' + nameOf(m.den) + (m.mul && m.mul !== 1 ? ' × ' + m.mul : '');
    if (m.kind === 'derived') return typeof m.expr === 'string' ? m.expr : JSON.stringify(m.expr);
    const ds = m.dataset || m.boundTo || '', f = m.field || '';
    if (m.agg === 'count') return language === 'en' ? 'row count of ' + ds : ds + ' 表 记录数';
    const w = (AGG_WORDS[language] || AGG_WORDS.zh)[m.agg] || m.agg || '';
    return language === 'en' ? w + ' of ' + ds + '.' + f : ds + ' 表 ' + f + ' ' + w;
  }
  function dimText(d) {
    if (!d || !d.dataset) return '';
    if (d.kind === 'timeBucket') return language === 'en' ? 'by ' + (d.grain || 'month') + ' of ' + d.dataset + '.' + d.field : d.dataset + ' 表 ' + d.field + ' 按' + ({ day: '日', week: '周', month: '月', quarter: '季度', year: '年' }[d.grain || 'month'] || d.grain) + '分组';
    return language === 'en' ? 'values of ' + d.dataset + '.' + d.field : d.dataset + ' 表 ' + d.field + ' 列的取值';
  }
  const savePack = () => fsx.writeFile(autoPackFile, JSON.stringify(basePacks[0], null, 1));
  function autoItemOf(id) {   // the auto-generated metric / dimension this id names (m:/d: prefix optional, metrics first)
    const pack = basePacks[0];
    if (rulesMode !== 'auto' || !pack || pack.id !== 'auto_ws') return null;
    const raw = String(id == null ? '' : id), b = bareId(raw);
    const m = raw.startsWith('d:') ? null : (pack.metrics || []).find(x => x.id === b);
    if (m) return { kind: 'metric', x: m };
    const d = raw.startsWith('m:') ? null : (pack.dims || []).find(x => x.id === b);
    return d ? { kind: 'dim', x: d } : null;
  }
  const recordFor = (list, id) => [...list].reverse().find(c => (c.items || []).some(i => bareId(i.id) === bareId(id)));
  async function afterRuleChange(action, id) {
    if (reuseStore) reuseStore.clear('semantic');
    runtime = await buildRuntime(); secureState();
    emit({ type: 'rules_changed', action, id });
  }
  async function confirmAutoItem(it, o) {
    const by = (o && (o.by || o.decided_by)) || 'host';
    if (by === 'model') throw Object.assign(new Error('confirm must be decided by a person'), { code: 'no_decider' });
    const id = (it.kind === 'metric' ? 'm:' : 'd:') + it.x.id;
    if (it.x.confirmed) throw Object.assign(new Error('already confirmed: ' + id), { code: 'already_confirmed' });
    const rev = recordFor(autoConfirms.filter(c => !liveConfirm(c)), id);
    if (rev && !it.x.rejected) return setAutoConfirm(rev, true, o, 'confirm');
    const at = new Date().toISOString();
    delete it.x.rejected; delete it.x.rejected_at;
    it.x.auto = false; it.x.confirmed = true; it.x.confirmed_by = by; it.x.confirmed_at = at;
    savePack();
    const rec = { id: 'ac_' + crypto.randomUUID().slice(0, 12), kind: 'auto_confirm', status: 'confirmed', items: [{ kind: it.kind, id }], refs: [id], decided_by: by, at, request_id: null };
    autoConfirms.push(rec); saveConfirms();
    await afterRuleChange('confirm', rec.id);
    return { ...rec, items: rec.items.map(i => ({ ...i })) };
  }
  async function rejectAutoItem(it, o) {   // "this reading is not right": the item is left out of the rules until reverted
    const by = (o && (o.by || o.decided_by)) || 'host';
    if (by === 'model') throw Object.assign(new Error('reject must be decided by a person'), { code: 'no_decider' });
    const id = (it.kind === 'metric' ? 'm:' : 'd:') + it.x.id;
    if (it.x.rejected) throw Object.assign(new Error('already rejected: ' + id), { code: 'already_rejected' });
    it.x.rejected = true; it.x.rejected_at = new Date().toISOString(); it.x.rejected_by = by;
    savePack();
    await afterRuleChange('reject', id);
    return { id, kind: it.kind, status: 'rejected', rejected_by: by, rejected_at: it.x.rejected_at };
  }
  async function previewMetric(id) {
    const key = String(id == null ? '' : id);
    let mId = bareId(key), recordId = null;
    const rec = autoConfirms.find(c => c.id === key);
    const pend = pending.get(key);
    if (rec) { const mi = rec.items.find(i => i.kind === 'metric'); if (!mi) throw Object.assign(new Error('preview: record has no metric'), { code: 'unknown_metric' }); mId = bareId(mi.id); recordId = rec.id; }
    else if (pend && pend.result && pend.result.plan && (pend.result.plan.metric_ids || []).length) mId = bareId(pend.result.plan.metric_ids[0]);
    const reg = runtime.registry;
    let m = null; try { m = reg.metric(mId); } catch (_) {}
    if (!m || m.unbound) throw Object.assign(new Error('preview: unknown metric ' + key), { code: 'unknown_metric' });
    const metricId = 'm:' + m.id;
    let formula = null;
    if (m.kind === 'ratio') formula = { kind: 'ratio', num: 'm:' + m.num, den: 'm:' + m.den };
    else if (m.kind === 'derived') formula = { kind: 'derived', expr: m.expr };
    else formula = { kind: 'simple', agg: m.agg, field: m.field, dataset: m.dataset };
    const basePlan = { schema: 'plan-ir/2', question: '', metric_ids: [metricId], dimensions: [], entities: [], filters: [], negations: [], time: {}, comparison: { kind: 'none' }, grain: null, rank: null, formula, unit: m.unit || '', output_shape: 'scalar', unresolved: [], permission_scope: { workspace: 'engine', datasets: null } };
    const out = { id: metricId, ...(recordId ? { recordId } : {}), label: m.name, formula: formulaText(m, reg), total: null, lastMonth: null, unit: m.unit || '', decimals: m.decimals == null ? null : m.decimals };
    // rc.7: amounts in several currencies are not one number: say so next to the total (and show the split, computed here, never sent anywhere)
    let curSplit = null;
    if (m.multi_currency || m.currency_unknown) out.currencyNote = m.multi_currency ? CUR_NOTE[language] || CUR_NOTE.zh : (language === 'en' ? 'currency not stated in the data' : '币种：数据未标明');
    if (m.multi_currency) {
      const cm = basePacks[0] && basePacks[0]._meta && basePacks[0]._meta.currency && basePacks[0]._meta.currency[m.dataset];
      if (cm && cm.col) { out.currencies = cm.codes || []; curSplit = { table: m.dataset, col: cm.col }; }
    }
    const sess = await db.session();
    try {
      const t = await planExecutor.execute(basePlan, { registry: reg, cards: sess.cards });
      if (t && t.ok && t.result_status === 'ok' && t.rows && t.rows.length) out.total = t.rows[0].value;
      else out.note = (t && t.result_reason) || (t && t.errors && t.errors[0] && t.errors[0].message) || (t && t.result_status) || 'not computable';
      if (curSplit && m.kind === 'simple' && m.field && ['sum', 'avg', 'min', 'max'].includes(m.agg)) {
        try {
          const aggSql = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[m.agg];
          const rows = await sess.run(`SELECT CAST(${qid(curSplit.col)} AS VARCHAR) AS c, ${aggSql}(${qid(m.field)}) AS v FROM ${qid(curSplit.table)} WHERE ${qid(curSplit.col)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
          out.byCurrency = rows.map(r => ({ currency: String(r.c), value: Number(r.v) }));
        } catch (_) {}
      }
      let ds = m.dataset || null;
      if (!ds) { try { for (const l of reg.leaves(metricId)) { const x = reg.metric(l); if (x && x.dataset) { ds = x.dataset; break; } } } catch (_) {} }
      const role = ds ? (reg.timeRoles() || []).find(r => r.dataset === ds) : null;
      if (role) {
        const g = await planExecutor.execute({ ...basePlan, grain: 'month', time: { role: role.id } }, { registry: reg, cards: sess.cards });
        const anchorMonth = String(opts.anchor || todayIn(timezone)).slice(0, 7);
        const months = ((g && g.rows) || []).filter(r => /^\d{4}-\d{2}$/.test(String(r.label)) && String(r.label) < anchorMonth && r.value != null).sort((a, b) => String(a.label) < String(b.label) ? -1 : 1);
        if (months.length) { const last = months[months.length - 1]; out.lastMonth = { period: String(last.label), value: last.value }; }
      }
    } finally { sess.close(); }
    return out;
  }

  // rc.7: "look at the values" for a dimension: how many distinct values, and the 5 with the most rows. Computed on this machine; the values are
  // shown to the local user only and are never part of any model request (the engine builds requests from names and structure alone).
  async function previewDimension(key) {
    const k0 = String(key == null ? '' : key);
    let dId = bareId(k0), recordId = null;
    const rec = autoConfirms.find(c => c.id === k0);
    if (rec) { const di = rec.items.find(i => i.kind === 'dim'); if (!di) throw Object.assign(new Error('preview: record has no dimension'), { code: 'unknown_metric' }); dId = bareId(di.id); recordId = rec.id; }
    const reg = runtime.registry;
    let d = null; try { d = reg.dim(dId); } catch (_) {}
    if (!d || d.unbound || !d.source || !d.source.table || !d.source.field) throw Object.assign(new Error('preview: unknown dimension ' + k0), { code: 'unknown_metric' });
    const table = d.source.table, field = d.source.field;
    const out = { id: 'd:' + d.id, kind: 'dimension', ...(recordId ? { recordId } : {}), label: d.name, dimKind: d.kind || 'column', dataset: table, field, distinct: null, rows: null, nullCount: null, top: [], local: true };
    const sess = await db.session();
    try {
      const col = qid(field);
      let expr = col;
      if (d.kind === 'timeBucket') {   // the buckets (e.g. months), not the raw days
        const fn = { year: 'year', quarter: 'quarter', month: 'month', week: 'week', day: 'day' }[d.grain || 'month'] || 'month';
        expr = `CAST(date_trunc('${fn}', TRY_CAST(${col} AS DATE)) AS DATE)`;
      }
      const head = (await sess.run(`SELECT COUNT(*) AS rows, COUNT(${expr}) AS nn, COUNT(DISTINCT ${expr}) AS dc FROM ${qid(table)}`))[0] || {};
      out.rows = Number(head.rows); out.nullCount = Number(head.rows) - Number(head.nn); out.distinct = Number(head.dc);
      const top = await sess.run(`SELECT CAST(${expr} AS VARCHAR) AS v, COUNT(*) AS n FROM ${qid(table)} WHERE ${expr} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`);
      out.top = top.map(r => ({ value: String(r.v).slice(0, 80), count: Number(r.n) }));
    } finally { sess.close(); }
    return out;
  }
  async function previewAny(id) {
    const key = String(id == null ? '' : id);
    if (/^d:/.test(key)) return previewDimension(key);
    const rec = autoConfirms.find(c => c.id === key);
    if (rec && !rec.items.some(i => i.kind === 'metric') && rec.items.some(i => i.kind === 'dim')) return previewDimension(key);
    try { return await previewMetric(key); }
    catch (err) {
      if (!(err && err.code === 'unknown_metric')) throw err;
      try { return await previewDimension(key); } catch (e2) { if (e2 && e2.code === 'unknown_metric') throw err; throw e2; }
    }
  }

  // Mark the auto-generated metrics/dimensions that an answer relied on as confirmed (decided by the host) and persist the auto pack.
  function confirmAutoNames(r, registry, rid) {
    const pack = basePacks[0];
    if (!pack || pack.id !== 'auto_ws') return 0;
    const mids = new Set(), dids = new Set(), fields = new Set();
    const plan = r.plan;
    if (plan) {
      for (const id of (plan.metric_ids || [])) { try { for (const l of registry.leaves(id)) mids.add(String(l).replace(/^m:/, '')); } catch (_) {} mids.add(String(id).replace(/^m:/, '')); }
      for (const d of [...(plan.dimensions || []), ...(plan.entities || []).map(e => e.dim), ...(plan.negations || []).map(e => e.dim)]) dids.add(String(d).replace(/^d:/, ''));
    }
    for (const s of ((r.tier_why && r.tier_why.auto_names) || [])) {
      const m = /=\s*(.+)$/.exec(String(s)); if (m) fields.add(m[1].trim());
      else if (r.lane === 'sql' && /^[^=\s]+\.[^=\s]+$/.test(String(s))) fields.add(String(s).trim());   // rc.7: the SQL lane lists plain "table.column" entries
    }
    let n = 0; const at = new Date().toISOString();
    const items = [];
    const flip = (x, kind) => { if (x.auto && !x.confirmed) { x.auto = false; x.confirmed = true; x.confirmed_by = 'host'; x.confirmed_at = at; n++; items.push({ kind, id: (kind === 'metric' ? 'm:' : 'd:') + x.id }); } };
    for (const m of pack.metrics || []) if (mids.has(m.id) || (m.dataset && m.field && fields.has(m.dataset + '.' + m.field))) flip(m, 'metric');
    for (const d of pack.dims || []) if (dids.has(d.id) || (d.dataset && fields.has(d.dataset + '.' + String(d.role || '').split('.').pop()))) flip(d, 'dim');
    if (n) {
      fsx.writeFile(autoPackFile, JSON.stringify(pack, null, 1));
      const refs = [...new Set([...(plan ? (plan.metric_ids || []) : []).map(x => 'm:' + bareId(x)), ...[...dids].map(x => 'd:' + x)])];
      autoConfirms.push({ id: 'ac_' + crypto.randomUUID().slice(0, 12), kind: 'auto_confirm', status: 'confirmed', items, refs, decided_by: 'host', at, request_id: rid || null });
      saveConfirms();
      if (reuseStore) reuseStore.clear('semantic');   // answers cached under the unconfirmed reading must not outlive it
      emit({ type: 'rules_changed', action: 'confirm_auto_names', count: n });
    }
    return n;
  }

  // rc.6: model-written SQL must not name a hidden column (the model never saw the name; the question text might contain it)
  function assertNoHidden(sql) {
    if (!modelSqlOf(sql)) return;
    const t = String(sql).toLowerCase();
    for (const n of hiddenNames) {
      const re = new RegExp('(^|[^a-z0-9_$\\u0080-\\uffff])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9_$\\u0080-\\uffff])');
      if (re.test(t)) throw Object.assign(new Error('SQL 检查未通过：不许使用已设为隐藏的列'), { code: 'sql_hidden_column_blocked' });
    }
  }

  function finalize(result, c) {
    const { rid, question, anchor, callLog, irCall, blocked, t0 } = c;
    const rt = c.rt || runtime;
    secureState();
    // arm-public.mjs: two attempts that are all "HTTP 200 + empty body + all reasoning" are recorded as model_reasoning_only
    try {
      const pcs = Array.isArray(result.provider_calls) ? result.provider_calls : callLog;
      const allThink = pcs.length > 0 && pcs.every(x => {
        const u = x.usage || {}; const ct = Number(u.completion_tokens || 0), rtk = Number((u.completion_tokens_details || {}).reasoning_tokens || 0);
        return x.finish_reason === 'length' && rtk > 0 && rtk >= ct - 1;
      });
      if (allThink && result.status !== 'ok') { result.status = 'model_reasoning_only'; result.code = 'model_reasoning_only'; }
    } catch (_) {}
    // a value the user explicitly picked via confirm() is no longer a guess
    if (c.picked && c.picked.value != null && (result.value_guess || result.value_guesses)) {
      const isPicked = g => g && String(g.value) === String(c.picked.value) && String(g.literal) === String(c.picked.literal);
      const rest = (result.value_guesses || [result.value_guess]).filter(g => g && !isPicked(g));
      result = { ...result, value_guess: rest[0] || undefined, value_guesses: rest.length > 1 ? rest : undefined };
      if (!result.value_guess) delete result.value_guess; if (!result.value_guesses) delete result.value_guesses;
    }
    const status = (blocked || c.budget) ? 'refused' : mapStatus(result);
    const answer = neutralizeExtraAnswerLines(result.answer == null ? '' : String(result.answer));
    const answerLine = status === 'cancelled' ? '' : answerLineOf(answer);
    const facts = (result.facts || []).map(f => ({
      id: f.id, label: f.label, value: f.value, unit: f.unit, display: f.display, status: f.status,
      period: f.period || null, filter_fp: f.filter_fp || null, plan_id: f.plan_id || null,
      tier: f.tier || null, lane: f.lane || null,
      source: f.source || null, schema_version: f.schema_version || null,
    }));
    const raw = {
      qid: rid, question, category: 'adhoc', status: result.status, code: result.code || null,
      route: result.route || null, answer, answer_line: answerLine,
      lane: result.lane || 'config', sql: result.sql || null, tier: result.tier || null,
      plan: result.plan || null, result_status: result.result_status || null,
      facts, rows: (result.rows || []).slice(0, 200), comparison: result.comparison || null,
      llm_calls: result.llm_calls == null ? callLog.length : result.llm_calls,
      calls_this_turn: result.calls_this_turn == null ? callLog.length : result.calls_this_turn,
      tokens: result.tokens || null, zero_llm: !!result.zero_llm,
      ir: result.ir || null, reuse: result.reuse || null,
      trace: result.trace || null,
      provider_calls: callLog.map(x => ({ provider: x.provider, model: x.model, request_id: x.request_id, usage: x.usage, finish_reason: x.finish_reason, purpose: x.purpose, content_len: x.content_len ?? null, reasoning_len: x.reasoning_len ?? null, request_params: x.request_params ?? null, concurrency: x.concurrency ?? null })),
      ir_raw_text: irCall ? String(irCall.text).slice(0, 4000) : null,
      ir_reasoning: irCall && irCall.reasoning ? String(irCall.reasoning).slice(0, 1000) : null,
      latency_ms: Date.now() - t0,
      errors: result.errors || null, message: result.message || null,
      engine: { version: CODE_VERSION, status, model: (irCall && irCall.model) || model.name, anchor, timezone, data_engine: 'duckdb', executor: 'main/plan-executor.js', started_at: new Date(t0).toISOString(), duration_ms: Date.now() - t0, limits },
    };
    const calls = callLog.length;
    const providerCalls = callLog.map(x => ({ request_id: x.request_id, usage: x.usage, finish_reason: x.finish_reason, purpose: x.purpose, request_params: x.request_params ?? null }));
    const r = {
      requestId: rid, status, answer, answerLine,
      facts, rows: result.rows || [], plan: result.plan || null, sql: result.sql || null,
      route: routeOf(result, result.calls_this_turn == null ? calls : result.calls_this_turn),
      meta: { dataStamp, ruleVersion: rt.registry.stamp(), codeVersion: CODE_VERSION, anchor, checks: checksOf(result, { blocked: !!blocked, modelCalls: calls }) },
      usage: { calls, providerCalls, tokens: result.tokens || null },
      raw: clone(raw),
    };
    const cf = confirmOf(result, status, { zh: rulesMode === 'auto' && language === 'zh' });
    if (cf) r.confirm = cf;
    if (status === 'refused' && blocked) r.refusal = { code: 'outbound_blocked', reason: blocked };
    if (c.budget) r.refusal = { code: 'daily_budget_exceeded', spentUSD: c.budget.spentUSD, limitUSD: c.budget.limitUSD, day: c.budget.day };
    return redactAll(r);
  }

  // rc.5: flip the items of an auto_confirm record back to confirmed (on=true) or unconfirmed (on=false); persisted, runtime rebuilt, caches cleared
  async function setAutoConfirm(target, on, o, action) {
    const by = (o && (o.by || o.decided_by)) || 'host';
    if (by === 'model') throw Object.assign(new Error(action + ' must be decided by a person'), { code: 'no_decider' });
    if (on && liveConfirm(target)) throw Object.assign(new Error('already confirmed: ' + target.id), { code: 'already_confirmed' });
    if (!on && !liveConfirm(target)) throw Object.assign(new Error('already reverted: ' + target.id), { code: 'not_confirmed' });
    const pack = basePacks[0];
    const at = new Date().toISOString();
    if (pack && pack.id === 'auto_ws') {
      for (const it of target.items) {
        const list = it.kind === 'metric' ? pack.metrics : pack.dims;
        const x = (list || []).find(e => e.id === bareId(it.id));
        if (!x) continue;
        if (on) { x.auto = false; x.confirmed = true; x.confirmed_by = by; x.confirmed_at = at; }
        else { x.auto = true; x.confirmed = false; delete x.confirmed_by; delete x.confirmed_at; }
      }
      fsx.writeFile(autoPackFile, JSON.stringify(pack, null, 1));
    }
    if (on) { target.status = 'confirmed'; target.reconfirmed_by = by; target.reconfirmed_at = at; delete target.reverted_by; delete target.reverted_at; }
    else { target.status = 'reverted'; target.reverted_by = by; target.reverted_at = at; }
    saveConfirms();
    if (reuseStore) reuseStore.clear('semantic');   // nothing cached under the other state may be served
    runtime = await buildRuntime(); secureState();
    emit({ type: 'rules_changed', action: on ? 'confirm' : 'revert', id: target.id });
    return { ...target, items: target.items.map(i => ({ ...i })) };
  }

  // ---- public API ----
  const engine = {
    ask: (question, o = {}) => run(question, o),

    cancel(requestId) {
      const rec = inflight.get(String(requestId));
      if (!rec) return false;
      rec.st.cancelRequested = true;
      rec.ctrl.abort();
      return true;
    },

    async confirm(requestId, choice) {
      const rid = String(requestId);
      const pend = pending.get(rid);
      if (!pend) throw new Error('confirm: no pending confirmation for requestId ' + rid);
      const r = pend.result;
      const base = { requestId: rid, anchor: pend.anchor };
      if (r.code === 'no_such_metric') return notConfirmable(rid, pend, 'no_such_metric');   // rc.7: nothing to confirm, the metric has to be defined first
      if (r.value_choice) {
        const v = r.value_choice;
        const opts2 = v.options || [];
        let picked;
        if (typeof choice === 'number' && Number.isInteger(choice)) picked = opts2[choice];
        else if (choice && typeof choice === 'object') picked = opts2.find(o => String(o.value) === String(choice.value));
        else picked = opts2.find(o => String(typeof o === 'object' ? o.value : o) === String(choice));
        if (picked == null) throw new Error('confirm: choice is not one of the offered options');
        const value = typeof picked === 'object' ? picked.value : picked;
        return run(pend.question, { ...base, valueChoice: { ...v, value: String(value) } });
      }
      if (r.value_guess || r.value_guesses || r.tier || r.plan) {
        if (!(choice === true || choice === 'accept' || (choice && choice.id === 'accept'))) throw new Error("confirm: use choice 'accept' to confirm this plan");
        // rc.7: a SQL-lane answer that rests on a NEW calculation (conditional sum, unregistered ratio, window ...) is "pending" because of the
        // calculation itself, which a click cannot register: say so instead of re-asking into the same needs_confirm.
        const sqlOnly = r.lane === 'sql' && !r.plan && !r.value_guess && !(r.value_guesses && r.value_guesses.length);
        if (sqlOnly) {
          const why = r.tier_why || {};
          if (rulesMode !== 'auto' || (why.new_algos || []).length || (why.unregistered_fields || []).length || (why.bad_joins || []).length) return notConfirmable(rid, pend, 'sql_not_confirmable');
        }
        // auto-derived field names are only "confirmed" when the rule itself is confirmed: flip them in the auto pack (rules: provided -> use engine.rules.*)
        if (rulesMode === 'auto' && confirmAutoNames(r, runtime.registry, rid)) runtime = await buildRuntime();
        if (r.plan) return run(pend.question, { ...base, confirmedPlan: r.plan });
        const again = await run(pend.question, base);
        if (sqlOnly && again.status === 'needs_confirm') return notConfirmable(rid, pend, 'sql_not_confirmable');   // still pending after the click: never loop
        return again;
      }
      // clarification with options (metric / time role / dimension): re-ask with the picked option's name appended
      const opts2 = Array.isArray(r.options) ? r.options : [];
      let picked = typeof choice === 'number' ? opts2[choice] : opts2.find(o => String(o && (o.id ?? o.value ?? o.name)) === String(choice && choice.id !== undefined ? choice.id : choice));
      if (picked == null && typeof choice === 'string') picked = choice;
      if (picked == null) throw new Error('confirm: choice is not one of the offered options');
      const label = typeof picked === 'object' ? (picked.name || picked.label || picked.value || picked.id) : picked;
      return run(pend.question + '（' + label + '）', { ...base });
    },

    rules: {
      list(filter) {
        const f = filter || {};
        const recs = autoConfirms.filter(c => (!f.status || c.status === f.status) && (!f.origin || f.origin === 'host') && (!f.kind || f.kind === 'auto_confirm'))
          .map(c => ({ ...c, items: c.items.map(i => ({ ...i })) }));
        const patches = f.kind && f.kind !== 'patch' && f.kind !== 'auto_confirm' ? [] : patchService.store.snapshot(f).patches;
        return f.kind === 'auto_confirm' ? recs : patches.concat(recs);
      },
      snapshot() { const s = patchService.store.snapshot(); return { ...s, auto_confirms: autoConfirms.map(c => ({ ...c })) }; },
      async propose(patch) { const rec = patchService.propose(patch); runtime = await buildRuntime(); secureState(); return rec; },
      /** the metrics of the current rules with their confirmation state (rc.6) */
      metrics() {
        const reg = runtime.registry;
        const live = autoConfirms.filter(liveConfirm), rev = autoConfirms.filter(c => !liveConfirm(c));
        const out = [];
        const autoIds = rulesMode === 'auto' && basePacks[0] && basePacks[0].id === 'auto_ws' ? new Set((basePacks[0].metrics || []).map(x => x.id)) : null;
        for (const d of reg.metrics()) {
          if (!d.bound) continue;
          let raw = null; try { raw = reg.metric(d.id); } catch (_) {}
          if (!raw) continue;
          let status = 'provided', record = null;
          if (!(autoIds && autoIds.has(raw.id))) { /* metric of a supplied pack or a confirmed patch: nothing to confirm */ }
          else if (raw.confirmed) { status = 'confirmed'; record = recordFor(live, d.id) || null; }   // (after a restart the auto pack keeps confirmed:true and auto:true)
          else if (raw.auto) { record = recordFor(rev, d.id); status = record ? 'reverted' : 'unconfirmed'; }
          out.push({ id: d.id, name: d.name, kind: d.kind, unit: d.unit || '', dataset: d.dataset, field: d.field, formula: formulaText(raw, reg), status, recordId: record ? record.id : null, auto: !!(autoIds && autoIds.has(raw.id)) });
        }
        const pack = basePacks[0];
        if (rulesMode === 'auto' && pack) for (const m of pack.metrics || []) if (m.rejected) out.push({ id: 'm:' + m.id, name: m.name, kind: m.kind, unit: m.unit || '', dataset: m.dataset || null, field: m.field || null, formula: formulaText(m, runtime.registry), status: 'rejected', recordId: null, auto: true });
        return out;
      },
      /** all-data total and last complete month for one metric (or the first metric of a record / pending request); local only, no model call */
      preview: (id) => previewAny(id),
      /** rc.7: the dimensions (渠道, 国家, month buckets ...) of the current rules with their confirmation state; same states as metrics() */
      dimensions() {
        const reg = runtime.registry;
        const live = autoConfirms.filter(liveConfirm), rev = autoConfirms.filter(c => !liveConfirm(c));
        const pack = basePacks[0];
        const isAuto = rulesMode === 'auto' && pack && pack.id === 'auto_ws';
        const packDims = new Map(isAuto ? (pack.dims || []).map(x => [x.id, x]) : []);
        const hasD = (list, id) => [...list].reverse().find(c => (c.items || []).some(i => i.kind === 'dim' && bareId(i.id) === bareId(id)));
        const out = [];
        for (const d of reg.dims()) {
          if (!d.bound) continue;
          let raw = null; try { raw = reg.dim(d.id); } catch (_) {}
          if (!raw) continue;
          const px = packDims.get(raw.id);
          let status = 'provided', record = null;
          if (px) {
            if (px.confirmed) { status = 'confirmed'; record = hasD(live, raw.id) || null; }
            else if (px.auto) { record = hasD(rev, raw.id) || null; status = record ? 'reverted' : 'unconfirmed'; }
          }
          out.push({ id: d.id, name: d.name, kind: d.kind || 'column', dataset: d.dataset, field: d.field, grain: d.grain || null, formula: dimText(d), status, recordId: record ? record.id : null, auto: !!px });
        }
        if (isAuto) for (const x of pack.dims || []) if (x.rejected) out.push({ id: 'd:' + x.id, name: x.name, kind: x.kind || 'column', dataset: x.dataset || null, field: x.role ? String(x.role).split('.').pop() : null, grain: x.grain || null, formula: '', status: 'rejected', recordId: null, auto: true });
        return out;
      },
      async confirm(id, o = {}) {
        const target = autoConfirms.find(c => c.id === String(id));
        if (target) return setAutoConfirm(target, true, o, 'confirm');
        const item = autoItemOf(id);
        if (item && (item.x.auto || item.x.rejected || item.x.confirmed)) return confirmAutoItem(item, o);
        const rec = patchService.confirm(id, { by: 'host', ...o }); runtime = await buildRuntime(); secureState(); emit({ type: 'rules_changed', action: 'confirm', id }); return rec;
      },
      async reject(id, o = {}) {
        const target = autoConfirms.find(c => c.id === String(id));
        if (target) {
          if (!liveConfirm(target)) throw Object.assign(new Error('reject: ' + target.id + ' is already reverted (nothing to reject); use rules.confirm to re-confirm it'), { code: 'not_confirmed' });
          return setAutoConfirm(target, false, o, 'reject');
        }
        const item = autoItemOf(id);
        if (item) {
          const liveRec = item.x.confirmed ? recordFor(autoConfirms.filter(liveConfirm), (item.kind === 'metric' ? 'm:' : 'd:') + item.x.id) : null;
          if (liveRec) return setAutoConfirm(liveRec, false, o, 'reject');
          if (item.x.auto && !item.x.confirmed) return rejectAutoItem(item, o);
        }
        const rec = patchService.reject(id, { by: 'host', ...o }); runtime = await buildRuntime(); secureState(); emit({ type: 'rules_changed', action: 'reject', id }); return rec;
      },
      async revert(id, o = {}) {
        const key = String(id);
        let target = autoConfirms.find(c => c.id === key);
        if (!target) {   // a metric / dimension id as the host knows it (result.plan.metric_ids, confirm options): map it to the record that confirmed it
          const b = bareId(key), pre = /^[md]:/.test(key) ? key.slice(0, 2) : null;
          const hit = (c, field) => (c[field] || []).some(i => { const iid = typeof i === 'string' ? i : i.id; return bareId(iid) === b && (!pre || !/^[md]:/.test(iid) || iid.startsWith(pre)); });
          const live = autoConfirms.filter(liveConfirm);
          target = [...live].reverse().find(c => hit(c, 'items')) || [...live].reverse().find(c => hit(c, 'refs'));
        }
        if (target) {
          return setAutoConfirm(target, false, o, 'revert');
        }
        const item = autoItemOf(key);
        if (item && item.x.rejected) {   // "not right" -> back to unconfirmed
          delete item.x.rejected; delete item.x.rejected_at; delete item.x.rejected_by;
          savePack(); await afterRuleChange('revert', (item.kind === 'metric' ? 'm:' : 'd:') + item.x.id);
          return { id: (item.kind === 'metric' ? 'm:' : 'd:') + item.x.id, kind: item.kind, status: 'unconfirmed' };
        }
        const rec = patchService.revert(id, { by: 'host', ...o }); runtime = await buildRuntime(); secureState(); emit({ type: 'rules_changed', action: 'revert', id }); return rec; },
    },

    tables() {
      const out = rawMeta.map(t => ({ name: t.name, columns: t.columns.map(c => ({ name: c.name, type: c.type })) }));
      // rc.4: names that were left out of the metadata are listed (redacted), marked excluded
      for (const e of excludedNames) {
        if (e.column == null) { out.push({ name: e.tableRedacted, excluded: true, reason: e.reason, columns: [] }); continue; }
        let t = out.find(x => x.name === e.table);
        if (!t) { t = { name: e.table, columns: [] }; out.push(t); }
        t.columns.push({ name: e.columnRedacted, type: e.type, excluded: true, reason: e.reason });
      }
      // rc.6: columns the owner chose to hide are listed with their real names, marked hidden
      for (const h of hiddenCols) {
        let t = out.find(x => x.name === h.table);
        if (!t) { t = { name: h.table, columns: [] }; out.push(t); }
        if (h.tableHidden) t.hidden = true;
        t.columns.push({ name: h.column, type: h.type, hidden: true });
      }
      return out;
    },

    info() { return { version: CODE_VERSION, dataDir, database: dbFile, dataStamp, rules: rulesMode, ruleVersion: runtime.registry.stamp(), aliasesApplied: (runtime.registry.aliasApplied || []).length, vectors: vec.status, vectorsReason: vec.reason || null, imported: importInfo ? importInfo.tables : null, timezone, limits, lastRefreshAt, dataUpdatedAt: lastRefreshAt || (importInfo && importInfo.manifest && importInfo.manifest.at) || (() => { try { return new Date(fs.statSync(dbFile).mtimeMs).toISOString(); } catch (_) { return null; } })(), hiddenColumns: hiddenCols.map(h => h.table + '.' + h.column) }; },

    /** rc.8: what is in the data now: per table rows, columns and the date range of its main date column (computed locally, never sent to a model) */
    async dataSummary() { return require('./summary.js').summarize(db, rawMeta, importInfo ? importInfo.tables : null); },
    /** rc.6: re-check the data sources now (force) and re-import what changed; resolves { refreshed, files, tables } */
    refreshData: (o = {}) => refreshData({ force: true, ...o }),
    /** rc.6: model-call ledger (null when neither a price nor a daily limit is configured) */
    get usage() { return ledger ? { today: () => ledger.today(), list: (n) => ledger.list(n), totalUSD: () => ledger.totalUSD() } : null; },

    async close() {
      if (closed) return;
      closed = true;
      for (const rec of inflight.values()) { try { rec.ctrl.abort(); } catch (_) {} }
      await new Promise(r => setTimeout(r, 20));
      try { reuseStore && reuseStore.close(); } catch (_) {}
      try { db.close(); } catch (_) {}
      secureState();
    },
  };
  emit({ type: 'engine_ready', dataStamp, rules: rulesMode, vectors: vec.status, tables: meta.length });
  return engine;
}

async function createEngine(opts = {}) {
  const res = {};
  try { return await build(opts, res); }
  catch (err) {
    try { res.reuseStore && res.reuseStore.close(); } catch (_) {}
    try { res.db && res.db.close(); } catch (_) {}
    throw err;
  }
}

/** Write the same files arm-public.mjs writes (answer.txt, raw.json, facts.json, meta.json) so existing graders can read an engine result. */
function writeAttempt(r, outDir) {
  fsx.ensureDir(outDir);
  const rd = makeRedactor([]);
  const W = (name, text) => fsx.writeFile(path.join(outDir, name), rd.str(text));
  W('answer.txt', r.answerLine + '\n');
  W('raw.json', JSON.stringify(r.raw, jsonSafe, 1));
  const items = {};
  const _num = (s, fallback) => { const m = String(s == null ? '' : s).replace(/[,，]/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : fallback; };
  for (const f of r.facts) items[f.id] = { value: f.value, d: _num(f.display, f.value), display: f.display == null ? f.value : f.display, unit: f.unit, status: f.status, period: f.period, source: f.source, plan_id: f.plan_id, filter_fp: f.filter_fp };
  W('facts.json', JSON.stringify({ schema: 'facts-export/1', qid: r.requestId, plan_id: r.plan && r.plan.id || null, items }, jsonSafe, 1));
  const e = r.raw.engine || {};
  W('meta.json', JSON.stringify({ qid: r.requestId, arm: 'estratto-engine', model: e.model, anchor: r.meta.anchor, timezone: e.timezone, max_output_tokens: e.limits && e.limits.maxOutputTokens, data_engine: 'duckdb', executor: e.executor, engine_status: r.status, code_version: r.meta.codeVersion, data_stamp: r.meta.dataStamp, rule_version: r.meta.ruleVersion, started_at: e.started_at, duration_ms: e.duration_ms }, null, 1));
}

module.exports = { createEngine, writeAttempt, answerLineOf, neutralizeExtraAnswerLines, assertSqlAllowed, parseJsonLoose, CODE_VERSION, GatedStore };
