'use strict';
// Pure mappers from the core ask() result to the engine's public result fields.
// Source references (core/main/ask.js): status values 'ok' | 'needs_clarification' | 'capability_gap' | 'no_data' | 'error';
// ok + result_status 'no_data' (config lane no rows, sql lane ask.js:2257); ok + tier 'pending' (auto-named fields ask.js:893-929,
// sql lane new algorithm sql-lane.js tierOf); ok + tier 'unverified' (sql lane, unregistered fields / bad joins);
// ok + value_guess (ask.js:274, 2168); needs_clarification code 'value_choice' (ask.js:552, 2065).

const STATUSES = ['verified', 'needs_confirm', 'unverified', 'refused', 'no_data', 'cancelled', 'error'];

function mapStatus(r) {
  if (!r || typeof r !== 'object') return 'error';
  const st = r.status;
  if (st === 'cancelled' || r.code === 'cancelled') return 'cancelled';
  if (st === 'ok') {
    if (r.result_status === 'no_data') return 'no_data';
    if (r.tier === 'unverified') return 'unverified';
    if (r.value_guess || (Array.isArray(r.value_guesses) && r.value_guesses.length)) return 'needs_confirm';
    const autoNames = r.tier_why && Array.isArray(r.tier_why.auto_names) && r.tier_why.auto_names.length;
    if (r.tier === 'pending' || autoNames || (Array.isArray(r.facts) && r.facts.some(f => f && f.tier === 'pending'))) return 'needs_confirm';
    return 'verified';
  }
  if (st === 'needs_clarification') return 'needs_confirm';
  if (st === 'capability_gap' || st === 'refused' || st === 'locked') return 'refused';
  if (st === 'no_data') return 'no_data';
  return 'error';
}

function routeOf(r, callsThisAsk) {
  if (!r) return 'plan';
  const route = String(r.route || '');
  if (r.lane === 'sql' || /sql/i.test(route)) return 'sql';
  if (r.reuse && r.reuse.result_hit) return 'reuse';
  if (/^(reuse|cache)|result_cache|entry_cache|plan_cache/i.test(route)) return 'reuse';
  if (callsThisAsk === 0) return 'local';
  return 'plan';
}

// rc.7: `zh` (auto-rules mode with language zh) gives the two fixed card sentences a Chinese text; without it the rc.6 English text is kept
// byte for byte (supplied rules packs must produce exactly what they produced before).
const ZH_CARD = {
  value_guess: '问题里的一个词被对应到了库里已有的取值；确认就按这个理解算。',
  plan: '字段的含义或计算方式是自动认的、还没人确认；确认后，这个问题就按这个口径算。',
};
function confirmOf(r, status, { zh = false } = {}) {
  if (status !== 'needs_confirm' || !r) return undefined;
  if (r.code === 'no_such_metric') return { kind: 'no_such_metric', message: r.message || r.answer || null, options: [], asked: r.asked || null, suggestion: r.suggestion || null };
  if (r.value_choice) {
    const v = r.value_choice;
    return { kind: 'value_choice', message: r.answer || null, literal: v.literal, dim: v.dim || null, table: v.table || null, column: v.col || null, options: (v.options || []).map(o => ({ ...o })) };
  }
  if (r.value_guess || (r.value_guesses && r.value_guesses.length)) {
    const gs = r.value_guesses && r.value_guesses.length ? r.value_guesses : [r.value_guess];
    return { kind: 'value_guess', message: zh ? ZH_CARD.value_guess : 'A value in the question was matched to a stored value; confirm to keep this reading.', options: [{ id: 'accept', guesses: gs.map(g => ({ literal: g.literal, value: g.value, table: g.table || null, column: g.col || null })) }] };
  }
  if (r.status === 'needs_clarification') {
    return { kind: r.code || 'clarification', message: r.answer || r.message || null, options: Array.isArray(r.options) ? r.options.map(o => (o && typeof o === 'object' ? { ...o } : o)) : [], errors: r.errors || null };
  }
  return { kind: 'plan', message: zh ? ZH_CARD.plan : 'Field meaning or calculation is auto-derived or not yet registered; confirm to accept it for this question.', options: [{ id: 'accept' }], reasons: r.tier_why || null };
}

// meta.checks: derived from the core trace layers, not from the model's own statements.
function checksOf(r, { blocked = false, modelCalls = 0 } = {}) {
  const layers = (r && r.trace && Array.isArray(r.trace.layers)) ? r.trace.layers : [];
  const find = name => layers.find(l => l && l.layer === name);
  const res = (cond) => cond === true ? 'pass' : cond === false ? 'fail' : 'not_executed';
  const checks = [];
  checks.push({ name: 'privacy_outbound', result: blocked ? 'fail' : (modelCalls > 0 ? 'pass' : 'not_executed') });
  const vir = find('validate_ir');
  checks.push({ name: 'plan_validation', result: vir ? res(!!vir.ok) : (r && r.plan && r.lane !== 'sql' ? 'pass' : 'not_executed') });
  const sqlc = find('sql_check');
  checks.push({ name: 'sql_check', result: sqlc ? res(!!sqlc.ok) : (r && r.lane === 'sql' ? (r.status === 'ok' ? 'pass' : 'fail') : 'not_executed') });
  const ran = r && Array.isArray(r.facts) && r.facts.length > 0;
  checks.push({ name: 'execution', result: ran ? 'pass' : (r && r.status === 'error' && r.lane === 'sql' ? 'fail' : 'not_executed') });
  const sc = layers.find(l => l && /self_check/.test(String(l.layer)));
  checks.push({ name: 'self_check', result: sc ? res(sc.ok !== false && !(sc.issues && sc.issues.length)) : (ran ? 'pass' : 'not_executed') });
  return checks;
}

module.exports = { mapStatus, routeOf, confirmOf, checksOf, STATUSES };
