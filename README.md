# dsh-squeeze-command

A `/squeeze` slash command for [DeepSeek Harness](https://github.com/) (DSH):
manual, budget-targeted context compression for expensive-model sessions.

## Why

Long conversations with expensive models drown in input-token costs: every
turn resends the whole history. `/squeeze` shrinks a session's context toward
a token budget you choose, with one deliberate division of labor:

- The **conversation model** (expensive or not) only picks *which* spans to
  compress — a small, cheap decision.
- A configured **summarizer route** — a cheap, fast flash-tier model — writes
  the checkpoint summaries, so compression never costs frontier prices.

Everything trimmed stays recoverable from the append-only session log.

## Usage

```
/squeeze           compress toward contextBudgetTokens (preset config)
/squeeze 60k       one-off token target (also plain: /squeeze 60000)
/squeeze status    read-only: message count, token estimate, budget, summarizer
/squeeze help      full usage guide
```

Run it yourself, in the session you want to shrink, when the session is idle
(it refuses while an agent turn is in flight, and never auto-triggers).
A good habit is squeezing a "dry" session — one idle long enough that the
prompt cache it invalidates has already expired.

## Install

1. Place this package in your DSH commands directory:

```
~/.dsh/commands/dsh-squeeze-command/
```

2. Register it in your profile's resolver manifest
(`~/.dsh/profiles/web/package.json` — bare plugin names resolve from the
profile's `node_modules`):

```json
"dependencies": {
  "dsh-squeeze-command": "link:../../commands/dsh-squeeze-command"
}
```

and create the matching link:

```
ln -s ../../../commands/dsh-squeeze-command ~/.dsh/profiles/web/node_modules/dsh-squeeze-command
```

3. Mount it in a preset's compaction group (`agent.cordis.yml`):

```yaml
- id: command-squeeze
  name: 'dsh-squeeze-command'
  config:
    contextBudgetTokens: 100000
    summarizerProvider: <your-provider>
    summarizerModel: <your-flash-model>
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `contextBudgetTokens` | — (required for bare `/squeeze`) | target for bare invocation |
| `summarizerProvider` | — (required) | provider key for the summary route |
| `summarizerModel` | — (required) | model id for the summary route |
| `summarizerReasoningEffort` | `low` | effort pin for summarizer calls; `null` sends unpinned |
| `summarizerConcurrency` | `5` | max parallel summarizer calls |
| `maxSpanInputTokens` | `30000` | per-span summarizer input cap |
| `maxSummaryTokens` | `2048` | per-summary output cap |
| `minSpanTokens` | `200` | span floor worth a checkpoint |
| `maxSnapSteps` | `5` | balanced-edge snap budget |

The summarizer route should be a cheap, fast model — a flash-tier model is
the sweet spot: dense summarization is not reasoning-heavy work, and spans
run in parallel. The plugin is provider-neutral; any route registered in
your DSH settings works.

## How it works

1. `/squeeze` injects a trigger message; the conversation model reviews its
   context and calls the lazily-visible `context_squeeze` tool once with
   position ranges (it never writes summaries itself).
2. Spans are validated: edges snap outward to tool-pairing balanced cuts,
   spans that would overlap an already-planned neighbor are trimmed around
   it (only fully consumed spans drop), and tiny spans are rejected.
3. Each span opens its compaction bracket (the durable lock), then spans are
   summarized in parallel (bounded by `summarizerConcurrency`) on the
   configured cheap route. Truncated summaries fail closed — a checkpoint
   that hit the token cap is never accepted.
4. Checkpoints commit sequentially through the compaction marker protocol
   (`compaction/start` -> `compaction/summary` -> surface `replace` ->
   `compaction/end`), with every opened bracket closed on every path.
   Originals always remain in the session log.

## Development

```
node smoke.mjs   # 52 behavior checks against real Session objects, no LLM needed
```
