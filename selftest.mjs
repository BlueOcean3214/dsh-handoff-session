import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

const temp = await mkdtemp(join(tmpdir(), 'session-handoff-test-'))
const cleanup = []

let projection
let tool
let pressureContext
let policySection
let concluded = false
let createdRequest
let promptedRequest
// Two independent facts, exactly like the Host: an Agent can stay attached to
// this process after its stored log directory was deleted.
const liveSessions = new Set()
const persistedSessions = new Set()
let createdCount = 0
let queryAvailable = true
let persistenceAvailable = true

const state = {
  turn: 22,
  step: 677,
  contextWindow: 128000,
  lastInputTokens: 31200,
  totalTokens: 55_500_000,
  inputTokens: 56_000_000,
  cacheReadTokens: 54_880_000,
  handoffPending: [],
  handoffSucceeded: false,
}

const session = {
  id: 'old-session-1',
  header: { version: 1, createdAt: Date.now(), cwd: temp, isSeeded: false, agentPreset: 'desktop' },
  snapshotEvents() {
    return [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please ship the handoff plugin.' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Installing the bundle now.' }] } } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"node selftest.mjs"}' } },
      { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'selftest: ok' }] } } },
    ]
  },
}

const ctx = {
  effect(setup) {
    const disposer = setup()
    cleanup.push(disposer)
    return disposer
  },
  logger: { warn() {} },
  sessionProjections: {
    register(definition) {
      projection = definition
      return () => {}
    },
    stateOf(_session, key) {
      assert.equal(key, 'sessionHandoffPressure')
      return state
    },
  },
  systemPrompt: {
    section(section) {
      policySection = section
      return () => {}
    },
    context(context) {
      pressureContext = context
      return () => {}
    },
  },
  tools: {
    register(definition) {
      tool = definition
      return () => {}
    },
  },
  workspaceRegistry: { list: () => [] },
  agents: { currentInitiator: () => undefined },
  // Host services the durability probe reaches through ctx.get: optional, so
  // the fallback chain stays testable by switching them off.
  sessionQuery: {
    async listSessions() {
      const ids = [...new Set([...persistedSessions, ...liveSessions])]
      return ids.map((id) => ({
        header: { id, createdAt: 0, cwd: temp },
        live: liveSessions.has(id),
        persisted: persistedSessions.has(id),
      }))
    },
  },
  sessionPersistence: {
    async stat(sessionId) {
      return persistedSessions.has(sessionId) ? { header: { id: sessionId }, revision: 'r1' } : undefined
    },
  },
  get(name) {
    if (name === 'sessionQuery' && queryAvailable) return ctx.sessionQuery
    if (name === 'sessionPersistence' && persistenceAvailable) return ctx.sessionPersistence
    return undefined
  },
  sessionController: {
    // The real contract reports domain failures as { error }, never as a throw.
    async resolveAgent(sessionId) {
      if (!liveSessions.has(sessionId)) return { error: { code: 'session/not-found', message: `session "${sessionId}" not found` } }
      return { agent: { id: sessionId } }
    },
    async create(request) {
      createdRequest = request
      const sessionId = `new-session-${++createdCount}`
      liveSessions.add(sessionId)
      persistedSessions.add(sessionId)
      return { sessionId, agentPreset: request.agentPreset }
    },
    async prompt(request, signal) {
      assert.equal(signal.aborted, false)
      promptedRequest = request
      return { accepted: true }
    },
  },
}

apply(ctx, {})
assert.ok(projection, 'projection registered')
assert.ok(tool, 'tool registered')
assert.ok(policySection, 'policy section registered')
assert.ok(pressureContext, 'pressure context registered')
assert.equal(tool.name, 'session_handoff')
assert.ok(tool.output.schema.properties.transcriptPath, 'output schema declares transcriptPath')
assert.ok(tool.output.schema.required.includes('transcriptPath'), 'output schema requires transcriptPath')
assert.deepEqual(tool.output.presentationMeta({}, { newSessionId: 'new-session-1', handoffPath: 'x', transcriptPath: 'y' }), {
  newSessionId: 'new-session-1',
  handoffPath: 'x',
  transcriptPath: 'y',
})

