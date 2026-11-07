// ================= 出厂词典（10-16 第四批，jackson 定：一本、全行业、一次编齐，不分批）=================
// 每条：中英文名 / 缩写 / 别名、合计方法、单位、所属行业、一句话说明；比率写清分子分母（按「角色」写，指向词典里的另一条，不写具体列名）。
// 合计方法：sum 能直接加 / ratio 比率（分子合计 ÷ 分母合计，不能加也不能简单平均）/ stock 存量（库存、余额这种每天一个水位，跨天看期末或日均，不能加）
//          / dcount 去重计数（人数、SKU 数这种，跨天跨组不能直接加）/ avg 平均型（时长、单价这种本身就是平均，跨组要加权）/ none 不能汇总（排名、评分、汇率）
// 缩写、别名在本机精确对（不分大小写）；说明文字给本机向量用（「广告投入回报」→ ROAS）。
// 这是「广」不是「全」：漏的由「数据认关系 + 助手提议 + 你的记忆」兜。改这里要跑 node main/dict.js 自检。
'use strict';
const D = [];
const L = s => (s ? String(s).split('|').map(x => x.trim()).filter(Boolean) : []);
// 一般指标
function E(id, zh, en, abbr, alias, agg, unit, ind, desc, extra){ D.push(Object.assign({ id, zh, en, abbr: L(abbr), alias: L(alias), agg, unit, ind: L(ind), desc }, extra || {})); }
// 比率：num / den 是词典里另一条的 id；mul 100 = 百分数，1000 = 千次
function R(id, zh, en, abbr, alias, unit, ind, desc, num, den, mul, extra){ E(id, zh, en, abbr, alias, 'ratio', unit, ind, desc, Object.assign({ num, den, mul: mul || 1 }, extra || {})); }

/* ---------------- 通用 ---------------- */
E('amount', '金额', 'Amount', '', '总金额|发生额|金额合计', 'sum', '元', '通用', '一笔或多笔交易的钱数，能直接相加');
E('quantity', '数量', 'Quantity', 'QTY', '件数|个数|总数量|qty', 'sum', '件', '通用', '物品的件数或个数，能直接相加');
E('count_records', '记录数', 'Count', '', '笔数|条数|行数|次数', 'sum', '条', '通用', '有多少条记录、发生了多少次');
E('unit_price', '单价', 'Unit Price', '', '每件价格|售价|价格', 'avg', '元', '通用', '一件东西的价格；多件合起来看要用总金额除以总件数，不能把单价相加');
E('avg_price', '均价', 'Average Price', 'ASP', '平均售价|平均单价|平均价格|average selling price', 'ratio', '元', '通用|电商|零售', '平均每件卖多少钱 = 销售额 ÷ 销量', { num: 'sales', den: 'units', mul: 1 });
E('share', '占比', 'Share', '', '比重|份额|占总体比例|构成比', 'none', '%', '通用', '某部分占整体的比例；不同部分的占比只能在同一个整体下比较，不能相加平均');
E('growth_rate', '增长率', 'Growth Rate', '', '增速|增幅|涨幅|变化率', 'none', '%', '通用', '和上一期比变化了百分之几 =（本期 − 上期）÷ 上期；要从两期的合计重新算，不能把各组的增长率相加或平均');
E('yoy', '同比', 'Year over Year', 'YoY', '同比增长|同比增速|比去年同期', 'none', '%', '通用', '和去年同一段时间比的变化；要从两期的合计重新算');
E('mom', '环比', 'Month over Month', 'MoM|WoW|DoD', '环比增长|比上期|比上月|比上周', 'none', '%', '通用', '和紧挨着的上一段时间比的变化；要从两期的合计重新算');
E('target', '目标', 'Target', 'KPI', '目标值|指标值|计划值|预算目标', 'sum', '', '通用', '计划要达到的数');
R('achievement', '达成率', 'Achievement Rate', '', '完成率|目标达成率|完成度', '%', '通用', '实际做到目标的百分之几 = 实际 ÷ 目标 × 100', 'amount', 'target', 100);
E('budget', '预算', 'Budget', '', '预算金额|计划投入', 'sum', '元', '通用|财务', '计划花的钱');
R('budget_usage', '预算使用率', 'Budget Utilization', '', '预算执行率|预算消耗率', '%', '通用|财务|广告', '花掉的钱占预算的百分之几 = 实际花费 ÷ 预算 × 100', 'cost', 'budget', 100);
E('variance', '差异', 'Variance', '', '差额|偏差|差值', 'sum', '', '通用|财务', '实际和目标 / 预算之间差了多少');
E('rank', '排名', 'Rank', '', '名次|排行|位次', 'none', '', '通用', '排第几；不能相加平均');
E('score', '评分', 'Score', '', '分数|打分|星级', 'none', '分', '通用', '打分结果；多条合起来看要按人数加权平均，不能相加');
E('headcount_people', '人数', 'Number of People', '', '人次|人头数', 'dcount', '人', '通用', '有多少人；跨天、跨组直接相加会把同一个人算多次');
E('days', '天数', 'Days', '', '日数', 'sum', '天', '通用', '多少天');
E('duration', '时长', 'Duration', '', '用时|耗时|持续时间', 'avg', '分钟', '通用', '花了多长时间；看平均要用总时长除以次数');
E('exchange_rate', '汇率', 'Exchange Rate', 'FX', '外汇汇率|兑换率|fx rate', 'none', '', '通用|财务|跨境', '一种货币换另一种货币的比例；只能取当时的值或加权平均，不能相加');
E('cost', '成本', 'Cost', '', '费用|花费|支出|开支', 'sum', '元', '通用|财务', '花出去的钱，能直接相加');
E('profit', '利润', 'Profit', '', '盈利|利润额|赚的钱', 'sum', '元', '通用|财务', '收入减去成本和费用后剩下的钱；先确认扣了哪些成本', { defs: ['毛利：只扣商品成本', '营业利润：再扣运营费用', '净利润：再扣税和其他'] });
R('profit_margin', '利润率', 'Profit Margin', '', '盈利率|利润占比', '%', '通用|财务', '利润占收入的百分之几 = 利润 ÷ 收入 × 100；先确认是哪种利润', 'profit', 'revenue', 100);

/* ---------------- 电商：交易与销售 ---------------- */
E('gmv', '成交总额', 'Gross Merchandise Volume', 'GMV', '成交额|成交金额|商品交易总额|交易总额|总成交额|拍下金额|下单金额|gross merchandise value', 'sum', '元', '电商|零售|直播', '统计期内下单的商品总金额（通常含未付款、取消和退款），衡量规模', { defs: ['含未付款、取消、退款（平台口径）', '只算已付款', '扣掉退款后的成交额（有些公司叫净 GMV）'] });
E('sales', '销售额', 'Sales', '', '营业额|销售收入|卖了多少钱|销售金额|营收|流水|sales amount|revenue from sales', 'sum', '元', '电商|零售|通用', '卖出去的商品金额，最常用的规模指标；先确认含不含税、退款、运费', { defs: ['含退款的销售额', '扣掉退款的净销售额', '含税 / 不含税'] });
E('net_sales', '净销售额', 'Net Sales', 'NS', '净销售|净收入|扣退款销售额|实际销售额|净营业额|net revenue', 'sum', '元', '电商|零售|财务', '销售额扣掉退款、退货、折让后的金额');
E('revenue', '收入', 'Revenue', 'REV', '营业收入|营收|总收入|turnover', 'sum', '元', '通用|财务', '企业在一段时间内挣到的钱（确认收入）');
E('paid_amount', '支付金额', 'Paid Amount', '', '实付金额|付款金额|支付总额|已付金额|实收金额|成交金额', 'sum', '元', '电商', '买家实际付了多少钱');
E('refund_amount', '退款金额', 'Refund Amount', '', '退款额|退款总额|退货金额|退款', 'sum', '元', '电商|零售', '退还给买家的钱');
R('refund_rate', '退款率', 'Refund Rate', '', '退款比例|金额退款率', '%', '电商|零售', '退款金额占支付金额的百分之几 = 退款金额 ÷ 支付金额 × 100', 'refund_amount', 'paid_amount', 100);
E('orders', '订单数', 'Orders', '', '订单量|单量|下单数|成交单数|订单笔数|order count|单数', 'sum', '单', '电商|零售|餐饮', '下了多少单');
E('paid_orders', '支付订单数', 'Paid Orders', '', '付款订单数|支付单量|已付款订单', 'sum', '单', '电商', '付了款的订单数');
E('units', '销量', 'Units Sold', '', '销售数量|卖出件数|售出数量|件数|销售件数|units|units ordered|销售量', 'sum', '件', '电商|零售', '卖出去多少件');
R('aov', '客单价', 'Average Order Value', 'AOV|ATV', '平均订单金额|笔单价|每单金额|平均客单价|average transaction value', '元', '电商|零售|餐饮', '平均每单卖多少钱 = 销售额 ÷ 订单数', 'sales', 'orders', 1, { defs: ['销售额 ÷ 订单数', '销售额 ÷ 买家数（按人算的客单价）'] });
R('upt', '连带率', 'Units per Transaction', 'UPT|IPT', '件单比|每单件数|平均每单件数|连单率', '件', '电商|零售', '平均每单买几件 = 销量 ÷ 订单数', 'units', 'orders', 1);
E('buyers', '买家数', 'Buyers', '', '下单人数|成交人数|购买人数|成交客户数|支付买家数|顾客数|付款人数|客户数', 'dcount', '人', '电商|零售', '有多少人买了；跨天直接相加会把同一个人算多次');
E('visitors', '访客数', 'Unique Visitors', 'UV', '访问人数|独立访客|进店人数|访问用户数|sessions|会话数', 'dcount', '人', '电商|内容', '有多少人来过；跨天直接相加会重复算人');
E('page_views', '浏览量', 'Page Views', 'PV', '页面浏览量|访问量|浏览次数|page view', 'sum', '次', '电商|内容', '页面被看了多少次');
R('cvr', '转化率', 'Conversion Rate', 'CVR|CR', '成交转化率|支付转化率|下单转化率|购买转化率|conversion|unit session percentage', '%', '电商|广告|零售', '来的人里有百分之几买了 = 买家数（或订单数）÷ 访客数 × 100', 'buyers', 'visitors', 100, { defs: ['支付买家数 ÷ 访客数', '订单数 ÷ 访客数', '订单数 ÷ 点击数（广告转化率）'], ambiguous: true });
E('add_to_cart', '加购数', 'Add to Cart', 'ATC', '加购次数|加入购物车数|加购件数|加购人数', 'sum', '次', '电商', '被加进购物车多少次');
R('atc_rate', '加购率', 'Add-to-Cart Rate', '', '加购转化率|加车率', '%', '电商', '访客里有百分之几加了购物车 = 加购数 ÷ 访客数 × 100', 'add_to_cart', 'visitors', 100);
E('favorites', '收藏数', 'Favorites', '', '收藏次数|关注商品数|收藏人数|wishlist', 'sum', '次', '电商', '被收藏多少次');
R('fav_rate', '收藏率', 'Favorite Rate', '', '收藏转化率', '%', '电商', '访客里有百分之几收藏了 = 收藏数 ÷ 访客数 × 100', 'favorites', 'visitors', 100);
E('bounces', '跳失人数', 'Bounces', '', '只看一页就走的人数|跳出人数', 'sum', '人', '电商|内容', '只看了一页就离开的人数');
R('bounce_rate', '跳失率', 'Bounce Rate', '', '跳出率', '%', '电商|内容', '只看一页就走的人占访客的百分之几 = 跳失人数 ÷ 访客数 × 100', 'bounces', 'visitors', 100);
E('stay_time', '平均停留时长', 'Average Time on Page', '', '停留时长|浏览时长|访问时长', 'avg', '秒', '电商|内容', '平均每个人看了多久；跨组要按人数加权');
E('repeat_buyers', '复购人数', 'Repeat Buyers', '', '回购人数|二次购买人数|老客购买人数', 'dcount', '人', '电商|零售', '买了两次及以上的人数');
R('repurchase_rate', '复购率', 'Repurchase Rate', '', '回购率|重复购买率|复购比例', '%', '电商|零售', '买家里有百分之几买了不止一次 = 复购人数 ÷ 买家数 × 100', 'repeat_buyers', 'buyers', 100);
E('new_buyers', '新客数', 'New Customers', '', '新买家数|首购人数|新客户数|新增客户', 'dcount', '人', '电商|零售|营销', '第一次买的人数');
E('old_buyers', '老客数', 'Returning Customers', '', '老买家数|回头客|老客户数', 'dcount', '人', '电商|零售', '以前买过、这次又买的人数');
R('new_buyer_share', '新客占比', 'New Customer Share', '', '新客比例', '%', '电商|零售', '买家里新客占百分之几 = 新客数 ÷ 买家数 × 100', 'new_buyers', 'buyers', 100);
E('returns', '退货数', 'Returns', '', '退货件数|退货量|退回数量|returned units', 'sum', '件', '电商|零售|跨境', '退回来多少件');
R('return_rate', '退货率', 'Return Rate', '', '退货比例|退货占比', '%', '电商|零售|跨境', '卖出去的里面退回来百分之几 = 退货数 ÷ 销量 × 100', 'returns', 'units', 100, { defs: ['退货件数 ÷ 销量', '退货订单数 ÷ 订单数', '退货金额 ÷ 销售额'] });
E('cancelled_orders', '取消订单数', 'Cancelled Orders', '', '取消单量|撤单数', 'sum', '单', '电商|跨境', '下了又取消的订单数');
R('cancel_rate', '取消率', 'Cancellation Rate', '', '订单取消率|撤单率', '%', '电商|跨境', '订单里取消了百分之几 = 取消订单数 ÷ 订单数 × 100', 'cancelled_orders', 'orders', 100);
E('discount_amount', '优惠金额', 'Discount Amount', '', '折扣金额|让利金额|促销金额|优惠额|减免金额', 'sum', '元', '电商|零售', '让给买家的钱');
R('discount_rate', '折扣率', 'Discount Rate', '', '让利率|优惠率|折扣比例', '%', '电商|零售', '优惠占原价销售额的百分之几 = 优惠金额 ÷ 销售额 × 100', 'discount_amount', 'sales', 100);
E('shipping_fee', '运费', 'Shipping Fee', '', '物流费|快递费|配送费|运输费|邮费|shipping cost|freight', 'sum', '元', '电商|物流|跨境', '发货花的钱');
E('commission', '佣金', 'Commission', '', '平台佣金|推广佣金|分佣|referral fee|佣金费用', 'sum', '元', '电商|跨境', '按成交给平台或推广者的抽成');
R('take_rate', '平台扣点', 'Take Rate', '', '扣点|抽佣比例|佣金率|平台费率', '%', '电商|跨境', '平台从销售额里抽走百分之几 = 佣金 ÷ 销售额 × 100', 'commission', 'sales', 100);
E('cogs', '商品成本', 'Cost of Goods Sold', 'COGS', '销货成本|产品成本|采购成本|进货成本|货品成本|成本价合计|营业成本|主营业务成本', 'sum', '元', '电商|零售|财务', '卖出去的这些货当初花了多少钱');
E('gross_profit', '毛利', 'Gross Profit', 'GP', '毛利额|毛利润|商品毛利', 'sum', '元', '电商|零售|财务', '销售额减商品成本 = 销售额 − 商品成本');
R('gross_margin', '毛利率', 'Gross Margin', 'GPM|GM', '毛利占比|毛利润率|gross profit margin', '%', '电商|零售|财务|餐饮', '毛利占销售额的百分之几 = 毛利 ÷ 销售额 × 100', 'gross_profit', 'sales', 100);
E('net_profit', '净利润', 'Net Profit', 'NP', '净利|纯利|纯利润|税后利润|net income', 'sum', '元', '财务|电商', '扣掉所有成本、费用和税后剩下的钱');
R('net_margin', '净利率', 'Net Margin', 'NPM', '净利润率|纯利率|net profit margin', '%', '财务|电商', '净利润占收入的百分之几 = 净利润 ÷ 收入 × 100', 'net_profit', 'revenue', 100);
E('sku_count', 'SKU 数', 'SKU Count', '', '商品数|款数|单品数|货品数|品数', 'dcount', '个', '电商|零售|库存', '有多少个不同的商品（按 SKU 去重）');
E('selling_skus', '动销 SKU 数', 'Selling SKUs', '', '动销商品数|有销量的SKU数|动销款数', 'dcount', '个', '电商|零售|库存', '这段时间有卖出去的 SKU 有多少个');
R('sell_rate', '动销率', 'Sell-through SKU Rate', '', '动销比|商品动销率', '%', '电商|零售|库存', '在售商品里有百分之几卖出去过 = 动销 SKU 数 ÷ SKU 数 × 100', 'selling_skus', 'sku_count', 100);
E('new_listings', '上新数', 'New Listings', '', '新品数|上架数|新上架商品数', 'sum', '个', '电商|零售', '新上架了多少商品');
E('reviews', '评价数', 'Reviews', '', '评论数|评价量|review count|ratings count', 'sum', '条', '电商|跨境', '收到多少条评价');
E('positive_reviews', '好评数', 'Positive Reviews', '', '好评量|五星评价数', 'sum', '条', '电商|跨境', '好评有多少条');
R('positive_rate', '好评率', 'Positive Review Rate', '', '好评比例|满意评价率', '%', '电商|跨境|客服', '评价里好评占百分之几 = 好评数 ÷ 评价数 × 100', 'positive_reviews', 'reviews', 100);
E('negative_reviews', '差评数', 'Negative Reviews', '', '差评量|一星评价数|中差评数', 'sum', '条', '电商|跨境', '差评有多少条');
R('negative_rate', '差评率', 'Negative Review Rate', '', '差评比例|中差评率', '%', '电商|跨境', '评价里差评占百分之几 = 差评数 ÷ 评价数 × 100', 'negative_reviews', 'reviews', 100);
E('store_rating', '店铺评分', 'Store Rating', 'DSR', '动态评分|店铺星级|卖家评分|feedback score', 'none', '分', '电商|跨境', '平台给店铺打的分；不能相加');
E('complaints', '投诉量', 'Complaints', '', '投诉数|客诉量|投诉次数|客诉数', 'sum', '次', '电商|客服|跨境', '收到多少次投诉');
R('complaint_rate', '投诉率', 'Complaint Rate', '', '客诉率', '%', '电商|客服', '订单里有百分之几被投诉 = 投诉量 ÷ 订单数 × 100', 'complaints', 'orders', 100);
E('disputes', '纠纷数', 'Disputes', '', '纠纷单数|争议订单数', 'sum', '单', '电商|跨境', '发生纠纷的订单数');
R('dispute_rate', '纠纷率', 'Dispute Rate', '', '纠纷占比|争议率', '%', '电商|跨境', '订单里有百分之几发生纠纷 = 纠纷数 ÷ 订单数 × 100', 'disputes', 'orders', 100);
E('ship_time', '发货时长', 'Time to Ship', '', '发货时效|出库时长|处理时长|handling time', 'avg', '小时', '电商|物流|跨境', '从下单到发货平均用多久');
E('ontime_shipments', '准时发货单数', 'On-time Shipments', '', '按时发货单数', 'sum', '单', '电商|物流|跨境', '在承诺时间内发出的订单数');
R('ontime_ship_rate', '准时发货率', 'On-time Shipment Rate', '', '及时发货率|按时发货率', '%', '电商|物流|跨境', '订单里有百分之几按时发货 = 准时发货单数 ÷ 订单数 × 100', 'ontime_shipments', 'orders', 100);
E('search_impressions', '搜索曝光', 'Search Impressions', '', '搜索展现|搜索曝光量|自然曝光', 'sum', '次', '电商|广告', '在搜索结果里被看到多少次');
E('organic_visitors', '自然流量', 'Organic Traffic', '', '免费流量|自然访客|自然访客数', 'dcount', '人', '电商|广告', '不花广告费来的访客');
E('paid_visitors', '付费流量', 'Paid Traffic', '', '广告流量|付费访客|付费访客数', 'dcount', '人', '电商|广告', '花广告费带来的访客');
R('organic_share', '自然流量占比', 'Organic Traffic Share', '', '免费流量占比', '%', '电商|广告', '访客里自然来的占百分之几 = 自然流量 ÷ 访客数 × 100', 'organic_visitors', 'visitors', 100);
R('uv_value', 'UV 价值', 'Revenue per Visitor', 'RPV', '访客价值|每访客销售额|uv价值', '元', '电商|内容|直播', '平均每个访客带来多少销售额 = 销售额 ÷ 访客数', 'sales', 'visitors', 1);
R('sales_per_buyer', '人均消费', 'Spend per Customer', '', '人均消费额|人均销售额|每人消费|客单价（按人）', '元', '电商|零售|餐饮', '平均每个买家花多少钱 = 销售额 ÷ 买家数', 'sales', 'buyers', 1);

