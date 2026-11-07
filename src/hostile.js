'use strict';
// rc.4: hostile identifiers. A table or column name that contains control characters (incl. CR/LF, C1, U+2028/2029) or is longer
// than 64 characters can carry arbitrary text (even private data) into the system prompt / candidates. Such names are kept out of
// every piece of metadata the registry, the entity lookup, the auto rules and the SQL context are built from.
const CTRL_ANY = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CTRL_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const MAX_NAME = 64;

function badReason(name) {
  const s = String(name == null ? '' : name);
  if (CTRL_ANY.test(s)) return 'control_characters';
  if (s.length > MAX_NAME) return 'longer_than_64';
  return null;
}
/** first 16 characters (controls shown as spaces) + an ellipsis; never the whole name */
function redactName(name) {
  return Array.from(String(name == null ? '' : name).replace(CTRL_ALL, ' ')).slice(0, 16).join('') + '…';
}

/**
 * @param {{name:string, columns:{name:string,type:string}[]}[]} meta  typed (number/date/text) metadata for the registry
 * @param {{name:string, columns:{name:string,type:string}[]}[]} raw   DuckDB types, for auto rules / tables()
 * @returns {{meta, raw, excluded:{table:string, tableRedacted:string, column:string|null, columnRedacted:string|null, type:string|null, reason:string}[]}}
 *   Without hostile names `meta` and `raw` are returned unchanged (same objects).
 */
function screenMeta(meta, raw, emit) {
  const excluded = [];
  let any = false;
  const note = (e) => {
    excluded.push(e);
    if (typeof emit === 'function') {
      try { emit({ type: 'import_warning', level: 'warning', table: e.tableRedacted, column: e.columnRedacted, reason: e.reason, action: 'excluded', note: 'name is excluded from everything sent to the model' }); } catch (_) {}
    }
  };
  const rawBy = new Map(raw.map(t => [t.name, t]));
  const outMeta = [], outRaw = [];
  for (const t of meta) {
    const rt = rawBy.get(t.name) || { name: t.name, columns: [] };
    const tr = badReason(t.name);
    if (tr) {
      any = true;
      note({ table: t.name, tableRedacted: redactName(t.name), column: null, columnRedacted: null, type: null, reason: tr });
      continue;
    }
    const bad = t.columns.filter(c => badReason(c.name));
    if (!bad.length) { outMeta.push(t); outRaw.push(rt); continue; }
    any = true;
    for (const c of bad) {
      const rc = rt.columns.find(x => x.name === c.name);
      note({ table: t.name, tableRedacted: t.name, column: c.name, columnRedacted: redactName(c.name), type: rc ? rc.type : null, reason: badReason(c.name) });
    }
    const keep = c => !badReason(c.name);
    const mc = t.columns.filter(keep);
    if (!mc.length) continue;   // nothing left to describe
    outMeta.push({ ...t, columns: mc });
    outRaw.push({ ...rt, columns: rt.columns.filter(keep) });
  }
  return any ? { meta: outMeta, raw: outRaw, excluded } : { meta, raw, excluded };
}

module.exports = { badReason, redactName, screenMeta, MAX_NAME };
