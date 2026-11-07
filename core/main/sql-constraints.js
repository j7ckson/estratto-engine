'use strict';
// 校验本机完整目录里已精确识别、且在题面原样出现的对象没有被模型省掉。
// 不追加WHERE，不输出真实目录值，不把同义/向量候选提升为确定对象。
async function missingEntities(question,lookup,registry,check,run){
 if(!lookup?.resolve)return [];
 const q=String(question||''),norm=s=>String(s).toLowerCase().replace(/[\s_，,]/g,'');
 let matches=[];try{matches=lookup.resolve(q).matches||[];}catch(_){return [];}
 const candidates=matches.filter(m=>['exact','contains'].includes(m.how)&&String(m.value).length>=2&&q.includes(String(m.value))).filter(m=>{
  try{const d=registry.dim(m.dim);return d&&!d.unbound&&d.source;}catch(_){return false;}
 }).filter(m=>!matches.some(n=>String(n.value).length>String(m.value).length&&q.includes(String(n.value))&&String(n.value).includes(String(m.value))));
 // P78:题面用已登记的中文专名（亚马逊→Amazon）点名对象时同样是明确筛选；只认目录里唯一精确命中的英文取值。
 try{if(lookup.index){const hit=require('./value-match').explicitNominalAlias(q,{lookup,dimIds:[...lookup.index.keys()]});if(hit&&!candidates.some(m=>norm(m.value)===norm(hit.value))){const d=registry.dim(hit.dim);if(d&&!d.unbound&&d.source)candidates.push({dim:hit.dim,value:hit.value,how:'exact',alias_of:hit.literal});}}}catch(_){}
 const constants=new Set();
 // P78:SELECT 列表里直接写的常量只是展示标签（如 SELECT '个护' AS label），不算筛选；只认条件/表达式里的取值
 const walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(!x||typeof x!=='object')return;if(x.class==='CONSTANT'&&x.value?.type?.id==='VARCHAR'&&!x.value.is_null)constants.add(norm(x.value.value));for(const [k,v] of Object.entries(x)){if(k==='select_list'&&Array.isArray(v)){v.forEach(c=>{if(!(c&&c.class==='CONSTANT'))walk(c);});continue;}walk(v);}};walk(check.ast);
 const groups=new Map();for(const m of candidates){const key=norm(m.value);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(m);}
 const missing=[];Object.defineProperty(missing,'hints',{value:[],enumerable:false});for(const [key,group] of groups){const definition=explicitDefinition(q,group[0].value,registry);if(definition){if(hasDefinedPredicate(check,definition,registry))continue;missing.push('题面括号定义条件 '+definition.table+'.'+definition.field);continue;}if(constants.has(key))continue;let proved=false;for(const m of group){const d=registry.dim(m.dim);if(await impliesMember(check,d.source,m.value,registry,run)){proved=true;break;}}if(proved)continue;
  const sources=group.map(m=>registry.dim(m.dim).source),present=sources.filter(x=>check.tables.includes(x.table)),wanted=present.length?present:sources;
  for(const d of wanted){const field=d.table+'.'+d.field;if(!missing.includes(field)){missing.push(field);missing.hints.push(field+'（题面「'+(group[0].alias_of||group[0].value)+'」）');}}
 }

 return missing;
}
function explicitDefinition(question,value,registry){
 const escaped=String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),body=new RegExp(escaped+'\\s*[？?]?\\s*[（(]([^）)]{1,80})[）)]').exec(question)?.[1];if(!body)return null;
 const predicate=body.replace(/\s*(?:时|则)?\s*记\s*1\s*[,，]\s*否则(?:记)?\s*0\s*$/,'');
 const m=/^\s*(.+?)\s*(>=|<=|==|=|>|<|≥|≤|为|等于)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(predicate);if(!m)return null;
 if(/[=<>≥≤]|(?:为|等于)\s*-?\d/.test(m[1]))return null;
 const ids=require('./plan-ir').metricCandidates(registry,m[1]).candidates||[],fields=new Map();
 for(const id of ids){const x=registry.metric(id);if(x.kind==='simple'&&x.field&&(x.dataset||x.boundTo))fields.set((x.dataset||x.boundTo)+'.'+x.field,{table:x.dataset||x.boundTo,field:x.field,agg:x.agg});}
 return fields.size===1?{...[...fields.values()][0],op:m[2].replace('≥','>=').replace('≤','<=').replace('==','=').replace(/为|等于/,'='),value:Number(m[3])}:null;
}
function hasDefinedPredicate(check,definition,registry){
 const ops={'=':'COMPARE_EQUAL','>':'COMPARE_GREATERTHAN','<':'COMPARE_LESSTHAN','>=':'COMPARE_GREATERTHANOREQUALTO','<=':'COMPARE_LESSTHANOREQUALTO'},aliases=new Map();
 const walk=(x,fn)=>{if(Array.isArray(x))return x.forEach(v=>walk(v,fn));if(!x||typeof x!=='object')return;fn(x);Object.values(x).forEach(v=>walk(v,fn));};walk(check.ast,n=>{if(n.type==='BASE_TABLE'){aliases.set(n.table_name,n.table_name);if(n.alias)aliases.set(n.alias,n.table_name);}});
 // P78:列经 CTE 透传(FROM s 而 s 是 SELECT … FROM snap_inventory)时，按 CTE 里的真实来源表认
 const cteBase=new Map();walk(check.ast,n=>{for(const c of (n.cte_map?.map||[])){const bases=[];walk(c.value,m=>{if(m.type==='BASE_TABLE')bases.push(m.table_name);});cteBase.set(String(c.key).toLowerCase(),bases);}});
 const projections=new Map();walk(check.ast,n=>{if(n.type==='SELECT_NODE')for(const expr of n.select_list||[])if(expr.alias){const key=String(expr.alias).toLowerCase();if(!projections.has(key))projections.set(key,[]);projections.get(key).push(expr);}});
 const strip=x=>x?.class==='CAST'?strip(x.child):x,field=(x,seen=new Set())=>{x=strip(x);if(x?.class==='FUNCTION'&&String(x.function_name).toLowerCase()===definition.agg&&(x.children||[]).length===1)return field(x.children[0],seen);if(x?.class!=='COLUMN_REF')return false;const ns=x.column_names||[],name=ns.at(-1);if(name===definition.field){if(ns.length>1&&aliases.has(ns.at(-2))&&(aliases.get(ns.at(-2))===definition.table||(cteBase.get(String(aliases.get(ns.at(-2))).toLowerCase())||[]).includes(definition.table)))return true;const tables=registry.tables.filter(t=>check.tables.includes(t.name)&&t.columns.some(c=>c.name===definition.field));if(ns.length===1&&tables.length===1&&tables[0].name===definition.table)return true;}const key=String(name).toLowerCase(),ps=projections.get(key)||[];if(seen.has(key)||!ps.length)return false;const next=new Set([...seen,key]);return ps.every(p=>field(p,next));},number=x=>{x=strip(x);return x?.class==='CONSTANT'&&!x.value?.is_null&&Number.isFinite(Number(x.value?.value))?Number(x.value.value):null;};
 let found=false;const visit=(x,predicate=false)=>{if(Array.isArray(x))return x.forEach(v=>visit(v,predicate));if(!x||typeof x!=='object')return;const scope=predicate||x.class==='CASE'||x.class==='FUNCTION'&&/^(?:sum|avg|count|count_if|countif|bool_and|bool_or)$/i.test(x.function_name||'');if(scope&&x.class==='COMPARISON'&&x.type===ops[definition.op]&&field(x.left)&&number(x.right)===definition.value)found=true;for(const [key,v]of Object.entries(x))visit(v,scope||['where_clause','having','when_expr'].includes(key));};visit(check.ast);return found;
}
function definedIndicatorCovers(question,value,plan,registry){
 if(!registry||!plan.indicator)return false;const definition=explicitDefinition(question,value,registry);if(!definition||({eq:'=',ne:'!=',gt:'>',gte:'>=',lt:'<',lte:'<='})[plan.indicator.op]!==definition.op||Number(plan.indicator.value)!==definition.value)return false;
 return (plan.metric_ids||[]).length===1&&(plan.metric_ids||[]).some(id=>{try{const m=registry.metric(id);return m.kind==='simple'&&(m.dataset||m.boundTo)===definition.table&&m.field===definition.field&&m.agg===definition.agg;}catch(_){return false;}});
}

