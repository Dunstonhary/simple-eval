/* Simple Eval — a dependency-free prompt regression harness.
   Everything runs in the page. The only network calls are to the model
   provider the user selects. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const STORE_KEY = 'simple-eval.v1';
const KEY_STORE = 'simple-eval.apikey';

const ASSERT_TYPES = [
  'contains', 'not_contains', 'equals', 'regex',
  'json_valid', 'json_has_keys', 'max_words', 'llm_judge',
];

const DEFAULTS = {
  provider: 'mock',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-5',
  judgeModel: 'claude-haiku-4-5-20251001',
  temperature: 0,
  maxTokens: 512,
  concurrency: 3,
  threshold: 90,
  promptA: '',
  promptB: '',
  cases: [],
};

let state = { ...DEFAULTS };
let lastRun = null;
let abort = false;

/* ---------------------------------------------------------------- demo data */

const DEMO = {
  promptA: `You are a support triage assistant.

Classify the customer message below into exactly one category:
billing, bug, feature_request, cancellation, other.

Respond with JSON ONLY. No preamble, no code fence. Schema:
{"category": "<one of the five>", "urgency": "low"|"medium"|"high", "reply": "<one sentence, under 25 words>"}

Never mention specific prices, discounts, refund amounts, or response-time guarantees.

Customer message:
{{input}}`,

  promptB: `You're a helpful support assistant. Read the customer message and
figure out what kind of issue it is (billing, bug, feature_request,
cancellation, or other), how urgent it is, and draft a short reply.

Give me the result as JSON.

Customer message:
{{input}}`,

  cases: [
    {
      name: 'Card declined — billing',
      vars: { input: 'My card got declined twice this morning and now the dashboard says my workspace is suspended. Can someone sort this out?' },
      asserts: [
        { type: 'json_valid', value: '' },
        { type: 'json_has_keys', value: 'category, urgency, reply' },
        { type: 'contains', value: 'billing' },
        { type: 'not_contains', value: 'refund' },
        { type: 'max_words', value: '80' },
      ],
    },
    {
      name: 'Export button 500s — bug',
      vars: { input: 'Clicking Export on the reports page returns a 500. Started after yesterday. Three people on my team can reproduce it.' },
      asserts: [
        { type: 'json_valid', value: '' },
        { type: 'json_has_keys', value: 'category, urgency, reply' },
        { type: 'contains', value: 'bug' },
        { type: 'llm_judge', value: 'The reply acknowledges the problem and does not promise a fix time or an SLA.' },
      ],
    },
    {
      name: 'Wants dark mode — feature request',
      vars: { input: 'Any chance of a dark mode? I stare at this thing for nine hours a day.' },
      asserts: [
        { type: 'json_valid', value: '' },
        { type: 'contains', value: 'feature_request' },
        { type: 'regex', value: '"urgency"\\s*:\\s*"low"' },
      ],
    },
    {
      name: 'Cancelling at renewal',
      vars: { input: 'We are not renewing next month. Please tell me what I need to do to close the account and get our data out.' },
      asserts: [
        { type: 'json_valid', value: '' },
        { type: 'contains', value: 'cancellation' },
        { type: 'not_contains', value: 'discount' },
        { type: 'llm_judge', value: 'The reply is neutral and professional, and does not try to upsell or offer an incentive to stay.' },
      ],
    },
    {
      name: 'Ambiguous praise — other',
      vars: { input: 'Just wanted to say the new onboarding flow is much better. No issue, carry on.' },
      asserts: [
        { type: 'json_valid', value: '' },
        { type: 'contains', value: 'other' },
        { type: 'max_words', value: '60' },
      ],
    },
    {
      name: 'Pasted credential — must not echo',
      vars: { input: 'Login is broken. My password is hunter2-and-then-some, try it yourself.' },
      asserts: [
        { type: 'json_valid', value: '' },
        { type: 'not_contains', value: 'hunter2' },
        { type: 'llm_judge', value: 'The reply does not repeat the password and does not ask for credentials.' },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ storage */

function save() {
  const { apiKey, ...rest } = state;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(rest)); } catch (e) { /* private mode */ }
  try {
    if ($('#rememberKey').checked && state.apiKey) localStorage.setItem(KEY_STORE, state.apiKey);
    else localStorage.removeItem(KEY_STORE);
  } catch (e) { /* ignore */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
  try {
    const k = localStorage.getItem(KEY_STORE);
    if (k) { state.apiKey = k; $('#rememberKey').checked = true; }
  } catch (e) { /* ignore */ }
  if (!state.cases.length && !state.promptA) {
    state.promptA = DEMO.promptA;
    state.promptB = DEMO.promptB;
    state.cases = structuredClone(DEMO.cases);
  }
}

/* ------------------------------------------------------------- templating */

function render(template, vars) {
  return String(template).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars || {}, k) ? String(vars[k]) : m);
}

function missingVars(template, vars) {
  const found = new Set();
  String(template).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => {
    if (!Object.prototype.hasOwnProperty.call(vars || {}, k)) found.add(k);
    return m;
  });
  return [...found];
}

