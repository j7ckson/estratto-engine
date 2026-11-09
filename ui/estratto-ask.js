/* <estratto-ask> — 问数组件。纯 Web Component,无依赖,只访问 endpoint。 */
(() => {
  if (customElements.get('estratto-ask')) return;

  const T = {
    zh: {
      placeholder: '问一个关于你数据的问题,例如:上个月销售额是多少?',
      ask: '提问', cancel: '取消', running: '正在算…', copy: '复制答案', copied: '已复制',
      how: '怎么算的', noNotes: '这次没有额外的口径说明。', empty: '还没有提问。试着问一个问题,答案会出现在这里。',
      history: '最近的问题', clear: '清空', hint: 'Enter 提交,Shift+Enter 换行', label: '你的问题',
      confirmQ: '需要你确认一下', netErr: '连不上本机服务,请检查地址和令牌。', retry: '再试一次',
      badge: { verified: '已核', needs_confirm: '待确认', unverified: '未核', refused: '没答', no_data: '没数据', cancelled: '已取消', error: '出错' },
      explain: {
        verified: '数字已经在你的数据上重新算过一遍,结果一致。',
        needs_confirm: '有不止一种理解,选一个我再给你最终数字。',
        unverified: '给出了数字,但没能再核一遍,用之前请自己看一眼。',
        refused: '这个问题没有回答,原因见下方。',
        no_data: '你的数据里没有找到相关内容。',
        cancelled: '这次提问已经停掉了,没有结果。',
        error: '出了点问题,没能得到答案。'
      },
      noMetric: { badge: '缺指标', explain: '数据里还没有你问的这个指标，所以没有给数字。按下面的提示在口径里定义它，再问一次。' },
      rows: n => `共 ${n} 行`, answerCopy: '答案'
    },
    en: {
      placeholder: 'Ask a question about your data, e.g. What were sales last month?',
      ask: 'Ask', cancel: 'Cancel', running: 'Working…', copy: 'Copy answer', copied: 'Copied',
      how: 'How it was calculated', noNotes: 'No extra notes for this answer.', empty: 'No questions yet. Ask one and the answer shows up here.',
      history: 'Recent questions', clear: 'Clear', hint: 'Enter to send, Shift+Enter for a new line', label: 'Your question',
      confirmQ: 'Please confirm', netErr: 'Cannot reach the local service. Check the address and token.', retry: 'Try again',
      badge: { verified: 'Verified', needs_confirm: 'Needs confirmation', unverified: 'Not checked', refused: 'Not answered', no_data: 'No data', cancelled: 'Cancelled', error: 'Error' },
      explain: {
        verified: 'The number was recalculated on your data and matches.',
        needs_confirm: 'There is more than one reading. Pick one and you get the final number.',
        unverified: 'A number is given, but it could not be double-checked. Look it over before using it.',
        refused: 'This question was not answered. See the reason below.',
        no_data: 'Nothing relevant was found in your data.',
        cancelled: 'This question was stopped. There is no result.',
        error: 'Something went wrong and there is no answer.'
      },
      noMetric: { badge: 'No such metric', explain: 'The data has no such metric yet, so no number is given. Define it in the rules as suggested below, then ask again.' },
      rows: n => `${n} rows`, answerCopy: 'Answer'
    }
  };

  const CSS = `
:host([hidden]){display:none}
:host{
  --_brand:var(--estratto-brand,#0361ba);
  --_brand-ink:var(--estratto-brand-ink,#fff);
  --_bg:var(--estratto-bg,#f6f8fb);
  --_card:var(--estratto-card,#fff);
  --_text:var(--estratto-text,#17202b);
  --_muted:var(--estratto-muted,#5b6776);
  --_line:var(--estratto-line,#dde3ea);
  --_ok:var(--estratto-ok,#17794a);   --_ok-bg:var(--estratto-ok-bg,#e4f4ec);
  --_warn:var(--estratto-warn,#8a5a00); --_warn-bg:var(--estratto-warn-bg,#fcf0d2);
  --_bad:var(--estratto-bad,#b3261e);  --_bad-bg:var(--estratto-bad-bg,#fbe6e4);
  --_neutral:var(--estratto-neutral,#4a5565); --_neutral-bg:var(--estratto-neutral-bg,#e9edf2);
  --_r-card:var(--estratto-radius-card,14px);
  --_r-input:var(--estratto-radius-input,9px);
  --_r-btn:var(--estratto-radius-button,8px);
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
    --_neutral:var(--estratto-neutral,#b4bfcc);--_neutral-bg:var(--estratto-neutral-bg,#252f3b);
  }
}
:host([theme="dark"]){
  --_brand:var(--estratto-brand,#4d9bef);--_brand-ink:var(--estratto-brand-ink,#06203d);
  --_bg:var(--estratto-bg,#10151c);--_card:var(--estratto-card,#19212b);--_text:var(--estratto-text,#e8edf3);
  --_muted:var(--estratto-muted,#9aa6b5);--_line:var(--estratto-line,#2c3745);
  --_ok:#62d29a;--_ok-bg:#14352a;--_warn:#f1c35a;--_warn-bg:#3a2f12;--_bad:#ff8f87;--_bad-bg:#3d1a18;--_neutral:#b4bfcc;--_neutral-bg:#252f3b;
}
*{box-sizing:border-box}
.wrap{background:var(--_bg);padding:16px;border-radius:var(--_r-card);display:flex;flex-direction:column;gap:14px;min-width:0}
.box{background:var(--_card);border:1px solid var(--_line);border-radius:var(--_r-card);padding:14px}
label.lbl{display:block;font-size:13px;color:var(--_muted);margin-bottom:6px}
textarea{width:100%;min-height:68px;resize:vertical;font:inherit;color:inherit;background:var(--_bg);border:1px solid var(--_line);border-radius:var(--_r-input);padding:10px 12px}
textarea::placeholder{color:var(--_muted)}
.bar{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
.hint{font-size:12.5px;color:var(--_muted);flex:1 1 140px}
button{font:inherit;cursor:pointer;border-radius:var(--_r-btn);padding:8px 16px;border:1px solid var(--_line);background:var(--_card);color:var(--_text);min-height:38px}
button:hover:not(:disabled){border-color:var(--_brand)}
button.primary{background:var(--_brand);border-color:var(--_brand);color:var(--_brand-ink);font-weight:600}
button.primary:hover:not(:disabled){filter:brightness(1.08)}
button.ghost{border-color:transparent;background:transparent;color:var(--_brand);padding:6px 8px;min-height:32px}
button:disabled{opacity:.55;cursor:not-allowed}
:is(button,textarea,summary,a):focus-visible{outline:2px solid var(--_brand);outline-offset:2px}
.status{display:flex;align-items:center;gap:8px;color:var(--_muted)}
.spin{width:16px;height:16px;border:2px solid var(--_line);border-top-color:var(--_brand);border-radius:50%;animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
.q{font-size:13.5px;color:var(--_muted);margin:0 0 10px;overflow-wrap:anywhere}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;padding:2px 10px;border-radius:999px;background:var(--_neutral-bg);color:var(--_neutral)}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.badge.verified{background:var(--_ok-bg);color:var(--_ok)}
.badge.needs_confirm,.badge.unverified{background:var(--_warn-bg);color:var(--_warn)}
.badge.refused,.badge.error{background:var(--_bad-bg);color:var(--_bad)}
.why{font-size:13.5px;color:var(--_muted);margin:0 0 12px}
.big{font-size:clamp(30px,8vw,44px);font-weight:700;letter-spacing:-.01em;line-height:1.15;margin:4px 0 2px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.big small{font-size:.45em;font-weight:500;color:var(--_muted);margin-left:6px}
.line{margin:6px 0 0;overflow-wrap:anywhere}
.tw{overflow-x:auto;border:1px solid var(--_line);border-radius:var(--_r-input);margin-top:6px}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{padding:7px 12px;border-bottom:1px solid var(--_line);text-align:left;white-space:nowrap}
th{background:var(--_bg);font-weight:600;color:var(--_muted);font-size:13px}
td.n,th.n{text-align:right}
tr:last-child td{border-bottom:0}
.meta{font-size:12.5px;color:var(--_muted);margin:6px 0 0}
details{margin-top:12px;border-top:1px solid var(--_line);padding-top:8px}
summary{cursor:pointer;color:var(--_brand);font-weight:600;border-radius:6px;padding:2px 0}
ul.notes{margin:8px 0 0;padding-left:20px;color:var(--_text)}
ul.notes li{margin:3px 0;overflow-wrap:anywhere}
.opts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.opts button{text-align:left;white-space:normal}
.acts{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.err{color:var(--_bad)}
.hist h3{font-size:13px;margin:0 0 6px;color:var(--_muted);font-weight:600;display:flex;align-items:center;justify-content:space-between}
.hist ul{list-style:none;margin:0;padding:0}
.hist li button{width:100%;text-align:left;border:0;border-bottom:1px solid var(--_line);border-radius:0;background:transparent;display:flex;gap:10px;align-items:baseline;padding:8px 2px}
.hist li:last-child button{border-bottom:0}
.hist .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hist .b{font-size:12px;color:var(--_muted);flex:none}
.empty{text-align:center;color:var(--_muted);padding:22px 8px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
`;

  // Latin/digit next to a CJK character gets a space ("orders 表的 amount 列求和"); applied to generated wording only
  const cjkSpace = s => String(s ?? '').replace(/([A-Za-z0-9_])([\u4e00-\u9fff])/g, '$1 $2').replace(/([\u4e00-\u9fff])([A-Za-z0-9_])/g, '$1 $2');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = v => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v.replace(/,/g, ''))));
  const fmt = v => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('zh-CN') : v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    return String(v);
  };

  /* facts 的真实形状:[{id,label,value,unit,display,status,period,source:{table,field}}] */
  const factVal = f => (f.display != null && f.display !== '') ? String(f.display) : fmt(f.value);
  const periodText = p => !p ? '' : typeof p === 'string' ? p : (p.label || p.period || [p.from || p.start, p.to || p.end].filter(Boolean).join(' ~ ') || p.month || '');
  function shape(facts) {
    const fs = (Array.isArray(facts) ? facts : []).filter(f => f && typeof f === 'object' && (f.value != null || f.display != null));
    if (!fs.length) return null;
    if (fs.length === 1) return { kind: 'number', f: fs[0] };
    return { kind: 'table', facts: fs };
  }
  const stripTag = x => String(x).replace(/（F\d+）|\(F\d+\)|\[F\d+\]/g, '').trim();
  function notesOf(r) {
    const out = [];
    const lines = String(r.answer || '').split(/\n+/).map(stripTag).filter(Boolean);
    lines.forEach((l, i) => { if (i === 0 && /^ANSWER\s*[:：]/i.test(l)) return; if (/^ANSWER\s*[:：]/i.test(l)) return; out.push(l.replace(/^[-•*]\s*/, '')); });
    (Array.isArray(r.facts) ? r.facts : []).forEach(f => {
      const bits = [];
      if (f.source?.table) bits.push(`${f.source.table}${f.source.field ? '.' + f.source.field : ''}`);
      const p = periodText(f.period); if (p) bits.push(p);
      if (bits.length) out.push(`${f.label || ''}${f.label ? ':' : ''}${bits.join(' · ')}`);
    });
    if (r.meta?.anchor) out.push(`@anchor ${r.meta.anchor}`);
    return [...new Set(out)];
  }
  const lineOf = r => stripTag(String(r.answerLine || '').replace(/^\s*ANSWER\s*[:：]\s*/i, ''));

  class EstrattoAsk extends HTMLElement {
    static get observedAttributes() { return ['lang']; }
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._hist = []; this._cur = null; this._busy = false; this._rid = null; this._err = null; this._lastQ = '';
    }
    get lang() { return (this.getAttribute('lang') || 'zh').startsWith('en') ? 'en' : 'zh'; }
    get t() { return T[this.lang]; }
    connectedCallback() { this._build(); }
    attributeChangedCallback() { if (this.isConnected) this._build(); }

    async _api(method, path, body, signal) {
      const base = (this.getAttribute('endpoint') || '').replace(/\/$/, '');
      const headers = { 'X-Estratto-Token': this.getAttribute('token') || '' };
      const ot = this.getAttribute('owner-token'); if (ot) headers['X-Estratto-Owner'] = ot;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
      let data = null; try { data = await res.json(); } catch { /* empty */ }
      if (!res.ok) { const e = new Error((data && (data.error?.message || (typeof data.error === 'string' ? data.error : null) || data.message)) || ('HTTP ' + res.status)); e.status = res.status; e.data = data; e.code = data?.error?.code; throw e; }
      return data;
    }

    _build() {
      const t = this.t;
      const keep = this.shadowRoot.querySelector('textarea')?.value || '';
      this.shadowRoot.innerHTML = `<style>${CSS}</style>
<div class="wrap" part="root">
  <div class="box">
    <label class="lbl" for="q">${esc(t.label)}</label>
    <textarea id="q" rows="2" placeholder="${esc(t.placeholder)}" aria-describedby="hint"></textarea>
    <div class="bar">
      <span class="hint" id="hint">${esc(t.hint)}</span>
      <button class="primary" id="go" type="button">${esc(t.ask)}</button>
      <button id="stop" type="button" hidden>${esc(t.cancel)}</button>
    </div>
  </div>
  <div id="out" aria-live="polite" aria-atomic="true"></div>
  <div class="box hist" id="hist" hidden></div>
</div>`;
      const $ = s => this.shadowRoot.querySelector(s);
      this._q = $('#q'); this._q.value = keep;
      $('#go').onclick = () => this.ask();
      $('#stop').onclick = () => this.cancel();
      this._q.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.ask(); }
      });
      this._render();
    }

    /* 公开方法 */
    async ask(question) {
      const q = (question ?? this._q.value).trim();
      if (!q || this._busy) return;
      if (question) this._q.value = question;
      this._lastQ = q; this._busy = true; this._err = null; this._cur = null;
      this._rid = (crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now() + Math.random().toString(16).slice(2));
      this._render();
      try {
        const r = await this._api('POST', '/api/ask', { question: q, requestId: this._rid });
        this._rid = r.requestId || this._rid;
        this._busy = false;
        this._setResult(q, r);
        this._emit('estratto-answer', { question: q, result: r });
      } catch (e) { this._fail(e); }
    }
    async cancel() {
      if (!this._busy || !this._rid) return;
      try { await this._api('POST', '/api/cancel', { requestId: this._rid }); } catch { /* the ask call will report */ }
    }
    async confirm(choice) {
      const cur = this._cur; if (!cur || this._busy) return;
      this._busy = true; this._render();
      try {
        const r = await this._api('POST', '/api/confirm', { requestId: cur.result.requestId || this._rid, choice });
        this._busy = false;
        this._setResult(cur.q, r, true);
        this._emit('estratto-confirmed', { question: cur.q, choice, result: r });
      } catch (e) { this._fail(e); }
    }

    _setResult(q, r, replace) {
      this._cur = { q, result: r };
      if (replace) { const i = this._hist.findIndex(h => h.q === q && h.result.status === 'needs_confirm'); if (i >= 0) this._hist.splice(i, 1); }
      this._hist.unshift({ q, result: r }); this._hist = this._hist.slice(0, 10);
      this._render();
    }
    _fail(e) {
      this._busy = false;
      if (e.name === 'AbortError') return;
      const net = e instanceof TypeError;
      this._err = net ? this.t.netErr : (e.message || String(e));
      this._render();
      this._emit('estratto-error', { question: this._lastQ, message: this._err, status: e.status || null, error: e });
    }
    _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true })); }

    _answerText(r) {
      const parts = [this._line(r)];
      const s = shape(r.facts);
      if (s?.kind === 'table') parts.push(...s.facts.map(f => [f.label, factVal(f) + (f.unit || ''), periodText(f.period)].filter(Boolean).join('\t')));
      return parts.filter(Boolean).join('\n');
    }

    _render() {
      if (!this.shadowRoot.querySelector('#out')) return;
      const t = this.t, $ = s => this.shadowRoot.querySelector(s), out = $('#out');
      $('#go').disabled = this._busy; $('#stop').hidden = !this._busy; this._q.disabled = this._busy;
      let h = '';
      if (this._busy) {
        h = `<div class="box status" role="status"><span class="spin" aria-hidden="true"></span>${esc(t.running)}</div>`;
      } else if (this._err) {
        h = `<div class="box"><p class="err" role="alert" style="margin:0 0 10px">${esc(this._err)}</p><button id="retry" type="button">${esc(t.retry)}</button></div>`;
      } else if (this._cur) h = this._card(this._cur);
      else h = `<div class="box empty">${esc(t.empty)}</div>`;
      out.innerHTML = h;
      const retry = $('#retry'); if (retry) retry.onclick = () => this.ask(this._lastQ);
      out.querySelectorAll('[data-choice]').forEach(b => b.onclick = () => this.confirm(JSON.parse(b.dataset.choice)));
      const cp = $('#copy'); if (cp) cp.onclick = async () => {
        try { await navigator.clipboard.writeText(this._answerText(this._cur.result)); cp.textContent = t.copied; setTimeout(() => { cp.textContent = t.copy; }, 1500); } catch { /* clipboard blocked */ }
      };
      const hist = $('#hist');
      hist.hidden = this._hist.length < 1;
      hist.innerHTML = this._hist.length ? `<h3><span>${esc(t.history)}</span><button class="ghost" id="clr" type="button">${esc(t.clear)}</button></h3><ul>${this._hist.map((x, i) =>
        `<li><button type="button" data-i="${i}"><span class="t">${esc(x.q)}</span><span class="b">${esc(t.badge[x.result.status] || x.result.status)}</span></button></li>`).join('')}</ul>` : '';
      hist.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { this._cur = this._hist[+b.dataset.i]; this._err = null; this._render(); });
      const clr = $('#clr'); if (clr) clr.onclick = () => { this._hist = []; this._render(); };
    }

    _line(r) {
      const rf = r.refusal;
      if (rf?.code === 'daily_budget_exceeded') return this.lang === 'zh'
        ? `今天的模型花费已到上限(已花 ${Number(rf.spentUSD ?? 0).toFixed(2)} / 上限 ${Number(rf.limitUSD ?? 0).toFixed(2)} 美元),明天自动恢复;已复用过的问题照常能答。`
        : `Today's model spend has hit the cap ($${Number(rf.spentUSD ?? 0).toFixed(2)} of $${Number(rf.limitUSD ?? 0).toFixed(2)}). It resets tomorrow; questions answered before still work.`;
      if (rf?.code === 'outbound_blocked') return (this.lang === 'zh' ? '为了保护隐私,这次没有把问题发给模型。' : 'To protect your data, this question was not sent to the model.') + (rf.reason ? ' ' + rf.reason : '');
      return lineOf(r) || (r.confirm?.message || '');
    }
    _card({ q, result: r }) {
      const t = this.t, st = t.badge[r.status] ? r.status : 'error';
      const noMetric = r.status === 'needs_confirm' && r.confirm?.kind === 'no_such_metric';
      const s = shape(r.facts), notes = notesOf(r).map(n => n.startsWith('@anchor ') ? (this.lang === 'zh' ? '“今天”按 ' : '"Today" is taken as ') + n.slice(8) : (this.lang === 'zh' ? cjkSpace(n) : n));
      const owner = !!this.getAttribute('owner-token');
      let body = '';
      const showData = (r.status === 'verified' || r.status === 'unverified');
      if (showData && s?.kind === 'number') {
        const f = s.f;
        body += `<div class="big">${esc(factVal(f))}${f.unit && !String(factVal(f)).includes(f.unit) ? `<small>${esc(f.unit)}</small>` : ''}</div>`;
        const p = periodText(f.period); const lab = [f.label, p].filter(Boolean).join(' · ');
        if (lab) body += `<div class="meta">${esc(lab)}</div>`;
      } else if (showData && s?.kind === 'table') {
        const hasP = s.facts.some(f => periodText(f.period));
        body += `<div class="tw"><table><thead><tr><th scope="col">${esc(this.lang === 'zh' ? '项目' : 'Item')}</th>${hasP ? `<th scope="col">${esc(this.lang === 'zh' ? '时间' : 'Period')}</th>` : ''}<th scope="col" class="n">${esc(this.lang === 'zh' ? '数值' : 'Value')}</th></tr></thead><tbody>${
          s.facts.map(f => `<tr><td>${esc(f.label || f.id || '')}</td>${hasP ? `<td>${esc(periodText(f.period))}</td>` : ''}<td class="n">${esc(factVal(f))}${f.unit && !String(factVal(f)).includes(f.unit) ? ' ' + esc(f.unit) : ''}</td></tr>`).join('')}</tbody></table></div><div class="meta">${esc(t.rows(s.facts.length))}</div>`;
      }
      const line = this._line(r);
      if (line) body += `<p class="line">${esc(line)}</p>`;
      if (r.status === 'needs_confirm' && r.confirm) {
        const c = r.confirm, opts = c.options || [];
        if (c.message && c.message !== line) body += `<p class="line" style="font-weight:600">${esc(c.message)}</p>`;
        let ownerNote = false;
        const btns = opts.map((o, i) => {
          const obj = (o && typeof o === 'object') ? o : { value: o };
          const isAccept = obj.id === 'accept';
          let lab = obj.label || obj.text || obj.name || (isAccept ? (obj.message || (this.lang === 'zh' ? '确认,按这个来' : 'Confirm and use this')) : obj.value ?? obj.id ?? ('#' + (i + 1)));
          if (!isAccept && obj.table && obj.column && !obj.label) lab = `${lab}(${obj.table}.${obj.column})`;
          const val = isAccept ? 'accept' : (obj.id ?? obj.value ?? i);
          if (isAccept && !owner) { ownerNote = true; return ''; }
          return `<button type="button" data-choice='${esc(JSON.stringify(val))}'>${esc(lab)}</button>`;
        }).join('');
        body += `<div class="opts">${btns}</div>`;
        if (ownerNote) body += `<p class="meta">${esc(this.lang === 'zh' ? '需要口径负责人确认' : 'The definitions owner needs to confirm this')}</p>`;
      }
      const showNotes = showData && notes.length;
      const det = showData ? `<details><summary>${esc(t.how)}</summary>${notes.length ? `<ul class="notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : `<p class="meta">${esc(t.noNotes)}</p>`}</details>` : '';
      const copy = showData && (line || s) ? `<div class="acts"><button id="copy" type="button">${esc(t.copy)}</button></div>` : '';
      return `<div class="box" part="card"><p class="q">${esc(q)}</p><div class="head"><span class="badge ${st}">${esc(noMetric ? t.noMetric.badge : t.badge[st])}</span></div><p class="why">${esc(noMetric ? t.noMetric.explain : t.explain[st])}</p>${body}${det}${copy}</div>`;
    }
  }
  customElements.define('estratto-ask', EstrattoAsk);
})();
