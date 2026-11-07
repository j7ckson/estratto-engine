'use strict';
// rc.8: "what did I just import?" -- rows, columns and the date range of each table, computed locally on the warehouse.
const q = s => '"' + String(s).replace(/"/g, '""') + '"';
const DATE_TYPE = /^(DATE|TIMESTAMP)/i;
const DATE_NAME = /date|time|month|day|日期|时间|月份|年月|日$/i;
const PREFERRED = /order|created|placed|paid|sale|trans|日期|下单|创建|date/i;

async function pickDateColumn(db, table, cols) {
  const typed = cols.filter(c => DATE_TYPE.test(String(c.type)));
  if (typed.length) return { col: (typed.find(c => PREFERRED.test(c.name)) || typed[0]).name, cast: false };
  for (const c of cols.filter(c => /^(VARCHAR|TEXT|STRING|CHAR)/i.test(String(c.type)) && DATE_NAME.test(c.name))) {
    try {
      const r = (await db.adminRun(`SELECT COUNT(${q(c.name)}) AS n, COUNT(TRY_CAST(${q(c.name)} AS DATE)) AS ok FROM (SELECT ${q(c.name)} FROM ${q(table)} LIMIT 2000)`))[0];
      if (Number(r.n) > 0 && Number(r.ok) / Number(r.n) >= 0.9) return { col: c.name, cast: true };
    } catch (_) {}
  }
  return null;
}

/** @param db the engine's open database (adminRun / rowCount)  @param raw [{name, columns:[{name,type}]}]  @param imported [{name, source, rows}] | null */
async function summarize(db, raw, imported) {
  const src = new Map((imported || []).map(t => [t.name, t.source]));
  const out = [];
  for (const t of raw) {
    const e = { name: t.name, rows: null, columns: t.columns.length, dateColumn: null, from: null, to: null, source: src.get(t.name) || null };
    try { e.rows = await db.rowCount(t.name); } catch (_) {}
    try {
      const pick = await pickDateColumn(db, t.name, t.columns);
      if (pick) {
        const expr = pick.cast ? `TRY_CAST(${q(pick.col)} AS DATE)` : `CAST(${q(pick.col)} AS DATE)`;
        const r = (await db.adminRun(`SELECT CAST(MIN(${expr}) AS VARCHAR) AS a, CAST(MAX(${expr}) AS VARCHAR) AS b FROM ${q(t.name)}`))[0];
        if (r && r.a) { e.dateColumn = pick.col; e.from = r.a; e.to = r.b; }
      }
    } catch (_) {}
    out.push(e);
  }
  return out;
}

module.exports = { summarize };
