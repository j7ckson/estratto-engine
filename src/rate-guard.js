'use strict';
// rc.7, auto-rules mode only. A question about a RATE / SHARE / AVERAGE ("退款率是多少") must not be answered with a plain total.
// The planner (or the local matcher, which maps "退款率" onto the metric whose alias is "退款") can pick an amount metric for it, and the
// answer then carries a verified-looking number of the wrong kind. This module decides, from the question text and the typed result
// (never from numbers), whether the answer's kind fits the question, and builds the replacement "no such metric yet" result.

// 率 / 比例 / 占比 / 百分比 / 平均 / 均 / rate / ratio / share / percent / % / average / avg / "<x> per <order|customer|...>"
const ZH_RE = /率|比例|占比|比重|百分比|平均|均/;
const EN_RE = /\b(rate|ratio|share|percent(?:age)?|average|avg)\b/i;
const EN_PER_RE = /\bper\s+(?:order|customer|user|unit|item|click|session|visit(?:or)?|day|transaction|piece|ticket|sku|product|employee|head|capita)s?\b/i;
const LONE_PCT_RE = /(?<![\d.])\s*[%％]/;   // "10%" inside a filter is a number, not a rate question

function asksRate(question) {
  const q = String(question || '');
  return ZH_RE.test(q) || EN_RE.test(q) || EN_PER_RE.test(q) || LONE_PCT_RE.test(q);
}

function stripSql(sql) {
  return String(sql || '').replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}
function sqlIsRatioLike(sql) {
  const t = stripSql(sql);
  return /\/|\b(?:avg|mean|average|median|quantile\w*|percent_rank|cume_dist)\s*\(/i.test(t);
}

function metricIsRatioLike(m) {
  if (!m) return false;
  return m.kind === 'ratio' || m.kind === 'derived' || m.agg === 'avg' || !!m.platform_ratio || m.percent_scale != null || m.additivity === 'ratio' || m.additivity === 'none';
}

/** true = the answer is a ratio / share / average (or a growth rate), false = it is a plain total / count, null = cannot tell */
function answerIsRatioLike(result, registry) {
  if (!result) return null;
  const plan = result.plan;
  if (plan && typeof plan === 'object') {
    const f = plan.formula;
    if (f && ['ratio', 'share', 'pp', 'derived', 'member_diff'].includes(f.kind)) return true;
    if (f && f.kind === 'simple' && f.agg === 'avg') return true;
    if (plan.comparison && plan.comparison.kind && plan.comparison.kind !== 'none') return true;   // growth rate / change
    const ids = plan.metric_ids || [];
    if (!ids.length) return null;
    for (const id of ids) {
      let m = null; try { m = registry.metric(id); } catch (_) {}
      if (metricIsRatioLike(m)) return true;
    }
    return false;
  }
  if (result.lane === 'sql' || result.sql) return result.sql ? sqlIsRatioLike(result.sql) : null;
  return null;
}

/** the rate word as the user wrote it, e.g. "退款率", "占比", "平均"; null when none can be cut out */
function askedWord(question) {
  const q = String(question || '');
  let m = /([一-鿿]{1,4}?)(率|占比|比例|比重|百分比)/.exec(q);
  if (m) return (m[1] + m[2]).replace(/^(?:的|各|每|是|和|与)+/, '') || m[2];
  m = /(平均[一-鿿]{1,6}?)(?=是|为|多少|的|[，。？?]|$)/.exec(q);
  if (m) return m[1];
  m = EN_RE.exec(q);
  return m ? m[1].toLowerCase() : null;
}

function usableMetrics(registry) {
  const out = [];
  try {
    for (const d of registry.metrics()) {
      if (!d.bound || d.kind !== 'simple') continue;
      let m = null; try { m = registry.metric(d.id); } catch (_) {}
      if (!m || m.agg === 'count' || m.agg === 'dcount') continue;
      out.push({ id: d.id, name: String(d.name || ''), names: [d.name, ...(m.aliases || [])].map(x => String(x || '')).filter(x => x.length >= 2), unit: d.unit || '', dataset: d.dataset });
    }
  } catch (_) {}
  return out;
}

/** "退款额 ÷ 销售额" when both can be found among the metrics the data already has; null otherwise (never guesses) */
function suggestRatio(question, registry) {
  const q = String(question || '');
  const mm = /([一-鿿]{1,6})(?:率|占比|比例|比重)/.exec(q);
  if (!mm) return null;
  const stem = mm[1];
  const ms = usableMetrics(registry);
  let num = null, best = 0;
  for (const m of ms) for (const n of m.names) if (n.length > best && stem.includes(n)) { best = n.length; num = m; }
  if (!num) return null;
  const den = ms.find(m => m.id !== num.id && m.unit === num.unit && /销售额|成交总额|营业额|订单金额|^金额$|gmv/i.test(m.name))
    || ms.find(m => m.id !== num.id && m.unit === num.unit && /金额|销售|成交/.test(m.name));
  const text = den ? num.name + ' ÷ ' + den.name : null;
  return text && !/\d/.test(text) ? { num: num.name, den: den.name, text } : null;
}

function messageFor(question, registry, language) {
  const word = askedWord(question);
  const sug = suggestRatio(question, registry);
  if (language === 'en') {
    return 'The data has no ' + (word ? '"' + word + '"' : 'rate / ratio / average') + ' metric yet, so no number is given (the metrics it has are plain totals and counts). '
      + (sug ? 'You can define it in the rules as ' + sug.text + ' and ask again.' : 'Define it in the rules as one metric divided by another (or an average) and ask again.');
  }
  return '数据里还没有' + (word ? '「' + word + '」' : '比率 / 占比 / 平均值') + '这个指标（现有的只是合计和个数），所以没有给出数字，免得拿一个合计冒充它。'
    + (sug ? '可以在口径里把它定义成：' + sug.text + '，定义好再问就有核验过的结果。' : '请在口径里把它定义成「一个指标 ÷ 另一个指标」（或平均值），定义好再问。');
}

/**
 * @returns the replacement result (status needs_clarification, code no_such_metric, no facts / rows / plan / sql) or null when the answer stands.
 * Only answers that carry a number are touched; refusals, errors, no_data and clarifications pass through.
 */
function guard(question, result, registry, language) {
  if (!result || result.status !== 'ok' || result.result_status === 'no_data') return null;
  if (!Array.isArray(result.facts) || !result.facts.length) return null;
  if (!asksRate(question)) return null;
  if (answerIsRatioLike(result, registry) !== false) return null;
  const msg = messageFor(question, registry, language);
  const out = {
    status: 'needs_clarification', code: 'no_such_metric', answer: 'ANSWER: ' + msg, message: msg,
    facts: [], rows: [], plan: null, sql: null, options: [],
    asked: askedWord(question), suggestion: (suggestRatio(question, registry) || {}).text || null,
  };
  for (const k of ['route', 'lane', 'llm_calls', 'calls_this_turn', 'tokens', 'zero_llm', 'trace', 'provider_calls', 'reuse']) if (result[k] !== undefined) out[k] = result[k];
  return out;
}

module.exports = { guard, asksRate, answerIsRatioLike, sqlIsRatioLike, askedWord, suggestRatio, messageFor };
