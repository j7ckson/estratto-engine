# estratto-engine

Ask business questions in plain language over your own data and get **numbers computed locally**, with a status that tells you how far to trust them.

The model is only used to turn the question into a small structured plan (or, as a fallback, one read-only SQL statement). The plan is validated and executed on your machine against DuckDB; the answer text is rendered locally from typed facts. No data rows and no computed values are sent to the model.

This package is the headless engine behind the Estratto Studio desktop app (same planner, executor, prompts and checks), packaged for Node.js. Version `1.0.0-rc.8` is a release candidate.

## Install

```sh
npm install estratto-engine          # Node >= 22.5 (uses node:sqlite)
node node_modules/estratto-engine/scripts/fetch-model.js ./models   # optional: local multilingual-e5-small for value matching
```

The e5 model is not bundled (118 MB). Without it the engine runs with vectors disabled and emits a `vectors_disabled` warning event.

## Quickstart

```js
const { createEngine, openaiCompatible } = require('estratto-engine')   // ESM: import { createEngine } from 'estratto-engine'

const engine = await createEngine({
  dataDir: './state',                                  // everything the engine writes lives here (reuse.db, rules/, warehouse.duckdb)
  data: { files: ['./node_modules/estratto-engine/examples/sales.csv'] },                    // or { duckdb: './warehouse.duckdb' }  (opened read-only)
  rules: [require('estratto-engine/examples/sales-pack.json')],   // semantic pack(s) (this one ships in the package); omit to auto-generate (best effort, see Limits)
  model: openaiCompatible({ baseURL: 'https://api.example.com/v1', apiKey: process.env.MY_KEY, model: 'my-model' }),
  modelsDir: './models',                               // contains multilingual-e5-small/ ; optional
  anchor: '2026-10-22', timezone: 'Asia/Shanghai',
  onEvent: e => console.log(e.type),
})
const r = await engine.ask('2026年10月 Amazon 的销售额是多少？')
console.log(r.status, r.answerLine)      // verified  ANSWER: 49.75 元（销售额，口径：…）
console.log(r.facts, r.sql, r.route, r.usage.calls, r.meta)
if (r.status === 'needs_confirm') console.log(r.confirm)      // { kind, options }  ->  await engine.confirm(r.requestId, choice)
await engine.close()
```

Any model works: `model: { async generate(req, signal) { return { text, usage, finish_reason, request_id } } }` with `req = { messages, maxOutputTokens, temperature: 0, purpose: 'ir', repair }`. `openaiCompatible({ baseURL, apiKey, model, thinking: 'disabled'|'false_bool'|'low', thinkingRepair, timeoutMs, headers })` posts `{ model, messages, stream:false, temperature:0, max_tokens, response_format:{type:'json_object'}, thinking… }` to `<baseURL>/chat/completions`. The API key stays inside that closure. The engine itself never reads `process.env` or credential files.

### API

| call | |
|---|---|
| `engine.ask(question, {requestId?, signal?, anchor?})` | returns `{requestId, status, answer, answerLine, facts, rows, plan, sql, route, confirm?, meta:{dataStamp, ruleVersion, codeVersion, anchor, checks}, usage:{calls, providerCalls, tokens}, raw}` |
| `engine.cancel(requestId)` | aborts the in-flight model call and SQL; the ask resolves `cancelled`; a late result is never cached |
| `engine.confirm(requestId, choice)` | re-asks with the user's choice (value pick / accept) |
| `engine.rules.list/propose/confirm/reject/revert` | rule patches, persisted in `dataDir/rules`, hot-loaded (async). Confirming auto-generated items via `engine.confirm(id,'accept')` creates a record `{id, kind:'auto_confirm', items, decided_by, at, status}` in `list()`; `revert(recordId)` (or a metric/dimension id such as `result.plan.metric_ids[i]`) sets those items back to unconfirmed and drops cached answers that relied on them. `rules.confirm(recordId)` re-confirms a reverted record (same record, status back to `confirmed`); `rules.reject(recordId)` on an active record = revert, on a reverted one it throws |
| `engine.tables()` (columns/tables left out because of unsafe names are listed redacted with `excluded:true`), `engine.info()`, `await engine.close()` | |
| `writeAttempt(result, dir)` | writes `answer.txt`, `raw.json`, `facts.json`, `meta.json` |

