'use strict';
// DuckDB access for the engine. Mirrors arm-public.mjs openDuck()/loadMeta(): the same SQL, the same
// type heuristic (so the registry sees the same table metadata), the same `cards` adapter contract.
// Difference by design: every ask() gets its own connection (session) so cancellation can interrupt it
// and concurrent questions never share per-connection settings.
const path = require('node:path');

const q = s => '"' + String(s).replace(/"/g, '""') + '"';

// arm-public.mjs columnsOf(): identical heuristic, including its quirks (kept for benchmark parity).
function metaType(columnName, columnType) {
  return /INT|REAL|NUM|DEC|DOUBLE|FLOAT|HUGEINT|UBIGINT|BIGINT/i.test(String(columnType))
    ? 'number'
    : (/date|month/i.test(String(columnName)) ? 'date' : 'text');
}

// rc.7, auto-rules mode only: column types come from the real DuckDB type (so a DATE column named 下单日期 is a date and gets a time role);
// text columns with a date-like name (English or Chinese) still count as dates, as before. The name heuristic above stays in force for
// supplied rules packs (benchmark parity).
const NUM_TYPE_RE = /^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?\d*|DECIMAL|NUMERIC|DOUBLE|FLOAT\d*|REAL)\b/i;
const DATE_TYPE_RE = /^(DATE|TIMESTAMP|DATETIME)/i;
const DATE_NAME_RE = /date|month|日期|时间|月份|年月|日$/i;
function metaTypeAuto(columnName, columnType) {
  const t = String(columnType || '').trim();
  if (DATE_TYPE_RE.test(t)) return 'date';
  if (NUM_TYPE_RE.test(t)) return 'number';
  return DATE_NAME_RE.test(String(columnName)) && /^(VARCHAR|TEXT|STRING|CHAR)/i.test(t) ? 'date' : 'text';
}

async function openDb(file, { readOnly = true, memoryLimit = '2GB', autoTypes = false } = {}) {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const cfg = { memory_limit: String(memoryLimit) };
  if (readOnly) cfg.access_mode = 'READ_ONLY';
  const instance = await DuckDBInstance.create(path.resolve(file), cfg);
  const admin = await instance.connect();
  const adminRun = async (sql) => (await admin.runAndReadAll(sql)).getRowObjects();

  const listTables = async () => (await adminRun("SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name")).map(r => r.table_name);
  const describe = async (name) => (await adminRun(`DESCRIBE ${q(name)}`)).map(c => ({ name: c.column_name, rawType: String(c.column_type) }));
  const columnsOf = async (name) => (await describe(name)).map(c => ({ name: c.name, type: (autoTypes ? metaTypeAuto : metaType)(c.name, c.rawType) }));
  const distinct = async (table, field, limit = 5000) => adminRun(`SELECT CAST(${q(field)} AS VARCHAR) AS v, COUNT(*) AS n FROM ${q(table)} WHERE ${q(field)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT ${Math.max(1, Math.min(Number(limit) || 5000, 20000))}`);
  const rowCount = async (table) => Number((await adminRun(`SELECT COUNT(*) AS n FROM ${q(table)}`))[0].n);

  /** One connection per question. `cards.worker.call('semanticQuery')` is the contract plan-executor.js expects. */
  async function session() {
    const conn = await instance.connect();
    let closed = false;
    const run = async (sql) => (await conn.runAndReadAll(sql)).getRowObjects();
    const cards = {
      worker: {
        async call(op, args) {
          if (op !== 'semanticQuery') throw new Error('engine only implements semanticQuery, got: ' + op);
          if (!args || typeof args.sql !== 'string') throw new Error('semanticQuery needs sql');
          return { rows: await run(args.sql) };
        },
      },
    };
    const interrupt = () => { try { conn.interrupt(); return true; } catch (_) { return false; } };
    const close = () => {
      if (closed) return; closed = true;
      try { conn.disconnectSync ? conn.disconnectSync() : conn.closeSync && conn.closeSync(); } catch (_) {}
    };
    return { run, cards, interrupt, close };
  }

  const close = () => {
    try { admin.disconnectSync ? admin.disconnectSync() : admin.closeSync && admin.closeSync(); } catch (_) {}
    try { instance.closeSync && instance.closeSync(); } catch (_) {}
  };
  return { file: path.resolve(file), readOnly, listTables, describe, columnsOf, distinct, rowCount, adminRun, session, close };
}

async function loadMeta(db) {
  const names = await db.listTables();
  const meta = [], raw = [];
  for (const name of names) {
    meta.push({ name, columns: await db.columnsOf(name) });
    raw.push({ name, columns: (await db.describe(name)).map(c => ({ name: c.name, type: c.rawType })) });
  }
  return { meta, raw, names };
}

module.exports = { openDb, loadMeta, metaType, metaTypeAuto, q };