/* ---------------- 广告投放 ---------------- */
E('impressions', '曝光量', 'Impressions', 'IMP', '展示量|展现量|曝光次数|展示次数|曝光|展现|展示|impression|views', 'sum', '次', '广告|电商|内容', '广告或内容被展示了多少次');
E('clicks', '点击量', 'Clicks', '', '点击次数|点击数|点击|click', 'sum', '次', '广告|电商|内容', '被点了多少次');
R('ctr', '点击率', 'Click-Through Rate', 'CTR', '点击通过率|点进率|click through rate', '%', '广告|电商|内容|营销', '展示里有百分之几被点了 = 点击量 ÷ 曝光量 × 100', 'clicks', 'impressions', 100);
E('ad_spend', '广告花费', 'Ad Spend', '', '广告费|广告消耗|投放金额|推广费|推广花费|消耗|花费|ad cost|spend|ads spend|投流费用|投流消耗|广告支出', 'sum', '元', '广告|电商|直播', '投广告花了多少钱');
E('ad_sales', '广告销售额', 'Ad Sales', '', '广告成交额|广告带来的销售额|推广销售额|投放成交额|广告GMV|广告产出|attributed sales|ad revenue|广告营收', 'sum', '元', '广告|电商', '归因到广告的成交金额');
E('ad_orders', '广告订单数', 'Ad Orders', '', '广告订单|广告成交单数|推广订单|广告单量|attributed orders', 'sum', '单', '广告|电商', '归因到广告的订单数');
R('roas', '广告支出回报率', 'Return on Ad Spend', 'ROAS', '广告投入产出比|广告回报率|投产比|广告投入回报|广告产出比|投入产出比', '倍', '广告|电商|直播', '花一块钱广告带回多少钱销售额 = 广告销售额 ÷ 广告花费', 'ad_sales', 'ad_spend', 1);
R('acos', '广告销售成本比', 'Advertising Cost of Sales', 'ACOS|ACoS', '广告成本占比|广告花费占广告销售额比例', '%', '广告|电商|跨境', '广告花费占广告销售额的百分之几 = 广告花费 ÷ 广告销售额 × 100，是 ROAS 的倒数', 'ad_spend', 'ad_sales', 100);
R('tacos', '总广告销售成本比', 'Total Advertising Cost of Sales', 'TACOS|TACoS', '广告费占总销售额比例|整体广告占比', '%', '广告|电商|跨境', '广告花费占全部销售额（含自然订单）的百分之几 = 广告花费 ÷ 销售额 × 100', 'ad_spend', 'sales', 100);
R('cpc', '单次点击成本', 'Cost per Click', 'CPC', '点击单价|平均点击花费|每次点击费用|ppc 单价', '元', '广告|电商', '平均点一次花多少钱 = 广告花费 ÷ 点击量', 'ad_spend', 'clicks', 1);
R('cpm', '千次展示成本', 'Cost per Mille', 'CPM', '千次曝光成本|千次展现费用|千展成本', '元', '广告|内容', '每展示一千次花多少钱 = 广告花费 ÷ 曝光量 × 1000', 'ad_spend', 'impressions', 1000);
R('ad_cvr', '广告转化率', 'Ad Conversion Rate', '', '点击转化率|广告点击转化率', '%', '广告|电商', '点了广告的人里有百分之几下单 = 广告订单数 ÷ 点击量 × 100', 'ad_orders', 'clicks', 100);
R('cpa', '单次转化成本', 'Cost per Acquisition', 'CPA', '每次转化成本|转化成本|获取成本|cost per action', '元', '广告|营销', '平均拿到一次转化（下单、注册等）花多少钱 = 广告花费 ÷ 转化数', 'ad_spend', 'conversions', 1, { ambiguous: true, defs: ['按订单算：广告花费 ÷ 广告订单数', '按注册 / 线索算：广告花费 ÷ 注册数'] });
E('conversions', '转化数', 'Conversions', '', '转化次数|转化量|转化|conversion count', 'sum', '次', '广告|营销', '完成目标动作（下单、注册、留资）的次数');
R('cpo', '单均广告成本', 'Cost per Order', 'CPO', '每单广告成本|订单成本', '元', '广告|电商', '平均每个广告订单花多少广告费 = 广告花费 ÷ 广告订单数', 'ad_spend', 'ad_orders', 1);
R('cps_rate', '按成交付费比例', 'Cost per Sale Rate', 'CPS', '成交佣金比例|cps 佣金率', '%', '广告|电商', '按成交金额付的推广费比例 = 推广佣金 ÷ 推广成交额 × 100', 'commission', 'ad_sales', 100);
R('ad_roi', '广告投资回报率', 'Advertising ROI', 'ROI', '投资回报率|回报率|return on investment', '%', '广告|营销|财务', '投进去的钱赚回来百分之几 =（收益 − 投入）÷ 投入 × 100；有的公司直接把 ROAS 叫 ROI', 'profit', 'ad_spend', 100, { ambiguous: true, defs: ['（收益 − 投入）÷ 投入', '广告销售额 ÷ 广告花费（等同 ROAS）', '广告带来的毛利 ÷ 广告花费'] });
R('ad_sales_share', '广告销售占比', 'Ad Sales Share', '', '广告成交占比|付费成交占比', '%', '广告|电商', '销售额里广告带来的占百分之几 = 广告销售额 ÷ 销售额 × 100', 'ad_sales', 'sales', 100);
E('reach', '覆盖人数', 'Reach', '', '触达人数|到达人数|覆盖用户数|reach', 'dcount', '人', '广告|内容|营销', '至少看到一次的人数；跨天直接相加会重复');
R('frequency', '平均频次', 'Frequency', '', '曝光频次|人均曝光次数|frequency', '次', '广告|营销', '平均每人看到几次 = 曝光量 ÷ 覆盖人数', 'impressions', 'reach', 1);
E('video_views', '视频播放量', 'Video Views', 'VV', '播放量|播放次数|观看次数|播放数', 'sum', '次', '广告|内容|直播', '视频被播放了多少次');
E('video_completes', '完播次数', 'Video Completions', '', '播完次数|完整播放次数', 'sum', '次', '广告|内容', '从头看到尾的次数');
R('completion_rate', '完播率', 'Video Completion Rate', 'VCR', '播完率|完整播放率', '%', '广告|内容', '播放里有百分之几看完了 = 完播次数 ÷ 视频播放量 × 100', 'video_completes', 'video_views', 100);
R('cpv', '单次播放成本', 'Cost per View', 'CPV', '播放单价|每次观看成本', '元', '广告|内容', '平均每次播放花多少钱 = 广告花费 ÷ 视频播放量', 'ad_spend', 'video_views', 1);
E('engagements', '互动量', 'Engagements', '', '互动次数|互动数|点赞评论转发合计|engagement', 'sum', '次', '广告|内容|营销', '点赞、评论、转发、收藏加起来的次数');
R('engagement_rate', '互动率', 'Engagement Rate', 'ER', '互动比例', '%', '广告|内容|营销', '曝光里有百分之几产生了互动 = 互动量 ÷ 曝光量 × 100', 'engagements', 'impressions', 100, { defs: ['互动量 ÷ 曝光量', '互动量 ÷ 粉丝数'] });
R('cpe', '单次互动成本', 'Cost per Engagement', 'CPE', '互动单价', '元', '广告|内容', '平均一次互动花多少钱 = 广告花费 ÷ 互动量', 'ad_spend', 'engagements', 1);
E('leads', '线索数', 'Leads', '', '留资数|销售线索|表单提交数|询盘数|lead count|留资量', 'sum', '条', '广告|营销|B2B', '留下联系方式的潜在客户数');
R('cpl', '单条线索成本', 'Cost per Lead', 'CPL', '线索成本|留资成本|获客线索成本', '元', '广告|营销|B2B', '平均拿到一条线索花多少钱 = 广告花费 ÷ 线索数', 'ad_spend', 'leads', 1);
R('cac', '获客成本', 'Customer Acquisition Cost', 'CAC', '获客单价|拉新成本|新客获取成本|用户获取成本', '元', '营销|SaaS|电商|广告', '平均拉来一个新客户花多少钱 = 营销花费 ÷ 新客数', 'ad_spend', 'new_buyers', 1);
E('bid', '出价', 'Bid', 'CPC bid', '竞价|关键词出价|默认竞价|bid price', 'avg', '元', '广告|电商', '愿意为一次点击付的最高价；不能相加');
R('impression_share', '曝光份额', 'Impression Share', 'IS', '展示份额|展现份额|搜索份额', '%', '广告', '能拿到的展示里实际拿到了百分之几 = 实际曝光 ÷ 可获得曝光 × 100', 'impressions', 'eligible_impressions', 100);
E('eligible_impressions', '可获得曝光', 'Eligible Impressions', '', '可展示次数|潜在曝光', 'sum', '次', '广告', '按出价和定向本来能拿到的展示次数');
R('top_is_rate', '首页顶部展示率', 'Top-of-Search Impression Rate', '', '顶部曝光占比|首位展示率', '%', '广告|跨境', '曝光里有百分之几出现在搜索结果顶部', 'top_impressions', 'impressions', 100);
E('top_impressions', '顶部曝光量', 'Top-of-Search Impressions', '', '首页首位曝光', 'sum', '次', '广告|跨境', '出现在搜索结果顶部的曝光次数');
R('ecpm', '千次展示收入', 'Effective CPM', 'eCPM|RPM', '千次收益|千次展示收益', '元', '广告|内容|游戏', '每展示一千次挣多少钱（流量方看） = 广告收入 ÷ 曝光量 × 1000', 'ad_revenue_pub', 'impressions', 1000);
E('ad_revenue_pub', '广告收入', 'Ad Revenue (Publisher)', '', '流量变现收入|广告变现收入', 'sum', '元', '广告|内容|游戏', '卖广告位挣到的钱');
R('gpm', '千次观看成交额', 'GMV per Mille', 'GPM', '千次曝光成交额|千川GPM|千次播放成交', '元', '直播|内容|广告', '每一千次观看带来多少成交 = 成交额 ÷ 观看次数 × 1000', 'gmv', 'video_views', 1000);
R('live_roi', '投放 ROI（直播）', 'Live-stream ROI', '', '千川ROI|直播投产|直播ROI|投流ROI', '倍', '直播|广告', '直播投流花一块钱带回多少成交（等同直播间 ROAS）= 成交额 ÷ 投流消耗', 'gmv', 'ad_spend', 1);

