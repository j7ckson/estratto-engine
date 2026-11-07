'use strict';
// 提示词按题面召回的依赖闭包裁剪；授权与SQL校验始终使用完整准许目录。
// 双连通块内每个顶点都可位于两端之间的某条简单路径；挂在同一割点的环路不属于候选。
function relationshipPathClosure(rels,seeds){
  const graph=new Map();
  for(const r of rels)if(r.left!==r.right)for(const [a,b]of [[r.left,r.right],[r.right,r.left]]){
    if(!graph.has(a))graph.set(a,new Set());graph.get(a).add(b);
  }
  const seen=new Map(),low=new Map(),stack=[],blocks=[];let clock=0;
  function visit(at,parent){
    seen.set(at,++clock);low.set(at,clock);
    for(const next of graph.get(at)||[]){
      if(!seen.has(next)){
        stack.push([at,next]);visit(next,at);low.set(at,Math.min(low.get(at),low.get(next)));
        if(low.get(next)>=seen.get(at)){
          const nodes=new Set();let edge;
          do{edge=stack.pop();nodes.add(edge[0]);nodes.add(edge[1]);}while(edge[0]!==at||edge[1]!==next);
          blocks.push({nodes});
        }
      }else if(next!==parent&&seen.get(next)<seen.get(at)){
        stack.push([at,next]);low.set(at,Math.min(low.get(at),seen.get(next)));
      }
    }
  }
  for(const t of graph.keys())if(!seen.has(t))visit(t,null);
  const tree=new Map(),connect=(a,b)=>{if(!tree.has(a))tree.set(a,[]);tree.get(a).push(b);};
  for(const block of blocks)for(const t of block.nodes){connect(t,block);connect(block,t);}
  const keep=new Set(seeds);
  for(const from of seeds){
    const parents=new Map([[from,null]]),queue=[from];
    for(let i=0;i<queue.length;i++)for(const next of tree.get(queue[i])||[])if(!parents.has(next)){parents.set(next,queue[i]);queue.push(next);}
    for(const to of seeds)if(to!==from&&parents.has(to))for(let at=to;at!==null;at=parents.get(at)){
      if(typeof at==='string')keep.add(at);else for(const t of at.nodes)keep.add(t);
    }
  }
  return keep;
}

