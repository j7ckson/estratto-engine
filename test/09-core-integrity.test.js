'use strict';
// core/ is a copy of the P80 source: every file must match core/CORE-MANIFEST.json, and only the documented files may differ from P80.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', 'core');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'CORE-MANIFEST.json'), 'utf8'));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('every core file matches the manifest (no silent edits), and no extra files exist', () => {
  const onDisk = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name !== 'CORE-MANIFEST.json') onDisk.push(path.relative(ROOT, p)); } })(ROOT);
  assert.deepEqual(onDisk.sort(), manifest.files.map(f => f.file).sort());
  for (const f of manifest.files) assert.equal(sha(path.join(ROOT, f.file)), f.sha256, f.file);
});

test('exactly the three documented core files differ from P80 (see DECISIONS.md); all others are byte-identical', () => {
  const modified = manifest.files.filter(f => f.modified).map(f => f.file).sort();
  assert.deepEqual(modified, ['main/ask.js', 'main/auto-semantics.js', 'worker/embed.js']);
  const decisions = fs.readFileSync(path.join(__dirname, '..', 'DECISIONS.md'), 'utf8');
  for (const f of modified) assert.ok(decisions.includes('core/' + f), f + ' is documented in DECISIONS.md');
  for (const f of manifest.files) if (!f.modified) assert.equal(f.sha256, f.sha256_p80, f.file);
});
