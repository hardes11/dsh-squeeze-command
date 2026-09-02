/**
 * dsh-squeeze-command — /squeeze slash command + context_squeeze tool.
 *
 * Manual-only, budget-targeted context compression for expensive-model
 * sessions. One opinion, deliberately:
 *
 *   - The conversation model only PICKS ranges (a small decision).
 *   - A configured cheap route (summarizerProvider/summarizerModel) WRITES
 *     the checkpoint summaries, so compression never costs frontier prices.
 *   - Everything is manual: no thresholds, no turn-end triggers, no
 *     auto-fire of any kind. The command refuses to activate while an
 *     agent turn is open or a compaction is active.
 *
 * /squeeze          — squeeze toward contextBudgetTokens (preset config)
 * /squeeze NNk|NN   — one-off token-target override
 * /squeeze status   — read-only: surface size, estimated tokens, budget
 *
 * The tool is only visible while squeeze mode is active (lazy visibility
 * via system-prompt/assemble, cleared at turn end). Originals are always
 * preserved in the append-only session log (replay-safe).
 *
 * Config (mount site: the preset's compaction group):
 *   contextBudgetTokens    — target for bare /squeeze (required for bare use)
 *   summarizerProvider     — cheap route provider for summary writing (required)
 *   summarizerModel        — cheap route model (required)
 *   maxSummaryTokens       — per-span summary cap (default 2048)
 *   minSpanTokens          — span floor worth a checkpoint (default 200)
 *   maxSnapSteps           — balanced-edge snap budget (default 5)
 *   maxSpanInputTokens     — summarizer input cap per span (default 30000)
 *   summarizerReasoningEffort — effort pin for the summarizer route; 'low' keeps
 *                              the flash summarizer fast, null sends unpinned
 *   summarizerConcurrency   — max parallel summarizer calls (default 5)
 *
 * @module dsh-squeeze-command
 */

import { compactCheckpointSource, toolPairingBalancedBefore, toolPairingBalancedAfter, CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const DEFAULT_MAX_SUMMARY_TOKENS = 2048
const DEFAULT_MIN_SPAN_TOKENS = 200
const DEFAULT_MAX_SNAP_STEPS = 5
const DEFAULT_MAX_SPAN_INPUT_TOKENS = 30000
const DEFAULT_SUMMARIZER_EFFORT = 'low'
const DEFAULT_SUMMARIZER_CONCURRENCY = 5

// ── Surface inspection helpers ──────────────────────────────────────────────

/**
 * Extract the text of one surface node's message for summarization input.
 * User messages carry their fields directly on the event data; assistant
 * messages and tool results wrap them under data.message, with tool results
 * nesting inner blocks one level deeper.
 */
function extractMessageText(event) {
  if (event?.type === 'user/message') {
    const blocks = event.data?.content
    if (!Array.isArray(blocks)) return ''
    return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  }
  const message = event?.data?.message
  if (message === undefined) return ''
  let blocks = message.content
  // tool/result wraps inner blocks under content[0].content
  if (event.type === 'tool/result') {
    const outer = Array.isArray(blocks) ? blocks[0] : undefined
    blocks = outer?.content
  }
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * The message-like value of a surface event for token estimation.
 * User messages ARE the event data; assistant/tool events nest a message.
 */
function messageOf(event) {
  if (event?.type === 'user/message') return event.data
  return event?.data?.message
}

/**
 * Estimate total surface context tokens via the token meter.
 */
function estimateSurfaceTokens(session, tokenMeter) {
  let total = 0
  for (const seq of session.surface.nodes) {
    const message = messageOf(session.events[seq])
    if (message !== undefined) total += tokenMeter.estimateMessage(message)
  }
  return total
}

/**
 * Find the currently open turn by scanning backwards for turn/start without
 * an intervening turn/end.
 */
function findOpenTurn(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const evt = session.events[i]
    if (evt === undefined) continue
    if (evt.type === 'turn/end') return null
    if (evt.type === 'turn/start') return evt.data.turn
  }
  return null
}

/**
 * Check there is no unmatched compaction/start in the log.
 */
function isCompactionActive(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const evt = session.events[i]
    if (evt === undefined) continue
    if (evt.type === 'compaction/end') return false
    if (evt.type === 'compaction/start') return true
  }
  return false
}

