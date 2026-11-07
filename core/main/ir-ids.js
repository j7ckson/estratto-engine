'use strict';
// 请求内短代号只压缩标识；响应在本机还原后再核验权限和执行。
function compactResolver(resolve){
  if(typeof resolve!=='function')return resolve;
  return async payload=>{
    if(payload?.lane)return resolve(payload);
    const ids=new Set();
    for(const group of ['metrics','dimensions','time_roles'])for(const x of payload?.candidates?.[group]||[])if(x.id)ids.add(x.id);
    for(const group of ['metrics','dimensions'])for(const x of payload?.catalog?.[group]||[])if(x[0])ids.add(x[0]);
    const map=new Map(),taken=new Set(ids),counts={m:0,d:0,t:0};
    for(const id of [...ids].sort()){
      const kind=String(id)[0];if(id.length<24||!counts.hasOwnProperty(kind)||id[1]!==':')continue;
      let short;do{short=kind+':'+ ++counts[kind];}while(taken.has(short));taken.add(short);map.set(id,short);
    }
    if(!map.size)return resolve(payload);
    const reverse=new Map([...map].map(([a,b])=>[b,a]));
    const literalKeys=new Set(['question','name','unit','label','value','literal','message','word']);
    const visit=(x,m,key='')=>literalKeys.has(key)?x:typeof x==='string'?(m.get(x)||x):Array.isArray(x)?x.map(v=>Array.isArray(v)&&['metrics','dimensions','time_roles'].includes(key)?v.map((item,i)=>i===0?visit(item,m):item):visit(v,m,key)):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,visit(v,m,k)])):x;
    const input=visit(payload,map);input.question=payload.question;
    if(Array.isArray(input.previous_errors))input.previous_errors=input.previous_errors.map(e=>{if(typeof e!=='string')return e;for(const [a,b]of map)e=e.split(a).join(b);return e;});
    const res=await resolve(input);if(!res||!res.ok)return res;
    return {...res,...(res.ir?{ir:visit(res.ir,reverse)}:{}),...(res.plan?{plan:visit(res.plan,reverse)}:{})};
  };
}
module.exports={compactResolver};
