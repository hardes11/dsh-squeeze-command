/**
 * Standalone behavior smoke for dsh-squeeze-command.
 * Builds real Session objects and drives the registered command/tool handlers
 * through a mock ctx with a deterministic fake summarizer stream — no LLM
 * needed. Run from this directory:
 *   node smoke.mjs
 * Exits nonzero on any failure. Kept as the package's regression harness.
 */
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CallId, createUserMessage, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { apply } from './lib/index.js'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok  ${name}`) }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// Deterministic stub meter: ~4 chars/token on JSON length.
const tokenMeter = {
  estimateMessage: (m) => Math.max(1, Math.ceil(JSON.stringify(m?.content ?? m ?? '').length / 4)),
}

// Deterministic fake summarizer: returns a short dense summary.
const fakeSummary = 'Summary: the user asked for work; bash ran; output recorded; paths and errors preserved.'
function makeLlm(failStream = false, emptySummary = false, finishKind = undefined, summary = fakeSummary) {
  return {
    stream: async function* (options) {
      if (failStream) {
        yield { type: 'finish', reason: { kind: 'error', message: 'boom' } }
        return
      }
      yield { type: 'text-delta', text: emptySummary ? '' : summary }
      yield { type: 'finish', ...(finishKind !== undefined ? { reason: { kind: finishKind } } : {}) }
    },
  }
}

function makeCtx(config = {}, llm = makeLlm()) {
  const registered = { tools: [], commands: [] }
  const listeners = {}
  const ctx = {
    effect: (fn) => fn(),
    on: (evt, handler) => { (listeners[evt] ??= []).push(handler) },
    get: (name) => (name === 'llm' ? llm : undefined),
    tokenMeter,
    tools: { register: (def) => registered.tools.push(def) },
    commands: { register: (cmd) => registered.commands.push(cmd) },
  }
  apply(ctx, config)
  ctx.registered = registered
  ctx.listeners = listeners
  return { ctx, registered, listeners }
}

const FULL_CONFIG = {
  contextBudgetTokens: 1000,
  summarizerProvider: 'test-provider',
  summarizerModel: 'test-flash',
}

/** N closed tool turns; each turn = [user, assistant(tool-call), tool-result]. */
function toolConversation(nTurns, resultChars = 900, openTail = false) {
  const session = Session.create(SessionId('smoke'))
  session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' } }, reason: 'initial' })
  for (let turn = 1; turn <= nTurns; turn += 1) {
    const callId = CallId(`call-${turn}`)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request ${turn} `.repeat(40) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `calling ${turn} ` },
          { type: 'tool-call', id: callId, name: 'bash', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `R${turn}-`.repeat(resultChars) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  if (openTail) session.append('turn/start', { turn: nTurns + 1 })
  return session
}

const execFor = (session, signal) => ({ agent: { session }, signal })

async function runTool(ctx, session, squeezes, opts = {}) {
  const controller = new AbortController()
  if (opts.abort) controller.abort()
  const tool = ctx.registered.tools.find((t) => t.name === 'context_squeeze')
  return tool.execute({ squeezes }, execFor(session, controller.signal))
}

async function runCommand(ctx, session, rawInput, opts = {}) {
  let followedUp = null
  const agent = { session, followup: (m) => { followedUp = m } }
  const cmd = ctx.registered.commands.find((c) => c.name === 'squeeze')
  const out = await cmd.handler({ rawInput, agent, signal: new AbortController().signal, commandId: opts.commandId ?? 'cmd-1' })
  return { out, followedUp }
}

