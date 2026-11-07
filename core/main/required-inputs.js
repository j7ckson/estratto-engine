'use strict';
// 必需输入缺失只在完整准许目录确认；普通单价不能充当采购成本，实际值不能充当目标。
function missingRequiredInput(question,registry){
 const q=String(question||'');if(/不(?:要|用|问|看|算).{0,3}(?:毛利|利润|成本)/.test(q))return null;
 const numeric=[];for(const t of registry.tables||[])for(const c of t.columns||[])numeric.push(c.name);
 for(const m of registry.semantic.metrics.values())if(!m.unbound)numeric.push(m.name,m.field,...m.aliases||[]);
 for(const d of registry.semantic.dims.values())if(!d.unbound)numeric.push(d.name,d.source?.field,...d.aliases||[]);
 for(const p of registry.packDefs||[])for(const [key,v]of Object.entries(p._meta?.column_names||{}))if(registry.tables.some(t=>t.columns.some(c=>t.name+'.'+c.name===key)))numeric.push(v.zh,...v.aliases||[]);
 const words=numeric.filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ');
 if(/下单[^。；]{0,12}到货[^。；]{0,12}(?:平均|多少|几|天)|(?:平均|多少|几)[^。；]{0,12}下单[^。；]{0,12}到货/.test(q)&&!(/交货周期|交付周期|供货周期|lead\s*time/i.test(words)||(/下单日期|订购日期|order\s*date/i.test(words)&&/到货日期|收货日期|arrival\s*date|received\s*date/i.test(words))))return {concept:'交货周期',missing:'下单和到货日期或已登记的交货周期字段',reason:'库龄表示已入库时长，不能代替从下单到到货的交货周期',local_reject:true};
 const requiredFields=[
  {q:/满意度|satisfaction(?:[\s_-]+(?:score|rating))?|\bCSAT\b/i,field:/满意度|satisfaction|\bCSAT\b/i,negated:/(?:不要|不用|无需|忽略|不计算)[^，。；]{0,8}满意度|\b(?:ignore|exclude|without|not\s+(?:using|use|calculate))\s+(?:customer\s+)?(?:satisfaction|CSAT)/i,concept:'客户满意度',missing:'客户满意度评分（customer satisfaction score）字段',reason:'访问量、跳出率、服务请求数或销售金额不能代替满意度评分'},
  {q:/员工工时|人员工时|工作时长|staff[\s_-]*(?:work[\s_-]*)?hours|employee[\s_-]*(?:work[\s_-]*)?hours|\bwork[\s_-]*hours\b/i,field:/工时|工作时长|staff\s+(?:work\s*)?hours|employee\s+(?:work\s*)?hours|work\s*hours|^(?=[\s\S]*(?:上班时间|上班日期|clock\s*in|shift\s*start))(?=[\s\S]*(?:下班时间|下班日期|clock\s*out|shift\s*end))/i,negated:/(?:不要|不用|无需|忽略|不计算)[^，。；]{0,8}(?:工时|工作时长)|\b(?:ignore|exclude|without|not\s+(?:using|use|calculate))\s+(?:staff|employee|work)[\s_-]*hours/i,concept:'员工工时',missing:'员工工时（staff workhours）或可计算工时的考勤时间字段',reason:'营业日期、服务请求次数或业务金额不能代替员工实际工作时长'},
  {q:/(?:入库|收货|到货)[^。；]{0,12}(?:日期|哪天|何时)|(?:日期|哪天|何时)[^。；]{0,12}(?:入库|收货|到货)|(?:receipt|received|arrival|inbound)\s+date|(?:when|date)[^.]{0,25}(?:received|arrived)/i,field:/入库日期|收货日期|到货日期|入库时间|收货时间|到货时间|(?:receipt|received|arrival|inbound)\s+(?:date|time)|(?:date|time)\s+(?:received|arrived)/i,concept:'入库日期',missing:'入库或收货日期字段',reason:'快照日期仅表示盘点时点，不能代替货物实际入库日期'},
  {q:/促销[^。；]{0,30}(?:额外|增量)|(?:额外|增量)[^。；]{0,20}促销|promotion[^.]{0,30}(?:incremental|uplift)/i,field:/促销增量|活动增量|促销基线|促销对照|实验分组|对照组|counterfactual|baseline|promotion\s+(?:incremental|uplift)/i,concept:'促销增量归因',missing:'促销基线、对照或已登记增量字段',reason:'实际成交总额不能代替促销造成的额外成交'},
  {q:/取消(?:的)?订单|取消率|订单取消|cancel(?:led|lation)s?\b/i,field:/取消|cancel|订单状态|order\s*status|\bstatus\b|状态/i,negated:/(?:不要|不用|无需|忽略)[^，。；]{0,8}取消/,concept:'订单取消状态',missing:'订单取消标记或订单状态字段',reason:'下单日期为空、金额为零等都不能当作取消订单的依据'},
  {q:/达人带货|网红带货|influencer\s+(?:sales|revenue|contribution)/i,field:/达人|主播|网红|influencer|creator|affiliate/i,concept:'达人归因',missing:'达人或带货归因字段',reason:'整个平台成交额不能代替达人带货贡献'},
  {q:/在哪[^，。；]{0,8}仓库|哪个仓库|仓库(?:位置|名称)|库房|\bwarehouse\b|storage\s+location/i,field:/仓库|库房|库位|仓位|warehouse|depot|storehouse|storage\s+location/i,concept:'仓库位置',missing:'仓库或库位字段',reason:'库存数量和货架状态不能代替仓库位置'},
  {q:/交货周期|交付周期|交货时间|供货周期|lead\s*time|delivery\s+(?:lead|time)/i,field:/交货|交付|供货周期|lead\s*time|delivery\s+(?:lead|time)/i,concept:'交货周期',missing:'交货周期或相关交付日期字段',reason:'普通销售或库存日期不能代替交货周期'},
  {q:/广告(?:花费|费|成本|支出)|ad\s*spend|advertising\s+(?:cost|spend)/i,field:/广告(?:花费|费|成本|支出)|ad\s*spend|advertising\s+(?:cost|spend)/i,concept:'广告花费',missing:'广告花费字段',reason:'销售收入不能代替广告支出'},
  {q:/退货原因|退款原因|因[^，。；]{1,30}退货|return\s+reason|refund\s+reason/i,field:/退货原因|退款原因|return\s+reason|refund\s+reason|reason\s+(?:for\s+)?(?:return|refund)/i,concept:'退货原因',missing:'退货或退款原因字段',reason:'退款金额或全部销售行数不能代替按原因筛选的退货数量'},
 ];
 for(const spec of requiredFields)if(spec.q.test(q)&&!spec.negated?.test(q)&&!spec.field.test(words))return {concept:spec.concept,missing:spec.missing,reason:spec.reason,local_reject:true};
 const profit=/毛利|净利|利润|gross\s+(?:margin|profit)|net\s+profit/i.test(q);
 const hasCost=/采购价|进货价|采购成本|商品成本|货品成本|成本|毛利|净利|利润|\b(?:cost|cogs|profit|margin)\b|purchase\s+price/i.test(words);
 if(profit&&!hasCost)return {concept:'利润',missing:'商品成本或已登记的利润字段',reason:'普通销售单价不是采购成本，不能据此估算利润或毛利率'};
 const goalQ=q.replace(/(?:不算|不计算|不要|不用|忽略)[^，。；]{0,16}(?:计划|目标|预算|达成率|完成率)[^，。；]*/g,'');
 const goal=/(?:计划|目标|预算)(?:销售|销量|成交|收入|金额|值|数|\s*GMV)|达成率|完成率|(?:达成|完成|占)[^，。；]{0,24}(?:计划|目标|预算)|(?:计划|目标|预算)(?:的)?(?:百分|比例|多少)|\b(?:target|goal|budget|plan)\s+(?:attainment|achievement|completion|sales|revenue)|\b(?:percent(?:age)?|fraction|ratio)[^.]{0,32}\b(?:target|goal|budget|plan)\b/i.test(goalQ);
 const tableNames=(registry.tables||[]).flatMap(t=>[t.name,t.display||'']);for(const p of registry.packDefs||[])for(const [t,n]of Object.entries(p._meta?.table_names||{}))if(registry.tables.some(x=>x.name===t))tableNames.push(n);
 if(goal&&!/计划|目标|预算|达成率|完成率|\b(?:targets?|goals?|budgets?|plans?)\b|(?:attainment|achievement|completion)\s+(?:rate|ratio|percent)/i.test(words+' '+tableNames.join(' ').replace(/[_-]/g,' '))){
  const ambiguousSummary=/汇总|预聚合|\b(?:summary|rollup)\b|(?:^|_)(?:summary|rollup)(?:_|$)/i.test(tableNames.join(' '));
  return {concept:'目标或计划',missing:'目标、计划或预算字段',reason:'实际发生值不能当作目标值；请确认计划数据来源和口径后重算',local_clarify:ambiguousSummary,code:ambiguousSummary?'goal_source_unconfirmed':undefined};
 }
 const fee=/运费|物流费|快递费|配送费|运输费|邮费|shipping\s+(?:fee|cost)|freight/i.test(q);
 if(fee&&!/运费|物流费|快递费|配送费|运输费|邮费|\b(?:shipping|freight|postage)\b/i.test(words))return {concept:'运费',missing:'物流运费字段',reason:'销售额不是物流费用，不能拿销售额顶替'};
 const identityQ=q.replace(/(?:不做|不作|不进行|无需|不要|不用|不要求)[^，。；（）]{0,40}去重/g,'');
 const identity=/(?:跨天|跨日|跨设备|跨浏览器|跨分段|跨段)[^。；]{0,60}(?:去重|真人)|去重[^。；]{0,30}(?:跨天|跨日|跨设备|跨浏览器)/.test(identityQ)&&/访客|用户|真人/.test(identityQ);
 const hasIdentity=/访客(?:ID|标识|编号)|用户(?:ID|标识|编号)|客户(?:ID|标识|编号)|\b(?:user|visitor|client|customer|person|device|cookie)[ _]?(?:id|identifier|key|pseudonym)\b/i.test(words);
 if(identity&&!hasIdentity)return {concept:'跨段访客去重',missing:'访客或用户标识',reason:'每日或设备浏览器分段只有汇总人数，汇总值相加或整行去重都不是跨段真人去重'};
 const exactRounded=/已舍入|舍入|四舍五入/.test(q)&&/绝对精确|精确(?:的)?(?:真实)?[^，。；]{0,10}(?:次数|跳出次数)/.test(q.replace(/不是[^，。；]{0,20}精确[^，。；]*/g,''));
 // 率字段和自动派生的近似计数都不是原始次数；这里只核实际列名。
 const rawColumns=(registry.tables||[]).flatMap(t=>(t.columns||[]).map(c=>c.name)).join(' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ');
 if(exactRounded&&/跳出|Bounce Rate/i.test(q)&&!/跳出次数|\bbounces\b|\bbounce\s+count\b/i.test(rawColumns))return {concept:'精确跳出次数',missing:'未舍入的真实跳出次数或逐次访问记录',reason:'已舍入的跳出率不能保证还原绝对精确的真实跳出次数',local_reject:true};
 return null;
}
module.exports={missingRequiredInput};
