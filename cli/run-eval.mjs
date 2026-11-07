#!/usr/bin/env node
/* Headless runner for a suite exported from the Simple Eval UI.
   Zero dependencies, Node 20+. Exits non-zero when the score is below the
   threshold, which is all a CI gate needs.

     node cli/run-eval.mjs eval-suite.json --provider anthropic --model claude-sonnet-5
     ANTHROPIC_API_KEY=... node cli/run-eval.mjs eval-suite.json --threshold 90
*/

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};

if (!file) {
  console.error('usage: run-eval.mjs <suite.json> [--provider anthropic|openai] [--model M] [--prompt A|B] [--threshold N]');
  process.exit(2);
}

const suite = JSON.parse(readFileSync(file, 'utf8'));
const provider = flag('provider', 'anthropic');
const model = flag('model', provider === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o-mini');
const judgeModel = flag('judge-model', model);
const which = flag('prompt', 'A').toUpperCase();
const threshold = Number(flag('threshold', suite.threshold ?? 90));
const maxTokens = Number(flag('max-tokens', 512));
const temperature = Number(flag('temperature', 0));
const concurrency = Number(flag('concurrency', 3));

const template = which === 'B' ? suite.promptB : suite.promptA;
if (!template) { console.error(`Suite has no prompt ${which}.`); process.exit(2); }

const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY.'); process.exit(2); }

const baseUrl = flag('base-url', provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com');

const render = (t, vars) =>
  String(t).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars || {}, k) ? String(vars[k]) : m);

async function complete(prompt, mdl = model) {
  if (provider === 'anthropic') {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: mdl, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const d = await res.json();
    return (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: mdl, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Provider ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content ?? '';
}

const stripFence = (t) => { const m = String(t).match(/```(?:json)?\s*([\s\S]*?)```/i); return (m ? m[1] : t).trim(); };

function tryParseJson(text) {
  const raw = String(text).trim();
  try { return { ok: true, value: JSON.parse(raw), salvaged: false }; } catch {}
  const unfenced = stripFence(raw);
  if (unfenced !== raw) { try { return { ok: true, value: JSON.parse(unfenced), salvaged: true }; } catch {} }
  const first = unfenced.search(/[{[]/);
  const last = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'));
  if (first !== -1 && last > first) {
    try { return { ok: true, value: JSON.parse(unfenced.slice(first, last + 1)), salvaged: true }; } catch {}
  }
  return { ok: false, salvaged: false };
}

const JUDGE = `You are grading one model output against one criterion. You are not being asked to improve it.

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

async function check(a, out) {
  const val = String(a.value ?? '').trim();
  const o = String(out ?? '');
  switch (a.type) {
    case 'contains': return { pass: o.toLowerCase().includes(val.toLowerCase()), detail: `contains "${val}"` };
    case 'not_contains': return { pass: !o.toLowerCase().includes(val.toLowerCase()), detail: `not_contains "${val}"` };
    case 'equals': return { pass: o.trim() === val, detail: 'exact match' };
    case 'regex': { let re; try { re = new RegExp(val); } catch (e) { return { pass: false, detail: `bad regex: ${e.message}` }; }
      return { pass: re.test(o), detail: `/${val}/` }; }
    case 'json_valid': { const p = tryParseJson(o);
      return { pass: p.ok && !p.salvaged, detail: p.ok ? (p.salvaged ? 'JSON only after stripping fence/preamble' : 'valid JSON') : 'not JSON' }; }
    case 'json_has_keys': { const p = tryParseJson(o);
      if (!p.ok || typeof p.value !== 'object' || p.value === null) return { pass: false, detail: 'not a JSON object' };
      const miss = val.split(',').map((s) => s.trim()).filter(Boolean).filter((k) => !(k in p.value));
      return { pass: !miss.length, detail: miss.length ? `missing: ${miss.join(', ')}` : 'keys present' }; }
    case 'max_words': { const n = parseInt(val, 10) || 0; const w = o.trim().split(/\s+/).filter(Boolean).length;
      return { pass: w <= n, detail: `${w}/${n} words` }; }
    case 'llm_judge': {
      const raw = await complete(render(JUDGE, { criterion: val, output: o }), judgeModel);
      const p = tryParseJson(raw);
      if (p.ok && typeof p.value.pass === 'boolean') return { pass: p.value.pass, detail: String(p.value.reason || '').slice(0, 120) };
      return { pass: false, detail: 'judge verdict unparseable' };
    }
    default: return { pass: false, detail: `unknown assertion "${a.type}"` };
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await worker(items[i]); }
  }));
  return out;
}

const results = await pool(suite.cases || [], concurrency, async (c) => {
  const prompt = render(template, c.vars || {});
  let output = '', error = null;
  try { output = await complete(prompt); } catch (e) { error = e.message; }
  const checks = error ? [] : await Promise.all((c.asserts || []).map((a) => check(a, output).then((r) => ({ ...a, ...r }))));
  return { name: c.name, output, error, checks, passed: !error && checks.length > 0 && checks.every((k) => k.pass) };
});

const score = Math.round((results.filter((r) => r.passed).length / Math.max(1, results.length)) * 100);

for (const r of results) {
  const mark = r.error ? 'ERR ' : r.passed ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${r.name}`);
  if (r.error) console.log(`      ${r.error}`);
  for (const k of r.checks.filter((k) => !k.pass)) console.log(`      ✗ ${k.type}: ${k.detail}`);
}

console.log(`\nprompt ${which} — ${score}% (${results.filter((r) => r.passed).length}/${results.length}), threshold ${threshold}%`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Prompt eval — ${score}% (threshold ${threshold}%)\n\n` +
    results.map((r) => `- ${r.passed ? '✅' : '❌'} ${r.name}`).join('\n') + '\n');
}

process.exit(score >= threshold ? 0 : 1);