/* ---------------- 库存与供应链 ---------------- */
E('stock_qty', '库存数量', 'Inventory Quantity', '', '库存|库存量|现有库存|在库数量|库存件数|on hand|inventory|stock|库存数', 'stock', '件', '库存|电商|零售|制造', '某个时点手上有多少件货；跨天不能相加，看期末或日均');
E('available_qty', '可售库存', 'Available Inventory', '', '可用库存|可卖库存|可售数量|fulfillable|available', 'stock', '件', '库存|电商|跨境', '现在能马上卖的库存；跨天看期末或日均');
E('inbound_transit', '在途库存', 'In-transit Inventory', '', '在途数量|在途|运输中库存|inbound|在途货', 'stock', '件', '库存|物流|跨境', '已经发出、还没到仓的货；跨天看期末');
E('stock_value', '库存金额', 'Inventory Value', '', '库存价值|库存成本|在库金额|库存货值|inventory value', 'stock', '元', '库存|财务|零售', '库存按成本算值多少钱；跨天看期末或日均');
E('stock_age', '库龄', 'Inventory Age', '', '库存天数|在库天数|货龄|aging', 'avg', '天', '库存|跨境', '货在仓里放了多久；看平均要按件数加权');
E('daily_sales', '日均销量', 'Average Daily Sales', 'ADS', '日均出库|日均卖出|日销|平均日销量|daily run rate', 'avg', '件', '库存|电商|零售', '平均每天卖多少件 = 销量 ÷ 天数');
R('dos', '库存可售天数', 'Days of Supply', 'DOS|DOH|DSI', '可售天数|库存天数|库存覆盖天数|周转天数|days on hand|days of inventory', '天', '库存|电商|零售|跨境', '按现在的卖法，库存还够卖几天 = 期末库存 ÷ 日均销量', 'stock_qty', 'daily_sales', 1, { defs: ['期末库存 ÷ 日均销量', '平均库存 ÷ 日均销售成本（财务口径的存货周转天数）'] });
R('woc', '库存覆盖周数', 'Weeks of Cover', 'WOC|WOS', '可售周数|库存周数|weeks of supply', '周', '库存|零售', '库存还够卖几周 = 期末库存 ÷ 周均销量', 'stock_qty', 'weekly_sales', 1);
E('weekly_sales', '周均销量', 'Average Weekly Sales', '', '周销量|平均周销', 'avg', '件', '库存|零售', '平均每周卖多少件');
R('inv_turnover', '库存周转率', 'Inventory Turnover', 'ITO', '周转次数|存货周转率|库存周转次数|turnover', '次', '库存|财务|零售', '一段时间里库存卖完换新了几轮 = 销售成本 ÷ 平均库存金额', 'cogs', 'stock_value', 1);
R('sell_through', '售罄率', 'Sell-through Rate', 'STR', '售出率|消化率|卖出比例|sell through', '%', '库存|零售|电商', '进来的货卖掉了百分之几 = 销量 ÷（销量 + 期末库存）× 100', 'units', 'received_qty', 100, { defs: ['销量 ÷ 进货量', '销量 ÷（销量 + 期末库存）'] });
E('received_qty', '入库数量', 'Received Quantity', '', '到货数量|收货数量|进货量|入库量|receipts|inbound qty', 'sum', '件', '库存|物流|制造', '这段时间入仓了多少件');
E('outbound_qty', '出库数量', 'Shipped Quantity', '', '出库量|发货数量|发出数量|outbound qty', 'sum', '件', '库存|物流', '这段时间出仓了多少件');
E('oos_skus', '缺货 SKU 数', 'Out-of-stock SKUs', '', '断货SKU数|缺货商品数|无货SKU', 'dcount', '个', '库存|电商|零售', '没货的 SKU 有多少个');
R('oos_rate', '缺货率', 'Out-of-stock Rate', 'OOS', '断货率|缺货比例', '%', '库存|电商|零售', 'SKU 里有百分之几没货 = 缺货 SKU 数 ÷ SKU 数 × 100', 'oos_skus', 'sku_count', 100);
R('instock_rate', '现货率', 'In-stock Rate', '', '有货率|在库率|instock', '%', '库存|电商|零售', 'SKU 里有百分之几有货 =（SKU 数 − 缺货 SKU 数）÷ SKU 数 × 100', 'instock_skus', 'sku_count', 100);
E('instock_skus', '有货 SKU 数', 'In-stock SKUs', '', '在库SKU数', 'dcount', '个', '库存|电商|零售', '有货的 SKU 有多少个');
E('oos_days', '缺货天数', 'Out-of-stock Days', '', '断货天数|无货天数', 'sum', '天', '库存|电商', '没货的天数');
E('safety_stock', '安全库存', 'Safety Stock', 'SS', '保险库存|缓冲库存', 'stock', '件', '库存|制造', '为防断货多备的库存');
E('reorder_point', '补货点', 'Reorder Point', 'ROP', '再订货点|订货点', 'none', '件', '库存', '库存降到这个数就该补货');
E('reorder_qty', '补货数量', 'Reorder Quantity', 'ROQ|EOQ', '建议补货量|补货量|采购建议量|经济订货量', 'sum', '件', '库存|电商|跨境', '这次该补多少货');
E('po_qty', '采购数量', 'Purchase Quantity', 'PO', '采购量|下单采购数|订货数量|po qty', 'sum', '件', '库存|制造|电商', '向供应商下单采购了多少件');
E('po_amount', '采购金额', 'Purchase Amount', '', '采购额|进货金额|采购总额|采购花费', 'sum', '元', '库存|财务|制造', '采购花了多少钱');
E('slow_stock', '滞销库存', 'Slow-moving Inventory', '', '滞销品库存|慢动销库存|呆滞库存|积压库存|dead stock', 'stock', '件', '库存|电商|零售', '长期卖不动的库存；跨天看期末');
R('slow_rate', '呆滞率', 'Obsolete Inventory Ratio', '', '滞销率|积压比例|呆滞库存占比', '%', '库存|财务', '库存里卖不动的占百分之几 = 滞销库存 ÷ 库存数量 × 100', 'slow_stock', 'stock_qty', 100);
E('forecast_qty', '预测销量', 'Forecast Quantity', '', '销量预测|需求预测|预测值|forecast', 'sum', '件', '库存|计划', '预计会卖多少件');
R('forecast_accuracy', '预测准确率', 'Forecast Accuracy', 'FA', '预测达成率|准确率', '%', '库存|计划', '预测和实际有多接近 = 1 − |实际 − 预测| ÷ 实际（按总量算，不能把各组准确率平均）', 'units', 'forecast_qty', 100, { defs: ['1 − 绝对误差合计 ÷ 实际合计', '实际 ÷ 预测'] });
E('mape', '平均绝对百分比误差', 'Mean Absolute Percentage Error', 'MAPE|WAPE', '预测误差率|绝对误差率', 'none', '%', '库存|计划', '预测平均偏了百分之几；跨组要按实际量加权');
E('forecast_bias', '预测偏差', 'Forecast Bias', '', '预测偏高偏低|bias', 'none', '%', '库存|计划', '预测整体偏高还是偏低 =（预测 − 实际）÷ 实际');
E('filled_qty', '满足数量', 'Filled Quantity', '', '已满足数量|已交付数量', 'sum', '件', '库存|物流|制造', '按要求交付了的数量');
R('fill_rate', '订单满足率', 'Fill Rate', 'FR', '满足率|供货满足率|履约率', '%', '库存|物流|制造', '要的货里有百分之几按时按量交了 = 满足数量 ÷ 需求数量 × 100', 'filled_qty', 'quantity', 100);
E('otif_orders', '准时足量单数', 'OTIF Orders', '', '准时足量交付单数', 'sum', '单', '物流|制造|库存', '按时、足量交付的订单数');
R('otif', '准时足量交付率', 'On Time In Full', 'OTIF', '准交率|准时交付率|交付准时率', '%', '物流|制造|库存', '订单里有百分之几按时足量交付 = 准时足量单数 ÷ 订单数 × 100', 'otif_orders', 'orders', 100);
E('lead_time', '交货周期', 'Lead Time', 'LT', '交期|采购周期|备货周期|到货周期|lead time', 'avg', '天', '库存|制造|跨境', '从下单到货到手平均要多久');
E('storage_fee', '仓储费', 'Storage Fee', '', '仓租|仓储费用|月度仓储费|storage cost', 'sum', '元', '库存|跨境|物流', '放货收的钱');
E('lts_fee', '长期仓储费', 'Long-term Storage Fee', 'LTSF', '超期仓储费|长期库存费|aged inventory surcharge', 'sum', '元', '库存|跨境', '货放太久额外收的钱');
E('fba_fee', '配送费', 'Fulfillment Fee', 'FBA fee', 'fba费用|履约费|配送费用|fulfillment fee|尾程费', 'sum', '元', '跨境|物流|电商', '平台仓代发货收的钱');
E('count_diff', '盘点差异', 'Count Variance', '', '盘盈盘亏|盘差|库存差异', 'sum', '件', '库存', '盘点数和账面数差了多少');
R('count_diff_rate', '盘点差异率', 'Inventory Accuracy Variance', '', '盘差率|库存差异率', '%', '库存', '盘点差了账面的百分之几 = 盘点差异 ÷ 库存数量 × 100', 'count_diff', 'stock_qty', 100);
E('damaged_qty', '残损数量', 'Damaged Quantity', '', '破损数量|坏货|残次品数量|报损数量', 'sum', '件', '库存|物流', '坏了不能卖的货');
R('damage_rate', '残损率', 'Damage Rate', '', '破损率|报损率', '%', '库存|物流', '货里坏了百分之几 = 残损数量 ÷ 入库数量 × 100', 'damaged_qty', 'received_qty', 100);
E('picks', '拣货行数', 'Pick Lines', '', '拣货单数|拣货量', 'sum', '行', '库存|物流', '拣了多少行货');
R('pick_accuracy', '拣货准确率', 'Pick Accuracy', '', '拣货正确率|发货准确率', '%', '库存|物流', '拣货里有百分之几没拣错 = 正确拣货行数 ÷ 拣货行数 × 100', 'correct_picks', 'picks', 100);
E('correct_picks', '正确拣货行数', 'Correct Pick Lines', '', '无误拣货行数', 'sum', '行', '库存|物流', '没拣错的行数');