Options: `limits {maxCallsPerQuestion:2, maxCallsTotal:4, maxTokensPerQuestion:2000, maxOutputTokens:400, memoryLimit:'2GB'}`, `reuse` (default true: results/plans cached in `dataDir/reuse.db`), `sqlFallback` (default true), `vectors` (default true).

### CLI

```sh
export ESTRATTO_API_KEY=...   # read by the CLI shell only
npx estratto ask --data sales.csv --rules pack.json --base-url https://api.example.com/v1 --model my-model --data-dir ./state "2026年10月 Amazon 的销售额是多少？"
```
`--data` takes one `.duckdb` file or several csv/tsv/xlsx/parquet files. `--json` prints the structured result, `--no-vectors`, `--models-dir`, `--anchor`, `--timezone`, `--thinking` are available.

### Workspace, local page and MCP (rc.6)

```sh
export ESTRATTO_API_KEY=...                       # read by the CLI only; stored in the workspace's secrets.json (0600)
estratto init --yes --name sales --data ./exports --provider deepseek --model deepseek-chat    # or without --yes in a terminal
estratto rules                                    # metrics AND dimensions (channel, country ...) recognised from your columns, with kind and state
estratto rules preview m:au_sales_amount          # all-data total and last full month, computed locally, no model call
estratto rules preview d:au_sales_channel         # a dimension: number of distinct values + the 5 with most rows (local only, never sent to a model)
estratto rules confirm m:au_sales_amount          # or: reject <id> ("not right") / revert <id>; the same for d:... ids
estratto serve --name sales                       # http://127.0.0.1:7317  (ask page + settings link + session token)
estratto serve --name sales --token <t> --print-config json   # fixed session token (or config surfaces.serve.token); one JSON line {endpoint, token, settingsUrl, ownerKey} for hosts
estratto mcp --name sales                         # MCP over stdio: ask, list_tables, list_rules (+ confirm_rule, revert_rule, confirm_choice when surfaces.mcp.allowRuleChanges)
estratto status | usage | doctor | config get|set|set-key | add <path> | rules export|import

# rc.8: guided data setup (interactive `estratto init` asks: do you already use a SQL database? -> where is your data? -> pick -> import)
# DuckDB is the engine's own built-in database (nothing to install); SQLite files, PostgreSQL and MySQL are copied into it, read-only.
estratto init --yes --name shop --db none --warehouse ~/data/shop.duckdb --scan ~/exports ~/orders --pick all     # scans ONLY the folders you name
estratto init --yes --name shop --db sqlite --data ./shop.db --tables orders,customers
ESTRATTO_DB_PASSWORD=... estratto init --yes --name shop --db postgres --pg-url postgres://reader@db.example.com:5432/shop?schema=public --tables orders,refunds
estratto add --mysql mysql://reader@db.example.com/shop --tables orders      # password from ESTRATTO_DB_PASSWORD
estratto add --refresh                                                      # take new snapshots of database sources now (otherwise every data.refreshMinutes, default 15, on the next question)
```
A workspace is `<home>/<name>/` (`~/.estratto` by default, `--home` or `ESTRATTO_HOME`): `estratto.json` (config), `secrets.json` (key), `usage.jsonl` (one line per model call), plus the engine's own data. In code: `const ws = await openWorkspace({ home, name })`, then `ws.ask(...)`; `createEngine` keeps working without a workspace. New engine options: `privacy.hiddenColumns`, `data.refresh:'auto'`, `limits.dailyBudgetUSD` + `limits.price`; new calls `engine.rules.metrics()`, `engine.rules.preview(id)`, `engine.refreshData()`. HTTP API: `docs/HTTP-API.md`. Design decisions: `DECISIONS.md` ("1.0 workspace & surfaces").

## Status meanings

| status | meaning |
|---|---|
| `verified` | planned from registered rules, validated, executed locally; the number is the data's number |
| `needs_confirm` | a number may exist, but something needs a human: a value reading was guessed (`value_guess`), field names were auto-generated, the plan needs a choice (`value_choice`, time role, metric…). See `r.confirm` |
| `unverified` | SQL fallback used fields or joins that no rule registers; treat the number as a draft |
| `no_data` | the query ran, no rows matched |
| `refused` | the question cannot be expressed with the available rules (capability gap), or the privacy transport blocked the request |
| `cancelled` | `cancel()` / abort signal |
| `error` | model unavailable, unusable output after the allowed attempts, or an internal error |

