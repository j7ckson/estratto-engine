'use strict';
// rc.8 discovery: look for usable data under the folders / files the user NAMED. Nothing else is ever read.
//   discover(paths, { maxDepth: 4, maxFiles: 5000, previewMaxBytes }) -> [{ kind, path, name, size, mtime, tables?: [{ name, rows, columns }] }]
// Rules: only the given paths; no network; databases are opened read-only; hidden folders, node_modules, system and
// credential folders are never entered; symbolic links are not followed; a file is recognised by its first bytes
// (SQLite "SQLite format 3\0", DuckDB "DUCK" at offset 8) before its extension, so a database with a wrong extension is found too.
const fs = require('node:fs');
const path = require('node:path');

const KINDS = ['csv', 'tsv', 'xlsx', 'parquet', 'duckdb', 'sqlite'];
const EXT_KIND = { '.csv': 'csv', '.tsv': 'tsv', '.xlsx': 'xlsx', '.parquet': 'parquet', '.duckdb': 'duckdb', '.ddb': 'duckdb' };
const DEFAULT_PREVIEW_MAX = 512 * 1024 * 1024;

// directory NAMES that are never entered (case-insensitive). Credential stores are refused even when the user names them.
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.trash', '$recycle.bin', 'system volume information', 'lost+found', 'site-packages', '.venv', 'venv']);
const CREDENTIAL_DIRS = new Set(['.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.kube', '.docker', '.password-store', 'keychains', '.pki', '.npmrc', '.netrc']);
const SYSTEM_ROOTS = ['/proc', '/sys', '/dev', '/etc', '/boot', '/run', '/bin', '/sbin', '/lib', '/lib64', '/usr', '/var/lib', '/var/run', '/private/etc', '/System', '/Library', '/Windows'];

function refusedReason(abs) {
  const norm = abs.replace(/\\/g, '/');
  if (path.parse(abs).root === abs) return 'disk_root';
  const segs = norm.split('/').filter(Boolean).map(s => s.toLowerCase());
  for (const s of segs) if (CREDENTIAL_DIRS.has(s)) return 'credential_folder';
  if (/\/library\/keychains(\/|$)/i.test(norm) || /\/(appdata\/[^/]+\/)?microsoft\/(credentials|protect|vault)(\/|$)/i.test(norm) || /\/\.config\/(gcloud|gh|op)(\/|$)/i.test(norm)) return 'credential_folder';
  for (const r of SYSTEM_ROOTS) { const rl = r.toLowerCase(); if (norm.toLowerCase() === rl || norm.toLowerCase().startsWith(rl + '/')) return 'system_folder'; }
  if (/^[a-z]:\/(windows|program files|program files \(x86\)|programdata)(\/|$)/i.test(norm)) return 'system_folder';
  return null;
}

function sniffHeader(file) {
  let fd; try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(16);
    const n = fs.readSync(fd, b, 0, 16, 0);
    if (n >= 16 && b.toString('latin1', 0, 16) === 'SQLite format 3\u0000') return 'sqlite';
    if (n >= 12 && b.toString('latin1', 8, 12) === 'DUCK') return 'duckdb';
  } catch (_) { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch (_) {} }
  return null;
}
/** classify one file: by magic header first (databases), then by extension; null = not data we know */
function kindOfFile(file) {
  const head = sniffHeader(file);
  if (head) return head;
  return EXT_KIND[path.extname(file).toLowerCase()] || null;
}

// ---- csv / tsv: header + a cheap row count ----
function splitHeader(line, delim) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
function textPreview(file, delim, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 65536)); const n = fs.readSync(fd, head, 0, head.length, 0);
    let text = head.subarray(0, n).toString('utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const first = text.split(/\r?\n/)[0] || '';
    const columns = first ? splitHeader(first, delim).slice(0, 500) : [];
    let lines = 0, last = 10; const buf = Buffer.allocUnsafe(1 << 20); let pos = 0, r;
    while ((r = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) { for (let i = 0; i < r; i++) if (buf[i] === 10) lines++; last = buf[r - 1]; pos += r; }
    if (pos > 0 && last !== 10) lines++;
    return { columns, rows: Math.max(0, lines - 1), approx: true };
  } finally { fs.closeSync(fd); }
}