async function impliesMember(check,source,value,registry,run){
 if(typeof run!=='function')return false;
 const clone=x=>JSON.parse(JSON.stringify(x)),walk=(x,f)=>{if(Array.isArray(x))return x.forEach(v=>walk(v,f));if(!x||typeof x!=='object')return;f(x);Object.values(x).forEach(v=>walk(v,f));};
 const aliases=new Map();walk(check.ast,n=>{if(n.type==='BASE_TABLE'){aliases.set(n.table_name,n.table_name);if(n.alias)aliases.set(n.alias,n.table_name);}});
 const tableOf=n=>{const ns=n.column_names||[];if(ns.length>1)return aliases.get(ns.at(-2));const ts=(registry.tables||[]).filter(t=>check.tables.includes(t.name)&&t.columns.some(c=>c.name===ns[0]));return ts.length===1?ts[0].name:null;};
 const pick=n=>{if(!n)return null;if(n.class==='CONJUNCTION'){const cs=(n.children||[]).map(pick);if(n.type==='CONJUNCTION_OR'&&cs.some(x=>!x))return null;const ok=cs.filter(Boolean);return ok.length>1?{...clone(n),children:ok}:ok[0]||null;}
  let refs=[],unsafe=false;walk(n,x=>{if(x.class==='COLUMN_REF')refs.push(x);if(x.class==='SUBQUERY'||x.class==='WINDOW')unsafe=true;});if(unsafe||!refs.length||refs.some(r=>tableOf(r)!==source.table))return null;const out=clone(n);walk(out,x=>{if(x.class==='COLUMN_REF')x.column_names=[x.column_names.at(-1)];});return out;};
 let node=check.ast?.node||check.ast;
 // 单个CTE的直通投影/汇总：约束位于CTE内，不能只检查外层WHERE。
 // 不跨外连接、集合运算、嵌套CTE或标量子查询推断所属关系。
 const ctes=node?.cte_map?.map||[],from=node?.from_table;
 // P78:外层把这个 CTE 作为 INNER JOIN 的一侧(其余都是 INNER 连接)时，CTE 内对来源表的筛选同样限定了结果行。
 const innerJoinCte=(()=>{if(ctes.length!==1||from?.type!=='JOIN')return false;let ok=true,hit=false;const visit=x=>{if(!x||!ok)return;if(x.type==='JOIN'){if(!['INNER','SEMI'].includes(x.join_type))ok=false;visit(x.left);visit(x.right);}else if(x.type==='BASE_TABLE'){if(x.table_name===ctes[0].key)hit=true;}else ok=false;};visit(from);return ok&&hit;})();
 if((from?.type==='BASE_TABLE'&&ctes.length===1&&ctes[0].key===from.table_name&&from.table_name!==source.table)||innerJoinCte){
  const inner=ctes[0].value?.query?.node;let unsafe=false,refs=0;
  const outer={...node,cte_map:null};walk(outer,x=>{if(x.class==='SUBQUERY')unsafe=true;});
  if(inner?.type!=='SELECT_NODE'||inner.cte_map?.map?.length)unsafe=true;
  walk(inner,x=>{if(x.class==='SUBQUERY'||x.type==='SET_OPERATION_NODE')unsafe=true;if(x.type==='JOIN'&&!['INNER','SEMI'].includes(x.join_type))unsafe=true;if(x.type==='BASE_TABLE'&&x.table_name===source.table)refs++;});
  if(!unsafe&&refs===1)node=inner;
 }
 const predicate=pick(node.where_clause);if(!predicate)return false;
 const qi=s=>'"'+String(s).replaceAll('"','""')+'"',sq=s=>"'"+String(s).replaceAll("'","''")+"'";
 try{
  const query='SELECT COUNT(*) AS n,COUNT(*) FILTER(WHERE CAST('+qi(source.field)+' AS VARCHAR) IS DISTINCT FROM '+sq(value)+') AS bad FROM '+qi(source.table);
  const a=JSON.parse((await run('SELECT json_serialize_sql('+sq(query)+') AS j'))[0].j);a.statements[0].node.where_clause=predicate;walk(a,n=>{if(n.query_location>Number.MAX_SAFE_INTEGER)n.query_location=0;});
  const sql=(await run('SELECT json_deserialize_sql('+sq(JSON.stringify(a))+') AS s'))[0].s;const row=(await run(sql))[0];return Number(row.n)>0&&Number(row.bad)===0;
 }catch(_){return false;}
}
function temporalStateScopeGap(question,check,context){
 const q=String(question||'');if(!/断货|缺货|状态|转为|变成|恢复/.test(q)||!/到|变|恢复|已经|这期|现在/.test(q))return false;
 const fields=new Set((context.tables||[]).flatMap(t=>t.columns||[]).filter(c=>/(?:^|_)(?:state|status)(?:_|$)|状态/i.test(c.name)).map(c=>c.name));if(!fields.size)return false;
 const walk=(x,fn)=>{if(Array.isArray(x))return x.forEach(v=>walk(v,fn));if(!x||typeof x!=='object')return;fn(x);Object.values(x).forEach(v=>walk(v,fn));};
 const globalState=n=>{if(!n)return false;if(n.class==='CONJUNCTION')return n.type==='CONJUNCTION_AND'&&(n.children||[]).some(globalState);if(n.class!=='COMPARISON')return false;let found=false;walk(n,x=>{if(x.class==='COLUMN_REF'&&fields.has(x.column_names?.at(-1)))found=true;});return found;};
 let gap=false;walk(check.ast,n=>{if(n.type!=='SELECT_NODE'||!globalState(n.where_clause))return;const dates=new Set();let cases=0;walk(n.select_list,x=>{if(x.class==='CASE')cases++;if(x.class==='CONSTANT'&&typeof x.value?.value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.value.value))dates.add(x.value.value);});if(cases>=2&&dates.size>=2)gap=true;});return gap;
}
// 展示语义来自SQL日期表达式及CTE列传递，不根据结果值或题库猜年份/月。
function temporalLabelKinds(check){
 const root=check.ast?.node||check.ast,active=new Set();
 const analyze=(node,inherited=new Map(),depth=0)=>{
  if(!node||node.type!=='SELECT_NODE'||depth>12||active.has(node))return new Map();active.add(node);
  const ctes=new Map(inherited);for(const x of node.cte_map?.map||[])ctes.set(x.key,x.value?.query?.node);
  const source=n=>{if(!n)return [];if(n.type==='JOIN')return [...source(n.left),...source(n.right)];if(n.type==='BASE_TABLE')return [{name:n.alias||n.table_name,columns:ctes.has(n.table_name)?analyze(ctes.get(n.table_name),ctes,depth+1):new Map()}];if(n.type==='SUBQUERY')return [{name:n.alias,columns:analyze(n.subquery?.node,ctes,depth+1)}];return [];};
  const sources=source(node.from_table),infer=x=>{
   if(!x)return null;if(x.class==='CAST')return infer(x.child);
   if(x.class==='FUNCTION'){
    const fn=String(x.function_name||'').toLowerCase(),cs=x.children||[],strs=cs.filter(v=>v.class==='CONSTANT').map(v=>v.value?.value);
    if(fn==='strftime'){if(strs.includes('%Y'))return 'year';if(strs.includes('%m'))return 'month';}
    if(fn==='year'||fn==='month')return fn;
    if(['date_part','datepart','extract'].includes(fn)){if(strs.includes('year'))return 'year';if(strs.includes('month'))return 'month';}
   }
   if(x.class==='COLUMN_REF'){const ns=x.column_names||[],list=ns.length>1?sources.filter(s=>s.name===ns.at(-2)):sources,kinds=new Set(list.map(s=>s.columns.get(ns.at(-1))).filter(Boolean));return kinds.size===1?[...kinds][0]:null;}return null;
  };
  const out=new Map();for(const x of node.select_list||[]){if(x.class==='STAR'){for(const s of sources)for(const [k,v]of s.columns)out.set(k,v);continue;}const name=x.alias||(x.class==='COLUMN_REF'?x.column_names?.at(-1):null),kind=infer(x);if(name&&kind)out.set(String(name),kind);}active.delete(node);return out;
 };return analyze(root);
}
function rankIntents(question){
 const q=String(question||''),raw=/未(?:经|做|进行)?(?:任何)?(?:四舍五入|舍入)|不(?:做|进行)?(?:任何)?(?:四舍五入|舍入)|\bunrounded\b|without\s+rounding|before\s+rounding/i.test(q);
 const affirmative=q.replace(/未(?:经|做|进行)?(?:任何)?(?:四舍五入|舍入)|不(?:做|进行)?(?:任何)?(?:四舍五入|舍入)|\bunrounded\b/gi,'');
 const rounded=/先[^。！？.!?]{0,45}(?:舍入|四舍五入)[^。！？.!?]{0,35}(?:再|后)[^。！？.!?]{0,12}(?:比较|排序|排名)|rank\s+using\s+(?:the\s+)?rounded\s+metric|(?:rank|sort)[^.!?]{0,30}(?:by|using)[^.!?]{0,12}\brounded\b/i.test(affirmative);
 return {raw,rounded};
}
function rankOrderGap(question,check){
 const q=String(question||'');if(!/最高的?[一二三四五六七八九十\d]+|最多的?[一二三四五六七八九十\d]+|最大.{0,3}前|前[一二三四五六七八九十\d]+|top\s*\d/i.test(q)||/对应|时的|所在|关联|最低|最小|最少/.test(q)||check.windows)return false;
 const n=check.ast?.node||check.ast,mods=n?.modifiers||[];if(!mods.some(m=>String(m.type).includes('LIMIT')&&m.limit))return false;
 const list=n.select_list||[],vi=list.findIndex(x=>String(x.alias).toLowerCase()==='v');if(vi<0||list[vi].class==='CONSTANT')return false;
 const order=mods.find(m=>String(m.type).includes('ORDER'))?.orders?.[0];if(!order)return true;const x=order.expression,value=list[vi];
 const {raw:rawIntent,rounded:roundedIntent}=rankIntents(q);
 if(rawIntent&&roundedIntent)return true;
 const scopeName=n.from_table?.alias||n.from_table?.table_name,singleSource=['BASE_TABLE','SUBQUERY'].includes(n.from_table?.type);
 const scrub=v=>{if(Array.isArray(v))return v.map(scrub);if(!v||typeof v!=='object')return v;const out=Object.fromEntries(Object.entries(v).filter(([k])=>!['alias','query_location'].includes(k)).map(([k,y])=>[k,scrub(y)]));if(singleSource&&out.class==='COLUMN_REF'&&out.column_names?.length===2&&String(out.column_names[0]).toLowerCase()===String(scopeName||'').toLowerCase())out.column_names=out.column_names.slice(1);return out;};
 const same=(a,b)=>JSON.stringify(scrub(a))===JSON.stringify(scrub(b));
 const presentFn=value?.class==='FUNCTION'&&['round','trunc'].includes(String(value.function_name).toLowerCase()),presentCast=value?.class==='CAST'&&!!value.child,presented=presentFn||presentCast,raw=presentFn?value.children?.[0]:presentCast?value.child:value;
 const integer=(expr,scope,seen=new Set())=>{if(!expr||seen.has(expr))return false;const next=new Set([...seen,expr]);if(expr.class==='FUNCTION'&&['count','count_star'].includes(String(expr.function_name).toLowerCase()))return true;if(expr.class!=='COLUMN_REF')return false;const key=expr.column_names?.at(-1),projection=(scope.select_list||[]).find(p=>p.alias===key);if(projection&&projection!==expr)return integer(projection,scope,next);const from=scope.from_table;const inner=from?.type==='SUBQUERY'?from.subquery?.node:from?.type==='BASE_TABLE'&&!from.schema_name&&!from.catalog_name?(scope.cte_map?.map||[]).find(c=>c.key===from.table_name)?.value?.query?.node:null;if(!inner||inner.type!=='SELECT_NODE')return false;const source=(inner.select_list||[]).find(p=>p.alias===key||!p.alias&&p.class==='COLUMN_REF'&&p.column_names?.at(-1)===key);return !!source&&integer(source,inner,next);};
 const precision=value.children?.[1],integral=integer(raw,n)&&(!precision||precision.class==='CONSTANT'&&Number.isInteger(precision.value?.value)&&precision.value.value>=0),alias=x?.class==='COLUMN_REF'&&x.column_names?.length===1&&String(x.column_names[0]).toLowerCase()==='v',ordinal=x?.class==='CONSTANT'&&Number(x.value?.value)===vi+1;
 let numeric=alias||ordinal||same(x,value);
 if(rawIntent&&presented&&!integral)numeric=!alias&&!ordinal&&same(x,raw);
 else if(!roundedIntent&&presented)numeric=numeric||same(x,raw);
 // P78:展示包装可能藏在 CASE 等表达式里(如 CASE WHEN u=0 THEN NULL ELSE ROUND(s/u,2) END)
 {
  const isPres=e=>e&&(e.class==='FUNCTION'&&['round','trunc'].includes(String(e.function_name).toLowerCase())||e.class==='CAST');
  const strip=e=>{if(Array.isArray(e))return e.map(strip);if(!e||typeof e!=='object')return e;if(e.class==='FUNCTION'&&['round','trunc'].includes(String(e.function_name).toLowerCase()))return strip(e.children?.[0]);if(e.class==='CAST'&&e.child)return strip(e.child);return Object.fromEntries(Object.entries(e).map(([k,y])=>[k,strip(y)]));};
  const deep=e=>{let h=false;const w=y=>{if(Array.isArray(y))return y.forEach(w);if(!y||typeof y!=='object')return;if(isPres(y))h=true;Object.values(y).forEach(w);};w(e);return h;};
  const aliasRef=x?.class==='COLUMN_REF'&&x.column_names?.length===1&&list.some(c=>String(c.alias||'').toLowerCase()===String(x.column_names[0]).toLowerCase());
  const rawMatch=!aliasRef&&!ordinal&&!deep(x)&&same(x,strip(value));
  if(rawIntent&&!presented&&deep(value))numeric=rawMatch;      // 要按原值排:只有「去掉展示包装的同一表达式」才算对
  else if(!numeric&&!roundedIntent&&rawMatch)numeric=true;
 }
 return !numeric||!/DESC/.test(String(order.type));
}
// 只改明确要求原值排名却引用展示别名的排序键；其他排序错误仍由原检查拒绝。
function rawRankOrderExpression(question,check){
 const intent=rankIntents(question);if(!intent.raw||intent.rounded||!rankOrderGap(question,check))return null;
 const n=check.ast?.node||check.ast,list=n?.select_list||[],vi=list.findIndex(x=>String(x.alias).toLowerCase()==='v'),value=list[vi];
 const inner=value?.class==='FUNCTION'&&['round','trunc'].includes(String(value.function_name).toLowerCase())?value.children?.[0]:value?.class==='CAST'?value.child:null;if(!inner)return null;
 const order=(n.modifiers||[]).find(m=>String(m.type).includes('ORDER'))?.orders?.[0],x=order?.expression;
 if(!/DESC/.test(String(order?.type)))return null;
 if(x?.class==='COLUMN_REF'&&x.column_names?.length===1&&String(x.column_names[0]).toLowerCase()==='v'||x?.class==='CONSTANT'&&Number(x.value?.value)===vi+1)return inner;
 return null;
}
module.exports={missingEntities,temporalStateScopeGap,temporalLabelKinds,rankOrderGap};
module.exports.rawRankOrderExpression=rawRankOrderExpression;