## Privacy guarantees (enforced inside the engine; the host cannot disable them)

- What leaves the machine, per request: the question text, anchor date and timezone, table and column names, rule names/ids/units/definitions, candidate ids, and dimension values **only if they literally appear in the question**.
- Never sent: data rows, computed values, result numbers, value lists. `previous_errors` (repair attempts) are reduced to a typed category plus authorized column names.
- Every request passes the same transport (`src/privacy.js`). A request that does not have the expected shape is **not sent**: the ask ends `refused`, event `outbound_blocked`.
- SQL fallback: a single read-only `SELECT`/`WITH` over registered tables, validated locally (no files, no system tables, no external access), at most 60 rows and 20 s, at most 4 model calls per question.
- Rules you supply are trusted input: whatever they contain (aliases, notes) is part of the prompt.
- Table or column names that contain control characters / line breaks or are longer than 64 characters are never given to the registry, the rules or any prompt: with `data.duckdb` they are excluded (event `import_warning`, name shortened to 16 characters + `…`), with `data.files` columns are renamed `col_<n>`.

## Limits

- Auto-generated rules (no `rules` option) are best effort: names come from a dictionary and column names only (no model naming), every answer that depends on them is `needs_confirm` until confirmed (`engine.confirm(id,'accept')` or `engine.rules`). Hand-written or reviewed packs give the best results.
- Questions that need a concept your data/rules do not have are refused, not guessed.
- One database per engine; no streaming; xlsx import loads the workbook into memory.
- Auto-rules mode (rc.7): a question about a rate / share / average (率, 比例, 占比, 百分比, 平均, rate, ratio, share, average, `per order` ...) is never answered with a plain total. If the answer's metric is not a ratio / average (or the SQL does not divide / average), the result is `needs_confirm` with `confirm.kind: "no_such_metric"`, no number, and a suggestion such as `退款额 ÷ 销售额` when both metrics exist; define the metric in the rules and ask again. With a supplied rules pack this guard does not exist (rc.6 behaviour, byte for byte).
- Auto-rules mode (rc.7): date columns are recognised from the real DuckDB type (so `下单日期` gets a time role); a currency column named 币种 / 货币 / 币别 is read like `currency` (several codes -> amounts are flagged "含多种币种，未换汇，不能直接相加" in answers and previews; one code -> the unit names it). Currencies are never converted.
- `engine.confirm(id,'accept')` on a SQL-lane answer: if it is pending only because it reads auto-named fields, accepting confirms those fields and the answer becomes `verified`. If it rests on a NEW calculation (conditional sum, unregistered ratio, window function ...) 1.0 cannot register that with one click: the call returns `refused` / `refusal.code: "sql_not_confirmable"` ("这类新算法 1.0 还不能一键确认，请在口径里把它定义成指标") instead of asking again. Define it as a metric in the rules.
- `confirm()` for metric/time-role clarifications re-asks with the chosen option's name appended; confirmations are held in memory only.
- Rules/format of the packs: see `examples/sales-pack.json` (ships with the package, matches `examples/sales.csv`) for a minimal one.
- Benchmark numbers: see "Benchmarks" below; only those measured runs are claimed.

### Known limitations
- Repair side channel: whether a repair request follows a failed local query depends on the data. A malicious model provider (or a prompt injection that controls the model) can infer a few bits per question about the data from that. Fix planned for 1.1.
- The privacy transport does not inspect the system message; it is built only from table structure and rules (rules you supply are trusted input).
- With auto-generated rules, date-format detection reads samples of cell values locally; only the detected format is used in prompts.
- Model-written SQL that names catalog objects (`duckdb_*`, `information_schema`, `pg_*`, `sqlite_*`, `pragma_*`) is rejected; DuckDB memory is capped by `limits.memoryLimit` (default 2GB). State files are created with mode 0700/0600.

## Benchmarks

<!-- BENCHMARK-TABLE: draft, pending maintainer approval -->
Numbers below come from independent, held-out question banks (written by a separate agent, not used during development); see the technical report for method.

Two held-out banks (B5, B6), 84 questions each (60 Chinese on a cross-border e-commerce dataset, 24 English on three public datasets). Same model for every arm (deepseek-v4.1-flash, temperature 0, thinking off, max output 400), one first pass per arm, frozen grader. "Ordinary agent" = a general tool-using agent that may read data rows.

