'use strict';
const num = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
function mapProviderUsage(u, finishReason) {
  const s = u && typeof u === 'object' ? u : {};
  if (s.usage_normalized) return Object.assign({},s,{finish_reason:finishReason||s.finish_reason||null});
  if (s.input_tokens != null && s.prompt_tokens == null && s.cache_read_input_tokens == null && s.cache_creation_input_tokens == null && !s.usage_normalized) return {input_tokens:num(s.input_tokens),output_tokens:num(s.output_tokens),total_tokens:num(s.total_tokens) ?? (s.output_tokens != null ? num(s.input_tokens)+num(s.output_tokens) : null),reasoning_tokens:num(s.reasoning_tokens),finish_reason:finishReason||s.finish_reason||null};
  const openai = s.prompt_tokens != null;
  const cache = num(openai ? s.prompt_tokens_details?.cached_tokens ?? s.prompt_cache_hit_tokens : s.cache_read_input_tokens);
  const write = num(s.cache_creation_input_tokens);
  const base = num(openai ? s.prompt_tokens : s.input_tokens);
  const input = openai ? base : base == null ? null : base + (cache || 0) + (write || 0);
  const output = num(s.output_tokens ?? s.completion_tokens);
  const total = num(s.total_tokens) ?? (input != null && output != null ? input + output : null);
  return { usage_normalized:true, raw_usage:s, input_tokens:input, output_tokens:output, total_tokens:total,
    uncached_input_tokens: openai ? (input != null && cache != null ? Math.max(0,input-cache) : null) : base,
    cache_read_tokens:cache, cache_write_tokens:write,
    reasoning_tokens:num(s.reasoning_tokens ?? s.output_tokens_details?.reasoning_tokens ?? s.completion_tokens_details?.reasoning_tokens),
    output_tokens_include_reasoning:true, finish_reason:finishReason||s.finish_reason||null };
}
function sumUsage(calls) {
  const us=calls.map(c=>mapProviderUsage(c.usage||c.usage_raw,c.finish_reason));
  const sum=k=>us.length===0 ? 0 : us.some(u=>u[k]==null) ? null : us.reduce((a,u)=>a+u[k],0);
  const out={};
  for (const k of ['input_tokens','output_tokens','total_tokens','uncached_input_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens']) out[k]=sum(k);
  return Object.assign(out,{calls:us.length,known_calls:us.filter(u=>u.total_tokens!=null).length,unknown_calls:us.filter(u=>u.total_tokens==null).length,
    known_total_tokens:us.reduce((a,u)=>a+(u.total_tokens||0),0)});
}
module.exports={mapProviderUsage,sumUsage};
