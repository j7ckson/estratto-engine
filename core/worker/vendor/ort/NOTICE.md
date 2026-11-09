# onnxruntime-web 1.22.0（只取了 wasm 版的三个文件）

10-16「取数报告改进 · 第四批」加入，给 `worker/embed.js` 在本机跑向量模型用（Node 里直接跑 wasm，不用装任何原生程序）。

- `ort.wasm.min.mjs`：入口
- `ort-wasm-simd-threaded.mjs`、`ort-wasm-simd-threaded.wasm`：推理内核（只开单线程用）

来源：npm `onnxruntime-web@1.22.0` 的 `dist/` 目录，原样拷贝，未改动。
许可：MIT，Copyright (c) Microsoft Corporation（<https://github.com/microsoft/onnxruntime>）。