// ---- xlsx: sheet names and their used range, read from the zip without loading cell data ----
async function xlsxSheets(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const wbf = zip.file('xl/workbook.xml'); if (!wbf) return [];
  const wb = await wbf.async('string');
  const relf = zip.file('xl/_rels/workbook.xml.rels');
  const rels = relf ? await relf.async('string') : '';
  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0]), tg = /\bTarget="([^"]*)"/.exec(m[0]);
    if (id && tg) relMap.set(id[1], tg[1]);
  }
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const out = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const nm = /\bname="([^"]*)"/.exec(m[0]); const rid = /\br:id="([^"]*)"/.exec(m[0]);
    if (!nm) continue;
    let rows = null, columns = null;
    const target = rid && relMap.get(rid[1]);
    if (target) {
      const p = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
      const sf = zip.file(p);
      if (sf) {
        const head = await new Promise((resolve, reject) => {
          let acc = ''; const st = sf.nodeStream();
          st.on('data', d => { acc += d.toString('utf8'); if (acc.length > 4096 || /<dimension\b/.test(acc)) { st.destroy(); resolve(acc); } });
          st.on('end', () => resolve(acc)); st.on('error', reject); st.on('close', () => resolve(acc));
        });
        const d = /<dimension\s+ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/.exec(head);
        if (d) {
          const col = s => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
          const r1 = Number(d[2]), r2 = d[4] ? Number(d[4]) : r1, c1 = col(d[1]), c2 = d[3] ? col(d[3]) : c1;
          rows = Math.max(0, r2 - r1);   // header row not counted
          columns = c2 - c1 + 1;
        }
      }
    }
    out.push({ name: unesc(nm[1]), rows, columns });
  }
  return out;
}