/* ---------------- 财务 ---------------- */
E('operating_cost', '营业成本', 'Cost of Revenue', '', '主营业务成本|销售成本|cost of sales', 'sum', '元', '财务', '为取得收入直接花的成本');
E('selling_expense', '销售费用', 'Selling Expenses', '', '营销费用|市场费用|销售开支', 'sum', '元', '财务|营销', '为卖东西花的费用（广告、推广、销售人员等）');
E('admin_expense', '管理费用', 'Administrative Expenses', 'G&A', '行政费用|管理开支|一般管理费用', 'sum', '元', '财务', '管理公司花的费用');
E('rd_expense', '研发费用', 'R&D Expenses', 'R&D', '研发投入|研发支出|开发费用', 'sum', '元', '财务|SaaS|制造', '研发花的钱');
E('finance_expense', '财务费用', 'Financial Expenses', '', '利息费用|手续费|汇兑损益', 'sum', '元', '财务', '利息、手续费、汇兑损失等');
E('opex', '运营费用', 'Operating Expenses', 'OPEX', '期间费用|经营费用|营运费用|运营开支', 'sum', '元', '财务', '销售、管理、研发等日常经营花的钱');
R('expense_ratio', '费用率', 'Expense Ratio', '', '期间费用率|运营费用率|费用占比', '%', '财务', '费用占收入的百分之几 = 运营费用 ÷ 收入 × 100', 'opex', 'revenue', 100);
R('selling_expense_ratio', '销售费用率', 'Selling Expense Ratio', '', '营销费用率|市场费用率', '%', '财务|营销', '销售费用占收入的百分之几 = 销售费用 ÷ 收入 × 100', 'selling_expense', 'revenue', 100);
E('operating_profit', '营业利润', 'Operating Profit', 'EBIT', '经营利润|息税前利润|营运利润', 'sum', '元', '财务', '收入减营业成本和运营费用后剩下的');
R('operating_margin', '营业利润率', 'Operating Margin', 'OPM', '经营利润率|营运利润率', '%', '财务', '营业利润占收入的百分之几 = 营业利润 ÷ 收入 × 100', 'operating_profit', 'revenue', 100);
E('ebitda', '息税折旧摊销前利润', 'EBITDA', 'EBITDA', '税息折旧及摊销前利润', 'sum', '元', '财务', '不算利息、税、折旧、摊销时的利润');
R('ebitda_margin', 'EBITDA 利润率', 'EBITDA Margin', '', 'ebitda率', '%', '财务', 'EBITDA 占收入的百分之几', 'ebitda', 'revenue', 100);
E('contribution', '贡献毛利', 'Contribution Margin', 'CM', '边际贡献|贡献利润|边际利润|贡献毛益', 'sum', '元', '财务|电商', '收入减变动成本（货、运费、佣金、广告等）后剩下的钱');
R('contribution_rate', '边际贡献率', 'Contribution Margin Ratio', '', '贡献毛利率|边际利润率', '%', '财务|电商', '贡献毛利占收入的百分之几', 'contribution', 'revenue', 100);
E('ocf', '经营现金流', 'Operating Cash Flow', 'OCF', '经营活动现金流|营运现金流', 'sum', '元', '财务', '日常经营收进来减付出去的现金');
E('fcf', '自由现金流', 'Free Cash Flow', 'FCF', '可支配现金流', 'sum', '元', '财务', '经营现金流减掉资本开支后能自由用的现金');
E('cash', '现金余额', 'Cash Balance', '', '货币资金|账户余额|现金|资金余额', 'stock', '元', '财务|金融', '某个时点手上有多少现金；跨天看期末');
E('ar', '应收账款', 'Accounts Receivable', 'AR', '应收款|应收|待回款|未回款', 'stock', '元', '财务|B2B', '别人欠我们、还没收回的钱；跨天看期末或平均');
E('ap', '应付账款', 'Accounts Payable', 'AP', '应付款|应付|待付款', 'stock', '元', '财务', '我们欠别人、还没付的钱；跨天看期末或平均');
R('dso', '应收账款周转天数', 'Days Sales Outstanding', 'DSO', '回款天数|应收周转天数|收款天数', '天', '财务|B2B', '平均多少天收回货款 = 平均应收账款 ÷ 日均收入', 'ar', 'daily_revenue', 1);
R('dpo', '应付账款周转天数', 'Days Payable Outstanding', 'DPO', '付款天数|应付周转天数', '天', '财务', '平均多少天付给供应商 = 平均应付账款 ÷ 日均采购成本', 'ap', 'daily_cogs', 1);
R('dio', '存货周转天数', 'Days Inventory Outstanding', 'DIO', '存货天数|库存周转天数（财务）', '天', '财务|库存', '库存平均多少天卖掉 = 平均库存金额 ÷ 日均销售成本', 'stock_value', 'daily_cogs', 1);
E('daily_revenue', '日均收入', 'Average Daily Revenue', '', '日均营收|日均销售额', 'avg', '元', '财务|电商', '平均每天的收入');
E('daily_cogs', '日均销售成本', 'Average Daily COGS', '', '日均成本', 'avg', '元', '财务|库存', '平均每天的销售成本');
E('ccc', '现金周期', 'Cash Conversion Cycle', 'CCC', '现金转换周期|营运资金周期', 'none', '天', '财务', '钱从付出去到收回来要多少天 = 存货周转天数 + 应收天数 − 应付天数');
E('equity', '净资产', 'Shareholders Equity', '', '股东权益|所有者权益|净值', 'stock', '元', '财务', '资产减负债；跨天看期末');
E('total_assets', '总资产', 'Total Assets', 'TA', '资产总额|资产合计', 'stock', '元', '财务', '公司全部资产；跨天看期末');
E('total_liabilities', '总负债', 'Total Liabilities', 'TL', '负债总额|负债合计', 'stock', '元', '财务', '公司全部负债；跨天看期末');
R('roe', '净资产收益率', 'Return on Equity', 'ROE', '股东权益回报率|权益回报率', '%', '财务', '净利润占平均净资产的百分之几', 'net_profit', 'equity', 100);
R('roa', '总资产收益率', 'Return on Assets', 'ROA', '资产回报率|资产收益率', '%', '财务', '净利润占平均总资产的百分之几', 'net_profit', 'total_assets', 100);
R('roic', '投入资本回报率', 'Return on Invested Capital', 'ROIC', '投资资本回报率', '%', '财务', '税后营业利润占投入资本的百分之几', 'operating_profit', 'invested_capital', 100);
E('invested_capital', '投入资本', 'Invested Capital', 'IC', '资本投入', 'stock', '元', '财务', '股东和债权人投进来的钱');
R('debt_ratio', '资产负债率', 'Debt Ratio', '', '负债率|负债比率', '%', '财务', '负债占总资产的百分之几 = 总负债 ÷ 总资产 × 100（同一时点）', 'total_liabilities', 'total_assets', 100);
R('current_ratio', '流动比率', 'Current Ratio', 'CR', '流动资产比率', '倍', '财务', '流动资产是流动负债的几倍（同一时点）', 'current_assets', 'current_liabilities', 1, { ambiguous: true });
E('current_assets', '流动资产', 'Current Assets', '', '短期资产', 'stock', '元', '财务', '一年内能变现的资产');
E('current_liabilities', '流动负债', 'Current Liabilities', '', '短期负债', 'stock', '元', '财务', '一年内要还的负债');
R('quick_ratio', '速动比率', 'Quick Ratio', 'QR', '酸性测试比率', '倍', '财务', '扣掉存货后的流动资产是流动负债的几倍', 'quick_assets', 'current_liabilities', 1);
E('quick_assets', '速动资产', 'Quick Assets', '', '', 'stock', '元', '财务', '流动资产减存货');
E('tax', '税费', 'Tax', 'VAT|GST', '增值税|销售税|税额|税金|消费税|sales tax', 'sum', '元', '财务|跨境', '交的税');
R('tax_rate', '税率', 'Tax Rate', '', '实际税率|综合税率', '%', '财务|跨境', '税费占计税金额的百分之几', 'tax', 'revenue', 100);
E('breakeven', '盈亏平衡点', 'Break-even Point', 'BEP', '保本点|保本销售额', 'none', '元', '财务', '收入刚好覆盖成本的那个销售额');
E('settlement', '结算金额', 'Settlement Amount', '', '回款金额|到账金额|结算款|打款金额|disbursement|payout', 'sum', '元', '财务|跨境|电商', '平台结给我们、实际到账的钱');
E('fx_loss', '汇兑损益', 'FX Gain/Loss', '', '汇损|汇差|汇率损益', 'sum', '元', '财务|跨境', '换汇时多出或少了的钱');
E('chargebacks', '拒付金额', 'Chargebacks', '', '拒付|退单金额|争议扣款', 'sum', '元', '金融|跨境|电商', '买家通过发卡行要回去的钱');

/* ---------------- SaaS / 订阅 ---------------- */
E('mrr', '月经常性收入', 'Monthly Recurring Revenue', 'MRR', '月度订阅收入|月订阅收入|月续费收入', 'stock', '元', 'SaaS|订阅', '每个月固定会收到的订阅收入（某个时点的水位，跨月不能相加）');
E('arr', '年经常性收入', 'Annual Recurring Revenue', 'ARR', '年度订阅收入|年化订阅收入', 'stock', '元', 'SaaS|订阅', '一年固定会收到的订阅收入 = MRR × 12（时点值，不能相加）');
E('new_mrr', '新增 MRR', 'New MRR', '', '新签MRR|新客MRR', 'sum', '元', 'SaaS', '新客户带来的月订阅收入');
E('expansion_mrr', '扩展 MRR', 'Expansion MRR', '', '增购MRR|升级MRR|扩展收入', 'sum', '元', 'SaaS', '老客户加购、升级多出来的月订阅收入');
E('churned_mrr', '流失 MRR', 'Churned MRR', '', '流失收入|降级MRR|收缩MRR', 'sum', '元', 'SaaS', '客户流失、降级少掉的月订阅收入');
E('net_new_mrr', '净新增 MRR', 'Net New MRR', '', '净增MRR', 'sum', '元', 'SaaS', '新增 + 扩展 − 流失的月订阅收入');
E('customers', '客户数', 'Customers', '', '付费客户数|在约客户数|账户数|租户数|accounts', 'stock', '个', 'SaaS|B2B', '某个时点有多少付费客户；跨月看期末');
E('churned_customers', '流失客户数', 'Churned Customers', '', '流失数|退订客户数|取消订阅数', 'sum', '个', 'SaaS|订阅|营销', '这段时间流失了多少客户');
R('churn_rate', '流失率', 'Churn Rate', '', '客户流失率|退订率|logo churn', '%', 'SaaS|订阅|营销|游戏', '期初客户里有百分之几流失了 = 流失客户数 ÷ 期初客户数 × 100', 'churned_customers', 'customers', 100);
R('grr', '总收入留存率', 'Gross Revenue Retention', 'GRR', '毛收入留存|收入留存率', '%', 'SaaS', '老客户收入扣掉流失降级后还剩百分之几（不算扩展）', 'retained_mrr', 'mrr', 100);
E('retained_mrr', '留存 MRR', 'Retained MRR', '', '保留MRR', 'sum', '元', 'SaaS', '老客户期末还在的月订阅收入');
R('nrr', '净收入留存率', 'Net Revenue Retention', 'NRR|NDR', '净留存率|净美元留存', '%', 'SaaS', '老客户收入算上扩展、扣掉流失后是期初的百分之几', 'retained_mrr', 'mrr', 100, { defs: ['（期初 MRR + 扩展 − 流失 − 降级）÷ 期初 MRR'] });
R('arpu', '每用户平均收入', 'Average Revenue per User', 'ARPU|ARPA', '人均收入|平均每用户收入|单用户收入', '元', 'SaaS|游戏|App|订阅', '平均每个用户带来多少收入 = 收入 ÷ 活跃用户数', 'revenue', 'active_users', 1);
R('arppu', '每付费用户平均收入', 'Average Revenue per Paying User', 'ARPPU', '付费用户人均收入|付费ARPU', '元', 'SaaS|游戏|App', '平均每个付费用户带来多少收入 = 收入 ÷ 付费用户数', 'revenue', 'paying_users', 1);
E('ltv', '用户生命周期价值', 'Lifetime Value', 'LTV|CLV|CLTV', '客户终身价值|生命周期价值|客户价值', 'none', '元', 'SaaS|电商|营销|游戏', '一个客户整个合作期间预计带来多少钱（按模型估算，不能相加）');
E('ltv_cac', 'LTV/CAC', 'LTV to CAC Ratio', 'LTV:CAC', '获客回报倍数', 'none', '倍', 'SaaS|营销', '一个客户带来的价值是获客成本的几倍');
E('payback', '回本周期', 'CAC Payback Period', '', '获客回本周期|回收期', 'none', '月', 'SaaS|营销', '多少个月能赚回获客成本');
E('active_users', '活跃用户数', 'Active Users', 'DAU|MAU|WAU', '日活|月活|周活|活跃人数|活跃用户|日活跃用户|月活跃用户', 'dcount', '人', 'SaaS|App|游戏|内容', '这段时间用过产品的人数；日活不能加成月活');
E('paying_users', '付费用户数', 'Paying Users', 'PU', '付费人数|付费用户|付费账户数', 'dcount', '人', 'SaaS|App|游戏', '付了钱的人数');
R('pay_rate', '付费率', 'Paying Rate', '', '付费转化率|付费渗透率', '%', 'SaaS|App|游戏', '活跃用户里有百分之几付费 = 付费用户数 ÷ 活跃用户数 × 100', 'paying_users', 'active_users', 100);
R('stickiness', '用户粘性', 'Stickiness (DAU/MAU)', 'DAU/MAU', '日活月活比|粘性', '%', 'SaaS|App|游戏', '月活里平均每天有百分之几回来 = 日活 ÷ 月活 × 100', 'active_users', 'active_users', 100);
E('retained_users', '留存用户数', 'Retained Users', '', '留存人数|回访用户', 'dcount', '人', 'SaaS|App|游戏|电商', '过一段时间还在用的人数');
R('retention_rate', '留存率', 'Retention Rate', '', '次日留存|7日留存|30日留存|用户留存率|retention', '%', 'SaaS|App|游戏|电商|营销', '一批新用户过 N 天还剩百分之几 = 留存用户数 ÷ 新增用户数 × 100', 'retained_users', 'new_users', 100);
E('new_users', '新增用户数', 'New Users', '', '新用户|新增用户|拉新人数|新增注册', 'dcount', '人', 'SaaS|App|游戏|营销|内容', '这段时间新来的用户');
E('trials', '试用数', 'Trials', '', '试用用户数|开通试用数|免费试用数', 'sum', '个', 'SaaS', '开了试用的数量');
R('trial_cvr', '试用转化率', 'Trial Conversion Rate', '', '试用转付费率', '%', 'SaaS', '试用的里有百分之几转成付费', 'trial_converted', 'trials', 100);
E('trial_converted', '试用转付费数', 'Trial Conversions', '', '转付费数', 'sum', '个', 'SaaS', '试用后付费了的数量');
E('seats', '座席数', 'Seats', '', '账号数|许可数|license数|席位数', 'stock', '个', 'SaaS', '买了多少个使用账号；跨月看期末');
E('renewals', '续约数', 'Renewals', '', '续费数|续订数|续约客户数', 'sum', '个', 'SaaS|订阅|教育', '到期后续约的数量');
R('renewal_rate', '续约率', 'Renewal Rate', '', '续费率|续订率', '%', 'SaaS|订阅|教育', '到期的里有百分之几续约 = 续约数 ÷ 到期数 × 100', 'renewals', 'expiring', 100);
E('expiring', '到期数', 'Expiring Contracts', '', '到期客户数|应续数', 'sum', '个', 'SaaS|订阅|教育', '这段时间到期的合同 / 订阅数');

/* ---------------- 用户与营销 / CRM ---------------- */
E('registrations', '注册数', 'Sign-ups', '', '注册人数|注册量|新注册|signups|registrations', 'sum', '个', '营销|SaaS|App|电商', '这段时间注册了多少');
E('activations', '激活数', 'Activations', '', '激活用户数|激活量', 'sum', '个', '营销|App|SaaS', '真正开始用的数量');
R('activation_rate', '激活率', 'Activation Rate', '', '激活转化率', '%', '营销|App|SaaS', '注册的里有百分之几激活了', 'activations', 'registrations', 100);
E('members', '会员数', 'Members', '', '会员人数|会员总数|累计会员|会员量', 'stock', '人', '零售|电商|营销|餐饮', '某个时点有多少会员；跨天看期末');
E('member_sales', '会员销售额', 'Member Sales', '', '会员消费额|会员贡献销售额', 'sum', '元', '零售|电商|营销', '会员买的金额');
R('member_sales_share', '会员销售占比', 'Member Sales Share', '', '会员贡献占比|会员消费占比', '%', '零售|电商|营销', '销售额里会员买的占百分之几', 'member_sales', 'sales', 100);
E('repurchase_cycle', '复购周期', 'Repurchase Cycle', '', '回购周期|购买间隔', 'avg', '天', '电商|零售|营销', '两次购买平均隔多少天');
E('sends', '发送数', 'Sends', '', '发送量|推送数|触达数|发送人数', 'sum', '次', '营销|CRM', '短信、邮件、推送发了多少条');
E('opens', '打开数', 'Opens', '', '打开次数|打开人数', 'sum', '次', '营销|CRM', '被打开了多少次');
R('open_rate', '打开率', 'Open Rate', 'OR', '邮件打开率|推送打开率', '%', '营销|CRM', '发出去的里有百分之几被打开', 'opens', 'sends', 100);
R('email_ctr', '邮件点击率', 'Email Click Rate', '', '推送点击率|短信点击率', '%', '营销|CRM', '发出去的里有百分之几被点击', 'clicks', 'sends', 100);
E('unsubscribes', '退订数', 'Unsubscribes', '', '取消订阅数|退订人数', 'sum', '人', '营销|CRM', '退订了多少人');
R('unsub_rate', '退订率', 'Unsubscribe Rate', '', '取关率', '%', '营销|CRM', '发出去的里有百分之几退订', 'unsubscribes', 'sends', 100);
E('nps', '净推荐值', 'Net Promoter Score', 'NPS', '推荐值|口碑分', 'none', '分', '营销|客服|SaaS', '推荐者占比减贬损者占比；要用原始问卷重算，不能平均');
E('csat', '满意度', 'Customer Satisfaction', 'CSAT', '客户满意度|满意率|满意度评分', 'none', '%', '客服|营销|SaaS', '说满意的人占百分之几；要用满意人数 ÷ 评价人数重算');
E('followers', '粉丝数', 'Followers', '', '关注数|粉丝量|订阅者|关注人数|粉丝总数', 'stock', '人', '内容|营销|直播', '某个时点有多少粉丝；跨天看期末');
E('new_followers', '涨粉数', 'New Followers', '', '新增粉丝|粉丝增量|净增粉丝|涨粉', 'sum', '人', '内容|营销|直播', '这段时间新增的粉丝');
E('likes', '点赞数', 'Likes', '', '点赞量|赞|like', 'sum', '次', '内容|营销', '被点了多少赞');
E('comments', '评论数', 'Comments', '', '评论量|留言数|comment', 'sum', '条', '内容|营销', '收到多少条评论');
E('shares', '分享数', 'Shares', '', '转发数|分享量|share', 'sum', '次', '内容|营销', '被分享了多少次');
E('posts', '发布数', 'Posts', '', '发帖数|内容发布数|作品数|发文数', 'sum', '条', '内容|营销', '发了多少条内容');
E('private_users', '私域用户数', 'Private Traffic Users', '', '私域人数|企微好友数|社群人数', 'stock', '人', '营销|零售', '加到私域（企业微信、社群）的人数；跨天看期末');
E('coupons_issued', '发券数', 'Coupons Issued', '', '优惠券发放数|领券数', 'sum', '张', '营销|电商|零售|餐饮', '发出去多少张券');
E('coupons_used', '核销数', 'Coupons Redeemed', '', '用券数|优惠券使用数|核销量', 'sum', '张', '营销|电商|零售|餐饮', '用掉多少张券');
R('redemption_rate', '核销率', 'Coupon Redemption Rate', '', '用券率|优惠券使用率|券核销率', '%', '营销|电商|零售|餐饮', '发出去的券有百分之几被用了', 'coupons_used', 'coupons_issued', 100);
E('referrals', '推荐数', 'Referrals', '', '老带新数|邀请数|分享拉新数', 'sum', '个', '营销|App|电商', '老用户拉来的新用户数');

