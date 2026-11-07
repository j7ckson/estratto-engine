# estratto serve: HTTP API (rc.7)

`estratto serve [--name N] [--port P] [--token T] [--print-config json]` listens on `127.0.0.1` only (default port 7317, `surfaces.serve.port`; `--port 0` picks a free one).
All bodies are JSON (`Content-Type: application/json`). Errors: `{ "error": { "code": "...", "message": "..." } }`.

## Who may call what

Every request is checked in this order:

1. **Host** header must be exactly `127.0.0.1:<port>` or `localhost:<port>`, otherwise `403 bad_host` (DNS rebinding). Applies to pages and static files too.
2. **Origin** header: absent is fine; otherwise it must be `http://127.0.0.1:<port>`, `http://localhost:<port>` or one of `surfaces.serve.allowedOrigins` (default empty), otherwise `403 bad_origin` (also for the `OPTIONS` preflight). Pages (`/`, `/settings`) refuse every cross-origin request; `/api/*` and `/ui/*` answer allowed origins with CORS headers (`Access-Control-Allow-Origin: <that origin>`, allowed headers `content-type, x-estratto-token, x-estratto-owner`, methods `GET, POST, PUT, OPTIONS`).
3. **`X-Estratto-Token: <session token>`** on every `/api/*` request, otherwise `401 bad_token`. The token is random at every start unless you fix it with `estratto serve --token <t>` or the config `surfaces.serve.token` (16-200 characters: letters, digits, `. _ ~ -`; `config get` shows `(set)`, never the value). It is printed by `estratto serve` ("Session token"); hosts should use `estratto serve --print-config json`, which prints ONE JSON line on stdout instead of the text lines and then keeps serving: `{ "name", "endpoint": "http://127.0.0.1:7317", "port", "token", "tokenStable": true|false, "settingsUrl", "ownerKey" }` (`ownerKey` is the owner key inside `settingsUrl`: treat the line as a secret). The token is also and written into the pages the server itself serves (`token="..."`).
4. **Role.** `X-Estratto-Owner: <access.ownerToken from estratto.json>` that matches means **owner**; absent or wrong means **asker** (no error). Owner-only calls answer `403 owner_only` to an asker.

Asker can: status, ask, cancel, confirm (not `accept`), read rules / preview / settings (short view) / usage (summary), refresh data.
Owner can in addition: confirm with `accept`, confirm / reject / revert rules, change settings, set the key, add data.

The `/settings` page needs the owner key in its URL (`/settings?owner=<ownerToken>`; `estratto serve` prints the full link), otherwise it answers `403` with a plain message. The `/` page carries only the session token.

## Pages and files

| | |
|---|---|
| `GET /` | HTML shell with `<estratto-ask endpoint="http://<Host header>" token="<session token>" lang="zh\|en">` and `<script type="module" src="/ui/estratto-ask.js">`. If `ui/estratto-ask.js` does not exist, a plain message instead of the element. |
| `GET /settings?owner=<ownerToken>` | HTML shell with `<estratto-settings endpoint token owner-token lang>` and `/ui/estratto-settings.js`. |
| `GET /ui/<file>` | Static file from the package's `ui/` folder. Single path segment, `[A-Za-z0-9][A-Za-z0-9._-]*`, extension one of `.js .mjs .css .svg .json .woff2 .png .map`, regular file inside `ui/` (symlinks that leave it are refused). No listing, no sub folders, anything else is `404`. |

`endpoint` is built from the request's Host header, so the page and the API are always the same origin. Pages are sent with a CSP (`script-src 'self'`, `connect-src 'self'`, `style-src 'self' 'unsafe-inline'`, no framing).

## Endpoints

