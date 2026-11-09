'use strict';
// Outbound privacy transport. Equivalent of the B6 benchmark's studio-privacy.cjs `protect()`, applied to every
// request the engine hands to a model; the host cannot switch it off.
//   - exactly two messages (system, user); no tools
//   - the user message is the marker + a JSON payload whose `question` is the user's own question
//   - payload keys limited to the allowed set
//   - `entities` filtered to values that literally occur in the user question
//   - `previous_errors` reduced to a typed category + authorized (table-schema) field names
// Anything that does not have the expected shape is refused (never sent).
const MARKER = 'INPUT（JSON）:\n';
const ALLOWED_KEYS = ['question', 'anchor', 'timezone', 'candidates', 'period', 'entities', 'previous_errors'];
const CANDIDATE_KEYS = ['metrics', 'dimensions', 'time_roles'];

class OutboundBlocked extends Error {
  constructor(reason) { super('outbound_blocked: ' + reason); this.code = 'outbound_blocked'; this.reason = reason; }
}


function categoryOf(raw) {
  return /convert|conversion|转换|日期格式/i.test(raw) ? 'type_conversion'
    : /无权|outside|permission|restricted/i.test(raw) ? 'scope_or_column_binding'
    : /share|ratio|denominator|比率|分母|百分/i.test(raw) ? 'ratio_or_shape'
    : /column|字段|列|binder/i.test(raw) ? 'column_binding'
    : /json|JSON|格式/i.test(raw) ? 'output_format'
    : 'plan_or_sql_contract';
}

/**
 * @param {{messages:{role:string,content:string}[], tools?:any[]}} body
 * @param {string} question the user's question, verbatim
 * @param {{tables:{name:string, columns:{name:string}[]}[]}} schema engine table metadata
 * @returns {{ok:true, body:object, changes:{entitiesDropped:number, errorsReduced:number}} | {ok:false, reason:string}}
 */
function protect(body, question, schema) {
  const fail = reason => ({ ok: false, reason });
  if (!body || typeof body !== 'object') return fail('body_not_object');
  for (const k of ['tools', 'functions', 'tool_choice', 'function_call']) if (k in body && body[k] != null && !(Array.isArray(body[k]) && !body[k].length)) return fail('tools_not_allowed');
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length !== 2) return fail('messages_shape');
  if (!msgs[0] || msgs[0].role !== 'system' || typeof msgs[0].content !== 'string') return fail('system_message_shape');
  if (!msgs[1] || msgs[1].role !== 'user' || typeof msgs[1].content !== 'string') return fail('user_message_shape');
  if (!msgs[1].content.startsWith(MARKER)) return fail('user_marker_missing');
  let p;
  try { p = JSON.parse(msgs[1].content.slice(MARKER.length)); } catch (_) { return fail('payload_not_json'); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return fail('payload_not_object');
  if (p.question !== question) return fail('question_mismatch');
  const extra = Object.keys(p).filter(k => !ALLOWED_KEYS.includes(k));
  if (extra.length) return fail('payload_keys_not_allowed:' + extra.join(','));
  const shortStr = v => v === null || (typeof v === 'string' && v.length <= 64);
  if (p.anchor !== undefined && !shortStr(p.anchor)) return fail('anchor_shape');
  if (p.timezone !== undefined && !shortStr(p.timezone)) return fail('timezone_shape');
  if (p.period != null) {
    const per = p.period;
    if (typeof per !== 'object' || Array.isArray(per)) return fail('period_shape');
    for (const [k, v] of Object.entries(per)) if (k.length > 32 || !(v === null || typeof v === 'number' || (typeof v === 'string' && v.length <= 64))) return fail('period_shape');
  }
  // candidates: compact id/name/unit tuples only (buildIRMessages' shape); objects with arbitrary fields could carry data
  if (p.candidates != null) {
    const c = p.candidates;
    if (typeof c !== 'object' || Array.isArray(c)) return fail('candidates_shape');
    for (const k of Object.keys(c)) {
      if (!CANDIDATE_KEYS.includes(k) || !Array.isArray(c[k])) return fail('candidates_shape');
      const str = x => x === null || typeof x === 'string';
      for (const item of c[k]) if (!(str(item) || (Array.isArray(item) && item.length <= 8 && item.every(str)))) return fail('candidates_shape');
    }
  }
  const changes = { entitiesDropped: 0, errorsReduced: 0 };
  if (p.entities != null) {
    if (!Array.isArray(p.entities)) return fail('entities_shape');
    // P80's prompt builder produces exactly {dim:string, value:string}; anything else is refused, not mutated
    for (const e of p.entities) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return fail('entities_shape');
      if (Object.keys(e).some(k => k !== 'dim' && k !== 'value')) return fail('entities_shape');
      if (typeof e.dim !== 'string' || typeof e.value !== 'string') return fail('entities_shape');
    }
    const kept = p.entities.filter(e => question.includes(e.value));
    changes.entitiesDropped = p.entities.length - kept.length;
    p.entities = kept;
  }
  if (p.previous_errors != null) {
    if (!Array.isArray(p.previous_errors)) return fail('previous_errors_shape');
    const permitted = [...new Set(((schema && schema.tables) || []).flatMap(t => (t.columns || []).map(c => c.name)))];
    p.previous_errors = p.previous_errors.map(error => {
      const raw = typeof error === 'string' ? error : JSON.stringify(error);
      const names = [...new Set(permitted.filter(f => raw.includes(f)))];
      return '本机检查未通过：' + categoryOf(raw) + (names.length ? '；涉及已授权字段：' + names.join(', ') : '') + '。按原题、表列类型和登记算法修正；不从错误推测数据值。';
    });
    changes.errorsReduced = p.previous_errors.length;
  }
  const out = { ...body, messages: [msgs[0], { role: 'user', content: MARKER + JSON.stringify(p) }] };
  return { ok: true, body: out, changes };
}

module.exports = { protect, OutboundBlocked, MARKER, ALLOWED_KEYS };
