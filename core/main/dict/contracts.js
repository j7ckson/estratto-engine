// ================= 指标契约（第二轮能力补齐 / T2）=================
// 目的：让「指标」能当契约用，而不只是一个名字 + 一句话说明。
//   每个指标补成五字段：说明(desc) / 计算方式(calc：分子、分母、过滤条件) / 单位(unit) / 时间角色(time_role) / 常见易错点(caveats)。
//
// 数据来源与边界（重要，别在这里猜业务口径）：
//   · 出厂词典 main/dict/metrics.js（436 条）：agg / unit / num / den / mul / defs / ambiguous 全是已有定义，
//     本模块只做「结构化整理 + 说明补全 + 易错点归纳」；业务上没定的（币种、含不含退款、分母是谁、
//     自然月还是发货日……）一律不猜，只在条目上挂 pending 编号，指向 T2-口径待定清单（P01–P29）。
//   · 语义包 main/semantic/*.json（60 条）：kind / expr / num / den / mul / dataset / additivity 是已有定义，
//     本模块按这些结构推计算方式与时间角色；包内指标原缺 desc，已在包 JSON 里补（只加说明字段）。
//   · 不改 metrics.js 的任何 key、不改语义：contract 是「覆盖层」，读不改写；词典自检照旧。
//
// 导出：
//   contractOf(idOrEntry)  -> 完整契约（五字段 + pending + certain）
//   specOf(idOrEntry)      -> 同上（别名，人读用）
//   shortSpec(idOrEntry)   -> {calc,time_role,caveats} 短版（字符串，给候选卡片）
//   cardOf(idOrEntry,o)    -> {id,name,unit,spec:{calc,time_role,caveats}} 候选卡片用（省 token）
//   cardLine(idOrEntry)    -> 一行字符串（更省 token 的兜底格式）
//   auditContracts()       -> 五字段齐全率审计（JSON 可序列化）
//   pendingList()          -> 口径待定清单（P01–P29）
//   defaultFor(idOrEntry)  -> 该条目挂的待定项的默认口径（default / default_rule / calib_note）
//   PENDING / cardFields   -> 常量
//
// CLI：node main/dict/contracts.js           人读汇总
//      node main/dict/contracts.js --json    打印审计 JSON
'use strict';
const path = require('node:path');
const D = require('./metrics');

const dictById = new Map(D.map(e => [e.id, e]));
const FIVE_FIELDS = ['desc', 'calc', 'unit', 'time_role', 'caveats'];

/* ============================================================
 * 一、口径待定清单（P01–P29）：业务口径没定的，挂编号，不猜
 *    与 artifacts/T2-口径待定清单.md 同编号；来源标 G3#n = 第一轮窗口2 G3 已列 8 条
 * ============================================================ */
const PENDING = [
  { id: 'P01', title: '币种与汇率折算', question: '金额类指标用哪个币种显示/比较？跨币种怎么折算（交易日汇率还是期末汇率）、汇兑损益是否计入利润？', scope: '词典所有 unit 含「元」的指标（108 条）+ 语义包 GBP/USD 指标 + exchange_rate/fx_loss', source: 'G3#1；本轮复核', priority: 'P0' },
  { id: 'P02', title: '金额类指标的统计范围', question: 'GMV/销售额/收入/成本/利润/退款额/优惠额 是否含未付款、取消、退款退货、运费、平台费？含税还是未税？', scope: 'gmv,sales,net_sales,revenue,paid_amount,refund_amount,discount_amount,cogs,gross_profit,net_profit,profit,contribution,settlement,tpv,ad_sales,ad_gmv,ship_revenue,room_revenue 等', source: '词典 gmv/sales/profit 的 defs；G3#3；本轮', priority: 'P0' },
  { id: 'P03', title: '收入确认口径', question: '收入按开票、发货、签收还是收款确认？跨期怎么切？', scope: 'revenue,fin_revenue,ship_revenue,room_revenue,member_sales', source: '本轮（词典 revenue 说明只有一句）', priority: 'P1' },
  { id: 'P04', title: '利润率/毛利率的成本范围', question: '毛利扣哪些成本？cost 是否含运费、平台费、退款、税？净利再扣哪些？', scope: 'profit,profit_margin,gross_profit,gross_margin,net_profit,net_margin,contribution,contribution_rate,operating_margin,fin_gross_profit,fin_net_profit,fin_gross_margin,fin_net_margin,ship_margin', source: '词典 profit/defs；G3#3', priority: 'P0' },
  { id: 'P05', title: '退货率/退款率的默认分母', question: '「退货率」「退款率」默认用 金额/订单/件数 哪个口径？两种指标同时存在时怎么自动选？', scope: 'return_rate,refund_rate,refund_amount,returns,returned_shipments,rts_rate；语义包 m:refund_rate,m:order_return_rate', source: 'G3#2；词典 return_rate 的 defs', priority: 'P0' },
  { id: 'P06', title: '百分比指标的百分点换算是否写进语义包', question: 'derived 分数形态的 % 指标（gross_margin/sell_through）是否显式写 percent_scale=100？', scope: '语义包 m:gross_margin,m:sell_through（词典侧 mul 已声明，不需要）', source: 'G3#4', priority: 'P1' },
  { id: 'P07', title: '半可加/快照指标的取数规则', question: '库存、余额、会员数、门店数这类时点值：取期末、日均还是最新快照？跨表分组如何预聚合？', scope: '词典 34 条 stock + 全部含 stock 腿的比率；语义包 stock_qty/stock_value/age_180_qty/sku 表全部指标', source: 'G3#6；本轮', priority: 'P0' },
  { id: 'P08', title: '时间对比的对齐口径', question: '月/季/年同比按「年份+1」还是日期偏移？日/周同比遇上闰日、周边界怎么对齐？缺对比期如何报？', scope: 'yoy,mom,growth_rate 及所有 comparison 计划', source: 'G3#5；第一轮失分归因「跨期比率」', priority: 'P1' },
  { id: 'P09', title: '计划值/目标值的来源与口径', question: '目标值/预算/计划值来自哪张表？按什么周期下发？达成率分母是目标合计还是期末目标？', scope: 'target,budget,achievement,budget_usage,variance,breakeven', source: 'G3#7；词典 defs', priority: 'P1' },
  { id: 'P10', title: '计数类的中文量词是否写进单位', question: '订单数/点击数/人数等是否在 unit 里写「单/次/人」？语义包 19 个计数指标目前无 unit。', scope: '语义包无 unit 的计数/比值指标；词典 dcount 与计数类 sum', source: 'G3#8', priority: 'P2' },
  { id: 'P11', title: '客单价的分母', question: '销售额 ÷ 订单数，还是销售额 ÷ 买家数？按人算的客单价什么时候用？', scope: 'aov,avg_price,sales_per_buyer,live_aov', source: '词典 aov 的 defs', priority: 'P0' },
  { id: 'P12', title: '转化率的分子', question: '支付买家数、订单数还是点击数？站点转化率与广告转化率怎么区分？', scope: 'cvr,ad_cvr,usp,inquiry_cvr,close_rate,live_cvr；语义包 m:cvr,m:conversion', source: '词典 cvr 标了 ambiguous；本轮', priority: 'P0' },
  { id: 'P13', title: 'ROI/ROAS 的收益定义与归因窗口', question: 'ROI 用利润、广告销售额还是毛利？ROAS 是否等同 ROI？广告归因窗口多长、跨表 N:N 怎么归因？', scope: 'ad_roi,roas,live_roi,tacos,ad_sales_share,ad_gmv；语义包 m:roas,m:acos,m:ad_gmv', source: '词典 ad_roi 的 defs；本轮', priority: 'P0' },
  { id: 'P14', title: 'CPA/转化成本的分母', question: '「一次转化」按订单、注册还是线索？', scope: 'cpa,cpo,cpl,cac,cpi,cpe,cpv,cpc；语义包 m:cpa', source: '词典 cpa 的 defs', priority: 'P1' },
  { id: 'P15', title: '互动率的分母', question: '互动量 ÷ 曝光量，还是互动量 ÷ 粉丝数？', scope: 'engagement_rate', source: '词典 engagement_rate 的 defs', priority: 'P2' },
  { id: 'P16', title: '售罄率的公式', question: '销量 ÷ 进货量，还是 销量 ÷（销量 + 期末库存）？', scope: 'sell_through；语义包 m:sell_through', source: '词典 sell_through 的 defs', priority: 'P1' },
  { id: 'P17', title: '可售天数的分子分母', question: '期末库存 ÷ 日均销量，还是 平均库存 ÷ 日均销售成本？「日均」怎么算（自然日还是营业日）？', scope: 'dos,woc,daily_sales,weekly_sales；语义包 m:days_of_supply', source: '词典 dos 的 defs', priority: 'P1' },
  { id: 'P18', title: '周转类指标的平均库存与成本口径', question: '平均库存按（期初+期末）/2 还是按日均？周转率用销售成本还是销售额？周转天数按 360 还是 365 天？', scope: 'inv_turnover,dio,ccc,turnover,dso,dpo,daily_cogs,daily_revenue；语义包 m:turnover', source: '本轮（词典只写公式，没写平均方法）', priority: 'P1' },
  { id: 'P19', title: '预测准确率/误差的公式与加权', question: '1 − Σ|误差| ÷ Σ实际，还是 实际 ÷ 预测？MAPE/WAPE 跨组是否按实际量加权？', scope: 'forecast_accuracy,mape,forecast_bias,forecast_qty', source: '词典 forecast_accuracy 的 defs', priority: 'P2' },
  { id: 'P20', title: '留存/流失的分母与观察窗口', question: '留存率分母是期初用户还是当期新增？MRR 留存用期初还是期末基数？N 天/月的观察窗口怎么定？', scope: 'retention_rate,churn_rate,grr,nrr,mrr,arr,retained_mrr,churned_mrr,new_mrr；语义包无', source: '词典 grr/nrr/churn_rate；本轮', priority: 'P1' },
  { id: 'P21', title: '新客/复购的判定窗口', question: '「新客」按首次购买还是首次注册？复购按两次及以上、观察窗口多长？', scope: 'new_buyers,old_buyers,repeat_buyers,repurchase_rate,repurchase_cycle,new_buyer_share,cac', source: '本轮（词典只有一句话）', priority: 'P1' },
  { id: 'P22', title: '去重指标的统计窗口', question: '访客/买家/活跃用户的去重窗口（天/月）怎么定？日活能否相加成月活？', scope: '词典 18 条 dcount（buyers,visitors,active_users…）', source: '词典 active_users 说明；本轮', priority: 'P1' },
  { id: 'P23', title: '去重指标的实体键', question: '「买家数」按买家ID、账号还是手机号？跨店铺/跨渠道是否合并去重？', scope: 'buyers,visitors,reach,sku_count,oos_skus,active_users,paying_users；语义包 m:refund_order_count', source: '本轮', priority: 'P1' },
  { id: 'P24', title: '退款/退货的时间归属', question: '退款金额/退货按退款发生日还是原订单日归属？跨期比率（本期退款 ÷ 本期销售额）的分母用哪一期？', scope: 'refund_amount,refund_rate,returns,return_rate,returned_shipments,rts_rate,chargebacks,chargeback_rate,net_sales,settlement；语义包 m:refund_rate,m:order_return_rate,m:refund_amount', source: '本轮（第一轮「跨期比率」20 题失分相关）', priority: 'P0' },
  { id: 'P25', title: '「准时」的判定基准', question: '准时发货/准时送达/时效达成按承诺时效、平台要求还是合同？分母是全部订单还是已发货订单？', scope: 'ontime_shipments,ontime_ship_rate,otif,otif_orders,ontime_delivered,ontime_delivery_rate,delivery_rate,ship_time,transit_time,lead_time；语义包 m:on_time_rate', source: '本轮', priority: 'P1' },
  { id: 'P26', title: '费用类指标的含税与归集层', question: '佣金/手续费/仓储费/配送费 含税与否？计入毛利、营业利润还是净利润？', scope: 'commission,take_rate,fees,fee_rate,storage_fee,lts_fee,fba_fee,shipping_fee,ad_spend,sponsored_spend,fin_opex,fin_fees', source: 'G3#3 延伸；本轮', priority: 'P1' },
  { id: 'P27', title: '平台口径指标的聚合方式', question: 'ODR/LSR/VTR/BSR/BuyBox/店铺评分 是平台按滚动窗口算的，指定期间时取最新值还是重算？能不能按分组相加？', scope: 'odr,lsr,vtr,bsr,buybox_rate,buybox_views,listing_quality,star_rating,store_rating,top_is_rate,impression_share', source: '本轮', priority: 'P2' },
  { id: 'P28', title: '物流重量/体积口径', question: '实重、体积重、计费重哪个作为重量指标？kg 与立方米换算系数（6000/5000）用哪个？', scope: 'weight,volume,capacity_volume,load_factor,cost_per_kg；语义包 m:chargeable_weight,m:cost_per_kg', source: '本轮', priority: 'P2' },
  { id: 'P29', title: '税务口径', question: '含税/未税用哪个？VAT/GST/销售税/消费税是否单列？tax_rate 的计税金额是什么？', scope: 'tax,tax_rate,vat_amount,gmv,sales,revenue', source: '本轮', priority: 'P1' },
];
const PENDING_BY_ID = new Map(PENDING.map(p => [p.id, p]));

