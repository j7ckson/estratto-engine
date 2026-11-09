# 语义层领域包（semantic packs）

一个「领域包」= 一套指标 + 维度 + 粒度 + 关系，描述一类业务场景该怎么取数。
新增场景（广告、直播、财务、库存……）= 新增一个 JSON，**不改 `main/semantic.js`**。

加载：`new Semantic().load(require('./main/semantic/ads.json'))`

## 包结构

```jsonc
{
  "id": "ads",                 // 小写字母数字下划线，唯一
  "name": "广告",
  "grain": {                    // 每张表「一行是什么」（扇出防护的依据）
    "ads": ["ad_id"],
    "orders": ["order_id"]
  },
  "metrics": [
    // simple：列 + 聚合
    { "id": "ad_spend", "name": "广告花费", "kind": "simple",
      "dataset": "ads", "agg": "sum", "field": "spend",
      "additivity": "additive", "unit": "GBP", "decimals": 2 },
    // ratio：两个指标的比值（可乘 100）
    { "id": "ctr", "name": "点击率", "kind": "ratio",
      "num": "clicks", "den": "impressions", "mul": 100,
      "additivity": "ratio", "unit": "%" },
    // derived：四则运算树，叶子是别的指标 id
    { "id": "gross_margin", "kind": "derived",
      "expr": { "op": "div", "args": [ { "op": "sub", "args": ["gmv", "cost"] }, "gmv" ] },
      "additivity": "ratio" }
  ],
  "dims": [
    // column：直接取列
    { "id": "platform", "kind": "column", "source": { "table": "ads", "field": "platform" } },
    // timeBucket：按周/月/年分桶（周一为一周）
    { "id": "ad_week", "kind": "timeBucket", "source": { "table": "ads", "field": "date" }, "grain": "week" },
    // bucket：数值分档（edges 是含上限的分界点）
    { "id": "tier", "kind": "bucket", "source": { "table": "orders", "field": "amount" },
      "edges": [50, 100], "labels": ["小单", "中单", "大单"] },
    // map：值映射（映射表只在本机）
    { "id": "status", "kind": "map", "source": { "table": "sessions", "field": "status" },
      "mapping": { "1": "直播中", "2": "已结束" }, "default": "未知" }
  ],
  "relationships": [
    // cardinality 方向 = left:right
    // orders(1) — refunds(N)：一对多，加可指标不能 join refunds 分组
    { "id": "orders_refunds", "left": "orders", "right": "refunds",
      "pairs": [["order_id", "order_id"]], "cardinality": "1:N" },
    // orders(N) — stores(1)：多对一，安全
    { "id": "orders_stores", "left": "orders", "right": "stores",
      "pairs": [["store_id", "store_id"]], "cardinality": "N:1" }
  ]
}
```

## 指标 additivity（决定扇出规则）

| 值 | 含义 | join 事实表（1:N / N:N）时的处理 |
|---|---|---|
| `additive` | 可加（GMV、花费、单量） | **拒绝**，先按粒度预聚合 |
| `semiAdditive` | 半可加（库存、库龄快照） | 拒绝行级 join，先取期末快照 |
| `ratio` | 比率（CTR、ROAS、毛利率） | 拒绝，分子分母各自按粒度聚合后再除 |
| `distinct` | 去重（SKU 数、店铺数） | 拒绝 |

## 扇出防护怎么生效

`eval(metricId, dims, tables)` 内部先跑 `checkJoin`：

- 维度在基表 → 直接分组；
- 维度在「1 侧」表，且能沿 N:1 路径（支持多跳）走到 → 查表取标签，**不复制行**；
- 维度要经过 1:N / N:N → 抛错，写明是哪条关系、哪个指标；
- 两张表之间没声明关系 → 抛错。

核心：**宁可报错，也不返回一个看着正常但加错过的数。**

## 新增一个场景（三步）

1. 在 `main/semantic/` 新建 `xxx.json`，按上面结构写指标/维度/粒度/关系；
2. 在 `test/semantic.test.js` 里加几张表 + 几条断言（至少一条「扇出被拒」用例）；
3. 跑 `node test/semantic.test.js` 全绿即合入。

## 边界（v1 未做）

- 纯 JS 计算，用于校验与测试；**尚未发射 SQL**、尚未接到 `harness.fetch` / `gate`。
- 多事实表「预聚合后再 join」的 SQL 生成路径留到 v2；当前先拒绝，不允许静默放大。
- 半可加指标的快照语义（取哪个日期的值）尚未实现，只做了 join 层面的防护。