function selectContext(full, registry, plan, question) {
  const tables=new Set(), metrics=new Set(), dims=new Set();
  const addMetric=id=>{if(!id)return;try{const m=registry.metric(id);metrics.add(m.id);for(const l of registry.leaves(id)){const v=registry.metric(l);metrics.add(v.id);tables.add(v.dataset||v.boundTo);}}catch(_){}};
  for(const d of [...plan?.dimensions||[],...(plan?.entities||[]).map(e=>e.dim),...(plan?.negations||[]).map(e=>e.dim)])try{const x=registry.dim(d);dims.add(x.id);tables.add(x.source?.table||x.dataset);}catch(_){}
  const q=String(question).toLowerCase().replace(/\s/g,'');
  const subtypeHints=(full.subtypes||[]).filter(s=>s.zh&&String(s.zh).length>=2&&q.includes(String(s.zh).toLowerCase()));
  for(const hint of subtypeHints){tables.add(hint.table);tables.add(hint.of);}
  const roleHints=require('./sql-constraints').requiredRoleMappings(question,full);
  for(const role of roleHints)tables.add(role.table);
  const namedTables=full.tables.filter(t=>{const name=String(full.tableNames?.[t.name]||'').toLowerCase().replace(/\s/g,'');return name.length>=2&&q.includes(name);});
  for(const t of namedTables)tables.add(t.name);
  // 多指标歧义常由表名泛称扩出金额/行数；已有明确题面表时，只保留该表或题面精确点名的指标种子。
  const exactTerm=n=>n&&String(n).length>=2&&q.includes(String(n).toLowerCase().replace(/\s/g,''));
  const namedSet=new Set(namedTables.map(t=>t.name));
  const ambiguousMetric=(plan?.unresolved||[]).some(u=>u.code==='ambiguous_metric');
  for(const id of plan?.metric_ids||[]){
    let m;try{m=registry.metric(id);}catch(_){continue;}
    if(ambiguousMetric&&!require('./sql-constraints').dateDifferenceRoles(question,full)&&namedSet.size&&!namedSet.has(m.dataset||m.boundTo)&&![m.name,m.field,...m.aliases||[]].some(exactTerm))continue;
    addMetric(id);
  }
  const exactBusinessNumbers=[...registry.semantic.dims.values()].filter(d=>/_Number$/i.test(d.source?.field||'')&&[d.name,d.source?.field].some(exactTerm));
  const shadowedKey=d=>!/内部|identifier|\bid\b/i.test(String(question))&&/_Identifier$/i.test(d.source?.field||'')&&exactBusinessNumbers.some(n=>n.source.field.toLowerCase()===d.source.field.replace(/_Identifier$/i,'_Number').toLowerCase())&&![d.name,d.source?.field].some(exactTerm);
  if(subtypeHints.length)for(const t of full.tables){const name=full.tableNames?.[t.name];if(name&&String(name).length>=2&&q.includes(String(name).toLowerCase()))tables.add(t.name);}
  for(const m of registry.semantic.metrics.values())if([m.name,m.field,...m.aliases||[]].some(n=>n&&String(n).length>=2&&q.includes(String(n).toLowerCase().replace(/\s/g,''))))addMetric(m.id);
  for(const d of registry.semantic.dims.values())if(!shadowedKey(d)&&[d.name,d.source?.field,...d.aliases||[]].some(n=>n&&String(n).length>=2&&q.includes(String(n).toLowerCase().replace(/\s/g,'')))){dims.add(d.id);tables.add(d.source?.table||d.dataset);}
  tables.delete(undefined);tables.delete(null);
  const bound=new Set([...full.metrics.map(m=>m.dataset),...full.dims.map(d=>d.table),...full.rels.flatMap(r=>[r.left,r.right])].filter(Boolean));
  for(const t of full.tables)if(q.includes(t.name.toLowerCase()))tables.add(t.name);
  // 只有维度或未决指标时，不能把它误当完整事实范围；保留全部业务表再由模型选择。
  if(!tables.size || !subtypeHints.length&&!roleHints.length&&!namedTables.length&&(plan?.unresolved?.length || !metrics.size))for(const t of bound)tables.add(t);
  if(!tables.size)return {context:full,reason:'no_reliable_seed'};
  // 连接候选保留所有登记简单路径上的表；用双连通块的树路径避免只取最短路或指数枚举。
  for(const t of relationshipPathClosure(full.rels||[],[...tables]))tables.add(t);
  // 子类型已指明事实来源时，业务编号标签只需补直接登记的编号维表，不把它再当事实种子扩成无关业务图。
  if(subtypeHints.length&&/编号|号码|单号/.test(q)&&!/内部|identifier|\bid\b/.test(q))for(const t of full.tables){
    if(tables.has(t.name))continue;
    const ids=t.columns.filter(c=>/_Identifier$/i.test(c.name));
    if(ids.some(id=>t.columns.some(c=>new RegExp('^(?:Company_)?'+id.name.replace(/_Identifier$/i,'')+'_Number$','i').test(c.name))&&(full.rels||[]).some(rel=>[rel.left,rel.right].includes(t.name)&&[rel.left,rel.right].some(x=>tables.has(x))&&rel.pairs.some(pair=>pair.includes(id.name)))))tables.add(t.name);
  }
  // 同表字段仍全部保留：筛选、日期角色、行级乘积、业务列去重都可能依赖它们。
  const out=Object.assign({},full,{tables:full.tables.filter(t=>tables.has(t.name)),metrics:full.metrics.filter(m=>metrics.has(m.id)||tables.has(m.dataset)),dims:full.dims.filter(d=>tables.has(d.table)),rels:full.rels.filter(r=>tables.has(r.left)&&tables.has(r.right)),roles:full.roles.filter(r=>tables.has(r.table)),subtypes:(full.subtypes||[]).filter(s=>tables.has(s.table)&&tables.has(s.of)),bridges:(full.bridges||[]).filter(b=>tables.has(b.table))});
  for(const key of ['colNames','dateFormats'])out[key]=Object.fromEntries(Object.entries(full[key]||{}).filter(([k])=>[...tables].some(t=>k.startsWith(t+'.'))));
  for(const key of ['currency','dupRows','tableNames'])out[key]=Object.fromEntries(Object.entries(full[key]||{}).filter(([t])=>tables.has(t)));
  out.platformRatios=(full.platformRatios||[]).filter(x=>tables.has(x.table));out.returnNotes=(full.returnNotes||[]).filter(x=>[...tables].some(t=>String(x).startsWith(t+'.')));
  return {context:out,reason:out.tables.length===full.tables.length?'dependency_closure_full':'dependency_closure',selected_tables:out.tables.length,full_tables:full.tables.length};
}
module.exports={selectContext};