// Fold a few durable events through the projection.
let folded = projection.init(session.header, 0)
folded = projection.apply(folded, { type: 'turn/start', data: { turn: 1 } })
folded = projection.apply(folded, { type: 'step/start', data: { turn: 1, step: 1 } })
folded = projection.apply(folded, { type: 'step/start', data: { turn: 1, step: 2 } })
folded = projection.apply(folded, { type: 'step/start', data: { turn: 1, step: 3 } })
folded = projection.apply(folded, { type: 'request/context', data: { contextWindow: 128000 } })
folded = projection.apply(folded, {
  type: 'assistant/message',
  data: { usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800 } },
})
assert.equal(folded.turn, 1)
assert.equal(folded.step, 3)
assert.equal(folded.contextWindow, 128000)
assert.equal(folded.lastInputTokens, 1800)
assert.equal(folded.inputTokens, 1800)
assert.equal(folded.totalTokens, 2000)
assert.equal(folded.cacheReadTokens, 800)

// A successful tool result flips the handoff flag; a failed one does not.
folded = projection.apply(folded, { type: 'tool/call', data: { name: 'session_handoff', callId: 'call-1' } })
assert.deepEqual(folded.handoffPending, ['call-1'])
folded = projection.apply(folded, { type: 'tool/result', data: { error: { name: 'x' }, message: { toolCallId: 'call-1' } } })
assert.equal(folded.handoffSucceeded, false)
folded = projection.apply(folded, { type: 'tool/call', data: { name: 'session_handoff', callId: 'call-2' } })
folded = projection.apply(folded, { type: 'tool/result', data: { message: { toolCallId: 'call-2' }, meta: { newSessionId: 'new-session-1' } } })
assert.equal(folded.handoffSucceeded, true)
assert.equal(folded.newSessionId, 'new-session-1')

// The model-facing context reflects "recommended" at 22 turns / 677 steps.
const pressure = pressureContext.text({ agent: { session } })
assert.match(pressure, /<session-pressure /)
assert.match(pressure, /turn="22"/)
assert.match(pressure, /step="677"/)
assert.match(pressure, /level: recommended/)
assert.match(pressure, /handoff: recommended/)
assert.match(pressure, /cache_read="98%"/)

const policy = policySection.text
assert.match(policy, /session_handoff/)
assert.match(policy, /recommended at turn 20/)

// Exercise the full handoff.
const result = await tool.execute(
  {
    goal: 'Ship the session handoff plugin.',
    summary: 'Host half is implemented; install and integration verification remain.',
    completed: ['Registered projection, policy section, context block, and tool.'],
    remaining: ['Install the bundle.', 'Run an end-to-end handoff in the desktop app.'],
    decisions: ['Host-only; no Client half in v1.'],
    files: ['index.js` with a backtick inside', 'cordis.patch.yml'],
    verification: ['node --check index.js'],
    nextPrompt: 'Install the bundle, then start a session and call session_handoff.\n\n```bash\nnode selftest.mjs\n```',
  },
  {
    agent: { session },
    signal: new AbortController().signal,
    concludeTurn() {
      concluded = true
    },
  },
)

assert.equal(result.status, 'created')
assert.equal(result.newSessionId, 'new-session-1')
assert.ok(result.transcriptPath, 'transcript sidecar path returned')
assert.equal(concluded, true)
assert.equal(createdRequest.cwd, temp)
assert.equal(createdRequest.agentPreset, 'desktop')
assert.equal(promptedRequest.sessionId, 'new-session-1')
assert.equal(promptedRequest.mode, 'queue')
assert.ok(promptedRequest.requestId)
assert.match(promptedRequest.content[0].text, /请先阅读交接文档/)
assert.match(promptedRequest.content[0].text, /完整转录/)
assert.match(promptedRequest.content[0].text, /Install the bundle/)