// 库存的历史极值与最新快照是不同问题；不能用MAX日期替代MAX数量。
function snapshotExtremumGap(question,check,context){
 const q=String(question||'');if(!/(?:快照|历史|各期|三期|多期|每期)/.test(q)||!/(?:最多|最少|最大|最小|最高|最低)/.test(q)||/最新|最近一次|最晚|截至/.test(q))return false;
 if(!(context.metrics||[]).some(m=>m.additivity==='semiAdditive'&&check.tables.includes(m.dataset))&&!(context.tables||[]).some(t=>check.tables.includes(t.name)&&t.columns.some(c=>/snapshot.*date|快照日期/i.test(c.name))))return false;
 const dates=new Set((context.roles||[]).map(r=>r.col||r.field).filter(Boolean));for(const t of context.tables||[])for(const c of t.columns||[])if(c.type==='date'||/snapshot.*date|快照日期/i.test(c.name))dates.add(c.name);
 let gap=false;const walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(!x||typeof x!=='object')return;if(x.class==='SUBQUERY'){const scan=n=>{if(Array.isArray(n))return n.forEach(scan);if(!n||typeof n!=='object')return;if(n.class==='FUNCTION'&&/^(max|min)$/i.test(n.function_name||'')&&(n.children||[]).some(c=>c.class==='COLUMN_REF'&&dates.has(c.column_names?.at(-1))))gap=true;Object.values(n).forEach(scan);};scan(x);}Object.values(x).forEach(walk);};walk(check.ast);return gap;
}
module.exports.snapshotExtremumGap=snapshotExtremumGap;

