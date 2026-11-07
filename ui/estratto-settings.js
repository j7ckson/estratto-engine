/* <estratto-settings> — 设置组件(数据 / 模型 / 口径 / 隐私)。纯 Web Component,无依赖。 */
(() => {
  if (customElements.get('estratto-settings')) return;

  const T = {
    zh: {
      tabs: { data: '数据', model: '模型', rules: '口径', privacy: '隐私' },
      readonly: '只有口径负责人能修改', loading: '加载中…', loadErr: '没能读取设置', retry: '再试一次',
      saved: '已保存', saving: '保存中…', save: '保存', failed: '没成功',
      d: { sources: '数据来源', none: '还没有数据来源。', tables: '表', rows: '行', add: '加数据', addPh: '文件或文件夹的完整路径,例如 /Users/me/orders.csv', addBtn: '添加', refresh: '立即刷新', updated: '最近更新', never: '还没更新过', refreshed: '已刷新', addData: '添加数据', empty: '还没有数据,先加一份', expand: n => `展开全部(${n})`, collapse: '收起', tablesN: n => `${n} 张表`, kindTag: { file: '文件', folder: '文件夹', sqlite: 'SQLite', postgres: 'PostgreSQL', mysql: 'MySQL', duckdb: 'DuckDB' }, justAdded: n => `刚添加了 ${n} 张表`, dismiss: '知道了', other: '其他表', refreshBtnNote: '' },
      m: { provider: '服务商', model: '模型名', baseURL: '服务地址', key: '密钥(key)', keySet: '已设置', keyUnset: '未设置', change: '修改 key', changePh: '粘贴新的 key,保存后不会再显示', keyHint: '只写不读:保存后这里不会显示 key,输入框会清空。', spend: '今日花费', cap: '每日上限', capLabel: '每日上限(美元)', spendOf: (a, b) => `今天已花 $${a} / 上限 $${b}`, nolimit: '没设上限' },
      r: { auto: '自动认出的指标', confirmed: '已确认的口径', noAuto: '没有待确认的指标。', noConf: '还没有确认过的口径。', all: '全部合计', last: '上个月', preview: '按这个口径', ok: '确认', no: '不对', revert: '撤销', formula: '算法', loadingPrev: '正在本机算…', prevErr: '算不出预览', rejected: '已标为不对', tech: '技术写法', basisAll: '按全部数据算', basisLast: '上个月', noLast: '没有数据', st: { confirmed: '已确认', unconfirmed: '待确认', rejected: '已标不对', reverted: '已撤销', provided: '规则包给定' }, rejectedList: '已标不对的指标', tableSuf: '表的', col: '列', ops: { '合计': '求和', '去重计数': '去重计数', '计数': '计数', '平均': '求平均', '最大': '取最大值', '最小': '取最小值' }, noTotal: '算不出全部数据的数', dims: '分组用的字段（维度）', dimsHint: '回答里“按渠道”“按国家”这类分组用到它们；确认前，用到它们的答案都是“待确认”。', dimNone: '没有可确认的维度。', distinct: n => `${n} 个不同取值`, topVals: '最多的 5 个', rowsWord: '行', nulls: n => `${n} 行为空`, dimLocal: '这些取值只在本机显示，不会发给模型。', byMonth: '按月', dimKinds: { column: '字段取值', timeBucket: '时间分组' }, multiCur: '含多种币种，未换汇，不能直接相加', byCur: '分币种' },
      w: {
        title: '添加数据', start: '添加数据', startHint: '先说有没有数据库,再挑要导入的数据。数据都导进本机的数据库里,不会改你的原文件。',
        q: '你有没有已经在用的数据库?',
        kinds: { none: ['没有', '用引擎自带的数据库'], sqlite: ['有:SQLite 文件', '一个 .db / .sqlite 文件'], postgres: ['有:PostgreSQL', '连到数据库服务器,只读'], mysql: ['有:MySQL', '连到数据库服务器,只读'], duckdb: ['有:DuckDB 文件', '直接用这个文件'] },
        back: '上一步', cancel: '取消', scan: '扫描', scanning: '正在看…', connect: '连接并看有哪些表', connecting: '正在连接…',
        pathNone: '数据在哪?把文件夹或文件的完整路径给我(可以写多个,用逗号隔开)', pathSqlite: 'SQLite 文件的路径(或它所在的文件夹)', pathDuck: 'DuckDB 文件的路径(或它所在的文件夹)',
        pathPh: '/Users/me/exports, /Users/me/orders.csv', onlyLook: '只会看你写的这些位置,不会去翻别的地方。',
        host: '数据库地址', port: '端口', database: '数据库名', user: '用户名', password: '密码', schema: 'schema', ssl: '用加密连接(SSL)', pwHint: '密码只写不读:只存在这台电脑的 secrets.json 里,页面以后不会再显示它。',
        found: n => `找到 ${n} 个可以导入的数据`, tablesFound: n => `这个库里有 ${n} 张表`, noneFound: '没找到能用的数据(支持 csv、tsv、xlsx、parquet、SQLite、DuckDB)。换个位置再试?', skipped: n => `有 ${n} 个位置按安全规则跳过了(隐藏文件夹、系统和密码相关文件夹等)`, truncated: '文件太多,只看了前一部分,可以写更具体的文件夹。',
        all: '全选', none: '全不选', importSel: n => `导入所选(${n})`, tablesInside: n => `${n} 张表`, rowsApprox: n => `约 ${n} 行`, over: n => `超过 ${n} 行上限,不能导入`, sheets: n => `${n} 个工作表`,
        duckOnly: 'DuckDB 文件只能单独用,选它就不能同时选别的。',
        importing: '正在导入', importNote: '大表要几分钟,请先别关这个页面。', rowsOf: (a, b) => b ? `${a} / ${b} 行` : `${a} 行`, waiting: '准备中…',
        done: n => `已导入 ${n} 张表`, tbl: '表', rows: '行数', range: '日期范围', noDate: '没有日期列', finish: '完成', again: '再添加一批', warnBlob: n => `有 ${n} 列是二进制内容(图片、文件等),没有导入。`,
        quick: '直接添加文件夹或文件(高级)', quickHint: '整个文件夹加进来后,以后放进去的新文件也会自动加入。', snapshot: m => `数据库里的数据是导入时的快照,每 ${m} 分钟自动更新一次;也可以点“立即刷新”。`,
        bad: { connection_failed: '连不上数据库', row_cap_exceeded: '表太大', mixed_sources: '这些数据不能混着用', import_failed: '导入没成功', bad_paths: '路径有问题' }
      },
      p: { intro: '勾选的列不会发给模型,也不会出现在问答里。', hidden: '已屏蔽', cols: n => `${n} 列` , tablesEmpty: '还没有可显示的表。' },
      ownerNote: '只有口径负责人能修改'
    },
    en: {
      tabs: { data: 'Data', model: 'Model', rules: 'Definitions', privacy: 'Privacy' },
      readonly: 'Only the definitions owner can change this', loading: 'Loading…', loadErr: 'Could not load settings', retry: 'Try again',
      saved: 'Saved', saving: 'Saving…', save: 'Save', failed: 'Failed',
      d: { sources: 'Data sources', none: 'No data sources yet.', tables: 'Tables', rows: 'rows', add: 'Add data', addPh: 'Full path to a file or folder, e.g. /Users/me/orders.csv', addBtn: 'Add', refresh: 'Refresh now', updated: 'Last updated', never: 'Never updated', refreshed: 'Refreshed', addData: 'Add data', empty: 'No data yet. Add some first.', expand: n => `Show all (${n})`, collapse: 'Show less', tablesN: n => `${n} table(s)`, kindTag: { file: 'File', folder: 'Folder', sqlite: 'SQLite', postgres: 'PostgreSQL', mysql: 'MySQL', duckdb: 'DuckDB' }, justAdded: n => `Just added ${n} table(s)`, dismiss: 'Dismiss', other: 'Other tables', refreshBtnNote: '' },
      m: { provider: 'Provider', model: 'Model', baseURL: 'Base URL', key: 'API key', keySet: 'Set', keyUnset: 'Not set', change: 'Change key', changePh: 'Paste a new key; it is never shown again', keyHint: 'Write-only: the key is not displayed after saving and the field is cleared.', spend: 'Spent today', cap: 'Daily cap', capLabel: 'Daily cap (USD)', spendOf: (a, b) => `Spent $${a} of $${b} today`, nolimit: 'No cap set' },
      r: { auto: 'Detected metrics', confirmed: 'Confirmed definitions', noAuto: 'Nothing waiting for confirmation.', tech: 'Technical form', basisAll: 'All data', basisLast: 'last month', noLast: 'no data', st: { confirmed: 'Confirmed', unconfirmed: 'Needs confirmation', rejected: 'Marked wrong', reverted: 'Undone', provided: 'From rules pack' }, rejectedList: 'Marked as wrong', tableSuf: ' table, ', col: 'column', ops: { '合计': 'sum', '去重计数': 'distinct count', '计数': 'count', '平均': 'average', '最大': 'max', '最小': 'min' }, noTotal: 'Cannot compute an all-data value', dims: 'Grouping fields (dimensions)', dimsHint: 'Answers that group "by channel" or "by country" use these; until confirmed, those answers need confirmation.', dimNone: 'No dimensions to confirm.', distinct: n => `${n} distinct values`, topVals: 'Top 5 by rows', rowsWord: 'rows', nulls: n => `${n} empty rows`, dimLocal: 'These values are shown on this machine only and are never sent to the model.', byMonth: 'by month', dimKinds: { column: 'Field values', timeBucket: 'Time buckets' }, multiCur: 'Mixed currencies, not converted, cannot be added up directly', byCur: 'By currency', noConf: 'Nothing confirmed yet.', all: 'all-time total', last: 'last month', preview: 'With this definition', ok: 'Confirm', no: 'Wrong', revert: 'Undo', formula: 'Formula', loadingPrev: 'Calculating locally…', prevErr: 'Could not compute a preview', rejected: 'Marked as wrong' },
      w: {
        title: 'Add data', start: 'Add data', startHint: 'First say whether you already have a database, then pick what to import. Data is copied into a database on this machine; your original files are not changed.',
        q: 'Do you already use a SQL database?',
        kinds: { none: ['No', 'Use the engine\'s own database'], sqlite: ['Yes: a SQLite file', 'A .db / .sqlite file'], postgres: ['Yes: PostgreSQL', 'Connect to the server, read-only'], mysql: ['Yes: MySQL', 'Connect to the server, read-only'], duckdb: ['Yes: a DuckDB file', 'Use that file as it is'] },
        back: 'Back', cancel: 'Cancel', scan: 'Scan', scanning: 'Looking…', connect: 'Connect and list tables', connecting: 'Connecting…',
        pathNone: 'Where is your data? Give the full path of folders or files (several allowed, separated by commas)', pathSqlite: 'Path of the SQLite file (or the folder it is in)', pathDuck: 'Path of the DuckDB file (or the folder it is in)',
        pathPh: '/Users/me/exports, /Users/me/orders.csv', onlyLook: 'Only the locations you type are looked at; nothing else is read.',
        host: 'Database host', port: 'Port', database: 'Database name', user: 'User name', password: 'Password', schema: 'Schema', ssl: 'Encrypted connection (SSL)', pwHint: 'Write-only: the password is stored only in secrets.json on this machine and is never shown again.',
        found: n => `Found ${n} item(s) you can import`, tablesFound: n => `This database has ${n} table(s)`, noneFound: 'No usable data found (csv, tsv, xlsx, parquet, SQLite and DuckDB are supported). Try another location?', skipped: n => `${n} location(s) were skipped by the safety rules (hidden folders, system and credential folders, ...)`, truncated: 'Too many files: only the first part was looked at. Type a more specific folder.',
        all: 'Select all', none: 'Select none', importSel: n => `Import selected (${n})`, tablesInside: n => `${n} tables`, rowsApprox: n => `about ${n} rows`, over: n => `over the ${n}-row limit, cannot be imported`, sheets: n => `${n} sheets`,
        duckOnly: 'A DuckDB file can only be used on its own: choosing it deselects the others.',
        importing: 'Importing', importNote: 'Big tables take a few minutes; please keep this page open.', rowsOf: (a, b) => b ? `${a} / ${b} rows` : `${a} rows`, waiting: 'Getting ready…',
        done: n => `Imported ${n} table(s)`, tbl: 'Table', rows: 'Rows', range: 'Date range', noDate: 'no date column', finish: 'Done', again: 'Add more', warnBlob: n => `${n} column(s) hold binary content (images, files, ...) and were not imported.`,
        quick: 'Add a folder or file directly (advanced)', quickHint: 'A folder added this way keeps picking up new files you put into it later.', snapshot: m => `Data from a database is a snapshot taken at import time and refreshed every ${m} minutes; you can also press "Refresh now".`,
        bad: { connection_failed: 'Could not reach the database', row_cap_exceeded: 'Table too large', mixed_sources: 'These cannot be mixed', import_failed: 'Import failed', bad_paths: 'Problem with the paths' }
      },
      p: { intro: 'Checked columns are not sent to the model and do not appear in answers.', hidden: 'Hidden', cols: n => `${n} columns`, tablesEmpty: 'No tables to show yet.' },
      ownerNote: 'Only the definitions owner can change this'
    }
  };

  const CSS = `
:host([hidden]){display:none}
:host{
  --_brand:var(--estratto-brand,#0361ba);--_brand-ink:var(--estratto-brand-ink,#fff);
  --_bg:var(--estratto-bg,#f6f8fb);--_card:var(--estratto-card,#fff);--_text:var(--estratto-text,#17202b);
  --_muted:var(--estratto-muted,#5b6776);--_line:var(--estratto-line,#dde3ea);
  --_ok:var(--estratto-ok,#17794a);--_ok-bg:var(--estratto-ok-bg,#e4f4ec);
  --_warn:var(--estratto-warn,#8a5a00);--_warn-bg:var(--estratto-warn-bg,#fcf0d2);
  --_bad:var(--estratto-bad,#b3261e);--_bad-bg:var(--estratto-bad-bg,#fbe6e4);
  --_r-card:var(--estratto-radius-card,14px);--_r-input:var(--estratto-radius-input,9px);
  --_r-btn:var(--estratto-radius-button,8px);--_r-tog:var(--estratto-radius-toggle,7px);
  --_font:var(--estratto-font,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
  display:block;font-family:var(--_font);color:var(--_text);font-size:15px;line-height:1.55;
}
@media (prefers-color-scheme:dark){
  :host(:not([theme="light"])){
    --_brand:var(--estratto-brand,#4d9bef);--_brand-ink:var(--estratto-brand-ink,#06203d);
    --_bg:var(--estratto-bg,#10151c);--_card:var(--estratto-card,#19212b);--_text:var(--estratto-text,#e8edf3);
    --_muted:var(--estratto-muted,#9aa6b5);--_line:var(--estratto-line,#2c3745);
    --_ok:var(--estratto-ok,#62d29a);--_ok-bg:var(--estratto-ok-bg,#14352a);
    --_warn:var(--estratto-warn,#f1c35a);--_warn-bg:var(--estratto-warn-bg,#3a2f12);
    --_bad:var(--estratto-bad,#ff8f87);--_bad-bg:var(--estratto-bad-bg,#3d1a18);
  }
}
:host([theme="dark"]){
  --_brand:#4d9bef;--_brand-ink:#06203d;--_bg:#10151c;--_card:#19212b;--_text:#e8edf3;--_muted:#9aa6b5;--_line:#2c3745;
  --_ok:#62d29a;--_ok-bg:#14352a;--_warn:#f1c35a;--_warn-bg:#3a2f12;--_bad:#ff8f87;--_bad-bg:#3d1a18;
}
*{box-sizing:border-box}
.wrap{background:var(--_bg);padding:16px;border-radius:var(--_r-card);min-width:0}
[role=tablist]{display:flex;gap:4px;border-bottom:1px solid var(--_line);margin-bottom:14px;overflow-x:auto}
[role=tab]{font:inherit;background:transparent;border:0;border-bottom:3px solid transparent;color:var(--_muted);padding:9px 14px;cursor:pointer;white-space:nowrap;min-height:42px}
[role=tab][aria-selected=true]{color:var(--_brand);border-bottom-color:var(--_brand);font-weight:600}
[role=tab]:hover:not(:disabled){border-color:transparent;border-bottom-color:var(--_line)}
[role=tab][aria-selected=true]:hover{border-bottom-color:var(--_brand)}
[role=tab]{border-radius:0}
[role=tab]:focus{outline:none}
[role=tab]:focus-visible{outline:2px solid var(--_brand);outline-offset:-2px;border-radius:6px}
.metric .cur{margin-top:6px;color:var(--_warn);font-size:13px}.metric .top{margin-top:4px;overflow-wrap:anywhere}
.tech summary{cursor:pointer;color:var(--_muted);font-size:12.5px}.tech code{display:inline-block;margin-top:4px}
.pill.st-confirmed,.pill.st-provided{background:var(--_ok-bg);color:var(--_ok)}.pill.st-unconfirmed,.pill.st-reverted{background:var(--_warn-bg);color:var(--_warn)}.pill.st-rejected{background:var(--_bad-bg);color:var(--_bad)}
.note{background:var(--_warn-bg);color:var(--_warn);border-radius:var(--_r-input);padding:8px 12px;margin:0 0 14px;font-size:14px}
.card{background:var(--_card);border:1px solid var(--_line);border-radius:var(--_r-card);padding:14px;margin-bottom:12px}
h3{font-size:14px;margin:0 0 10px;color:var(--_muted);font-weight:600}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
label.f{display:block;font-size:13px;color:var(--_muted);margin-bottom:4px}
input[type=text],input[type=password],input[type=number],select{width:100%;font:inherit;color:inherit;background:var(--_bg);border:1px solid var(--_line);border-radius:var(--_r-input);padding:8px 11px;min-height:40px}
input:disabled,select:disabled{opacity:.7;cursor:not-allowed}
button{font:inherit;cursor:pointer;border-radius:var(--_r-btn);padding:7px 14px;border:1px solid var(--_line);background:var(--_card);color:var(--_text);min-height:38px}
button:hover:not(:disabled){border-color:var(--_brand)}
button.primary{background:var(--_brand);border-color:var(--_brand);color:var(--_brand-ink);font-weight:600}
button.danger{color:var(--_bad)}
button:disabled{opacity:.5;cursor:not-allowed}
:is(button:not([role=tab]),input,select):focus-visible{outline:2px solid var(--_brand);outline-offset:2px}
.pill{display:inline-block;font-size:12.5px;font-weight:600;padding:2px 10px;border-radius:999px}
.pill.ok{background:var(--_ok-bg);color:var(--_ok)}.pill.no{background:var(--_warn-bg);color:var(--_warn)}
.muted{color:var(--_muted);font-size:13.5px}
.msg{font-size:13.5px;min-height:20px;margin-top:8px}.msg.ok{color:var(--_ok)}.msg.bad{color:var(--_bad)}
ul.plain{list-style:none;margin:0;padding:0}
ul.plain li{padding:8px 0;border-bottom:1px solid var(--_line);overflow-wrap:anywhere}
ul.plain li:last-child{border-bottom:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:var(--_bg);padding:1px 6px;border-radius:5px;overflow-wrap:anywhere}
.meter{height:10px;background:var(--_line);border-radius:999px;overflow:hidden;margin:8px 0 4px}
.meter>i{display:block;height:100%;background:var(--_brand);border-radius:999px}
.meter.hot>i{background:var(--_bad)}
.metric{border:1px solid var(--_line);border-radius:var(--_r-input);padding:12px;margin-bottom:10px;background:var(--_card)}
.metric h4{margin:0 0 2px;font-size:16px}
.metric .pv{margin:8px 0 10px;padding:8px 10px;background:var(--_bg);border-radius:var(--_r-input);font-size:14px;font-variant-numeric:tabular-nums}
.metric .pv b{font-size:15px}
.tbl{margin-bottom:12px}
.grp{font-size:12.5px;color:var(--_muted);margin:10px 0 2px;font-weight:600}.grp:first-of-type{margin-top:0}
button.ghost{border-color:transparent;background:transparent;color:var(--_brand);padding:4px 8px;min-height:32px}
.tbl summary{cursor:pointer;font-weight:600;padding:6px 0}
.col{display:flex;align-items:center;gap:10px;padding:7px 4px;min-height:40px;border-bottom:1px solid var(--_line)}
.col:last-child{border-bottom:0}
.col span.n{flex:1;min-width:0;overflow-wrap:anywhere}
.col span.ty{color:var(--_muted);font-size:12.5px}
.sw{appearance:none;-webkit-appearance:none;width:42px;height:24px;border-radius:var(--_r-tog);background:var(--_line);position:relative;cursor:pointer;flex:none;border:0;margin:0}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:5px;background:#fff;transition:transform .15s}
.sw:checked{background:var(--_brand)}.sw:checked::after{transform:translateX(18px)}
.sw:disabled{opacity:.5;cursor:not-allowed}
.sw:focus-visible{outline:2px solid var(--_brand);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.sw::after{transition:none}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.opts{display:grid;gap:8px;margin:10px 0}
.opt{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;padding:10px 14px;min-height:56px;width:100%}
.opt b{font-size:15px}
.opt:hover:not(:disabled){border-color:var(--_brand)}
.chk{display:flex;gap:12px;align-items:flex-start;min-height:44px;padding:6px 2px;cursor:pointer}
.chk input{flex:none;margin-top:4px;width:18px;height:18px;accent-color:var(--_brand)}
.chk .nm{min-width:0;overflow-wrap:anywhere}
.chk.dim{opacity:.55;cursor:not-allowed}
.kind{background:var(--_bg);color:var(--_muted);font-weight:500}
.sub{margin:2px 0 4px 30px}.sub .chk{min-height:36px;padding:3px 2px}
.links{display:flex;gap:14px;margin:0 0 6px}
.links button{border:0;background:none;color:var(--_brand);padding:4px 0;min-height:32px;text-decoration:underline}
.prog{margin:0 0 12px;overflow-wrap:anywhere}.prog .top{display:flex;justify-content:space-between;gap:10px;font-size:14px}
.res{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
.res th{text-align:left;color:var(--_muted);font-weight:600;font-size:12.5px;padding:4px 8px 6px 0;border-bottom:1px solid var(--_line)}
.res td{padding:8px 8px 8px 0;border-bottom:1px solid var(--_line);vertical-align:top;overflow-wrap:anywhere}
.res tr:last-child td{border-bottom:0}.res td.r,.res th.r{text-align:right;padding-right:12px}
.res .rng{white-space:nowrap}
@media (max-width:480px){.res thead{display:none}.res,.res tbody{display:block}.res tr{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:9px 0;border-bottom:1px solid var(--_line)}.res tr:last-child{border-bottom:0}.res td{border:0;padding:0}.res td.r{padding:0;text-align:right;white-space:nowrap;font-weight:600}.res td.rng{grid-column:1/-1;white-space:normal;color:var(--_muted);font-size:13px}}
.swl{display:flex;align-items:center;gap:10px;min-height:40px}
textarea{width:100%;font:inherit;color:inherit;background:var(--_bg);border:1px solid var(--_line);border-radius:var(--_r-input);padding:8px 11px}
`;

  // Latin/digit next to a CJK character gets a space ("orders 表的 amount 列求和"); applied to generated wording only
  const cjkSpace = s => String(s ?? '').replace(/([A-Za-z0-9_])([\u4e00-\u9fff])/g, '$1 $2').replace(/([\u4e00-\u9fff])([A-Za-z0-9_])/g, '$1 $2');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => (v == null || v === '') ? '—' : (typeof v === 'number' ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(v));
  const money = v => Number(v || 0).toFixed(2);
  const fmtSize = b => { b = Number(b) || 0; if (b < 1024) return b + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let v = b / 1024, i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i]; };

  class EstrattoSettings extends HTMLElement {
    static get observedAttributes() { return ['lang', 'owner-token', 'endpoint', 'token']; }
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._tab = 'data'; this._w = null; this._st = null; this._set = null; this._ruleList = null; this._prev = {}; this._msg = {}; this._loadErr = null;
    }
    get lang() { return (this.getAttribute('lang') || 'zh').startsWith('en') ? 'en' : 'zh'; }
    get t() { return T[this.lang]; }
    get owner() { return !!this.getAttribute('owner-token'); }
    connectedCallback() { this.refresh(); }
    attributeChangedCallback(n, o, v) { if (this.isConnected && o !== v) { n === 'lang' || n === 'owner-token' ? this._draw() : this.refresh(); } }

    async _api(method, path, body) {
      const base = (this.getAttribute('endpoint') || '').replace(/\/$/, '');
      const headers = { 'X-Estratto-Token': this.getAttribute('token') || '' };
      const ot = this.getAttribute('owner-token'); if (ot) headers['X-Estratto-Owner'] = ot;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let data = null; try { data = await res.json(); } catch { /* empty */ }
      if (!res.ok) { const e = new Error((data && (data.error?.message || (typeof data.error === 'string' ? data.error : null) || data.message)) || ('HTTP ' + res.status)); e.status = res.status; e.code = (data && data.error && data.error.code) || null; throw e; }
      return data;
    }
    _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true })); }
    _err(e) { this._emit('estratto-error', { message: e.message, status: e.status || null, error: e }); return e.message || String(e); }

    async refresh() {
      this._loadErr = null; this._draw();
      try {
        const [st, set, rules] = await Promise.all([this._api('GET', '/api/status'), this._api('GET', '/api/settings'), this._api('GET', '/api/rules')]);
        this._st = st; this._set = set; this._keySet = set.apiKey ?? st.apiKey;
        this._ruleList = rules.metrics || [];
        this._dimList = rules.dimensions || [];
        this._draw();
        this._ruleList.filter(r => r.status === 'unconfirmed' || r.status === 'reverted').forEach(r => this._loadPreview(r.id));
        if (this.owner) this._dimList.filter(r => r.status === 'unconfirmed' || r.status === 'reverted').forEach(r => this._loadPreview(r.id));   // distinct values are for the owner's eyes only
      } catch (e) { this._loadErr = this._err(e); this._draw(); }
    }
    async _loadPreview(id) {
      this._prev[id] = { loading: true };
      try { this._prev[id] = { data: await this._api('GET', `/api/rules/${encodeURIComponent(id)}/preview`) }; } catch (e) { this._prev[id] = { error: true }; }
      if (this._tab === 'rules') this._draw();
    }

    _draw() {
      const t = this.t;
      const active = this.shadowRoot.activeElement?.id || this.shadowRoot.activeElement?.dataset?.k;
      const tabs = ['data', 'model', 'rules', 'privacy'];
      let body = '';
      if (this._loadErr) body = `<div class="card"><p style="margin:0 0 10px;color:var(--_bad)" role="alert">${esc(t.loadErr)}:${esc(this._loadErr)}</p><button id="retry" type="button">${esc(t.retry)}</button></div>`;
      else if (!this._st) body = `<div class="card muted" role="status">${esc(t.loading)}</div>`;
      else body = this['_' + this._tab]();
      this.shadowRoot.innerHTML = `<style>${CSS}</style><div class="wrap" part="root">
<div role="tablist" aria-label="${esc(t.tabs[this._tab])}">${tabs.map(k => `<button role="tab" id="tab-${k}" aria-selected="${k === this._tab}" aria-controls="panel" tabindex="${k === this._tab ? 0 : -1}" data-tab="${k}">${esc(t.tabs[k])}</button>`).join('')}</div>
<div id="panel" role="tabpanel" aria-labelledby="tab-${this._tab}">${!this.owner && this._st ? `<p class="note" role="note">${esc(t.readonly)}</p>` : ''}${body}</div></div>`;
      this._bind();
      if (active) { const el = this.shadowRoot.getElementById(active) || this.shadowRoot.querySelector(`[data-k="${active}"]`); el?.focus?.(); }
    }

    _bind() {
      const R = this.shadowRoot, $ = s => R.querySelector(s);
      R.querySelectorAll('[role=tab]').forEach((b, i, all) => {
        b.onclick = () => { this._tab = b.dataset.tab; this._draw(); if (this._kbd) { R.getElementById('tab-' + this._tab)?.focus(); this._kbd = false; } };
        b.onkeydown = e => {
          const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (d) { e.preventDefault(); this._kbd = true; all[(i + d + all.length) % all.length].click(); }
        };
      });
      const rt = $('#retry'); if (rt) rt.onclick = () => this.refresh();
      if (!this._st) return;
      const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
      on('#wizStart', () => { if (!this.owner) return; this._w = this._wizNew(); this._draw(); });
      R.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => { const k = b.dataset.exp; this._exp = this._exp || {}; this._exp[k] = !this._exp[k]; this._draw(); });
      on('#dismissAdd', () => { this._lastAdd = null; this._draw(); });
      if (this._w) this._wizBind();
      on('#add', () => this._act('add', async () => { const p = $('#path').value.trim(); if (!p) return; const r = await this._api('POST', '/api/data/add', { path: p }); this._w = null; if (r && r.imported && r.imported.length) this._lastAdd = r.imported; await this.refresh(); }, this.t.saved));
      on('#refreshData', () => this._act('data', async () => { await this._api('POST', '/api/data/refresh', {}); await this.refresh(); }, this.t.d.refreshed, true));
      on('#saveModel', () => this._act('model', async () => {
        const patch = { model: { provider: $('#provider').value, model: $('#modelName').value.trim(), baseURL: $('#baseURL').value.trim() }, limits: { dailyBudgetUSD: $('#cap').value === '' ? null : Number($('#cap').value) } };
        await this._api('PUT', '/api/settings', patch); await this.refresh();
      }, this.t.saved));
      on('#saveKey', () => this._act('key', async () => {
        const inp = $('#newKey'); const k = inp.value.trim(); if (!k) return;
        await this._api('PUT', '/api/settings/key', { apiKey: k }); inp.value = ''; await this.refresh();
      }, this.t.saved));
      R.querySelectorAll('[data-rule]').forEach(b => b.onclick = () => this._act('rule-' + b.dataset.rule, async () => {
        await this._api('POST', `/api/rules/${encodeURIComponent(b.dataset.rule)}/${b.dataset.do}`, {}); await this.refresh();
      }, this.t.saved));
      R.querySelectorAll('[data-hide]').forEach(c => c.onchange = () => this._togglePrivacy(c));
    }

    async _act(key, fn, okText, anyone) {
      if (!this.owner && !anyone) return;
      this._msg[key] = { text: this.t.saving }; this._setMsg(key);
      try { await fn(); this._msg[key] = { text: okText, ok: true }; }
      catch (e) { this._msg[key] = { text: `${this.t.failed}:${this._err(e)}`, bad: true }; }
      this._setMsg(key);
      setTimeout(() => { delete this._msg[key]; this._setMsg(key); }, 4000);
    }
    _setMsg(key) {
      const el = this.shadowRoot.querySelector(`[data-msg="${key.replace(/"/g, '')}"]`) || this.shadowRoot.querySelector('[data-msg="' + key.split('-')[0] + '"]');
      const m = this._msg[key]; if (el) { el.textContent = m ? m.text : ''; el.className = 'msg' + (m?.ok ? ' ok' : m?.bad ? ' bad' : ''); }
    }
    async _togglePrivacy(c) {
      if (!this.owner) return;
      const cur = new Set(this._set.privacy?.hiddenColumns || []);
      c.checked ? cur.add(c.dataset.hide) : cur.delete(c.dataset.hide);
      const list = [...cur];
      this._msg.privacy = { text: this.t.saving }; this._setMsg('privacy');
      try { await this._api('PUT', '/api/settings', { privacy: { hiddenColumns: list } }); this._set.privacy = { ...(this._set.privacy || {}), hiddenColumns: list }; this._msg.privacy = { text: this.t.saved, ok: true }; }
      catch (e) { c.checked = !c.checked; this._msg.privacy = { text: `${this.t.failed}:${this._err(e)}`, bad: true }; }
      this._setMsg('privacy');
    }

    /* —— 各标签页 —— */
    _tables() { return this._st.tables || []; }
    _srcKey(x) { return x.id || x.name || (x.path ? x.path : `${x.type}://${x.host}/${x.database}`); }
    _srcKind(x) { return x.type || (x.host ? 'postgres' : 'file'); }
    /* 把表归到来源下(接口没给对应关系,按命名规则推:数据库表 <库名>__<表>,文件表 = 文件名) */
    _group(srcs, tables) {
      const norm = n => String(n).replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_').toLowerCase();
      const base = x => x.path ? String(x.path).split(/[\\/]/).pop() : (x.name || '');
      const groups = srcs.map(x => ({ src: x, tables: [] })), other = [];
      const folder = groups.filter(g => this._srcKind(g.src) === 'folder');
      for (const tb of tables) {
        let g = tb.source != null ? groups.find(g => this._srcKey(g.src) === tb.source || g.src.name === tb.source) : null;
        if (!g) g = groups.find(g => { const k = this._srcKind(g.src); const nm = norm(base(g.src)); const key = String(g.src.id || g.src.database || '').toLowerCase(); return (key && tb.name.toLowerCase().startsWith(key + '__')) || (k === 'sqlite' && tb.name.toLowerCase().startsWith(nm + '__')) || ((k === 'file' || k === 'duckdb') && nm === tb.name.toLowerCase()); });
        if (!g && folder.length === 1) g = folder[0];
        (g ? g.tables : other).push(tb);
      }
      return { groups, other };
    }
    _srcLine(g) {
      const x = g.src, k = this._srcKind(x), d = this.t.d, tag = d.kindTag[k] || k;
      const db = k === 'postgres' || k === 'mysql';
      const n = Array.isArray(x.tables) && x.tables.length ? x.tables.length : g.tables.length;
      const cnt = n ? ` · ${esc(d.tablesN(n))}` : '';
      if (db) return `<li><span class="pill kind">${esc(tag)}</span> <b>${esc(x.host || '')}${x.database ? ' / ' + esc(x.database) : ''}</b><span class="muted" style="white-space:nowrap">${cnt}</span></li>`;
      const nm = x.path || x.name || '';
      return `<li><span class="pill kind">${esc(tag)}</span> <code>${esc(nm)}</code><span class="muted" style="white-space:nowrap">${cnt}</span></li>`;
    }
    _data() {
      const t = this.t.d, st = this._st, owner = this.owner;
      const srcs = (this._set.data?.sources) || st.sources || [];
      const tables = this._tables();
      const upd = st.dataUpdatedAt || this._set.data?.updatedAt, chk = st.lastDataRefresh || this._set.data?.lastRefreshAt;
      const when = x => x ? esc(new Date(x).toLocaleString(this.lang === 'zh' ? 'zh-CN' : 'en-US')) : esc(t.never);
      const empty = !srcs.length && !tables.length;
      if (empty && owner && !this._w && !this._autoOpened) { this._autoOpened = true; this._w = this._wizNew(); }
      const hasDb = srcs.some(x => x.host || x.type === 'postgres' || x.type === 'mysql');
      const addBtn = owner ? `<button id="wizStart" class="primary" type="button" ${this._w ? 'disabled' : ''}>${esc(t.addData)}</button>` : '';
      const top = empty
        ? `<div class="card"><p style="margin:0 0 ${owner ? 10 : 0}px">${esc(t.empty)}</p>${addBtn}</div>`
        : `<div class="row" style="margin-bottom:12px">${addBtn}<button id="refreshData" type="button">${esc(t.refresh)}</button><span class="muted" style="font-size:13.5px">${esc(t.updated)}:${when(upd || chk)}</span><span class="msg" data-msg="data" aria-live="polite" style="margin:0"></span></div>`;
      const wiz = this._w ? this._wizard() : '';
      const added = this._lastAdd && this._lastAdd.length ? `<div class="card"><div class="row" style="justify-content:space-between"><b>${esc(t.justAdded(this._lastAdd.length))}</b><button type="button" id="dismissAdd" class="ghost">${esc(t.dismiss)}</button></div>${this._resTable(this._lastAdd)}</div>` : '';
      if (empty) return top + wiz;
      const ex = this._exp || (this._exp = {});
      const SMAX = 6, TMAX = 8;
      const shown = ex.src ? srcs : srcs.slice(0, SMAX);
      const { groups, other } = this._group(srcs, tables);
      const toggle = (key, n, max) => n > max ? `<div class="links" style="margin-top:6px"><button type="button" data-exp="${key}">${esc(ex[key] ? t.collapse : t.expand(n))}</button></div>` : '';
      const srcCard = `<div class="card"><h3>${esc(t.sources)}</h3><ul class="plain">${shown.map(x => this._srcLine(groups.find(g => g.src === x) || { src: x, tables: [] })).join('')}</ul>${toggle('src', srcs.length, SMAX)}${hasDb ? `<p class="muted" style="margin:8px 0 0">${esc(this.t.w.snapshot(this._set.data?.refreshMinutes || 15))}</p>` : ''}</div>`;
      let budget = ex.tbl ? Infinity : TMAX, hidden = 0;
      const li = x => `<li><strong>${esc(x.name)}</strong> <span class="muted">${x.rows != null ? esc(num(x.rows)) + ' ' + esc(t.rows) + ' · ' : ''}${esc(this.t.p.cols((x.columns || []).length))}</span></li>`;
      const blocks = [...groups.filter(g => g.tables.length).map(g => ({ head: this._srcHead(g.src), tables: g.tables })), ...(other.length ? [{ head: groups.length ? t.other : '', tables: other }] : [])];
      const multi = blocks.length > 1;
      const tblHtml = blocks.map(bk => {
        const vis = bk.tables.slice(0, Math.max(0, budget)); budget -= vis.length; hidden += bk.tables.length - vis.length;
        if (!vis.length) return '';
        return `${multi && bk.head ? `<div class="grp">${esc(bk.head)}</div>` : ''}<ul class="plain">${vis.map(li).join('')}</ul>`;
      }).join('');
      const tblCard = `<div class="card"><h3>${esc(t.tables)} <span class="muted">(${tables.length})</span></h3>${tables.length ? tblHtml : `<p class="muted" style="margin:0">${esc(this.t.p.tablesEmpty)}</p>`}${toggle('tbl', tables.length, TMAX)}</div>`;
      return top + wiz + added + srcCard + tblCard;
    }
    _srcHead(x) { const k = this._srcKind(x); const tag = this.t.d.kindTag[k] || k; return (k === 'postgres' || k === 'mysql') ? `${tag} · ${x.host || ''}${x.database ? ' / ' + x.database : ''}` : `${tag} · ${x.path ? String(x.path).split(/[\\/]/).pop() : (x.name || '')}`; }
    _resTable(r) { const w = this.t.w; return `<table class="res"><thead><tr><th>${esc(w.tbl)}</th><th class="r">${esc(w.rows)}</th><th>${esc(w.range)}</th></tr></thead><tbody>${r.map(x => `<tr><td>${esc(x.name)}</td><td class="r">${esc(num(x.rows))}</td><td class="rng">${x.from ? esc(x.from) + ' ~ ' + esc(x.to) : `<span class="muted">${esc(w.noDate)}</span>`}</td></tr>`).join('')}</tbody></table>`; }

    /* —— 添加数据向导:有没有数据库 → 路径/连接 → 扫描结果 → 导入进度 → 结果表 —— */
    _wizNew() { return { step: 'kind', kind: null, f: { host: 'localhost', port: '', database: '', user: '', password: '', schema: 'public', ssl: false }, paths: '', found: [], skipped: 0, truncated: false, pick: new Set(), tsel: {}, tables: [], tpick: new Set(), cap: 5000000, busy: false, err: '', prog: {}, order: [], warns: 0, result: null, since: 0 }; }
    _wizErr(e) { const w = this.t.w, c = e && e.code; this._err(e); return (w.bad[c] ? w.bad[c] + ':' : '') + (e.message || String(e)); }
    _wizard() {
      const w = this.t.w, W = this._w, esc2 = esc;
      const head = `<h3>${esc2(w.title)}</h3>`;
      const err = W.err ? `<div class="msg bad" role="alert" style="margin:8px 0">${esc2(W.err)}</div>` : '';
      const nav = (primary, extra = '') => `<div class="row" style="margin-top:12px"><button type="button" data-w="back">${esc2(w.back)}</button>${primary}<button type="button" data-w="cancel">${esc2(w.cancel)}</button>${extra}</div>`;
      if (W.step === 'kind') {
        return `<div class="card" role="group" aria-label="${esc2(w.title)}">${head}<p style="margin:0">${esc2(w.q)}</p><div class="opts">${['none', 'sqlite', 'postgres', 'mysql', 'duckdb'].map(k => `<button type="button" class="opt" data-w="kind" data-v="${k}"><b>${esc2(w.kinds[k][0])}</b><span class="muted">${esc2(w.kinds[k][1])}</span></button>`).join('')}</div><details style="margin-top:12px"><summary class="muted" style="cursor:pointer">${esc2(w.quick)}</summary><p class="muted" style="margin:8px 0">${esc2(w.quickHint)}</p><label class="f" for="path">${esc2(this.t.d.add)}</label><div class="row"><input type="text" id="path" style="flex:1 1 220px;width:auto" placeholder="${esc2(this.t.d.addPh)}"><button id="add" type="button">${esc2(this.t.d.addBtn)}</button></div><div class="msg" data-msg="add" aria-live="polite"></div></details><div class="row" style="margin-top:10px"><button type="button" data-w="cancel">${esc2(w.cancel)}</button></div></div>`;
      }
      if (W.step === 'path') {
        const lab = W.kind === 'sqlite' ? w.pathSqlite : W.kind === 'duckdb' ? w.pathDuck : w.pathNone;
        return `<div class="card" role="group" aria-label="${esc2(w.title)}">${head}<label class="f" for="wPaths">${esc2(lab)}</label><input type="text" id="wPaths" data-wf="paths" value="${esc2(W.paths)}" placeholder="${esc2(w.pathPh)}" autocomplete="off"><p class="muted" style="margin:6px 0 0">${esc2(w.onlyLook)}</p>${err}${nav(`<button type="button" class="primary" data-w="scan" ${W.busy ? 'disabled' : ''}>${esc2(W.busy ? w.scanning : w.scan)}</button>`)}</div>`;
      }
      if (W.step === 'conn') {
        const f = W.f, pg = W.kind === 'postgres', fld = (id, label, type = 'text', extra = '') => `<div><label class="f" for="w-${id}">${esc2(label)}</label><input type="${type}" id="w-${id}" data-wf="${id}" value="${type === 'password' ? '' : esc2(f[id])}" ${type === 'password' && f.password ? 'placeholder="••••••••"' : ''} autocomplete="${type === 'password' ? 'new-password' : 'off'}" ${extra}></div>`;
        return `<div class="card" role="group" aria-label="${esc2(w.title)}">${head}<div class="grid">${fld('host', w.host)}${fld('port', w.port, 'text', `placeholder="${pg ? 5432 : 3306}" inputmode="numeric"`)}${fld('database', w.database)}${fld('user', w.user)}${fld('password', w.password, 'password')}${pg ? fld('schema', w.schema) : ''}</div>
<label class="swl" style="margin-top:8px"><input class="sw" type="checkbox" role="switch" data-wf="ssl" ${f.ssl ? 'checked' : ''}><span>${esc2(w.ssl)}</span></label><p class="muted" style="margin:6px 0 0">${esc2(w.pwHint)}</p>${err}${nav(`<button type="button" class="primary" data-w="connect" ${W.busy ? 'disabled' : ''}>${esc2(W.busy ? w.connecting : w.connect)}</button>`)}</div>`;
      }
      if (W.step === 'pick') {
        const db = W.kind === 'postgres' || W.kind === 'mysql';
        let list, n;
        if (db) {
          n = W.tpick.size;
          list = `<ul class="plain">${W.tables.map((x, i) => `<li><label class="chk ${x.overLimit ? 'dim' : ''}"><input type="checkbox" data-tp="${i}" ${W.tpick.has(i) ? 'checked' : ''} ${x.overLimit ? 'disabled' : ''}><span class="nm"><b>${esc2(x.name)}</b>${x.kind === 'view' ? ' <span class="pill kind">view</span>' : ''}<br><span class="muted">${x.rows == null ? '' : esc2(x.approx ? w.rowsApprox(num(x.rows)) : num(x.rows) + ' ' + this.t.d.rows) + ' · '}${esc2(this.t.p.cols((x.columns || []).length))}${x.overLimit ? ' · ' + esc2(w.over(num(W.cap))) : ''}</span></span></label></li>`).join('')}</ul>`;
        } else {
          n = W.pick.size;
          list = `<ul class="plain">${W.found.map((c, i) => {
            const tabs = c.tables || [];
            const info = c.kind === 'xlsx' ? w.sheets(tabs.length) : (c.kind === 'sqlite' || c.kind === 'duckdb') ? (tabs.length ? w.tablesInside(tabs.length) : '') : (tabs[0] && tabs[0].rows != null ? num(tabs[0].rows) + ' ' + this.t.d.rows : '');
            const dir = String(c.path).replace(/[\\/][^\\/]*$/, '');
            const sub = c.kind === 'sqlite' && tabs.length > 1 && W.pick.has(i) ? `<div class="sub">${tabs.map(tb => `<label class="chk"><input type="checkbox" data-ts="${i}" data-tn="${esc2(tb.name)}" ${(W.tsel[i] ? W.tsel[i].has(tb.name) : true) ? 'checked' : ''}><span class="nm">${esc2(tb.name)} <span class="muted">${tb.rows == null ? '' : esc2(num(tb.rows)) + ' ' + esc2(this.t.d.rows)}</span></span></label>`).join('')}</div>` : '';
            return `<li><label class="chk"><input type="checkbox" data-pk="${i}" ${W.pick.has(i) ? 'checked' : ''}><span class="nm"><b>${esc2(c.name)}</b> <span class="pill kind">${esc2(c.kind)}</span><br><span class="muted">${esc2([info, fmtSize(c.size)].filter(Boolean).join(' · '))}</span><br><span class="muted" style="font-size:12.5px">${esc2(dir)}</span></span></label>${sub}</li>`;
          }).join('')}</ul>`;
        }
        const total = db ? W.tables.length : W.found.length;
        const notes = (!db && W.skipped ? `<p class="muted" style="margin:0 0 6px">${esc2(w.skipped(W.skipped))}</p>` : '') + (!db && W.truncated ? `<p class="muted" style="margin:0 0 6px">${esc2(w.truncated)}</p>` : '');
        return `<div class="card" role="group" aria-label="${esc2(w.title)}">${head}<p style="margin:0 0 6px"><b>${esc2(db ? w.tablesFound(total) : w.found(total))}</b></p>${notes}<div class="links"><button type="button" data-w="all">${esc2(w.all)}</button><button type="button" data-w="nothing">${esc2(w.none)}</button></div>${list}${err}${nav(`<button type="button" class="primary" data-w="import" ${n ? '' : 'disabled'}>${esc2(w.importSel(n))}</button>`)}</div>`;
      }
      if (W.step === 'importing') {
        const rows = W.order.map(k => W.prog[k]).filter(Boolean);
        return `<div class="card" role="status" aria-live="polite">${head}<p style="margin:0 0 10px"><b>${esc2(w.importing)}…</b></p>${rows.length ? rows.map(r => { const pct = r.total ? Math.min(100, Math.round(r.rows / r.total * 100)) : (r.done ? 100 : 0); return `<div class="prog"><div class="top"><span>${esc2(r.table)}</span><span class="muted">${esc2(r.done ? w.rowsOf(num(r.rows)) : w.rowsOf(num(r.rows), r.total ? num(r.total) : null))}</span></div><div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc2(r.table)}"><i style="width:${pct}%"></i></div></div>`; }).join('') : `<p class="muted">${esc2(w.waiting)}</p>`}<p class="muted" style="margin:6px 0 0">${esc2(w.importNote)}</p></div>`;
      }
      if (W.step === 'done') {
        const r = W.result || [];
        return `<div class="card" role="group" aria-label="${esc2(w.title)}">${head}<p style="margin:0 0 8px"><b>${esc2(w.done(r.length))}</b></p>${r.length ? this._resTable(r) : ''}${W.warns ? `<p class="muted" style="margin:10px 0 0">${esc2(w.warnBlob(W.warns))}</p>` : ''}<div class="row" style="margin-top:12px"><button type="button" class="primary" data-w="finish">${esc2(w.finish)}</button><button type="button" data-w="again">${esc2(w.again)}</button></div></div>`;
      }
      return '';
    }
    _wizBind() {
      const R = this.shadowRoot, W = this._w;
      const go = (step, patch = {}) => { Object.assign(W, patch, { step, err: '' }); this._draw(); setTimeout(() => R.getElementById(step === 'path' ? 'wPaths' : step === 'conn' ? 'w-host' : '')?.focus?.(), 0); };
      R.querySelectorAll('[data-wf]').forEach(el => {
        el.oninput = () => { const k = el.dataset.wf; if (k === 'paths') W.paths = el.value; else if (k === 'ssl') W.f.ssl = el.checked; else W.f[k] = el.value; };
        el.onchange = el.oninput;
      });
      R.querySelectorAll('[data-w]').forEach(b => b.onclick = () => {
        const a = b.dataset.w;
        if (a === 'cancel' || a === 'finish') { W.f.password = ''; if (a === 'finish' && W.result && W.result.length) this._lastAdd = W.result; this._w = null; this._draw(); return; }
        if (a === 'again') { this._w = this._wizNew(); this._draw(); return; }
        if (a === 'back') { const db = W.kind === 'postgres' || W.kind === 'mysql'; go(W.step === 'pick' ? (db ? 'conn' : 'path') : 'kind'); return; }
        if (a === 'kind') { const k = b.dataset.v; go(k === 'postgres' || k === 'mysql' ? 'conn' : 'path', { kind: k }); return; }
        if (a === 'scan') return this._wizScan();
        if (a === 'connect') return this._wizConnect();
        if (a === 'import') return this._wizImport();
        if (a === 'all' || a === 'nothing') {
          const db = W.kind === 'postgres' || W.kind === 'mysql';
          if (db) W.tpick = new Set(a === 'all' ? W.tables.map((x, i) => x.overLimit ? -1 : i).filter(i => i >= 0) : []);
          else W.pick = new Set(a === 'all' && !W.found.some(c => c.kind === 'duckdb') ? W.found.map((_, i) => i) : []);
          this._draw();
        }
      });
      R.querySelectorAll('[data-pk]').forEach(c => c.onchange = () => {
        const i = Number(c.dataset.pk);
        if (c.checked) { if (W.found[i].kind === 'duckdb') W.pick = new Set([i]); else { W.pick.add(i); for (const j of [...W.pick]) if (W.found[j].kind === 'duckdb') W.pick.delete(j); } }
        else W.pick.delete(i);
        this._draw();
      });
      R.querySelectorAll('[data-tp]').forEach(c => c.onchange = () => { const i = Number(c.dataset.tp); c.checked ? W.tpick.add(i) : W.tpick.delete(i); this._draw(); });
      R.querySelectorAll('[data-ts]').forEach(c => c.onchange = () => {
        const i = Number(c.dataset.ts), all = (W.found[i].tables || []).map(x => x.name);
        const cur = W.tsel[i] || new Set(all);
        c.checked ? cur.add(c.dataset.tn) : cur.delete(c.dataset.tn);
        W.tsel[i] = cur;
        if (!cur.size) { W.pick.delete(i); delete W.tsel[i]; }
        this._draw();
      });
    }
    async _wizScan() {
      const W = this._w, w = this.t.w;
      const paths = W.paths.split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
      if (!paths.length) { W.err = w.pathNone; this._draw(); return; }
      W.busy = true; W.err = ''; this._draw();
      try {
        const r = await this._api('POST', '/api/data/discover', { paths });
        const want = W.kind === 'sqlite' ? ['sqlite'] : W.kind === 'duckdb' ? ['duckdb'] : null;
        W.found = (r.candidates || []).filter(c => !want || want.includes(c.kind));
        W.skipped = (r.skipped || []).length; W.truncated = !!r.truncated;
        if (!W.found.length) { W.err = w.noneFound; W.busy = false; this._draw(); return; }
        W.pick = new Set(W.kind === 'duckdb' ? [0] : W.found.map((_, i) => i).filter(i => W.found[i].kind !== 'duckdb')); W.tsel = {};
        W.busy = false; W.step = 'pick'; this._draw();
      } catch (e) { W.busy = false; W.err = this._wizErr(e); this._draw(); }
    }
    _wizSpec() {
      const W = this._w, f = W.f, pg = W.kind === 'postgres';
      return { type: W.kind, host: f.host.trim(), ...(f.port.trim() ? { port: Number(f.port) } : {}), database: f.database.trim(), user: f.user.trim(), ...(f.password ? { password: f.password } : {}), ...(pg && f.schema.trim() ? { schema: f.schema.trim() } : {}), ...(f.ssl ? { ssl: true } : {}) };
    }
    async _wizConnect() {
      const W = this._w, w = this.t.w;
      W.busy = true; W.err = ''; this._draw();
      try {
        const r = await this._api('POST', '/api/data/test-connection', { source: this._wizSpec() });
        W.tables = r.tables || []; W.cap = r.maxRowsPerTable || W.cap;
        W.tpick = new Set(W.tables.map((x, i) => x.overLimit ? -1 : i).filter(i => i >= 0));
        W.busy = false; W.step = 'pick'; this._draw();
      } catch (e) { W.busy = false; W.err = this._wizErr(e); this._draw(); }
    }
    async _wizImport() {
      const W = this._w, db = W.kind === 'postgres' || W.kind === 'mysql';
      let sources;
      if (db) sources = [{ ...this._wizSpec(), tables: [...W.tpick].sort((a, b) => a - b).map(i => W.tables[i].name) }];
      else sources = [...W.pick].sort((a, b) => a - b).map(i => {
        const c = W.found[i];
        if (c.kind === 'sqlite') { const sel = W.tsel[i], all = (c.tables || []).map(x => x.name); return { type: 'sqlite', path: c.path, ...(sel && sel.size < all.length ? { tables: all.filter(n => sel.has(n)) } : {}) }; }
        if (c.kind === 'duckdb') return { type: 'duckdb', path: c.path };
        return { type: 'file', path: c.path };
      });
      W.step = 'importing'; W.err = ''; W.prog = {}; W.order = []; W.since = 0; W.warns = 0; this._draw();
      let alive = true;
      const poll = async () => {
        while (alive) {
          try {
            const r = await this._api('GET', `/api/data/progress?since=${W.since}`);
            for (const ev of r.events || []) {
              W.since = Math.max(W.since, ev.seq);
              if (ev.type === 'import_warning') { W.warns++; continue; }
              if (!ev.table) continue;
              if (!W.prog[ev.table]) { W.prog[ev.table] = { table: ev.table, rows: 0, total: null, done: false }; W.order.push(ev.table); }
              const p = W.prog[ev.table];
              if (ev.rowsTotal != null) p.total = ev.rowsTotal;
              if (ev.rows != null) p.rows = ev.rows;
              if (ev.type === 'import_table') { p.done = true; p.total = p.rows; }
            }
            if (this._w === W && W.step === 'importing') this._draw();
          } catch (_) { /* polling is best effort */ }
          await new Promise(r => setTimeout(r, 700));
        }
      };
      poll();
      try {
        W.since = (await this._api('GET', '/api/data/progress?since=999999999')).last || 0;
        const r = await this._api('POST', '/api/data/add', { sources });
        alive = false;
        W.f.password = '';
        W.result = r.imported && r.imported.length ? r.imported : (r.summary || []);
        W.step = 'done';
        this._draw();
        this.refresh();
      } catch (e) { alive = false; W.err = this._wizErr(e); W.step = 'pick'; this._draw(); }
    }

    _model() {
      const t = this.t.m, c = this._set, m = c.model || this._st.model || {}, dis = this.owner ? '' : 'disabled';
      const u = this._st.usage || c.usage || {};
      const capRaw = c.limits?.dailyBudgetUSD ?? u.dailyBudgetUSD;
      const cap = capRaw == null ? 0 : Number(capRaw);
      const spent = Number(u.todayUSD || 0);
      const pct = cap > 0 ? Math.min(100, spent / cap * 100) : 0;
      const keyOn = this._keySet === 'set';
      const provs = ['deepseek', 'openai', 'custom'];
      const showBase = this.owner;
      return `<div class="card"><div class="grid">
<div><label class="f" for="provider">${esc(t.provider)}</label><select id="provider" ${dis}>${provs.map(p => `<option value="${p}" ${m.provider === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
<div><label class="f" for="modelName">${esc(t.model)}</label><input type="text" id="modelName" value="${esc(m.model)}" ${dis}></div>
${showBase ? `<div style="grid-column:1/-1"><label class="f" for="baseURL">${esc(t.baseURL)}</label><input type="text" id="baseURL" value="${esc(m.baseURL)}" ${dis}></div>` : ''}
${this.owner ? `<div><label class="f" for="cap">${esc(t.capLabel)}</label><input type="number" id="cap" min="0" step="0.1" value="${capRaw == null ? '' : esc(cap)}" ${dis}></div>` : ''}</div>
${this.owner ? `<div class="row" style="margin-top:12px"><button id="saveModel" class="primary" type="button">${esc(this.t.save)}</button><span class="msg" data-msg="model" aria-live="polite"></span></div>` : ''}</div>
<div class="card"><h3>${esc(t.spend)}</h3><div class="muted">${cap > 0 ? esc(t.spendOf(money(spent), money(cap))) : esc(t.nolimit) + ' · $' + money(spent)}</div>
${cap > 0 ? `<div class="meter ${pct >= 90 ? 'hot' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${esc(t.cap)}"><i style="width:${pct}%"></i></div>` : ''}</div>
<div class="card"><h3>${esc(t.key)}</h3><p style="margin:0 0 10px"><span class="pill ${keyOn ? 'ok' : 'no'}">${esc(keyOn ? t.keySet : t.keyUnset)}</span></p>
<label class="f" for="newKey">${esc(t.change)}</label><div class="row"><input type="password" id="newKey" autocomplete="off" style="flex:1 1 220px;width:auto" placeholder="${esc(t.changePh)}" ${dis}><button id="saveKey" type="button" ${dis}>${esc(t.change)}</button></div>
<p class="muted" style="margin:8px 0 0">${esc(t.keyHint)}</p><div class="msg" data-msg="key" aria-live="polite"></div></div>`;
    }

    /* 一句话的算法:由指标字段生成,原始写法收进「技术写法」 */
    _how(r) {
      const t = this.t.r, f = String(r.formula || '');
      const m = /^(\S+)\s*表\s+(\S+)\s+(.+)$/.exec(f);
      if (r.kind === 'simple' || m) {
        const tab = r.dataset || (m && m[1]), col = r.field || (m && m[2]);
        const opRaw = m ? m[3].trim() : '合计';
        const op = t.ops[opRaw] || opRaw;
        if (tab && col) return this.lang === 'zh' ? cjkSpace(`${tab}表的 ${col} 列${op}`) : `${op} of column ${col} in table ${tab}`;
      }
      if (f && !/[(){}=<>]|select|sum\(|count\(/i.test(f)) return cjkSpace(f.replace(/\s*\/\s*/g, ' ÷ ').replace(/\s*\*\s*/g, ' × '));
      return r.name || r.id;
    }
    _nonAdd(r) { return r.kind === 'ratio' || r.kind === 'derived' || r.unit === '%' || /平均|avg|average|率|÷|\//i.test(r.formula || ''); }
    _fmtNum(v, dec) { return v == null ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: dec ?? 2 }); }
    _pv(r) {
      const t = this.t.r, p = this._prev[r.id];
      if (!p || p.loading) return `<span class="muted">${esc(t.loadingPrev)}</span>`;
      const d = p.data; if (p.error || !d) return `<span class="muted">${esc(t.prevErr)}</span>`;
      const u = d.unit ? ' ' + esc(d.unit) : '', dec = d.decimals;
      const lm = d.lastMonth;
      const zh = this.lang === 'zh', non = this._nonAdd(r);
      const lmWord = zh ? '上个月' : t.basisLast;
      const lastTxt = lm ? `${lmWord}(${esc(lm.period)})${non || !zh ? ': ' : ' '}<b>${esc(this._fmtNum(lm.value, dec))}</b>${u}` : `${lmWord}:${esc(t.noLast)}`;
      const totalTxt = d.total == null ? esc(d.note || t.noTotal) : `<b>${esc(this._fmtNum(d.total, dec))}</b>${u}`;
      const sep = zh ? ';' : '; ';
      const cur = d.currencyNote ? `<div class="cur">${esc(d.currencyNote)}${d.byCurrency?.length ? ` · ${esc(t.byCur)}: ` + d.byCurrency.map(x => `${esc(x.currency)} <b>${esc(this._fmtNum(x.value, dec))}</b>`).join(zh ? ';' : '; ') : ''}</div>` : '';
      if (non) return `${esc(t.basisAll)}${zh ? ':' : ': '}${totalTxt}${sep}${lastTxt}${cur}`;
      return `${esc(t.preview)}${zh ? ':' : ': '}${esc(t.all)} ${totalTxt}${sep}${lastTxt}${cur}`;
    }
    _pvDim(r) {
      const t = this.t.r, p = this._prev[r.id];
      if (!this.owner) return '';
      if (!p || p.loading) return `<span class="muted">${esc(t.loadingPrev)}</span>`;
      const d = p.data; if (p.error || !d) return `<span class="muted">${esc(t.prevErr)}</span>`;
      const zh = this.lang === 'zh', sep = zh ? '、' : ', ';
      const head = `<b>${esc(t.distinct(this._fmtNum(d.distinct, 0)))}</b>${d.nullCount ? (zh ? ';' : '; ') + esc(t.nulls(this._fmtNum(d.nullCount, 0))) : ''}`;
      const top = (d.top || []).map(x => `${esc(x.value)} <span class="muted">(${esc(this._fmtNum(x.count, 0))})</span>`).join(sep);
      return `${head}${top ? `<div class="top">${esc(t.topVals)}${zh ? ':' : ': '}${top}</div>` : ''}<div class="muted" style="font-size:12.5px;margin-top:4px">${esc(t.dimLocal)}</div>`;
    }
    _dims() {
      const t = this.t.r, dis = this.owner ? '' : 'disabled';
      const list = this._dimList || [];
      if (!list.length) return '';
      const pill = r => `<span class="pill st-${esc(r.status)}">${esc(t.st[r.status] || r.status)}</span>`;
      const head = r => `<div class="row" style="justify-content:space-between;align-items:flex-start"><h4 style="margin:0">${esc(r.name || r.id)}</h4>${pill(r)}</div><div class="muted" style="margin-top:2px">${esc(t.dimKinds[r.kind] || r.kind)}${r.formula ? ' · ' + esc(this.lang === 'zh' ? cjkSpace(r.formula) : r.formula) : ''}</div>`;
      const btn = (r, act, label, cls = '') => `<button class="${cls}" type="button" data-rule="${esc(r.id)}" data-do="${act}" ${dis}>${esc(label)}</button>`;
      const pending = list.filter(r => r.status === 'unconfirmed' || r.status === 'reverted');
      const rest = list.filter(r => r.status !== 'unconfirmed' && r.status !== 'reverted');
      const card = r => `<div class="metric">${head(r)}<div class="pv" aria-live="polite">${this._pvDim(r)}</div><div class="row">${btn(r, 'confirm', t.ok, 'primary')}${btn(r, 'reject', t.no)}</div></div>`;
      const line = r => `<li><div class="row" style="justify-content:space-between;align-items:flex-start"><div style="min-width:0;flex:1 1 200px">${head(r)}</div>${r.status === 'confirmed' || r.status === 'rejected' ? btn(r, 'revert', t.revert, 'danger') : ''}</div></li>`;
      return `<div class="card"><h3>${esc(t.dims)}</h3><p class="muted" style="margin:0 0 10px">${esc(t.dimsHint)}</p>${pending.length ? pending.map(card).join('') : `<p class="muted" style="margin:0">${esc(t.dimNone)}</p>`}${rest.length ? `<details style="margin-top:10px"><summary>${esc(t.confirmed)} (${rest.length})</summary><ul class="plain">${rest.map(line).join('')}</ul></details>` : ''}</div>`;
    }
    _rules() {
      const t = this.t.r, dis = this.owner ? '' : 'disabled';
      const list = this._ruleList || [];
      const pending = list.filter(r => r.status === 'unconfirmed' || r.status === 'reverted');
      const done = list.filter(r => r.status === 'confirmed' || r.status === 'provided');
      const rej = list.filter(r => r.status === 'rejected');
      const pill = r => `<span class="pill st-${esc(r.status)}">${esc(t.st[r.status] || r.status)}</span>`;
      const head = r => `<div class="row" style="justify-content:space-between;align-items:flex-start"><h4 style="margin:0">${esc(r.name || r.id)}</h4>${pill(r)}</div><div class="muted" style="margin-top:2px">${esc(t.formula)}:${esc(this._how(r))}</div><details class="tech"><summary>${esc(t.tech)}</summary><code>${esc(r.formula)}</code></details>`;
      const btn = (r, act, label, cls = '') => `<button class="${cls}" type="button" data-rule="${esc(r.id)}" data-do="${act}" ${dis}>${esc(label)}</button>`;
      const card = r => `<div class="metric">${head(r)}<div class="pv" aria-live="polite">${this._pv(r)}</div><div class="row">${btn(r, 'confirm', t.ok, 'primary')}${btn(r, 'reject', t.no)}</div></div>`;
      const line = (r, act, label, cls) => `<li><div class="row" style="justify-content:space-between;align-items:flex-start"><div style="min-width:0;flex:1 1 200px">${head(r)}</div>${act ? btn(r, act, label, cls) : ''}</div></li>`;
      return `<div class="card"><h3>${esc(t.auto)}</h3>${pending.length ? pending.map(card).join('') : `<p class="muted" style="margin:0">${esc(t.noAuto)}</p>`}<div class="msg" data-msg="rule" aria-live="polite"></div></div>
<div class="card"><h3>${esc(t.confirmed)}</h3>${done.length ? `<ul class="plain">${done.map(r => line(r, r.status === 'confirmed' ? 'revert' : '', t.revert, 'danger')).join('')}</ul>` : `<p class="muted" style="margin:0">${esc(t.noConf)}</p>`}</div>
${rej.length ? `<div class="card"><h3>${esc(t.rejectedList)}</h3><ul class="plain">${rej.map(r => line(r, 'revert', t.revert, 'danger')).join('')}</ul></div>` : ''}${this._dims()}`;
    }

    _privacy() {
      const t = this.t.p, dis = this.owner ? '' : 'disabled';
      const tables = this._set.privacy?.tables || this._st.tables || [];
      const hidden = new Set(this._set.privacy?.hiddenColumns || []);
      return `<div class="card"><p class="muted" style="margin:0 0 8px">${esc(t.intro)}</p><div class="msg" data-msg="privacy" aria-live="polite"></div>${tables.length ? tables.map(x => `<details class="tbl" open><summary>${esc(x.name)} <span class="muted">${esc(t.cols((x.columns || []).length))}</span></summary>${(x.columns || []).map((c, i) => {
        const cn = typeof c === 'string' ? c : c.name, key = `${x.name}.${cn}`, id = `h-${x.name}-${i}`;
        return `<div class="col"><span class="n"><label for="${esc(id)}">${esc(cn)}</label> ${c.type ? `<span class="ty">${esc(c.type)}</span>` : ''}</span><span class="muted">${esc(t.hidden)}</span><input class="sw" type="checkbox" role="switch" id="${esc(id)}" data-hide="${esc(key)}" ${hidden.has(key) || c.hidden ? 'checked' : ''} ${dis}></div>`;
      }).join('')}</details>`).join('') : `<p class="muted">${esc(t.tablesEmpty)}</p>`}</div>`;
    }
  }
  customElements.define('estratto-settings', EstrattoSettings);
})();