/* ============================================================
 * 一点五、默认口径（10-23 jackson 定）：29 项不逐条问，每项先按「行业最常见做法」给一个默认；
 *    default      一句话默认口径（给人看、给答案写明）
 *    default_rule 结构化规则（给代码读：分母用谁、取哪天、汇率按哪天……）
 *    calib_note   答案里怎么写明（模型照着这句话告诉用户“我按什么算的”）
 *    brief        ≤14 字的极短版（候选卡片里用，省 token）
 *    用户觉得不对，在公式块里改那一条就行；改了以后以用户的为准。
 * ============================================================ */
const DEFAULTS = {
  P01: { default: '金额按数据原币种显示，不自动换汇；不同币种不相加，答案写明币种', default_rule: { currency: 'as_is', fx: null, cross_currency_sum: false, state_currency: true }, calib_note: '金额按数据原币种（不换汇），币种：{币种}', brief: '原币种不换汇' },
  P02: { default: '销售额/GMV 含已付款订单、含运费、不扣退款，含税与否按数据原样（答案写明）；「净销售额」才扣退款', default_rule: { include_status: 'paid', include_shipping: true, deduct_refund: false, deduct_refund_metrics: ['net_sales'], tax: 'as_is', state_tax: true }, calib_note: '按已付款订单、含运费、未扣退款；税按数据原样（{含税/未税}）', brief: '已付款含运费不扣退款' },
  P03: { default: '收入按订单（发货）日期确认', default_rule: { recognize_on: 'order_date', alt: 'ship_date' }, calib_note: '收入按订单（发货）日期归属到哪一天', brief: '收入按订单日' },
  P04: { default: '毛利 = 销售额 − 商品成本（不含运费、平台费、广告）；净利再扣其余费用', default_rule: { gross_profit: 'sales - cogs', exclude_from_gross: ['shipping', 'platform_fee', 'ad_spend'], net_profit: 'gross_profit - other_expenses' }, calib_note: '毛利 = 销售额 − 商品成本（不含运费、平台费、广告）', brief: '毛利只扣商品成本' },
  P05: { default: '退货率默认按金额（退款额 ÷ 销售额）；问「退货单数比例」才按订单数', default_rule: { den: 'sales', num: 'refund_amount', by: 'amount', order_variant_on: ['退货单数', '退货订单'] }, calib_note: '按金额口径：退款额 ÷ 销售额', brief: '退货率按金额' },
  P06: { default: '百分比指标统一乘 100，按百分数显示', default_rule: { percent_scale: 100 }, calib_note: '比率按百分数显示（已乘 100）', brief: '比率乘100' },
  P07: { default: '快照类（库存、余额、会员数）：问某天取那天；问一段时间取期末那天；不跨天相加', default_rule: { snapshot: 'period_end', point_in_time: 'that_day', sum_across_days: false }, calib_note: '库存类取{日期}当天（时段取期末），不跨天相加', brief: '快照取期末不相加' },
  P08: { default: '同比按日历同期（年 +1、同月同日，闰日取 2/28）；环比按等长上一期；缺对比期就报「缺对比期」', default_rule: { yoy: 'calendar_year_plus_one', leap_day: 'feb28', mom: 'previous_equal_length', missing_baseline: 'report' }, calib_note: '同比对比{去年同期}，环比对比{上一期}；缺对比期会直接说明', brief: '同比按日历同期' },
  P09: { default: '目标值来自目标/计划表；达成率 = 实际合计 ÷ 目标合计', default_rule: { target_source: 'target_table', achievement: 'sum(actual)/sum(target)' }, calib_note: '目标取自{目标表}；达成率 = 实际合计 ÷ 目标合计', brief: '达成=实际合计÷目标合计' },
  P10: { default: '订单写「单」、人数写「人」、次数写「次」', default_rule: { units: { order: '单', people: '人', times: '次' } }, calib_note: '计数带量词：单 / 人 / 次', brief: '单/人/次' },
  P11: { default: '客单价 = 销售额 ÷ 订单数', default_rule: { num: 'sales', den: 'order_count' }, calib_note: '客单价 = 销售额 ÷ 订单数', brief: '客单价÷订单数' },
  P12: { default: '转化率 = 订单数 ÷ 访客数；广告转化率 = 转化 ÷ 点击', default_rule: { site: { num: 'order_count', den: 'visitors' }, ad: { num: 'conversions', den: 'clicks' } }, calib_note: '转化率 = 订单数 ÷ 访客数（广告转化率 = 转化 ÷ 点击）', brief: '转化=订单÷访客' },
  P13: { default: 'ROAS = 广告带来的销售额 ÷ 广告花费；ROI = (收入 − 花费) ÷ 花费；归因按平台导出的原值，不自己重算', default_rule: { roas: { num: 'ad_sales', den: 'ad_spend' }, roi: '(revenue - spend)/spend', attribution: 'platform_export', recompute: false }, calib_note: 'ROAS = 广告销售额 ÷ 广告花费；归因用平台导出的原值', brief: 'ROAS=广告销售÷花费' },
  P14: { default: 'CPA = 花费 ÷ 转化数', default_rule: { num: 'spend', den: 'conversions' }, calib_note: 'CPA = 花费 ÷ 转化数', brief: 'CPA=花费÷转化' },
  P15: { default: '互动率 = 互动量 ÷ 曝光量', default_rule: { num: 'engagements', den: 'impressions' }, calib_note: '互动率 = 互动量 ÷ 曝光量', brief: '互动÷曝光' },
  P16: { default: '售罄率 = 销量 ÷ (销量 + 期末库存)', default_rule: { num: 'units', den: 'units + ending_stock' }, calib_note: '售罄率 = 销量 ÷ (销量 + 期末库存)', brief: '售罄=销量÷(销量+库存)' },
  P17: { default: '可售天数 = 期末库存 ÷ 近 30 天日均销量（自然日）', default_rule: { num: 'ending_stock', den: 'avg_daily_units', window_days: 30, day_type: 'calendar' }, calib_note: '可售天数 = 期末库存 ÷ 近 30 天日均销量（自然日）', brief: '库存÷近30天日均销量' },
  P18: { default: '周转天数 = 平均库存 ((期初 + 期末) / 2) ÷ 日均销售成本，按 365 天', default_rule: { avg_stock: '(begin+end)/2', den: 'daily_cogs', days_in_year: 365 }, calib_note: '周转天数 = 平均库存（期初期末均值）÷ 日均销售成本，一年按 365 天', brief: '周转按平均库存365天' },
  P19: { default: '预测准确率 = 1 − Σ|预测 − 实际| ÷ Σ实际', default_rule: { formula: '1 - sum(abs(forecast-actual))/sum(actual)', weight: 'actual' }, calib_note: '预测准确率 = 1 − Σ|预测−实际| ÷ Σ实际', brief: '准确率=1−总误差÷总实际' },
  P20: { default: '留存率分母 = 期初用户数', default_rule: { den: 'begin_users', num: 'retained_users' }, calib_note: '留存率 = 留存用户 ÷ 期初用户数', brief: '留存分母=期初用户' },
  P21: { default: '新客 = 统计期内首次下单；复购 = 统计期内下单 ≥ 2 次', default_rule: { new_customer: 'first_order_in_period', repeat_min_orders: 2, window: 'period' }, calib_note: '新客指统计期内首次下单，复购指统计期内下单 ≥ 2 次', brief: '新客=期内首单' },
  P22: { default: '去重默认按所选期间去重；日活不能相加成月活', default_rule: { dedupe_window: 'period', sum_daily_to_monthly: false }, calib_note: '人数按所选期间去重（日数据不相加）', brief: '按所选期间去重' },
  P23: { default: '去重按客户/买家编号，跨店铺合并', default_rule: { dedupe_key: 'customer_id', cross_store: 'merge' }, calib_note: '人数按客户/买家编号去重，跨店铺合并', brief: '按买家编号去重' },
  P24: { default: '退款按退款发生日归属', default_rule: { refund_time: 'refund_date', den_period: 'same_period_sales' }, calib_note: '退款按退款发生日算在哪个时段', brief: '退款按退款日' },
  P25: { default: '「准时」按承诺时效判定，分母为已发货订单', default_rule: { ontime_basis: 'promised_time', den: 'shipped_orders' }, calib_note: '准时 = 在承诺时效内；分母为已发货订单', brief: '准时按承诺时效' },
  P26: { default: '费用按数据原样（含税与否答案写明），归入营业费用', default_rule: { tax: 'as_is', state_tax: true, bucket: 'operating_expense' }, calib_note: '费用按数据原样（{含税/未税}），归入营业费用', brief: '费用归营业费用' },
  P27: { default: '平台口径指标（ODR/LSR/评分等）取期末最新值，不相加', default_rule: { aggregate: 'latest', sum: false, period_pick: 'period_end' }, calib_note: '平台口径指标取{日期}最新值，不相加', brief: '平台指标取最新值' },
  P28: { default: '物流重量按计费重', default_rule: { weight_basis: 'chargeable' }, calib_note: '重量按计费重（实重与体积重取大）', brief: '重量按计费重' },
  P29: { default: '金额默认按数据原样；税单列时可算未税', default_rule: { amount: 'as_is', ex_tax_when_tax_column: true }, calib_note: '金额按数据原样（{含税/未税}）；有税额列时可换算未税', brief: '金额按原样' },
};
for (const p of PENDING) Object.assign(p, DEFAULTS[p.id] || {});