### `GET /api/status`
```json
{ "name": "sales", "version": "1.0.0-rc.7", "engine": "estratto-engine@1.0.0-rc.7", "role": "owner|asker",
  "language": "zh", "timezone": "Asia/Shanghai", "rules": "auto|provided",
  "sources": [ { "type": "file|folder|duckdb", "path": "/abs/x.csv", "pattern": "*.csv" } ],
  "tables": [ { "name": "sales", "columns": [ { "name": "amount", "type": "DOUBLE", "hidden": true } ] } ],
  "model": { "provider": "deepseek", "model": "...", "baseURL": "..." },
  "apiKey": "set|not set",
  "usage": { "day": "2026-11-05", "todayUSD": 0.0123, "dailyBudgetUSD": 1.0 },
  "lastDataRefresh": "ISO|null", "dataUpdatedAt": "ISO|null", "dataRefresh": "auto|manual" }
```
For an asker: `sources` is `[{type, name}]` (file name only), `model` has no `baseURL`, `tables` omit hidden / excluded columns and tables. `dailyBudgetUSD` is `null` when there is no limit. The key is never returned, only `"set"` / `"not set"`.

### `POST /api/ask`  `{ "question": "...", "requestId"?: "..." }`
`question`: 1..2000 characters. `requestId`: `[A-Za-z0-9_.:-]{1,80}`, generated (`req_<uuid>`) when absent. If the HTTP connection closes before the answer, the request is cancelled.
```json
{ "requestId": "...", "status": "verified|needs_confirm|unverified|no_data|refused|cancelled|error",
  "answer": "multi-line text, first line starting with ANSWER", "answerLine": "ANSWER: 155.25 ...",
  "facts": [ { "id": "F1", "label": "...", "value": 155.25, "unit": "元", "display": "155.25", "status": "ok", "period": {...}, "tier": null, "lane": null, "source": { "table": "sales", "field": "amount" } } ],
  "route": "plan|local|reuse|sql",
  "confirm": null,
  "refusal": null,
  "meta": { "dataStamp": "...", "ruleVersion": "...", "codeVersion": "...", "anchor": "2026-10-22", "checks": [ { "name": "plan_validation", "result": "pass|fail|not_executed" } ] },
  "usage": { "calls": 1, "providerCalls": [ { "request_id": "...", "usage": {...}, "finish_reason": "stop", "purpose": "ir" } ], "tokens": null } }
```
Never present: `raw`, `plan`, `sql`, `rows`.
`confirm` (only when `status` is `needs_confirm`): `{ "kind": "value_choice|value_guess|plan|no_such_metric|clarification|<code>", "message": "text|null", "options": [...] , ... }`.
- `value_choice`: `options` = `[{ "value": "...", ... }]` (also `literal`, `dim`, `table`, `column`); answer with `choice` = option index or `option.value`.
- `value_guess` / `plan`: `options` = `[{ "id": "accept", ... }]`; answer with `choice: "accept"` (**owner only**, it can confirm auto-generated rules).
- `no_such_metric` (rc.7, auto-rules mode): the question asks for a rate / share / average (率, 比例, 占比, 百分比, 平均, rate, ratio, share, average, per ...) and the data has no metric of that kind, only totals. `options` is `[]` (nothing to confirm), `message` says so in plain words and, when it can, suggests a definition (`退款额 ÷ 销售额`); `answerLine` has no number and `facts` is `[]`. Define the metric in the rules and ask again. Posting `accept` for such a request returns `status: "refused"` with `refusal.code: "no_such_metric"`.
- other clarifications: `options` = list of `{id|value|name, ...}`; `choice` = index or id.

`refusal` (when `status` is `refused` for a local reason): `{ "code": "daily_budget_exceeded", "spentUSD": 1.02, "limitUSD": 1, "day": "2026-11-05" }` or `{ "code": "outbound_blocked", "reason": "..." }`. For `daily_budget_exceeded` no model call was made; `answerLine` carries a plain sentence in the workspace language. Cache hits are still answered while over budget.

### `POST /api/cancel`  `{ "requestId": "..." }` -> `{ "requestId": "...", "cancelled": true|false }`
The cancelled ask resolves with `status: "cancelled"`.

