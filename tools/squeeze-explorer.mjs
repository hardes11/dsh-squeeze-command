// squeeze-explorer — interactive before/after map of /squeeze checkpoints in a
// session log. Read-only over session.jsonl.zstd; emits a self-contained HTML.
// Usage: node squeeze-explorer.mjs <session.jsonl.zstd> [--out file]
//        node squeeze-explorer.mjs --demo [--out file]   (synthetic data, no real content)
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const args = process.argv.slice(2)
const demo = args.includes('--demo')
const outIdx = args.indexOf('--out')
const out = outIdx >= 0 ? args[outIdx + 1] : '/tmp/squeeze-explorer.html'
const dir = demo ? null : args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out')

// Seeded PRNG so the demo is byte-for-byte reproducible (README screenshots).
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

function demoEvents() {
  const rand = mulberry32(20260905)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  const events = []
  const spans = [[10,3564],[3666,10872],[11194,24673],[24681,40581],[50115,56634],[56642,61889],[61897,72549],[94254,103121],[9,44039],[44256,46153],[46161,48302],[48310,76140],[76148,86094],[86102,90335]]
  const sums = [
    'Diagnosed the Aurora gateway memory growth: heap snapshots across three deploys show the worker pool retaining evicted connections. Traced to src/workers/pool.ts:82 where release() is skipped when eviction races a pending health check. Decision: fix in-place, no pool rewrite. Load-test harness extended to hold 4x traffic for 20 minutes.',
    'Implemented the pool release fix: eviction now queues release after in-flight health checks drain (src/workers/pool.ts, pool.test.ts). All 214 worker tests pass; the leak no longer reproduces under the 20-minute 4x run (RSS flat at 480 MB vs 2.1 GB before). Decision: keep the release path synchronous for sockets, async for timers.',
    'Load-test matrix completed across cpu profiles: the fix holds at 4x traffic on all three profiles. One regression found and fixed: pool.shutdown() now waits for queued releases (src/workers/pool.ts:140). Benchmark comparison table recorded in docs/bench-2026-09.md.',
    'Code review round 1: addressed naming and the double-checked lock in acquire(). Reviewer concern about thundering herd on release resolved with a small backoff. Docs updated (README worker-pool section). Decision: one more review pass before merge.',
    'Rollout planning: canary at 5% for two hours, then 50/50. Alert thresholds set for RSS > 900 MB and evictions/min > 40. Runbook drafted in docs/runbook.md with rollback to previous gateway image.',
    'Canary deployed and monitored: RSS stable at 470-510 MB across 6 hours at 5%. No alert fired. Two benign warnings triaged (clock skew on node-3, duplicate metrics tag). Decision: proceed to 50/50 tomorrow morning.',
    '50/50 rollout completed overnight: error budget untouched, p99 latency improved 3 ms (fewer GC pauses). One node recycled by autoscaler and rejoined cleanly. Rollback criteria never approached.',
    'Release wrap-up: gateway 2.4.1 shipped with the pool fix. Postmortem drafted (docs/postmortems/pool-leak.md) blaming the missing drain-on-eviction for the original leak. Follow-up filed to add regression test on shutdown path.',
    'Upstream dependency audit: upgraded the connection library two minors; one breaking change (callback removed) adapted in three call sites. Fuzzed the pool for 30 minutes with zero assertion failures.',
    'Observability additions: pool metrics exported (active, evicting, queued-release) and a dashboard panel committed. Alert on queued-release > 5 sustained 5 minutes, tuned with the canary data.',
    'Test hardening: added property tests for release ordering and a stress test simulating eviction storms. CI runtime impact acceptable (+40 s). Flaky clock-dependent test made deterministic with injected timers.',
    'Docs and examples: worker-pool usage guide written, two examples added (basic, storm-resistant). Changelog updated for 2.4.1. Migration notes cover the config rename pool.maxIdle -> pool.maxEvictable.',
    'Cleanup pass: dead code removed from the legacy pool path, feature flag deleted after full rollout confirmed. Bundle size down 4 KB. One TODO resolved (socket vs timer release asymmetry now documented).',
    'Session close-out: gateway 2.4.1 fully rolled out and stable for 48 h. Postmortem merged, follow-up shipped. Working tree clean; branch deleted after merge.',
  ]
  const userT = ['Why does the worker pool grow after every deploy?','Run the load test again with 4x traffic','Ship it if the canary holds tonight','What is eating memory on node-3 specifically?','Add the dashboard panel before the 50/50','Do we need a rollback plan first?','Good — proceed to 50/50 tomorrow','Keep the postmortem blameless','Can we delete the feature flag now?','Summarize where the leak was, one paragraph']
  const asstT = ['Traced the leak to src/workers/pool.ts:82 — evicted workers are never released when a health check is pending. Fix: queue the release after the check drains.','214/214 worker tests pass. RSS flat at 480 MB over the 20-minute 4x run (was 2.1 GB before the fix).','Canary stable: RSS 470-510 MB over 6 hours at 5%, no alerts. Two benign warnings triaged and documented.','p99 improved 3 ms — fewer GC pauses. Rollback criteria never approached during the overnight 50/50.','Postmortem drafted at docs/postmortems/pool-leak.md; root cause is the missing drain-on-eviction. Follow-up adds a regression test on shutdown.','Pool metrics now exported: active, evicting, queued-release. Alert tuned with canary data (5 sustained 5 minutes).']
  const toolT = ['ok 214 tests passed (pool.test.ts)','src/workers/pool.ts | 82 +/- 14 lines changed','HTTP 200 — canary metrics scraped (6h window)','rss_mb: 480 480 482 479 481 483 (stable)','bundle size: 4.1 KB smaller after cleanup','docs/runbook.md written (3 sections)','property tests: 1000 cases, 0 failures','git: branch pool-leak-fix merged, deleted']
  let clock = 1788000000000
  const pushMsg = (seq, kind) => {
    clock += 60000 + Math.floor(rand() * 240000)
    const text = kind === 'user' ? pick(userT) : kind === 'assistant' ? pick(asstT) : pick(toolT)
    const content = kind === 'tool-result'
      ? [{ type: 'tool-result', content: [{ type: 'text', text }] }]
      : [{ type: 'text', text }]
    events.push({ type: kind === 'assistant' ? 'assistant/message' : kind === 'tool-result' ? 'tool/result' : 'user/message',
      seq, time: clock, data: { content } })
  }
  // messages inside every span
  for (const [a, b] of spans) {
    const n = Math.max(8, Math.floor((b - a) / 110))
    for (let i = 0; i < n; i++) {
      const seq = a + Math.floor((i + 0.5) * (b - a) / n)
      const r = rand()
      pushMsg(seq, r < 0.15 ? 'user' : r < 0.5 ? 'assistant' : 'tool-result')
    }
  }
  // live tail after the last span
  for (let seq = 103500; seq < 119900; seq += 300 + Math.floor(rand() * 700)) {
    const r = rand()
    pushMsg(seq, r < 0.25 ? 'user' : r < 0.6 ? 'assistant' : 'tool-result')
  }
  // checkpoint commits: 8 (pass 1) then 6 (pass 2), ascending seqs after the ranges
  let commitSeq = 103200
  spans.forEach((sp, i) => {
    const [a, b] = sp
    const shadowedSeqs = []
    for (let q = a; q <= b; q += 60) shadowedSeqs.push(q) // sampled seqs (shape only)
    events.push({ type: 'compaction/summary', seq: commitSeq, time: clock,
      data: { shadowedRange: { start: a, end: b }, shadowedSeqs,
        shadowedTokenCount: Math.floor((b - a) * 0.42),
        summary: [{ type: 'text', text: sums[i] }],
        model: 'demo-flash' } })
    events.push({ type: 'user/message', seq: commitSeq + 1, time: clock,
      surfaceOp: { op: 'replace', start: a, end: b },
      data: { content: [{ type: 'text', text: sums[i] }] } })
    commitSeq += 2
  })
  const endStates = ['Span end-state: leak diagnosis COMPLETED; fix NOT STARTED.',
    'Span end-state: pool fix COMPLETED (tests green); review PENDING.',
    'Span end-state: load-test matrix COMPLETED; one regression FIXED.',
    'Span end-state: review round 1 COMPLETED; second pass PENDING.',
    'Span end-state: rollout plan COMPLETED; canary NOT STARTED.',
    'Span end-state: canary COMPLETED (stable); 50/50 PENDING.',
    'Span end-state: 50/50 rollout COMPLETED; wrap-up PENDING.',
    'Span end-state: release 2.4.1 SHIPPED; postmortem merged.',
    'Span end-state: dependency audit COMPLETED; zero failures.',
    'Span end-state: observability additions COMPLETED.',
    'Span end-state: test hardening COMPLETED (+40s CI accepted).',
    'Span end-state: docs and examples COMPLETED.',
    'Span end-state: cleanup pass COMPLETED; flag removed.',
    'Span end-state: session close-out COMPLETED.']
  events.forEach((e) => { if (e.type === 'compaction/summary') {
    const i = spans.findIndex((sp) => sp[0] === e.data.shadowedRange.start)
    if (i >= 0) e.data.summary[0].text = sums[i] + '\n' + endStates[i]
  } })
  events.sort((x, y) => x.seq - y.seq)
  return events
}