// ---- databases (read-only) ----
function sqliteTables(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND COALESCE(sql,'') NOT LIKE 'CREATE VIRTUAL%' ORDER BY name").all().map(r => r.name);
    return names.map(name => {
      const q = '"' + name.replace(/"/g, '""') + '"';
      const columns = db.prepare(`PRAGMA table_info(${q})`).all().map(c => c.name);
      let rows = null; try { rows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q}`).get().n); } catch (_) {}
      return { name, rows, columns };
    });
  } finally { try { db.close(); } catch (_) {} }
}
async function duckTables(file) {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(file, { access_mode: 'READ_ONLY', enable_external_access: 'false' });
  const conn = await inst.connect();
  try {
    const run = async sql => (await conn.runAndReadAll(sql)).getRowObjects();
    const ts = await run("SELECT table_name FROM information_schema.tables WHERE table_schema='main' AND table_type='BASE TABLE' ORDER BY table_name");
    const out = [];
    for (const t of ts) {
      const q = '"' + String(t.table_name).replace(/"/g, '""') + '"';
      const columns = (await run(`DESCRIBE ${q}`)).map(c => String(c.column_name));
      let rows = null; try { rows = Number((await run(`SELECT COUNT(*) AS n FROM ${q}`))[0].n); } catch (_) {}
      out.push({ name: String(t.table_name), rows, columns });
    }
    return out;
  } finally { try { conn.disconnectSync ? conn.disconnectSync() : conn.closeSync(); } catch (_) {} try { inst.closeSync(); } catch (_) {} }
}
async function parquetInfo(file) {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  try {
    const lit = "'" + file.replace(/'/g, "''") + "'";
    const rows = Number((await (await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM read_parquet(${lit})`)).getRowObjects())[0].n);
    const columns = (await (await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${lit})`)).getRowObjects()).map(c => String(c.column_name));
    return { rows, columns };
  } finally { try { conn.disconnectSync ? conn.disconnectSync() : conn.closeSync(); } catch (_) {} try { inst.closeSync(); } catch (_) {} }
}

/** the interesting part: describe one candidate file (never throws; problems are reported on the candidate) */
async function describeFile(file, kind, st, previewMaxBytes) {
  const c = { kind, path: file, name: path.basename(file), size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  if (st.size > previewMaxBytes && kind !== 'parquet') { c.note = 'too_large_for_preview'; return c; }
  try {
    if (kind === 'csv' || kind === 'tsv') {
      const p = textPreview(file, kind === 'tsv' ? '\t' : ',', st.size);
      c.tables = [{ name: path.basename(file).replace(/\.[^.]+$/, ''), rows: p.rows, columns: p.columns, rowsApprox: true }];
    } else if (kind === 'xlsx') {
      c.tables = (await xlsxSheets(file)).map(s => ({ name: s.name, rows: s.rows, columns: s.columns, sheet: true }));
    } else if (kind === 'parquet') {
      if (st.size > previewMaxBytes * 4) c.note = 'too_large_for_preview';
      else { const p = await parquetInfo(file); c.tables = [{ name: path.basename(file).replace(/\.[^.]+$/, ''), rows: p.rows, columns: p.columns }]; }
    } else if (kind === 'sqlite') c.tables = sqliteTables(file);
    else if (kind === 'duckdb') c.tables = await duckTables(file);
  } catch (e) {
    c.error = /lock|conflict|another process/i.test(String(e && e.message)) ? 'file_in_use' : 'unreadable';
    c.detail = String(e && e.message || e).slice(0, 200);
  }
  return c;
}

/**
 * @param {string|string[]} paths  files and/or folders the user named (nothing else is looked at)
 * @returns {Promise<object[]>} candidates; the array also carries .skipped [{path, reason}] and .truncated
 */
async function discover(paths, { maxDepth = 4, maxFiles = 5000, previewMaxBytes = DEFAULT_PREVIEW_MAX, kinds = null } = {}) {
  const list = Array.isArray(paths) ? paths : [paths];
  const out = [], skipped = [], seen = new Set();
  let examined = 0, truncated = false;
  const want = kinds ? new Set(kinds) : null;
  const skip = (p, reason) => { skipped.push({ path: p, reason }); };

  async function handleFile(abs, st) {
    if (seen.has(abs)) return; seen.add(abs);
    if (path.basename(abs).startsWith('~$')) return;
    const kind = kindOfFile(abs);
    if (!kind || (want && !want.has(kind))) return;
    out.push(await describeFile(abs, kind, st, previewMaxBytes));
  }
  async function walk(dir, depth) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { skip(dir, 'unreadable'); return; }
    ents.sort((a, b) => a.name < b.name ? -1 : 1);
    for (const e of ents) {
      if (truncated) return;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { skip(p, 'symlink'); continue; }
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase();
        if (e.name.startsWith('.')) { skip(p, 'hidden_folder'); continue; }
        if (CREDENTIAL_DIRS.has(lower) || /^keychains$/i.test(e.name)) { skip(p, 'credential_folder'); continue; }
        if (SKIP_DIRS.has(lower)) { skip(p, 'ignored_folder'); continue; }
        const why = refusedReason(p); if (why) { skip(p, why); continue; }
        if (depth >= maxDepth) { skip(p, 'too_deep'); continue; }
        await walk(p, depth + 1);
        continue;
      }
      if (!e.isFile() || e.name.startsWith('.')) continue;
      if (++examined > maxFiles) { truncated = true; return; }
      let st; try { st = fs.statSync(p); } catch (_) { continue; }
      await handleFile(p, st);
    }
  }

  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim() || /\u0000/.test(raw)) { skip(String(raw), 'bad_path'); continue; }
    const abs = path.resolve(raw);
    const why = refusedReason(abs);
    if (why) { skip(abs, why); continue; }
    let lst; try { lst = fs.lstatSync(abs); } catch (_) { skip(abs, 'not_found'); continue; }
    if (lst.isSymbolicLink()) { skip(abs, 'symlink'); continue; }
    if (lst.isDirectory()) { await walk(abs, 0); }
    else if (lst.isFile()) { if (++examined > maxFiles) { truncated = true; break; } await handleFile(abs, lst); }
    if (truncated) break;
  }
  out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  Object.defineProperty(out, 'skipped', { value: skipped, enumerable: false });
  Object.defineProperty(out, 'truncated', { value: truncated, enumerable: false });
  return out;
}

module.exports = { discover, kindOfFile, sniffHeader, sqliteTables, duckTables, KINDS, DEFAULT_PREVIEW_MAX };