### `POST /api/confirm`  `{ "requestId": "...", "choice": <string|number|object> }` -> same shape as `/api/ask`
`choice: "accept"` needs the owner (`403 owner_only` otherwise). Unknown request / bad choice: `400 confirm_failed`.
A SQL-lane answer that rests on a **new calculation** (conditional sum, unregistered ratio, window function ...) cannot be made `verified` by a click: `accept` returns `status: "refused"`, `refusal.code: "sql_not_confirmable"` and the message "这类新算法 1.0 还不能一键确认，请在口径里把它定义成指标。" (the request stays as it was). A SQL-lane answer that is pending only because it reads auto-named fields is confirmed normally.

### `GET /api/rules`
```json
{ "mode": "auto|provided",
  "metrics": [ { "id": "m:au_sales_amount", "name": "金额", "kind": "simple|ratio|derived", "unit": "", "dataset": "sales", "field": "amount",
                 "formula": "sales 表 amount 合计", "status": "unconfirmed|confirmed|reverted|rejected|provided", "recordId": "ac_...|null", "auto": true } ],
  "dimensions": [ { "id": "d:au_sales_channel", "name": "channel", "kind": "column|timeBucket", "dataset": "sales", "field": "channel", "grain": null,
                    "formula": "sales 表 channel 列的取值", "status": "unconfirmed|confirmed|reverted|rejected|provided", "recordId": "ac_...|null", "auto": true } ],
  "records": [ { "id": "ac_...", "kind": "auto_confirm", "status": "confirmed|reverted", "items": [ { "kind": "metric|dim", "id": "m:..." } ], "decided_by": "host", "at": "ISO" } ],
  "patches": [ ... ] }
```
`status`: `unconfirmed` = recognised automatically, nobody decided yet; `confirmed`; `reverted` = confirmed once, then undone (can be confirmed again); `rejected` = marked "not right" (left out of the rules; `revert` brings it back to `unconfirmed`); `provided` = comes from a rules pack you supplied, nothing to confirm.

### `GET /api/rules/:id/preview`
`:id` = URL-encoded metric id (`m:au_sales_amount`, the `m:` is optional), dimension id (`d:au_sales_channel`), a record id (`ac_...`), or the `requestId` of a `needs_confirm` answer. Computed locally, no model call.
```json
{ "id": "m:au_sales_amount", "recordId"?: "ac_...", "label": "金额", "formula": "sales 表 amount 合计",
  "total": 195.25, "lastMonth": { "period": "2026-09", "value": 40 }, "unit": "", "decimals": 2, "note"?: "why total is null" }
```
`lastMonth` is the latest month before the anchor month that has data (`null` when the data has no date column or no earlier month). `total` can be `null` with a `note`. Unknown id: `404 unknown_metric`.
When a money metric covers several currencies (a table with a 币种 / 货币 / currency column holding more than one code), the preview adds `currencyNote` ("含多种币种，未换汇，不能直接相加"), `currencies` and `byCurrency: [{ currency, value }]`: the total is then NOT one number.

Preview of a **dimension** (rc.7; **owner only**, `403 owner_only` for an asker, because it lists real values):
```json
{ "id": "d:au_sales_channel", "kind": "dimension", "label": "channel", "dimKind": "column|timeBucket", "dataset": "sales", "field": "channel",
  "rows": 22020, "distinct": 4, "nullCount": 0, "top": [ { "value": "Amazon", "count": 9100 } ], "local": true }
```
`distinct` = number of different values (for `timeBucket` dimensions: of buckets, e.g. months), `top` = the 5 values with the most rows. Computed on this machine; the values are shown to the local user only and are never part of a model request.

