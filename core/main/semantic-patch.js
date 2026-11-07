// ================= 语义补丁与确认（M2）=================
// 新领域只补「差量」：别名、字段绑定、指标表达式、关系、业务决定。
// 每条补丁都要能回答四个问题：**凭什么**（证据）、**作用在哪**（作用域）、**谁定的**（model / rule / user）、
// **怎么退**（旧新版本 + 依赖 + 撤销）。
//
// 三条不能含糊的规则（来自复审）：
//   · request_id / usage 只证明「调用发生过」，不证明地图是对的；
//   · rule 模式没有模型 usage 时记 model_calls=0，不因此判「未运行」；
//   · C-confirmed 必须有真实决定来源（谁、什么时候、选了什么），不能自己盖章。
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const relations = require('./relations');

const ORIGINS = new Set(['model', 'rule', 'user']);
// 对外的类型名（工具/CLI 用）→ 内部类型。relation 就是 relationship，field_binding 就是 binding。
const KIND_ALIAS = { relation: 'relationship', field_binding: 'binding' };
const KINDS = new Set(['alias', 'binding', 'metric', 'dimension', 'relationship', 'decision', 'field_binding', 'relation']);
const nowISO = () => new Date().toISOString();
const hash = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);

class PatchError extends Error {
  constructor(code, message){ super(message); this.code = code; }
}

class PatchStore {
  /**
   * @param {{registry?:object, now?:Function, freezeState?:object}} o
   */
  constructor(o = {}){
    this.registry = o.registry || null;
    this.now = o.now || nowISO;
    this.patches = new Map();        // id → patch（含 versions）
    this.order = [];
    this.frozen = null;              // {at, reason, hidden_set, by}
    this.decisions = [];             // 业务决定（问题 → 选项 → 选定）
    this.events = [];
    // 给了 dir 就落盘：patches.json + generated/ 语义包。重启后读回来，候选态也一起保留。
    this.dir = o.dir || null;
    this.tables = o.tables || null;      // [{name, columns:[{name,type}], stats}]：关系补丁校验用
    this.mapVersion = 0;                 // 地图版本：每次确认/撤销/改口径 +1，补丁记录引用它
    if (this.dir) this._load();
  }