const txt = demo ? null : execSync(`zstd -dc "${dir}"`, { maxBuffer: 1 << 30 }).toString('utf8')

const brackets = [], events = []
const textOf = (e) => {
  const c = e?.data?.message?.content ?? e?.data?.content
  if (!Array.isArray(c)) return ''
  return c.map((p) => p?.text ?? (p?.type === 'tool-result'
    ? (typeof p.content === 'string' ? p.content : (p.content ?? []).map((q) => q?.text ?? '').join(' '))
    : '')).join('\n')
}
const kindOf = (e) => e?.type === 'user/message' ? 'user' : e?.type === 'assistant/message' ? 'assistant' : e?.type === 'tool/result' ? 'tool-result' : 'other'
const sourceEvents = demo ? demoEvents() : txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
for (const e of sourceEvents) {
  events.push(e)
  if (e.type === 'compaction/summary' && e.data?.shadowedRange) {
    brackets.push({ commitSeq: e.seq, time: e.time,
      start: e.data.shadowedRange.start, end: e.data.shadowedRange.end,
      n: e.data.shadowedSeqs?.length ?? 0, tokens: e.data.shadowedTokenCount ?? 0,
      sum: (e.data.summary?.[0]?.text ?? '').slice(0, 1200),
      model: e.data.model })
  }
}
brackets.sort((a, b) => a.commitSeq - b.commitSeq)
const lastSeq = Math.max(...events.map(e => e.seq ?? 0))
const evBySeq = new Map(events.map(e => [e.seq, e]))
for (const b of brackets) {
  b.originals = []
  for (const s of (evBySeq.get(b.commitSeq)?.data?.shadowedSeqs ?? [])) {
    const e = evBySeq.get(s); if (!e) continue
    const t = textOf(e).trim(); if (!t) continue
    b.originals.push({ kind: kindOf(e), seq: s, text: t.slice(0, 700) + (t.length > 700 ? '\n… [truncated — full text in the durable log]' : ''), chars: t.length })
  }
}
const NB = 120, bs = Math.ceil(lastSeq / NB)
const shadowOf = new Map()
brackets.forEach((b, i) => { for (let s = b.start; s <= b.end; s++) shadowOf.set(s, i) })
const counts = Array.from({ length: NB }, () => ({ live: 0, shadowed: 0 }))
for (const e of events) { const bi = Math.min(NB - 1, Math.floor((e.seq ?? 0) / bs)); if (shadowOf.has(e.seq ?? 0)) counts[bi].shadowed++; else counts[bi].live++ }