// 只给冗长、无业务语义的物理视图编号设短代号；回到本机后还原AST再做原授权校验。
function tableAliases(context){
 const taken=new Set(context.tables.map(t=>t.name.toLowerCase())),map=new Map();let i=1;
 const largeBusiness=(context.fields instanceof Map?context.tables.filter(t=>context.fields.has(t.name)).length:context.tables.length)>=8;
 for(const t of context.tables.slice().sort((a,b)=>a.name.localeCompare(b.name)))if(/^v_t[a-f0-9]{16}$/.test(t.name)||(largeBusiness&&t.name.length>8&&(!(context.fields instanceof Map)||context.fields.has(t.name)))){
  let short;do{short='T'+i++;}while(taken.has(short.toLowerCase()));map.set(t.name,short);taken.add(short.toLowerCase());
 }
 return map;
}
function aliasContext(context,map){
 if(!map.size)return context;
 const qualified=s=>{for(const [real,short]of map)if(s.startsWith(real+'.'))return short+s.slice(real.length);return s;};
 const table=s=>map.get(s)||s,tableKeys=new Set(['dataset','boundTo','table','left','right','of']);
 const textKeys=new Set(['field','name','zh','aliases','value','label','note']);
 // 表、列、名称是不同命名空间；Policy_Amount既能是表名也能是金额列，不能把列也替换成T编号。
 const visit=(x,key='',parent=null)=>{
  if(typeof x==='string')return tableKeys.has(key)||key==='name'&&Array.isArray(parent?.columns)?table(x):textKeys.has(key)?x:qualified(x);
  if(Array.isArray(x))return x.map(v=>visit(v,key,x));
  if(x instanceof Set)return new Set([...x].map(v=>visit(v,key==='fields'?'field':key,x)));
  if(x instanceof Map)return new Map([...x].map(([k,v])=>[table(qualified(k)),visit(v,key,x)]));
  if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[table(qualified(k)),visit(v,k,x)]));
  return x;
 };
 const out=visit(context);
 // 有业务含义的长表名在结构中保留一次，引用用短代号；本机仍按AST还原并校验真实表权限。
 if(context.tables)for(const [real,short]of map)if(!/^v_t[a-f0-9]{16}$/.test(real))out.tableNames={...out.tableNames,[short]:real+(context.tableNames?.[real]?'；'+context.tableNames[real]:'')};
 return out;
}
async function restoreAliases(sql,map,run){
 if(!map.size)return sql;
 const reverse=new Map([...map].map(([a,b])=>[b.toLowerCase(),a])),sq=s=>"'"+String(s).replaceAll("'","''")+"'";
 const ast=JSON.parse((await run('SELECT json_serialize_sql('+sq(sql)+') AS j'))[0].j);if(ast.error)return sql;
 let changed=false;const walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(!x||typeof x!=='object')return;
  if(x.type==='BASE_TABLE'&&reverse.has(String(x.table_name).toLowerCase())){const old=x.table_name;x.table_name=reverse.get(old.toLowerCase());if(!x.alias)x.alias=old;changed=true;}
  if(x.query_location>Number.MAX_SAFE_INTEGER)x.query_location=0;Object.values(x).forEach(walk);
 };walk(ast);if(!changed)return sql;
 return String((await run('SELECT json_deserialize_sql('+sq(JSON.stringify(ast))+') AS s'))[0].s);
}
module.exports.tableAliases=tableAliases;module.exports.aliasContext=aliasContext;module.exports.restoreAliases=restoreAliases;