// 取一个条目挂着的待定项的默认口径（多项都返回；非词典 / 语义包条目或没挂待定项 → 空数组）
function defaultFor(idOrEntry) {
  const c = contractOf(idOrEntry);
  if (!c || !Array.isArray(c.pending)) return [];
  return c.pending.map(id => PENDING_BY_ID.get(id)).filter(p => p && p.default)
    .map(p => ({ id: p.id, title: p.title, default: p.default, default_rule: p.default_rule, calib_note: p.calib_note, brief: p.brief }));
}
// 卡片里用的极短默认口径（≤40 字）：先挑口径类（P01 币种这种全员都有的往后放），最多拼 2 项
const GENERIC_DEFAULT = new Set(['P01', 'P06', 'P10', 'P29']);
function defaultBrief(idOrEntry, maxLen = 40) {
  const list = defaultFor(idOrEntry);
  if (!list.length) return '';
  const sorted = list.filter(x => !GENERIC_DEFAULT.has(x.id)).concat(list.filter(x => GENERIC_DEFAULT.has(x.id)));
  let out = '';
  for (const x of sorted.slice(0, 2)) { const next = out ? out + '；' + x.brief : x.brief; if (next.length > maxLen) break; out = next; }
  return out;
}

/* ============================================================
 * 二、词典侧：结构可判定的规则表
 * ============================================================ */

// 不可汇总（agg=none）指标的时间角色：逐条按定义判，判不出才写「待定」
const NONE_TIME_ROLE = {
  share: '期间（同一整体下）', growth_rate: '跨期（本期 vs 上期）', yoy: '跨期（本期 vs 去年同期）', mom: '跨期（本期 vs 紧邻上期）',
  rank: '期间（按统计期排名）', score: '期间（打分，跨组按人数加权）', exchange_rate: '时点（取当时汇率）', store_rating: '时点（平台当前评分）',
  reorder_point: '时点（当前补货阈值）', mape: '跨期（预测误差，按实际量加权）', forecast_bias: '跨期（预测偏差）', ccc: '期间（周转天数组合）',
  breakeven: '期间（按本期成本结构）', ltv: '模型（生命周期估算）', ltv_cac: '模型（估算倍数）', payback: '模型（估算月数）',
  nps: '期间（用原始问卷重算）', csat: '期间（用原始问卷重算）', oee: '期间（三因子重算）', bsr: '时点（平台当前排名）',
  odr: '时点（平台滚动窗口）', lsr: '时点（平台滚动窗口）', vtr: '时点（平台滚动窗口）', listing_quality: '时点（平台当前评分）',
  quality_score: '时点（平台当前打分）', search_lost_is_budget: '期间（平台算好的份额）', search_lost_is_rank: '期间（平台算好的份额）',
  abs_top_is: '期间（平台算好的份额）', avg_position: '期间（按曝光加权）', ces: '期间（用原始问卷重算）', enps: '期间（用原始问卷重算）',
  star_rating: '时点（按评价数加权）', peak_online: '时点（统计窗内峰值）', app_rating: '时点（商店当前评分）',
};

