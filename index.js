'use strict';
const { createEngine, writeAttempt, CODE_VERSION } = require('./src/engine.js');
const { openaiCompatible } = require('./src/openai.js');
const { protect } = require('./src/privacy.js');
const { initWorkspace, openWorkspace, readConfig, validateConfig } = require('./src/workspace.js');
module.exports = {
  createEngine, openaiCompatible, writeAttempt, protect, CODE_VERSION,
  initWorkspace, openWorkspace, readConfig, validateConfig,
  // loaded on first use (the HTTP service and the MCP server pull in more modules)
  startServe: (...a) => require('./src/serve/index.js').startServe(...a),
  createMcpServer: (...a) => require('./src/mcp.js').createMcpServer(...a),
};