// ── Q1: balanced range applies, summary written by the summarizer ─────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3)
  const sizeBefore = session.surface.nodes.length // 9
  check('Q1 surface size is 9', sizeBefore === 9, String(sizeBefore))

  // Positions 5-6 = [assistant(tool-call), its result] — legal span, no snap.
  const res = await runTool(ctx, session, [{ start: 5, end: 6 }])
  const text = res.result
  check('Q1 balanced range applies cleanly', text.includes('Squeezed 1 span(s)') && !text.includes('expanded to'), text)
  check('Q1 surface shrank by 1', session.surface.nodes.length === sizeBefore - 1, String(session.surface.nodes.length))
  // The checkpoint carries the fake summarizer's text, not a model summary.
  const checkpointSeq = session.surface.nodes.find((seq) => {
    const e = session.events[seq]
    return e?.type === 'user/message' && JSON.stringify(e.data?.content ?? '').includes('Summary: the user asked')
  })
  check('Q1 checkpoint text came from summarizer', checkpointSeq !== undefined)
  // compaction/summary records the flash route as provider/model.
  const summaryEvents = session.events.filter((e) => e?.type === 'compaction/summary')
  check('Q1 compaction/summary attributes flash route',
    summaryEvents.length === 1
      && summaryEvents[0].data.provider === 'test-provider'
      && summaryEvents[0].data.model === 'test-flash',
    JSON.stringify(summaryEvents.map((e) => e.data.model)))
  // Marker protocol closed.
  const starts = session.events.filter((e) => e?.type === 'compaction/start').length
  const ends = session.events.filter((e) => e?.type === 'compaction/end').length
  check('Q1 compaction lifecycle closed', starts === 1 && ends === 1, `${starts}/${ends}`)
}

// ── Q2: pair-straddling edges snap outward on both sides ──────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3)
  // Range 6-8 = [r2, u3, a3]: starts mid-pair, ends on open-call assistant.
  // Both edges must snap: -> [a2 .. r3] = positions 5-9.
  const res = await runTool(ctx, session, [{ start: 6, end: 8 }])
  check('Q2 snapped both edges', res.result.includes('expanded to 5-9') && res.result.includes('Squeezed 1 span(s)'), res.result)
  check('Q2 surface shrank by 4', session.surface.nodes.length === 5, String(session.surface.nodes.length))
}

// ── Q3: overlap rejection in original coordinates ─────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3)
  const res = await runTool(ctx, session, [
    { start: 7, end: 9 },
    { start: 4, end: 8 },
  ])
  check('Q3 one applied, intruder consumed', res.result.includes('Squeezed 1 span(s)') && /consumed by a neighboring span/.test(res.result), res.result)
}

// ── Q4: min-span floor ────────────────────────────────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3, 20) // tiny results -> every node small
  const res = await runTool(ctx, session, [{ start: 4, end: 6 }])
  check('Q4 floor rejects tiny span', /below the 200-token floor/.test(res.result), res.result)
}

// ── Q5: empty squeezes + abort ────────────────────────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  check('Q5 empty squeezes', (await runTool(ctx, toolConversation(1), [])).result === 'No squeezes provided.')
  const res = await runTool(ctx, toolConversation(3), [{ start: 4, end: 6 }], { abort: true })
  check('Q5 abort honored', res.result.includes('Aborted'), res.result)
}

// ── Q6: summarizer failure surfaces, nothing applied ──────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG, makeLlm(true))
  const session = toolConversation(3)
  const res = await runTool(ctx, session, [{ start: 5, end: 6 }])
  check('Q6 summarizer failure reported', /summarizer failed/.test(res.result), res.result)
  check('Q6 nothing applied', session.surface.nodes.length === 9, String(session.surface.nodes.length))
}

// ── Q7: active-turn guard refuses command ─────────────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3, 900, true) // open tail turn
  const { out, followedUp } = await runCommand(ctx, session, '')
  check('Q7 refuses while turn in flight', out.kind === 'error' && /in flight/.test(out.text), out.text)
  check('Q7 no followup sent', followedUp === null)
}

// ── Q8: already under target is a no-op ───────────────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3) // ~? tokens with budget 1000; force generous budget instead
  const { out, followedUp } = await runCommand(ctx, session, '999999')
  check('Q8 under target no-op', out.kind === 'success' && /Already under target/.test(out.text), out.text)
  check('Q8 no followup sent', followedUp === null)
}

// ── Q9: missing summarizer config fails loud ──────────────────────────────
{
  const { ctx } = makeCtx({ contextBudgetTokens: 1000 }) // no summarizer
  const session = toolConversation(3)
  const { out } = await runCommand(ctx, session, '100')
  check('Q9 missing summarizer errors', out.kind === 'error' && /summarizerProvider/.test(out.text), out.text)
}

// ── Q10: /squeeze status is read-only and complete ────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3)
  const nodesBefore = session.surface.nodes.length
  const { out } = await runCommand(ctx, session, 'status')
  check('Q10 status reports budget relation', /tokens/.test(out.text) && /(under|OVER) budget/.test(out.text), out.text)
  check('Q10 status reports summarizer', out.text.includes('test-provider/test-flash'), out.text)
  check('Q10 status changed nothing', session.surface.nodes.length === nodesBefore)
  // Status works even with a turn open (read-only).
  const open = toolConversation(3, 900, true)
  const openOut = await runCommand(ctx, open, 'status')
  check('Q10 status works with open turn', openOut.out.kind === 'success', openOut.out.text)
}

