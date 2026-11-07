'use strict';
// Private file helpers: directories 0700, files 0600.
const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dir) {
  const first = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (first) { // chmod every directory this call created (mkdir mode is masked by umask)
    let p = dir; const created = [];
    while (p.length >= first.length) { created.push(p); const up = path.dirname(p); if (up === p) break; p = up; }
    for (const c of created) { try { fs.chmodSync(c, 0o700); } catch (_) {} }
  }
}
function writeFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}
function touch(file) { if (!fs.existsSync(file)) writeFile(file, ''); }
function secureFile(file) { try { if (fs.existsSync(file)) fs.chmodSync(file, 0o600); } catch (_) {} }
function secureTree(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) secureTree(p); else secureFile(p); }
}
module.exports = { ensureDir, writeFile, touch, secureFile, secureTree };