const allMsgs = []
for (const e of events) {
  const kind = kindOf(e)
  if (kind === 'other') continue // skip stream chunks, hooks, steps — not transcript messages
  const t = textOf(e).trim()
  if (!t) continue
  const cap = kind === 'tool-result' ? 200 : 500
  allMsgs.push({ seq: e.seq, kind, text: t.slice(0, cap) + (t.length > cap ? '\n… [truncated — ' + t.length + ' chars total]' : ''), chars: t.length })
}
allMsgs.sort((a, b) => a.seq - b.seq)
// ── surface replay: what the agent saw after each squeeze pass ──────────────
const commitOrder = [...brackets] // already sorted by commitSeq
const isMsg = (e) => ['user/message', 'assistant/message', 'tool/result'].includes(e?.type)
const msgByText = new Map(allMsgs.map((m) => [m.seq, m]))
const checkpointAt = new Map() // checkpoint message seq -> bracket
const versions = [{ label: 'original — before any squeeze', seqs: null }]
let surface = [], k = 0
for (const e of events) {
  if (isMsg(e)) {
    const op = e?.data?.message ? undefined : e?.surfaceOp
    const realOp = e?.surfaceOp ?? (e?.data?.surfaceOp)
    if (e.type === 'user/message' && realOp?.op === 'replace') {
      // remove shadowed seqs, insert the checkpoint message at that position
      const start = realOp.start, end = realOp.end
      const idx = surface.indexOf(start)
      const cut = surface.filter((q) => q < start || q > end)
      const at = idx >= 0 ? cut.indexOf(surface[Math.max(0, idx - 1)]) + 1 : cut.length
      surface = cut; surface.push(e.seq)
      const b = commitOrder[k]; k++
      if (b) checkpointAt.set(e.seq, commitOrder.indexOf(b))
      if (k === 8 || k === commitOrder.length) versions.push({ label: 'after pass ' + (k === 8 ? 1 : 2), seqs: null, _snap: [...surface] })
      continue
    }
    if (msgByText.has(e.seq)) surface.push(e.seq)
  }
}
versions[0]._snap = [...surface].length ? versions[0]._snap : null
// recompute cleanly: version 0 = surface before first replace; redo replay capturing that too
surface = []; k = 0
const snaps = []
let before = true
for (const e of events) {
  if (isMsg(e)) {
    const realOp = e?.surfaceOp ?? (e?.data?.surfaceOp)
    if (e.type === 'user/message' && realOp?.op === 'replace') {
      if (before) { versions[0]._snap = [...surface]; before = false }
      const start = realOp.start, end = realOp.end
      surface = surface.filter((q) => q < start || q > end)
      surface.push(e.seq)
      const b = commitOrder[k]; k++
      if (b) checkpointAt.set(e.seq, commitOrder.indexOf(b))
      if (k === 8 || k === commitOrder.length) { const v = versions.find((x) => x._snapLabel === undefined && x !== versions[0] && !x._snap); }
      if (k === 8) versions[1]._snap = [...surface]
      if (k === commitOrder.length) versions[versions.length - 1]._snap = [...surface]
      continue
    }
    if (msgByText.has(e.seq)) surface.push(e.seq)
  }
}
versions.push({ label: 'current surface (now)', seqs: null, _snap: [...surface] })
const data = { lastSeq, totalEvents: events.length, brackets, buckets: counts, bucketSize: bs, allMsgs,
  versions: versions.map((v) => ({ label: v.label, seqs: v._snap ?? [] })), ckAt: Object.fromEntries(checkpointAt),
  title: demo ? 'Squeeze Explorer — demo session (synthetic data)' : 'Squeeze Explorer — ' + (dir.split('/').pop() || 'session') }
