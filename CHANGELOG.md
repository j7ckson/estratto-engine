# Changelog

## 1.0.0 (unreleased)

First public release (current candidate: 1.0.0-rc.8).

- Question answering is identical to the P80 engine used in the published Estratto Studio technical report: model requests are byte-identical on all 168 recorded benchmark requests (`core/` differs from P80 in three files only, see `DECISIONS.md` section 1).
- Privacy transport inside the engine (`src/privacy.js`): every outbound request passes one check that the host cannot disable; a request of unexpected shape is not sent (status `refused`, event `outbound_blocked`). Data rows, computed values and value lists are never sent.

### Hardening (from `DECISIONS.md`)

rc.2 (red-team fixes):
- API keys and bearer tokens redacted from provider errors, results, events and CLI output.
- Control characters stripped from the model's structured output; only the first `ANSWER` line is kept.
- Model-written SQL touching catalog objects (`duckdb_*`, `information_schema`, `pg_*`, `sqlite_*`, `pragma_*`) is rejected; DuckDB memory capped by `limits.memoryLimit` (default 2GB).
- Currency whitelist (core item 1.3).
- Stricter transport: refuses malformed entities, period, anchor/timezone, candidate tuples, and `tools`/`functions`/`tool_choice`/`function_call`.
- Resource caps: more than 200 entities, 2000 array items, or a response over 1,000,000 characters is refused; oversized `usage` is trimmed.
- State directories 0700 and state files 0600.
- xlsx header sanity check (`import_warning`, columns `col_1..col_n`).
- Follow-up: the control-character scrub no longer alters line breaks inside `sql` fields.

rc.3: the "rc.2 follow-up" in `DECISIONS.md` — line breaks inside model-written SQL are kept, so a `--` comment cannot swallow the rest of the query.

rc.5:
- rules.confirm / rules.reject accept auto_confirm record ids (re-confirm a reverted record; reject on an active record = revert).

rc.4:
- Auto-generated rule confirmations are stored as revertible records (`engine.rules.revert`), surviving restarts.
- Table and column names with control characters or over 64 characters are excluded (database) or renamed `col_<n>` (files), with `import_warning` events.
- `describe()` quotes table names consistently.
- README quickstart uses the pack and CSV shipped under `examples/`.

### Release candidates after rc.5 (from `DECISIONS.md`)

rc.6, workspace and surfaces (src/, bin/, docs/, tests; `core/` untouched). With no hidden columns, ledger, budget or refresh configured, the engine runs the rc.5 code path; a replay of 6 questions (19 model requests) against rc.5 was byte-identical.
- Workspace (`src/workspace.js`): `<home>/<name>/` holds the data directory plus `estratto.json`, `secrets.json` and `usage.jsonl` (directory 0700, files 0600). The library never reads `process.env` or `os.homedir()`.
- Hand-validated config schema; unknown keys are errors. Some settings rebuild the engine, others apply live.
- API key handling: the key lives in `secrets.json` and the model wrapper only; every output goes through a redactor.
- `privacy.hiddenColumns`: hidden columns are removed from registry, lookup, auto rules, SQL context and schema; supplied-pack rules built on them are dropped.
- Data auto-refresh (`data.refresh`): changed files are re-imported table by table in one transaction; an unreadable file keeps its old tables (`data_refresh_failed`).
- Daily budget and usage ledger (`src/ledger.js`, `usage.jsonl`).
- Rules: `engine.rules.metrics()`, `preview(id)`, and confirm / reject / revert for auto metrics.
- HTTP service (`estratto serve`, `docs/HTTP-API.md`): Host, Origin, token and role checks; owner-only settings; JSON bodies up to 64 KB.
- MCP server (`estratto mcp`): tools `ask`, `list_tables`, `list_rules`; rule-changing tools only with `surfaces.mcp.allowRuleChanges`; no rows, SQL or plan in results.
- CLI: `init`, `config`, `rules export` / `import`; `init` never edits another program's configuration.
- New dependency `@modelcontextprotocol/sdk`; `files` now includes `ui` and `docs`.

rc.7 (src/, bin/, ui/, docs/, tests; `core/` untouched). Behaviour changes are gated on auto-rules mode; with a supplied pack, request bodies and answers are the rc.6 ones (replay of 4 questions byte-identical).
- Rate / share / average wording guard (`src/rate-guard.js`): a question asking for a rate, share or average is not answered with a plain total; the result is `needs_confirm` with `confirm.kind: "no_such_metric"`.
- Column types in auto mode are taken from the real DuckDB types.
- Currency columns named 币种 / 货币 / 币别 are read like `currency`; several codes are flagged as not addable, and currencies are never converted.
- `engine.rules.dimensions()`; dimension preview; `revert('d:...')` matches records by kind.
- Confirm on a SQL-lane answer now flips auto-named fields; a new calculation returns `refused` with `sql_not_confirmable`.
- CLI friction: SQLite `ExperimentalWarning` suppressed narrowly; `serve --token` and `--print-config json`; Chinese wording for two fixed confirm-card sentences.
- UI: spacing between Latin and CJK text, a card for dimensions in the rules tab, `no_such_metric` badge.

rc.8, guided data setup (src/, bin/, ui/, docs/, tests; `core/` untouched). New work is on the import side; with a supplied pack the request path and answers are the rc.7 ones.
- DuckDB is the engine's own built-in database; SQLite files, PostgreSQL and MySQL are copied into it, read-only. Questions never query the source databases.
- Discovery (`src/discover.js`) looks only at the paths given; skips hidden folders, `node_modules`, `.git`, credential folders and symlinks; recognises SQLite / DuckDB files by header.
- New source types `sqlite`, `postgres`, `mysql`; `data.refreshMinutes`, `data.maxRowsPerTable`, `data.warehouse`. Database passwords are stored in `secrets.json` only.
- SQLite import (`src/snapshot.js`) with per-column type detection; PostgreSQL and MySQL via `pg` and `mysql2` (new dependencies) in read-only, consistent-snapshot transactions with streaming.
- Refresh of database sources through marker files; a failed refresh keeps the old tables.
- Interactive `estratto init` guided setup (`--language en` for English); `POST /api/data/discover`, `/test-connection`, `/add`, `GET /api/data/progress`; "add data" flow in Settings.
- Follow-up: `POST /api/data/refresh` is owner-only.
- Not done: choosing individual xlsx sheets; importing a DuckDB file's tables into the own warehouse.

Packaging for the repository (not a code change): the package now lives in the `j7ckson/estratto-engine` repository, published with npm trusted publishing and provenance; `package.json` pins `uuid` to `^11.1.1` through `overrides`.

### Known limitations
- Repair side channel (fix planned for 1.1); see `SECURITY.md`.
