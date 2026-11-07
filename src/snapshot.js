'use strict';
// rc.8 snapshot importers: SQLite (node:sqlite, read-only), PostgreSQL (pg) and MySQL/MariaDB (mysql2) -> tables in the workspace DuckDB.
// Everything is a one-way, read-only copy. Model SQL never touches these servers: it only ever runs on the local DuckDB.
//   listSource(spec, password)  -> { tables: [{ name, kind, rows, approx, columns: [{ name, type }], overLimit }] }   (test a connection / show what is there)
//   copySource(ctx, spec, password) -> fills DuckDB tables through ctx (see import.js); never silently truncates (row cap = hard refusal)
const crypto = require('node:crypto');
const path = require('node:path');

const qi = s => '"' + String(s).replace(/"/g, '""') + '"';
const qm = s => '`' + String(s).replace(/`/g, '``') + '`';
const BATCH = 5000;
const PROGRESS_EVERY = 100000;
const DEFAULT_MAX_ROWS = 5000000;
const CONNECT_TIMEOUT_MS = 10000;

class SnapshotError extends Error { constructor(msg, code = 'snapshot_failed') { super(msg); this.code = code; } }
const fmt = n => Number(n).toLocaleString('en-US');

/** copy an error without the password (drivers may echo connection strings or server messages) */
function scrub(err, secrets) {
  const lits = (secrets || []).filter(s => typeof s === 'string' && s.length >= 1);
  let msg = String(err && err.message || err);
  for (const s of lits) msg = msg.split(s).join('***');
  const e = new SnapshotError(msg.slice(0, 400), (err && (err.code && typeof err.code === 'string' ? err.code : null)) || 'snapshot_failed');
  return e;
}

function uniqueColumnNames(names) {
  const seen = new Set();
  return names.map((n0, i) => {
    let n = String(n0 == null || n0 === '' ? 'col_' + (i + 1) : n0), k = 2;
    const base = n;
    while (seen.has(n.toLowerCase())) n = base + '_' + (k++);
    seen.add(n.toLowerCase());
    return n;
  });
}

// ---- writer: fills one DuckDB table from rows ----------------------------------------------------------------------------
// typed mode (SQLite): values already have JS types; each column is appended as varchar / bigint / double.
// staged mode (PostgreSQL / MySQL): every value arrives as text; batches go through an all-VARCHAR stage table and are CAST into the final types.
async function openWriter(conn, run, table, cols, staged) {
  await run(`CREATE TABLE ${qi(table)} (${cols.map(c => `${qi(c.name)} ${c.ddl}`).join(', ')})`);
  const needStage = staged && cols.some(c => c.ddl !== 'VARCHAR');
  let stage = null;
  if (needStage) {
    stage = '__estratto_stage_' + crypto.randomBytes(4).toString('hex');
    await run(`CREATE TABLE ${qi(stage)} (${cols.map(c => `${qi(c.name)} VARCHAR`).join(', ')})`);
  }
  const app = await conn.createAppender(stage || table);
  const select = cols.map(c => c.ddl === 'VARCHAR' ? qi(c.name) : `CAST(${qi(c.name)} AS ${c.ddl})`).join(', ');
  let pending = 0, total = 0;
  const move = async () => {
    app.flushSync();
    if (!stage) return;
    await run(`INSERT INTO ${qi(table)} SELECT ${select} FROM ${qi(stage)}`);
    await run(`DELETE FROM ${qi(stage)}`);
  };
  return {
    get total() { return total; },
    async add(row) {
      for (let i = 0; i < cols.length; i++) {
        const v = row[i];
        if (v == null) { app.appendNull(); continue; }
        if (staged) { app.appendVarchar(typeof v === 'string' ? v : String(v)); continue; }
        switch (cols[i].app) {
          case 'bigint': app.appendBigInt(typeof v === 'bigint' ? v : BigInt(v)); break;
          case 'double': app.appendDouble(typeof v === 'bigint' ? Number(v) : Number(v)); break;
          default: app.appendVarchar(typeof v === 'string' ? v : String(v));
        }
      }
      app.endRow(); total++;
      if (++pending >= BATCH) { pending = 0; await move(); }
    },
    async finish() {
      try { await move(); } finally { try { app.closeSync(); } catch (_) {} }
      if (stage) await run(`DROP TABLE IF EXISTS ${qi(stage)}`);
      return total;
    },
    async abort() { try { app.closeSync(); } catch (_) {} if (stage) { try { await run(`DROP TABLE IF EXISTS ${qi(stage)}`); } catch (_) {} } },
  };
}

function capError(table, rows, maxRows) {
  return new SnapshotError(`table "${table}" has ${fmt(rows)} rows, more than the limit of ${fmt(maxRows)} rows per table, so nothing was imported from it. Raise data.maxRowsPerTable, or import a smaller table or a view.`, 'row_cap_exceeded');
}

// =========================================================================================================================
// SQLite
// =========================================================================================================================
function sqliteOpen(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
  return db;
}
const sqliteAllTables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND COALESCE(sql,'') NOT LIKE 'CREATE VIRTUAL%' ORDER BY name").all().map(r => r.name);

function sqliteAffinityDdl(declared) {
  const d = String(declared || '').toUpperCase();
  if (/INT/.test(d)) return 'BIGINT';
  if (/REAL|FLOA|DOUB/.test(d)) return 'DOUBLE';
  return 'VARCHAR';
}

async function listSqlite(spec, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const db = sqliteOpen(spec.path);
  try {
    const out = [];
    for (const name of sqliteAllTables(db)) {
      const q = qi(name);
      const columns = db.prepare(`PRAGMA table_info(${q})`).all().map(c => ({ name: c.name, type: String(c.type || '') }));
      let rows = null; try { rows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q}`).get().n); } catch (_) {}
      out.push({ name, kind: 'table', rows, approx: false, columns, overLimit: rows != null && rows > maxRows });
    }
    return { tables: out };
  } finally { try { db.close(); } catch (_) {} }
}

async function copySqlite(ctx, spec) {
  const db = sqliteOpen(spec.path);
  try {
    const have = new Set(sqliteAllTables(db));
    const want = spec.tables && spec.tables.length ? spec.tables : [...have];
    for (const t of want) if (!have.has(t)) throw new SnapshotError(`table "${t}" not found in ${path.basename(spec.path)}`, 'table_not_found');
    for (const t of want) {
      const q = qi(t);
      const info = db.prepare(`PRAGMA table_info(${q})`).all();
      if (!info.length) continue;
      const names = uniqueColumnNames(info.map(c => c.name));
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q}`).get().n);
      if (total > ctx.maxRows) throw capError(t, total, ctx.maxRows);
      // one pass over the table: which storage types does each column really hold? (SQLite is dynamically typed)
      const probe = info.map((c, i) => `SUM(typeof(${qi(c.name)})='integer') AS i${i}, SUM(typeof(${qi(c.name)})='real') AS r${i}, SUM(typeof(${qi(c.name)})='text') AS t${i}, SUM(typeof(${qi(c.name)})='blob') AS b${i}`).join(', ');
      const pr = db.prepare(`SELECT ${probe} FROM ${q}`).get() || {};
      const cols = [], selects = [];
      info.forEach((c, i) => {
        const ni = Number(pr['i' + i] || 0), nr = Number(pr['r' + i] || 0), nt = Number(pr['t' + i] || 0), nb = Number(pr['b' + i] || 0);
        if (nb > 0) {
          ctx.warn({ table: t, column: c.name, reason: 'blob_column', action: 'skipped', note: 'binary (BLOB) column is not imported' });
          return;
        }
        let ddl, app, sel = `${qi(c.name)}`;
        if (nt > 0 && (ni > 0 || nr > 0)) { ddl = 'VARCHAR'; app = 'varchar'; sel = `CAST(${qi(c.name)} AS TEXT)`; }
        else if (nt > 0) { ddl = 'VARCHAR'; app = 'varchar'; }
        else if (nr > 0) { ddl = 'DOUBLE'; app = 'double'; }
        else if (ni > 0) { ddl = 'BIGINT'; app = 'bigint'; }
        else { ddl = sqliteAffinityDdl(c.type); app = ddl === 'BIGINT' ? 'bigint' : ddl === 'DOUBLE' ? 'double' : 'varchar'; }
        cols.push({ name: names[i], ddl, app });
        selects.push(sel);
      });
      if (!cols.length) { ctx.warn({ table: t, column: null, reason: 'no_importable_columns', action: 'skipped', note: 'every column is binary; the table was not imported' }); continue; }
      const name = ctx.nameFor(t);
      ctx.event({ type: 'import_start', table: name, rowsTotal: total });
      const w = await openWriter(ctx.conn, ctx.run, name, cols, false);
      try {
        const st = db.prepare(`SELECT ${selects.map((s, i) => `${s} AS c${i}`).join(', ')} FROM ${q}`);
        st.setReadBigInts(true);
        let n = 0;
        for (const r of st.iterate()) {
          const row = new Array(cols.length);
          for (let i = 0; i < cols.length; i++) row[i] = r['c' + i];
          await w.add(row);
          if (++n % PROGRESS_EVERY === 0) ctx.event({ type: 'import_progress', table: name, rows: n, rowsTotal: total });
        }
        await w.finish();
      } catch (e) { await w.abort(); throw e; }
      await ctx.finish(name, t);
    }
  } finally { try { db.close(); } catch (_) {} }
}

