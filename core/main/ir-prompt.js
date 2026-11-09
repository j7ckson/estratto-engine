// ================= 问数计划的模型提示词（第三轮，App 与评测共用这一份）=================
// 为什么单独成文件：第二轮时评测程序自己拼了一份带规则说明的提示词，App 走的是另一份（只发整包 JSON），
// 两边不是同一条路；而且评测那份在「修一次」时没把上次哪里不对告诉模型。现在两边都从这里取。
//
// 省钱的做法：不变的部分（角色、字段说明、写法规则）放在最前面的 system 里，每题都一样 → 模型服务商按「前缀缓存」计价，
// 这一段第二题起按缓存价（约 1/50）；每题会变的部分（问题、候选、上次的错误）放在后面的 user 里，尽量短。
'use strict';

const IR_STATIC_SYSTEM = [
  '经营分析计划解析器：只输出一个JSON，不解释、不写答案数字或SQL。完整保留题目期间、条件、实体、排除、分组、比较、排名和口径。只用候选ID，未知不替代。',
  '字段（未用可省）：metric=指标ID或none；time_role=时间角色ID或none；period={kind:explicit|relative|none,start,end,label,grain}，显式日期YYYY-MM-DD且含首尾，相对期间给label。',
  'dimensions=[维度ID]：仅题面要求按/各/分别/哪些对象分组时填；全体合计不分组。entities=[{dim,value}]用具体对象的题面原词；negations同结构表示排除，全部/四个渠道等范围不是实体。',
  'comparison=none|previous_period|year_over_year；comparison_output=growth_rate或delta；显式基期comparison_base={start,end}。rank={top:N,direction:desc|asc,partition_by:[维度ID]}。grain=day|week|month|quarter|year。',
  '同一指标的同比/环比增长率由comparison_output=growth_rate计算，不再填formula或跨期ratio；差多少用delta。',
  'having={op,value,count_groups}先聚合再筛组；count_groups=true输出满足条件的组数。indicator={op,value}输出是否1/0。op=eq|ne|gt|gte|lt|lte。',
  'output_shape=scalar|table|series。合计/累计共多少是scalar且无grain；仅明确逐期累计序列设cumulative=true。单日/哪天用day。空值/空白不等于0，表达不了写unresolved。',
  'unresolved=[{slot,reason,options}]，reason=ambiguous|capability_gap|clarify|candidate_miss；候选未召回不是字段不存在。',
  'formula：ratio={kind:ratio,num:A,den:B,mul:1或100}（百分数100，倍数1）；分母求和用den_expr:{op:add,args:[A,B]}；跨期用num_window/den_window:{start,end}或num_period/den_period:same|previous_period|period_start|period_end；行条件用num_filter/den_filter:{metric,op,value}。',
  '总体占比={kind:share,base:X}；同维度两成员差={kind:diff,dim:维度ID,left:成员A,right:成员B}；派生={kind:derived,expr:{op:add|sub|mul|div,args:[指标ID]}}。括号公式按原定义，不当指标名。',
  'SKU/货号数量用去重计数；平均每SKU除以SKU去重数，不能除以行数；有条件的计数用num_filter。库存按盘点日或期末快照，不跨快照相加。previous_errors是本次修复约束，返回完整计划。'
].join('\n');