  /* ---------- 落盘 / 重启恢复 ---------- */
  toJSON(){
    return {
      schema: 'studio-patches/v1', saved_at: this.now(), map_version: this.mapVersion,
      order: this.order.slice(),
      patches: this.order.map(id => this.patches.get(id)),
      frozen: this.frozen, decisions: this.decisions.slice(), events: this.events.slice(-500),
    };
  }
  _load(){
    try {
      const f = path.join(this.dir, 'patches.json');
      if (!fs.existsSync(f)) return this;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const id of j.order || []) this.order.push(id);
      for (const p of j.patches || []) this.patches.set(p.id, p);
      this.mapVersion = Number(j.map_version) || 0;
      this.frozen = j.frozen || null;
      this.decisions = (j.decisions || []).slice();
      this.events = (j.events || []).slice();
    } catch (err) {
      // 文件坏了不能当成「没有补丁」：记一笔，交给调用方决定（不静默丢口径）
      this.load_error = String(err && err.message || err);
    }
    return this;
  }
  save(){
    if (!this.dir) return this;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, 'patches.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2));
    fs.renameSync(tmp, file);            // 原子替换：写一半崩了也不会留半个文件
    return this;
  }
  _commit(){
    this.mapVersion += 1;
    this.save();
    try { return this.exportPacks(); } catch (_) { return null; }
  }

  /* ---------- 关系补丁：实测基数 / 唯一性 / 类型 ---------- */
  /**
   * 关系进包之前必须实测，不能凭模型说「是多对一」。
   * @param {string} id
   * @param {{tables?:Array, rowsOf?:Function}} o rowsOf(table) 返回行数组（测试/小表）；不给就看 columns/stats
   */
  verifyRelation(id, o = {}){
    const rec = this._get(id);
    if (rec.kind !== 'relationship') throw new PatchError('not_relation', '只有关系补丁需要实测');
    const p = this._head(rec).proposal || {};
    const tables = o.tables || this.tables || [];
    const rowsOf = o.rowsOf || null;
    const checks = [];
    const fail = (code, detail) => { checks.push({ name: code, ok: false, detail }); return { ok: false, code, checks }; };
    const tableOf = name => tables.find(t => t.name === name);

    const lt = tableOf(p.left), rt = tableOf(p.right);
    if (!lt || !rt) return fail('table_missing', { left: !!lt, right: !!rt });
    const pairs = Array.isArray(p.pairs) && p.pairs.length ? p.pairs : null;
    if (!pairs) return fail('pairs_missing', '关系要写明 pairs: [[左列, 右列], …]');
    for (const [lc, rc] of pairs) {
      if (!(lt.columns || []).some(c => c.name === lc)) return fail('column_missing', `${p.left}.${lc}`);
      if (!(rt.columns || []).some(c => c.name === rc)) return fail('column_missing', `${p.right}.${rc}`);
    }
    // 类型兼容：同为数字 / 同为文字 / 同为日期；数字↔文字允许（ID 常见），但要记下来
    const typeOf = (t, c) => ((t.columns || []).find(x => x.name === c) || {}).type || null;
    for (const [lc, rc] of pairs) {
      const a = typeOf(lt, lc), b = typeOf(rt, rc);
      if (a && b && a !== b && !(a === 'number' && b === 'text') && !(a === 'text' && b === 'number'))
        return fail('type_mismatch', { left: a, right: b });
      checks.push({ name: 'type', ok: true, detail: { [lc]: a, [rc]: b } });
    }
    // P1：四个基数都认（1:1 / N:1 / 1:N / N:N），但必须用真实行 / worker 实测；
    // 声明与实测不一致 → 拒绝（声明方向会被拿去 join，方向错了会放大行）。
    let card;
    try { card = relations.normCard(p.cardinality || 'N:1'); }
    catch (err) { return fail('fanout_risk', `基数无效：${p.cardinality}（只认 1:1 / N:1 / 1:N / N:N）`); }
    checks.push({ name: 'cardinality_declared', ok: true, detail: card });
    const leftCols = pairs.map(([lc]) => lc), rightCols = pairs.map(([, rc]) => rc);
    let L = null, R = null;
    try {
      if (rowsOf) {
        L = relations.keyStats(rowsOf(p.left), leftCols);
        R = relations.keyStats(rowsOf(p.right), rightCols);
      } else {
        if (o.measured) R = measuredSide(o.measured, rightCols);
        if (o.measuredLeft) L = measuredSide(o.measuredLeft, leftCols);
        if (!R) R = statsSide(rt, rightCols);
        if (!L) L = statsSide(lt, leftCols);
      }
    } catch (err) { return fail('verify_failed', String(err && err.message || err)); }
    // 方向确认：N:1 只要 one 侧（右）唯一就够；1:N 只要左唯一就够；1:1 要两侧都唯一；
    // N:N 要两侧都实测到「不唯一」，缺一侧不能推断。
    let measured = relations.measuredCardinality(L, R);
    let partial = false;
    if (!measured) {
      if (card === 'N:1' && R && R.unique) { measured = 'N:1'; partial = !L; }
      else if (card === '1:N' && L && L.unique) { measured = '1:N'; partial = !R; }
    }
    if (!measured) {
      if (!o.allowUnverified) return fail('cardinality_unverified', { rows: R && R.rows == null ? null : R && R.rows, hint: '用 rowsOf 或 worker 实测两侧键唯一性（复合键按整组），或 allowUnverified 由人确认' });
      const verification = { ok: true, at: this.now(), checks, rows: R && R.rows == null ? null : R && R.rows, unique: null, composite: pairs.length > 1, measured: false, cardinality: { declared: card, measured: null } };
      this._head(rec).verification = verification;
      this._event('relation_verified', { id, verification });
      this.save();
      return verification;
    }
    if (!relations.compatible(card, measured)) {
      if (card === 'N:1' && R && R.unique === false) return fail('not_unique', { duplicates: R.duplicates || null, pairs, declared: card, measured });
      return fail('fanout_risk', `声明 ${card}，实测 ${measured}：基数方向与数据不符（声明方向会被拿去 join）`);
    }
    checks.push({ name: 'cardinality_measured', ok: true, detail: { declared: card, measured, partial,
      left: L ? { rows: L.rows, unique: L.unique, distinct: L.distinct } : null,
      right: R ? { rows: R.rows, unique: R.unique, distinct: R.distinct } : null } });
    const uniqueSide = card === '1:N' ? !!(L && L.unique) : !!(R && R.unique);
    const verification = { ok: true, at: this.now(), checks, rows: R && R.rows == null ? null : R && R.rows,
      unique: uniqueSide, composite: pairs.length > 1, measured: true, partial,
      cardinality: { declared: card, measured }, left: L, right: R };
    this._head(rec).verification = verification;
    this._event('relation_verified', { id, verification });
    this.save();
    return verification;
  }

  /* ---------- 确认过的补丁 → 生成语义包（只有 confirmed 才进） ---------- */
  exportPacks(){
    if (!this.dir) return { packs: [], skipped: [] };
    const confirmed = this.list({ status: 'confirmed' });
    const byDataset = new Map(), skipped = [], aliasesOut = [], relations = [];
    const metricIds = new Set();
    for (const rec of confirmed) {
      const head = this._head(rec);
      const p = head.proposal || {};
      const ds = (rec.scope && rec.scope.dataset) || p.dataset || null;
      if (rec.kind === 'metric' || rec.kind === 'dimension') {
        if (!ds || !p.field) { skipped.push({ id: rec.id, kind: rec.kind, why: '缺 dataset / field' }); continue; }
        if (!byDataset.has(ds)) byDataset.set(ds, { metrics: [], dims: [], patches: [] });
        byDataset.get(ds).patches.push({ id: rec.id, kind: rec.kind, origin: rec.origin, decided_by: head.decided_by || null, v: rec.head, map_version: head.map_version || null });
        if (rec.kind === 'metric') {
          metricIds.add(p.id);
          byDataset.get(ds).metrics.push({ id: p.id, name: p.name || p.id, kind: 'simple', dataset: ds, agg: p.agg || 'sum', role: p.field, match: [p.field], additivity: p.additivity || 'additive', unit: p.unit || '', decimals: p.decimals == null ? 2 : p.decimals });
        } else {
          byDataset.get(ds).dims.push({ id: p.id, name: p.name || p.id, kind: 'column', dataset: ds, role: p.field, match: [p.field] });
        }
      } else if (rec.kind === 'relationship') {
        // 只有实测通过的关系才进包；没实测就记原因，不静默丢
        if (!head.verification || !head.verification.ok) { skipped.push({ id: rec.id, kind: 'relationship', why: '关系未实测（先 verifyRelation）' }); continue; }
        relations.push({ id: 'rel_' + crypto.createHash('sha1').update(rec.id).digest('hex').slice(0, 10), patch: rec.id, left: p.left, right: p.right, pairs: p.pairs, cardinality: p.cardinality, verification: head.verification, decided_by: head.decided_by || null, map_version: head.map_version || null });
      } else if (rec.kind === 'alias') {
        if (!p.target || !p.alias) { skipped.push({ id: rec.id, kind: 'alias', why: '缺 target / alias' }); continue; }
        aliasesOut.push({ patch: rec.id, target: p.target, alias: String(p.alias), scope: rec.scope || null, decided_by: head.decided_by || null, map_version: head.map_version || null });
      } else if (rec.kind === 'binding') {
        // field_binding：只对「本包内定义的指标」生效；内置指标要改绑定只能发新包（不在这里悄悄改）
        const target = String(p.target || '').replace(/^m:/, '');
        let applied = false;
        for (const part of byDataset.values()) for (const m of part.metrics) {
          if (m.id === target) { m.role = p.field; m.match = [p.field]; applied = true; }
        }
        if (!applied) skipped.push({ id: rec.id, kind: 'binding', why: '目标指标不在生成包里（内置指标改绑定要发新语义包，这里不改）' });
      } else if (rec.kind === 'decision') {
        // 决定不进包（它属于口径记录，不进语义定义）
      } else {
        skipped.push({ id: rec.id, kind: rec.kind, why: `kind=${rec.kind} 不写进生成包` });
      }
    }
    // 别名可能指向内置指标：包里的 aliases 由 registry 叠加（不改内置定义的源文件）
    const dir = path.join(this.dir, 'generated');
    fs.mkdirSync(dir, { recursive: true });
    const writePack = (packId, name, datasets, body, metaExtra) => {
      const file = path.join(dir, packId + '.json');
      let prev = null;
      try { if (fs.existsSync(file)) prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
      const prevMeta = (prev && prev._meta) || {};
      const version = prevMeta.content_hash === hash ? (prevMeta.version || 1) : ((prevMeta.version || 0) + 1);
      const history = (prevMeta.history || []).slice(-4);
      if (prev && prevMeta.content_hash !== hash) history.push({ version: prevMeta.version || 1, content_hash: prevMeta.content_hash, at: prevMeta.generated_at || null });
      const pack = Object.assign({
        id: packId, name, datasets, grain: {}, metrics: [], dims: [], relationships: [],
      }, body, {
        _meta: Object.assign({
          schema: 'studio-semantic-pack/v1', generated_at: this.now(), version, content_hash: hash,
          map_version: this.mapVersion, source: 'PatchStore.exportPacks', history, skipped,
          note: '只包含确认过的补丁；候选/驳回/未实测的不进包。',
        }, metaExtra || {}),
      });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(pack, null, 2));
      fs.renameSync(tmp, file);
      return { file, pack_id: packId, name, version, metrics: pack.metrics.length, dims: pack.dims.length, relationships: pack.relationships.length, aliases: (pack.aliases || []).length };
    };

    const packs = [];
    for (const [ds, part] of byDataset) {
      if (!part.metrics.length && !part.dims.length) continue;
      const packId = 'gen_' + crypto.createHash('sha1').update(String(ds)).digest('hex').slice(0, 10);
      packs.push(writePack(packId, String(ds), { [ds]: { match: [String(ds)], keys: [] } },
        { metrics: part.metrics, dims: part.dims }, { scope: { dataset: ds }, patches: part.patches }));
    }
    if (aliasesOut.length) {
      const key = aliasesOut.map(a => a.target + '|' + a.alias).sort().join(';');
      const packId = 'gen_alias_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
      packs.push(writePack(packId, '别名补丁', {}, { aliases: aliasesOut }, { scope: { aliases: aliasesOut.map(a => a.target) } }));
    }
    if (relations.length) {
      const key = relations.map(r => [r.left, r.right, JSON.stringify(r.pairs)].join('|')).sort().join(';');
      const packId = 'gen_rel_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
      const datasets = {};
      for (const r of relations) { datasets[r.left] = { match: [r.left], keys: [] }; datasets[r.right] = { match: [r.right], keys: [] }; }
      const relDefs = relations.map(r => ({ id: r.id, left: r.left, right: r.right, pairs: r.pairs, cardinality: r.cardinality }));
      packs.push(writePack(packId, '关系补丁', datasets, { relationships: relDefs }, {
        scope: { datasets: [...new Set(relations.flatMap(r => [r.left, r.right]))] },
        patches: relations.map(r => ({ id: r.patch, kind: 'relationship', verified: r.verification, decided_by: r.decided_by, map_version: r.map_version })),
      }));
    }
    // 撤销/驳回后包可能变空：把这一轮没再产出的 gen_*.json 删掉，别让旧文件继续被加载
    const produced = new Set(packs.map(p => path.basename(p.file)));
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('gen_') || !f.endsWith('.json') || produced.has(f)) continue;
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
    this.exported = packs;
    return { packs, skipped };
  }

  listPacks(){
    const dir = this.dir ? path.join(this.dir, 'generated') : null;
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { file: path.join(dir, f), id: j.id, name: j.name, meta: j._meta || {}, metrics: (j.metrics || []).length, dims: (j.dims || []).length }; }
      catch (err) { return { file: path.join(dir, f), error: String(err.message || err) }; }
    });
  }

  _event(type, data){ this.events.push({ at: this.now(), type, ...data }); }

  /* ---------- 0. 自动候选（只用本机信息） ---------- */
  /**
   * 从 schema / 列画像 / 注释 / 文档 / 已有定义里提出候选。默认 origin=rule（0 次模型调用）。
   * @param {{tables:Array, profiles?:object, comments?:object, docs?:Array, existing?:object}} input
   */
  candidates(input = {}){
    const out = [];
    const comment = (input.comments || {});
    for (const t of input.tables || []) {
      const cols = t.columns || [];
      for (const c of cols) {
        const name = typeof c === 'string' ? c : c.name;
        const type = typeof c === 'string' ? null : c.type;
        const note = comment[c.name] || comment[t.name + '.' + c.name] || null;
        const prof = (input.profiles && (input.profiles[t.name] || {})[c.name]) || null;
        // 数值列 → 可加指标的候选（证据：类型 + 画像里的取值范围）
        if (type === 'number') {
          // 置信度只反映「本机证据有多强」：有画像 +0.15、有注释/文档 +0.15，不掺模型主观分
          const conf = Math.min(0.9, 0.55 + (prof ? 0.15 : 0) + (note && note.text ? 0.15 : 0));
          out.push({
            kind: 'metric', origin: 'rule', confidence: conf,
            proposal: { id: slug('m', t.name, name), name, dataset: t.name, agg: 'sum', field: name, additivity: 'additive' },
            evidence: [{ type: 'schema', ref: `${t.name}.${name}`, detail: `数值列` }, ...(prof ? [{ type: 'profile', ref: `${t.name}.${name}`, detail: `min=${prof.min} max=${prof.max} distinct=${prof.distinct}` }] : [])],
            scope: { dataset: t.name },
            needs_confirmation: true,
          });
        }
        // 文字列且基数低 → 维度候选（基数高的是 ID，不当分法）
        // 基数阈值 500：ID 类（user_id 6040 / stock_code 5300）排除，国家名 217 这类业务维度保留。
        // 阈值是**规则**，写在这里而不是按领域写死。
        if (type === 'text' && (!prof || prof.distinct == null || prof.distinct <= 500)) {
          out.push({
            kind: 'dimension', origin: 'rule', confidence: prof && prof.distinct != null ? 0.7 : 0.45,
            proposal: { id: slug('d', t.name, name), name, dataset: t.name, kind: 'column', field: name },
            evidence: [{ type: 'schema', ref: `${t.name}.${name}`, detail: '文字列' }, ...(prof && prof.distinct != null ? [{ type: 'profile', ref: `${t.name}.${name}`, detail: `distinct=${prof.distinct}` }] : [])],
            scope: { dataset: t.name }, needs_confirmation: true,
          });
        }
        // 有注释/文档说明的列 → 别名候选（证据是文字本身，不是模型猜的）
        if (note && note.text) {
          out.push({
            kind: 'alias', origin: 'rule', confidence: 0.6,
            proposal: { target: `${t.name}.${name}`, alias: note.text },
            evidence: [{ type: note.source === 'doc' ? 'doc' : 'schema', ref: note.ref || `${t.name}.${name}`, detail: note.text }],
            scope: { dataset: t.name }, needs_confirmation: true,
          });
        }
      }
    }
    // 已有定义（同名列/同义键）→ 关系候选：两侧都出现同名列且基数不高的，先提后验
    for (const d of (input.docs || [])) {
      if (d && d.type === 'join_hint' && d.left && d.right) {
        out.push({
          kind: 'relationship', origin: 'rule', confidence: 0.5,
          proposal: { left: d.left, right: d.right, keys: d.keys || [], cardinality: d.cardinality || null },
          evidence: [{ type: 'doc', ref: d.ref || 'doc', detail: d.detail || '文档里的关联说明' }],
          scope: { datasets: [d.left, d.right] }, needs_confirmation: true,
          verify: 'uniqueness/cardinality must be measured before confirm',
        });
      }
    }
    return out;
  }

  /* ---------- 1. 提议 ---------- */
  propose(patch){
    const p = Object.assign({}, patch);
    if (KIND_ALIAS[p.kind]) p.kind = KIND_ALIAS[p.kind];
    if (!KINDS.has(p.kind) && !KIND_ALIAS[p.kind]) throw new PatchError('bad_kind', `补丁类型无效：${p.kind}`);
    if (!ORIGINS.has(p.origin)) throw new PatchError('bad_origin', `来源必须是 model / rule / user：${p.origin}`);
    if (this.frozen && !p.override_freeze) throw new PatchError('frozen', `地图已冻结（${this.frozen.reason}），不能再改；需要先由人解冻`);
    if (!Array.isArray(p.evidence) || !p.evidence.length) throw new PatchError('no_evidence', '补丁必须带证据（schema / profile / doc / definition / user_decision）');
    if (!p.scope || (!p.scope.dataset && !p.scope.metric && !p.scope.dim && !(p.scope.datasets && p.scope.datasets.length))) throw new PatchError('no_scope', '补丁必须写明作用域（dataset / datasets / metric / dim）');
    if (p.kind === 'alias' && !(p.proposal && p.proposal.alias && p.proposal.target)) throw new PatchError('bad_proposal', 'alias 补丁要写 {target, alias}');
    if (p.kind === 'binding' && !(p.proposal && p.proposal.field)) throw new PatchError('bad_proposal', 'field_binding 补丁要写 {field}（可带 target）');
    if (p.origin === 'user') {
      if (!p.decided_by) throw new PatchError('no_decider', 'user 来源的补丁必须写明是谁定的（decided_by）');
      p.decided_at = p.decided_at || this.now();
    }
    // model 来源：usage / request_id 只作为「调用发生过」的记录，不作为正确性证据
    p.call_proof = p.origin === 'model'
      ? { request_id: p.request_id || null, usage: p.usage || null, note: '只证明调用发生，不证明语义正确' }
      : p.origin === 'rule' ? { model_calls: p.model_calls == null ? 0 : p.model_calls, note: '规则生成；0 调用不等于未运行' } : { decided_by: p.decided_by };
    const id = 'patch_' + hash({ kind: p.kind, proposal: p.proposal, scope: p.scope, at: this.now() });
    const v1 = { v: 1, at: this.now(), status: 'candidate', proposal: p.proposal, evidence: p.evidence, origin: p.origin, decided_by: p.decided_by || null };
    const rec = { id, kind: p.kind, scope: p.scope, origin: p.origin, call_proof: p.call_proof, needs_confirmation: p.needs_confirmation !== false, versions: [v1], head: 1 };
    this.patches.set(id, rec); this.order.push(id);
    this._event('patch_proposed', { id, kind: p.kind, origin: p.origin });
    this._commit();
    return rec;
  }

  /* ---------- 2. 确认 / 驳回 ---------- */
  confirm(id, o = {}){
    const rec = this._get(id);
    if (this._head(rec).status === 'confirmed') return rec;
    // C-confirmed 必须有真实决定来源：模型候选不能自己确认
    const by = o.by || o.decided_by;
    if (!by || by === 'model') throw new PatchError('no_decider', '确认必须由人（或明确策略）做出，模型不能给自己盖章');
    this._freezeGuard('confirm');
    const head = this._head(rec);
    head.status = 'confirmed';
    head.patch_id = id;
    head.decided_by = by;
    head.decided_at = o.at || this.now();
    head.decision_evidence = o.evidence || head.evidence;      // 决定依据：谁、凭什么
    head.map_version = this.mapVersion + 1;                    // 这次确认之后的第几个地图版本
    if (o.decision_note) head.decision_note = o.decision_note;
    this._event('patch_confirmed', { id, by, map_version: head.map_version });
    this._commit();
    return rec;
  }
  reject(id, o = {}){
    const rec = this._get(id);
    const head = this._head(rec);
    const by = (o && (o.by || o.decided_by)) || null;
    if (by === 'model') throw new PatchError('no_decider', '驳回也要由人（或明确策略）做');
    head.status = 'rejected';
    head.patch_id = id;
    head.reason = (o && (o.reason || o.why)) || (typeof o === 'string' ? o : 'no_reason');
    head.rejected_by = by; head.rejected_at = this.now();
    head.decision_evidence = (o && o.evidence) || null;
    head.map_version = this.mapVersion + 1;
    this._event('patch_rejected', { id, reason: head.reason, by });
    this._commit();
    return rec;
  }

  /* ---------- 3. 版本 / 依赖 / 撤销 ---------- */
  revise(id, o = {}){
    const rec = this._get(id);
    this._freezeGuard('revise');
    if (!o.evidence || !o.evidence.length) throw new PatchError('no_evidence', '改口径也要带证据');
    const prev = this._head(rec);
    const next = { v: rec.head + 1, at: this.now(), status: 'candidate', proposal: o.proposal || prev.proposal, evidence: o.evidence, origin: o.origin || prev.origin, supersedes: rec.head, decided_by: null };
    rec.versions.push(next); rec.head = next.v;
    this._event('patch_revised', { id, from: prev.v, to: next.v });
    this._commit();
    return rec;
  }
  /** 撤销 = 回到上一版（不删历史）；相关指标 / 缓存要一起失效 */
  revert(id, o = {}){
    const rec = this._get(id);
    const by = (o && (o.by || o.decided_by)) || null;
    if (by === 'model') throw new PatchError('no_decider', '撤销也要由人做');
    if (rec.head <= 1) {
      this._head(rec).status = 'reverted';
      this._head(rec).reverted_by = by; this._head(rec).reverted_at = this.now();
      this._head(rec).map_version = this.mapVersion + 1;
      this._event('patch_reverted', { id, to: 0, by });
      this._commit();
      return { rec, invalidates: this.dependents(id) };
    }
    rec.head -= 1;
    this._head(rec).status = 'confirmed';
    this._head(rec).reverted_by = by; this._head(rec).reverted_at = this.now();
    this._head(rec).map_version = this.mapVersion + 1;
    this._event('patch_reverted', { id, to: rec.head, by });
    this._commit();
    return { rec, invalidates: this.dependents(id) };
  }
  /** 谁依赖这条补丁：同 target 的指标 / 引用它的表达式（本机静态扫描，不做数据库血缘） */
  dependents(id){
    const rec = this.patches.get(id);
    if (!rec) return [];
    const target = this._head(rec).proposal;
    const out = [];
    for (const [oid, o] of this.patches) {
      if (oid === id) continue;
      const p = this._head(o).proposal || {};
      if (p.num === target.id || p.den === target.id) out.push(oid);
      if (p.target === target.id) out.push(oid);
      if (p.dataset && target.dataset && p.dataset === target.dataset) out.push(oid);
    }
    return [...new Set(out)];
  }

  /* ---------- 4. 冻结（隐藏题揭晓前不许按答案补地图） ---------- */
  freeze(o = {}){
    if (!o.by) throw new PatchError('no_decider', '冻结要写明是谁冻结的');
    this.frozen = { at: this.now(), reason: o.reason || '冻结待测', hidden_set: o.hidden_set || null, by: o.by };
    this._event('map_frozen', this.frozen);
    this._commit();
    return this.frozen;
  }
  unfreeze(o = {}){
    if (!this.frozen) return null;
    if (!o.by || o.by === 'model') throw new PatchError('no_decider', '解冻必须由人做');
    const was = this.frozen; this.frozen = null;
    this._event('map_unfrozen', { ...was, by: o.by, at: this.now(), reason: o.reason || null });
    this._commit();
    return was;
  }
  _freezeGuard(action){
    // 冻结期间允许「记录人工决定」，但改地图（新补丁 / 改口径）要显式解冻
    if (this.frozen) throw new PatchError('frozen', `地图已冻结，不能 ${action}；先由人解冻`);
  }

  /* ---------- 5. 业务决定 ---------- */
  decide(o = {}){
    if (!o.question || !o.chosen) throw new PatchError('bad_decision', '决定要写明「问题」和「选了什么」');
    const d = { id: 'dec_' + hash({ q: o.question, c: o.chosen, at: this.now() }), question: o.question, chosen: o.chosen, options: o.options || [], decided_by: o.decided_by || null, at: this.now(), scope: o.scope || null };
    if (!d.decided_by || d.decided_by === 'model') throw new PatchError('no_decider', '业务决定必须有人（或明确策略）作为来源');
    this.decisions.push(d);
    this._event('decision', { id: d.id, question: d.question, chosen: d.chosen });
    this._commit();
    return d;
  }
  /** 已有决定能覆盖这个问题就不再问（恢复任务时不重复问） */
  decided(question, scope){
    return this.decisions.find(d => d.question === question && (!scope || JSON.stringify(d.scope) === JSON.stringify(scope))) || null;
  }

  /* ---------- 6. 生成地图 + 计分 ---------- */
  /** 把 confirmed 补丁展开成一张「地图」，结构 {metrics, dims, rels, decisions, stats} */
  buildMap(){
    const map = { metrics: [], dims: [], rels: [], decisions: this.decisions.slice(), by_origin: { model: 0, rule: 0, user: 0 }, confirmed: 0, candidates: 0, rejected: 0 };
    for (const id of this.order) {
      const rec = this.patches.get(id);
      const head = this._head(rec);
      map.by_origin[rec.origin] = (map.by_origin[rec.origin] || 0) + 1;
      if (head.status === 'confirmed') map.confirmed++;
      else if (head.status === 'rejected') map.rejected++;
      else map.candidates++;
      if (head.status !== 'confirmed') continue;
      const p = head.proposal;
      if (rec.kind === 'metric') map.metrics.push(p);
      else if (rec.kind === 'dimension') map.dims.push(p);
      else if (rec.kind === 'relationship') map.rels.push(p);
    }
    map.stats = { confirmed: map.confirmed, candidates: map.candidates, rejected: map.rejected, by_origin: map.by_origin };
    return map;
  }
  /** 地图 P/R：和人工标注的 gold 比（gold 是测试前写好的，不看题） */
  static scoreMap(actual, gold){
    const key = x => x.id || `${x.dataset || ''}.${x.field || x.keys || ''}`;
    const A = new Set((actual.metrics || []).concat(actual.dims || []).map(key));
    const G = new Set((gold.metrics || []).concat(gold.dims || []).map(key));
    const tp = [...A].filter(x => G.has(x)).length;
    return { tp, precision: A.size ? tp / A.size : null, recall: G.size ? tp / G.size : null, actual: A.size, gold: G.size, extra: [...A].filter(x => !G.has(x)), missing: [...G].filter(x => !A.has(x)) };
  }

  /** 给确认页 / CLI 的一行摘要：看得到候选、谁确认的、进了哪个地图版本 */
  snapshot(filter = {}){
    return {
      map_version: this.mapVersion,
      frozen: this.frozen,
      patches: this.list(filter).map(rec => {
        const h = this._head(rec);
        return {
          id: rec.id, kind: rec.kind, origin: rec.origin, status: h.status, version: rec.head,
          proposal: h.proposal, scope: rec.scope,
          decided_by: h.decided_by || null, decided_at: h.decided_at || null,
          decision_evidence: h.decision_evidence || null, map_version: h.map_version || null,
          verification: h.verification || null, reason: h.reason || null,
          reverted_by: h.reverted_by || null, reverted_at: h.reverted_at || null,
        };
      }),
      decisions: this.decisions.slice(),
      exported: (this.exported || []).map(p => ({ pack_id: p.pack_id, name: p.name, version: p.version, metrics: p.metrics, dims: p.dims, relationships: p.relationships, aliases: p.aliases })),
    };
  }

  provenance(id){
    const rec = this._get(id);
    return { id, kind: rec.kind, scope: rec.scope, origin: rec.origin, call_proof: rec.call_proof, head: rec.head, versions: rec.versions };
  }
  list(filter = {}){
    return this.order.map(id => this.patches.get(id)).filter(r => (!filter.status || this._head(r).status === filter.status) && (!filter.origin || r.origin === filter.origin));
  }
  _get(id){ const r = this.patches.get(id); if (!r) throw new PatchError('unknown_patch', `没有这条补丁：${id}`); return r; }
  // head 是版本号（1 起），versions 是数组（0 起）：统一从这里取当前版，避免差一错
  _head(rec){ return rec.versions[rec.head - 1]; }
}