| Bank | estratto-engine | Reference (same answering code) | Ordinary agent |
|---|---|---|---|
| B5 | 77/84 (CN 54/60, EN 23/24) | 76/84 (P79d) | 39/84 |
| B6 | 77/84 (CN 55/60, EN 22/24) | 76/84 (P80) | 31/84 |

- On B6 the engine's first model request was byte-identical to the reference for 84/84 questions; the engine missed no question the reference answered. Differences between the two arms come from the model side, so read engine and reference as the same level, not as an improvement.
- Cost per question vs the ordinary agent: about 91% fewer total tokens; estimated spend about 39% (B5) and 53% (B6) lower; per correct answer about 69% and 81% lower.
- **Not met:** our own target of at most 900 uncached-input+output tokens per question (measured 1445 on B5, 1023 on B6). With byte-identical requests the provider cache hit rate was 0.48 for the engine vs 0.60 for the reference on B6, which explains about three quarters of that gap.
- **Not met:** our target of at most 1% wrong answers among zero-call reused answers (2/71 on B5, 3/70 on B6). Every one of them was already wrong on the first pass; no answer that was right the first time came back wrong from the cache.
- Method, question banks and grader: see the Estratto Studio technical report.

## Mechanism report

The method behind this engine, and the benchmark results of the Estratto Studio app it comes from, are written up in the mechanism report (CC BY 4.0):

- [Overview](report/README.md) · [Full report](report/mechanism-report.md)
- [中文概览](report/README.zh-CN.md) · [中文完整报告](report/mechanism-report.zh-CN.md)

## License

- Code: Apache-2.0, see [LICENSE](LICENSE) and `NOTICE`. Copyright (c) 2026 Jackson Wu (j7ckson). Third party: ONNX Runtime Web (MIT, Microsoft), multilingual-e5-small (MIT).
- Mechanism report and figures (`report/`, `docs/images/`): CC BY 4.0, see [report/LICENSE](report/LICENSE).

Decisions and the exact differences from the desktop source: `DECISIONS.md`.

---

# 中文说明

**estratto-engine**：用自然语言对自己的数据问数，数字在本机算出来，并给出"这个数能信到什么程度"的状态。

模型只负责把问题翻译成一份小的结构化计划（兜底时写一条只读 SQL）；计划在本机校验、在 DuckDB 上执行，答案文字由本机按类型化事实生成。**不会把数据行和计算结果发给模型。** 这个包就是 Estratto Studio 桌面版背后的同一套规划、执行、提示词和校验，做成了 Node.js 包（`1.0.0-rc.8` 为候选版）。

## 安装与快速使用

```sh
npm install estratto-engine        # Node >= 22.5
node node_modules/estratto-engine/scripts/fetch-model.js ./models   # 可选：本机 e5 向量模型（不随包发布）
```
用法见上方英文 Quickstart：`createEngine({ dataDir, data, rules, model, modelsDir })` → `engine.ask('问题')`。`data` 可以是已有的 DuckDB 文件，或 csv/xlsx/parquet 文件（导入到 `dataDir/warehouse.duckdb`）。`model` 用 `openaiCompatible({ baseURL, apiKey, model })` 或自己写 `{ generate(req, signal) }`。密钥只放在适配器闭包里，引擎本体不读环境变量和任何凭据文件。

命令行：`estratto ask --data 文件 --rules 规则包.json --base-url … --model … --data-dir ./state "问题"`，密钥从环境变量 `ESTRATTO_API_KEY` 读（只有命令行外壳读）。

## 状态含义

- `verified`：按已登记口径规划、校验、本机执行，数字就是数据里的数字。
- `needs_confirm`：需要人确认——取值是猜的、字段名是自动认的、或需要选一个（对象 / 时间口径 / 指标），见 `r.confirm`，用 `engine.confirm(requestId, choice)` 带确认重问。
- `unverified`：SQL 兜底用了没登记的字段或连接，数字只当草稿。
- `no_data`：查询成功但没有匹配的数据。
- `refused`：现有规则表达不了这个问法（能力缺口），或隐私出口检查拦下了请求。
- `cancelled`：已取消；`error`：模型不可用或多次输出不可用等。

## 隐私保证（引擎内强制，宿主关不掉）

