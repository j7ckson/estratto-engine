'use strict';
// files -> dataDir/warehouse.duckdb  (csv/tsv via read_csv_auto, parquet via read_parquet, xlsx via exceljs -> temp csv -> read_csv_auto)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fsx = require('./fsx.js');
const { badReason, redactName, MAX_NAME } = require('./hostile.js');

const sqlStr = s => "'" + String(s).replace(/'/g, "''") + "'";
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';

function tableNameFrom(base, used, onTruncate) {
  let n = String(base).replace(/\.[^.]+$/, '').normalize('NFKC').replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
  if (!n) n = 'table';
  if (/^\d/.test(n)) n = 't_' + n;
  if (Array.from(n).length > MAX_NAME) {   // our own warehouse: names over 64 characters are shortened (room left for the _<k> suffix)
    if (typeof onTruncate === 'function') onTruncate(n);
    n = Array.from(n).slice(0, MAX_NAME - 4).join('');
  }
  let out = n, k = 2;
  while (used.has(out.toLowerCase())) out = n + '_' + (k++);
  used.add(out.toLowerCase());
  return out;
}

function sha256File(f) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(f, 'r'); const buf = Buffer.allocUnsafe(1 << 20);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

const csvCell = v => {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().replace(/T00:00:00\.000Z$/, '').replace('T', ' ').replace(/\.000Z$/, '').replace(/Z$/, '');
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('richText' in v) return v.richText.map(r => r.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
    return JSON.stringify(v);
  }
  return v;
}

async function xlsxToCsvs(file, tmpDir, baseName, onEvent) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const out = [];
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => { rows.push(row.values.slice(1).map(cellValue)); });
    if (rows.length < 2) continue;
    const width = Math.max(...rows.map(r => r.length));
    // A title row / banner is not a header: any very long first-row cell, or fewer than half of the cells filled.
    const filled = Array.from({ length: width }, (_, i) => rows[0][i]).filter(h => h != null && h !== '').length;
    const longCell = rows[0].some(h => h != null && String(h).length > 64);
    const titleRow = longCell || filled * 2 < width;
    if (titleRow) { try { onEvent && onEvent({ type: 'import_warning', level: 'warning', file: baseName, sheet: ws.name, reason: longCell ? 'first_row_cell_longer_than_64' : 'first_row_less_than_half_filled', note: 'first row does not look like a header; columns named col_1..col_n and the row is kept as data' }); } catch (_) {} }
    const header = Array.from({ length: width }, (_, i) => { const h = rows[0][i]; return titleRow || h == null || h === '' ? 'col_' + (i + 1) : String(h).trim(); });
    const seen = new Map();
    const uniq = header.map(h => { const k = h.toLowerCase(); const c = (seen.get(k) || 0) + 1; seen.set(k, c); return c > 1 ? h + '_' + c : h; });
    const f = path.join(tmpDir, crypto.randomUUID() + '.csv');
    const lines = [uniq.map(csvCell).join(',')];
    for (let i = titleRow ? 0 : 1; i < rows.length; i++) lines.push(Array.from({ length: width }, (_, j) => csvCell(rows[i][j])).join(','));
    fsx.writeFile(f, lines.join('\n'));
    out.push({ csv: f, sheet: ws.name, sheets: wb.worksheets.length, base: baseName });
  }
  return out;
}

/**
 * @returns {{file:string, tables:{name:string, source:string, rows:number}[], manifest:object, reused:boolean}}
 */
