'use strict';
// rc.6 MCP server (stdio) over one workspace, using the official @modelcontextprotocol/sdk.
// The workspace (and with it the api key) comes from the configuration only; no tool takes a path.
// Default tools: ask, list_tables, list_rules. confirm_rule, revert_rule, confirm_choice exist only when surfaces.mcp.allowRuleChanges is true.
// Results carry answer text, status, calculation notes and confirmation options; never raw rows, plans, SQL or secrets.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const pkg = require('../package.json');

const MAX_QUESTION = 2000;
const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

function toolList(allowRuleChanges) {
  const tools = [
    { name: 'ask', description: 'Ask a business question about the workspace data in plain language. The number is computed locally on the data; the status says how far to trust it (verified, needs_confirm, unverified, no_data, refused, error).', inputSchema: obj({ question: { type: 'string', description: 'The question, in the user\'s own words.', maxLength: MAX_QUESTION } }, ['question']) },
    { name: 'list_tables', description: 'List the tables and columns that questions can use (hidden columns are not listed).', inputSchema: obj({}, []) },
    { name: 'list_rules', description: 'List the metrics (calculations) and dimensions (grouping fields such as channel or country) the workspace knows, with their meaning and whether a person has confirmed them.', inputSchema: obj({}, []) },
  ];
  if (allowRuleChanges) {
    tools.push(
      { name: 'confirm_rule', description: 'Confirm a metric or an earlier confirmation record by id (changes the workspace rules).', inputSchema: obj({ id: { type: 'string', maxLength: 200 } }, ['id']) },
      { name: 'revert_rule', description: 'Undo the confirmation of a metric or record by id (changes the workspace rules).', inputSchema: obj({ id: { type: 'string', maxLength: 200 } }, ['id']) },
      { name: 'confirm_choice', description: 'Answer a pending confirmation of an earlier ask: pass its requestId and the chosen option ("accept", an option number, or an option value).', inputSchema: obj({ requestId: { type: 'string', maxLength: 80 }, choice: { description: 'accept, an option index, or an option value', anyOf: [{ type: 'string' }, { type: 'number' }] } }, ['requestId', 'choice']) },
    );
  }
  return tools;
}

function askText(r) {
  const lines = [String(r.answer || r.answerLine || '').trim() || '(no answer)', 'status: ' + r.status];
  if (r.refusal) lines.push('refused: ' + r.refusal.code);
  if (r.confirm) {
    lines.push('needs confirmation (requestId: ' + r.requestId + ', kind: ' + r.confirm.kind + ')');
    if (r.confirm.message) lines.push(String(r.confirm.message));
    if (Array.isArray(r.confirm.options) && r.confirm.options.length) lines.push('options: ' + JSON.stringify(r.confirm.options));
  }
  return lines.join('\n');
}
const askData = r => ({ requestId: r.requestId, status: r.status, answer: r.answer, answerLine: r.answerLine, route: r.route, confirm: r.confirm || null, refusal: r.refusal || null });

function createMcpServer(ws, { allowRuleChanges } = {}) {
  const allow = allowRuleChanges != null ? !!allowRuleChanges : !!ws.config.surfaces.mcp.allowRuleChanges;
  const server = new Server({ name: 'estratto-' + ws.config.name, version: pkg.version }, { capabilities: { tools: {} } });
  const out = (text, data, isError) => {
    const safe = ws.redact.deep({ text, data });
    return { content: [{ type: 'text', text: safe.text }], ...(safe.data ? { structuredContent: safe.data } : {}), ...(isError ? { isError: true } : {}) };
  };
  const fail = msg => out(String(msg).slice(0, 400), null, true);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList(allow) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name, a = req.params.arguments || {};
    try {
      if (name === 'ask') {
        const q = typeof a.question === 'string' ? a.question.trim() : '';
        if (!q) return fail('question must be a non-empty string');
        if (q.length > MAX_QUESTION) return fail('question is too long');
        const r = await ws.ask(q);
        return out(askText(r), askData(r));
      }
      if (name === 'list_tables') {
        const tables = ws.engine.tables().filter(t => !t.hidden && !t.excluded).map(t => ({ name: t.name, columns: t.columns.filter(c => !c.hidden && !c.excluded).map(c => ({ name: c.name, type: c.type })) }));
        return out(tables.map(t => t.name + '(' + t.columns.map(c => c.name + ':' + c.type).join(', ') + ')').join('\n') || '(no tables)', { tables });
      }
      if (name === 'list_rules') {
        const metrics = ws.engine.rules.metrics().map(m => ({ id: m.id, name: m.name, kind: m.kind, formula: m.formula, unit: m.unit, status: m.status }));
        const dimensions = ws.engine.rules.dimensions().map(d => ({ id: d.id, name: d.name, kind: d.kind, formula: d.formula, status: d.status }));   // names and structure only: no values
        const text = [...metrics.map(m => `metric     ${m.id}  ${m.name}  [${m.status}]  ${m.formula}${m.unit ? '  (' + m.unit + ')' : ''}`), ...dimensions.map(d => `dimension  ${d.id}  ${d.name}  [${d.status}]  ${d.formula}`)].join('\n');
        return out(text || '(no metrics)', { metrics, dimensions });
      }
      if (!allow && ['confirm_rule', 'revert_rule', 'confirm_choice'].includes(name)) return fail('unknown tool: ' + name);
      if (name === 'confirm_rule' || name === 'revert_rule') {
        if (typeof a.id !== 'string' || !a.id || a.id.length > 200) return fail('id is required');
        const rec = await ws.use(e => name === 'confirm_rule' ? e.rules.confirm(a.id, { by: 'mcp' }) : e.rules.revert(a.id, { by: 'mcp' }));
        return out(`${name === 'confirm_rule' ? 'confirmed' : 'reverted'}: ${rec.id || a.id} (${rec.status || 'ok'})`, { id: rec.id || a.id, status: rec.status || null });
      }
      if (name === 'confirm_choice') {
        if (typeof a.requestId !== 'string' || !a.requestId) return fail('requestId is required');
        if (!(typeof a.choice === 'string' || typeof a.choice === 'number')) return fail('choice is required');
        const r = await ws.confirm(a.requestId, a.choice);
        return out(askText(r), askData(r));
      }
      return fail('unknown tool: ' + name);
    } catch (e) { return fail(ws.redact.str(String(e && e.message || e))); }
  });
  return server;
}

/** connect to stdio and resolve when the client goes away */
async function runMcp(ws, opts = {}) {
  const server = createMcpServer(ws, opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise(resolve => { server.onclose = resolve; process.stdin.once('end', resolve); process.stdin.once('close', resolve); });
  try { await server.close(); } catch (_) {}
}

module.exports = { createMcpServer, runMcp, toolList };