// ── Balanced-edge snapping (same discipline the sweep command proved) ───────

/**
 * Walk a span's start edge backwards to the nearest tool-pairing balanced cut.
 * Expansion is the safe direction: it keeps every node the model intended
 * inside the span instead of splitting a pair.
 */
function snapStartBackward(session, nodes, idx, maxSteps, minIdx = 0) {
  let steps = 0
  while (!toolPairingBalancedBefore(session, nodes[idx])) {
    if (idx <= minIdx || steps >= maxSteps) return -1
    idx -= 1
    steps += 1
  }
  return idx
}

/**
 * Walk a span's end edge forwards to the nearest tool-pairing balanced cut.
 */
function snapEndForward(session, nodes, idx, maxSteps, maxIdx = nodes.length - 1) {
  let steps = 0
  while (!toolPairingBalancedAfter(session, nodes[idx])) {
    if (idx >= maxIdx || steps >= maxSteps) return -1
    idx += 1
    steps += 1
  }
  return idx
}

// ── Cheap-route summarization ───────────────────────────────────────────────

const SPAN_SUMMARY_PROMPT = 'You are a compaction engine for an AI coding assistant. Write a high-fidelity summary of the conversation span below that lets the assistant resume work with no loss of essential context. Preserve verbatim: file paths, function and identifier names, commands, error messages, user decisions, and key findings. Discard verbose output, raw data dumps, and repetition. Write dense factual prose, no preamble.'

/**
 * Summarize one span's text on the configured cheap route.
 * Fails closed on error, abort, and token-cap truncation: a truncated
 * checkpoint silently loses span content, so it is never accepted.
 * @returns {Promise<{ ok: true, summary: string } | { ok: false, error: string }>}
 */
async function summarizeSpan(llm, provider, model, spanText, maxSummaryTokens, summarizerEffort, session, signal) {
  let summaryText = ''
  try {
    for await (const chunk of llm.stream({
      provider,
      model,
      ...summarizerEffort === null ? {} : { reasoningEffort: summarizerEffort },
      messages: [
        { role: 'system', content: [{ type: 'text', text: SPAN_SUMMARY_PROMPT }] },
        { role: 'user', content: [{ type: 'text', text: spanText }] },
      ],
      sessionId: session.id,
      purpose: 'compaction',
      maxTokens: maxSummaryTokens,
      signal,
    })) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        summaryText += chunk.text
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason !== undefined && reason.kind === 'error') {
          return { ok: false, error: `summarizer stream finished with error` }
        }
        if (reason !== undefined && reason.kind === 'aborted') {
          return { ok: false, error: 'summarizer stream aborted' }
        }
        if (reason !== undefined && (reason.kind === 'length' || reason.kind === 'max-tokens')) {
          return { ok: false, error: `summary truncated at the ${maxSummaryTokens}-token cap (incomplete checkpoint); split into smaller spans` }
        }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const trimmed = summaryText.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'summarizer returned an empty summary' }
  }
  return { ok: true, summary: trimmed }
}

// ── Trigger prompt ──────────────────────────────────────────────────────────

/**
 * Build the squeeze trigger prompt: the addressing contract, the current
 * size, the token target, and the ranges-only tool discipline.
 */
function buildTriggerPrompt(session, tokenMeter, targetTokens) {
  const messageCount = session.surface.nodes.length
  const currentTokens = estimateSurfaceTokens(session, tokenMeter)
  return 'Context squeeze requested. '
    + `Your context currently contains ${messageCount} messages (~${currentTokens} tokens), numbered 1..${messageCount} in conversation order. `
    + 'Every message counts as one position: your own replies, user messages, EACH individual tool result, and any earlier summary checkpoints.\n\n'
    + `Target: get your context under ${targetTokens} tokens. `
    + 'Review your conversation and identify spans of old tool results, file reads, or completed exploration whose details can be condensed. '
    + 'Then call the context_squeeze tool EXACTLY ONCE, passing all spans together. You provide ONLY the position ranges — the summaries will be written for you by a separate summarizer. Boundary rules:\n'
    + '- Never start a span on an assistant message that contains tool calls unless the span also includes every result those calls produced. When unsure where results end, start the span just after a run of tool results.\n'
    + '- Prefer several small-to-medium spans over one giant span.\n'
    + '- Do not compress the most recent turn, user decisions, or content you are actively working with.\n\n'
    + 'After the tool reports its results, briefly confirm what was squeezed.'
}