const html = `<!doctype html><html><head><meta charset="utf-8"><title>${data.title}</title>
<style>
 :root{--bg:#0b1220;--panel:#111a2e;--line:#1e293b;--txt:#e2e8f0;--dim:#7c8db0;--blue:#3b82f6;--red:#ef4444;--teal:#14b8a6;--amber:#f59e0b}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,sans-serif}
 header{padding:20px 28px;border-bottom:1px solid var(--line)} h1{margin:0;font-size:19px} .sub{color:var(--dim);margin-top:4px;font-size:13px}
 .layout{display:grid;grid-template-columns:1fr 6px 420px;gap:0;height:calc(100vh - 92px)}
 .left{padding:18px 24px;overflow:auto;min-width:280px}
 #split{cursor:col-resize;background:var(--line);position:relative}
 #split:hover,#split.drag{background:var(--blue)}
 #split::after{content:'';position:absolute;top:50%;left:1px;width:4px;height:34px;transform:translateY(-50%);border-radius:2px;background:#31415f}
 .right{overflow:auto;background:var(--panel);min-width:300px}
 h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:18px 0 8px}
 #strip{width:100%;height:96px;border:1px solid var(--line);border-radius:6px;position:relative;background:#0d1526}
 .lane{position:absolute;left:0;right:0;height:50%;display:flex;align-items:center}
 .lane label{width:64px;flex:none;font-size:10.5px;color:var(--dim);text-align:right;padding-right:8px;letter-spacing:.04em}
 .lanebox{position:relative;flex:1;height:30px;border-bottom:1px solid #020617;background:repeating-linear-gradient(90deg,transparent 0 calc(100%/12 - 1px),#1a2438 calc(100%/12 - 1px) calc(100%/12))}
 .seg{position:absolute;top:0;height:30px;cursor:pointer;transition:filter .15s;border-radius:3px;border:1px solid #020617;box-shadow:0 0 0 1px rgba(2,6,23,.35)} .seg:hover{filter:brightness(1.4)} .seg.sel{outline:2px solid #fff;z-index:2}
 #hist{width:100%;height:110px;display:flex;align-items:flex-end;gap:1px;margin-top:6px}
 .bcol{flex:1;height:100%;display:flex;flex-direction:column-reverse;gap:0;min-width:2px}
 .bl{background:var(--teal)} .bs{background:#4b628a}
 .legend{display:flex;gap:18px;color:var(--dim);font-size:12px;margin-top:10px}
 .sw{display:inline-block;width:12px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
 table{width:100%;border-collapse:collapse;font-size:12.5px} th{color:var(--dim);text-align:left;font-weight:500;padding:4px 8px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
 td{padding:5px 8px;border-bottom:1px solid #16203a;cursor:pointer;white-space:nowrap} tr:hover td{background:#16213c} tr.sel td{background:#1d2c52}
 .mono{font-family:ui-monospace,monospace}
 #detail{padding:20px 22px} .kv{display:grid;grid-template-columns:130px 1fr;gap:4px 10px;font-size:13px;margin:10px 0}
 .kv b{color:var(--dim);font-weight:500} .ratio{height:14px;background:#1a2438;border-radius:4px;overflow:hidden;margin:6px 0} .ratio>i{display:block;height:100%;background:linear-gradient(90deg,var(--amber),#f97316)}
 pre{white-space:pre-wrap;font:11.5px/1.55 ui-monospace,monospace;background:#0d1526;border:1px solid var(--line);border-radius:6px;padding:12px;color:#9fb4d8;max-height:44vh;overflow:auto}
 .empty{color:var(--dim);padding:30px 10px}
 .pass{font-size:10px;padding:1px 6px;border-radius:8px;vertical-align:1px} .p1{background:#1e3a8a} .p2{background:#7f1d1d}
</style></head><body>
<header><h1>${data.title}</h1>
<div class="sub" id="sub"></div></header>
<div class="layout" id="layout"><div class="left">
 <h2>Log timeline (0 → <span class="mono" id="ls"></span> seqs) — two lanes, one per squeeze pass; click a bar</h2>
 <div id="strip"></div>
 <div class="legend"><span><span class="sw" style="background:var(--blue)"></span>pass 1 span</span><span><span class="sw" style="background:var(--red)"></span>pass 2 span (re-split)</span><span>unmarked = still live</span></div>
 <h2>Event density per ~<span id="bsz"></span> seqs — <span class="sw" style="background:var(--teal)"></span>live on surface &nbsp;<span class="sw" style="background:#31415f"></span>shadowed by a checkpoint</h2>
 <div id="hist"></div>
 <h2>Checkpoints</h2>
 <table><thead><tr><th>#</th><th>pass</th><th>seq range</th><th>msgs</th><th>tokens shadowed</th><th>summary</th><th>kept</th></tr></thead><tbody id="rows"></tbody></table>
 <h2>Session history — as the agent saw it at each point in time</h2>
 <div id="vsel" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"></div>
 <div id="vstats" style="color:var(--dim);font-size:12px;margin-bottom:8px"></div>
 <details id="fullhist"><summary style="cursor:pointer;color:var(--dim);padding:6px 0">Expand the transcript for the selected version</summary><div id="fhbody"></div></details>
</div><div id="split" title="drag to resize"></div><div class="right"><div id="detail"><div class="empty">Select a checkpoint — lane bar or table row — to inspect it.</div></div></div></div>
<script>
const D = ${JSON.stringify(data).replace(/<\//g, '<\\/')};
const fmt = n => n.toLocaleString();
document.getElementById('sub').textContent = fmt(D.totalEvents)+' events in the durable log · '+D.brackets.length+' squeeze checkpoints · nothing deleted — only the model surface shrank';
document.getElementById('ls').textContent = fmt(D.lastSeq);
document.getElementById('bsz').textContent = fmt(D.bucketSize);
const strip = document.getElementById('strip');
['PASS 1','PASS 2'].forEach((name,li)=>{
 const lane=document.createElement('div');lane.className='lane';lane.style.top=(li*50)+'%';
 const lb=document.createElement('label');lb.textContent=name;lane.appendChild(lb);
 const box=document.createElement('div');box.className='lanebox';lane.appendChild(box);
 strip.appendChild(lane);
 D.brackets.forEach((b,i)=>{if((i<8)!==(li===0))return;const s=document.createElement('div');s.className='seg';
  s.style.left=(b.start/D.lastSeq*100)+'%';s.style.width=Math.max(0.35,(b.end-b.start)/D.lastSeq*100)+'%';
  s.style.background=li===0?'var(--blue)':'var(--red)';s.style.opacity='0.9';
  s.title='pass '+(li+1)+' · seq '+b.start.toLocaleString()+'–'+b.end.toLocaleString()+' · '+b.n+' msgs → 1 ckpt';s.onclick=()=>sel(i);box.appendChild(s)});
});
const hist=document.getElementById('hist'), maxC=Math.max(...D.buckets.map(b=>b.live+b.shadowed));
D.buckets.forEach(b=>{const c=document.createElement('div');c.className='bcol';c.title=b.live+' live · '+b.shadowed+' shadowed';
 const sh=document.createElement('div');sh.className='bs';sh.style.height=(b.shadowed/maxC*100)+'%';
 const lv=document.createElement('div');lv.className='bl';lv.style.height=(b.live/maxC*100)+'%';
 c.appendChild(sh);c.appendChild(lv);hist.appendChild(c)});
const tb=document.getElementById('rows');
D.brackets.forEach((b,i)=>{const tr=document.createElement('tr');const kept=b.tokens>0?Math.round(Math.min(100,b.sum.length*4/b.tokens*100)):0;
 tr.innerHTML='<td>'+(i+1)+'</td><td><span class="pass '+(i<8?'p1':'p2')+'">'+(i<8?'1':'2')+'</span></td><td class="mono">'+fmt(b.start)+'–'+fmt(b.end)+'</td><td>'+b.n+'→1</td><td>~'+fmt(b.tokens)+'</td><td>'+fmt(b.sum.length)+' ch</td><td>'+kept+'%</td>';
 tr.onclick=()=>sel(i);tb.appendChild(tr)});
function sel(i){setTimeout(()=>{const orig=document.getElementById('orig');if(!orig)return;
 const pill=document.createElement('div');pill.style.cssText='position:sticky;top:0;z-index:5;float:right;background:#1d2c52;border:1px solid var(--line);border-radius:12px;padding:2px 12px;font-size:11.5px;color:#fca5a5;font-family:ui-monospace,monospace';
 orig.parentNode.insertBefore(pill,orig);
 const rightPane=document.querySelector('.right');
 const rows=[...orig.querySelectorAll('details')];
 const upd=()=>{const mid=window.innerHeight*0.4;let vis=0;
  rows.forEach((r,ri)=>{if(r.getBoundingClientRect().top<=mid)vis=ri+1});
  pill.textContent=rows.length?('message '+fmt(vis)+' / '+fmt(rows.length)):''};
 rightPane.addEventListener('scroll',upd,{passive:true});upd()},0);
 document.querySelectorAll('.seg').forEach((s,j)=>s.classList.toggle('sel',j===i));
 document.querySelectorAll('#rows tr').forEach((r,j)=>r.classList.toggle('sel',j===i));
 const b=D.brackets[i],kept=b.tokens>0?Math.min(100,b.sum.length*4/b.tokens*100):0, d=new Date(b.time);
 const ckSeq=Number(Object.entries(D.ckAt).find(([sq,gi])=>gi===i)?.[0] ?? -1);
 const surfaceIdx=ckSeq>=0?D.versions[curV].seqs.indexOf(ckSeq)+1:null;
 document.getElementById('detail').innerHTML='<h2>Checkpoint '+(i+1)+' <span class="pass '+(i<8?'p1':'p2')+'">pass '+(i<8?'1':'2')+'</span>'+(surfaceIdx?' <span style="color:#7c8db0;font-size:11px">· surface item #'+surfaceIdx+' ('+D.versions[curV].label+')</span>':'')+'</h2>'+
 '<div class="kv"><b>seq range</b><span class="mono">'+fmt(b.start)+' – '+fmt(b.end)+' ('+fmt(b.end-b.start)+' seqs)</span>'+
 '<b>replaced</b><span>'+b.n+' messages → 1 checkpoint</span>'+
 '<b>tokens shadowed</b><span>~'+fmt(b.tokens)+'</span>'+
 '<b>summary size</b><span>'+fmt(b.sum.length)+' chars (~'+fmt(Math.round(b.sum.length/4))+' tokens est.)</span>'+
 '<b>committed</b><span>'+d.toLocaleString()+'</span>'+
 '<b>summarizer</b><span class="mono">'+b.model+'</span>'+
 '<b>committed at seq</b><span class="mono">'+fmt(b.commitSeq)+'</span></div>'+
 '<h2>Survival ratio (est. summary tokens / shadowed tokens)</h2>'+
 '<div class="ratio"><i style="width:'+kept.toFixed(1)+'%"></i></div>'+
 '<div style="color:var(--dim);font-size:12px">'+kept.toFixed(1)+'% of the shadowed token mass survives in the checkpoint — the rest is recoverable only from the durable log.</div>'+
 '<h2>Before vs after</h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
 '<div><h2 style="margin-top:0">Original — '+b.originals.length+' messages ('+fmt(b.originals.reduce((a,o)=>a+o.chars,0))+' chars)</h2><div id="orig">'+b.originals.slice().sort((x,y)=>x.seq-y.seq).map((o,oi,arr)=>'<details style="margin-bottom:6px"><summary style="cursor:pointer;color:'+(o.kind==='user'?'#f59e0b':o.kind==='assistant'?'#38bdf8':o.kind==='tool-result'?'#a78bfa':'#7c8db0')+'">'+fmt(oi+1)+'/'+fmt(arr.length)+' · '+o.kind+' · seq '+fmt(o.seq)+' · '+fmt(o.chars)+' ch</summary><pre style="max-height:300px;margin:6px 0 0">'+o.text.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</pre></details>').join('')+'</div></div>'+
 '<div><h2 style="margin-top:0">After — the checkpoint (1 message)</h2><pre style="max-height:70vh">'+b.sum.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</pre></div></div>';}
const fh=document.getElementById('fhbody'),vsel=document.getElementById('vsel'),vstats=document.getElementById('vstats');
const bySeq=new Map(D.allMsgs.map(m=>[m.seq,m]));
const ckEl=(seq,idx)=>{const gi=D.ckAt[seq];const b=D.brackets[gi];
 const d=document.createElement('details');d.style.margin='6px 0';d.dataset.idx=idx;
 d.style.borderLeft='3px solid '+(gi<8?'var(--blue)':'var(--red)');d.style.paddingLeft='8px';
 const sm=document.createElement('summary');sm.style.cssText='cursor:pointer;font-size:12px;color:'+(gi<8?'#93c5fd':'#fca5a5')+';font-weight:600';
 sm.textContent='#'+idx+' · ◆ CHECKPOINT '+(gi+1)+' (pass '+(gi<8?'1':'2')+') · stands in for '+b.n+' original messages · ~'+fmt(b.tokens)+' tok';
 d.appendChild(sm);
 const pre=document.createElement('pre');pre.style.cssText='max-height:300px;margin:6px 0 0';pre.textContent=b.sum;
 d.appendChild(pre);return d};
const msgEl2=(o,idx)=>{const d=document.createElement('details');d.style.marginBottom='4px';d.dataset.idx=idx;
 const sm=document.createElement('summary');sm.style.cssText='cursor:pointer;font-size:11.5px;color:'+(o.kind==='user'?'#f59e0b':o.kind==='assistant'?'#38bdf8':o.kind==='tool-result'?'#a78bfa':'#7c8db0');
 sm.textContent='#'+idx+' · '+o.kind+' · seq '+fmt(o.seq)+' · '+fmt(o.chars)+' ch';
 d.appendChild(sm);
 const pre=document.createElement('pre');pre.style.cssText='max-height:260px;margin:6px 0 0';pre.textContent=o.text;
 d.appendChild(pre);return d};
let curV=0;
D.versions.forEach((v,i)=>{const btn=document.createElement('button');btn.textContent=v.label;
 btn.style.cssText='padding:5px 12px;border-radius:6px;border:1px solid var(--line);background:'+(i===0?'transparent':'transparent')+';color:'+(i===D.versions.length-1?'#5eead4':'#c7d2fe')+';cursor:pointer;font-size:12.5px';
 btn.onclick=()=>{curV=i;renderV();document.querySelectorAll('#vsel button').forEach((b,j)=>b.style.background=j===i?'#1d2c52':'transparent')};
 vsel.appendChild(btn)});
function renderV(){fh.innerHTML='';const v=D.versions[curV];
 let msgs=0,est=0,idx=0;
 for(const seq of v.seqs){idx++;if(D.ckAt[seq]!==undefined){const b=D.brackets[D.ckAt[seq]];msgs++;est+=b.sum.length/4;fh.appendChild(ckEl(seq,idx))}
  else{const m=bySeq.get(seq);if(m){msgs++;est+=m.chars/4;fh.appendChild(msgEl2(m,idx))}}}
 vstats.textContent=v.label+' · '+fmt(msgs)+' items on the surface · ~'+fmt(Math.round(est))+' tokens est. — this is the working set the model actually received';}
renderV();
const pill=document.createElement('div');pill.style.cssText='position:sticky;top:0;z-index:5;float:right;background:#1d2c52;border:1px solid var(--line);border-radius:12px;padding:2px 12px;font-size:11.5px;color:#93c5fd;font-family:ui-monospace,monospace';
fh.parentNode.insertBefore(pill,fh);
const leftPane=document.querySelector('.left');
const upd=()=>{const r=fh.getBoundingClientRect();const rows=[...fh.children];
 const mid=window.innerHeight*0.4;let vis=0;
 for(let i=0;i<rows.length;i++){const rr=rows[i].getBoundingClientRect();if(rr.top<=mid)vis=Math.max(vis,+rows[i].dataset.idx||0)}
 const tot=rows.length?+(rows[rows.length-1].dataset.idx||0):0;
 pill.textContent=tot?('item '+fmt(vis)+' / '+fmt(tot)):''};
leftPane.addEventListener('scroll',upd,{passive:true});window.addEventListener('resize',upd);fh.addEventListener('toggle',upd,true);upd();
document.querySelectorAll('#vsel button').forEach((b,j)=>{if(j===0)b.style.background='#1d2c52'});
const split=document.getElementById('split'),layout=document.getElementById('layout');let drag=false;
split.addEventListener('mousedown',e=>{drag=true;split.classList.add('drag');document.body.style.userSelect='none';e.preventDefault()});
window.addEventListener('mousemove',e=>{if(!drag)return;const r=layout.getBoundingClientRect();const right=Math.min(Math.max(r.right-e.clientX,300),r.width-320);layout.style.gridTemplateColumns='1fr 6px '+right+'px'});
window.addEventListener('mouseup',()=>{drag=false;split.classList.remove('drag');document.body.style.userSelect=''});
</script></body></html>`
fs.writeFileSync(out, html)
console.log('wrote', out, '—', data.brackets.length, 'checkpoints,', data.totalEvents, 'events' + (demo ? ' (demo)' : ''))