### `POST /api/rules/:id/(confirm|reject|revert)` (owner)  body optional
Works for metric ids (`m:...`) and dimension ids (`d:...`). Returns the changed record: `confirm` -> `{ id: "ac_...", kind: "auto_confirm", status: "confirmed", items, ... }`; `reject` on an unconfirmed metric -> `{ id: "m:...", kind: "metric", status: "rejected" }` (on a confirmed one it behaves like `revert`); `revert` -> `{ ..., status: "reverted" }` (or `{ id, kind, status: "unconfirmed" }` for a rejected metric).
Errors: `409 already_confirmed | not_confirmed | already_rejected`, `404` unknown id.

### `GET /api/settings`
Owner:
```json
{ "role": "owner", "apiKey": "set|not set",
  "data": { "refresh": "auto|manual", "refreshMinutes": 15, "maxRowsPerTable": 5000000, "sources": [ {type,path,pattern?} | {type:"sqlite",path,tables?} | {type:"postgres"|"mysql",id,name,host,port,database,user,schema?,tables,ssl?} ], "lastRefreshAt": "ISO|null", "updatedAt": "ISO|null" },
  "rules": { "mode": "auto|provided", "packs": ["/abs/pack.json"] },
  "model": { "provider": "deepseek|openai|custom", "baseURL": "...", "model": "...", "thinking": "disabled|false_bool|low|none" },
  "limits": { "maxCallsPerQuestion": 2, "maxCallsTotal": 4, "maxTokensPerQuestion": 2000, "maxOutputTokens": 400, "dailyBudgetUSD": 1.0, "price": { "inputPerM": 0.15, "cachedInputPerM": 0.003, "outputPerM": 0.6 } },
  "privacy": { "hiddenColumns": ["orders.customer_email"], "tables": [ { "name": "orders", "hidden": false, "excluded": false, "columns": [ { "name": "customer_email", "type": "VARCHAR", "hidden": true } ] } ] },
  "behavior": { "reuse": true, "sqlFallback": true, "vectors": true, "timezone": "Asia/Shanghai", "anchor": "today", "language": "zh" },
  "surfaces": { "serve": { "port": 7317, "allowedOrigins": [] }, "mcp": { "allowRuleChanges": false } },
  "usage": { "day": "...", "todayUSD": 0, "dailyBudgetUSD": 1.0, "callsToday": 0 },
  "editable": { "data": ["refresh","refreshMinutes","maxRowsPerTable"], "model": ["provider","baseURL","model","thinking"], "limits": [...], "privacy": ["hiddenColumns"], "behavior": [...] } }
```
Asker: `{ role: "asker", apiKey, model: {provider, model}, behavior: {language, timezone}, limits: {dailyBudgetUSD}, usage }`.

### `PUT /api/settings` (owner)
Body: a partial settings object, only the `editable` groups/fields, e.g. `{ "limits": { "dailyBudgetUSD": 2 }, "privacy": { "hiddenColumns": ["orders.customer_email"] } }` (objects are merged, arrays replaced). Returns the owner settings view. `403 not_editable` for anything else (`data.sources` -> use `/api/data/add`; `access`, `surfaces`, `rules.packs`, `name` can only be changed with the CLI / file); `400 bad_config` with the field named when a value is invalid. Hidden columns, behavior and rule limits rebuild the engine (a running question is waited for); budget, price, base URL, thinking and the key apply immediately.

### `PUT /api/settings/key` (owner)  `{ "apiKey": "sk-..." }` -> `{ "apiKey": "set" }`
Write-only. An empty string clears the key (`"not set"`). The key is stored in `secrets.json` (0600) and nowhere else; no endpoint ever returns it, and request bodies are never echoed in errors.