function projectedColumnNames(check){
 const root=check.ast?.node||check.ast,links=new Map(),walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(!x||typeof x!=='object')return;if(x.type==='SELECT_NODE')for(const e of x.select_list||[]){let v=e;while(v?.class==='CAST')v=v.child;if(e.alias&&v?.class==='COLUMN_REF'){const k=String(e.alias).toLowerCase();if(!links.has(k))links.set(k,new Set());links.get(k).add(v.column_names?.at(-1));}}Object.values(x).forEach(walk);};walk(root);
 const origin=(name,seen=new Set())=>{if(!name)return null;const k=String(name).toLowerCase();if(seen.has(k))return null;seen.add(k);const next=links.get(k);if(next?.size>1)return null;if(next?.size===1){const value=[...next][0];return String(value).toLowerCase()===k?name:origin(value,seen);}return name;};
 const columns=x=>{if(!x)return [];if(x.class==='COLUMN_REF')return [origin(x.column_names?.at(-1))];if(x.class==='CAST')return columns(x.child);return (x.children||[]).flatMap(columns);};
 return [...new Set((root?.select_list||[]).filter(x=>String(x.alias||'').toLowerCase()!=='v').flatMap(columns).filter(Boolean))];
}
function businessLabelGap(question,check,context){
 const q=String(question||'');if(!/编号|号码|单号/.test(q)||/内部|Identifier|\bID\b/i.test(q))return [];
 const labels=projectedColumnNames(check);if(!labels.length)return [];
 const expected=[];
 for(const name of labels){if(requiredRoleMappings(q,context).some(r=>r.subjectField===name))continue;const m=/^(.+)_Identifier$/i.exec(name||'');if(!m)continue;for(const t of context.tables||[]){const fields=new Set(t.columns.map(c=>c.name));if(!fields.has(name))continue;for(const c of t.columns){if(!new RegExp('^(?:Company_)?'+m[1]+'_Number$','i').test(c.name))continue;const connected=check.tables.includes(t.name)||(context.rels||[]).some(rel=>[rel.left,rel.right].includes(t.name)&&[rel.left,rel.right].some(x=>check.tables.includes(x))&&rel.pairs.some(pair=>pair.includes(name)));if(connected&&!check.columns.some(x=>x.col===c.name))expected.push(t.name+'.'+c.name);}}}
 return [...new Set(expected)];
}
module.exports.businessLabelGap=businessLabelGap;
function personNameLabelGap(question,check,context){
 const q=String(question||'');if(!/哪[两几一二三四五六七八九十\d]*(?:个|位)?人|哪[两几一二三四五六七八九十\d]+位|谁|姓名|人名|which people|which persons?|who\b/i.test(q)||/(?:人员|员工|person|employee).{0,6}(?:编号|id)|内部.?id|person_id/i.test(q))return [];
 const ids=projectedColumnNames(check).filter(x=>/^(?:person|employee|staff|user|customer|agent)[_ ]?(?:id|identifier)$/i.test(x));if(!ids.length)return [];
 const expected=[];for(const t of context.tables||[])for(const col of t.columns||[]){
  const label=context.colNames?.[t.name+'.'+col.name]?.zh||'';
  if(!/^(?:name|full_name|person_name|employee_name|staff_name|姓名|名字)$/i.test(col.name)&&!/姓名|人员名称|员工姓名/.test(label))continue;
  if((context.rels||[]).some(r=>[r.left,r.right].includes(t.name)&&[r.left,r.right].some(x=>check.tables.includes(x))&&r.pairs.some(p=>p.some(x=>ids.some(id=>String(x).toLowerCase()===id.toLowerCase())))))expected.push(t.name+'.'+col.name);
 }
 return [...new Set(expected)];
}
module.exports.personNameLabelGap=personNameLabelGap;
function dateDifferenceRoles(question,context){
 const q=String(question||''),m=/(?:从|由)\s*([^，。；]{1,12}?)\s*(?:到|至)\s*([^，。；]{1,12}?)(?:平均|需要|相隔|间隔|耗时|历时|用时|要)/.exec(q);if(!m||!/天|日|多久/.test(q.slice(m.index+m[0].length))||/工作日|营业日|小时|分钟|business days|working days/i.test(q))return null;
 const roles=m.slice(1).map(x=>x.trim()),fields=roles.map(role=>(context.tables||[]).flatMap(t=>(t.columns||[]).filter(c=>{const n=context.colNames?.[t.name+'.'+c.name];const text=[c.name,n?.zh,...n?.aliases||[]].join(' ');return /date|time|日期|时间/i.test(c.type+' '+text)&&text.includes(role);}).map(c=>t.name+'.'+c.name)));
 return fields.every(xs=>xs.length)&&fields[0].some(a=>fields[1].some(b=>a!==b))?{roles,fields}:null;
}
module.exports.dateDifferenceRoles=dateDifferenceRoles;
function roleIsSubject(question,name){
 const word=String(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp('(?:按|每[个位名]|各|多少|几位|几名|by\\s+|each\\s+|per\\s+|number of\\s+)[^，。；,]{0,5}'+word+'|'+word+'[^，。；,]{0,4}(?:编号|姓名|名下|人数|\\bid\\b|\\bname\\b)','i').test(String(question||''));
}
function unconfirmedRole(question,context,registry,lookup){
 const q=String(question||''),types=[{re:/投保人|policyholder/i,names:['投保人','policyholder','policy_holder']},{re:/被保险人|insured person/i,names:['被保险人','insured','insured_person']},{re:/保险代理|代理人|代理|insurance agent/i,names:['保险代理','代理人','agent','insurance_agent']}],role=types.find(x=>x.re.test(q));if(!role)return null;
 if(!roleIsSubject(q,q.match(role.re)[0]))return null;
 const norm=s=>String(s).toLowerCase().replace(/[\s_]/g,'');
 if((context.tables||[]).some(t=>role.names.some(n=>norm(t.name)===norm(n)||norm(context.tableNames?.[t.name])===norm(n))))return null;
 for(const dim of registry.semantic.dims.values()){
  if(dim.unbound||!dim.source||!/(?:party|agreement).*role.*(?:code|type)/i.test(dim.source.field)||!(context.tables||[]).some(t=>t.name===dim.source.table&&t.columns.some(c=>c.name===dim.source.field)))continue;
  const values=lookup?.index?.get(String(dim.id).replace(/^d:/,''));if(!values||values.size<2)continue;
  const mappings=dim.map||dim.mapping||(dim.valueAliasSource?.confirmed?dim.valueAliases:null)||{};
  if(role.names.some(n=>JSON.stringify(mappings).toLowerCase().includes(n.toLowerCase())))continue;
  const explicit=[...values.values()].some(x=>{const v=String(x.value);if(role.names.some(n=>norm(v)===norm(n)))return true;const escaped=v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return /^[A-Za-z0-9_]+$/.test(v)?new RegExp('(?:^|[^A-Za-z0-9_])'+escaped+'(?=$|[^A-Za-z0-9_])','i').test(q):q.includes(v);});
  if(explicit)continue;
  return {role:q.match(role.re)[0],field:dim.source.table+'.'+dim.source.field,reason:'multiple_opaque_role_codes_without_declared_mapping'};
 }
 return null;
}
module.exports.unconfirmedRole=unconfirmedRole;
// 只有已经登记来源的语义字典才是角色条件；不从查询取值或标准答案反推含义。
function requiredRoleMappings(question,context){
 const q=String(question||''),out=[];
 for(const d of context.dims||[]){
  const t=(context.tables||[]).find(t=>t.name===d.table);if(!d.valueAliasSource?.confirmed||!t?.columns.some(c=>c.name===d.field))continue;
  for(const [value,names]of Object.entries(d.valueAliases||{})){
   if(!Array.isArray(names))continue;
   const name=names.find(n=>typeof n==='string'&&n.length>=2&&(/[\u3400-\u9fff]/.test(n)?q.includes(n):new RegExp('(?:^|[^A-Za-z0-9])'+n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^A-Za-z0-9])','i').test(q)));
   if(name&&roleIsSubject(q,name))out.push({name,table:d.table,field:d.field,value,subjectField:t.columns.some(c=>c.name===d.subjectField)?d.subjectField:null});
  }
 }
 return out;
}
function roleMappingGap(question,check,context){
 const labels=projectedColumnNames(check),q=String(question||'');
 return requiredRoleMappings(q,context).filter(r=>!check.literals.some(l=>l.table===r.table&&l.col===r.field&&l.value===r.value)||(r.subjectField&&q.includes(r.name)&&new RegExp(r.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'.{0,3}编号').test(q)&&!labels.includes(r.subjectField))).map(r=>r.table+'.'+r.field+'='+JSON.stringify(r.value)+(r.subjectField?'；角色编号='+r.table+'.'+r.subjectField:''));
}
module.exports.requiredRoleMappings=requiredRoleMappings;module.exports.roleMappingGap=roleMappingGap;
function requiredSubtypes(question,context){
 const q=String(question||'');return (context.subtypes||[]).filter(s=>s.zh&&String(s.zh).length>=2&&q.includes(s.zh)).filter(s=>{
  const parent=String(context.tableNames?.[s.of]||'').split('；').at(-1);return !(parent&&q.includes(parent)&&/全部|所有|全体/.test(q)&&new RegExp('(?:含|包含|包括)[^，。；]{0,8}'+s.zh.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).test(q));
 });
}
module.exports.requiredSubtypes=requiredSubtypes;
function missingSubtypeMarkers(question,check,context){
 return requiredSubtypes(question,context).filter(s=>check.tables.includes(s.of)&&!check.tables.includes(s.table)).map(s=>s.table+'.'+s.key+' = '+s.of+'.'+s.of_key);
}
module.exports.missingSubtypeMarkers=missingSubtypeMarkers;
function subtypeAmountNeedsSql(question,context,registry){
 const q=String(question||''),subtypes=requiredSubtypes(q,context);
 if(!subtypes.length||!/金额|收入|支付|[多少几]元|合计|总额|平均/.test(q)||/记录|条数|数量|个数|人数|几条|多少条|几个|多少个|多少人/.test(q))return false;
 return subtypes.some(s=>![...registry.semantic.metrics.values()].some(m=>{
  if(m.unbound||m.kind==='simple'&&['count','dcount'].includes(m.agg))return false;
  const named=[m.name,...m.aliases||[]].some(name=>name&&String(name).includes(s.zh)&&q.toLowerCase().includes(String(name).toLowerCase()));
  return named&&(m.confirmed||(m.dataset||m.boundTo)&&![s.of,s.table].includes(m.dataset||m.boundTo));
 }));
}
module.exports.subtypeAmountNeedsSql=subtypeAmountNeedsSql;

function rowAverageRatioGap(question,check){
 const q=String(question||'');if(!/平均(?:一|每)\s*(?:件|个|单|次)|每(?:件|单)[^，。？?]{0,12}(?:平均|多少钱)|均价/.test(q)||/逐行|每行|各行|不加权|简单平均|行均/.test(q))return false;
 let gap=false;const walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(!x||typeof x!=='object')return;if(x.class==='FUNCTION'&&String(x.function_name).toLowerCase()==='avg'){const div=n=>{if(Array.isArray(n))return n.forEach(div);if(!n||typeof n!=='object')return;if(n.class==='FUNCTION'&&['/','divide'].includes(String(n.function_name).toLowerCase()))gap=true;Object.values(n).forEach(div);};div(x.children);}Object.values(x).forEach(walk);};walk(check.ast);return gap;
}
module.exports.rowAverageRatioGap=rowAverageRatioGap;

function rawRecordCountGap(question,check){
 const q=String(question||'');if(!/(?:记录|明细|行)[^，。？?]{0,12}(?:共|有|多少|条|数)|(?:共|有|多少)[^，。？?]{0,12}(?:记录|明细|行)/.test(q)||/按|分组|各|每天|每月|去重|不同|唯一|distinct|同一/.test(q))return false;
 let gap=false;const walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(!x||typeof x!=='object')return;if(x.type==='SELECT_NODE'&&((x.group_expressions||[]).length||x.having))gap=true;Object.values(x).forEach(walk);};walk(check.ast);return gap;
}
module.exports.rawRecordCountGap=rawRecordCountGap;

