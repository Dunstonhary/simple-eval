# Simple Eval

A small prompt regression harness. One static page, no build step, no backend, no dependencies.

**Live:** https://dunstonhary.github.io/simple-eval/

![status](https://img.shields.io/badge/deps-0-blue) ![status](https://img.shields.io/badge/backend-none-blue)

---

## The premise

"The prompt isn't working as expected" is almost never a tooling problem. It is a missing
definition of *expected*. Teams have no test set, no pass criteria, and no record of what changed
between the version that worked and the version that didn't.

A tool does not supply those. You still have to sit down and write 30–50 real inputs with
known-good outputs. That work is boring and it is the actual bottleneck.

What a tool *can* do is make the discipline cheap once you have the dataset: run every case on
every prompt change, show you exactly which cases moved, and block a merge when the score drops.
That is all this is.

## What it does

- **Test cases** — inputs plus expectations, stored as JSON you can commit to your repo.
- **Assertions** — `contains`, `not_contains`, `equals`, `regex`, `json_valid`, `json_has_keys`,
  `max_words`, and `llm_judge` for the fuzzy ones.
- **A/B diff** — run a baseline prompt and a candidate side by side, per case, with a word-level
  diff of the two outputs and an explicit improved / regressed / same label.
- **A pass gate** — set the threshold *before* you run. The CLI exits non-zero below it.
- **Judge calibration** — label judged outputs by hand and get agreement and Cohen's κ against
  the judge. This is the part most teams skip, and it is the part that decides whether a judged
  score means anything.

## Getting started

Open the live page. It loads with a demo suite (support-ticket triage) and a **Mock** provider that
runs offline and costs nothing, so you can feel the loop before wiring up a key.

The demo is rigged to show one real failure mode: Prompt A demands JSON-only output and scores
100%; Prompt B asks politely for "the result as JSON" and intermittently gets a `Sure! Here's the
JSON:` preamble, scoring 50%. A single manual spot-check would have missed it. A suite catches it.

Then:

1. Switch the provider to Anthropic or any OpenAI-compatible endpoint and paste a key.
2. Replace the demo prompts with one of your own real prompts.
3. Replace the demo cases with your own. This is the part that takes the afternoon.
4. Export the suite as JSON and commit it next to the prompt.

### Running it locally

```bash
git clone https://github.com/Dunstonhary/simple-eval.git
cd simple-eval
python3 -m http.server 8000   # any static server works
```

## CI gate

`cli/run-eval.mjs` runs an exported suite headlessly. Node 20+, zero dependencies.

```bash
node cli/run-eval.mjs eval-suite.json \
  --provider anthropic \
  --model claude-sonnet-5 \
  --threshold 90
```

Exit code is 0 at or above the threshold, 1 below it, 2 for a usage error. Flags:
`--prompt A|B`, `--judge-model`, `--base-url`, `--temperature`, `--max-tokens`, `--concurrency`.
The key comes from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `LLM_API_KEY`.

```yaml
# .github/workflows/eval.yml
on: pull_request
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node cli/run-eval.mjs prompts/triage.suite.json --threshold 90
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

It writes a pass/fail list to the job summary when `GITHUB_STEP_SUMMARY` is set.

## On LLM-as-judge

A judge is a prompt, so it needs its own eval. Judges drift, agree with themselves, and reward
verbosity. Tab 4 exists to measure yours:

- **≥ 90% agreement** — usable as a gate.
- **75–90%** — a signal, not a gate. Tighten the rubric.
- **< 75%** — the judged portion of your score is noise. Replace it with a deterministic
  assertion or rewrite the criterion.

Cohen's κ is shown alongside raw agreement because raw agreement flatters a judge on a skewed
set — if 95% of your cases pass, a judge that says "pass" unconditionally scores 95%. Fewer than
20 labels is directional only.

## Privacy and keys

Everything runs in the page. The only outbound requests go to the provider endpoint you configure.
There is no analytics, no telemetry, and no server of ours in the path.

Your API key is held in memory, and written to this browser's `localStorage` only if you tick
"Remember key". Leave that off on any shared or public machine. If you have pasted a key into a
machine you do not control, rotate it.

Test-case content is sent to your chosen provider as part of the prompt. Use representative
examples rather than real customer records.

## Scope

This is deliberately small. If you need datasets at scale, tracing, versioned experiment history,
team dashboards, or regression tracking across months, use one of the mature tools instead —
Promptfoo, Langfuse, DeepEval, Arize Phoenix, Braintrust, Comet Opik, or LangSmith. Several are
open source and self-hostable.

The reason to run this one is that it fits in your head and in a single afternoon, so nobody has
an excuse not to write the test cases.

## License

MIT