/* ---------------- 客服 ---------------- */
E('inquiries', '咨询量', 'Inquiries', '', '咨询数|进线量|接待量|会话量|询单数|咨询人数', 'sum', '次', '客服|电商', '收到多少次咨询');
E('first_response', '首次响应时长', 'First Response Time', 'FRT', '首响时长|首次回复时间|首响', 'avg', '秒', '客服|电商', '顾客问了以后多久第一次回复（平均）');
E('handle_time', '平均处理时长', 'Average Handle Time', 'AHT', '处理时长|平均通话时长|解决时长', 'avg', '分钟', '客服', '处理一个问题平均用多久');
E('resolved_first', '一次解决数', 'First Contact Resolutions', '', '首次解决数', 'sum', '次', '客服', '第一次联系就解决了的数量');
R('fcr', '一次解决率', 'First Contact Resolution', 'FCR', '首次解决率|一次性解决率', '%', '客服', '咨询里有百分之几第一次就解决了', 'resolved_first', 'inquiries', 100);
E('tickets', '工单数', 'Tickets', '', '工单量|服务单|case数|ticket', 'sum', '单', '客服|SaaS', '开了多少张工单');
E('backlog', '积压工单', 'Ticket Backlog', '', '未结工单|待处理工单|积压量', 'stock', '单', '客服|SaaS', '某个时点还没处理完的工单；跨天看期末');
E('inquiry_buyers', '询单成交人数', 'Inquiry Conversions', '', '询单成交数|咨询下单人数', 'sum', '人', '客服|电商', '咨询过以后下单的人数');
R('inquiry_cvr', '询单转化率', 'Inquiry Conversion Rate', '', '咨询转化率|客服转化率', '%', '客服|电商', '咨询的人里有百分之几下单', 'inquiry_buyers', 'inquiries', 100);
R('reply_rate', '回复率', 'Response Rate', '', '应答率|接通率|回复率（客服）', '%', '客服|电商', '咨询里有百分之几被回复了', 'replied', 'inquiries', 100);
E('replied', '已回复数', 'Replied Inquiries', '', '应答数|接通数', 'sum', '次', '客服', '回复了的咨询数');

/* ---------------- 零售门店 ---------------- */
E('footfall', '客流量', 'Footfall', '', '进店人数|到店人数|客流|进店客流|traffic count', 'sum', '人次', '零售|餐饮', '来了多少人次（按人次算可以加）');
E('passersby', '过店客流', 'Passer-by Traffic', '', '路过人数|门前客流', 'sum', '人次', '零售', '从店门口经过的人次');
R('entry_rate', '进店率', 'Store Entry Rate', '', '入店率', '%', '零售', '路过的人里有百分之几进了店', 'footfall', 'passersby', 100);
R('close_rate', '成交率', 'Close Rate', '', '进店转化率|门店转化率|提袋率', '%', '零售', '进店的人里有百分之几买了 = 成交单数 ÷ 客流量 × 100', 'orders', 'footfall', 100);
E('store_area', '营业面积', 'Selling Area', '', '门店面积|经营面积|面积', 'stock', '平方米', '零售|餐饮', '店的营业面积');
R('sales_per_sqm', '坪效', 'Sales per Square Meter', '', '每平方米销售额|单位面积销售额|平效', '元/平方米', '零售|餐饮', '每平方米卖了多少钱 = 销售额 ÷ 营业面积', 'sales', 'store_area', 1);
E('staff_count', '员工人数', 'Staff Count', '', '店员数|在岗人数|员工数|人数（员工）', 'stock', '人', '零售|人力|餐饮|制造', '某个时点有多少员工；跨天看期末或平均');
R('sales_per_staff', '人效', 'Sales per Employee', '', '人均销售额|人均产值|人均业绩|人均产出', '元', '零售|人力|制造|餐饮', '平均每个员工带来多少销售额 = 销售额 ÷ 员工人数', 'sales', 'staff_count', 1);
E('stores', '门店数', 'Store Count', '', '店铺数|门店总数|网点数|店数', 'stock', '家', '零售|餐饮', '某个时点开着的门店数；跨天看期末');
R('sales_per_store', '店效', 'Sales per Store', '', '单店销售额|店均销售额|店均', '元', '零售|餐饮', '平均每家店卖多少钱', 'sales', 'stores', 1);
E('same_store_sales', '同店销售额', 'Same-store Sales', 'SSS|LFL', '可比门店销售额|同店|like for like', 'sum', '元', '零售|餐饮', '开满一年以上门店的销售额（用来比较增长）');
E('new_stores', '新开门店数', 'New Stores', '', '开店数|新开店', 'sum', '家', '零售|餐饮', '新开了多少家');
E('closed_stores', '关闭门店数', 'Closed Stores', '', '闭店数|关店数', 'sum', '家', '零售|餐饮', '关了多少家');

/* ---------------- 餐饮 ---------------- */
E('tables_served', '开台数', 'Tables Served', '', '开桌数|桌次|用餐桌数', 'sum', '桌', '餐饮', '一共开了多少桌（按桌次算）');
E('table_count', '餐桌数', 'Table Count', '', '桌位数|总桌数', 'stock', '张', '餐饮', '店里有多少张桌子');
R('table_turnover', '翻台率', 'Table Turnover Rate', '', '翻台次数|翻桌率', '次', '餐饮', '每张桌子平均坐了几轮 = 开台数 ÷ 餐桌数', 'tables_served', 'table_count', 1);
R('sales_per_table', '桌均消费', 'Average Spend per Table', '', '桌均|单桌消费', '元', '餐饮', '平均每桌花多少钱 = 销售额 ÷ 开台数', 'sales', 'tables_served', 1);
E('guests', '客人数', 'Guests', '', '就餐人数|用餐人数|来客数|客数', 'sum', '人次', '餐饮', '来吃饭的人次');
R('sales_per_guest', '人均消费（餐饮）', 'Average Spend per Guest', '', '餐饮人均|客单价（人均）', '元', '餐饮', '平均每位客人花多少钱 = 销售额 ÷ 客人数', 'sales', 'guests', 1);
E('seats_total', '座位数', 'Seats', '', '餐位数|客座数', 'stock', '个', '餐饮', '店里有多少座位');
R('occupancy_seat', '上座率', 'Seat Occupancy', '', '满座率|上座比例', '%', '餐饮', '座位有百分之几被坐了 = 客人数 ÷（座位数 × 营业餐段）× 100', 'guests', 'seats_total', 100);
E('food_cost', '食材成本', 'Food Cost', '', '原料成本|物料成本|食材费用', 'sum', '元', '餐饮', '买食材花的钱');
R('food_cost_rate', '食材成本率', 'Food Cost Ratio', '', '原料成本率|物料成本占比', '%', '餐饮', '食材成本占销售额的百分之几', 'food_cost', 'sales', 100);
E('labor_cost', '人力成本', 'Labor Cost', '', '人工成本|工资成本|薪酬成本|人工费', 'sum', '元', '餐饮|零售|人力|制造', '给员工花的钱');
R('labor_cost_rate', '人力成本率', 'Labor Cost Ratio', '', '人工成本率|人力成本占比|工资占比', '%', '餐饮|零售|人力|制造', '人力成本占收入的百分之几', 'labor_cost', 'revenue', 100);
E('rent', '房租', 'Rent', '', '租金|场地费|物业租金', 'sum', '元', '餐饮|零售', '场地租金');
R('rent_ratio', '租售比', 'Rent-to-Sales Ratio', '', '房租占比|租金占比', '%', '餐饮|零售', '房租占销售额的百分之几', 'rent', 'sales', 100);
E('delivery_orders', '外卖订单数', 'Delivery Orders', '', '外卖单量|外送订单|配送订单数', 'sum', '单', '餐饮', '外卖下了多少单');
R('delivery_share', '外卖占比', 'Delivery Share', '', '外卖订单占比|外卖收入占比', '%', '餐饮', '订单里外卖占百分之几', 'delivery_orders', 'orders', 100);
E('waste', '损耗', 'Waste', '', '报损|损耗金额|食材损耗', 'sum', '元', '餐饮|零售', '浪费、报废的金额');
R('waste_rate', '损耗率', 'Waste Rate', '', '报损率|损耗占比', '%', '餐饮|零售', '损耗占食材成本的百分之几', 'waste', 'food_cost', 100);
E('prep_time', '出餐时长', 'Ticket Time', '', '出餐时间|上菜时间|备餐时长', 'avg', '分钟', '餐饮', '下单到出餐平均多久');

/* ---------------- 制造 ---------------- */
E('output', '产量', 'Output', '', '生产数量|产出数量|完工数量|生产量|产出', 'sum', '件', '制造', '生产了多少件');
E('good_units', '良品数', 'Good Units', '', '合格数|良品数量|合格品数', 'sum', '件', '制造', '合格的件数');
R('yield', '良率', 'Yield', '', '合格率|良品率|成品率', '%', '制造', '产出里有百分之几合格 = 良品数 ÷ 产量 × 100', 'good_units', 'output', 100);
E('defects', '不良数', 'Defects', '', '不良品数|次品数|缺陷数', 'sum', '件', '制造', '不合格的件数');
R('defect_rate', '不良率', 'Defect Rate', 'DPPM|PPM', '次品率|缺陷率|不合格率', '%', '制造', '产出里有百分之几不合格', 'defects', 'output', 100);
E('first_pass', '一次通过数', 'First-pass Units', '', '直通数', 'sum', '件', '制造', '不用返工一次就合格的件数');
R('fpy', '直通率', 'First Pass Yield', 'FPY', '一次合格率|一次通过率', '%', '制造', '产出里有百分之几一次就合格', 'first_pass', 'output', 100);
E('oee', '设备综合效率', 'Overall Equipment Effectiveness', 'OEE', '综合效率|设备效率', 'none', '%', '制造', '可用率 × 性能率 × 良率；要用三项的合计重算，不能平均');
E('run_hours', '运行时长', 'Run Time', '', '开机时长|生产时长|运转时间', 'sum', '小时', '制造', '设备开着在生产的时间');
E('planned_hours', '计划时长', 'Planned Production Time', '', '计划生产时间|排班时长', 'sum', '小时', '制造', '本来计划生产的时间');
R('availability', '稼动率', 'Availability', '', '设备利用率|开动率|时间稼动率|可用率', '%', '制造', '计划时间里设备真正在跑百分之几 = 运行时长 ÷ 计划时长 × 100', 'run_hours', 'planned_hours', 100);
E('downtime', '停机时长', 'Downtime', '', '故障时长|停线时长|宕机时长', 'sum', '小时', '制造|SaaS', '停下来的时间');
E('mtbf', '平均故障间隔', 'Mean Time Between Failures', 'MTBF', '故障间隔时间', 'avg', '小时', '制造|SaaS', '平均多久坏一次');
E('mttr', '平均修复时间', 'Mean Time to Repair', 'MTTR', '平均维修时间|修复时长', 'avg', '小时', '制造|SaaS', '坏了平均多久修好');
E('capacity', '产能', 'Capacity', '', '设计产能|最大产能|产能上限', 'sum', '件', '制造', '最多能生产多少');
R('capacity_util', '产能利用率', 'Capacity Utilization', '', '产能负荷率|开工率', '%', '制造', '产能用了百分之几 = 产量 ÷ 产能 × 100', 'output', 'capacity', 100);
E('wip', '在制品', 'Work in Progress', 'WIP', '在制数量|半成品|在产品', 'stock', '件', '制造', '做了一半还没完工的；跨天看期末');
R('unit_cost', '单位成本', 'Unit Cost', '', '单件成本|单位生产成本|件成本', '元', '制造|库存|电商', '平均每件的成本 = 总成本 ÷ 数量', 'cogs', 'quantity', 1);
E('rework', '返工数', 'Rework', '', '返修数|返工量', 'sum', '件', '制造', '需要返工的件数');
R('rework_rate', '返工率', 'Rework Rate', '', '返修率', '%', '制造', '产出里有百分之几要返工', 'rework', 'output', 100);
E('scrap', '报废数', 'Scrap', '', '报废量|废品数', 'sum', '件', '制造', '报废的件数');
R('scrap_rate', '报废率', 'Scrap Rate', '', '废品率', '%', '制造', '产出里有百分之几报废', 'scrap', 'output', 100);
E('energy', '能耗', 'Energy Consumption', '', '用电量|耗电量|能源消耗|电耗', 'sum', '千瓦时', '制造|能源', '用了多少电 / 能源');
R('energy_per_unit', '单位能耗', 'Energy per Unit', '', '单耗|单位产品能耗', '千瓦时/件', '制造|能源', '平均每件用多少能源', 'energy', 'output', 1);