module.exports.explicitDefinition=explicitDefinition;module.exports.definedIndicatorCovers=definedIndicatorCovers;

// 明确要求结果用小数表达，与“源列按fraction存储”是两件事。
function decimalRatioOutput(question){
 const q=String(question||'');
 if(!/率|比例|比值|份额|ratio|rate|share|proportion|fraction|percent/i.test(q))return false;
 if(!/(?:以|用)小数(?:表示|回答)|(?:输出|返回)(?:为)?小数|as\s+(?:a\s+)?decimal|decimal\s+(?:ratio|form)/i.test(q))return false;
 const notPct=/不是百分(?:数|比)|非百分(?:数|比)|not\s+(?:a\s+)?percentage/i.test(q);
 const sourceDescription=/(?:原|源)(?:列|字段|数据).{0,12}小数|小数.{0,5}(?:存储|保存)|(?:stored|source\s+column).{0,15}(?:decimal|fraction)/i.test(q);
 const percentOutput=/(?:结果|答案|输出|展示|显示|返回).{0,8}百分(?:数|比)|(?:以|按|用)百分(?:数|比)(?:表示|回答|展示|显示)/.test(q);
 const explicitOutput=/(?:结果|答案|比值|比例).{0,8}(?:用|以)小数(?:表示|回答)|(?:输出|返回)(?:为)?小数|(?:return|output|answer).{0,40}as\s+(?:a\s+)?decimal/i.test(q);
 return (!percentOutput&&(!sourceDescription||explicitOutput))||notPct;
}
module.exports.decimalRatioOutput=decimalRatioOutput;

// rank节点作用于最终结果，不能表达“先取Top-N，再合计作分子”的二阶段计算。
function rankedSubsetAggregate(question){
 const q=String(question||'');return require('./plan-ir').rankTopOf(q)!=null && /合计|加总|总和|combined|together|sum\b/i.test(q) && /占|份额|比重|share|percent/i.test(q);
}
module.exports.rankedSubsetAggregate=rankedSubsetAggregate;

