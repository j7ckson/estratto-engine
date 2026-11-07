# Security Policy

## Reporting a vulnerability

Please report security issues privately and do not open a public issue. Use GitHub private vulnerability reporting: <https://github.com/j7ckson/estratto-engine/security/advisories/new>

Include the version, a minimal reproduction, and the impact you observed.

## Privacy guarantees (enforced inside the engine; the host cannot disable them)

- What leaves the machine, per request: the question text, anchor date and timezone, table and column names, rule names/ids/units/definitions, candidate ids, and dimension values **only if they literally appear in the question**.
- Never sent: data rows, computed values, result numbers, value lists. `previous_errors` (repair attempts) are reduced to a typed category plus authorized column names.
- Every request passes the same transport (`src/privacy.js`). A request that does not have the expected shape is **not sent**: the ask ends `refused`, event `outbound_blocked`.
- SQL fallback: a single read-only `SELECT`/`WITH` over registered tables, validated locally (no files, no system tables, no external access), at most 60 rows and 20 s, at most 4 model calls per question.
- Rules you supply are trusted input: whatever they contain (aliases, notes) is part of the prompt.
- Table or column names that contain control characters / line breaks or are longer than 64 characters are never given to the registry, the rules or any prompt: with `data.duckdb` they are excluded (event `import_warning`, name shortened to 16 characters + `…`), with `data.files` columns are renamed `col_<n>`.

## Known limitations

- Repair side channel: whether a repair request follows a failed local query depends on the data. A malicious model provider (or a prompt injection that controls the model) can infer a few bits per question about the data from that. Fix planned for 1.1.
- The privacy transport does not inspect the system message; it is built only from table structure and rules (rules you supply are trusted input).
- With auto-generated rules, date-format detection reads samples of cell values locally; only the detected format is used in prompts.
- Model-written SQL that names catalog objects (`duckdb_*`, `information_schema`, `pg_*`, `sqlite_*`, `pragma_*`) is rejected; DuckDB memory is capped by `limits.memoryLimit` (default 2GB). State files are created with mode 0700/0600.

## Dependencies

`exceljs` (xlsx import) depends on `uuid` versions with advisory GHSA-w5hq-g745-h8pq (buffer bounds check in v3/v5/v6 when a buffer is passed). This repository pins `uuid@^11.1.1` through `overrides` for its own installs; npm does not apply a dependency's overrides to your project, so add the same override in your own package.json if your audit flags it.