/* ---------------- 物流 ---------------- */
E('shipments', '运单量', 'Shipments', '', '发货单量|包裹数|件量|票数|运单数|parcels', 'sum', '票', '物流|电商|跨境', '发了多少票货');
E('delivered', '妥投量', 'Delivered Shipments', '', '签收量|送达量|妥投数', 'sum', '票', '物流|跨境', '送到了多少票');
R('delivery_rate', '妥投率', 'Delivery Success Rate', '', '签收率|送达率', '%', '物流|跨境', '发出去的里有百分之几送到了', 'delivered', 'shipments', 100);
E('ontime_delivered', '准时送达量', 'On-time Deliveries', '', '时效达成量|准时签收量', 'sum', '票', '物流|跨境', '按时送到的票数');
R('ontime_delivery_rate', '时效达成率', 'On-time Delivery Rate', 'OTD', '准时率|送达准时率|按时送达率', '%', '物流|跨境|制造', '送到的里有百分之几按时送到', 'ontime_delivered', 'delivered', 100);
E('transit_time', '运输时效', 'Transit Time', '', '平均时效|配送时长|在途时长|妥投时效|送达天数', 'avg', '天', '物流|跨境|电商', '从发出到送达平均多久');
E('lost', '丢件量', 'Lost Shipments', '', '丢失件数|遗失数', 'sum', '票', '物流', '丢了多少票');
R('lost_rate', '丢件率', 'Loss Rate', '', '遗失率', '%', '物流', '发出去的里有百分之几丢了', 'lost', 'shipments', 100);
E('broken', '破损量', 'Damaged Shipments', '', '破损件数|货损数', 'sum', '票', '物流', '坏了的票数');
R('broken_rate', '破损率（物流）', 'Shipment Damage Rate', '', '货损率', '%', '物流', '发出去的里有百分之几坏了', 'broken', 'shipments', 100);
R('cost_per_shipment', '单票成本', 'Cost per Shipment', 'CPP', '单件运费|单票运费|每票成本|平均运费', '元', '物流|电商|跨境', '平均每票货运费多少 = 运费 ÷ 运单量', 'shipping_fee', 'shipments', 1);
R('shipping_cost_ratio', '运费占比', 'Shipping Cost Ratio', '', '物流费率|物流成本占比|运费率', '%', '物流|电商|跨境', '运费占销售额的百分之几', 'shipping_fee', 'sales', 100);
E('returned_shipments', '退件量', 'Returned Shipments', '', '退回件数|拒收量|退件数', 'sum', '票', '物流|电商|跨境', '被退回来的票数');
R('rts_rate', '退件率', 'Return-to-Sender Rate', 'RTS', '拒收率', '%', '物流|电商|跨境', '发出去的里有百分之几被退回', 'returned_shipments', 'shipments', 100);
E('weight', '重量', 'Weight', '', '计费重|实重|毛重|kg', 'sum', '千克', '物流|跨境', '货有多重');
E('volume', '体积', 'Volume', 'CBM', '方数|立方|体积重', 'sum', '立方米', '物流|跨境', '货占多大地方');
R('load_factor', '装载率', 'Load Factor', '', '满载率|装箱率|车辆装载率', '%', '物流', '运力用了百分之几 = 实际装载 ÷ 最大装载 × 100', 'volume', 'capacity_volume', 100);
E('capacity_volume', '可装载体积', 'Available Capacity', '', '最大装载量', 'sum', '立方米', '物流', '最多能装多少');

/* ---------------- 人力 ---------------- */
E('hires', '入职人数', 'Hires', '', '新入职|招聘入职数|入职数', 'sum', '人', '人力', '这段时间入职了多少人');
E('leavers', '离职人数', 'Leavers', '', '离职数|流失人数|离职量', 'sum', '人', '人力', '这段时间走了多少人');
R('attrition', '离职率', 'Attrition Rate', '', '员工流失率|人员流失率|turnover rate', '%', '人力', '平均员工里有百分之几离职 = 离职人数 ÷ 平均员工人数 × 100', 'leavers', 'staff_count', 100);
E('open_positions', '招聘需求数', 'Open Positions', '', '空缺岗位|编制空缺|招聘岗位数', 'stock', '个', '人力', '还要招的岗位数');
R('hire_rate', '招聘完成率', 'Hiring Completion Rate', '', '招聘达成率|到岗率', '%', '人力', '要招的里招到了百分之几', 'hires', 'open_positions', 100);
E('time_to_hire', '招聘周期', 'Time to Hire', '', '到岗周期|招聘时长', 'avg', '天', '人力', '从开放岗位到入职平均多久');
E('attendance_days', '出勤天数', 'Attendance Days', '', '实际出勤|到岗天数', 'sum', '天', '人力', '实际上班的天数');
R('attendance_rate', '出勤率', 'Attendance Rate', '', '到岗率（出勤）', '%', '人力', '应出勤里有百分之几到了', 'attendance_days', 'scheduled_days', 100);
E('scheduled_days', '应出勤天数', 'Scheduled Days', '', '排班天数', 'sum', '天', '人力', '本来应该上班的天数');
E('overtime', '加班时长', 'Overtime Hours', 'OT', '加班小时|加班时间', 'sum', '小时', '人力|制造', '加了多少小时班');
E('training_hours', '培训时长', 'Training Hours', '', '培训学时|学习时长', 'sum', '小时', '人力|教育', '培训了多少小时');
E('payroll', '薪酬总额', 'Payroll', '', '工资总额|人工总成本|薪资总额|应发工资', 'sum', '元', '人力|财务', '发给员工的钱');
R('payroll_per_head', '人均薪酬', 'Average Pay', '', '人均工资|平均薪资', '元', '人力', '平均每人拿多少 = 薪酬总额 ÷ 员工人数', 'payroll', 'staff_count', 1);

/* ---------------- 跨境平台（亚马逊 / Shopee / TikTok Shop 等常见字段） ---------------- */
R('buybox_rate', '购物车占有率', 'Buy Box Percentage', '', 'buy box占比|黄金购物车占有率|buybox|featured offer percentage', '%', '跨境|电商', '页面浏览里有百分之几是你拿着购物车按钮', 'buybox_views', 'page_views', 100);
E('buybox_views', '拿到购物车的浏览量', 'Buy Box Page Views', '', '', 'sum', '次', '跨境', '你拿着购物车时的页面浏览量');
E('bsr', '销售排名', 'Best Sellers Rank', 'BSR', '畅销排名|大类排名|小类排名|类目排名', 'none', '', '跨境|电商', '平台给的类目销售排名；数字越小越好，不能相加平均');
E('sessions', '会话数', 'Sessions', '', '访问次数|买家访问次数|session', 'sum', '次', '跨境|电商|内容', '买家来访的次数（同一人一天多次算多次）');
R('usp', '订单商品数量转化率', 'Unit Session Percentage', 'USP', '单位会话转化率|unit session percentage|商品转化率', '%', '跨境|电商', '访问里有百分之几买了（按件）= 订购件数 ÷ 会话数 × 100', 'units', 'sessions', 100);
E('odr', '订单缺陷率', 'Order Defect Rate', 'ODR', '订单瑕疵率', 'none', '%', '跨境', '有差评、索赔或拒付的订单占百分之几（平台按窗口算，不能再加总）');
E('lsr', '迟发率', 'Late Shipment Rate', 'LSR', '延迟发货率|发货延迟率', 'none', '%', '跨境', '晚发货的订单占百分之几（平台口径）');
E('vtr', '有效追踪率', 'Valid Tracking Rate', 'VTR', '追踪率|有效物流追踪率', 'none', '%', '跨境', '有有效物流单号的订单占百分之几（平台口径）');
E('atoz', 'A-to-Z 索赔数', 'A-to-z Claims', '', 'atoz索赔|商城交易保障索赔', 'sum', '次', '跨境', '买家发起的保障索赔次数');
E('listing_quality', '商品信息质量分', 'Listing Quality Score', 'LQS', 'listing分|商品质量分', 'none', '分', '跨境|电商', '平台对商品页面的打分');
E('star_rating', '星级', 'Star Rating', '', '商品评分|平均星级|rating', 'none', '星', '跨境|电商', '商品的平均星级；合起来看要按评价数加权');
E('referral_fee', '销售佣金', 'Referral Fee', '', '平台佣金（跨境）|referral fee|销售提成', 'sum', '元', '跨境', '按售价收的平台佣金');
E('vat_amount', '增值税额', 'VAT Amount', '', 'vat|销项税|欧洲增值税', 'sum', '元', '跨境|财务', '交的增值税');
E('sponsored_spend', '站内广告花费', 'Sponsored Ads Spend', 'SP|SB|SD', 'sp广告花费|sb广告花费|sd广告花费|商品推广花费|品牌推广花费', 'sum', '元', '跨境|广告', '平台站内广告的花费');
E('organic_orders', '自然订单数', 'Organic Orders', '', '自然单|非广告订单', 'sum', '单', '跨境|电商|广告', '不是广告带来的订单 = 订单数 − 广告订单数');

/* ---------------- 内容 / 直播 ---------------- */
E('live_viewers', '观看人数', 'Live Viewers', '', '场观|直播观看人数|进房人数|观看用户数|累计观看人数', 'dcount', '人', '直播|内容', '来看直播的人数；跨场直接相加会重复');
E('peak_online', '在线峰值', 'Peak Concurrent Viewers', 'PCU', '最高在线|同时在线峰值', 'none', '人', '直播|游戏', '同一时刻最多有多少人在线；不能相加');
E('avg_online', '平均在线', 'Average Concurrent Viewers', 'ACU', '平均在线人数', 'avg', '人', '直播|游戏', '平均同时有多少人在线');
E('watch_time', '观看时长', 'Watch Time', '', '人均观看时长|平均观看时长|停留时长（直播）', 'avg', '分钟', '直播|内容', '平均每人看了多久');
R('live_cvr', '直播转化率', 'Live Conversion Rate', '', '观看转化率|直播间转化率|成交转化率（直播）', '%', '直播', '看直播的人里有百分之几买了', 'buyers', 'live_viewers', 100);
E('live_duration', '直播时长', 'Stream Duration', '', '开播时长|播出时长', 'sum', '小时', '直播', '播了多少小时');
R('gmv_per_hour', '小时成交额', 'GMV per Hour', '', '每小时GMV|时均成交', '元', '直播', '平均每小时卖多少 = 成交额 ÷ 直播时长', 'gmv', 'live_duration', 1);

/* ---------------- 金融 / 支付 ---------------- */
E('transactions', '交易笔数', 'Transactions', '', '交易量|支付笔数|成功笔数|txn', 'sum', '笔', '金融|电商|零售', '一共多少笔交易');
E('tpv', '交易额', 'Total Payment Volume', 'TPV', '支付总额|交易流水|处理金额|收单金额', 'sum', '元', '金融|电商', '经手的支付总金额');
R('fee_rate', '费率', 'Fee Rate', 'MDR', '手续费率|支付费率|扣率', '%', '金融|电商|跨境', '手续费占交易额的百分之几', 'fees', 'tpv', 100);
E('fees', '手续费', 'Fees', '', '支付手续费|交易费|通道费|服务费', 'sum', '元', '金融|电商|跨境', '收或付的手续费');
E('auth_success', '授权成功笔数', 'Authorized Transactions', '', '支付成功笔数', 'sum', '笔', '金融|电商', '支付授权通过的笔数');
R('auth_rate', '支付成功率', 'Authorization Rate', '', '授权成功率|付款成功率', '%', '金融|电商|跨境', '发起的支付里有百分之几成功', 'auth_success', 'transactions', 100);
R('chargeback_rate', '拒付率', 'Chargeback Rate', '', '退单率（拒付）|争议率（支付）', '%', '金融|跨境|电商', '交易里有百分之几被拒付', 'chargebacks', 'tpv', 100);
E('loan_amount', '放款额', 'Loan Disbursed', '', '放款金额|贷款发放额', 'sum', '元', '金融', '放出去多少贷款');
E('balance_outstanding', '贷款余额', 'Outstanding Balance', '', '在贷余额|存量余额|未还余额', 'stock', '元', '金融', '某个时点还没还的钱；跨天看期末');
E('overdue_amount', '逾期金额', 'Overdue Amount', '', '逾期本金|过期未还金额', 'stock', '元', '金融', '过了还款日还没还的钱');
R('overdue_rate', '逾期率', 'Delinquency Rate', 'DPD', '逾期比例|M1逾期率|不良率（贷款）', '%', '金融', '贷款余额里逾期的占百分之几（同一时点）', 'overdue_amount', 'balance_outstanding', 100);
E('bad_debt', '坏账', 'Bad Debt', '', '坏账金额|核销金额|呆账', 'sum', '元', '金融|财务', '收不回来的钱');

/* ---------------- 游戏 / App ---------------- */
E('downloads', '下载量', 'Downloads', '', '下载次数|下载数', 'sum', '次', 'App|游戏', '被下载了多少次');
E('installs', '安装量', 'Installs', '', '新增安装|激活安装|安装数', 'sum', '次', 'App|游戏|广告', '装了多少次');
R('cpi', '单次安装成本', 'Cost per Install', 'CPI', '安装成本|下载成本', '元', 'App|游戏|广告', '平均拿到一次安装花多少钱 = 广告花费 ÷ 安装量', 'ad_spend', 'installs', 1);
R('arpdau', '日活跃用户平均收入', 'Average Revenue per DAU', 'ARPDAU', '日活人均收入', '元', '游戏|App', '平均每个日活用户带来多少收入', 'revenue', 'active_users', 1);
E('crashes', '崩溃次数', 'Crashes', '', '闪退次数|崩溃数', 'sum', '次', 'App|游戏|SaaS', '程序崩了多少次');
R('crash_rate', '崩溃率', 'Crash Rate', '', '闪退率', '%', 'App|游戏', '打开次数里有百分之几崩了', 'crashes', 'launches', 100);
E('launches', '启动次数', 'App Launches', '', '打开次数|启动量', 'sum', '次', 'App|游戏', 'App 被打开了多少次');
E('app_rating', '应用评分', 'App Store Rating', '', '商店评分|app评分', 'none', '分', 'App|游戏', '应用商店的评分');

/* ---------------- 酒店 / 教育 / 医疗 / 地产 ---------------- */
E('rooms_sold', '售出间夜', 'Room Nights Sold', '', '入住间夜|间夜数|已售房间数', 'sum', '间夜', '酒店|旅游', '卖出去多少间夜');
E('rooms_available', '可售间夜', 'Room Nights Available', '', '可售房间数|可用间夜', 'sum', '间夜', '酒店|旅游', '一共能卖多少间夜');
R('occupancy', '入住率', 'Occupancy Rate', 'OCC', '出租率|开房率', '%', '酒店|旅游|地产', '能卖的房间里卖掉了百分之几 = 售出间夜 ÷ 可售间夜 × 100', 'rooms_sold', 'rooms_available', 100);
R('adr', '平均房价', 'Average Daily Rate', 'ADR', '平均每间夜房价|日均房价', '元', '酒店|旅游', '平均每间夜卖多少钱 = 客房收入 ÷ 售出间夜', 'room_revenue', 'rooms_sold', 1);
E('room_revenue', '客房收入', 'Room Revenue', '', '房费收入|住宿收入', 'sum', '元', '酒店|旅游', '卖房间挣的钱');
R('revpar', '每间可售房收入', 'Revenue per Available Room', 'RevPAR', '单房收益', '元', '酒店|旅游', '平均每间可售房挣多少 = 客房收入 ÷ 可售间夜', 'room_revenue', 'rooms_available', 1);
E('students', '学员数', 'Students', '', '在读学员|学生数|在籍人数', 'stock', '人', '教育', '某个时点在读的学员；跨月看期末');
E('lessons_attended', '到课人次', 'Attended Sessions', '', '出勤人次|上课人次', 'sum', '人次', '教育', '实际来上课的人次');
R('attendance_class', '到课率', 'Class Attendance Rate', '', '出勤率（课程）', '%', '教育', '应到的里有百分之几来了', 'lessons_attended', 'lessons_scheduled', 100);
E('lessons_scheduled', '应到人次', 'Scheduled Sessions', '', '排课人次', 'sum', '人次', '教育', '本来应该来的人次');
E('completions', '完课人数', 'Course Completions', '', '结课人数|完成人数', 'sum', '人', '教育', '学完课程的人数');
R('completion_course', '完课率', 'Course Completion Rate', '', '结课率|课程完成率', '%', '教育', '报名的里有百分之几学完了', 'completions', 'enrollments', 100);
E('enrollments', '报名人数', 'Enrollments', '', '报名数|报班人数|新签学员', 'sum', '人', '教育', '这段时间报名了多少人');
E('outpatient_visits', '门诊量', 'Outpatient Visits', '', '门诊人次|就诊人次|接诊量', 'sum', '人次', '医疗', '看了多少门诊');
E('bed_days', '实际占用床日', 'Occupied Bed Days', '', '占床日', 'sum', '床日', '医疗', '病床被占用的天数');
R('bed_occupancy', '床位使用率', 'Bed Occupancy Rate', '', '病床使用率', '%', '医疗', '床位有百分之几被占用', 'bed_days', 'bed_days_available', 100);
E('bed_days_available', '可用床日', 'Available Bed Days', '', '开放床日', 'sum', '床日', '医疗', '一共能用的床日');
R('alos', '平均住院日', 'Average Length of Stay', 'ALOS', '平均住院天数', '天', '医疗|酒店', '平均每位病人住几天 = 占用床日 ÷ 出院人数', 'bed_days', 'discharges', 1);
E('discharges', '出院人数', 'Discharges', '', '出院人次', 'sum', '人', '医疗', '出院了多少人');
E('visits_property', '来访量', 'Site Visits', '', '到访量|来访人次|看房人次', 'sum', '人次', '地产|零售', '来看的人次');
E('units_sold_property', '成交套数', 'Units Sold (Property)', '', '签约套数|认购套数', 'sum', '套', '地产', '卖了多少套');
R('sell_out_rate', '去化率', 'Sell-out Rate', '', '去化比例|销售率（地产）', '%', '地产', '推出的房子卖掉了百分之几', 'units_sold_property', 'units_launched', 100);
E('units_launched', '推盘套数', 'Units Launched', '', '可售套数|推出套数', 'sum', '套', '地产', '推出来卖的套数');
R('visit_cvr', '来访成交率', 'Visit-to-Sale Rate', '', '到访转化率|看房成交率', '%', '地产|零售', '来访的里有百分之几成交了', 'units_sold_property', 'visits_property', 100);

