'use strict';
// rc.6: model-call ledger (usage.jsonl) and the daily budget.
// One JSON line per model call: { at, day, requestId, providerRequestId, model, usage, costUSD }.
// The ledger never sees the request or the response text, only the usage numbers; it cannot contain the api key.
const fs = require('node:fs');
const fsx = require('./fsx.js');
const { todayIn } = require('../core/main/time-core.js');

const num = x => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);

/** @returns {{input:number, cached:number, output:number}} token counts split the way prices are quoted */
function splitUsage(u) {
  if (!u || typeof u !== 'object') return { input: 0, cached: 0, output: 0 };
  const total = num(u.prompt_tokens) || num(u.input_tokens);
  const cached = num(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || num(u.prompt_cache_hit_tokens) || num(u.cache_read_tokens);
  let input = u.prompt_cache_miss_tokens != null ? num(u.prompt_cache_miss_tokens) : Math.max(0, total - cached);
  const output = num(u.completion_tokens) || num(u.output_tokens);
  return { input, cached, output };
}

/** estimated cost in USD for one call; 0 when no price is configured */
function costOf(usage, price) {
  if (!price || typeof price !== 'object') return 0;
  const { input, cached, output } = splitUsage(usage);
  const c = (input * num(price.inputPerM) + cached * num(price.cachedInputPerM) + output * num(price.outputPerM)) / 1e6;
  return Math.round(c * 1e9) / 1e9;
}

function createLedger({ file = null, timezone = 'Asia/Shanghai', price = null, dailyBudgetUSD = null } = {}) {
  const cfg = { timezone, price, dailyBudgetUSD };
  let mem = [];            // used when there is no file
  let loadedSize = -1, cache = [];
  const dayOf = () => todayIn(cfg.timezone);

  function readAll() {
    if (!file) return mem;
    let st; try { st = fs.statSync(file); } catch (_) { return []; }
    if (st.size === loadedSize) return cache;
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) {}
    }
    cache = out; loadedSize = st.size;
    return out;
  }
  return {
    configure(patch = {}) { for (const k of ['timezone', 'price', 'dailyBudgetUSD']) if (k in patch) cfg[k] = patch[k]; },
    get config() { return { ...cfg }; },
    record({ requestId = null, providerRequestId = null, model = null, usage = null } = {}) {
      const entry = { at: new Date().toISOString(), day: dayOf(), requestId, providerRequestId, model, usage: usage || null, costUSD: costOf(usage, cfg.price) };
      if (file) {
        if (!fs.existsSync(file)) fsx.writeFile(file, '');
        fs.appendFileSync(file, JSON.stringify(entry) + '\n');
        loadedSize = -1;
      } else mem.push(entry);
      return entry;
    },
    list(limit) { const a = readAll(); return limit ? a.slice(-limit) : a.slice(); },
    todayUSD() { const d = dayOf(); return Math.round(readAll().filter(e => e.day === d).reduce((s, e) => s + num(e.costUSD), 0) * 1e9) / 1e9; },
    totalUSD() { return Math.round(readAll().reduce((s, e) => s + num(e.costUSD), 0) * 1e9) / 1e9; },
    today() { return { day: dayOf(), spentUSD: this.todayUSD(), limitUSD: cfg.dailyBudgetUSD == null ? null : Number(cfg.dailyBudgetUSD), calls: readAll().filter(e => e.day === dayOf()).length }; },
    /** true when a daily limit is set and today's estimated spend has reached it */
    exceeded() { return cfg.dailyBudgetUSD != null && Number.isFinite(Number(cfg.dailyBudgetUSD)) && this.todayUSD() >= Number(cfg.dailyBudgetUSD); },
  };
}

module.exports = { createLedger, costOf, splitUsage };