// 行的占比要求计数口径；金额或件数除以行数是另一种指标。
function rowCountShareQuestion(question){
 const q=String(question||'');return /(?:行|记录)(?:数|数量)?(?:的)?占(?:全部|所有|总)(?:行|记录)(?:数|数量)?(?:的)?(?:比例|占比|百分比|比重)|(?:fraction|percentage|proportion|share|ratio)[^.]{0,40}(?:rows|records)[^.]{0,30}(?:all|total)[^.]{0,8}(?:rows|records)|(?:rows|records)[^.]{0,24}(?:percentage|proportion|share|ratio)[^.]{0,12}(?:all|total)[^.]{0,8}(?:rows|records)/i.test(q);
}
function rowCountShareSqlGap(question,check){
 if(!rowCountShareQuestion(question))return false;
 const bit=n=>n?.class==='CONSTANT'&&!n.value?.is_null&&[0,1].includes(Number(n.value?.value));
 const indicator=n=>n?.class==='CASE'&&(n.case_checks||[]).length>0&&(n.case_checks||[]).every(c=>bit(c.then_expr))&&bit(n.else_expr);
 return (check.aggregates||[]).some(a=>a.distinct||(['sum','avg'].includes(a.fn)&&(a.col||a.expr==='CASE'&&!indicator(a.node?.children?.[0]))));
}
module.exports.rowCountShareQuestion=rowCountShareQuestion;module.exports.rowCountShareSqlGap=rowCountShareSqlGap;

// 汇总只能在声明足以证明适配时替代明细；自动同名不等于等价。
function automaticSummarySourceGaps(question,registry,refs){
 const q=String(question||''),all=[...(registry?.semantic?.metrics?.values?.()||[])].filter(m=>!m.unbound),names=new Map((registry.tables||[]).map(t=>[t.name,[t.name,t.display||''].join(' ')]));
 for(const p of registry.packDefs||[])for(const [table,name]of Object.entries(p._meta?.table_names||{}))if(names.has(table))names.set(table,names.get(table)+' '+name);
 const summary=t=>/汇总|预聚合|聚合表|\b(?:summary|rollup|aggregates?|aggregated)\b|(?:^|_)(?:summary|rollup|aggregated)(?:_|$)/i.test(names.get(t)||''),detail=t=>/明细|事实|流水|\b(?:detail|facts?|transactions?|events?)\b|(?:^|_)(?:fact|detail|transactions?|events?)(?:_|$)/i.test(names.get(t)||'');
 const mentioned=term=>{if(!term||String(term).length<2)return false;const x=String(term);return /^[A-Za-z0-9_]+$/.test(x)?new RegExp('(?:^|[^A-Za-z0-9_])'+x+'(?=$|[^A-Za-z0-9_])','i').test(q):q.toLowerCase().includes(x.toLowerCase());};
 const selected=(refs||[]).flatMap(ref=>{if(typeof ref==='string'){try{return[registry.metric(ref)];}catch(_){return[]}}return all.filter(m=>(m.dataset||m.boundTo)===ref.table&&m.field===ref.field&&m.agg===ref.agg);});
 const gaps=[];for(const m of selected){const table=m.dataset||m.boundTo;if(!m.auto||m.confirmed||m.kind!=='simple'||!m.field||!summary(table))continue;
  // 确认只背书题面所用的业务口径，不能给同列的其他自动指标一并盖章。
  if(all.some(n=>(n.dataset||n.boundTo)===table&&n.field===m.field&&n.agg===m.agg&&(!n.auto||n.confirmed)&&[n.name,...n.aliases||[]].some(mentioned)))continue;
  const explicit=(registry.packDefs||[]).flatMap(p=>Object.entries(p._meta?.table_names||{})).filter(([t])=>t===table).map(([,n])=>n);const display=(registry.tables||[]).find(t=>t.name===table)?.display;if(display)explicit.push(display);
  if(mentioned(table)||explicit.some(mentioned))continue;
  const aliases=[m.name,...m.aliases||[]].filter(mentioned);
  if(aliases.length&&all.some(n=>{const t=n.dataset||n.boundTo;return t!==table&&detail(t)&&!summary(t)&&n.kind==='simple'&&n.field===m.field&&n.agg===m.agg&&String(n.unit||'')===String(m.unit||'')&&[n.name,...n.aliases||[]].some(a=>aliases.includes(a));}))gaps.push(table+'.'+m.field);
 }
 return [...new Set(gaps)];
}
function monthKeySourceGaps(period,registry,tables){
 if(!period?.start||!period.endExclusive||String(period.start).slice(0,10).endsWith('-01')&&String(period.endExclusive).slice(0,10).endsWith('-01'))return[];
 const chosen=new Set(tables||[]),gaps=[];for(const role of registry.timeRoles?.()||[]){if(!chosen.has(role.dataset))continue;try{const d=registry.dim(role.dim);if(d.kind==='timeBucket'&&d.grain==='month'&&/^(?:month|year_month|年月|月份)$/i.test(String(d.source?.field||'')))gaps.push(d.source.table+'.'+d.source.field);}catch(_){}}
 return [...new Set(gaps)];
}
module.exports.automaticSummarySourceGaps=automaticSummarySourceGaps;module.exports.monthKeySourceGaps=monthKeySourceGaps;
// 保留实际快照域：状态筛选放在条件计数中，避免零事件日期被WHERE删除。
function completeSnapshotCountQuestion(question){
 const q=String(question||'');return /(?:各期|每期|[一二两三四五六七八九十\d]+期)\s*快照|\b(?:all|each|every)\s+snapshots?\b/i.test(q)&&/多少个|几个|货号|SKU|\bcount\b|number\s+of/i.test(q)&&!/只(?:要|列|看|展示).{0,12}(?:非零|有|大于)|仅.{0,8}(?:有|非零)|有.{0,20}的(?:各)?(?:期|快照)|non.?zero|only[^.]{0,25}(?:matching|positive)/i.test(q);
}
function snapshotCountDomainGap(question,check,context){
 if(!completeSnapshotCountQuestion(question)||!check.aggregates.some(a=>/^count(?:_star)?$/i.test(a.fn)))return false;
 const n=check.ast?.node||check.ast;if(!n||n.from_table?.type!=='BASE_TABLE'||n.cte_map?.map?.length||n.having||!n.where_clause)return false;
 const table=n.from_table.table_name,dates=new Set((context.roles||[]).filter(r=>r.table===table).map(r=>r.field)),status=new Set((context.tables||[]).find(t=>t.name===table)?.columns.filter(c=>/(?:^|_)(?:state|status)(?:_|$)|状态/i.test(c.name)).map(c=>c.name)||[]);
 if(!dates.size||!status.size)return false;
 const refs=x=>{const names=new Set(),walk=y=>{if(!y||typeof y!=='object')return;if(y.class==='COLUMN_REF')names.add(y.column_names?.at(-1));Object.values(y).forEach(walk)};walk(x);return names};
 const groups=(n.group_expressions||[]).map(e=>e.class==='CONSTANT'&&Number.isInteger(Number(e.value?.value))?n.select_list?.[Number(e.value.value)-1]||e:e.class==='COLUMN_REF'&&e.column_names?.length===1?n.select_list?.find(p=>p.alias===e.column_names[0])||e:e);
 return [...refs(groups)].some(x=>dates.has(x))&&[...refs(n.where_clause)].some(x=>status.has(x));
}
module.exports.completeSnapshotCountQuestion=completeSnapshotCountQuestion;module.exports.snapshotCountDomainGap=snapshotCountDomainGap;