/* ---------------- 第五批补充（10-23）：对照 Shopify / Google Ads / Meta Ads / Amazon Seller Central / GA4 / SaaS / 财务 / 库存 / 人事 / 物流 的常见导出列，补词典里没有的 ---------------- */
// 英文别名尽量写「导出文件里真实的列名」（Impr.、Conv. value、Engaged sessions…）；比率的分子分母仍按角色指向词典里的另一条。
/* 广告：Google Ads / Meta Ads */
E('conv_value', '转化价值', 'Conversion Value', '', 'Conv. value|All conv. value|Purchase conversion value|Website purchases conversion value|Purchases conversion value|转化金额', 'sum', '元', '广告|电商', '广告带来的转化对应的金额（Google 的 Conv. value、Meta 的购物转化价值）；除以花费就是 ROAS');
E('interactions', '广告互动总次数', 'Interactions', '', 'Interactions|广告互动次数（Google）', 'sum', '次', '广告', 'Google Ads 里对广告的点击、点赞、播放等互动总次数');
R('interaction_rate', '互动率（广告）', 'Interaction Rate', '', 'Interaction rate|广告互动率', '%', '广告', '互动次数占曝光的百分之几 = 互动次数 ÷ 曝光量 × 100', 'interactions', 'impressions', 100);
E('link_clicks', '链接点击量', 'Link Clicks', '', 'Link clicks|Unique link clicks|链接点击|链接点击次数', 'sum', '次', '广告', 'Meta 广告里点了链接去到落地页的次数');
E('outbound_clicks', '出站点击量', 'Outbound Clicks', '', 'Outbound clicks|出站点击|站外点击', 'sum', '次', '广告', '从广告点出去到站外的次数');
E('landing_page_views', '落地页浏览量', 'Landing Page Views', 'LPV', 'Landing page views|落地页访问|着陆页浏览', 'sum', '次', '广告', '点了广告并且落地页真正打开的次数，比链接点击更准');
E('purchases', '购买次数', 'Purchases', '', 'Website purchases|Purchases|Results (purchase)|购物次数|网站购买次数|广告购买次数', 'sum', '次', '广告|电商', '广告带来的购买次数（Meta 的 Purchases）');
R('cost_per_purchase', '单次购买成本', 'Cost per Purchase', '', 'Cost per purchase|Cost per website purchase|购买成本', '元', '广告|电商', '平均每次购买花多少广告费 = 广告花费 ÷ 购买次数', 'ad_spend', 'purchases', 1);
E('thruplays', '15秒完整播放次数', 'ThruPlays', '', 'ThruPlays|ThruPlay|播放满15秒次数', 'sum', '次', '广告|内容', 'Meta 视频播放满 15 秒或看完的次数');
E('quality_score', '质量得分', 'Quality Score', 'QS', 'Quality score|关键词质量得分|质量分', 'none', '分', '广告', 'Google 对关键词和广告质量打的 1–10 分；不能相加，要看分布');
E('search_lost_is_budget', '预算导致的搜索曝光损失份额', 'Search Lost IS (budget)', '', 'Search lost IS (budget)|Search lost impression share (budget)|预算损失曝光份额', 'none', '%', '广告', '因为预算不够而没拿到的曝光份额；平台算好的比例，不能相加');
E('search_lost_is_rank', '排名导致的搜索曝光损失份额', 'Search Lost IS (rank)', '', 'Search lost IS (rank)|Search lost impression share (rank)|排名损失曝光份额', 'none', '%', '广告', '因为出价或质量排名低而没拿到的曝光份额；平台算好的比例，不能相加');
E('abs_top_is', '绝对顶部展示份额', 'Search Absolute Top Impression Share', '', 'Search abs. top IS|Search absolute top impression share|绝对顶部展示率|首位展示份额', 'none', '%', '广告', '广告排在搜索结果第一位的曝光份额；平台算好的比例');
E('view_through_conv', '浏览后转化数', 'View-through Conversions', 'VTC', 'View-through conv.|View through conversions|浏览转化|曝光后转化', 'sum', '次', '广告', '看过广告但没点，之后自己转化的次数');
R('video_view_rate', '视频观看率', 'Video View Rate', '', 'View rate|Video view rate|视频播放率', '%', '广告|内容', '曝光里有百分之几产生了视频观看 = 视频播放量 ÷ 曝光量 × 100', 'video_views', 'impressions', 100);
E('ad_units', '广告销量', 'Ad Units Sold', '', '7 Day Total Units|14 Day Total Units|Units sold (ads)|广告售出件数|广告成交件数', 'sum', '件', '广告|跨境', '广告带来的销售件数（亚马逊广告报表里的 Total Units）');
E('ntb_orders', '新品牌客户订单数', 'New-to-Brand Orders', 'NTB', 'New-to-brand orders|NTB orders|品牌新客订单', 'sum', '单', '广告|跨境', '亚马逊广告里首次购买该品牌的买家下的单');
R('ntb_rate', '新品牌客户订单占比', 'New-to-Brand Order Rate', '', 'New-to-brand order rate|NTB rate|品牌新客占比', '%', '广告|跨境', '广告订单里品牌新客占百分之几 = 新品牌客户订单 ÷ 广告订单数 × 100', 'ntb_orders', 'ad_orders', 100);
/* GA4 / 站内流量 */
E('ga_users', '用户数（GA4）', 'Total Users', '', 'Total users|Users|总用户数|用户', 'dcount', '人', '电商|内容|SaaS', 'GA4 里统计期内来过的去重用户数；跨天不能直接相加');
E('engaged_sessions', '参与会话数', 'Engaged Sessions', '', 'Engaged sessions|有效会话数|参与会话', 'sum', '次', '电商|内容', '停留超过 10 秒、或有转化事件、或看了 2 页以上的会话数');
R('ga4_engage_rate', '会话参与率', 'Session Engagement Rate', '', '参与会话占比|GA4 参与率', '%', '电商|内容', '会话里有百分之几算参与 = 参与会话数 ÷ 会话数 × 100', 'engaged_sessions', 'sessions', 100);
R('sessions_per_user', '人均会话数', 'Sessions per User', '', 'Sessions per user|每用户会话数', '次', '电商|内容', '平均每个用户来了几次 = 会话数 ÷ 用户数', 'sessions', 'ga_users', 1);
E('avg_session_duration', '平均会话时长', 'Average Session Duration', '', 'Average session duration|Avg. session duration|平均访问时长|每会话时长', 'avg', '秒', '电商|内容', '平均每次访问待多久；跨组要按会话数加权');
R('views_per_session', '每会话浏览页数', 'Pages per Session', '', 'Pages / Session|Pages per session|Views per session|每次访问页数', '页', '电商|内容', '平均每次访问看几页 = 浏览量 ÷ 会话数', 'page_views', 'sessions', 1);
E('event_count', '事件数', 'Event Count', '', 'Event count|Events|事件次数', 'sum', '次', '电商|内容|App', 'GA4 里所有事件触发的次数');
E('key_events', '关键事件数', 'Key Events', '', 'Key events|Goal completions|目标完成数|关键事件', 'sum', '次', '电商|内容|SaaS', 'GA4 里标记为关键（原转化）的事件次数，如购买、注册');
R('session_key_event_rate', '会话关键事件率', 'Session Key Event Rate', '', 'Session key event rate|会话转化率（GA4）', '%', '电商|内容', '会话里有百分之几发生了关键事件 = 关键事件数 ÷ 会话数 × 100', 'key_events', 'sessions', 100);
E('checkouts', '发起结账数', 'Checkouts Initiated', '', 'Checkouts|Begin checkout|begin_checkout|Initiate checkout|Checkouts initiated|发起结账', 'sum', '次', '电商', '点了结账按钮进入结账流程的次数');
R('checkout_rate', '结账发起率', 'Checkout Rate', '', 'Reached checkout rate|结账率', '%', '电商', '会话里有百分之几进入了结账 = 发起结账数 ÷ 会话数 × 100', 'checkouts', 'sessions', 100);
E('abandoned_checkouts', '放弃结账数', 'Abandoned Checkouts', '', 'Abandoned checkouts|Abandoned carts|弃单数|放弃购物车数', 'sum', '次', '电商', '进了结账但没付款就走的次数');
R('abandon_rate', '结账放弃率', 'Checkout Abandonment Rate', '', 'Abandoned checkout rate|Cart abandonment rate|购物车放弃率|弃单率', '%', '电商', '进了结账没付款的占百分之几 = 放弃结账数 ÷ 发起结账数 × 100', 'abandoned_checkouts', 'checkouts', 100);
/* 电商交易：Shopify / Amazon */
E('gross_sales', '毛销售额', 'Gross Sales', '', 'Gross sales|折前销售额|未扣优惠销售额', 'sum', '元', '电商|零售', 'Shopify 口径：折扣、退货之前的商品销售额');
E('total_sales', '总销售额（含运费税费）', 'Total Sales', '', 'Total sales|销售总额（含税运）', 'sum', '元', '电商', 'Shopify 口径：商品销售额 − 折扣 − 退货 + 运费 + 税费');
E('shipping_revenue', '运费收入', 'Shipping Charges', '', 'Shipping charges|Shipping collected|向买家收的运费|Shipping revenue', 'sum', '元', '电商|跨境', '向买家收的运费，和自己付给物流的运费不是一回事');
E('net_items_sold', '净售出件数', 'Net Items Sold', '', 'Net items sold|净销量|扣退后销量', 'sum', '件', '电商|零售', '售出件数扣掉退回的件数');
E('orders_fulfilled', '已履约订单数', 'Fulfilled Orders', '', 'Orders fulfilled|Fulfilled orders|已发货订单数|已履约单', 'sum', '单', '电商', '已经发出去的订单数');
R('fulfillment_order_rate', '订单履约率', 'Order Fulfillment Rate', '', 'Order fulfillment rate|发货完成率', '%', '电商', '订单里已发货的占百分之几 = 已履约订单数 ÷ 订单数 × 100', 'orders_fulfilled', 'orders', 100);
E('ordered_product_sales', '订购商品销售额', 'Ordered Product Sales', 'OPS', 'Ordered product sales|Ordered Product Sales - B2B|订购销售额|下单商品销售额', 'sum', '元', '跨境|电商', '亚马逊业务报告里按下单口径统计的商品销售额');
E('total_order_items', '订单商品总数', 'Total Order Items', '', 'Total order items|Total Order Items - B2B|订单商品件数', 'sum', '件', '跨境|电商', '亚马逊业务报告里订单中的商品总件数');
E('unfulfillable_qty', '不可售库存', 'Unfulfillable Quantity', '', 'Unfulfillable quantity|Unfulfillable|不可售数量', 'stock', '件', '跨境|库存', '仓库里损坏、过期等不能卖的库存');
E('reserved_qty', '预留库存', 'Reserved Quantity', '', 'Reserved quantity|Reserved|FC transfer|占用库存', 'stock', '件', '跨境|库存', '已被订单占用或在仓间转运、暂时不能卖的库存');
E('nmv', '净成交额', 'Net Merchandise Value', 'NMV', 'Net merchandise value|净商品交易额|净成交金额', 'sum', '元', '电商|零售', '成交总额扣掉取消、退款后实际成交的钱');
R('purchase_frequency', '购买频次', 'Purchase Frequency', '', 'Purchase frequency|Orders per customer|人均订单数|人均购买次数', '次', '电商|零售', '平均每个买家下几单 = 订单数 ÷ 买家数', 'orders', 'buyers', 1);
R('returning_cust_rate', '回头客占比', 'Returning Customer Rate', '', 'Returning customer rate|回头客比例|老客占比', '%', '电商|零售', '买家里老客占百分之几 = 老客数 ÷ 买家数 × 100', 'old_buyers', 'buyers', 100);
E('markdown_amount', '降价金额', 'Markdown Amount', '', 'Markdown amount|Markdowns|降价额|打折让利额', 'sum', '元', '零售|电商', '商品从原价降到现价让掉的钱');
R('markdown_rate', '降价率', 'Markdown Rate', '', 'Markdown rate|Markdown %|打折率', '%', '零售|电商', '降价金额占销售额的百分之几 = 降价金额 ÷ 销售额 × 100', 'markdown_amount', 'sales', 100);
R('markup', '加价率', 'Markup', '', 'Markup|Markup %|成本加成率', '%', '零售|电商', '售价比成本高百分之几 = 毛利 ÷ 商品成本 × 100；和毛利率分母不同', 'gross_profit', 'cogs', 100);
/* 内容 / 社媒 / SEO */
E('subscribers', '订阅者数', 'Subscribers', '', 'Subscribers|订阅数|订阅人数|频道订阅', 'stock', '人', '内容|直播', '订阅频道或账号的人数，是某一天的存量');
E('avg_view_duration', '平均每次观看时长', 'Average View Duration', '', 'Average view duration|Avg. view duration|平均播放时长', 'avg', '秒', '内容|直播', '平均每次播放看了多久；跨组要按播放量加权');
E('saves', '收藏保存数', 'Saves', '', 'Saves|Save|保存数|收藏量（内容）', 'sum', '次', '内容', '内容被收藏、保存的次数');
E('profile_visits', '主页访问量', 'Profile Visits', '', 'Profile visits|Profile views|主页浏览|主页访问次数', 'sum', '次', '内容', '账号主页被打开的次数');
E('avg_position', '平均排名', 'Average Position', '', 'Average position|Avg. position|Position|平均搜索排名|平均位置', 'none', '', '内容|广告', '搜索结果里平均排第几；不能相加，要按曝光加权');
E('backlinks', '外链数', 'Backlinks', '', 'Backlinks|Referring domains|反向链接数|外部链接', 'stock', '个', '内容', '别的网站指向我们的链接个数');
E('delivered_emails', '邮件送达数', 'Delivered Emails', '', 'Delivered|Emails delivered|送达邮件数|邮件送达', 'sum', '封', '营销', '发出去并成功送到收件箱的邮件数');
E('mqls', '营销合格线索数', 'Marketing Qualified Leads', 'MQL', 'MQLs|MQL count|市场合格线索', 'sum', '条', 'SaaS|营销', '市场部判断有意向、交给销售前的线索数');
E('sqls', '销售合格线索数', 'Sales Qualified Leads', 'SQL', 'SQLs|SQL count|销售合格线索', 'sum', '条', 'SaaS|营销', '销售确认值得跟进的线索数');
/* SaaS / 销售 */
E('contraction_mrr', '缩减 MRR', 'Contraction MRR', '', 'Contraction MRR|降档减少的 MRR', 'sum', '元', 'SaaS', '老客户降级、减座席少付的月经常性收入');
E('acv', '年合同价值', 'Annual Contract Value', 'ACV', 'Annual contract value|平均年合同额', 'avg', '元', 'SaaS', '一份合同平均每年的金额');
E('tcv', '合同总价值', 'Total Contract Value', 'TCV', 'Total contract value|合同总额', 'sum', '元', 'SaaS', '合同整个期限内的总金额');
E('bookings', '新签合同额', 'Bookings', '', 'Bookings|新签额|订单额（订阅）', 'sum', '元', 'SaaS', '本期签下的合同金额，不等于收入');
E('billings', '开票额', 'Billings', '', 'Billings|开票金额|账单金额', 'sum', '元', 'SaaS|财务', '本期开出去的发票金额，不等于已确认收入');
E('deferred_revenue', '递延收入', 'Deferred Revenue', '', 'Deferred revenue|合同负债|预收款', 'stock', '元', 'SaaS|财务', '钱收了但服务还没提供完的部分，是时点余额');
E('burn_rate', '月烧钱额', 'Burn Rate', '', 'Burn rate|Net burn|净烧钱额|月度净现金流出', 'sum', '元', 'SaaS|财务', '每月净花掉多少现金');
R('runway', '资金跑道', 'Runway', '', 'Runway|现金可用月数|可支撑月数', '月', 'SaaS|财务', '现金还够烧几个月 = 现金余额 ÷ 月烧钱额', 'cash', 'burn_rate', 1);
E('opportunities', '商机数', 'Opportunities', '', 'Opportunities|Open opportunities|销售机会数', 'sum', '个', 'SaaS|销售', '销售漏斗里的机会个数');
E('won_deals', '赢单数', 'Won Deals', '', 'Won deals|Closed won|成交商机数|赢单', 'sum', '个', 'SaaS|销售', '谈成签约的商机个数');
R('win_rate', '赢单率', 'Win Rate', '', 'Win rate|Close won rate|商机赢单率|签约率', '%', 'SaaS|销售', '商机里谈成了百分之几 = 赢单数 ÷ 商机数 × 100', 'won_deals', 'opportunities', 100);
E('sales_cycle', '销售周期', 'Sales Cycle Length', '', 'Sales cycle|Sales cycle length|成交周期|签约周期', 'avg', '天', 'SaaS|销售', '从商机创建到签约平均多少天；跨组要按单数加权');
E('resolution_time', '平均解决时长', 'Average Resolution Time', 'ART', 'Resolution time|Time to resolution|工单解决时长|处理完成时长', 'avg', '小时', '客服|SaaS', '从工单创建到解决平均多久；跨组要按工单数加权');
E('sla_met_tickets', '达标工单数', 'SLA Met Tickets', '', 'SLA met|Tickets within SLA|SLA 内工单', 'sum', '单', '客服', '在服务时限内处理完的工单数');
R('sla_rate', 'SLA 达成率', 'SLA Attainment', '', 'SLA attainment|SLA compliance|SLA 达标率|服务时限达成率', '%', '客服', '工单里按时处理的占百分之几 = 达标工单数 ÷ 工单数 × 100', 'sla_met_tickets', 'tickets', 100);
E('ces', '客户费力度', 'Customer Effort Score', 'CES', 'Customer effort score|费力度评分', 'none', '分', '客服|SaaS', '客户办成事觉得多费劲的评分；按人数加权平均');
/* 财务 */
E('working_capital', '营运资金', 'Working Capital', '', 'Working capital|净营运资本', 'stock', '元', '财务', '流动资产减流动负债，是时点余额');
E('interest_expense', '借款利息', 'Interest Expense', '', 'Interest expense|利息支出', 'sum', '元', '财务', '借钱付出去的利息');
R('interest_coverage', '利息保障倍数', 'Interest Coverage Ratio', '', 'Interest coverage|Times interest earned|TIE', '倍', '财务', '赚的钱够付几倍利息 = 营业利润 ÷ 利息费用', 'operating_profit', 'interest_expense', 1);
E('capex', '资本支出', 'Capital Expenditure', 'CAPEX', 'Capital expenditure|CapEx|购建固定资产支出', 'sum', '元', '财务', '买设备、建厂房等长期投入花的钱');
E('depreciation', '折旧摊销', 'Depreciation & Amortization', 'D&A', 'Depreciation|Amortization|折旧|摊销', 'sum', '元', '财务', '长期资产按期分摊进成本的钱');
R('asset_turnover', '总资产周转率', 'Asset Turnover', '', 'Asset turnover|总资产周转次数', '次', '财务', '每块钱资产一年带来多少收入 = 收入 ÷ 总资产', 'revenue', 'total_assets', 1);
R('ar_turnover', '应收账款周转率', 'Accounts Receivable Turnover', '', 'AR turnover|Receivables turnover|应收周转率', '次', '财务', '应收账款一年收回几轮 = 收入 ÷ 应收账款', 'revenue', 'ar', 1);
R('debt_to_equity', '产权比率', 'Debt-to-Equity Ratio', 'D/E', 'Debt to equity|DE ratio|负债权益比', '倍', '财务', '负债是净资产的几倍 = 总负债 ÷ 净资产', 'total_liabilities', 'equity', 1);
R('cash_ratio', '现金比率', 'Cash Ratio', '', 'Cash ratio', '倍', '财务', '现金能还几倍短期债 = 现金余额 ÷ 流动负债', 'cash', 'current_liabilities', 1);
E('pretax_profit', '利润总额', 'Profit Before Tax', 'EBT', 'Profit before tax|PBT|税前利润|Pre-tax profit', 'sum', '元', '财务', '交所得税之前的利润');
E('income_tax', '所得税费用', 'Income Tax Expense', '', 'Income tax|Income tax expense|所得税', 'sum', '元', '财务', '利润要交的所得税');
R('effective_tax_rate', '有效税率', 'Effective Tax Rate', '', 'Effective tax rate|ETR|实际所得税率', '%', '财务', '利润实际交了百分之几的税 = 所得税费用 ÷ 利润总额 × 100', 'income_tax', 'pretax_profit', 100);
E('shares_outstanding', '总股本', 'Shares Outstanding', '', 'Shares outstanding|流通股数|股本', 'stock', '股', '财务', '公司发行在外的股数，是时点值');
R('eps', '每股收益', 'Earnings per Share', 'EPS', 'Earnings per share|每股盈利', '元', '财务', '每股赚了多少钱 = 净利润 ÷ 总股本', 'net_profit', 'shares_outstanding', 1);
E('market_cap', '市值', 'Market Capitalization', '', 'Market cap|Market capitalization|总市值', 'stock', '元', '财务', '股价乘总股本，每天一个值');
R('pe_ratio', '市盈率', 'Price-to-Earnings Ratio', 'PE', 'P/E|PE ratio|P/E ratio|Price to earnings', '倍', '财务', '市值是一年净利润的几倍 = 市值 ÷ 净利润', 'market_cap', 'net_profit', 1);
E('dividends', '股息分红', 'Dividends', '', 'Dividends|Dividend paid|分红|派息', 'sum', '元', '财务', '分给股东的钱');
/* 库存 / 供应链 */
R('gmroi', '毛利投资回报率', 'Gross Margin Return on Inventory', 'GMROI', 'Gross margin return on investment|GMROII|库存毛利回报', '倍', '零售|库存', '库存里每投 1 块钱带来多少毛利 = 毛利 ÷ 库存金额', 'gross_profit', 'stock_value', 1);
R('inv_sales_ratio', '库销比', 'Inventory-to-Sales Ratio', '', 'Inventory to sales ratio|Stock-to-sales ratio|库存销售比', '倍', '零售|库存', '库存金额是销售额的几倍 = 库存金额 ÷ 销售额', 'stock_value', 'sales', 1);
E('backorders', '缺货待发订单', 'Backorders', '', 'Backorders|Back orders|欠货订单|缺货订单数', 'sum', '单', '库存|电商', '下了单但没货、等补货再发的订单数');
R('backorder_rate', '缺货待发率', 'Backorder Rate', '', 'Backorder rate|欠货率', '%', '库存|电商', '订单里因缺货等待的占百分之几 = 缺货待发订单 ÷ 订单数 × 100', 'backorders', 'orders', 100);
E('carrying_cost', '库存持有成本', 'Inventory Carrying Cost', '', 'Carrying cost|Holding cost|库存占用成本|库存持有费用', 'sum', '元', '库存|财务', '放着库存花的钱：资金占用、仓储、损耗等');
E('order_cycle_time', '订单周期', 'Order Cycle Time', '', 'Order cycle time|订单履约周期|下单到收货天数', 'avg', '天', '物流|库存', '从下单到收货平均多少天；跨组要按单数加权');
E('dock_to_stock', '上架时效', 'Dock-to-Stock Time', '', 'Dock to stock|Receiving to putaway|入库上架时长', 'avg', '小时', '物流|库存', '货到仓到上架可售平均多久');
/* 物流 */
E('first_attempt_delivered', '首次投递成功量', 'First-attempt Deliveries', '', 'First attempt delivered|First-attempt deliveries|一次妥投量', 'sum', '单', '物流', '第一次派送就签收的运单数');
R('first_attempt_rate', '首次投递成功率', 'First-attempt Delivery Rate', 'FADR', 'First attempt delivery rate|首次妥投率|一次妥投率', '%', '物流', '运单里第一次就送到的占百分之几 = 首次投递成功量 ÷ 运单量 × 100', 'first_attempt_delivered', 'shipments', 100);
E('distance', '里程', 'Distance', '', 'Distance|Mileage|行驶里程|运输里程', 'sum', 'km', '物流', '车辆跑了多少公里');
R('cost_per_km', '每公里成本', 'Cost per Kilometer', '', 'Cost per km|Cost per mile|单公里成本', '元', '物流', '每跑一公里花多少钱 = 运费 ÷ 里程', 'shipping_fee', 'distance', 1);
/* 人事 */
E('absent_days', '缺勤天数', 'Absent Days', '', 'Absent days|Absence days|缺勤', 'sum', '天', '人力', '该上班没来的天数');
R('absenteeism_rate', '缺勤率', 'Absenteeism Rate', '', 'Absenteeism rate|Absence rate', '%', '人力', '应出勤里缺勤占百分之几 = 缺勤天数 ÷ 应出勤天数 × 100', 'absent_days', 'scheduled_days', 100);
E('offers_made', '发出录用数', 'Offers Made', '', 'Offers extended|Offers made|发 offer 数', 'sum', '个', '人力', '给候选人发出去的录用通知数');
E('offers_accepted', '接受录用数', 'Offers Accepted', '', 'Offers accepted|接受 offer 数', 'sum', '个', '人力', '候选人答应入职的数');
R('offer_accept_rate', '录用接受率', 'Offer Acceptance Rate', '', 'Offer acceptance rate|OAR|offer 接受率', '%', '人力', '发出的录用里被接受的占百分之几 = 接受录用数 ÷ 发出录用数 × 100', 'offers_accepted', 'offers_made', 100);
E('recruiting_cost', '招聘费用', 'Recruiting Cost', '', 'Recruiting cost|Recruitment cost|招聘支出', 'sum', '元', '人力', '招人花的钱：渠道、猎头、广告等');
R('cost_per_hire', '单次招聘成本', 'Cost per Hire', 'CPH', 'Cost per hire|Cost-per-hire|人均招聘成本', '元', '人力', '招一个人平均花多少钱 = 招聘费用 ÷ 入职人数', 'recruiting_cost', 'hires', 1);
E('enps', '员工净推荐值', 'Employee Net Promoter Score', 'eNPS', 'Employee NPS|员工 NPS', 'none', '分', '人力', '员工愿不愿意推荐公司给朋友的分值；按人数重新算，不能相加');