const slug = (p, t, c) => p + '_' + String(t + '_' + c).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// 上层实测结果（worker.countGroups / CLI）→ 统一的两侧键统计形状。
// rows=null 表示没测到行数：不能据此推断唯一性，调用方会落到 unverified。
function measuredSide(m, cols){
  if (!m) return null;
  const rows = m.rows == null ? null : Number(m.rows);
  if (!Number.isFinite(rows) || rows < 0) return null;
  return { rows, keys: (cols || []).slice(), distinct: m.distinct == null ? null : Number(m.distinct),
    unique: m.unique !== false && (rows > 0), nullKeys: m.nullKeys == null ? null : Number(m.nullKeys),
    duplicates: Array.isArray(m.duplicates) ? m.duplicates.slice(0, 5) : [], measured: true };
}
// 列画像只能证明单列唯一（distinct >= rows）；复合键不能靠单列 distinct 推整组，返回 null。
function statsSide(t, cols){
  const st = (t && t.stats) || {}, c = st.cols || {};
  const rows = Number(st.rows);
  if (!Number.isFinite(rows) || rows <= 0) return null;
  if ((cols || []).length !== 1) return null;
  const d = c[cols[0]] && Number(c[cols[0]].distinct);
  if (!Number.isFinite(d)) return null;
  return { rows, keys: cols.slice(), distinct: d, unique: d >= rows, nullKeys: null, duplicates: [], from: 'stats' };
}

module.exports = { PatchStore, PatchError, ORIGINS, KINDS };
