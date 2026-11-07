# Estratto 组件

两个纯 Web Component,不依赖框架,不请求 `endpoint` 以外的地址。由 `estratto serve` 在 `/ui/estratto-ask.js` 和 `/ui/estratto-settings.js` 提供。

```html
<script src="/ui/estratto-ask.js"></script>
<script src="/ui/estratto-settings.js"></script>
<estratto-ask endpoint="http://127.0.0.1:7317" token="会话令牌" lang="zh"></estratto-ask>
<estratto-settings endpoint="http://127.0.0.1:7317" token="会话令牌" owner-token="负责人令牌"></estratto-settings>
```

## 属性

| 属性 | 组件 | 说明 |
|---|---|---|
| `endpoint` | 两者 | 本机服务地址,例如 `http://127.0.0.1:7317` |
| `token` | 两者 | 会话令牌,作为 `X-Estratto-Token` 发送 |
| `owner-token` | settings | 口径负责人令牌,作为 `X-Estratto-Owner` 发送。不给则全部只读,并显示“只有口径负责人能修改” |
| `lang` | 两者 | `zh`(默认)或 `en` |
| `theme` | 两者 | 可选,`light` / `dark` 强制主题;不写则跟随 `prefers-color-scheme` |

## 方法(estratto-ask)

`ask(question?)`、`cancel()`、`confirm(choice)`。settings 有 `refresh()`。

## 事件(都会冒泡并穿过 Shadow DOM)

| 事件 | 触发时机 | `detail` |
|---|---|---|
| `estratto-answer` | 拿到一个答案(任何状态) | `{ question, result }`,`result` 是 `/api/ask` 的返回 |
| `estratto-confirmed` | 选完待确认的选项并拿到新答案 | `{ question, choice, result }` |
| `estratto-error` | 请求失败(网络、HTTP 错误) | `{ question?, message, status, error }` |

## 状态标签

已核 `verified` / 待确认 `needs_confirm` / 未核 `unverified` / 没答 `refused` / 没数据 `no_data` / 已取消 `cancelled` / 出错 `error`。每个标签下有一句大白话说明。

## 主题变量

在组件外层(或组件自身)设置即可,浅色深色各自有默认值:

| 变量 | 默认(浅色) | 作用 |
|---|---|---|
| `--estratto-brand` | `#0361ba` | 品牌色(按钮、焦点、选中) |
| `--estratto-brand-ink` | `#fff` | 品牌色上的文字 |
| `--estratto-bg` / `--estratto-card` | `#f6f8fb` / `#fff` | 底色 / 卡片 |
| `--estratto-text` / `--estratto-muted` / `--estratto-line` | | 文字、次要文字、分割线 |
| `--estratto-ok` `-warn` `-bad` (+ `-bg`) | | 状态色 |
| `--estratto-radius-card` | `14px` | 卡片圆角 |
| `--estratto-radius-input` | `9px` | 输入框圆角 |
| `--estratto-radius-button` | `8px` | 按钮圆角 |
| `--estratto-radius-toggle` | `7px` | 开关圆角 |
| `--estratto-font` | 系统字体 | 字体 |

另外暴露了 `part="root"`、`part="card"` 供 `::part()` 微调。

## 预览

```
node ui/mock-server.mjs        # http://127.0.0.1:7318/preview.html
```
假服务器返回虚构的电商样例数据:令牌 `demo-token`,负责人令牌 `demo-owner`。

## 数据页的“添加数据”流程(rc.8)
设置组件的「数据」页:先问“有没有已经在用的数据库”(没有 / SQLite / PostgreSQL / MySQL / DuckDB) → 写路径并扫描,或填连接信息(密码只写不读) → 勾选要导入的数据 → 导入进度 → 结果表(表、行数、日期范围)。用到 `/api/data/discover`、`/api/data/test-connection`、`/api/data/add`、`/api/data/progress`。
