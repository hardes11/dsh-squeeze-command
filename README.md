# dsh-squeeze-command

Every turn of an expensive-model session re-sends its whole history. `/squeeze` shrinks it to a budget you pick.

A slash command for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that compresses a session's context on demand — with the summaries written by a cheap flash-tier route instead of the model you're paying for.

## Before / after

```
/squeeze status
Surface: 331 messages, ~371,000 tokens — OVER budget by 271,000 (budget 100000).
Summarizer: ollama/glm-5.3-flash:cloud. Read-only; nothing was changed.

/squeeze
Squeeze mode activated (target 100000 tokens, ~371,000 now; summaries via
ollama/glm-5.3-flash:cloud). The model will pick ranges; the summarizer
writes the checkpoints.

  ... the model reviews its context, marks compressible ranges,
      flash summarizers write the checkpoints in parallel ...

Squeezed 3 span(s) (~74,963 tokens shadowed). Surface now 116 messages, ~97,445 tokens.

/squeeze status
Surface: 44 messages, ~45,780 tokens — under budget (100000 by 54,220).
```

## What it does

- **Cuts what you resend.** One command on an idle session drops it under budget — and every summary is written by a cheap route you configure, not the frontier model running the conversation.
- **Nothing is thrown away.** Each squeeze leaves a checkpoint on the surface; the original messages stay in the append-only session log.
- **Fires only when you ask.** No thresholds, no auto-triggers, and it refuses to run while an agent turn is in flight.
- **No agents to dispatch.** The summary delegation is built in — you run one command, everything else happens inside it.

```
/squeeze           compress toward contextBudgetTokens (preset config)
/squeeze 60k       one-off token target (also plain: /squeeze 60000)
/squeeze status    read-only: message count, token estimate, budget, summarizer
/squeeze help      full usage guide
```

## Installation

1. Clone the package into your DSH commands directory:

```sh
git clone https://github.com/hardes11/dsh-squeeze-command.git ~/.dsh/commands/dsh-squeeze-command
```

2. Register it in your profile's resolver manifest — DSH resolves bare plugin
names from the profile's `node_modules`, so the manifest entry plus the
symlink puts it there:

```json
// e.g. ~/.dsh/profiles/web/package.json — substitute your profile
"dependencies": {
  "dsh-squeeze-command": "link:../../commands/dsh-squeeze-command"
}
```

```sh
ln -s ../../../commands/dsh-squeeze-command ~/.dsh/profiles/web/node_modules/dsh-squeeze-command
```

3. Mount it in a preset's compaction group (`~/.dsh/presets/<name>/agent.cordis.yml`):

```yaml
- id: command-squeeze
  name: 'dsh-squeeze-command'
  config:
    contextBudgetTokens: 100000
    summarizerProvider: <your-provider>
    summarizerModel: <your-flash-model>
```

4. Restart DSH, then run `/squeeze status`. If it prints a budget line, the
command is live. (Status works even unconfigured — it tells you what is missing.)

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `contextBudgetTokens` | — (required for bare `/squeeze`) | target for bare invocation |
| `summarizerProvider` | — (required) | provider key for the summary route |
| `summarizerModel` | — (required) | model id for the summary route |
| `summarizerReasoningEffort` | `null` | effort pin for summarizer calls; pin e.g. `low` only if the route's effort map declares it |
| `summarizerConcurrency` | `5` | max parallel summarizer calls |
| `maxSpanInputTokens` | `30000` | per-span summarizer input cap |
| `maxSummaryTokens` | `2048` | per-summary output cap |
| `minSpanTokens` | `200` | span floor worth a checkpoint |
| `maxSnapSteps` | `5` | balanced-edge snap budget |

Invalid values (zero, negative, non-integer) fail at plugin load with a named-field error, not at squeeze time.

The summarizer route should be a cheap, fast model — a flash-tier model is the sweet spot: dense summarization is not reasoning-heavy work, and spans run in parallel. The plugin is provider-neutral; any route registered in your DSH settings works.

## Compatibility

- **DSH:** peers on `@deepseek-ai/dsh-compaction` and `@deepseek-ai/dsh-llm` at `0.1.0-rc.6` (rc line — no stability promise).
- **Node:** >= 22 (`engines`).
- **Summarizer route:** provider-neutral — any provider registered in DSH settings.

Caveats worth knowing before installing:

- Manual-only. Nothing auto-fires, ever.
- Refuses while an agent turn or a compaction is active.
- A squeeze invalidates the prompt cache (it rewrites the context prefix) — run it on a session that has been idle long enough for the cache to have expired anyway.
- Squeezed spans are replaced on the surface by checkpoint messages — the visible transcript changes, though the session log keeps the originals.

## Why

Long conversations with expensive models drown in input-token costs: every turn resends the whole history, and input cost dominates — not the thinking. A 300k-token conversation sent to a frontier model on every turn is the budget killer; the cached-prefix discounts providers offer ([prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)) only soften it while the prefix stays stable.

`/squeeze` shrinks the context toward a budget you choose, with one deliberate division of labor: the conversation model (expensive or not) only picks *which* spans to compress — a small, cheap decision — while a configured summarizer route writes the checkpoint summaries, so compression never costs frontier prices.

## How it works

`/squeeze` asks the model to mark compressible ranges (one tool call). A cheap route writes the summaries in parallel. Checkpoints commit sequentially, and the originals stay in the session log.

## Implementation notes

- Model-picked span edges snap outward to tool-pairing balanced cuts; spans that would overlap an already-planned neighbor are trimmed to the free sub-interval (fully covered or split spans drop with a message).
- Summarization runs with bounded parallelism (`summarizerConcurrency`) holding no lock; each checkpoint then commits through its own tight synchronous bracket (`compaction/start` → `compaction/summary` → surface `replace` → `compaction/end`), honoring the compaction capability's single-lock contract. No code path can leave a bracket dangling.
- Summaries that hit the token cap fail closed — a truncated checkpoint is never accepted.

### Development

```sh
npm ci           # .npmrc pins legacy-peer-deps for the rc-tagged peer closure
node smoke.mjs   # 59 behavior checks against real Session objects, no LLM needed
```

`/squeeze -h` and `--help` work as aliases for `help`.

## License

[MIT](LICENSE)