- 发给模型的只有：用户原话、锚定日期和时区、表名列名、规则名称与定义、候选编号，以及**原样出现在问题里**的维度取值。
- 不发：数据行、计算结果、取值清单。修复重试时的错误信息只保留"类别 + 已授权字段名"。
- 每个请求都经过同一个出口检查；形状不对就**不发出**，该题状态为 `refused`，事件 `outbound_blocked`。
- SQL 兜底：只读、单条 SELECT、本机校验（不碰文件 / 系统表 / 外网）、最多 60 行 / 20 秒，每题模型调用不超过 4 次。
- 你自己提供的规则包视为可信输入，里面写了什么就会进提示词。

## 局限

- rc.7：自动规则下，问「率 / 占比 / 比例 / 平均」而数据里只有合计时，不再拿合计冒充：返回 `needs_confirm`（`confirm.kind: no_such_metric`），不给数字，并提示怎么定义（如 退款额 ÷ 销售额）。币种列叫 币种 / 货币 / 币别 且有多种币种时，答案和预览都会写「含多种币种，未换汇，不能直接相加」。SQL 兜底通道里「新算法」（条件合计、没登记的比率等）1.0 不能一键确认：返回 `sql_not_confirmable`，请把它在口径里定义成指标。
- 不给 `rules` 时自动生成规则只是尽力而为：只用词典和列名起名，不用模型起名；依赖它们的答案都是 `needs_confirm`，确认后才算 `verified`。
- 数据里没有的概念会被拒答，不会瞎猜。
- 一个引擎只接一个数据库；xlsx 导入整本读入内存；待确认记录只在内存里，重启后消失。
- 跑分数字只认下面「跑分」一节列出的实测结果。

## 工作区、本机页面、MCP（rc.6）

`estratto init` 建工作区（`~/.estratto/<名字>/`：`estratto.json` 配置、`secrets.json` 密钥〔0600〕、`usage.jsonl` 每次模型调用一行）；`estratto serve` 在本机 127.0.0.1 起问答页和设置页；`estratto mcp` 给 agent 用（默认只有 ask / list_tables / list_rules，改口径的工具要 `surfaces.mcp.allowRuleChanges: true` 才有）。可设「每日花费上限」「屏蔽列」「数据自动更新」；`estratto rules preview <id>` 在本机算出该指标的全部合计和上个完整月，不调模型。接口说明见 `docs/HTTP-API.md`。

## 跑分(草稿,待维护者确认)

两套独立题库 B5、B6,各 84 题(中文 60、英文 24),所有组用同一个模型、同样参数,各跑一次首遍,判分程序冻结。

| 题库 | estratto-engine | 参照(同一套问数代码) | 普通 agent |
|---|---|---|---|
| B5 | 77/84(中 54,英 23) | 76/84(P79d) | 39/84 |
| B6 | 77/84(中 55,英 22) | 76/84(P80) | 31/84 |

- B6 上引擎发给模型的首个请求与参照 84/84 逐字节相同,参照答对的题引擎全对;两组差别来自模型侧,应看作同一水平,不算提升。
- 对普通 agent:总 token 少约 91%;估算花费低约 39%(B5)/ 53%(B6);每答对一题低约 69% / 81%。
- **未达标**:每题高价 token ≤900(实测 B5 1445、B6 1023),主要因服务商缓存命中率波动(B6 同样请求 0.48 vs 0.60)。
- **未达标**:复用答案错误率 ≤1%(实测 B5 2/71、B6 3/70),错的都是首遍就错;首遍答对的题复用后没有变错。
- 方法、题库与判分见 Estratto Studio 技术报告。

## 机制报告

这个引擎背后的方法，以及它所源自的 Estratto Studio 软件的评测成绩，写在机制报告里（CC BY 4.0）：

- [概览](report/README.zh-CN.md) · [完整报告](report/mechanism-report.zh-CN.md)
- [English overview](report/README.md) · [English full report](report/mechanism-report.md)

## 许可

- 代码：Apache-2.0，见 [LICENSE](LICENSE) 和 `NOTICE`。版权所有 Copyright (c) 2026 Jackson Wu (j7ckson)。第三方：ONNX Runtime Web（MIT，Microsoft）、multilingual-e5-small（MIT）。
- 机制报告和图（`report/`、`docs/images/`）：CC BY 4.0，见 [report/LICENSE](report/LICENSE)。

与桌面版源码的差异见 `DECISIONS.md`。