async function importFiles(files, dataDir, { onEvent, update, plan, warehouse: warehouseOpt, maxRows } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('data.files must be a non-empty array');
  const abs = files.map(f => path.resolve(f));
  for (const f of abs) if (!fs.existsSync(f)) throw new Error('data file not found: ' + f);
  const warehouse = warehouseOpt ? path.resolve(warehouseOpt) : path.join(dataDir, 'warehouse.duckdb');
  const manifestFile = path.join(dataDir, 'import.json');
  const stamp = abs.map(f => { const s = fs.statSync(f); const pl = typeof plan === 'function' ? plan(f) : null; return { path: f, size: s.size, mtimeMs: Math.round(s.mtimeMs), ...(pl && pl.sig ? { sig: pl.sig } : {}) }; });
  if (!update) try {
    const prev = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (fs.existsSync(warehouse) && JSON.stringify(prev.stamp) === JSON.stringify(stamp)) {
      for (const w of prev.warnings || []) { try { onEvent && onEvent(w); } catch (_) {} }
      return { file: warehouse, tables: prev.tables, manifest: prev, reused: true };
    }
  } catch (_) {}

  const { DuckDBInstance } = require('@duckdb/node-api');
  if (warehouseOpt) fsx.ensureDir(path.dirname(warehouse));
  const tmpDir = path.join(dataDir, 'tmp'); fsx.ensureDir(tmpDir);
  let prevManifest = null;
  if (update) {
    // rc.6 data refresh: keep the warehouse, re-import only the tables of changed files, drop the tables of removed files
    try { prevManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) {}
    if (!prevManifest || !fs.existsSync(warehouse)) throw new Error('refresh: no previous import to update');
  } else {
    for (const x of [warehouse, warehouse + '.wal']) { try { fs.rmSync(x, { force: true }); } catch (_) {} }
  }
  const instance = await DuckDBInstance.create(warehouse);
  fsx.secureFile(warehouse);
  const conn = await instance.connect();
  const run = async (sql) => (await conn.runAndReadAll(sql)).getRowObjects();
  const used = new Set(), tables = [], hashes = {}, warnings = [];
  const warn = (w) => { const e = { type: 'import_warning', level: 'warning', ...w }; warnings.push(e); try { onEvent && onEvent(e); } catch (_) {} };
  const onTrunc = (n) => warn({ table: redactName(n), column: null, reason: 'longer_than_64', action: 'renamed', note: 'file name too long for a table name; shortened' });

  // hostile column names (control characters / over 64 chars) never enter the warehouse metadata: renamed to col_<n>
  async function finishTable(name, source) {
    const cols = (await run(`DESCRIBE ${qi(name)}`)).map(c => String(c.column_name));
    const taken = new Set(cols.map(c => c.toLowerCase()));
    for (let i = 0; i < cols.length; i++) {
      const reason = badReason(cols[i]);
      if (!reason) continue;
      let k = i + 1, to; do { to = 'col_' + (k++); } while (taken.has(to));
      taken.add(to);
      await run(`ALTER TABLE ${qi(name)} RENAME COLUMN ${qi(cols[i])} TO ${qi(to)}`);
      warn({ table: name, column: redactName(cols[i]), reason, action: 'renamed', renamedTo: to, note: 'column renamed because its name is unsafe to send to a model' });
    }
    const rows = Number((await run(`SELECT COUNT(*) AS n FROM ${qi(name)}`))[0].n);
    tables.push({ name, source, rows });
    if (typeof onEvent === 'function') onEvent({ type: 'import_table', table: name, rows });
  }
  const emitEv = e => { try { onEvent && onEvent(e); } catch (_) {} };

  // rc.8: SQLite files and PostgreSQL / MySQL snapshots (the workspace tells us what a path stands for through `plan`)
  async function importPlanned(f, pl) {
    const { copySource } = require('./snapshot.js');
    const prefix = String(pl.name || 'src');
    const ctx = {
      conn, run, warn, event: emitEv, maxRows: Number(maxRows) > 0 ? Number(maxRows) : require('./snapshot.js').DEFAULT_MAX_ROWS,
      nameFor: t => tableNameFrom((prefix + '__' + t).replace(/\./g, '_'), used, onTrunc),
      finish: (name, t) => finishTable(name, f + '#' + t),
    };
    await copySource(ctx, pl.spec, pl.password);
  }

  async function importOne(f) {
    const pl = typeof plan === 'function' ? plan(f) : null;
    hashes[f] = sha256File(f);
    if (pl) return importPlanned(f, pl);
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f);
    const jobs = [];
    if (ext === '.csv' || ext === '.tsv' || ext === '.txt') jobs.push({ name: tableNameFrom(base, used, onTrunc), src: `read_csv_auto(${sqlStr(f)}${ext === '.tsv' ? ", delim='\\t'" : ''})`, source: f });
    else if (ext === '.parquet') jobs.push({ name: tableNameFrom(base, used, onTrunc), src: `read_parquet(${sqlStr(f)})`, source: f });
    else if (ext === '.xlsx') {
      const sheets = await xlsxToCsvs(f, tmpDir, base, onEvent);
      if (!sheets.length) throw new Error('xlsx has no non-empty sheet: ' + f);
      for (const s of sheets) jobs.push({ name: tableNameFrom(s.sheets > 1 ? base.replace(/\.[^.]+$/, '') + '_' + s.sheet : base, used, onTrunc), src: `read_csv_auto(${sqlStr(s.csv)})`, source: f + (s.sheets > 1 ? '#' + s.sheet : ''), tmp: s.csv });
    } else throw new Error('unsupported data file type (csv/tsv/parquet/xlsx): ' + f);
    for (const j of jobs) {
      await run(`CREATE TABLE ${qi(j.name)} AS SELECT * FROM ${j.src}`);
      await finishTable(j.name, j.source);
      if (j.tmp) { try { fs.rmSync(j.tmp, { force: true }); } catch (_) {} }
    }
  }
  const ownedBy = (t, f) => t.source === f || String(t.source).startsWith(f + '#');
  try {
    if (!update) {
      for (const f of abs) await importOne(f);
    } else {
      const changed = new Set((update.changed || []).map(f => path.resolve(f)));
      const removed = new Set((update.removed || []).map(f => path.resolve(f)));
      const dropFiles = [...changed, ...removed];
      const keep = prevManifest.tables.filter(t => !dropFiles.some(f => ownedBy(t, f)));
      for (const t of keep) used.add(String(t.name).toLowerCase());
      Object.assign(hashes, prevManifest.sha256 || {});
      for (const f of removed) delete hashes[f];
      // each file is replaced inside one transaction: a file that cannot be read leaves its old tables untouched
      for (const f of abs) {
        if (!changed.has(f)) continue;
        const oldTables = prevManifest.tables.filter(t => ownedBy(t, f));
        const usedBefore = new Set(used), nT = tables.length, nW = warnings.length;
        await run('BEGIN TRANSACTION');
        try {
          for (const t of oldTables) await run(`DROP TABLE IF EXISTS ${qi(t.name)}`);
          await importOne(f);
          await run('COMMIT');
        } catch (err) {
          try { await run('ROLLBACK'); } catch (_) {}
          used.clear(); for (const u of usedBefore) used.add(u);
          tables.length = nT; warnings.length = nW;
          for (const t of oldTables) tables.push(t);
          for (const t of oldTables) used.add(String(t.name).toLowerCase());
          hashes[f] = (prevManifest.sha256 || {})[f];
          throw Object.assign(err, { refreshFile: f });
        }
      }
      for (const f of removed) for (const t of prevManifest.tables.filter(x => ownedBy(x, f))) await run(`DROP TABLE IF EXISTS ${qi(t.name)}`);
      const fresh = new Set(tables.map(t => t.name));
      const merged = keep.concat(tables);
      tables.length = 0; for (const t of merged) tables.push(t);
      const reTables = new Set([...fresh].map(String));
      const keepWarn = (prevManifest.warnings || []).filter(w => !reTables.has(w.table));
      const newWarn = warnings.slice(); warnings.length = 0; for (const w of keepWarn.concat(newWarn)) warnings.push(w);
    }
  } finally {
    try { conn.disconnectSync ? conn.disconnectSync() : conn.closeSync && conn.closeSync(); } catch (_) {}
    try { instance.closeSync && instance.closeSync(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
  let stampOut = stamp;
  if (update) {   // files that were not re-imported keep the stamp they were imported with (a failed refresh must not look current after a restart)
    const changedSet = new Set((update.changed || []).map(f => path.resolve(f)));
    const prevBy = new Map((prevManifest.stamp || []).map(e => [e.path, e]));
    stampOut = stamp.map(e => changedSet.has(e.path) || !prevBy.has(e.path) ? e : prevBy.get(e.path));
  }
  const manifest = { schema: 'estratto-import/1', stamp: stampOut, sha256: hashes, tables, warnings, at: new Date().toISOString() };
  fsx.writeFile(manifestFile, JSON.stringify(manifest, null, 1));
  for (const x of [warehouse, warehouse + '.wal']) fsx.secureFile(x);
  return { file: warehouse, tables, manifest, reused: false };
}

module.exports = { importFiles, tableNameFrom };
