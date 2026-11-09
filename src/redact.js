'use strict';
// Secret redaction. Last line of defence on everything that leaves the engine (results, raw, events, files, CLI output).
const TOKEN_RES = [
  /\bBearer\s+[^\s"',;]+/gi,
  /\boc_sk_[A-Za-z0-9_\-.]+/g,
  /\bsk-[A-Za-z0-9_\-.]{4,}/g,
  /\b(?:authorization|x-api-key|api[_-]?key)["']?\s*[:=]\s*["']?[^\s"',;}]{6,}/gi,
];
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {string[]} secrets literal secret values (e.g. the api key) */
function makeRedactor(secrets = []) {
  const lits = [...new Set(secrets.filter(s => typeof s === 'string' && s.length >= 4))];
  const litRe = lits.length ? new RegExp(lits.map(esc).join('|'), 'g') : null;
  const str = (s) => {
    if (typeof s !== 'string' || s.length < 4) return s;
    let out = s;
    if (litRe) out = out.replace(litRe, '[REDACTED]');
    for (const re of TOKEN_RES) { re.lastIndex = 0; out = out.replace(re, (m) => /^(authorization|x-api-key|api)/i.test(m) ? m.replace(/[:=]\s*["']?[^\s"',;}]{6,}$/, ': [REDACTED]') : (/^Bearer/i.test(m) ? 'Bearer [REDACTED]' : '[REDACTED]')); }
    return out;
  };
  const deep = (v, depth = 0) => {
    if (typeof v === 'string') return str(v);
    if (depth > 60 || v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(x => deep(x, depth + 1));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const out = {};
    for (const k of Object.keys(v)) out[str(k)] = deep(v[k], depth + 1);
    return out;
  };
  return { str, deep };
}

module.exports = { makeRedactor };