// ── Tool execution ──────────────────────────────────────────────────────────

/**
 * Execute the context_squeeze tool: snap model-picked edges to balanced
 * cuts, summarize each span on the cheap route, and commit checkpoint
 * replacements on the session surface.
 * @param {object} args — { squeezes: [{ start, end }] }
 * @param {object} exec — ToolRunContext (exec.agent.session is the session)
 * @param {object} ctx — plugin context (tokenMeter via inject, llm via get)
 * @param {Map} squeezeModes — per-session mode map
 * @param {object} options — resolved config (summarizer route, floors)
 */
/**
 * Run task thunks with bounded concurrency. Order of invocation is the
 * array order; completion order is whatever finishes first. Each thunk
 * receives its task and writes its outcome into it.
 */
async function runBounded(tasks, concurrency, thunk) {
  let next = 0
  const workers = []
  for (let w = 0; w < Math.max(1, Math.min(concurrency, tasks.length)); w += 1) {
    workers.push((async () => {
      while (next < tasks.length) {
        const task = tasks[next]
        next += 1
        await thunk(task)
      }
    })())
  }
  await Promise.all(workers)
}

/**
 * Execute the context_squeeze tool: snap model-picked edges to balanced
 * cuts, summarize spans on the cheap route (bounded parallelism), and commit
 * checkpoint replacements sequentially on the session surface.
 *
 * Phases: (1) validate every span and open its compaction bracket — the
 * durable start marker is the lock, opened before any summarizer yields;
 * (2) summarize the validated spans with bounded concurrency; (3) commit in
 * surface order (highest-first), closing every opened bracket on every path.
 * @param {object} args — { squeezes: [{ start, end }] }
 * @param {object} exec — ToolRunContext (exec.agent.session is the session)
 * @param {object} ctx — plugin context (tokenMeter via inject, llm via get)
 * @param {Map} squeezeModes — per-session mode map
 * @param {object} options — resolved config (summarizer route, floors)
 */