// ---- P78 · 显式聚合优先(经典做法:BI 工具里指标有默认聚合,但用户在问题里写明的聚合方式覆盖默认,如 Looker/Tableau 的度量可按查询改聚合) ----
// 只在题面明确说「合计/求和/总和/加总」且没说平均时生效;且只针对题面点到的、默认按平均登记的那个字段。
const EXPLICIT_SUM_RE=/合计|求和|总和|加总|\bsum of\b|\bsummed\b|\btotal of\b/i, EXPLICIT_AVG_RE=/平均|均值|\baverage\b|\bmean\b/i;
function mentionedIn(q,m){const t=[m.field,m.name,...(m.aliases||[])].filter(x=>x&&String(x).length>=2);return t.some(x=>q.toLowerCase().includes(String(x).toLowerCase()));}
function explicitSumAvgDefaults(question,context){
 const q=String(question||'');if(!EXPLICIT_SUM_RE.test(q)||EXPLICIT_AVG_RE.test(q))return[];
 // 「合计/求和」必须紧挨着这个字段(中间最多是括号里的列名),且不是乘积里的一项(如「X×Sessions 的合计」是加权,不是对X求和)
 const esc=x=>String(x).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return (context?.metrics||[]).filter(m=>{
  if(!(m.kind==='simple'&&m.agg==='avg'&&m.field))return false;
  const terms=[m.field,m.name&&String(m.name).split('·').pop(),...(m.aliases||[])].filter(x=>x&&String(x).length>=2);
  return terms.some(t=>{const e=esc(t);
   const after=new RegExp(e+'(?:\\s*[（(][^）)]{1,30}[）)])?\\s*(?:的)?\\s*(?:合计|求和|总和|加总)','i');
   const before=new RegExp('(?:合计|求和|加总|总和|sum of|total)\\s*(?:的)?\\s*'+e,'i');
   const prod=new RegExp(e+'[^，。；]{0,12}[×*乘]|[×*乘][^，。；]{0,12}'+e,'i');
   return (after.test(q)||before.test(q))&&!prod.test(q);});
 });
}
function explicitSumGap(question,check,context){
 const avgs=explicitSumAvgDefaults(question,context);if(!avgs.length)return false;
 return (check.aggregates||[]).some(a=>a.fn==='avg'&&a.col&&avgs.some(m=>m.dataset===a.col.table&&m.field===a.col.col));
}
// ---- P78 · 行级数值条件(经典做法:SQL 里行级条件放 WHERE、组级条件放 HAVING;配置单的筛选只做取值成员,表达不了行级阈值) ----
const ZH_THRESHOLD='(?:超过|低于|高于|大于|小于|至少|最多|不超过|不少于|大于等于|小于等于)\\s*[\\d.]+';
const ZH_ROW_FILTER=new RegExp(ZH_THRESHOLD+'[^，。；,;]{0,8}?的(?:记录|行|明细|销售记录|订单行)|(?:单笔|每笔|单条|每条|单行)[^，。；,;]{0,16}?'+ZH_THRESHOLD);
const EN_THRESHOLD=/(?:\b(?:strictly\s+)?(?:greater|more|less|fewer|higher|lower) than|\bat (?:least|most)\b|\bexceed(?:s|ing)?\b|>=?|<=?)\s*(?:US\$|\$|USD\s*)?\s*\d/i;
const EN_ROW=/\b(?:records?|rows?|transactions?|line items?|purchase records?)\b[^.?]{0,80}?\b(?:where|with|that have|have|has|having|whose)\b/i;
function rowNumericFilter(question){
 const q=String(question||'');
 if(ZH_ROW_FILTER.test(q))return true;
 return EN_THRESHOLD.test(q)&&EN_ROW.test(q)&&!/\b(?:total|sum|average|mean)\b[^.?]{0,30}(?:greater|more|less|fewer|higher|lower) than/i.test(q);
}
module.exports.explicitSumAvgDefaults=explicitSumAvgDefaults;module.exports.explicitSumGap=explicitSumGap;module.exports.rowNumericFilter=rowNumericFilter;
// ---- P78 · 明确点名快照原始字段并要求汇总、又没给快照日期 → 按记录逐条相加(Kimball:半可加指标不跨时间相加是「默认」,题面明确要求原始记录算术时按题面) ----
const SNAP_AGG_RE=/汇总|合计|总量|总和|求和|加总|\bsum\b|\btotal\b/i;
const SNAP_DATE_RE=/\d{1,2}[.月/-]\d{1,2}|\d{4}-\d{2}(?:-\d{2})?|当前|最新|期末|目前|现在|那期|这期|截至|最近一期|latest|current|as of|on hand now/i;
function rawSnapshotSum(question,context){
 const q=String(question||'');if(!SNAP_AGG_RE.test(q)||SNAP_DATE_RE.test(q))return [];
 return (context?.metrics||[]).filter(m=>m.additivity==='semiAdditive'&&m.field&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.field)&&new RegExp('(?:^|[^A-Za-z0-9_])'+m.field+'(?=$|[^A-Za-z0-9_])').test(q));
}
module.exports.rawSnapshotSum=rawSnapshotSum;
// ---- P78 · 英文明确月份/季度/区间(经典做法同 chrono 等日期解析器:Month YYYY = 整月 [1日, 次月1日)) ----
const EN_MON={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
const MON_RE='(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?';
const iso=(y,m,d=1)=>String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
const nextMonth=(y,m)=>m===12?[y+1,1]:[y,m+1];
const lastDay=(y,m)=>{const [ny,nm]=nextMonth(y,m);const d=new Date(Date.UTC(ny,nm-1,1)-864e5);return d.toISOString().slice(0,10);};
function englishPeriod(question){
 const q=String(question||'');if(/[一-鿿]/.test(q))return null;
 let m=new RegExp('\\b(?:between|from)\\s+'+MON_RE+'\\s+((?:19|20)\\d{2})\\s+(?:and|to|through|until|thru)\\s+'+MON_RE+'\\s+((?:19|20)\\d{2})\\b','i').exec(q);
 if(m){const a=[+m[2],EN_MON[m[1].toLowerCase()]],b=[+m[4],EN_MON[m[3].toLowerCase()]];if(a[0]*12+a[1]<=b[0]*12+b[1]){const ne=nextMonth(b[0],b[1]);return {start:iso(a[0],a[1]),end:lastDay(b[0],b[1]),endExclusive:iso(ne[0],ne[1]),grain:'month',label:m[0],explicit:true,relative:false,policy:'explicit',source:'english_month_range'};}}
 const all=[...q.matchAll(new RegExp('\\b'+MON_RE+'\\s*,?\\s+((?:19|20)\\d{2})\\b','gi'))].filter(x=>!/\bmay\b/i.test(x[1])||/\bin\s+may\b|\bof\s+may\b|\bmay\s+(?:19|20)\d{2}/i.test(q));
 const uniq=[...new Set(all.map(x=>x[2]+'-'+EN_MON[x[1].toLowerCase()]))];
 if(uniq.length===1&&!/\b(?:compare[ds]?|versus|vs\.?)\b/i.test(q)){const [y,mo]=uniq[0].split('-').map(Number),ne=nextMonth(y,mo);return {start:iso(y,mo),end:lastDay(y,mo),endExclusive:iso(ne[0],ne[1]),grain:'month',label:all[0][0],explicit:true,relative:false,policy:'explicit',source:'english_month'};}
 m=/\b(?:Q([1-4])|(first|second|third|fourth)\s+quarter(?:\s+of)?)\s*,?\s*((?:19|20)\d{2})\b/i.exec(q);
 if(m){const n=m[1]?+m[1]:{first:1,second:2,third:3,fourth:4}[m[2].toLowerCase()],y=+m[3],s=(n-1)*3+1,ne=nextMonth(y,s+2);return {start:iso(y,s),end:lastDay(y,s+2),endExclusive:iso(ne[0],ne[1]),grain:'quarter',label:m[0],explicit:true,relative:false,policy:'explicit',source:'english_quarter'};}
 return null;
}
function periodMissingInSql(period,sql){
 if(!period||!period.start||period.relative)return false;
 const q=String(sql||''),st=String(period.start).slice(0,10),y=st.slice(0,4);
 if(!/^\d{4}$/.test(y))return false;
 // 单日(如某一期快照)必须精确落到那一天;英文月/季度必须落到那个月;其余至少要有年份
 if(period.source==='snapshot_day')return !q.includes(st);
 if(/^english_/.test(String(period.source||'')))return !q.includes(st)&&!q.includes(st.slice(0,7));
 return !q.includes(y);
}
// 「9.19 那期 / 9.19 快照」这类月.日写法 → 当年(晚于 anchor 则上一年)的那一天
function snapshotDayPeriod(question,anchor){
 const qq=String(question||'');if((qq.match(/(?<![\d.])\d{1,2}\.\d{1,2}(?![\d.])/g)||[]).length!==1||/\d{1,2}\s*月\s*\d{1,2}|\d{4}-\d{2}/.test(qq))return null;
 const m=/(?<![\d.])(\d{1,2})\.(\d{1,2})(?![\d.])\s*(?:那期|这期|那次|那一期|这一期|的快照|快照|期)/.exec(qq);if(!m)return null;
 const a=String(anchor||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(a))return null;
 const mo=+m[1],d=+m[2];if(mo<1||mo>12||d<1||d>31)return null;
 let y=+a.slice(0,4);let iso=y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0');if(iso>a){y--;iso=y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0');}
 const dt=new Date(iso+'T00:00:00Z');if(isNaN(dt)||dt.toISOString().slice(0,10)!==iso)return null;
 const nx=new Date(dt.getTime()+864e5).toISOString().slice(0,10);
 return {start:iso,end:iso,endExclusive:nx,grain:'day',label:m[0],explicit:true,relative:false,policy:'explicit',source:'snapshot_day'};
}
module.exports.snapshotDayPeriod=snapshotDayPeriod;
module.exports.englishPeriod=englishPeriod;module.exports.periodMissingInSql=periodMissingInSql;
// ---- P78 · 「…大于N的记录」是逐行条件:必须在 WHERE(或逐行 CASE)里判断,不能只在分组后用 HAVING 判断合计/比率 ----
function rowConditionHavingGap(question,check){
 const q=String(question||'');const m=new RegExp('('+ZH_THRESHOLD+')[^，。；,;]{0,8}?的(?:记录|行|明细|销售记录|订单行)').exec(q);if(!m)return false;
 const num=(m[1].match(/[\d.]+/)||[])[0];if(num==null)return false;
 let havingHit=false,whereHit=false;
 const has=(x)=>{let hit=false;const w=y=>{if(Array.isArray(y))return y.forEach(w);if(!y||typeof y!=='object')return;if(y.class==='CONSTANT'&&String(y.value?.value)===String(Number(num))||y.class==='CONSTANT'&&String(y.value?.value)===num)hit=true;Object.values(y).forEach(w);};w(x);return hit;};
 const walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(!x||typeof x!=='object')return;if(x.type==='SELECT_NODE'){if(x.having&&has(x.having))havingHit=true;if(x.where_clause&&has(x.where_clause))whereHit=true;for(const s of x.select_list||[])if(s.class==='CASE'&&has(s))whereHit=true;}Object.values(x).forEach(walk);};
 walk(check.ast);return havingHit&&!whereHit;
}
module.exports.rowConditionHavingGap=rowConditionHavingGap;