// 不可汇总指标的计算方式（按定义写，不含业务选择）
const NONE_CALC = {
  share: '部分合计 ÷ 同一整体合计 × 100',
  growth_rate: '（本期合计 − 上期合计）÷ 上期合计 × 100',
  yoy: '（本期合计 − 去年同期合计）÷ 去年同期合计 × 100',
  mom: '（本期合计 − 紧邻上期合计）÷ 紧邻上期合计 × 100',
  rank: '按数值排序取位次（第 N 名，不能相加平均）',
  score: '取打分列数值；跨组要按人数加权平均',
  exchange_rate: '取对应时点的汇率值（不能相加）',
  store_rating: '取平台店铺评分数值（不能相加）',
  reorder_point: '按补货规则算出的库存阈值（库存降到该值就补货）',
  mape: 'Σ|实际 − 预测| ÷ Σ实际 × 100（按实际量加权）',
  forecast_bias: '（Σ预测 − Σ实际）÷ Σ实际 × 100',
  ccc: '存货周转天数 + 应收周转天数 − 应付周转天数',
  breakeven: '固定成本 ÷（1 − 变动成本率）',
  ltv: '按留存/毛利模型估算的单个客户生命周期价值',
  ltv_cac: 'LTV ÷ CAC',
  payback: 'CAC ÷ 月度毛利（回本月数）',
  nps: '推荐者占比 − 贬损者占比（用原始问卷重算）',
  csat: '满意人数 ÷ 评价人数 × 100（用原始问卷重算）',
  oee: '可用率 × 性能率 × 良率（用三项合计重算）',
  bsr: '平台类目排名值（越小越好，不能相加平均）',
  odr: '平台滚动窗口内缺陷订单 ÷ 订单数 × 100',
  lsr: '平台滚动窗口内迟发订单 ÷ 订单数 × 100',
  vtr: '平台滚动窗口内有效追踪订单 ÷ 订单数 × 100',
  listing_quality: '平台商品信息质量分（不可汇总）',
  star_rating: '按评价数加权的平均星级',
  peak_online: '统计窗内同时在线人数的最大值',
  app_rating: '应用商店评分（按评价数加权）',
};

// 结构上就没有单位的（不是缺项）：排名/比值/汇率
const NON_UNIT = { rank: '无量纲（名次）', exchange_rate: '无量纲（比值）', bsr: '无量纲（名次）' };

// 说明补全：原 desc 过短（≤8 字）的 93 条，补成可当契约的一句；仍不猜业务口径，相关处挂 P 编号
const DESC_ENRICH = {
  target: '计划要达到的数；下发周期与来源表见 P09',
  budget: '计划投入的钱；按什么周期/科目下发见 P09',
  days: '统计区间覆盖的天数；日均类指标的分母常用它',
  refund_amount: '退还给买家的钱；按退款发生日归属（跨期口径见 P24）',
  orders: '统计期内下的订单数；含不含取消/未付款见 P02',
  paid_orders: '支付状态为已付款的订单数；「已付款」以源表支付状态为准',
  units: '卖出的商品件数；与订单数（单）区分，是件单比的分母',
  favorites: '商品被收藏的次数；收藏率的分母是访客数',
  new_buyers: '首次购买的人数；首购判定窗口见 P21',
  returns: '退回的件数（按件，不是金额）；退货率分母见 P05',
  discount_amount: '从原价让给买家的优惠金额；折扣率分母是销售额',
  shipping_fee: '发货产生的物流费用；与运费收入、平台配送费区分',
  reviews: '收到的评价条数（含好评与差评）',
  positive_reviews: '评为好评的评价条数；好评标准由平台/业务定',
  negative_reviews: '评为差评的评价条数；是否含中评见平台口径',
  complaints: '收到的投诉次数；投诉率分母是订单数',
  clicks: '广告或内容被点击的次数；点击率的分母是曝光量',
  oos_days: '统计期内没货的天数；断货判定阈值见 P07',
  reorder_qty: '建议补货的件数；补货规则（安全库存/补货点）见 P07',
  po_amount: '向供应商下单采购的金额；币种见 P01',
  forecast_qty: '预测会卖出的件数；预测模型与周期见 P19',
  storage_fee: '货物存放收取的仓储费用；计费方式见 P26',
  damaged_qty: '损坏、不能销售的件数；残损率分母是入库数量',
  picks: '拣货作业的行数；拣货准确率的分母',
  correct_picks: '没有拣错的行数；拣货准确率的分子',
  rd_expense: '研发投入的费用金额；计入哪层利润见 P04',
  daily_revenue: '统计期总收入 ÷ 天数；周转天数的分母',
  quick_assets: '流动资产扣除存货后的金额；速动比率的分子',
  tax: '缴纳的税费合计；含税/未税与税种见 P29',
  paying_users: '发生过付费的用户数；付费率分母是活跃用户数',
  trials: '开通试用的数量；试用转化率的分母',
  member_sales: '会员身份买家贡献的销售额；会员销售占比的分子',
  opens: '消息/邮件被打开的次数；打开率分母是发送数',
  unsubscribes: '退订的人数；退订率分母是发送数',
  likes: '内容被点赞的次数；互动量的组成部分',
  comments: '内容收到评论的条数；互动量的组成部分',
  shares: '内容被分享/转发的次数；互动量的组成部分',
  posts: '发布的内容条数；与发布频率/互动率搭配看',
  coupons_issued: '发放出去的优惠券张数；核销率的分母',
  coupons_used: '被核销使用的优惠券张数；核销率的分子',
  inquiries: '收到的咨询次数；首次响应时长的分母',
  tickets: '创建的工单张数；积压工单是时点值',
  replied: '已回复的咨询次数；回复率的分子',
  store_area: '门店营业面积（平方米）；坪效的分母，时点值',
  new_stores: '统计期内新开的门店数；净增门店 = 新开 − 关闭',
  closed_stores: '统计期内关闭的门店数；净增门店 = 新开 − 关闭',
  guests: '到店用餐的客人次（人次可加）；人均消费的分母',
  seats_total: '门店座位数（时点值）；上座率分母需乘营业餐段',
  food_cost: '食材/原料成本金额；食材成本率分母是销售额',
  labor_cost: '员工薪酬等人力成本金额；人力成本率分母是收入',
  rent: '场地租金金额；租售比分母是销售额',
  delivery_orders: '外卖渠道的订单数；外卖占比分母是全部订单数',
  output: '生产完工的件数；良率/不良率的分母',
  good_units: '检验合格的件数；良率的分子',
  defects: '检验不合格的件数；不良率的分子',
  downtime: '设备停机的小时数；稼动率 = 运行时长 ÷ 计划时长',
  mtbf: '两次故障之间的平均运行时长（小时），不是修复时长',
  capacity: '设计/最大产能件数；产能利用率的分母',
  rework: '需要返工的件数；返工率分母是产量',
  scrap: '报废的件数；报废率分母是产量',
  shipments: '发出的运单票数；妥投/丢件/破损等比率的分母',
  delivered: '最终送达签收的票数；妥投率的分子',
  ontime_delivered: '在承诺时效内送达的票数；准时基准见 P25',
  lost: '运输中丢失的票数；丢件率分母是运单量',
  broken: '运输中破损的票数；破损率分母是运单量',
  returned_shipments: '被退回/拒收的票数；退件率分母是运单量',
  weight: '货物重量；实重/体积重/计费重口径见 P28',
  volume: '货物体积（立方米）；装载率的分子',
  capacity_volume: '可装载的最大体积；装载率的分母',
  open_positions: '待招聘的岗位数（时点值）；招聘完成率的分母',
  attendance_days: '员工实际出勤的天数；出勤率的分子',
  overtime: '加班的小时数；与人力成本一起看',
  training_hours: '组织培训的小时数；人均培训 = 总时长 ÷ 人数',
  payroll: '应发薪酬总额；人均薪酬分母是员工人数',
  vat_amount: '增值税税额；含税/未税口径见 P29',
  live_duration: '单场或统计期内直播的小时数；小时成交额的分母',
  transactions: '支付交易的总笔数；支付成功率的分母',
  fees: '支付通道或平台收取的手续费金额；费率分母是交易额',
  loan_amount: '发放出去的贷款金额；与贷款余额（时点）区分',
  bad_debt: '确认收不回来的坏账金额；是否已核销见财务口径',
  downloads: '应用被下载的次数；与安装量区分',
  installs: '应用被安装的次数；CPI 的分母',
  crashes: '应用崩溃的次数；崩溃率分母是启动次数',
  app_rating: '应用商店当前评分（时点值）；多版本按评价数加权',
  rooms_sold: '售出的房间间夜数；入住率/平均房价的分母',
  room_revenue: '客房收入金额；RevPAR/ADR 的分子',
  completions: '完成课程的人数；完课率分母是报名人数',
  outpatient_visits: '门诊接诊人次（可加）',
  bed_days_available: '统计期内可用床日总数；床位使用率的分母',
  discharges: '出院人数；平均住院日的分母',
  visits_property: '客户到访项目的批次/人次；来访成交率的分母',
  units_sold_property: '成交签约的套数；去化率的分子',
  units_launched: '推出销售的套数；去化率的分母',
  page_views: '页面被浏览的次数；浏览量（PV）与访客数（UV）区分',
  new_listings: '统计期内新上架的商品数；与在售 SKU 数（时点）区分',
  disputes: '发生纠纷的订单数；纠纷率分母是订单数',
  ad_spend: '投放广告花的钱；含平台站内与站外，费用范围见 P26',
  video_completes: '视频被完整看完的次数；完播率的分子',
  ad_revenue_pub: '媒体/流量方卖广告位挣到的钱；与商家广告花费方向相反',
  weekly_sales: '统计期销量 ÷ 周数；库存覆盖周数的分母',
  admin_expense: '管理公司发生的费用；计入运营费用，归集层见 P26',
  current_liabilities: '一年内要还的负债（时点值）；流动比率的分母',
  renewals: '到期后续约的合同/订阅数；续约率分母是到期数',
  activations: '注册后真正开始使用的人数；激活率的分子',
  table_count: '门店餐桌总数（时点值）；翻台率的分母',
  waste: '浪费/报废的金额；损耗率分母是食材成本',
  mttr: '故障后平均修复时长（小时），与 MTBF（故障间隔）区分',
  watch_time: '平均每人观看的时长；人均观看 = 总时长 ÷ 观看人数',
  tpv: '经手处理的支付总金额；费率的分母',
  rooms_available: '统计期可售的房间间夜总数；入住率的分母',
  lessons_attended: '实际到课的人次；到课率的分子',
  lessons_scheduled: '排课应到的人次；到课率的分母',
  bed_days: '病床被占用的床日数；床位使用率的分子',
};