async function executeContextSqueeze(args, exec, ctx, squeezeModes, options) {
  const session = exec.agent.session
  const signal = exec?.signal
  const tokenMeter = ctx.tokenMeter
  const llm = ctx.get('llm')
  const mode = squeezeModes.get(session.id)
  const sourceCommandId = mode?.sourceCommandId

  if (llm === undefined || typeof llm.stream !== 'function') {
    return { result: 'No LLM service available in this realm; cannot summarize spans.' }
  }

  const squeezes = Array.isArray(args?.squeezes) ? args.squeezes : []
  if (squeezes.length === 0) {
    return { result: 'No squeezes provided.' }
  }

  // Sort highest-first so commit order matches original execution semantics.
  const sorted = [...squeezes].sort((a, b) => (b.start ?? 0) - (a.start ?? 0))
  const originalNodesLength = session.surface.nodes.length

  const adjustments = []
  const failures = []
  // Surface-index intervals already planned; a later span may not overlap an
  // earlier one in original coordinates.
  const plannedSpans = []

  // ── Phase 1: validate + open brackets (synchronous) ─────────────────────
  // A foreign compaction must refuse the whole call before ANY bracket opens;
  // once our own brackets exist, a per-span check would trip on itself.
  const foreignCompaction = isCompactionActive(session)
  const pending = []
  for (const squeeze of sorted) {
    if (foreignCompaction) {
      failures.push('A compaction is already active. Wait for it to finish.')
      continue
    }
    if (!Number.isInteger(squeeze.start) || !Number.isInteger(squeeze.end)) {
      failures.push('Invalid squeeze entry (need integer start, end).')
      continue
    }
    if (squeeze.start < 1 || squeeze.end < squeeze.start) {
      failures.push(`Range ${squeeze.start}-${squeeze.end} is invalid.`)
      continue
    }

    const nodes = [...session.surface.nodes]
    if (squeeze.start > originalNodesLength || squeeze.end > originalNodesLength) {
      failures.push(`Range ${squeeze.start}-${squeeze.end} exceeds surface size (${originalNodesLength} messages when the call arrived).`)
      continue
    }

    let startIdx = squeeze.start - 1
    let endIdx = squeeze.end - 1

    // A previously planned span may have snapped outward into this range.
    // Trim this range around the intruder instead of dropping it: clamp the
    // start above any intruder's end (and the end below any intruder's start)
    // and snap within the free region. Only a fully consumed range drops.
    const intruders = plannedSpans.filter((s) => startIdx <= s.endIdx && endIdx >= s.startIdx)
    const floor = intruders.length > 0 ? Math.max(-1, ...intruders.map((s) => s.endIdx + 1)) : -1
    const ceiling = intruders.filter((s) => s.startIdx > startIdx).length > 0
      ? Math.min(nodes.length, ...intruders.filter((s) => s.startIdx > startIdx).map((s) => s.startIdx - 1))
      : nodes.length
    if (floor > endIdx || ceiling < startIdx) {
      failures.push(`Range ${squeeze.start}-${squeeze.end}: fully consumed by a neighboring span that expanded to balanced edges; skip it and squeeze the remainder on a later call.`)
      continue
    }
    if (floor > startIdx || ceiling < endIdx) {
      adjustments.push(`Range ${squeeze.start}-${squeeze.end} trimmed to fit neighboring spans (was ${startIdx + 1}-${endIdx + 1}).`)
      startIdx = Math.max(startIdx, floor)
      endIdx = Math.min(endIdx, ceiling)
    }

    const snappedStartIdx = snapStartBackward(session, nodes, startIdx, options.maxSnapSteps, floor > 0 ? floor : 0)
    if (snappedStartIdx === -1) {
      failures.push(`Range ${squeeze.start}-${squeeze.end}: no balanced start edge within ${options.maxSnapSteps} position(s) of ${squeeze.start}. Start the span just after a run of tool results instead.`)
      continue
    }
    const snappedEndIdx = snapEndForward(session, nodes, endIdx, options.maxSnapSteps, ceiling)
    if (snappedEndIdx === -1) {
      failures.push(`Range ${squeeze.start}-${squeeze.end}: no balanced end edge within ${options.maxSnapSteps} position(s) of ${squeeze.end}. End the span right after a completed block of tool results.`)
      continue
    }
    if (snappedStartIdx !== startIdx || snappedEndIdx !== endIdx) {
      adjustments.push(`Span ${squeeze.start}-${squeeze.end} expanded to ${snappedStartIdx + 1}-${snappedEndIdx + 1} (balanced-edge snap).`)
    }
    startIdx = snappedStartIdx
    endIdx = snappedEndIdx

    if (plannedSpans.some((s) => startIdx <= s.endIdx && endIdx >= s.startIdx)) {
      failures.push(`Range ${squeeze.start}-${squeeze.end}: still overlaps another span after trimming; skipped.`)
      continue
    }

    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
    const shadowedTokenCount = shadowedSeqs.reduce((sum, seq) => {
      const message = messageOf(session.events[seq])
      if (message !== undefined) return sum + tokenMeter.estimateMessage(message)
      return sum
    }, 0)

    // A checkpoint smaller than this floor costs more structure than it frees.
    if (shadowedTokenCount < options.minSpanTokens) {
      failures.push(`Range ${squeeze.start}-${squeeze.end}: shadowed content (~${shadowedTokenCount} tokens) is below the ${options.minSpanTokens}-token floor; too small to be worth a checkpoint. Use larger spans.`)
      continue
    }

    // Cheap-route summary input for the span.
    const spanText = shadowedSeqs
      .map((seq) => extractMessageText(session.events[seq]))
      .filter((text) => text.length > 0)
      .join('\n\n')
    if (spanText.trim().length === 0) {
      failures.push(`Range ${squeeze.start}-${squeeze.end}: no extractable text content in the span.`)
      continue
    }

    // Bound the summarizer input: a giant span would ship the whole history
    // to the cheap route (quota burn, context-limit failure, degraded output).
    const spanInputTokens = tokenMeter.estimateMessage({ content: [{ type: 'text', text: spanText }] })
    if (spanInputTokens > options.maxSpanInputTokens) {
      failures.push(`Range ${squeeze.start}-${squeeze.end}: span text (~${spanInputTokens} tokens) exceeds the summarizer input cap (${options.maxSpanInputTokens}); split it into smaller spans.`)
      continue
    }

    // The durable opening marker is the compaction lock: append it BEFORE any
    // summarizer yields, so a concurrent compaction refuses instead of racing
    // across an unbounded async window (same discipline as compactSurfaceRegion).
    const compactionId = CompactionId(crypto.randomUUID())
    const openTurn = findOpenTurn(session)
    const lifecycle = { compactionId, turn: openTurn, ...sourceCommandId === undefined ? {} : { sourceCommandId } }

    let startEvent
    try {
      startEvent = session.append('compaction/start', lifecycle)
    } catch (error) {
      failures.push(`Range ${squeeze.start}-${squeeze.end} failed to open compaction: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    plannedSpans.push({ startIdx, endIdx })
    pending.push({ squeeze, startIdx, endIdx, shadowedSeqs, shadowedTokenCount, spanText, compactionId, lifecycle, startEvent, summaryOutcome: null })
  }

  // ── Phase 2: bounded-parallel summarization ──────────────────────────────
  await runBounded(pending, options.summarizerConcurrency, async (task) => {
    task.summaryOutcome = await summarizeSpan(
      llm, options.summarizerProvider, options.summarizerModel,
      task.spanText, options.maxSummaryTokens, options.summarizerReasoningEffort, session, signal,
    )
  })

  // ── Phase 3: sequential commit; every opened bracket closes on every path ─
  let succeeded = 0
  let tokensShadowed = 0
  for (const task of pending) {
    const rangeLabel = `${task.squeeze.start}-${task.squeeze.end}`

    if (signal?.aborted) {
      session.append('compaction/end', { ...task.lifecycle, error: 'aborted before summarization completed' })
      failures.push('Aborted before this span was processed.')
      continue
    }
    if (!task.summaryOutcome.ok) {
      session.append('compaction/end', { ...task.lifecycle, error: `summarizer failed: ${task.summaryOutcome.error}` })
      failures.push(`Range ${rangeLabel}: summarizer failed (${task.summaryOutcome.error}).`)
      continue
    }
    const summaryText = task.summaryOutcome.summary

    // Post-await stability: if the surface moved during summarization, the
    // span's nodes may no longer all be live — refuse rather than replace blind.
    const liveNodes = new Set(session.surface.nodes)
    if (task.shadowedSeqs.some((seq) => !liveNodes.has(seq))) {
      session.append('compaction/end', { ...task.lifecycle, error: 'span left the surface during summarization' })
      failures.push(`Range ${rangeLabel}: the surface changed during summarization; the conversation is unchanged. Retry with fresh positions.`)
      continue
    }

    // Shrink guard: the checkpoint must be smaller than what it shadows.
    const checkpointMessage = createUserMessage({
      content: [{ type: 'text', text: summaryText }],
      source: compactCheckpointSource(task.compactionId, sourceCommandId),
    })
    const framedTokens = tokenMeter.estimateMessage(checkpointMessage)
    if (framedTokens >= task.shadowedTokenCount) {
      session.append('compaction/end', { ...task.lifecycle, error: 'summary not smaller than shadowed content' })
      failures.push(`Range ${task.startIdx + 1}-${task.endIdx + 1} summary (${framedTokens} tokens) is not smaller than the shadowed content (${task.shadowedTokenCount} tokens).`)
      continue
    }

    // Marker protocol: compaction/start -> compaction/summary -> user/message replace -> compaction/end
    try {
      const summaryEvent = session.append('compaction/summary', {
        compactionId: task.compactionId,
        ...sourceCommandId === undefined ? {} : { sourceCommandId },
        summary: [{ type: 'text', text: summaryText }],
        shadowedRange: { start: task.shadowedSeqs[0], end: task.shadowedSeqs[task.shadowedSeqs.length - 1] },
        shadowedSeqs: [...task.shadowedSeqs],
        shadowedTokenCount: task.shadowedTokenCount,
        provider: options.summarizerProvider,
        model: options.summarizerModel,
        llmStreamCall: true,
        rawOutput: [{ type: 'text', text: summaryText }],
        maxTokens: options.maxSummaryTokens,
      })

      session.append('user/message', checkpointMessage, {
        surfaceOp: { op: 'replace', start: task.shadowedSeqs[0], end: task.shadowedSeqs[task.shadowedSeqs.length - 1] },
        sourceEventSeqs: [task.startEvent.seq, summaryEvent.seq, ...task.shadowedSeqs],
      })

      session.append('compaction/end', task.lifecycle)
      succeeded += 1
      tokensShadowed += task.shadowedTokenCount
    } catch (innerError) {
      // Guarantee compaction/end even on failure; the error field is a string.
      const message = innerError instanceof Error ? innerError.message : String(innerError)
      session.append('compaction/end', { ...task.lifecycle, error: `${innerError?.name ?? 'Error'}: ${message}` })
      failures.push(`Range ${rangeLabel} failed: ${message}`)
    }
  }

  const parts = [
    `Squeezed ${succeeded} span(s) (~${tokensShadowed} tokens shadowed). Surface now ${session.surface.nodes.length} messages, ~${estimateSurfaceTokens(session, tokenMeter)} tokens.`,
  ]
  if (adjustments.length > 0) {
    parts.push('Adjustments:')
    for (const a of adjustments) parts.push(`  - ${a}`)
  }
  if (failures.length > 0) {
    parts.push(`${failures.length} span(s) failed:`)
    for (const f of failures) parts.push(`  - ${f}`)
  }
  return { result: parts.join('\n') }
}


// ── Argument parsing ────────────────────────────────────────────────────────

const USAGE = 'Usage: /squeeze [NNk | NN | status | help] — manual budget-targeted compression (no arguments = toward contextBudgetTokens)'

const HELP_TEXT = [
  '/squeeze — manual, budget-targeted context compression.',
  '',
  'WHAT IT DOES: shrinks this session\'s context toward a token budget. The',
  'conversation model only picks which spans to compress; a configured cheap',
  'route (summarizerProvider/summarizerModel in the preset config) writes the',
  'checkpoint summaries, so compression does not cost the expensive model\'s',
  'prices. Everything trimmed stays recoverable in the session log.',
  '',
  'COMMANDS:',
  '  /squeeze           squeeze toward contextBudgetTokens (preset config)',
  '  /squeeze 60k       one-off target override (also plain: /squeeze 60000)',
  '  /squeeze status    read-only: messages, tokens, budget, summarizer',
  '  /squeeze help      this text',
  '',
  'HOW TO USE: run it YOURSELF, in the session you want to shrink, when the',
  'session is idle (it refuses while an agent turn is in flight). After',
  'invocation the model reviews its context and calls context_squeeze once',
  'with position ranges; the summarizer route writes the checkpoints. You do',
  'not dispatch any agents — summary delegation is built in.',
  '',
  'TIP: run it when the session is "dry" (idle several minutes) so the prompt',
  'cache it breaks has already expired.',
].join('\n')

/**
 * Parse raw input: empty = budget target, NNk/NN = token override, status, help.
 */
function parseArgs(raw) {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { target: null, status: false, help: false, error: null }
  }
  if (trimmed.toLowerCase() === 'status') {
    return { target: null, status: true, help: false, error: null }
  }
  if (trimmed.toLowerCase() === 'help' || trimmed === '-h' || trimmed === '--help') {
    return { target: null, status: false, help: true, error: null }
  }
  const tokenKMatch = trimmed.match(/^(\d+)[kK]$/)
  if (tokenKMatch !== null) {
    const tokens = parseInt(tokenKMatch[1], 10) * 1000
    if (tokens < 1) return { target: null, status: false, error: 'Invalid token target. Usage: /squeeze NNk (e.g. 100k).' }
    return { target: tokens, status: false, help: false, error: null }
  }
  const tokenMatch = trimmed.match(/^(\d+)$/)
  if (tokenMatch !== null) {
    const tokens = parseInt(tokenMatch[1], 10)
    if (tokens < 1) return { target: null, status: false, error: 'Invalid token target. Usage: /squeeze NN (tokens) or NNk.' }
    return { target: tokens, status: false, help: false, error: null }
  }
  return { target: null, status: false, help: false, error: `Unknown argument "${trimmed}". ${USAGE}` }
}

// ── Plugin exports ──────────────────────────────────────────────────────────

export const name = 'squeeze-command'
export const inject = ['commands', 'tokenMeter', 'tools', 'systemPrompt']

export function apply(ctx, config = {}) {
  const contextBudgetTokens = config.contextBudgetTokens ?? null
  const summarizerProvider = config.summarizerProvider ?? null
  const summarizerModel = config.summarizerModel ?? null
  const maxSummaryTokens = config.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS
  const minSpanTokens = config.minSpanTokens ?? DEFAULT_MIN_SPAN_TOKENS
  const maxSnapSteps = config.maxSnapSteps ?? DEFAULT_MAX_SNAP_STEPS
  const maxSpanInputTokens = config.maxSpanInputTokens ?? DEFAULT_MAX_SPAN_INPUT_TOKENS
  const summarizerReasoningEffort = config.summarizerReasoningEffort === undefined
    ? DEFAULT_SUMMARIZER_EFFORT
    : config.summarizerReasoningEffort
  const summarizerConcurrency = config.summarizerConcurrency ?? DEFAULT_SUMMARIZER_CONCURRENCY

  // Misconfiguration fails loud at load: non-positive numeric fields have no
  // meaningful reading and would surface later as confusing per-span failures.
  for (const [field, value] of [
    ['maxSummaryTokens', maxSummaryTokens],
    ['minSpanTokens', minSpanTokens],
    ['maxSnapSteps', maxSnapSteps],
    ['maxSpanInputTokens', maxSpanInputTokens],
    ['summarizerConcurrency', summarizerConcurrency],
    ...(contextBudgetTokens !== null ? [['contextBudgetTokens', contextBudgetTokens]] : []),
  ]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`squeeze-command config: ${field} must be a positive integer (got ${JSON.stringify(value)})`)
    }
  }

  const summarizerConfigured = summarizerProvider !== null && summarizerModel !== null

  // Per-session squeeze mode: Map<sessionId, { squeezeMode, sourceCommandId }>
  const squeezeModes = new Map()

  // Register the context_squeeze tool (lazy visibility via assemble listener)
  ctx.effect(() => ctx.tools.register({
    name: 'context_squeeze',
    description: 'Squeeze spans of your conversation context into summaries written by a separate summarizer. Call ONCE with all spans in the squeezes array. You provide ONLY position ranges; do not write summaries yourself. Positions are 1-based message numbers counting every message, including each individual tool result. Edges are auto-adjusted to safe boundaries when needed.',
    parameters: {
      type: 'object',
      properties: {
        squeezes: {
          type: 'array',
          description: 'All spans to squeeze, in one call.',
          items: {
            type: 'object',
            properties: {
              start: { type: 'number', description: 'Position number of the first message to squeeze (1-based).' },
              end: { type: 'number', description: 'Position number of the last message to squeeze (1-based).' },
            },
            required: ['start', 'end'],
          },
        },
      },
      required: ['squeezes'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string' } }, required: ['result'] },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    execute: async (args, exec) => executeContextSqueeze(args, exec, ctx, squeezeModes, {
      summarizerProvider,
      summarizerModel,
      maxSummaryTokens,
      minSpanTokens,
      maxSnapSteps,
      maxSpanInputTokens,
      summarizerReasoningEffort,
      summarizerConcurrency,
    }),
  }))

  // Lazy visibility: filter context_squeeze out of the tool schema unless squeeze mode is active
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const sessionId = context.agent?.session?.id
    const mode = sessionId !== undefined ? squeezeModes.get(sessionId) : undefined
    if (!mode?.squeezeMode) {
      return { ...assembled, tools: assembled.tools.filter((t) => t.name !== 'context_squeeze') }
    }
    return assembled
  })

  // Turn-end cleanup: clear squeeze mode after the model's turn
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      squeezeModes.delete(session.id)
    }
  })

  // Register the /squeeze slash command
  ctx.commands.register({
    name: 'squeeze',
    description: 'Manual budget-targeted context compression; summaries written by a cheap route. Usage: /squeeze [NNk|NN|status|help]',
    input: { hint: '[NNk|NN|status|help]' },
    handler: async (invocation) => {
      const { target, status, help, error } = parseArgs(invocation.rawInput)
      if (error !== null) return { kind: 'error', text: error }

      const session = invocation.agent.session

      if (help) {
        return { kind: 'success', text: HELP_TEXT }
      }

      if (status) {
        const tokens = estimateSurfaceTokens(session, ctx.tokenMeter)
        const messages = session.surface.nodes.length
        if (contextBudgetTokens === null) {
          return { kind: 'success', text: `Surface: ${messages} messages, ~${tokens} tokens. (No contextBudgetTokens configured; /squeeze requires an explicit target.)` }
        }
        const relation = tokens <= contextBudgetTokens
          ? `under budget (${contextBudgetTokens} by ${contextBudgetTokens - tokens})`
          : `OVER budget by ${tokens - contextBudgetTokens} (budget ${contextBudgetTokens})`
        const summarizerLine = summarizerConfigured
          ? `Summarizer: ${summarizerProvider}/${summarizerModel}`
          : 'Summarizer: NOT configured — set summarizerProvider/summarizerModel before squeezing'
        return { kind: 'success', text: `Surface: ${messages} messages, ~${tokens} tokens — ${relation}. ${summarizerLine}. Read-only; nothing was changed.` }
      }

      // Manual-only guardrails: refuse while a turn is open or a compaction is active.
      if (findOpenTurn(session) !== null) {
        return { kind: 'error', text: 'An agent turn is currently in flight. Squeeze is manual-only — run /squeeze again once the agent is idle.' }
      }
      if (isCompactionActive(session)) {
        return { kind: 'error', text: 'A compaction is currently active. Wait for it to finish before squeezing.' }
      }

      const targetTokens = target ?? contextBudgetTokens
      if (targetTokens === null) {
        return { kind: 'error', text: 'No token target: pass one explicitly (/squeeze 100k) or set contextBudgetTokens in the preset config.' }
      }
      if (!summarizerConfigured) {
        return { kind: 'error', text: 'No summarizer route configured: set summarizerProvider and summarizerModel in the preset config (a cheap fast route — a flash-tier model is recommended).' }
      }

      const currentTokens = estimateSurfaceTokens(session, ctx.tokenMeter)
      if (currentTokens <= targetTokens) {
        return { kind: 'success', text: `Already under target: ~${currentTokens} tokens, target ${targetTokens}. Nothing to squeeze.` }
      }

      squeezeModes.set(session.id, { squeezeMode: true, sourceCommandId: invocation.commandId })
      const triggerMessage = createUserMessage({
        content: [{ type: 'text', text: buildTriggerPrompt(session, ctx.tokenMeter, targetTokens) }],
        source: { kind: 'plugin', plugin: 'squeeze-command' },
      })
      invocation.agent.followup(triggerMessage)
      return { kind: 'success', text: `Squeeze mode activated (target ${targetTokens} tokens, ~${currentTokens} now; summaries via ${summarizerProvider}/${summarizerModel}). The model will pick ranges; the summarizer writes the checkpoints.` }
    },
  })
}