// =========================================================================================================================
// PostgreSQL
// =========================================================================================================================
function sslOption(ssl) { return ssl === true ? { rejectUnauthorized: true } : ssl === 'no-verify' ? { rejectUnauthorized: false } : false; }

async function pgConnect(spec, password) {
  const { Client } = require('pg');
  const client = new Client({
    host: spec.host, port: spec.port, database: spec.database, user: spec.user, password: password || undefined,
    ssl: sslOption(spec.ssl), connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: 'estratto-engine',
    types: { getTypeParser: () => v => v },   // every value comes back as the server's own text; the DuckDB side casts it
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    await client.query('SET default_transaction_read_only = on');
    await client.query("SET TIME ZONE 'UTC'");
  } catch (e) { try { await client.end(); } catch (_) {} throw scrub(e, [password]); }
  return client;
}

function pgMap(c) {
  const u = String(c.udt_name || '').toLowerCase(), q = qi(c.name);
  switch (u) {
    case 'int2': return { ddl: 'SMALLINT', expr: q };
    case 'int4': return { ddl: 'INTEGER', expr: q };
    case 'int8': case 'oid': return { ddl: 'BIGINT', expr: q };
    case 'float4': case 'float8': return { ddl: 'DOUBLE', expr: q };
    case 'numeric': { const p = Number(c.numeric_precision), s = Number(c.numeric_scale || 0); return p > 0 && p <= 38 ? { ddl: `DECIMAL(${p},${s})`, expr: q } : { ddl: 'DOUBLE', expr: q }; }
    case 'money': return { ddl: 'DECIMAL(19,2)', expr: `(${q})::numeric` };
    case 'bool': return { ddl: 'BOOLEAN', expr: q };
    case 'date': return { ddl: 'DATE', expr: q };
    case 'timestamp': return { ddl: 'TIMESTAMP', expr: q };
    case 'timestamptz': return { ddl: 'TIMESTAMP', expr: `(${q} AT TIME ZONE 'UTC')` };
    case 'time': return { ddl: 'TIME', expr: q };
    case 'bytea': return null;
    default: return { ddl: 'VARCHAR', expr: q };
  }
}
const PG_COLS = 'SELECT table_name, column_name AS name, data_type, udt_name, numeric_precision, numeric_scale, ordinal_position FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position';

async function listPg(spec, password, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const c = await pgConnect(spec, password);
  try {
    const schema = spec.schema || 'public';
    const rels = (await c.query("SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS est FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m') ORDER BY c.relname", [schema])).rows;
    const cols = (await c.query(PG_COLS, [schema])).rows;
    const by = new Map();
    for (const r of cols) { if (!by.has(r.table_name)) by.set(r.table_name, []); by.get(r.table_name).push({ name: r.name, type: r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type }); }
    const out = [];
    for (const r of rels) {
      let rows = Number(r.est), approx = true;
      if (!(rows >= 100000) || r.kind === 'v') {   // small or unknown: an exact count is cheap
        try { rows = Number((await c.query(`SELECT count(*) AS n FROM ${qi(schema)}.${qi(r.name)}`)).rows[0].n); approx = false; } catch (_) { rows = rows >= 0 ? rows : null; }
      }
      out.push({ name: r.name, kind: r.kind === 'v' || r.kind === 'm' ? 'view' : 'table', rows, approx, columns: by.get(r.name) || [], overLimit: rows != null && rows > maxRows });
    }
    return { tables: out };
  } catch (e) { throw scrub(e, [password]); } finally { try { await c.end(); } catch (_) {} }
}

async function copyPg(ctx, spec, password) {
  const c = await pgConnect(spec, password);
  const schema = spec.schema || 'public';
  try {
    await c.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');   // one consistent snapshot for all chosen tables
    const colRows = (await c.query(PG_COLS, [schema])).rows;
    const by = new Map();
    for (const r of colRows) { if (!by.has(r.table_name)) by.set(r.table_name, []); by.get(r.table_name).push(r); }
    for (const t of spec.tables) {
      const src = by.get(t);
      if (!src || !src.length) throw new SnapshotError(`table "${t}" not found in schema "${schema}"`, 'table_not_found');
      const names = uniqueColumnNames(src.map(r => r.name));
      const cols = [], exprs = [];
      src.forEach((r, i) => {
        const m = pgMap(r);
        if (!m) { ctx.warn({ table: t, column: r.name, reason: 'blob_column', action: 'skipped', note: 'binary (bytea) column is not imported' }); return; }
        cols.push({ name: names[i], ddl: m.ddl }); exprs.push(m.expr);
      });
      if (!cols.length) { ctx.warn({ table: t, column: null, reason: 'no_importable_columns', action: 'skipped', note: 'every column is binary; the table was not imported' }); continue; }
      const full = `${qi(schema)}.${qi(t)}`;
      const total = Number((await c.query(`SELECT count(*) AS n FROM ${full}`)).rows[0].n);
      if (total > ctx.maxRows) throw capError(t, total, ctx.maxRows);
      const name = ctx.nameFor(`${schema === 'public' ? '' : schema + '_'}${t}`);
      ctx.event({ type: 'import_start', table: name, rowsTotal: total });
      const w = await openWriter(ctx.conn, ctx.run, name, cols, true);
      try {
        await c.query(`DECLARE estratto_cur NO SCROLL CURSOR FOR SELECT ${exprs.join(', ')} FROM ${full}`);
        let n = 0, nextP = PROGRESS_EVERY;
        for (;;) {
          const r = await c.query({ text: `FETCH ${BATCH} FROM estratto_cur`, rowMode: 'array' });
          if (!r.rows.length) break;
          for (const row of r.rows) { if (++n > ctx.maxRows) throw capError(t, n, ctx.maxRows); await w.add(row); }
          if (n >= nextP) { nextP += PROGRESS_EVERY; ctx.event({ type: 'import_progress', table: name, rows: n, rowsTotal: total }); }
        }
        await c.query('CLOSE estratto_cur');
        await w.finish();
      } catch (e) { await w.abort(); throw e instanceof SnapshotError ? e : scrub(e, [password]); }
      await ctx.finish(name, t);
    }
    await c.query('COMMIT');
  } catch (e) { throw e instanceof SnapshotError ? e : scrub(e, [password]); } finally { try { await c.end(); } catch (_) {} }
}

// =========================================================================================================================
// MySQL / MariaDB
// =========================================================================================================================
async function myConnect(spec, password) {
  const mysql = require('mysql2/promise');
  let conn;
  try {
    conn = await mysql.createConnection({
      host: spec.host, port: spec.port, user: spec.user, password: password || undefined, database: spec.database,
      ssl: spec.ssl === true ? { rejectUnauthorized: true } : spec.ssl === 'no-verify' ? { rejectUnauthorized: false } : undefined,
      connectTimeout: CONNECT_TIMEOUT_MS, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, rowsAsArray: true,
      typeCast: field => field.string(),   // every value as text (NULL stays null); the DuckDB side casts it
    });
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query("SET time_zone = '+00:00'");
  } catch (e) { if (conn) try { await conn.end(); } catch (_) {} throw scrub(e, [password]); }
  return conn;
}
const MY_SKIP = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit', 'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection']);
function myMap(c) {
  const dt = String(c.DATA_TYPE || c.data_type || '').toLowerCase(), ct = String(c.COLUMN_TYPE || c.column_type || ''), unsigned = /unsigned/i.test(ct);
  const p = Number(c.NUMERIC_PRECISION ?? c.numeric_precision), s = Number(c.NUMERIC_SCALE ?? c.numeric_scale ?? 0);
  if (MY_SKIP.has(dt)) return null;
  switch (dt) {
    case 'tinyint': return { ddl: 'SMALLINT' };
    case 'smallint': return { ddl: unsigned ? 'INTEGER' : 'SMALLINT' };
    case 'mediumint': return { ddl: 'INTEGER' };
    case 'int': case 'integer': return { ddl: unsigned ? 'BIGINT' : 'INTEGER' };
    case 'bigint': return { ddl: unsigned ? 'UBIGINT' : 'BIGINT' };
    case 'year': return { ddl: 'INTEGER' };
    case 'decimal': case 'numeric': return p > 0 && p <= 38 ? { ddl: `DECIMAL(${p},${s})` } : { ddl: 'DOUBLE' };
    case 'float': case 'double': case 'real': return { ddl: 'DOUBLE' };
    case 'date': return { ddl: 'DATE', zero: true };
    case 'datetime': case 'timestamp': return { ddl: 'TIMESTAMP', zero: true };
    default: return { ddl: 'VARCHAR' };   // char, varchar, text, enum, set, json, time (can be negative / over 24h)
  }
}
const MY_COLS = 'SELECT TABLE_NAME AS tn, COLUMN_NAME AS name, DATA_TYPE, COLUMN_TYPE, NUMERIC_PRECISION, NUMERIC_SCALE, ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION';
const objRow = (cols, row) => { const o = {}; cols.forEach((c, i) => { o[c] = row[i]; }); return o; };

async function myQueryObjects(conn, sql, params) {
  // rowsAsArray is on for the connection; build objects here with the field names
  const [rows, fields] = await conn.query({ sql, values: params, rowsAsArray: true });
  const names = fields.map(f => f.name);
  return rows.map(r => objRow(names, r));
}

async function listMy(spec, password, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const c = await myConnect(spec, password);
  try {
    const rels = await myQueryObjects(c, 'SELECT TABLE_NAME AS name, TABLE_TYPE AS ttype, TABLE_ROWS AS est FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [spec.database]);
    const cols = await myQueryObjects(c, MY_COLS, [spec.database]);
    const by = new Map();
    for (const r of cols) { if (!by.has(r.tn)) by.set(r.tn, []); by.get(r.tn).push({ name: r.name, type: r.COLUMN_TYPE }); }
    const out = [];
    for (const r of rels) {
      const isView = /VIEW/i.test(String(r.ttype));
      let rows = r.est == null ? null : Number(r.est), approx = true;
      if (rows == null || !(rows >= 100000) || isView) {
        try { rows = Number((await myQueryObjects(c, `SELECT COUNT(*) AS n FROM ${qm(spec.database)}.${qm(r.name)}`))[0].n); approx = false; } catch (_) {}
      }
      out.push({ name: r.name, kind: isView ? 'view' : 'table', rows, approx, columns: by.get(r.name) || [], overLimit: rows != null && rows > maxRows });
    }
    return { tables: out };
  } catch (e) { throw scrub(e, [password]); } finally { try { await c.end(); } catch (_) {} }
}

async function copyMy(ctx, spec, password) {
  const c = await myConnect(spec, password);
  try {
    await c.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    try { await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'); } catch (_) { await c.query('START TRANSACTION READ ONLY'); }
    const colRows = await myQueryObjects(c, MY_COLS, [spec.database]);
    const by = new Map();
    for (const r of colRows) { if (!by.has(r.tn)) by.set(r.tn, []); by.get(r.tn).push(r); }
    for (const t of spec.tables) {
      const src = by.get(t);
      if (!src || !src.length) throw new SnapshotError(`table "${t}" not found in database "${spec.database}"`, 'table_not_found');
      const names = uniqueColumnNames(src.map(r => r.name));
      const cols = [], sel = [];
      src.forEach((r, i) => {
        const m = myMap(r);
        if (!m) { ctx.warn({ table: t, column: r.name, reason: 'blob_column', action: 'skipped', note: 'binary column is not imported' }); return; }
        cols.push({ name: names[i], ddl: m.ddl, zero: !!m.zero }); sel.push(qm(r.name));
      });
      if (!cols.length) { ctx.warn({ table: t, column: null, reason: 'no_importable_columns', action: 'skipped', note: 'every column is binary; the table was not imported' }); continue; }
      const full = `${qm(spec.database)}.${qm(t)}`;
      const total = Number((await myQueryObjects(c, `SELECT COUNT(*) AS n FROM ${full}`))[0].n);
      if (total > ctx.maxRows) throw capError(t, total, ctx.maxRows);
      const name = ctx.nameFor(t);
      ctx.event({ type: 'import_start', table: name, rowsTotal: total });
      const w = await openWriter(ctx.conn, ctx.run, name, cols, true);
      try {
        const stream = c.connection.query({ sql: `SELECT ${sel.join(', ')} FROM ${full}`, rowsAsArray: true, typeCast: f => f.string() }).stream({ highWaterMark: BATCH });
        let n = 0;
        for await (const row of stream) {
          if (++n > ctx.maxRows) { stream.destroy(); throw capError(t, n, ctx.maxRows); }
          for (let i = 0; i < cols.length; i++) if (cols[i].zero && typeof row[i] === 'string' && row[i].startsWith('0000-00-00')) row[i] = null;   // MySQL "zero dates" are not dates
          await w.add(row);
          if (n % PROGRESS_EVERY === 0) ctx.event({ type: 'import_progress', table: name, rows: n, rowsTotal: total });
        }
        await w.finish();
      } catch (e) { await w.abort(); throw e instanceof SnapshotError ? e : scrub(e, [password]); }
      await ctx.finish(name, t);
    }
    await c.query('COMMIT');
  } catch (e) { throw e instanceof SnapshotError ? e : scrub(e, [password]); } finally { try { await c.end(); } catch (_) {} }
}

// =========================================================================================================================
async function listSource(spec, password, opts) {
  if (spec.type === 'sqlite') return listSqlite(spec, opts);
  if (spec.type === 'postgres') return listPg(spec, password, opts);
  if (spec.type === 'mysql') return listMy(spec, password, opts);
  throw new SnapshotError('unsupported source type: ' + spec.type, 'bad_source');
}
async function copySource(ctx, spec, password) {
  if (spec.type === 'sqlite') return copySqlite(ctx, spec);
  if (spec.type === 'postgres') return copyPg(ctx, spec, password);
  if (spec.type === 'mysql') return copyMy(ctx, spec, password);
  throw new SnapshotError('unsupported source type: ' + spec.type, 'bad_source');
}

module.exports = { listSource, copySource, SnapshotError, scrub, DEFAULT_MAX_ROWS, uniqueColumnNames };