// 额外易错点：只写结构/定义里已有的坑，不写业务选择
const CAVEAT_EXTRA = {
  gmv: '口径通常含未付款、取消、退款（平台口径），与净 GMV 不同（P02）',
  sales: '含税、退款、运费口径未定，先确认（P02）',
  net_sales: '净销售额是扣退款/退货/折让后的口径，别与销售额混用',
  paid_amount: '支付金额按「实际付款」算，与下单金额（缩单/取消前）不同',
  refund_rate: '金额口径退款率；订单口径叫法也叫「退货率」，先确认（P05）',
  return_rate: '件数口径退货率；还有订单口径、金额口径（P05）',
  aov: '按单客单价；按人客单价是 sales_per_buyer（P11）',
  avg_price: '均价 = 销售额 ÷ 销量；与「单价」取数方式不同',
  unit_price: '单价是平均型指标，不能把各行单价相加（P11）',
  cvr: '分子可能是买家数、订单数或点击数，一词多义（P12）',
  profit_margin: '分子用哪种利润要先定（毛利/营业/净）（P04）',
  gross_profit: '毛利 = 销售额 − 商品成本；成本范围见 P04',
  net_profit: '净利要扣哪些费用/税见 P04',
  ad_roi: 'ROI 的收益口径有多种，有的公司直接等同 ROAS（P13）',
  roas: 'ROAS 只算广告归因销售额，归因窗口见 P13',
  acos: 'ACOS 是 ROAS 的倒数（广告花费 ÷ 广告销售额）',
  cpa: '「一次转化」按订单还是注册/线索，先确认（P14）',
  dos: '分子是期末库存还是平均库存、分母是销量还是成本，见 P17',
  inv_turnover: '平均库存怎么算、用成本还是售价，见 P18',
  dio: '平均库存与日均成本口径见 P18',
  dso: '平均应收与日均收入的口径见 P18',
  dpo: '平均应付与日均采购成本的口径见 P18',
  ccc: '由三个周转天数组合，三个口径要一致（P18）',
  active_users: '日活不能相加成月活，去重窗口见 P22',
  visitors: '跨天直接相加会重复算人（P22）',
  buyers: '跨店铺/渠道是否合并去重见 P23',
  repeat_buyers: '复购判定窗口与次数见 P21',
  retention_rate: '分母是期初用户还是新增用户见 P20',
  churn_rate: '分母是期初客户还是平均客户见 P20',
  nrr: '留存口径有公式差异，见 P20',
  grr: '不含扩展收入，与 NRR 区分（P20）',
  mrr: 'MRR 是时点水位，跨月不能相加（P07/P20）',
  arr: 'ARR = MRR × 12，是时点年化值，不是年度累计收入',
  stock_qty: '快照值：跨天不能相加，取期末或日均（P07）',
  stock_value: '库存金额的单价口径（成本价/售价）见 P07',
  slow_stock: '「长期卖不动」的库龄阈值见 P07',
  cash: '时点余额，跨期不能相加（P07）',
  ar: '平均应收口径见 P18',
  ap: '平均应付口径见 P18',
  equity: '时点值；ROE 分母常用平均净资产（P07/P18）',
  total_assets: '时点值；ROA 分母常用平均总资产（P07/P18）',
  current_ratio: '缩写 CR 与点击率冲突，按中文名认；分子分母同一时点',
  quick_ratio: '分子扣存货，与流动比率区分',
  achievement: '达成率 = 实际 ÷ 目标；目标口径见 P09',
  budget_usage: '预算使用率分母是预算，口径见 P09',
  variance: '差异 = 实际 − 目标/预算，正负号方向见 P09',
  tax: '含税/未税与税种见 P29',
  tax_rate: '分母（计税金额）是含税还是未税见 P29',
  payback: '回本周期按毛利还是净利折算见 P04/P20',
  ltv: 'LTV 是模型估算值，不能相加（P04/P20）',
  nps: '要用原始问卷重算，不能对推荐值取平均',
  csat: '要用原始问卷重算，不能对满意率取平均',
  oee: '要用三项合计重算，不能对 OEE 取平均',
  odr: '平台滚动窗口口径，指定期间取最新值（P27）',
  lsr: '平台滚动窗口口径（P27）',
  vtr: '平台滚动窗口口径（P27）',
  bsr: '排名值越小越好，不能相加平均（P27）',
  buybox_rate: '平台口径比率，不能按分组相加（P27）',
  star_rating: '多组星级要按评价数加权（P27）',
  store_rating: '平台时点评分，不能相加（P27）',
  forecast_accuracy: '公式有多种（1−MAPE / 实际÷预测），见 P19',
  mape: '跨组按实际量加权，不能对各组 MAPE 平均（P19）',
  forecast_bias: '正负号表示预测偏高/偏低（P19）',
  sell_through: '公式有两种（÷进货量 或 ÷(销量+期末库存)），见 P16',
  fx_loss: '已实现/未实现汇兑是否入账见 P01',
  exchange_rate: '汇率是时点值，跨期比较要用同一来源（P01）',
};

/* ============================================================
 * 三、语义包侧：结构规则 + 逐条覆盖
 * ============================================================ */
const PACK_FILES = ['retail-core', 'ads', 'live', 'inventory', 'logistics', 'finance'];
const PACKS = PACK_FILES.map(id => require(path.join(__dirname, '..', 'semantic', id + '.json')));
const semRaw = new Map();      // 裸 id -> { pack, m }
const semByKey = new Map();    // 'm:id' -> { pack, m }
const semAll = [];
for (const pack of PACKS) for (const m of (pack.metrics || [])) {
  semRaw.set(m.id, { pack, m });
  semByKey.set('m:' + m.id, { pack, m });
  semAll.push({ pack, m });
}
const semName = id => (semRaw.get(String(id)) || {}).m ? semRaw.get(String(id)).m.name : String(id);
const semMetric = id => (semRaw.get(String(id)) || {}).m || null;

// 数据集 → 时间角色（结构：哪个日期列 / 有没有日期列）
const SEM_DATASET_TIME = {
  orders: '期间（按下单日期）', refunds: '期间（按退款日期）', ads: '期间（按广告日期）',
  live_sessions: '期间（按直播场次日期）', shipment: '期间（按运单日期）', pl: '期间（按损益月份）',
  sku: '时点（快照，SKU 表无日期列）',
};
const SEM_STOCK_IDS = new Set(['stock_qty', 'stock_value', 'age_180_qty']);