/* ---------------- 英文导出列名补别名（Google Ads / Meta / GA4 / Amazon / Shopify 导出里常见的写法） ---------------- */
// 只往已有条目上加别名；和别的条目重名的自动跳过，不制造新的撞车。
(function addExportAliases(){
  const nk = s => String(s == null ? '' : s).replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim().toLowerCase().replace(/[\s_\-·.、]+/g, '');
  const owner = new Map();
  for (const e of D) for (const k of [e.zh, e.en, ...e.abbr, ...e.alias]) { const n = nk(k); if (n) { if (!owner.has(n)) owner.set(n, new Set()); owner.get(n).add(e.id); } }
  const ADD = {
    impressions: 'Impr.|Impressions', clicks: 'Clicks', ad_spend: 'Cost|Amount spent|Spend', conversions: 'Conv.|All conv.|Results',
    ctr: 'Click-through rate|Link CTR', cpc: 'Avg. CPC|Cost per link click', cpm: 'Avg. CPM|CPM (cost per 1,000 impressions)',
    ad_cvr: 'Conv. rate|Conversion rate (ads)', cpa: 'Cost / conv.|Cost per result|Cost per conv.',
    roas: 'Purchase ROAS|Conv. value / cost|Website purchase ROAS', reach: 'Reach', frequency: 'Frequency',
    sessions: 'Sessions - Total|Sessions total|Total sessions', page_views: 'Page Views - Total|Page views total|Screen views',
    add_to_cart: 'Add to carts|Adds to cart|Added to cart|Add to cart', orders: 'Total orders|Orders placed',
    new_buyers: 'First-time customers|New customers', old_buyers: 'Returning customers',
    discount_amount: 'Discounts|Total discounts', returns: 'Items returned', refund_amount: 'Refunds|Refunded amount',
    net_sales: 'Net sales', shipping_fee: 'Shipping cost', visitors: 'Visitors|Unique visitors', bounce_rate: 'Bounce rate',
    buybox_rate: 'Featured Offer Percentage|Featured offer %', new_users: 'New users|Newly acquired users',
    video_views: 'Views|Video plays|Video views', active_users: 'Active users', engagements: 'Post engagement|Total engagements',
    units: 'Units Ordered', aov: 'Average order value|AOV', sales: 'Total sales amount|Sales amount',
  };
  for (const e of D) {
    const add = ADD[e.id]; if (!add) continue;
    for (const a of L(add)) { const n = nk(a); const o = owner.get(n); if (o && !(o.size === 1 && o.has(e.id))) continue; if (o && o.has(e.id)) continue; e.alias.push(a); if (!owner.has(n)) owner.set(n, new Set()); owner.get(n).add(e.id); }
  }
})();

module.exports = D;
