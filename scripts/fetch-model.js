#!/usr/bin/env node
'use strict';
// Downloads multilingual-e5-small (quantized ONNX) from Hugging Face (Xenova/multilingual-e5-small) into <dir>/multilingual-e5-small.
//   node scripts/fetch-model.js [targetDir]          (default: ./models)
// The engine never calls this by itself; models are not shipped in the npm tarball. License of the model: MIT.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main';
const FILES = [
  { name: 'config.json', remote: 'config.json' },
  { name: 'tokenizer.json', remote: 'tokenizer.json' },
  { name: 'model_quantized.onnx', remote: 'onnx/model_quantized.onnx' },
];

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('download failed ' + res.status + ' ' + url);
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const h = crypto.createHash('sha256');
  let n = 0;
  for await (const chunk of res.body) { out.write(chunk); h.update(chunk); n += chunk.length; }
  await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  fs.renameSync(tmp, dest);
  return { bytes: n, sha256: h.digest('hex') };
}

async function main() {
  const root = path.resolve(process.argv[2] || 'models');
  const dir = path.join(root, 'multilingual-e5-small');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(dir, f.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log('exists   ' + dest); continue; }
    process.stdout.write('download ' + f.remote + ' ... ');
    const r = await download(BASE + '/' + f.remote, dest);
    console.log(r.bytes + ' bytes  sha256=' + r.sha256);
  }
  console.log('done. Pass modelsDir: ' + JSON.stringify(root) + ' to createEngine().');
}
main().catch(err => { console.error(String(err && err.message || err)); process.exit(1); });