### `POST /api/data/discover` (owner)  `{ "paths": ["/abs/folder", "/abs/file.db"], "maxDepth"?: 4, "maxFiles"?: 5000 }`
Looks ONLY at the paths given (1-20): no default locations, no network. Hidden folders, `node_modules`, system and credential folders (`.ssh`, `.gnupg`, Keychains, ...) and symbolic links are skipped; a disk root is refused. Files are recognised by their first bytes (SQLite `SQLite format 3\0`, DuckDB `DUCK` at offset 8) before their extension. Returns
`{ "candidates": [ { "kind": "csv|tsv|xlsx|parquet|duckdb|sqlite", "path", "name", "size", "mtime", "tables"?: [ { "name", "rows", "columns", "sheet"?, "rowsApprox"? } ], "note"?: "too_large_for_preview", "error"?: "file_in_use|unreadable" } ], "skipped": [ { "path", "reason" } ], "truncated": false }`. xlsx lists its sheets, database files list tables with row counts and columns (opened read-only).

### `POST /api/data/test-connection` (owner)  `{ "source": { ... } }`
`source` is a SQLite file `{type:"sqlite", path}` or a database `{type:"postgres"|"mysql", host, port?, database, user, password?, schema? (postgres), ssl? (true | "no-verify")}`. Connects read-only, imports nothing, saves nothing. `200 { "ok": true, "tables": [ { "name", "kind": "table|view", "rows", "approx", "columns": [ {name,type} ], "overLimit" } ], "maxRowsPerTable": 5000000 }`; `400 connection_failed` (message never contains the password). The password in the body is write-only, like the api key.

### `POST /api/data/add` (owner)  `{ "path": "/abs/..." }` or `{ "source": {...} }` or `{ "sources": [ {...}, ... ] }`
A source is one of: `{type:"file"|"folder"|"duckdb", path}`, `{type:"sqlite", path, tables?:[...]}`, `{type:"postgres"|"mysql", host, port?, database, user, password?, schema?, tables:[...], ssl?}`. `path` (old form) is classified automatically (SQLite and DuckDB by header). A database password is written to `secrets.json` under `connections.<sourceId>.password` (0600) and is never stored in `estratto.json` or returned by any endpoint. The call returns when the import is done: `{ "sources": [...], "tables": [...], "imported": [ { "name", "columns", "rows", "dateColumn", "from", "to" } ], "summary": [ ...all tables... ] }`. Database tables are named `<source>__<table>`. Errors: `400 mixed_sources` (a DuckDB file cannot be mixed), `400 row_cap_exceeded` (a table is over `data.maxRowsPerTable`, default 5,000,000; nothing is truncated silently), `400 import_failed`, `400 bad_config`. A failed add leaves the configuration as it was.

### `GET /api/data/progress?since=N` (owner)
While an add / refresh request is running: `{ "events": [ { "seq", "type": "import_start|import_progress|import_table|import_warning|data_refreshed", "table", "rows", "rowsTotal", "reason", "column" } ], "last": N }`. Poll with the last `seq` seen.

### `POST /api/data/refresh`  (owner; empty body ok)
Checks the sources now and re-imports what changed; **database sources are snapshotted again** (manual refresh). Returns `{ "refreshed": true|false, "files": [...], "tables": [...], "failed"?: [ {file, message, code} ], "lastDataRefresh": "ISO|null", "dataUpdatedAt": "ISO|null" }`. Automatic checks also happen before an ask when `data.refresh` is `auto`: files at most every 5 seconds; database sources only when `data.refreshMinutes` (default 15) have passed since their last snapshot, so a question never hits the database by itself more often than that.

### `GET /api/usage`
`{ "day": "2026-11-05", "todayUSD": 0.01, "dailyBudgetUSD": 1.0|null, "callsToday": 3, "totalUSD": 0.4 }`; the owner also gets `"entries"`: the last 50 `{ at, requestId, model, usage, costUSD }`. Costs are estimates from `limits.price` (0 when no price is set).

## Status codes
`200` ok, `204` preflight, `400` bad input (`bad_json`, `bad_question`, `bad_request_id`, `bad_config`, `confirm_failed`, ...), `401 bad_token`, `403 bad_host | bad_origin | owner_only | not_editable`, `404 not_found | unknown_metric`, `405`, `409` rule state conflict, `413 too_large` (64 KB limit), `415` (POST/PUT body without `application/json`), `500 internal`.