// ── Q11: trigger prompt contract ──────────────────────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3)
  const { followedUp } = await runCommand(ctx, session, '')
  const text = followedUp?.content?.[0]?.text ?? ''
  check('Q11 one-call discipline stated', text.includes('EXACTLY ONCE'), '')
  check('Q11 ranges-only stated', /ONLY the position ranges|summaries will be written for you/.test(text), text.slice(0, 200))
  check('Q11 target stated', text.includes('under 1000 tokens'), text.slice(0, 160))
  check('Q11 counting rule stated', text.includes('EACH individual tool result'), '')
}

// ── Q12: lazy visibility filter ───────────────────────────────────────────
{
  const { ctx, listeners } = makeCtx(FULL_CONFIG)
  const handler = listeners['system-prompt/assemble'][0]
  const assembly = { tools: [{ name: 'context_squeeze' }, { name: 'read' }] }
  const out = await handler(assembly, {}, async () => assembly)
  check('Q12 tool hidden by default', out.tools.length === 1 && out.tools[0].name === 'read', JSON.stringify(out.tools))
}

// ── Q13: empty-summary summarizer is rejected ─────────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG, makeLlm(false, true))
  const session = toolConversation(3)
  const res = await runTool(ctx, session, [{ start: 5, end: 6 }])
  check('Q13 empty summary rejected', /empty summary/.test(res.result), res.result)
  check('Q13 nothing applied', session.surface.nodes.length === 9, String(session.surface.nodes.length))
}

// ── Q14: max-tokens-truncated summary fails closed ────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG, makeLlm(false, false, 'length'))
  const session = toolConversation(3)
  const res = await runTool(ctx, session, [{ start: 5, end: 6 }])
  check('Q14 truncation fails closed', /truncated at the .*-token cap/.test(res.result), res.result)
  const starts = session.events.filter((e) => e?.type === 'compaction/start').length
  const ends = session.events.filter((e) => e?.type === 'compaction/end').length
  check('Q14 opened compaction closed with error', starts === 1 && ends === 1
    && typeof session.events.find((e) => e?.type === 'compaction/end')?.data?.error === 'string', '')
  check('Q14 nothing applied', session.surface.nodes.length === 9, String(session.surface.nodes.length))
}

// ── Q15: unbounded summarizer input is rejected before the call ───────────
{
  let streamCalls = 0
  const llm = { stream: async function* () { streamCalls += 1; yield { type: 'finish' } } }
  const { ctx } = makeCtx(FULL_CONFIG, llm)
  const session = toolConversation(40, 3000) // huge span text
  const res = await runTool(ctx, session, [{ start: 5, end: 100 }])
  check('Q15 input cap rejects giant span', /exceeds the summarizer input cap/.test(res.result), res.result.slice(0, 200))
  check('Q15 summarizer never called', streamCalls === 0, String(streamCalls))
}

// ── Q16: mid-turn tool execution records the open turn ────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3, 900, true) // turn 4 open
  const res = await runTool(ctx, session, [{ start: 5, end: 6 }])
  check('Q16 mid-turn squeeze applies', res.result.includes('Squeezed 1 span(s)'), res.result)
  const startEvent = session.events.find((e) => e?.type === 'compaction/start')
  check('Q16 lifecycle carries open turn', startEvent?.data?.turn === 4, JSON.stringify(startEvent?.data))
}

// ── Q17: shrink guard fires and closes the compaction ─────────────────────
{
  const huge = 'X'.repeat(40000) // far more tokens than the shadowed span
  const { ctx } = makeCtx(FULL_CONFIG, makeLlm(false, false, undefined, huge))
  const session = toolConversation(3, 200)
  const res = await runTool(ctx, session, [{ start: 5, end: 6 }])
  check('Q17 shrink guard rejects', /not smaller than the shadowed content/.test(res.result), res.result)
  const ends = session.events.filter((e) => e?.type === 'compaction/end')
  check('Q17 guard path closed with string error', ends.length === 1 && typeof ends[0].data.error === 'string', JSON.stringify(ends[0]?.data?.error))
}