// Preserve the full contract for repairs; omit only unused operator documentation on first parse.
function rulesFor(payload){
  const p=payload||{},q=String(p.question||'');
  if(p.previous_errors?.length)return IR_STATIC_SYSTEM;
  const formula=/率|比例|占|百分|百分点|%|相当于|比值|之比|倍|[\/÷+*×]|平均|日均|每单|每件|客单|相差|差多少|多多少|少多少|变化|增长|增加|减少|同比|环比|ROAS|ROI|AOV|公式|利润|毛利|净利|加|减|乘|除|\b(?:ratio|rate|share|proportion|percent(?:age)?|margin|profit|average|mean|difference|growth|times)\b|\bper\s+(?:order|item|unit|sku|day)\b/i.test(q)||(p.candidates?.metrics||[]).some(m=>['ratio','derived'].includes(m.kind)&&(!m.name||String(q).toLowerCase().includes(String(m.name).replace(/[（(].*?[）)]/g,'').toLowerCase())||!(p.candidates.metrics||[]).some(x=>x.kind==='simple')));
  const threshold=/是否|够不够|有没有|有几|有多少|高于|低于|超过|未满|不足|等于|大于|小于|以上|以下|达标|达到|过万|为零|是零|零库存|断货|缺货|[<>≤≥]|\b(?:whether|if|condition|threshold|above|below|exceed|greater|less|more|under|over|zero)\b|\bat\s+(?:least|most)\b/i.test(q);
  const detail=/SKU|货号|款|库存|盘点|快照|平均|\b(?:stock|inventory|snapshot|average|mean)\b/i.test(q);
  return IR_STATIC_SYSTEM.split('\n').filter(line=>{
    if(line.startsWith('formula：')||line.startsWith('总体占比='))return formula;
    if(line.startsWith('having='))return threshold;
    if(line.startsWith('同一指标的同比'))return /同比|环比|增长|增速|变化率|\b(?:yoy|mom|growth|previous\s+period|year.over.year|month.over.month|change\s+rate)\b/i.test(q);
    if(line.startsWith('SKU/货号数量'))return detail;
    return true;
  }).join('\n');
}

/** 候选压成最短形状（只留 id / 名称 / 单位） */
function compactCandidates(c) {
  const cc = c || {};
  return {
    metrics: (cc.metrics || []).map(m => [m.id, m.name, m.unit || '']),
    dimensions: (cc.dimensions || []).map(d => [d.id, d.name]),
    time_roles: (cc.time_roles || []).map(r => [r.id, r.name+(r.dataset?' [所属表 '+r.dataset+']':'')]),
  };
}

/**
 * @param {object} payload main/ask.js 交给 resolveIR 的那一包（question/anchor/timezone/candidates/previous_errors）
 * @returns {{system:string, user:string}}
 */
function buildIRMessages(payload) {
  const p = payload || {};
  // 第三轮：兜底写 SQL 那一次走 sql-lane 的提示词（App 和评测共用这一处）
  if (p.lane === 'sql') {
    const out=require('./sql-lane').buildSqlMessages(p);
    // 本机诊断保留重复行数；真正出站只保留是否存在重复这一语义说明。
    out.system=out.system.replace(/这张表有 \d+ 行完全重复/g,'存在完全重复行');
    return out;
  }
  // 导入时起中文名（只发表名、列名、类型）
  if (p.lane === 'naming') return require('./auto-semantics').buildNamerMessages(p);
  const input = {
    anchor: p.anchor || null,
    timezone: p.timezone || 'Asia/Shanghai',
    candidates: compactCandidates(p.candidates),
    question: p.question,
  };
  // A6「乙」：全部指标 / 维度名称在固定说明里（缓存价），候选只给编号；候选里有目录外的（如派生临时指标）就照常带名称
  const selectedRules = rulesFor(p).split('\n');
  const commonRules = rulesFor({}).split('\n');
  const variableRules = selectedRules.filter(line => !commonRules.includes(line));
  let system = commonRules.join('\n');
  if (p.catalog && Array.isArray(p.catalog.metrics)) {
    const inCat = new Set([...(p.catalog.metrics || []), ...(p.catalog.dimensions || [])].map(x => x[0]));
    system += '\n本域全部指标 [id, 名称, 单位] 与维度 [id, 名称]（INPUT 的候选只给 id，名称查这里）：\n'
      + 'metrics=' + JSON.stringify(p.catalog.metrics) + '\ndimensions=' + JSON.stringify(p.catalog.dimensions || []);
    input.candidates = {
      metrics: input.candidates.metrics.map(m => inCat.has(m[0]) ? m[0] : m),
      dimensions: input.candidates.dimensions.map(d => inCat.has(d[0]) ? d[0] : d),
      time_roles: input.candidates.time_roles,
    };
  }
  // 题面相关规则后置，避免同一目录因算子不同失去前缀缓存。
  if (variableRules.length) system += '\n' + variableRules.join('\n');
  if (Array.isArray(p.previous_errors) && p.previous_errors.length) {
    input.previous_errors = p.previous_errors.slice(0, 4).map(e => String((e && (e.message || e.code)) || e).slice(0, 160));
  }
  return { system, user: 'INPUT（JSON）:\n' + JSON.stringify(input) };
}

module.exports = { buildIRMessages, IR_STATIC_SYSTEM, compactCandidates, rulesFor };