// 逐条：语义包业务口径没定的挂 P 编号（结构能定的不挂）
const SEM_PENDING = {
  gmv: ['P02'], cost: ['P02', 'P04'], gross_margin: ['P04', 'P06'],
  refund_amount: ['P05', 'P24'], refund_rate: ['P05', 'P24'], refund_order_count: ['P05', 'P23', 'P24'], order_return_rate: ['P05', 'P24'],
  aov: ['P11'], ad_spend: ['P01', 'P26'], ad_conversions: ['P12'], cvr: ['P12'], cpa: ['P14'],
  ad_gmv: ['P02', 'P13'], roas: ['P13'], acos: ['P13'],
  live_gmv: ['P02'], viewers: ['P22', 'P23'], gift_value: ['P01'], conversion: ['P12'], live_aov: ['P11'],
  stock_qty: ['P07'], stock_value: ['P07', 'P18'], daily_sales: ['P17'], days_of_supply: ['P07', 'P17'],
  sell_through: ['P16', 'P06'], turnover: ['P18'], age_180_qty: ['P07'], deadstock_ratio: ['P07', 'P18'],
  stockout_sku: ['P07'], replenish_qty: ['P07'],
  ship_revenue: ['P01', 'P02'], ship_cost: ['P01', 'P02'], ship_gross_profit: ['P01', 'P02'], ship_margin: ['P02', 'P04'],
  chargeable_weight: ['P28'], cost_per_kg: ['P01', 'P28'], on_time_rate: ['P25'],
  fin_revenue: ['P01', 'P03'], fin_cost: ['P01', 'P04'], fin_opex: ['P01', 'P26'], fin_fees: ['P01', 'P26'],
  fin_gross_profit: ['P01', 'P02', 'P04'], fin_net_profit: ['P01', 'P02', 'P04'],
  fin_gross_margin: ['P01', 'P04'], fin_net_margin: ['P01', 'P04'],
};
// 逐条：语义包补充易错点（结构/包定义里能看出来的）
const SEM_CAVEAT = {
  refund_rate: '退款金额 ÷ 销售额（跨表），与订单口径退货率不同（P05）',
  order_return_rate: '退款订单数 ÷ 订单数，与金额口径退款率不同（P05）',
  aov: '分母是订单数；按人客单价另算（P11）',
  gross_margin: '毛利扣哪些成本由 cost 定义决定（P04）',
  roas: '订单↔广告是 N:N（无归因键），不能按平台/活动分组',
  acos: 'ACOS = 广告花费 ÷ 广告 GMV，是 ROAS 的倒数',
  ad_gmv: '广告归因销售额，归因窗口见 P13',
  cpa: '转化按 ad_conversions 定义（P14）',
  cvr: '分母是点击（广告口径），与站点转化率不同（P12）',
  conversion: '直播转化率分母是观看人次（P12）',
  viewers: '观看人次与观看人数不同，去重窗口见 P22',
  days_of_supply: '期末库存 ÷ 日均销量；口径见 P17',
  sell_through: '销量 ÷（销量 + 期末库存）；另一口径是 ÷进货量（P16）',
  turnover: '周期销售额 ÷ 期末库存金额，非财务口径周转率（P18）',
  stock_qty: '快照值：跨天不能相加（P07）',
  stock_value: '库存金额按成本价还是售价见 P07',
  age_180_qty: '库龄 ≥180 天阈值由包定义（P07）',
  on_time_rate: '「准时」基准见 P25',
  cost_per_kg: '重量口径（实重/计费重）见 P28',
  ship_margin: '成本仅含渠道成本，费用范围见 P02/P04',
  fin_net_profit: '净利 = 毛利 −（运营费用 + 平台费用）；不含税？（P04）',
};

/* ============================================================
 * 四、构造契约
 * ============================================================ */
const AGG_CAVEAT = {
  sum: '可加：跨组/跨期直接相加（前提是同一口径）',
  avg: '平均型：不能对各组均值再平均，要按量加权（总时长 ÷ 次数）',
  dcount: '去重计数：跨天/跨组直接相加会重复计数，要先并集去重',
  stock: '存量/快照：跨天不能相加，看期末或日均',
  ratio: '比率：分子分母各自先聚合再相除，不能对各组比率求平均',
  none: '不可汇总：不能相加/平均，要按定义重算',
};

function dictTimeRole(e, numLeg, denLeg) {
  if (e.agg === 'stock') return '时点（期末/最新快照）';
  if (e.agg === 'avg') return '期间（均值，按量加权）';
  if (e.agg === 'ratio') {
    const legs = [numLeg, denLeg].filter(Boolean);
    const stock = legs.filter(x => x.agg === 'stock').length;
    if (stock === 2) return '时点（同一时点）';
    if (stock === 1) return '混合（时点 ÷ 期间）';
    return '期间';
  }
  if (e.agg === 'none') return NONE_TIME_ROLE[e.id] || '待定';
  return '期间';
}

function dictCalc(e, numLeg, denLeg) {
  const filter = [];
  const mk = (o) => Object.assign({ filter }, o);
  if (e.agg === 'ratio') {
    const mulTxt = e.mul === 100 ? ' × 100' : e.mul === 1000 ? ' × 1000' : '';
    const text = `${numLeg ? numLeg.zh : e.num} ÷ ${denLeg ? denLeg.zh : e.den}${mulTxt}`;
    return mk({ type: 'ratio', num: e.num, den: e.den, mul: e.mul || 1, text, alternatives: e.defs || [] });
  }
  if (e.agg === 'sum') return mk({ type: 'sum', text: `直接相加 Σ ${e.zh}（可加）` });
  if (e.agg === 'dcount') return mk({ type: 'dcount', text: `按实体去重计数 COUNT(DISTINCT ${e.zh})` });
  if (e.agg === 'avg') return mk({ type: 'avg', text: `按行求平均 AVG(${e.zh})；跨组要按量加权` });
  if (e.agg === 'stock') return mk({ type: 'stock', text: `取时点值（期末/快照）${e.zh}；跨期不可加` });
  if (e.agg === 'none') return mk({ type: 'non_additive', text: NONE_CALC[e.id] || `按定义直接取值（${e.zh}），不可汇总`, alternatives: e.defs || [] });
  return mk({ type: 'unknown', text: `按定义取数（${e.zh}）` });
}

function dictCaveats(e, numLeg, denLeg) {
  const out = [AGG_CAVEAT[e.agg] || '按定义取数'];
  if (e.agg === 'ratio') {
    const legs = [numLeg, denLeg].filter(Boolean);
    if (e.defs) out.push(`口径有多种：${e.defs.join('；')}，先确认（见待定清单）`);
    if (legs.some(x => x.agg === 'stock')) out.push('分子或分母是时点值，跨期比较要先定快照口径（P07）');
    if (legs.some(x => x.agg === 'avg')) out.push('分子或分母是均值，汇总要按量重算（P18）');
    if (legs.some(x => x.agg === 'dcount')) out.push('分母是去重计数，跨组不能相加（P23）');
    if (e.ambiguous) out.push('一词多义：同名缩写可能指别的指标，按中文名/上下文确认');
  }
  if (e.agg === 'none' && e.defs) out.push(`口径有多种：${e.defs.join('；')}，先确认（见待定清单）`);
  if (CAVEAT_EXTRA[e.id]) out.push(CAVEAT_EXTRA[e.id]);
  return [...new Set(out)];
}

// 逐条：词典侧业务口径没定的挂 P 编号（结构能定的不挂；P01/P07/P18/P22/P23 由规则推）
const DICT_PENDING = {
  'share': ['P02'], 'growth_rate': ['P08'], 'yoy': ['P08'], 'mom': ['P08'],
  'target': ['P09'], 'budget': ['P09'], 'achievement': ['P09'], 'budget_usage': ['P09'], 'variance': ['P09'], 'breakeven': ['P09'],
  'gmv': ['P02'], 'sales': ['P02'], 'net_sales': ['P02', 'P24'], 'revenue': ['P02', 'P03'], 'paid_amount': ['P02'],
  'refund_amount': ['P05', 'P24'], 'refund_rate': ['P05', 'P24'], 'returns': ['P05', 'P24'], 'return_rate': ['P05', 'P24'],
  'returned_shipments': ['P24', 'P25'], 'rts_rate': ['P24', 'P25'], 'chargebacks': ['P24'], 'chargeback_rate': ['P24'], 'settlement': ['P24'],
  'discount_amount': ['P02'], 'cogs': ['P02', 'P04'], 'gross_profit': ['P02', 'P04'], 'gross_margin': ['P04'],
  'net_profit': ['P02', 'P04'], 'net_margin': ['P04'], 'profit': ['P02', 'P04'], 'profit_margin': ['P04'],
  'contribution': ['P04'], 'contribution_rate': ['P04'], 'operating_profit': ['P04'], 'operating_margin': ['P04'],
  'ebitda': ['P04'], 'ebitda_margin': ['P04'],
  'aov': ['P11'], 'avg_price': ['P11'], 'sales_per_buyer': ['P11'], 'unit_price': ['P11'],
  'cvr': ['P12'], 'ad_cvr': ['P12'], 'usp': ['P12'], 'inquiry_cvr': ['P12'], 'close_rate': ['P12'], 'live_cvr': ['P12'],
  'roas': ['P13'], 'ad_roi': ['P13'], 'tacos': ['P13'], 'ad_sales_share': ['P13'], 'ad_sales': ['P02', 'P13'],
  'cpa': ['P14'], 'cpo': ['P14'], 'cpl': ['P14'], 'cac': ['P14', 'P21'], 'cpi': ['P14'],
  'engagement_rate': ['P15'], 'sell_through': ['P16'], 'dos': ['P17'], 'woc': ['P17'], 'daily_sales': ['P17'],
  'inv_turnover': ['P18'], 'ccc': ['P18'],
  'forecast_accuracy': ['P19'], 'mape': ['P19'], 'forecast_bias': ['P19'], 'forecast_qty': ['P19'],
  'nrr': ['P20'], 'grr': ['P20'], 'churn_rate': ['P20'], 'retention_rate': ['P20'], 'mrr': ['P20'], 'arr': ['P20'],
  'new_buyers': ['P21'], 'old_buyers': ['P21'], 'repeat_buyers': ['P21'], 'repurchase_rate': ['P21'], 'repurchase_cycle': ['P21'], 'new_buyer_share': ['P21'],
  'ontime_shipments': ['P25'], 'ontime_ship_rate': ['P25'], 'otif': ['P25'], 'otif_orders': ['P25'],
  'ontime_delivered': ['P25'], 'ontime_delivery_rate': ['P25'], 'delivery_rate': ['P25'], 'ship_time': ['P25'], 'transit_time': ['P25'], 'lead_time': ['P25'],
  'commission': ['P02', 'P26'], 'take_rate': ['P02', 'P26'], 'fees': ['P26'], 'fee_rate': ['P26'], 'storage_fee': ['P26'], 'lts_fee': ['P26'],
  'fba_fee': ['P26'], 'shipping_fee': ['P02', 'P26'], 'ad_spend': ['P26'], 'sponsored_spend': ['P26'],
  'odr': ['P27'], 'lsr': ['P27'], 'vtr': ['P27'], 'bsr': ['P27'], 'buybox_rate': ['P27'], 'buybox_views': ['P27'],
  'listing_quality': ['P27'], 'star_rating': ['P27'], 'store_rating': ['P27'], 'top_is_rate': ['P27'], 'impression_share': ['P27'],
  'weight': ['P28'], 'volume': ['P28'], 'capacity_volume': ['P28'], 'load_factor': ['P28'],
  'tax': ['P29'], 'tax_rate': ['P29'], 'vat_amount': ['P29'],
};