// ---- P78 · 达成率:实际和计划不能来自同一张计划表(用户确认过哪张是计划表) ----
const GOAL_RATE_RE=/达成率|完成率|达成了|完成了|(?:达成|完成|占)[^，。；]{0,24}(?:计划|目标|预算)|\b(?:attainment|achievement|completion)\b/i;
function planActualSameSource(question,check,context){
 if(!GOAL_RATE_RE.test(String(question||'')))return false;
 const plans=(context?.metrics||[]).filter(m=>m.confirmed&&!m.auto&&/计划|目标|预算|plan|target|budget/i.test([m.name,...(m.aliases||[])].join(' ')));
 if(!plans.length)return false;
 const planTables=new Set(plans.map(m=>m.dataset));
 const aggTables=new Set((check.aggregates||[]).filter(a=>a.col&&typeof a.col.table==='string').map(a=>a.col.table));
 return aggTables.size>0&&[...aggTables].every(t=>planTables.has(t));
}

// P78:按「滚动累计窗口值」排名是退化排名——非负量的滚动累计单调递增，取最高的N个永远是最后N期，
// 等于没有按业务量排名。题面要的是各组自身的合计排名；真要滚动累计序列时题面会说「截至每…/累计到/running」，那时不排名。
function runningTotalRankGap(question, sql){
  const q=String(question||''), t=String(sql||'');
  if(/截至每|累计到|滚动累计|累计曲线|running|cumulative/i.test(q))return false;
  if(!/\blimit\s+\d+/i.test(t))return false;
  const win=/\bsum\s*\((?:[^()]|\([^()]*\))*\)\s*over\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?:as\s+)?("?[\w一-龥]+"?)?/ig;
  for(const m of t.matchAll(win)){
    const spec=m[1]||'';
    if(!/order\s+by/i.test(spec)||/rows\s+between\s+\d+\s+preceding/i.test(spec))continue;
    const alias=String(m[2]||'').replace(/"/g,'');
    const tail=t.slice(m.index+m[0].length);
    const ob=/order\s+by\s+([^;]*?)\s+limit\s+\d+/ig;let o;
    while((o=ob.exec(tail))){const key=o[1];if(alias&&new RegExp('(?:^|[^\\w])"?'+alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"?(?:\\s|,|$)','i').test(key))return true;if(/\bover\s*\(/i.test(key))return true;}
  }
  return false;
}
// P78:题面声明某字段原值就是百分数（百分点），SQL 又对含该字段的表达式乘 100 → 重复换算（39.97 变 3997%）。
function percentDoubleScale(question, sql, context){
  const q=String(question||''), t=String(sql||'');
  if(!/(?:^|[^\d.])100(?:\.0*)?\s*\*|\*\s*100(?:\.0*)?(?![\d.])/.test(t))return [];
  const cols=[...new Set((context?.tables||[]).flatMap(x=>(x.columns||[]).map(c=>String(c.name||c))))].filter(c=>c.length>=3);
  const esc=x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return cols.filter(c=>new RegExp(esc(c)+'\\s*(?:的)?\\s*(?:原值|原始值|取值|值)?\\s*(?:为|是|按|以)?\\s*(?:百分数|百分点|百分比数值|percent(?:age)?\\s*(?:value|points?)?)','i').test(q)
    &&new RegExp('"?'+esc(c)+'"?','i').test(t));
}
module.exports.planActualSameSource=planActualSameSource;
module.exports.runningTotalRankGap=runningTotalRankGap;module.exports.percentDoubleScale=percentDoubleScale;

// P78:实体边界越界(经典 NER span 问题):题面「义乌杂品供的东西」里真实取值是「义乌杂品」，模型把后面的动词也当成了取值('义乌杂品供')。
// 只在:SQL 字符串常量本身是题面原文片段、目录里没有这个常量、且它以某个题面里精确出现的目录取值开头或结尾时，换回那个目录取值；引号点名的原文不动。
function entitySpanRepairs(question,lookup,check){
 if(!lookup?.resolve)return [];
 const q=String(question||'');let matches=[];try{matches=lookup.resolve(q).matches||[];}catch(_){return [];}
 const vals=[...new Set(matches.filter(m=>['exact','contains'].includes(m.how)&&String(m.value).length>=2&&q.includes(String(m.value))).map(m=>String(m.value)))];
 if(!vals.length)return [];
 const consts=new Set();const walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(!x||typeof x!=='object')return;if(x.class==='CONSTANT'&&x.value?.type?.id==='VARCHAR'&&!x.value.is_null)consts.add(String(x.value.value));Object.values(x).forEach(walk);};walk(check.ast);
 const out=[];
 for(const c of consts){
  if(vals.includes(c)||c.length<3||!q.includes(c))continue;
  if(require('./value-match').quotedVerbatim(q,c))continue;
  let known=false;try{const h=lookup.resolve(c,{});known=(h.matches||[h]).some(x=>x&&String(x.value)===c);}catch(_){known=true;}
  if(known)continue;
  const hits=vals.filter(v=>v!==c&&(c.startsWith(v)||c.endsWith(v))&&c.length-v.length<=2);
  if(hits.length===1)out.push({from:c,to:hits[0]});
 }
 return out;
}
module.exports.entitySpanRepairs=entitySpanRepairs;
// P79:题面用登记过的中文专名(亚马逊)而 SQL 照写了中文原词时,本机换成目录里唯一对应的取值(Amazon);目录取值不出站。
function nominalAliasRepairs(question,lookup,check){
 if(!lookup?.index)return [];
 let hit=null;try{hit=require('./value-match').explicitNominalAlias(String(question||''),{lookup,dimIds:[...lookup.index.keys()]});}catch(_){return [];}
 if(!hit)return [];
 const consts=new Set();const walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(!x||typeof x!=='object')return;if(x.class==='CONSTANT'&&x.value?.type?.id==='VARCHAR'&&!x.value.is_null)consts.add(String(x.value.value));Object.values(x).forEach(walk);};walk(check.ast);
 return consts.has(hit.literal)?[{from:hit.literal,to:hit.value}]:[];
}
module.exports.nominalAliasRepairs=nominalAliasRepairs;