// ── Q18: two successful disjoint spans, highest-first ──────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(4)
  const res = await runTool(ctx, session, [
    { start: 2, end: 3 },
    { start: 8, end: 9 },
  ])
  check('Q18 both spans applied', res.result.includes('Squeezed 2 span(s)'), res.result)
  check('Q18 surface shrank by 2', session.surface.nodes.length === 10, String(session.surface.nodes.length))
  const summaries = session.events.filter((e) => e?.type === 'compaction/summary')
  check('Q18 summary events carry stream provenance', summaries.length === 2
    && summaries.every((e) => e.data.llmStreamCall === true && e.data.maxTokens === 2048
      && Array.isArray(e.data.rawOutput)), '')
}

// ── Q19: tool stays visible while squeeze mode is active; turn/end clears ─
{
  const { ctx, listeners } = makeCtx(FULL_CONFIG)
  const session = toolConversation(3)
  // Activate via the command (target below current tokens).
  const agent = { session, followup: () => {} }
  const cmd = ctx.registered.commands.find((c) => c.name === 'squeeze')
  await cmd.handler({ rawInput: '10', agent, signal: new AbortController().signal, commandId: 'cmd-q19' })
  const handler = listeners['system-prompt/assemble'][0]
  const assembly = { tools: [{ name: 'context_squeeze' }, { name: 'read' }] }
  const context = { agent: { session } }
  const out = await handler(assembly, context, async () => assembly)
  check('Q19 tool visible while active', out.tools.length === 2, JSON.stringify(out.tools))
  // turn/end clears the mode.
  const sessionHandler = listeners['session/event'][0]
  sessionHandler(session, { type: 'turn/end', turn: 1 })
  const out2 = await handler(assembly, context, async () => assembly)
  check('Q19 mode cleared at turn end', out2.tools.length === 1 && out2.tools[0].name === 'read', JSON.stringify(out2.tools))
}

// ── Q20: /squeeze help ────────────────────────────────────────────────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(1)
  const { out } = await runCommand(ctx, session, 'help')
  check('Q20 help prints guide', out.kind === 'success' && out.text.includes('HOW TO USE') && out.text.includes('/squeeze status'), out.text.slice(0, 80))
  check('Q20 help changed nothing', session.surface.nodes.length === 3, String(session.surface.nodes.length))
}

// ── Q21: parallel spans run concurrently (bounded) ─────────────────────────
{
  // Track concurrent stream calls: 3 spans with 40ms summaries must overlap
  // under concurrency 3 (wall time < 3x40ms) and never exceed 3 in flight.
  let inFlight = 0
  let maxInFlight = 0
  const llm = { stream: async function* () {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 40))
    yield { type: 'text-delta', text: 'Summary: user asked; bash ran; output recorded; preserved.' }
    yield { type: 'finish' }
    inFlight -= 1
  } }
  const { ctx } = makeCtx(FULL_CONFIG, llm)
  const session = toolConversation(5)
  const t0 = Date.now()
  const res = await runTool(ctx, session, [
    { start: 2, end: 3 },
    { start: 5, end: 6 },
    { start: 8, end: 9 },
  ])
  const elapsed = Date.now() - t0
  check('Q21 three spans applied', res.result.includes('Squeezed 3 span(s)'), res.result)
  check('Q21 summarizer calls overlapped', maxInFlight === 3, `max in flight ${maxInFlight}`)
  check('Q21 wall time bounded by concurrency', elapsed < 100, `${elapsed}ms`)
}

// ── Q22: snap-expanded neighbor trims instead of dropping the span ────────
{
  const { ctx } = makeCtx(FULL_CONFIG)
  const session = toolConversation(4)
  // Sorted highest-first: {3,3} is r1, snaps backward to a1..r1 (positions
  // 2-3, planned idx 1..2). {2,6} intersects at idx 1: trimmed to 4-6 and
  // still applied — NOT dropped.
  const res = await runTool(ctx, session, [
    { start: 3, end: 3 },
    { start: 2, end: 6 },
  ])
  check('Q22 both spans applied after trim', res.result.includes('Squeezed 2 span(s)'), res.result)
  check('Q22 trim noted', /trimmed to fit neighboring spans/.test(res.result), res.result)
  check('Q22 surface shrank by 3', session.surface.nodes.length === 9, String(session.surface.nodes.length))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