function dictPending(e, numLeg, denLeg) {
  const out = new Set(DICT_PENDING[e.id] || []);
  if (/元|GBP|USD|CNY|RMB|EUR|¥|￥/.test(e.unit || '')) out.add('P01');
  if (e.agg === 'stock') out.add('P07');
  if (e.agg === 'dcount') { out.add('P22'); out.add('P23'); }
  if (e.agg === 'ratio') {
    const legs = [numLeg, denLeg].filter(Boolean);
    if (legs.some(x => x.agg === 'stock')) out.add('P07');
    if (legs.some(x => x.agg === 'avg')) out.add('P18');
    if (legs.some(x => x.agg === 'dcount')) out.add('P23');
  }
  if (e.defs) {
    const map = { profit: ['P02', 'P04'], gmv: ['P02'], sales: ['P02'], aov: ['P11'], cvr: ['P12'], return_rate: ['P05'], cpa: ['P14'], ad_roi: ['P13'], engagement_rate: ['P15'], dos: ['P17'], sell_through: ['P16'], forecast_accuracy: ['P19'], nrr: ['P20'] };
    (map[e.id] || []).forEach(x => out.add(x));
  }
  return PENDING.filter(p => out.has(p.id)).map(p => p.id);
}

function buildDictContract(e) {
  const numLeg = e.num ? dictById.get(e.num) : null;
  const denLeg = e.den ? dictById.get(e.den) : null;
  const unit = e.unit || '';
  const pending = dictPending(e, numLeg, denLeg);
  return {
    id: e.id, name: e.zh, en: e.en, entity: 'metric', source: 'dict',
    desc: DESC_ENRICH[e.id] || e.desc,
    unit, unit_kind: unit ? null : (NON_UNIT[e.id] || '未声明（待定）'),
    calc: dictCalc(e, numLeg, denLeg),
    time_role: dictTimeRole(e, numLeg, denLeg),
    caveats: dictCaveats(e, numLeg, denLeg),
    pending,
    certain: pending.length === 0,
    agg: e.agg, additivity: e.agg === 'ratio' ? 'ratio' : e.agg === 'stock' ? 'semiAdditive' : e.agg === 'dcount' ? 'distinct' : e.agg === 'sum' ? 'additive' : null,
  };
}

/* ---------- 语义包 ---------- */
function renderExpr(expr) {
  if (typeof expr === 'string') return semName(expr);
  const op = { add: '+', sub: '−', mul: '×', div: '÷' }[expr.op] || String(expr.op);
  const args = (expr.args || []).map(renderExpr);
  const body = args.length === 2 ? `${args[0]} ${op} ${args[1]}` : args.join(' ' + op + ' ');
  return `(${body})`;
}
// 顶层表达式去掉一层括号：((A ÷ B)) -> A ÷ B
const stripOuter = t => {
  if (!/^\(.*\)$/.test(t)) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') { depth--; if (depth === 0 && i !== t.length - 1) return t; }
  }
  return t.slice(1, -1);
};
function leavesOfExpr(expr, out = []) {
  if (typeof expr === 'string') out.push(expr);
  else for (const a of (expr && expr.args) || []) leavesOfExpr(a, out);
  return out;
}

function semCalc(pack, m) {
  const filter = [];
  const mk = (o) => Object.assign({ filter }, o);
  if (m.kind === 'ratio') {
    const mulTxt = m.mul === 100 ? ' × 100' : m.mul === 1000 ? ' × 1000' : '';
    return mk({ type: 'ratio', num: m.num, den: m.den, mul: m.mul || 1, text: `${semName(m.num)} ÷ ${semName(m.den)}${mulTxt}` });
  }
  if (m.kind === 'derived') return mk({ type: 'expr', expr: m.expr, text: stripOuter(renderExpr(m.expr)) });
  const col = m.field || m.role || m.name;
  if (m.agg === 'count') return mk({ type: 'sum', text: `COUNT(*)（${m.dataset} 表逐行计数）` });
  if (m.agg === 'dcount') return mk({ type: 'dcount', text: `COUNT(DISTINCT ${col})（${m.dataset} 表）` });
  if (m.agg === 'avg') return mk({ type: 'avg', text: `AVG(${col})（${m.dataset} 表；跨组按量加权）` });
  if (m.agg === 'last') return mk({ type: 'stock', text: `取期末值 ${col}（${m.dataset} 表）` });
  return mk({ type: 'sum', text: `Σ ${col}（${m.dataset} 表逐行求和）` });
}

function semTimeRole(m, legs) {
  const add = m.additivity;
  if (add === 'semiAdditive') return '时点（期末快照）';
  if (m.kind !== 'simple') {
    const legStock = legs.filter(x => x.additivity === 'semiAdditive' || SEM_STOCK_IDS.has(x.id)).length;
    if (legStock && legStock === legs.length) return '时点（同一时点）';
    if (legStock) return '混合（时点 ÷ 期间）';
  }
  const ds = new Set((m.kind === 'simple' ? [m.dataset] : legs.map(x => x.dataset)).filter(Boolean));
  if (ds.size > 1) return '期间（跨表，分子分母各按自身日期）';
  return SEM_DATASET_TIME[[...ds][0]] || '期间';
}

function semCaveats(pack, m, legs, ds) {
  const out = [];
  const add = m.additivity;
  if (add === 'ratio') out.push('比率：分子分母各自聚合后再相除，不能对各组比率求平均');
  else if (add === 'semiAdditive') out.push('快照/存量：跨期不能相加，看期末或日均');
  else if (add === 'distinct') out.push('去重计数：跨天不能相加');
  else if (add === 'additive') out.push('可加：跨组/跨期直接相加（同一口径）；不能与比率/均值混算');
  if (ds.size > 1) out.push('跨表：分子分母分别在各自数据集聚合（扇出防护）');
  // N:N 关系：涉及两侧数据集时不能按对侧维度分组
  for (const rel of (pack.relationships || [])) {
    if (rel.cardinality === 'N:N' && ds.has(rel.left) && ds.has(rel.right)) {
      out.push(`${rel.left}↔${rel.right} 是 N:N（无归因键），不能按对侧维度直接分组`);
      break;
    }
  }
  if (!m.unit && !(dictById.get(m.id) || {}).unit) out.push('单位未声明（计数/比值），中文量词见 P10');
  if (SEM_CAVEAT[m.id]) out.push(SEM_CAVEAT[m.id]);
  return [...new Set(out)];
}

function semPending(m, legs, ds, unit) {
  const out = new Set(SEM_PENDING[m.id] || []);
  if (/GBP|USD|CNY|RMB|EUR|元/.test(unit || '')) out.add('P01');
  if (m.additivity === 'semiAdditive') out.add('P07');
  if (m.kind === 'derived' && unit === '%' && m.mul == null) out.add('P06');
  if (!unit) out.add('P10');
  if (ds.size > 1 && /refund/.test(m.id)) out.add('P24');
  return PENDING.filter(p => out.has(p.id)).map(p => p.id);
}

function buildSemContract(pack, m) {
  const legIds = m.kind === 'ratio' ? [m.num, m.den] : m.kind === 'derived' ? leavesOfExpr(m.expr) : [];
  const legs = legIds.map(semMetric).filter(Boolean);
  const ds = new Set((m.kind === 'simple' ? [m.dataset] : legs.map(x => x.dataset)).filter(Boolean));
  // 语义包没写 unit 时，若出厂词典有同 id 条目就沿用它的单位（结构可判定的补全，不是猜）
  const unit = m.unit || (dictById.get(m.id) || {}).unit || '';
  const pending = semPending(m, legs, ds, unit);
  return {
    id: 'm:' + m.id, raws: m.id, name: m.name, entity: 'metric', source: 'semantic', pack: pack.id, pack_name: pack.name,
    desc: m.desc || '',
    unit, unit_kind: unit ? null : (m.kind === 'ratio' && m.num ? '无量纲（比值）' : '无量纲（计数）'),
    calc: semCalc(pack, m),
    time_role: semTimeRole(m, legs),
    caveats: semCaveats(pack, m, legs, ds),
    pending,
    certain: pending.length === 0,
    agg: m.agg || m.kind, additivity: m.additivity || null, dataset: m.dataset || (legs[0] && legs[0].dataset) || null,
  };
}