const markdown = await readFile(result.handoffPath, 'utf8')
assert.match(markdown, /# 会话交接文档/)
assert.match(markdown, /轮次 \/ 步数: 22 \/ 677/)
assert.match(markdown, /## 已完成/)
assert.match(markdown, /## 继续指令/)
assert.match(markdown, /## 完整转录/)
assert.match(markdown, /````text/, 'fence grows past inner backticks')

const transcript = await readFile(result.transcriptPath, 'utf8')
assert.match(transcript, /Please ship the handoff plugin/)
assert.match(transcript, /Installing the bundle now/)
assert.match(transcript, /selftest: ok/)

// The same old Session is idempotent while the recorded Session is durable.
const again = await tool.execute(
  { summary: 'again', nextPrompt: 'again' },
  { agent: { session }, signal: new AbortController().signal, concludeTurn() {} },
)
assert.equal(again.status, 'reused')
assert.equal(again.newSessionId, 'new-session-1')

// forceNew bypasses reuse even when the recorded Session is still durable.
const forced = await tool.execute(
  { summary: 'forced', nextPrompt: 'forced', forceNew: true },
  { agent: { session }, signal: new AbortController().signal, concludeTurn() {} },
)
assert.equal(forced.status, 'created')
assert.equal(forced.newSessionId, 'new-session-2')

// The regression this version fixes: the stored log of the recorded Session is
// deleted while its Agent stays attached to the process. Reuse would strand the
// user in a conversation that cannot survive a restart, so a replacement is
// created without asking for forceNew.
persistedSessions.delete('new-session-2')
assert.ok(liveSessions.has('new-session-2'), 'the stale Session is still live in memory')
const recreated = await tool.execute(
  { summary: 'recreated', nextPrompt: 'recreated' },
  { agent: { session }, signal: new AbortController().signal, concludeTurn() {} },
)
assert.equal(recreated.status, 'created')
assert.equal(recreated.newSessionId, 'new-session-3')
assert.match(recreated.message, /Replaced: new-session-2/)
assert.match(recreated.message, /stored log is gone/)

// A recorded Session that is neither live nor stored is replaced as well.
liveSessions.clear()
persistedSessions.delete('new-session-3')
const recovered = await tool.execute(
  { summary: 'recovered', nextPrompt: 'recovered' },
  { agent: { session }, signal: new AbortController().signal, concludeTurn() {} },
)
assert.equal(recovered.status, 'created')
assert.equal(recovered.newSessionId, 'new-session-4')
assert.match(await readFile(recovered.handoffPath, 'utf8'), /recovered/)

// Fallback 1: without sessionQuery the live-Agent probe decides, and its
// { error } answer now counts as a dead Session.
queryAvailable = false
persistenceAvailable = false
liveSessions.delete('new-session-4')
persistedSessions.delete('new-session-4')
const errorProbe = await tool.execute(
  { summary: 'error probe', nextPrompt: 'error probe' },
  { agent: { session }, signal: new AbortController().signal, concludeTurn() {} },
)
assert.equal(errorProbe.status, 'created')
assert.equal(errorProbe.newSessionId, 'new-session-5')
assert.match(errorProbe.message, /Replaced: new-session-4/)
assert.match(errorProbe.message, /resolveAgent reported/)

// Fallback 2: persistence.stat still catches a stored-log deletion even when
// the Agent answers as live.
liveSessions.add('new-session-5')
persistedSessions.delete('new-session-5')
persistenceAvailable = true
const statProbe = await tool.execute(
  { summary: 'stat probe', nextPrompt: 'stat probe' },
  { agent: { session }, signal: new AbortController().signal, concludeTurn() {} },
)
assert.equal(statProbe.status, 'created')
assert.equal(statProbe.newSessionId, 'new-session-6')
assert.match(statProbe.message, /Replaced: new-session-5/)
assert.match(statProbe.message, /no stored log/)

// Last resort: with no durability service and a live Agent, reuse is allowed so
// the tool never punishes a Host that predates these services.
persistedSessions.add('new-session-6')
persistenceAvailable = false
const unverified = await tool.execute(
  { summary: 'unverified', nextPrompt: 'unverified' },
  { agent: { session }, signal: new AbortController().signal, concludeTurn() {} },
)
assert.equal(unverified.status, 'reused')
assert.equal(unverified.newSessionId, 'new-session-6')

// A mode chosen in the handoff panel overrides inheritance and is recorded in
// both the creation request and the handoff document.
const chosenMode = await tool.execute(
  { summary: 'chosen mode', nextPrompt: 'chosen mode', forceNew: true, agentPreset: 'ptc' },
  { agent: { session }, signal: new AbortController().signal, concludeTurn() {} },
)
assert.equal(chosenMode.status, 'created')
assert.equal(chosenMode.newSessionId, 'new-session-7')
assert.equal(createdRequest.agentPreset, 'ptc')
assert.match(await readFile(chosenMode.handoffPath, 'utf8'), /- Agent 预设: `ptc`/)

for (const dispose of cleanup.reverse()) dispose?.()
await rm(temp, { recursive: true, force: true })
console.log('selftest: ok')