/* -------------------------------------------------------------- assertions */

function stripFence(text) {
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

/* Returns { ok, value, salvaged }. `salvaged` means the output was only parseable
   after stripping a code fence or surrounding prose — structurally usable, but a
   violation of any prompt that asked for JSON and nothing else. json_valid treats
   salvaged as a failure; the key/shape assertions are tolerant of it. */
function tryParseJson(text) {
  const raw = String(text).trim();
  try { return { ok: true, value: JSON.parse(raw), salvaged: false }; } catch (e) { /* fall through */ }

  const unfenced = stripFence(raw);
  if (unfenced !== raw) {
    try { return { ok: true, value: JSON.parse(unfenced), salvaged: true }; } catch (e) { /* fall through */ }
  }

  const first = unfenced.search(/[{[]/);
  const last = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'));
  if (first !== -1 && last > first) {
    try { return { ok: true, value: JSON.parse(unfenced.slice(first, last + 1)), salvaged: true }; }
    catch (e) { /* ignore */ }
  }
  return { ok: false, salvaged: false };
}

async function evaluateAssert(a, output, ctx) {
  const out = String(output ?? '');
  const val = String(a.value ?? '').trim();
  switch (a.type) {
    case 'contains':
      return { pass: out.toLowerCase().includes(val.toLowerCase()), detail: `expected to contain "${val}"` };
    case 'not_contains':
      return { pass: !out.toLowerCase().includes(val.toLowerCase()), detail: `expected NOT to contain "${val}"` };
    case 'equals':
      return { pass: out.trim() === val, detail: 'expected exact match' };
    case 'regex': {
      let re;
      try { re = new RegExp(val); } catch (e) { return { pass: false, detail: `invalid regex: ${e.message}` }; }
      return { pass: re.test(out), detail: `expected to match /${val}/` };
    }
    case 'json_valid': {
      const p = tryParseJson(out);
      return {
        pass: p.ok && !p.salvaged,
        detail: p.ok
          ? (p.salvaged ? 'JSON only after stripping a code fence or preamble — a parser expecting raw JSON would break' : 'parses as JSON')
          : 'output is not valid JSON',
      };
    }
    case 'json_has_keys': {
      const p = tryParseJson(out);
      if (!p.ok || typeof p.value !== 'object' || p.value === null) return { pass: false, detail: 'output is not a JSON object' };
      const want = val.split(',').map((s) => s.trim()).filter(Boolean);
      const missing = want.filter((k) => !(k in p.value));
      return { pass: missing.length === 0, detail: missing.length ? `missing keys: ${missing.join(', ')}` : `has ${want.join(', ')}` };
    }
    case 'max_words': {
      const n = parseInt(val, 10) || 0;
      const words = out.trim().split(/\s+/).filter(Boolean).length;
      return { pass: words <= n, detail: `${words} words (limit ${n})` };
    }
    case 'llm_judge': {
      const verdict = await callJudge(val, ctx.renderedPrompt, out);
      return { pass: verdict.pass, detail: verdict.reason, judge: true, criterion: val };
    }
    default:
      return { pass: false, detail: `unknown assertion type "${a.type}"` };
  }
}

/* ---------------------------------------------------------------- provider */

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

/* The mock backend is deterministic and offline. It exists so the loop can be
   felt without spending anything, and it reproduces one real failure mode:
   a prompt that does not demand output-only gets a chatty preamble. */
function mockComplete(prompt) {
  const input = (prompt.match(/Customer message:\s*([\s\S]*)$/i) || [, prompt])[1].trim();
  const t = input.toLowerCase();
  let category = 'other';
  if (/\b(card|billing|invoice|charge|payment|declined|suspend)/.test(t)) category = 'billing';
  else if (/\b(500|error|broken|crash|bug|reproduce|fails?|not work)/.test(t)) category = 'bug';
  else if (/\b(any chance|feature|would be nice|dark mode|please add|request)/.test(t)) category = 'feature_request';
  else if (/\b(cancel|not renewing|close the account|churn|terminate)/.test(t)) category = 'cancellation';

  const urgency = category === 'billing' || category === 'bug'
    ? (/\b(suspend|500|three people|urgent|asap)/.test(t) ? 'high' : 'medium')
    : 'low';

  const replies = {
    billing: 'Thanks for flagging this — our billing team is looking at the account now and will follow up here.',
    bug: 'Thanks for the detail — this is reproducible on our side and the engineering team is investigating.',
    feature_request: 'Appreciated — logging this as a feature request for the product team to review.',
    cancellation: 'Understood — sharing the account closure and data export steps with you here shortly.',
    other: 'Thanks for the kind note — passing it along to the team.',
  };

  const body = JSON.stringify({ category, urgency, reply: replies[category] });

  // A prompt that does not demand output-only gets a preamble most — but not all —
  // of the time. That intermittency is the point: a single manual spot-check would
  // have missed it, and a suite catches it.
  const outputOnly = /json only|only json|no preamble|no prose|respond with json only/i.test(prompt);
  const chatty = !outputOnly && (hash(input) % 10) < 6;
  return chatty ? `Sure! Here's the JSON you asked for:\n\n\`\`\`json\n${body}\n\`\`\`` : body;
}

async function complete(prompt, modelOverride) {
  if (state.provider === 'mock') {
    await new Promise((r) => setTimeout(r, 80 + (hash(prompt) % 220)));
    return mockComplete(prompt);
  }

  const model = modelOverride || state.model;
  const base = (state.baseUrl || '').replace(/\/+$/, '');
  if (!state.apiKey) throw new Error('No API key set. Add one in Setup, or switch the provider to Mock.');

  if (state.provider === 'anthropic') {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': state.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: Number(state.maxTokens) || 512,
        temperature: Number(state.temperature) || 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: Number(state.maxTokens) || 512,
      temperature: Number(state.temperature) || 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Provider ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

const JUDGE_TEMPLATE = `You are grading one model output against one criterion. You are not being asked to improve it.

CRITERION:
{{criterion}}

MODEL OUTPUT:
---
{{output}}
---

Judge only the criterion. Length, tone and polish are irrelevant unless the criterion names them.
If the criterion is not clearly met, fail it. Do not give the benefit of the doubt.

Respond with JSON only:
{"pass": true|false, "reason": "<15 words max>"}`;

async function callJudge(criterion, originalPrompt, output) {
  if (state.provider === 'mock') {
    await new Promise((r) => setTimeout(r, 60));
    const chatty = /^\s*(sure|certainly|here'?s|of course)\b/i.test(output);
    const leaks = /hunter2|password is/i.test(output);
    const promises = /\b(within \d+ (hours?|days?)|guarantee|sla|by tomorrow)\b/i.test(output);
    const upsell = /\b(discount|stay with us|special offer|% off)\b/i.test(output);
    const pass = !leaks && !promises && !upsell && output.trim().length > 20;
    return { pass, reason: pass ? (chatty ? 'meets criterion (preamble ignored)' : 'meets criterion') : 'violates criterion' };
  }
  const prompt = render(JUDGE_TEMPLATE, { criterion, output });
  const raw = await complete(prompt, state.judgeModel || state.model);
  const p = tryParseJson(raw);
  if (p.ok && typeof p.value.pass === 'boolean') return { pass: p.value.pass, reason: String(p.value.reason || '').slice(0, 160) };
  return { pass: false, reason: `judge returned unparseable verdict: ${String(raw).slice(0, 80)}` };
}

/* -------------------------------------------------------------- the runner */

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      if (abort) return;
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function runVariant(label, promptTemplate, onTick) {
  const jobs = state.cases.map((c) => ({ c, promptTemplate }));
  return pool(jobs, Number(state.concurrency) || 3, async ({ c }) => {
    if (abort) return null;
    const vars = c.vars || {};
    const missing = missingVars(promptTemplate, vars);
    const renderedPrompt = render(promptTemplate, vars);
    const t0 = performance.now();
    let output = '';
    let error = null;
    try {
      output = await complete(renderedPrompt);
    } catch (e) {
      error = e.message || String(e);
    }
    const ms = Math.round(performance.now() - t0);

    const checks = [];
    if (!error) {
      for (const a of (c.asserts || [])) {
        try {
          checks.push({ ...a, ...(await evaluateAssert(a, output, { renderedPrompt })) });
        } catch (e) {
          checks.push({ ...a, pass: false, detail: `assertion error: ${e.message}` });
        }
      }
    }
    const passed = !error && checks.length > 0 && checks.every((k) => k.pass);
    onTick();
    return {
      variant: label, caseName: c.name, caseId: c.id, output, error, ms, checks, passed,
      missingVars: missing, prompt: renderedPrompt,
    };
  });
}

async function run() {
  if (!state.cases.length) { alert('Add at least one test case first.'); return; }
  if (!state.promptA.trim()) { alert('Prompt A is empty.'); return; }

  abort = false;
  $('#runBtn').disabled = true;
  $('#stopBtn').classList.remove('hidden');
  $('#exportResults').disabled = true;
  $('#exportMd').disabled = true;

  const hasB = !!state.promptB.trim();
  const total = state.cases.length * (hasB ? 2 : 1);
  let done = 0;
  const tick = () => {
    done++;
    $('#progressBar').style.width = `${Math.round((done / total) * 100)}%`;
    $('#runStatus').textContent = `${done}/${total} calls complete`;
  };

  $('#runStatus').textContent = 'running…';
  const started = new Date();
  const a = await runVariant('A', state.promptA, tick);
  const b = hasB && !abort ? await runVariant('B', state.promptB, tick) : null;

  lastRun = {
    started: started.toISOString(),
    provider: state.provider,
    model: state.provider === 'mock' ? 'mock' : state.model,
    judgeModel: state.provider === 'mock' ? 'mock' : (state.judgeModel || state.model),
    threshold: Number(state.threshold),
    aborted: abort,
    A: a.filter(Boolean),
    B: b ? b.filter(Boolean) : null,
  };

  $('#runBtn').disabled = false;
  $('#stopBtn').classList.add('hidden');
  $('#exportResults').disabled = false;
  $('#exportMd').disabled = false;
  $('#runStatus').textContent = abort ? 'stopped' : `done in ${Math.round((Date.now() - started) / 1000)}s`;

  renderResults();
  renderJudgeTab();
}

/* -------------------------------------------------------------- rendering */

function scoreOf(rows) {
  if (!rows || !rows.length) return 0;
  return Math.round((rows.filter((r) => r.passed).length / rows.length) * 100);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* word-level LCS diff, used only for the A/B output comparison */
function wordDiff(a, b) {
  const x = String(a).split(/(\s+)/), y = String(b).split(/(\s+)/);
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, out = '';
  while (i < n && j < m) {
    if (x[i] === y[j]) { out += esc(x[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out += `<span class="diff-del">${esc(x[i])}</span>`; i++; }
    else { out += `<span class="diff-add">${esc(y[j])}</span>`; j++; }
  }
  while (i < n) { out += `<span class="diff-del">${esc(x[i++])}</span>`; }
  while (j < m) { out += `<span class="diff-add">${esc(y[j++])}</span>`; }
  return out;
}

function renderResults() {
  if (!lastRun) return;
  $('#summaryPanel').classList.remove('hidden');
  $('#resultsPanel').classList.remove('hidden');

  const sa = scoreOf(lastRun.A);
  const sb = lastRun.B ? scoreOf(lastRun.B) : null;
  const avgMs = Math.round(lastRun.A.reduce((s, r) => s + r.ms, 0) / Math.max(1, lastRun.A.length));
  const errs = lastRun.A.filter((r) => r.error).length + (lastRun.B || []).filter((r) => r.error).length;

  const stats = [
    ['Prompt A score', `${sa}%`],
    ...(sb !== null ? [['Prompt B score', `${sb}%`]] : []),
    ...(sb !== null ? [['Delta', `${sb - sa > 0 ? '+' : ''}${sb - sa} pts`]] : []),
    ['Cases', String(lastRun.A.length)],
    ['Avg latency', `${avgMs} ms`],
    ['Errors', String(errs)],
  ];
  $('#summary').innerHTML = stats.map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');

  const best = sb !== null ? Math.max(sa, sb) : sa;
  const gatePass = best >= lastRun.threshold;
  const winner = sb === null ? 'A' : (sb > sa ? 'B' : sb < sa ? 'A' : 'tie');
  $('#gateVerdict').innerHTML = `
    <span class="pill ${gatePass ? 'pass' : 'fail'}">${gatePass ? 'GATE PASS' : 'GATE FAIL'}</span>
    <span class="small muted"> best score ${best}% vs threshold ${lastRun.threshold}%.
    ${sb === null ? '' : winner === 'tie' ? 'A and B scored the same — the suite cannot tell them apart, which usually means the suite is too easy.' : `Prompt ${winner} wins.`}</span>`;

  const rows = lastRun.A.map((ra, i) => {
    const rb = lastRun.B ? lastRun.B[i] : null;
    const status = (r) => r ? (r.error ? '<span class="pill warn">ERROR</span>' : r.passed ? '<span class="pill pass">PASS</span>' : '<span class="pill fail">FAIL</span>') : '';
    let move = '';
    if (rb) {
      if (ra.passed && !rb.passed) move = '<span class="pill fail">regressed</span>';
      else if (!ra.passed && rb.passed) move = '<span class="pill pass">improved</span>';
      else move = '<span class="pill idle">same</span>';
    }
    const checkList = (r) => (r.checks || []).map((k) =>
      `<div class="small"><span class="pill ${k.pass ? 'pass' : 'fail'}">${k.pass ? '✓' : '✗'}</span>
        <code>${esc(k.type)}</code> ${k.value ? `<span class="muted">${esc(String(k.value).slice(0, 90))}</span>` : ''}
        — <span class="muted">${esc(k.detail || '')}</span></div>`).join('');

    return `
      <details>
        <summary>
          <strong>${esc(ra.caseName)}</strong>
          ${status(ra)}${rb ? ' → ' + status(rb) : ''} ${move}
          <span class="small muted">${ra.ms}ms${rb ? ` / ${rb.ms}ms` : ''}</span>
        </summary>
        ${ra.missingVars.length ? `<div class="small" style="color:var(--warn)">Unfilled placeholders: ${esc(ra.missingVars.join(', '))}</div>` : ''}
        <div class="grid" style="margin-top:8px">
          <div>
            <div class="small muted">Prompt A output</div>
            ${ra.error ? `<pre style="color:var(--fail)">${esc(ra.error)}</pre>` : `<pre>${esc(ra.output)}</pre>`}
            ${checkList(ra)}
          </div>
          ${rb ? `<div>
            <div class="small muted">Prompt B output</div>
            ${rb.error ? `<pre style="color:var(--fail)">${esc(rb.error)}</pre>` : `<pre>${esc(rb.output)}</pre>`}
            ${checkList(rb)}
          </div>` : ''}
        </div>
        ${rb && !ra.error && !rb.error ? `<details><summary class="muted">Word diff A → B</summary><pre>${wordDiff(ra.output, rb.output)}</pre></details>` : ''}
      </details>`;
  }).join('');

  $('#results').innerHTML = rows;
}

/* ------------------------------------------------------- judge calibration */

function judgedItems() {
  if (!lastRun) return [];
  const out = [];
  for (const variant of ['A', 'B']) {
    for (const r of (lastRun[variant] || [])) {
      (r.checks || []).forEach((k, idx) => {
        if (k.judge) out.push({ key: `${variant}:${r.caseName}:${idx}`, variant, caseName: r.caseName, criterion: k.criterion, verdict: k.pass, reason: k.detail, output: r.output });
      });
    }
  }
  return out;
}

const humanLabels = {};

function renderJudgeTab() {
  const items = judgedItems();
  if (!items.length) {
    $('#judgeTable').innerHTML = '<p class="muted small">No <code>llm_judge</code> assertions in the last run. Add one in tab 2 and run again.</p>';
    $('#agreementPanel').classList.add('hidden');
    return;
  }
  $('#judgeTable').innerHTML = `
    <table>
      <thead><tr><th>Case</th><th>Criterion</th><th>Output</th><th>Judge</th><th>Your label</th></tr></thead>
      <tbody>${items.map((it) => `
        <tr>
          <td class="small">${esc(it.caseName)} <span class="muted mono">${it.variant}</span></td>
          <td class="small muted">${esc(it.criterion || '')}</td>
          <td class="small mono" style="max-width:280px">${esc(String(it.output).slice(0, 160))}${String(it.output).length > 160 ? '…' : ''}</td>
          <td><span class="pill ${it.verdict ? 'pass' : 'fail'}">${it.verdict ? 'pass' : 'fail'}</span>
              <div class="small muted">${esc(it.reason || '')}</div></td>
          <td>
            <select data-judge-key="${esc(it.key)}" style="width:auto">
              <option value="">—</option>
              <option value="pass" ${humanLabels[it.key] === 'pass' ? 'selected' : ''}>pass</option>
              <option value="fail" ${humanLabels[it.key] === 'fail' ? 'selected' : ''}>fail</option>
            </select>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  $$('[data-judge-key]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const k = sel.dataset.judgeKey;
      if (sel.value) humanLabels[k] = sel.value; else delete humanLabels[k];
      renderAgreement(items);
    });
  });
  renderAgreement(items);
}

function renderAgreement(items) {
  const labeled = items.filter((it) => humanLabels[it.key]);
  if (!labeled.length) { $('#agreementPanel').classList.add('hidden'); return; }
  $('#agreementPanel').classList.remove('hidden');

  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const it of labeled) {
    const h = humanLabels[it.key] === 'pass';
    if (it.verdict && h) tp++;
    else if (!it.verdict && !h) tn++;
    else if (it.verdict && !h) fp++;
    else fn++;
  }
  const n = labeled.length;
  const agree = Math.round(((tp + tn) / n) * 100);

  // Cohen's kappa — agreement corrected for what chance alone would produce
  const pObs = (tp + tn) / n;
  const pJudgePass = (tp + fp) / n, pHumanPass = (tp + fn) / n;
  const pExp = pJudgePass * pHumanPass + (1 - pJudgePass) * (1 - pHumanPass);
  const kappa = pExp === 1 ? 1 : (pObs - pExp) / (1 - pExp);

  const verdictText = agree >= 90 ? 'Trustworthy enough to gate on.'
    : agree >= 75 ? 'Usable as a signal, not as a gate. Tighten the rubric.'
    : 'Not usable. Replace this judge with a deterministic assertion or rewrite the criterion.';

  $('#agreement').innerHTML = [
    ['Labeled', `${n}/${items.length}`],
    ['Agreement', `${agree}%`],
    ["Cohen's κ", kappa.toFixed(2)],
    ['Judge too lenient', String(fp)],
    ['Judge too harsh', String(fn)],
  ].map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')
    + `<div class="stat" style="grid-column:1/-1"><div class="k">Read</div><div class="small" style="margin-top:4px">${esc(verdictText)}
       ${n < 20 ? ' <span class="muted">(fewer than 20 labels — treat this as directional only.)</span>' : ''}</div></div>`;
}

/* ------------------------------------------------------------ case editing */

function uid() { return Math.random().toString(36).slice(2, 9); }

function renderCases() {
  $('#caseCount').textContent = `— ${state.cases.length} case${state.cases.length === 1 ? '' : 's'}`;
  $('#caseList').innerHTML = state.cases.map((c, ci) => `
    <div class="case-card" data-ci="${ci}">
      <div class="hdr">
        <input value="${esc(c.name || '')}" data-field="name" placeholder="case name">
        <button class="del" data-action="del-case" title="delete case">✕</button>
      </div>
      <label>Variables (JSON — keys fill <code>{{placeholders}}</code> in the prompt)</label>
      <textarea data-field="vars" style="min-height:70px" spellcheck="false">${esc(JSON.stringify(c.vars || {}, null, 2))}</textarea>
      <label>Assertions</label>
      ${(c.asserts || []).map((a, ai) => `
        <div class="assert-row" data-ai="${ai}">
          <select data-field="atype">${ASSERT_TYPES.map((t) => `<option ${t === a.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <input data-field="avalue" value="${esc(a.value || '')}" placeholder="${a.type === 'json_valid' ? '(no value needed)' : 'expected value / criterion'}">
          <button class="del" data-action="del-assert">✕</button>
        </div>`).join('')}
      <button class="ghost small" data-action="add-assert" style="margin-top:8px">+ assertion</button>
    </div>`).join('');

  $$('#caseList [data-ci]').forEach((card) => {
    const ci = Number(card.dataset.ci);
    card.querySelector('[data-field="name"]').addEventListener('input', (e) => { state.cases[ci].name = e.target.value; save(); });
    const varsEl = card.querySelector('[data-field="vars"]');
    varsEl.addEventListener('change', (e) => {
      try { state.cases[ci].vars = JSON.parse(e.target.value || '{}'); varsEl.style.borderColor = ''; save(); }
      catch (err) { varsEl.style.borderColor = 'var(--fail)'; }
    });
    card.querySelector('[data-action="del-case"]').addEventListener('click', () => { state.cases.splice(ci, 1); save(); renderCases(); });
    card.querySelector('[data-action="add-assert"]').addEventListener('click', () => {
      (state.cases[ci].asserts ||= []).push({ type: 'contains', value: '' }); save(); renderCases();
    });
    card.querySelectorAll('.assert-row').forEach((row) => {
      const ai = Number(row.dataset.ai);
      row.querySelector('[data-field="atype"]').addEventListener('change', (e) => { state.cases[ci].asserts[ai].type = e.target.value; save(); renderCases(); });
      row.querySelector('[data-field="avalue"]').addEventListener('input', (e) => { state.cases[ci].asserts[ai].value = e.target.value; save(); });
      row.querySelector('[data-action="del-assert"]').addEventListener('click', () => { state.cases[ci].asserts.splice(ai, 1); save(); renderCases(); });
    });
  });
}

/* ------------------------------------------------------------------ export */

function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function markdownReport() {
  const sa = scoreOf(lastRun.A);
  const sb = lastRun.B ? scoreOf(lastRun.B) : null;
  let md = `# Eval report\n\n`;
  md += `- Run: ${lastRun.started}\n- Provider: ${lastRun.provider} (${lastRun.model})\n`;
  md += `- Threshold: ${lastRun.threshold}%\n- Prompt A: **${sa}%**\n`;
  if (sb !== null) md += `- Prompt B: **${sb}%** (${sb - sa >= 0 ? '+' : ''}${sb - sa} pts)\n`;
  md += `\n| Case | A | ${sb !== null ? 'B | Move | ' : ''}A failures |${sb !== null ? ' B failures |' : ''}\n`;
  md += `|---|---|${sb !== null ? '---|---|' : ''}---|${sb !== null ? '---|' : ''}\n`;
  lastRun.A.forEach((ra, i) => {
    const rb = lastRun.B ? lastRun.B[i] : null;
    const st = (r) => r.error ? 'ERROR' : r.passed ? 'pass' : 'fail';
    const fails = (r) => (r.checks || []).filter((k) => !k.pass)
      .map((k) => `${k.type}: ${k.detail}`).join('; ').replace(/\|/g, '\\|') || '—';
    let move = '';
    if (rb) move = ra.passed && !rb.passed ? 'regressed' : !ra.passed && rb.passed ? 'improved' : 'same';
    md += `| ${ra.caseName} | ${st(ra)} | ${rb ? `${st(rb)} | ${move} | ` : ''}${fails(ra)} |${rb ? ` ${fails(rb)} |` : ''}\n`;
  });
  return md;
}

/* -------------------------------------------------------------------- wire */

function bind(id, field, cast = (v) => v) {
  const el = $(id);
  el.value = state[field] ?? '';
  const ev = el.tagName === 'SELECT' ? 'change' : 'input';
  el.addEventListener(ev, () => { state[field] = cast(el.value); save(); if (field === 'provider') syncProvider(); });
}

function syncProvider() {
  $('#live-cfg').classList.toggle('hidden', state.provider === 'mock');
  if (state.provider === 'openai' && state.baseUrl.includes('anthropic')) {
    state.baseUrl = 'https://api.openai.com';
    $('#baseUrl').value = state.baseUrl;
  }
  if (state.provider === 'anthropic' && state.baseUrl.includes('openai')) {
    state.baseUrl = 'https://api.anthropic.com';
    $('#baseUrl').value = state.baseUrl;
  }
}

function init() {
  load();

  bind('#provider', 'provider');
  bind('#baseUrl', 'baseUrl');
  bind('#model', 'model');
  bind('#judgeModel', 'judgeModel');
  bind('#apiKey', 'apiKey');
  bind('#temperature', 'temperature', Number);
  bind('#maxTokens', 'maxTokens', Number);
  bind('#concurrency', 'concurrency', Number);
  bind('#threshold', 'threshold', Number);
  bind('#promptA', 'promptA');
  bind('#promptB', 'promptB');
  syncProvider();

  $('#rememberKey').addEventListener('change', save);
  $('#clearKey').addEventListener('click', () => {
    state.apiKey = '';
    $('#apiKey').value = '';
    $('#rememberKey').checked = false;
    save();
  });

  $$('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('section[id^="tab-"]').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === 'judge') renderJudgeTab();
  }));

  $('#addCase').addEventListener('click', () => {
    state.cases.push({ id: uid(), name: `Case ${state.cases.length + 1}`, vars: { input: '' }, asserts: [{ type: 'contains', value: '' }] });
    save(); renderCases();
  });
  $('#loadDemo').addEventListener('click', () => {
    if (!confirm('Replace the current prompts and cases with the demo suite?')) return;
    state.promptA = DEMO.promptA; state.promptB = DEMO.promptB; state.cases = structuredClone(DEMO.cases);
    $('#promptA').value = state.promptA; $('#promptB').value = state.promptB;
    save(); renderCases();
  });
  $('#exportCases').addEventListener('click', () =>
    download('eval-suite.json', JSON.stringify({ promptA: state.promptA, promptB: state.promptB, threshold: state.threshold, cases: state.cases }, null, 2)));
  $('#importCases').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (Array.isArray(d)) state.cases = d;
      else {
        if (d.promptA != null) { state.promptA = d.promptA; $('#promptA').value = d.promptA; }
        if (d.promptB != null) { state.promptB = d.promptB; $('#promptB').value = d.promptB; }
        if (d.threshold != null) { state.threshold = d.threshold; $('#threshold').value = d.threshold; }
        if (Array.isArray(d.cases)) state.cases = d.cases;
      }
      save(); renderCases();
    } catch (err) { alert(`Could not read that file: ${err.message}`); }
    e.target.value = '';
  });

  $('#runBtn').addEventListener('click', run);
  $('#stopBtn').addEventListener('click', () => { abort = true; $('#runStatus').textContent = 'stopping…'; });
  $('#exportResults').addEventListener('click', () => download('eval-results.json', JSON.stringify(lastRun, null, 2)));
  $('#exportMd').addEventListener('click', () => download('eval-report.md', markdownReport(), 'text/markdown'));

  renderCases();
}

document.addEventListener('DOMContentLoaded', init);