/* ============================================================
 * 五、对外 API
 * ============================================================ */
const cache = new Map();
function contractOf(idOrEntry) {
  if (idOrEntry == null) return null;
  if (typeof idOrEntry === 'object') {
    if (idOrEntry.source === 'dict' || idOrEntry.source === 'semantic') return idOrEntry;
    if (idOrEntry.id != null) return contractOf(String(idOrEntry.id));
    return null;
  }
  const key = String(idOrEntry).trim();
  if (cache.has(key)) return cache.get(key);
  let c = null;
  if (semByKey.has(key)) c = buildSemContract(semByKey.get(key).pack, semByKey.get(key).m);
  else if (key.startsWith('m:')) c = null;
  else if (dictById.has(key)) c = buildDictContract(dictById.get(key));
  else if (semRaw.has(key)) { const x = semRaw.get(key); c = buildSemContract(x.pack, x.m); }
  if (c) cache.set(key, c);
  return c;
}
const specOf = contractOf;

function cardFields(idOrEntry, o = {}) {
  const c = contractOf(idOrEntry);
  if (!c) return null;
  return { id: c.id, name: c.name, unit: c.unit || '', kind: c.entity === 'metric' ? (c.source === 'semantic' ? 'semantic' : 'dict') : null };
}
const GENERIC_CAVEAT = new Set([...Object.values(AGG_CAVEAT),
  '比率：分子分母各自聚合后再相除，不能对各组比率求平均',
  '可加：跨组/跨期直接相加（同一口径）；不能与比率/均值混算']);
/** 短版：只给候选卡片要的三样（省 token，不塞 desc）；易错点优先给该指标特有的那条 */
function shortSpec(idOrEntry, o = {}) {
  const c = contractOf(idOrEntry);
  if (!c) return null;
  const n = o.maxCaveats == null ? 1 : Math.max(0, Math.min(2, o.maxCaveats));
  const specific = c.caveats.filter(x => !GENERIC_CAVEAT.has(x));
  const picked = (specific.length ? specific : c.caveats).slice(0, n);
  const out = { calc: c.calc.text, time_role: c.time_role, caveats: picked };
  const dflt = defaultBrief(c);          // 默认口径（有挂待定项才有；短）
  if (dflt) out.default = dflt;
  return out;
}
/** 候选卡片：{id,name,unit,spec:{calc,time_role,caveats}} */
function cardOf(idOrEntry, o = {}) {
  const c = contractOf(idOrEntry);
  if (!c) return null;
  const short = shortSpec(c, o);
  return { id: c.id, name: c.name, unit: c.unit || '', spec: short };
}
/** 一行字符串兜底（比对象更省 token） */
function cardLine(idOrEntry, o = {}) {
  const card = cardOf(idOrEntry, o);
  if (!card) return null;
  const cav = (card.spec.caveats || []).join('；');
  const tail = (cav ? `｜易错:${cav}` : '') + (card.spec.default ? `｜默认:${card.spec.default}` : '');
  return `${card.id} ${card.name}${card.unit ? '(' + card.unit + ')' : ''}｜${card.spec.calc}｜${card.spec.time_role}${tail}`;
}

/* ---------- 五字段审计 ---------- */
function fieldState(c) {
  const calcOk = !!(c.calc && c.calc.text) && (c.calc.type !== 'ratio' || (!!c.calc.num && !!c.calc.den));
  return {
    desc: !!(c.desc && String(c.desc).trim()),
    calc: calcOk,
    unit: !!(c.unit && String(c.unit).trim()) || !!c.unit_kind,
    time_role: !!(c.time_role && String(c.time_role).trim() && !/^待定/.test(c.time_role)),
    caveats: Array.isArray(c.caveats) && c.caveats.length > 0,
  };
}
function summarize(list, name) {
  const byField = {}; for (const f of FIVE_FIELDS) byField[f] = { present: 0, missing: 0 };
  const missing = []; const pendingBy = {}; let certain = 0; let descShort = 0; let unitMissing = 0; let unitPending = 0;
  for (const c of list) {
    const st = fieldState(c);
    let complete = true;
    for (const f of FIVE_FIELDS) { if (st[f]) byField[f].present++; else { byField[f].missing++; complete = false; missing.push({ id: c.id, field: f, why: fieldWhy(c, f) }); } }
    if (!st.unit) unitMissing++;
    if (!c.unit && /未声明/.test(String(c.unit_kind || ''))) unitPending++;
    if (complete) byField.complete = (byField.complete || 0) + 1;
    if (!c.certain) { for (const p of c.pending) pendingBy[p] = (pendingBy[p] || 0) + 1; } else certain++;
    if (c.desc && c.desc.length <= 8) descShort++;
  }
  const complete = byField.complete || 0;
  return {
    corpus: name, total: list.length, complete, incomplete: list.length - complete,
    five_field_rate: list.length ? Math.round((complete / list.length) * 10000) / 10000 : null,
    by_field: Object.fromEntries(FIVE_FIELDS.map(f => [f, { present: byField[f].present, missing: byField[f].missing, rate: list.length ? Math.round((byField[f].present / list.length) * 10000) / 10000 : null }])),
    business_certain: certain, pending_entries: list.length - certain, pending_by_id: pendingBy,
    desc_short: descShort, unit_missing: unitMissing, unit_pending: unitPending,
    missing,
  };
}
function fieldWhy(c, f) {
  if (f === 'desc') return '无说明';
  if (f === 'calc') return '无计算方式/比率缺分子分母';
  if (f === 'unit') return '单位未声明（业务待定，见 pending）';
  if (f === 'time_role') return '时间角色判不出（需业务口径）';
  if (f === 'caveats') return '无易错点';
  return '';
}

let _audit = null;
function auditContracts() {
  if (_audit) return _audit;
  const dict = D.map(buildDictContract);
  const sem = semAll.map(x => buildSemContract(x.pack, x.m));
  const all = [...dict, ...sem];
  const overall = summarize(all, 'all');
  const pendingMap = {};
  for (const c of all) for (const pid of c.pending) (pendingMap[pid] = pendingMap[pid] || []).push(c.id);
  _audit = {
    generated_at: new Date().toISOString(),
    spec_version: 'T2-metric-contract/1',
    five_fields: FIVE_FIELDS,
    pending_total: PENDING.length,
    dict: summarize(dict, 'dict'),
    semantic: summarize(sem, 'semantic'),
    overall,
    pending_map: pendingMap,
    packs: PACKS.map(p => ({ id: p.id, name: p.name, metrics: (p.metrics || []).length, metrics_with_desc: (p.metrics || []).filter(m => m.desc).length })),
  };
  return _audit;
}
function pendingList() { return PENDING.slice(); }

module.exports = {
  PENDING, PENDING_BY_ID, FIVE_FIELDS, PACKS,
  contractOf, specOf, cardFields, shortSpec, cardOf, cardLine,
  auditContracts, pendingList, defaultFor, defaultBrief, DEFAULTS,
};

/* ---------- CLI ---------- */
if (require.main === module) {
  const a = auditContracts();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(a, null, 2)); process.exit(0); }
  const pct = r => (r == null ? '—' : (r * 100).toFixed(2) + '%');
  console.log(`指标契约：词典 ${a.dict.total} 条 + 语义包 ${a.semantic.total} 条 = ${a.overall.total} 条`);
  console.log(`五字段齐全 ${a.overall.complete}/${a.overall.total}（${pct(a.overall.five_field_rate)}）；业务口径已确定 ${a.overall.business_certain} 条、挂待定清单 ${a.overall.pending_entries} 条（清单 ${a.pending_total} 项）`);
  for (const f of FIVE_FIELDS) console.log(`  ${f}\t齐全 ${a.overall.by_field[f].present}\t缺 ${a.overall.by_field[f].missing}`);
  console.log(`词典 desc≤8 字：${a.dict.desc_short} 条（已按 DESC_ENRICH 补全契约说明）；单位真缺 ${a.overall.unit_pending} 条（无量纲的已给 unit_kind）`);
  console.log(`语义包 desc 覆盖：${a.semantic.total ? a.packs.reduce((s, p) => s + p.metrics_with_desc, 0) : 0}/${a.semantic.total}`);
  for (const c of [a.dict, a.semantic]) if (c.missing.length) {
    console.log(`  ${c.corpus} 缺项：` + c.missing.map(m => `${m.id}.${m.field}`).join('、'));
  }
}
