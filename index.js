/**
 * Session Handoff — a Host-only DeepSeek Harness plugin.
 *
 * It does three things:
 *  1. folds each Session log into a small pressure projection (turn, step,
 *     context usage, token totals);
 *  2. publishes the pressure to the model as a dynamic <session-pressure>
 *     runtime-context block plus a policy section;
 *  3. exposes `session_handoff`, which writes a durable Markdown handoff,
 *     opens a fresh Session in the same working directory, sends it a
 *     self-contained continuation prompt, and ends the old turn.
 *
 * The Host half also wires the projection to the Client half (`client.js`), a
 * status strip in the composer dock that explains the current pressure and
 * sends a handoff request without the user copying any prompt.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const PROJECTION_KEY = 'sessionHandoffPressure'
const TOOL_NAME = 'session_handoff'

const DEFAULTS = Object.freeze({
  turnsWatch: 10,
  turnsSoft: 20,
  turnsUrgent: 30,
  stepsWatch: 250,
  stepsSoft: 500,
  stepsUrgent: 900,
  contextWatch: 0.4,
  contextSoft: 0.6,
  contextUrgent: 0.85,
  handoffDir: '.dsh/handoffs',
  language: 'zh',
  // Empty = use the localized built-in wording in the Client half. A non-empty
  // template is what the "hand off now" button puts into the composer; the
  // Client may override it per browser from its own editor.
  handoffPrompt: '',
  concludeTurn: true,
  autoOpenNewSession: true,
  transcript: true,
  transcriptMaxChars: 120000,
  transcriptReasoning: false,
  transcriptToolOutput: true,
  subagents: 'interrupt',
  subagentTakeover: true,
  subagentMaxItems: 8,
  subagentChars: 900,
})

const SUBAGENT_MODES = new Set(['off', 'keep', 'interrupt'])

/** Upper bound for a custom handoff instruction, in characters. */
const HANDOFF_PROMPT_MAX = 4000

const LEVEL_RANK = { low: 0, watch: 1, recommended: 2, urgent: 3 }

const LABELS = {
  zh: {
    title: '会话交接文档',
    createdAt: '创建时间',
    fromSession: '来源会话',
    turnStep: '轮次 / 步数',
    cwd: '工作目录',
    preset: 'Agent 预设',
    goal: '目标',
    state: '当前状态',
    completed: '已完成',
    remaining: '待办',
    decisions: '决策与约束',
    files: '关键文件',
    verification: '验证',
    reason: '交接原因',
    transcript: '完整转录',
    newSession: '新会话',
    transcriptHint: '需要核对细节时按需检索该文件（read/grep），不要整份读入上下文',
    next: '继续指令',
    empty: '（未提供）',
    subagents: '子智能体',
    subagentId: '会话',
    subagentMode: '类型',
    subagentStatus: '状态',
    subagentProgress: '最近进度',
    subagentTask: '任务',
    subagentTools: '最后的工具',
    subagentTurns: '轮次 / 步数',
    subagentRunning: '交接时仍在运行',
    subagentInterruptRequested: '交接时仍在运行，已请求打断',
    subagentInterruptFailed: '交接时仍在运行，打断请求失败',
    subagentInactive: '交接时已停止',
    subagentOmitted: '另有 {n} 个子智能体未列出（超过 subagentMaxItems）。',
    subagentUnavailable: '未能读取子智能体列表',
    subagentTakeoverTitle: '子智能体接手',
    subagentTakeoverIntro: '旧会话在交接时还有 {n} 个子智能体没有完成。新会话不能直接给它们发消息，请用 `subagent` 工具按下面的自包含提示重新派出，让新子智能体接着做；若这些任务已经不需要，或当前工具集里没有 `subagent`，先说明再跳过。',
    subagentTakeoverDone: '旧会话的子智能体都已完成，无需重新派出（明细见交接文档）。',
    subagentResumeHeading: 'resume prompt',
  },
  en: {
    title: 'Session Handoff',
    createdAt: 'Created',
    fromSession: 'From session',
    turnStep: 'Turn / step',
    cwd: 'Working directory',
    preset: 'Agent preset',
    goal: 'Goal',
    state: 'Current state',
    completed: 'Completed',
    remaining: 'Remaining',
    decisions: 'Decisions and constraints',
    files: 'Key files',
    verification: 'Verification',
    reason: 'Reason for handoff',
    transcript: 'Full transcript',
    newSession: 'New session',
    transcriptHint: 'Read or grep this file on demand; do not load it whole into context',
    next: 'Continuation prompt',
    empty: '(not provided)',
    subagents: 'Subagents',
    subagentId: 'Session',
    subagentMode: 'Mode',
    subagentStatus: 'Status',
    subagentProgress: 'Latest progress',
    subagentTask: 'Task',
    subagentTools: 'Last tools',
    subagentTurns: 'Turns / steps',
    subagentRunning: 'still running at handoff',
    subagentInterruptRequested: 'still running at handoff; interrupt requested',
    subagentInterruptFailed: 'still running at handoff; interrupt request failed',
    subagentInactive: 'stopped at handoff',
    subagentOmitted: '{n} more subagents are not listed (subagentMaxItems).',
    subagentUnavailable: 'Could not read the subagent list',
    subagentTakeoverTitle: 'Subagent takeover',
    subagentTakeoverIntro: 'At handoff the old Session had {n} unfinished subagent(s). The fresh Session cannot message them directly; re-dispatch each one with the `subagent` tool using the self-contained resume prompt below so a new subagent continues the work. If those tasks are no longer needed, or this toolset has no `subagent` tool, say so before skipping them.',
    subagentTakeoverDone: 'All subagents from the old Session had finished; nothing needs re-dispatching (details are in the handoff document).',
    subagentResumeHeading: 'resume prompt',
  },
}

/** Coerce a config value to a finite number, falling back when unusable. */
function finite(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/** Clamp a value into an inclusive range. */
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Normalize the bundle config once; patch rows may be partial or absent. */
function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const turnsWatch = Math.max(0, finite(input.turnsWatch, DEFAULTS.turnsWatch))
  const turnsSoft = Math.max(turnsWatch, finite(input.turnsSoft, DEFAULTS.turnsSoft))
  const turnsUrgent = Math.max(turnsSoft, finite(input.turnsUrgent, DEFAULTS.turnsUrgent))
  const stepsWatch = Math.max(0, finite(input.stepsWatch, DEFAULTS.stepsWatch))
  const stepsSoft = Math.max(stepsWatch, finite(input.stepsSoft, DEFAULTS.stepsSoft))
  const stepsUrgent = Math.max(stepsSoft, finite(input.stepsUrgent, DEFAULTS.stepsUrgent))
  const contextWatch = clamp(finite(input.contextWatch, DEFAULTS.contextWatch), 0, 1)
  const contextSoft = clamp(Math.max(contextWatch, finite(input.contextSoft, DEFAULTS.contextSoft)), 0, 1)
  const contextUrgent = clamp(Math.max(contextSoft, finite(input.contextUrgent, DEFAULTS.contextUrgent)), 0, 1)
  const subagentMode = SUBAGENT_MODES.has(String(input.subagents ?? '').toLowerCase())
    ? String(input.subagents).toLowerCase()
    : DEFAULTS.subagents
  return {
    turnsWatch,
    turnsSoft,
    turnsUrgent,
    stepsWatch,
    stepsSoft,
    stepsUrgent,
    contextWatch,
    contextSoft,
    contextUrgent,
    handoffDir: typeof input.handoffDir === 'string' && input.handoffDir.trim() !== '' ? input.handoffDir.trim() : DEFAULTS.handoffDir,
    language: String(input.language ?? DEFAULTS.language).toLowerCase().startsWith('en') ? 'en' : 'zh',
    handoffPrompt: typeof input.handoffPrompt === 'string' ? input.handoffPrompt.trim().slice(0, HANDOFF_PROMPT_MAX) : DEFAULTS.handoffPrompt,
    concludeTurn: input.concludeTurn !== false,
    autoOpenNewSession: input.autoOpenNewSession !== false,
    transcript: input.transcript !== false,
    transcriptMaxChars: clamp(finite(input.transcriptMaxChars, DEFAULTS.transcriptMaxChars), 10000, 2000000),
    transcriptReasoning: input.transcriptReasoning === true,
    transcriptToolOutput: input.transcriptToolOutput !== false,
    subagents: subagentMode,
    subagentTakeover: input.subagentTakeover !== false,
    subagentMaxItems: Math.round(clamp(finite(input.subagentMaxItems, DEFAULTS.subagentMaxItems), 0, 50)),
    subagentChars: Math.round(clamp(finite(input.subagentChars, DEFAULTS.subagentChars), 200, 8000)),
  }
}

/** A compact human-readable token count. */
function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}

/** The pressure level implied by one metric against its watch/soft/urgent thresholds. */
function metricLevel(value, watch, soft, urgent) {
  if (value >= urgent) return 'urgent'
  if (value >= soft) return 'recommended'
  if (value >= watch) return 'watch'
  return 'low'
}

/** Raise `level` to at least `candidate`; returns the winner. */
function higherLevel(level, candidate) {
  return LEVEL_RANK[candidate] > LEVEL_RANK[level] ? candidate : level
}

/** Compute the current handoff pressure from the folded Session state. */
function assess(state, config) {
  const ratio = state.contextWindow > 0 && state.lastInputTokens > 0 ? state.lastInputTokens / state.contextWindow : 0
  const turnLevel = metricLevel(state.turn, config.turnsWatch, config.turnsSoft, config.turnsUrgent)
  const stepLevel = metricLevel(state.step, config.stepsWatch, config.stepsSoft, config.stepsUrgent)
  const contextLevel = metricLevel(ratio, config.contextWatch, config.contextSoft, config.contextUrgent)
  const level = [turnLevel, stepLevel, contextLevel].reduce(higherLevel, 'low')
  const signals = []
  if (turnLevel !== 'low') signals.push(`turn ${state.turn} (${turnLevel})`)
  if (stepLevel !== 'low') signals.push(`step ${state.step} (${stepLevel})`)
  if (contextLevel !== 'low') signals.push(`context ${Math.round(ratio * 100)}% (${contextLevel})`)
  return { level, ratio, turnLevel, stepLevel, contextLevel, signals }
}

/** Build the model-facing pressure block. Empty string means "say nothing". */
function pressureText(state, assessment, config) {
  if (state === undefined) return ''
  const percent = Math.round(assessment.ratio * 100)
  const attributes = [
    `turn="${state.turn}"`,
    `step="${state.step}"`,
    `context="${percent}%"`,
    `context_tokens="${state.lastInputTokens}${state.contextWindow > 0 ? `/${state.contextWindow}` : ''}"`,
    `cumulative_tokens="${formatTokens(state.totalTokens)}"`,
  ]
  if (state.inputTokens > 0 && state.cacheReadTokens >= 0) {
    attributes.push(`cache_read="${Math.round((state.cacheReadTokens / state.inputTokens) * 100)}%"`)
  }

  const lines = [`<session-pressure ${attributes.join(' ')}>`, `level: ${assessment.level}`]
  if (state.handoffSucceeded) {
    lines.push('handoff: already completed in this session; do not call session_handoff again.')
  } else if (state.handoffPending.length > 0) {
    lines.push('handoff: a session_handoff call is already pending; do not start another.')
  } else if (assessment.level === 'urgent') {
    lines.push('handoff: urgent — finish the current atomic action, then call session_handoff before starting anything new.')
  } else if (assessment.level === 'recommended') {
    lines.push('handoff: recommended — call session_handoff at the next durable checkpoint.')
  } else if (assessment.level === 'watch') {
    lines.push('handoff: watch — keep the next durable checkpoint in mind; do not interrupt atomic work.')
  } else {
    lines.push('handoff: not needed yet; keep working.')
  }
  if (assessment.signals.length > 0) lines.push(`signals: ${assessment.signals.join(', ')}`)
  lines.push(`thresholds: recommended at turn>=${config.turnsSoft}, step>=${config.stepsSoft}, context>=${Math.round(config.contextSoft * 100)}%; urgent at turn>=${config.turnsUrgent}, step>=${config.stepsUrgent}, context>=${Math.round(config.contextUrgent * 100)}%`)
  lines.push('</session-pressure>')
  return lines.join('\n')
}

/** Static policy section shown in every system prompt. */
function policyText(config) {
  return `## Session longevity and handoff

Long sessions accumulate context and degrade reasoning quality. The host publishes a \`<session-pressure>\` block with the current turn, step, context usage, and a level: \`low\`, \`watch\`, \`recommended\`, or \`urgent\`.

When the level is \`recommended\` or \`urgent\` AND the work is at a durable checkpoint, call \`session_handoff\` exactly once. A durable checkpoint means:
- no file edit is half-applied and no long command is still running;
- the test/build state is known and recorded;
- the next unit of work can be stated without re-reading the whole conversation.

Before calling, fill the handoff completely: goal, current state, completed work, remaining work, decisions and constraints, key files, verification, and a self-contained next prompt. The next Session cannot see this conversation, so the next prompt must stand on its own.

\`session_handoff\` writes a Markdown handoff plus a searchable transcript sidecar, opens a fresh Session in the same working directory, sends the continuation prompt, and ends this turn. The fresh Session reads the handoff first and greps the transcript only when a detail is missing. After it returns successfully, stop: the new Session has already started. Do not call it mid-step, do not call it for a trivial session, and never call it from a subagent Session.

When the handoff request names a next-Session mode (for example \`agentPreset: "ptc"\`), pass that exact id as the \`agentPreset\` argument. Omit \`agentPreset\` only when the request says to inherit the current mode.

${config.subagents === 'off' ? '' : `The handoff also snapshots this Session's subagents into the document. With \`subagents: "${config.subagents}"\`, still-running ones are ${config.subagents === 'interrupt' ? 'interrupted (fire-and-forget) so they stop spending tokens' : 'left running'}; the fresh Session receives a self-contained resume prompt for each unfinished subagent and respawns it with its own \`subagent\` tool. Do not rely on the fresh Session being able to message the old children directly.`}

Current thresholds: recommended at turn ${config.turnsSoft}, step ${config.stepsSoft}, or context ${Math.round(config.contextSoft * 100)}%; urgent at turn ${config.turnsUrgent}, step ${config.stepsUrgent}, or context ${Math.round(config.contextUrgent * 100)}%.`
}

/** Render a bullet list, preserving multi-line items with indentation. */
function bulletList(items) {
  if (!Array.isArray(items)) return ''
  const rendered = items
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => `- ${item.trim().replace(/\r?\n/g, '\n  ')}`)
  return rendered.join('\n')
}

/** Pick a fence longer than any backtick run inside the content. */
function codeFence(content) {
  const runs = String(content).match(/`+/g) ?? []
  const longest = runs.reduce((maximum, run) => Math.max(maximum, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Cut text at a character budget, marking that it was shortened. */
function shorten(text, maximum) {
  const value = String(text ?? '')
  if (value.length <= maximum) return value
  return `${value.slice(0, Math.max(0, maximum - 1))}…`
}

/** Flatten one content-block array into plain Markdown-safe text. */
function contentText(content, maximum) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') {
      parts.push(`[image: ${block.attachment?.name ?? block.attachment?.mediaType ?? 'image'}]`)
    }
  }
  return shorten(parts.join('\n').trim(), maximum)
}

/** Render multi-line text as a Markdown blockquote. */
function quoteBlock(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')
}

/**
 * Drop the delivery boilerplate the host appends to a delegated prompt
 * ("Your parent agent id is ... send_message ..."). It describes the old
 * parent, so it is noise for the successor.
 */
function stripParentBoilerplate(text) {
  return String(text ?? '')
    .replace(/\n\s*Your parent agent id is\b[\s\S]*$/i, '')
    .trim()
}

/**
 * Fold one subagent Session log into the pieces a successor needs: the original
 * task, the latest assistant progress, the last tools, and whether its final
 * turn actually completed.
 */
function summarizeSubagentEvents(events, maximum) {
  let task = ''
  let progress = ''
  let lastTurnReason
  let turns = 0
  let steps = 0
  let lastTime = 0
  const tools = []
  for (const event of Array.isArray(events) ? events : []) {
    const type = event?.type
    const data = event?.data ?? {}
    const time = Number(event?.time)
    if (Number.isFinite(time)) lastTime = Math.max(lastTime, time)
    if (type === 'turn/start') {
      turns = Math.max(turns, Number(data.turn) || 0)
      continue
    }
    if (type === 'step/start') {
      steps += 1
      continue
    }
    if (type === 'user/message') {
      // The first genuine user message is the task the parent handed over.
      if (data.source?.kind !== 'user') continue
      if (task === '') task = stripParentBoilerplate(contentText(data.content, maximum))
      continue
    }
    if (type === 'assistant/message') {
      const text = stripParentBoilerplate(contentText(data.message?.content, maximum))
      if (text !== '') progress = text
      continue
    }
    if (type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : ''
      if (name !== '' && tools[tools.length - 1] !== name) {
        tools.push(name)
        if (tools.length > 6) tools.shift()
      }
      continue
    }
    if (type === 'turn/end') {
      lastTurnReason = data.reason?.kind
    }
  }
  return { task, progress, tools, turns, steps, lastTime, lastTurnReason }
}

/**
 * Snapshot the Session's subagents for the handoff.
 *
 * Only direct children are read in detail (deeper descendants belong to their
 * parent's task); every still-running descendant is interrupted when the
 * `interrupt` mode is active. The fresh Session cannot message these children
 * directly, so it receives self-contained resume prompts instead.
 */
async function collectSubagents(ctx, session, config, agent) {
  const report = {
    available: false,
    error: undefined,
    total: 0,
    running: 0,
    interruptRequested: 0,
    interruptFailed: 0,
    omitted: 0,
    items: [],
  }
  if (config.subagents === 'off') return report
  const service = typeof ctx.get === 'function' ? ctx.get('subagents') : ctx.subagents
  if (service === undefined || typeof service.listDescendants !== 'function') return report
  report.available = true

  let rows
  try {
    rows = await service.listDescendants(session.id)
  } catch (error) {
    report.error = String(error)
    ctx.logger?.warn?.(`session_handoff could not list subagents: ${String(error)}`)
    return report
  }

  const children = (Array.isArray(rows) ? rows : []).filter(
    (row) => row !== null && typeof row === 'object' && row.kind === 'child' && typeof row.id === 'string' && row.id !== '',
  )
  report.running = children.filter((row) => row.activity === 'running').length

  let direct = children.filter((row) => (row.depth ?? 1) === 1)
  // Hosts that report a flat child list without depth still deserve a snapshot.
  if (direct.length === 0) direct = children
  report.total = direct.length
  report.omitted = Math.max(0, direct.length - config.subagentMaxItems)
  const chosen = config.subagentMaxItems > 0 ? direct.slice(0, config.subagentMaxItems) : []

  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery
  for (const row of chosen) {
    let summary = { task: '', progress: '', tools: [], turns: 0, steps: 0, lastTime: 0, lastTurnReason: undefined }
    if (query !== undefined && typeof query.readSession === 'function') {
      try {
        const snapshot = await query.readSession(row.id)
        summary = summarizeSubagentEvents(snapshot?.events, config.subagentChars)
      } catch (error) {
        ctx.logger?.warn?.(`session_handoff could not read subagent ${row.id}: ${String(error)}`)
      }
    }
    const item = {
      id: row.id,
      label: typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : undefined,
      mode: typeof row.mode === 'string' ? row.mode : 'unknown',
      depth: row.depth ?? 1,
      parentId: typeof row.parentId === 'string' ? row.parentId : undefined,
      activity: row.activity === 'running' ? 'running' : 'inactive',
      interruptRequested: false,
      interruptError: undefined,
      ...summary,
    }
    item.unfinished = item.activity === 'running' || item.lastTurnReason !== 'completed' || item.progress === ''
    report.items.push(item)
  }

  if (config.subagents === 'interrupt') {
    for (const row of children.filter((entry) => entry.activity === 'running')) {
      const item = report.items.find((entry) => entry.id === row.id)
      try {
        service.interrupt(
          row.id,
          agent !== undefined
            ? { kind: 'ancestor', agent }
            : { kind: 'user', parentSessionId: session.id },
        )
        report.interruptRequested += 1
        if (item !== undefined) item.interruptRequested = true
      } catch (error) {
        report.interruptFailed += 1
        if (item !== undefined) item.interruptError = String(error)
        ctx.logger?.warn?.(`session_handoff could not interrupt subagent ${row.id}: ${String(error)}`)
      }
    }
  }
  return report
}

/** Human-readable status for one subagent snapshot line. */
function subagentStatusText(item, config) {
  const labels = LABELS[config.language]
  if (item.activity !== 'running') return labels.subagentInactive
  if (item.interruptError !== undefined) return `${labels.subagentInterruptFailed} (${item.interruptError})`
  if (item.interruptRequested) return labels.subagentInterruptRequested
  return labels.subagentRunning
}

/** Render the "Subagents" section of the handoff document. */
function subagentMarkdown(report, config) {
  if (report === undefined || report.available !== true) return ''
  const labels = LABELS[config.language]
  const lines = [`## ${labels.subagents} (${report.items.length}/${report.total})`, '']
  if (report.error !== undefined) lines.push(`> ${labels.subagentUnavailable}: ${report.error}`, '')
  for (const [index, item] of report.items.entries()) {
    lines.push(`### ${index + 1}. ${item.label ?? item.id}`, '')
    lines.push(`- ${labels.subagentId}: \`${item.id}\``)
    lines.push(`- ${labels.subagentMode}: \`${item.mode}\` / depth ${item.depth}`)
    lines.push(`- ${labels.subagentStatus}: ${subagentStatusText(item, config)}`)
    lines.push(`- ${labels.subagentTurns}: ${item.turns} / ${item.steps}`)
    lines.push('')
    lines.push(`${labels.subagentTask}:`, '', quoteBlock(item.task !== '' ? item.task : labels.empty), '')
    if (item.progress !== '') {
      lines.push(`${labels.subagentProgress}:`, '', quoteBlock(item.progress), '')
    }
    if (item.tools.length > 0) {
      lines.push(`- ${labels.subagentTools}: ${item.tools.map((tool) => `\`${tool}\``).join(', ')}`, '')
    }
  }
  if (report.omitted > 0) lines.push(`> ${labels.subagentOmitted.replace('{n}', String(report.omitted))}`, '')
  return lines.join('\n')
}

/** Build the self-contained prompt the fresh Session uses to respawn one subagent. */
function buildSubagentResumePrompt(item, config) {
  const name = item.label ?? item.id
  const task = item.task !== '' ? item.task : undefined
  const progress = item.progress !== '' ? item.progress : undefined
  const tools = item.tools.length > 0 ? item.tools.map((tool) => `\`${tool}\``).join(', ') : undefined
  if (config.language === 'en') {
    const lines = [
      `You are taking over an unfinished subagent task from an old Session. Old subagent: ${name} (id: ${item.id}), state at handoff: ${item.activity}.`,
      '',
      'Original task:',
      task ?? '(no original task was recorded)',
      '',
      'What it had done so far:',
      progress ?? '(no assistant progress was recorded)',
    ]
    if (tools !== undefined) lines.push('', `Last tools: ${tools}`)
    lines.push(
      '',
      'Continue the work; do not redo what is already finished:',
      '1. First check the current workspace (files, git status, existing artifacts) and confirm the progress above still holds.',
      '2. Finish only what is missing. If the task is in fact complete, report the result and the evidence instead of redoing it.',
      '3. You cannot see the old Session; all context you need is in this prompt. State your assumptions and list anything that needs confirmation.',
      '4. Finish with: what you did, files changed, verification commands and results, and remaining risks.',
    )
    return lines.join('\n')
  }
  const lines = [
    `你接替旧会话里一个尚未完成的子智能体任务。旧子智能体：${name}（id: ${item.id}），交接时状态：${subagentStatusText(item, config)}。`,
    '',
    '原任务：',
    task ?? '（没有记录到原任务）',
    '',
    '它已经做到的：',
    progress ?? '（没有助手进展记录）',
  ]
  if (tools !== undefined) lines.push('', `最后调用的工具：${tools}`)
  lines.push(
    '',
    '请接着做，不要重复已完成的部分：',
    '1. 先核对工作区现状（文件、git 状态、已有产物），确认上面的进度仍然成立。',
    '2. 只补完未完成的部分；如果原任务实际上已经完成，直接汇报结论与证据，不要重做。',
    '3. 你看不到旧会话，所有必要背景都在本提示里；缺信息时写明假设，并列出需要确认的问题。',
    '4. 结束时给出：做了什么、改了哪些文件、验证命令与结果、剩余风险。',
  )
  return lines.join('\n')
}

/** Render the "Subagent takeover" block appended to the fresh Session prompt. */
function subagentTakeoverText(report, config) {
  if (report === undefined || report.available !== true || config.subagentTakeover !== true) return ''
  const labels = LABELS[config.language]
  if (report.total === 0 || report.items.length === 0) return ''
  const pending = report.items.filter((item) => item.unfinished)
  if (pending.length === 0) {
    return `\n\n## ${labels.subagentTakeoverTitle}\n${labels.subagentTakeoverDone}`
  }
  const lines = [
    `\n## ${labels.subagentTakeoverTitle}`,
    '',
    labels.subagentTakeoverIntro.replace('{n}', String(pending.length)),
    '',
  ]
  for (const [index, item] of pending.entries()) {
    const prompt = buildSubagentResumePrompt(item, config)
    const fence = codeFence(prompt)
    lines.push(`### ${index + 1}. ${item.label ?? item.id}`, '', `${fence}text`, prompt, fence, '')
  }
  return lines.join('\n').trimEnd()
}

/** Compact counters for the tool's structured output and result message. */
function subagentCounters(report, config) {
  const available = report?.available === true
  const items = available && Array.isArray(report.items) ? report.items : []
  return {
    available,
    total: available ? report.total : 0,
    running: available ? report.running : 0,
    interrupted: available ? report.interruptRequested : 0,
    takeover: available && config.subagentTakeover === true ? items.filter((item) => item.unfinished).length : 0,
    omitted: available ? report.omitted : 0,
  }
}

/**
 * Export the Session log as a searchable sidecar. It is deliberately not fed
 * into the fresh Session's context: the handoff document stays the hot summary,
 * and the new Session reads this file only when a detail is missing.
 */
function buildTranscriptMarkdown(options) {
  const { session, cwd, now, config, events } = options
  const lines = [
    '# Session transcript',
    '',
    `- Session: \`${session.id}\``,
    `- Exported: ${now.toISOString()}`,
    `- Working directory: \`${cwd}\``,
    '',
    '> Machine-exported evidence. Search this file with grep/read when a detail is missing; do not load it whole into context.',
    '',
  ]
  for (const event of events) {
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'turn/start') {
      lines.push('', `## Turn ${data.turn ?? '?'}`, '')
      continue
    }
    if (type === 'user/message') {
      // Runtime-context / compaction injections are not human turns.
      if (data.source?.kind !== 'user') continue
      const text = contentText(data.content, 12000)
      if (text !== '') lines.push('### User', '', text, '')
      continue
    }
    if (type === 'assistant/message') {
      const content = data.message?.content
      if (config.transcriptReasoning && Array.isArray(content)) {
        const reasoning = content
          .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
        if (reasoning !== '') lines.push('#### Reasoning', '', shorten(reasoning, 8000), '')
      }
      const text = contentText(content, 12000)
      if (text !== '') lines.push('### Assistant', '', text, '')
      continue
    }
    if (type === 'tool/call') {
      const raw = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
      const fence = codeFence(raw)
      lines.push(`### Tool call: ${data.name ?? 'unknown'}`, '', `${fence}json`, shorten(raw, 4000), fence, '')
      continue
    }
    if (type === 'tool/result') {
      if (!config.transcriptToolOutput) continue
      const text = contentText(data.message?.content, 8000)
      if (text !== '') lines.push('### Tool result', '', text, '')
      if (data.error !== undefined) {
        lines.push(`> Error: ${String(data.error?.name ?? data.error?.code ?? data.error)}`)
      }
    }
  }

  let body = lines.join('\n')
  const maximum = config.transcriptMaxChars
  if (body.length > maximum) {
    const headLength = Math.floor(maximum * 0.25)
    const tailLength = Math.max(0, maximum - headLength - 200)
    const omitted = body.length - headLength - tailLength
    body = `${body.slice(0, headLength)}\n\n<!-- ${omitted} characters omitted; search the original Session log if needed -->\n\n${body.slice(-tailLength)}`
  }
  return body
}

/** Build the durable handoff document. */
function buildHandoffMarkdown(options) {
  const { args, session, cwd, now, config, state, transcriptPath, preset, subagents } = options
  const labels = LABELS[config.language]
  const lines = [`# ${labels.title}`, '']
  lines.push(`- ${labels.createdAt}: ${now.toISOString()}`)
  lines.push(`- ${labels.fromSession}: \`${session.id}\``)
  lines.push(`- ${labels.turnStep}: ${state.turn} / ${state.step}`)
  lines.push(`- ${labels.cwd}: \`${cwd}\``)
  const nextPreset = typeof preset === 'string' && preset !== '' ? preset : session.header.agentPreset
  if (nextPreset !== undefined) lines.push(`- ${labels.preset}: \`${nextPreset}\``)
  lines.push('')

  if (typeof args.goal === 'string' && args.goal.trim() !== '') {
    lines.push(`## ${labels.goal}`, '', args.goal.trim(), '')
  }
  lines.push(`## ${labels.state}`, '', args.summary.trim(), '')

  const sections = [
    [labels.completed, args.completed],
    [labels.remaining, args.remaining],
    [labels.decisions, args.decisions],
    [labels.files, args.files],
    [labels.verification, args.verification],
  ]
  for (const [heading, items] of sections) {
    const body = bulletList(items)
    if (body !== '') lines.push(`## ${heading}`, '', body, '')
  }

  if (typeof args.reason === 'string' && args.reason.trim() !== '') {
    lines.push(`## ${labels.reason}`, '', args.reason.trim(), '')
  }

  const subagentSection = subagentMarkdown(subagents, config)
  if (subagentSection !== '') lines.push(subagentSection, '')

  if (typeof transcriptPath === 'string' && transcriptPath !== '') {
    lines.push(`## ${labels.transcript}`, '', `${labels.transcriptHint}:`, '', `\`${transcriptPath}\``, '')
  }

  const fence = codeFence(args.nextPrompt)
  lines.push(`## ${labels.next}`, '', `${fence}text`, args.nextPrompt.trim(), fence, '')
  return lines.join('\n')
}

/** Build the first user message for the fresh Session. */
function buildContinuationPrompt(options) {
  const { handoffPath, summary, nextPrompt, config, transcriptPath, subagents } = options
  const transcriptNote = typeof transcriptPath === 'string' && transcriptPath !== ''
    ? (config.language === 'en'
      ? `\n\nIf a detail is missing from the handoff document, search the full transcript on demand (do not load it whole):\n${transcriptPath}`
      : `\n\n如果交接文档里缺少某个细节，可按需检索完整转录（不要整份读入）：\n${transcriptPath}`)
    : ''
  const takeoverNote = subagentTakeoverText(subagents, config)
  if (config.language === 'en') {
    return `You are taking over a session through a handoff.

Read the handoff document first:
${handoffPath}

Handoff summary:
${summary}${transcriptNote}${takeoverNote}

Requirements:
1. Briefly confirm the task and current state you are taking over. Do not repeat completed work.
2. Continue from the first item under "Remaining"; if you change the order, say why.
3. Follow the decisions and constraints in the handoff document.
4. If the document conflicts with the repository's current state, trust the repository and point out the conflict.

Continuation prompt:
${nextPrompt}`
  }
  return `你正在接手一个已经交接的会话。

请先阅读交接文档：
${handoffPath}

交接摘要：
${summary}${transcriptNote}${takeoverNote}

要求：
1. 先简短确认你接手的任务和当前状态，不要重复已完成的工作。
2. 从“待办”中的第一项继续；如需调整顺序，请说明原因。
3. 遵守交接文档中的决策与约束。
4. 如果交接文档与仓库现状冲突，以仓库现状为准，并指出冲突。

继续指令：
${nextPrompt}`
}

/** Normalize optional array arguments; the model may omit them. */
function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/** Find the workspace that owns this cwd, if any. */
function workspaceFor(ctx, cwd) {
  try {
    const workspaces = ctx.workspaceRegistry?.list?.() ?? []
    const normalize = (value) => String(value).replace(/[\\/]+$/, '').toLowerCase()
    const target = normalize(cwd)
    return workspaces.find((workspace) => {
      const root = normalize(workspace.path)
      return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`)
    })
  } catch {
    return undefined
  }
}

/** Find an already-written handoff for this source Session after a Host restart. */
async function findExistingHandoff(directory, sessionId, labels) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const needles = [
      `- ${labels.fromSession}: \`${sessionId}\``,
      `- ${LABELS.zh.fromSession}: \`${sessionId}\``,
      `- ${LABELS.en.fromSession}: \`${sessionId}\``,
    ]
    const newSessionLabels = [labels.newSession, LABELS.zh.newSession, LABELS.en.newSession].filter(Boolean)
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.endsWith('.transcript.md'))
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const name of names) {
      const path = join(directory, name)
      const text = await readFile(path, 'utf8')
      if (!needles.some((needle) => text.includes(needle))) continue
      let newSessionId
      for (const label of newSessionLabels) {
        const match = text.match(new RegExp(`^- ${label}: \`([^\`]+)\``, 'm'))
        if (match) {
          newSessionId = match[1]
          break
        }
      }
      const transcriptSection = text.split(/^## (?:完整转录|Full transcript)$/m)[1] ?? ''
      const transcriptMatch = transcriptSection.match(/`([^`\n]+\.transcript\.md)`/)
      return { path, newSessionId, transcriptPath: transcriptMatch?.[1] }
    }
  } catch {
    // Directory missing or unreadable: treat as no previous handoff.
  }
  return undefined
}

/**
 * Decide whether the Session recorded by a previous handoff is still reusable.
 *
 * A Session whose stored log was deleted can stay attached to this process for
 * the rest of its life, and `sessionController.resolveAgent` returns that live
 * Agent without touching disk. Reusing it strands the user in a conversation
 * that no longer exists after a restart, so durability is read from the Session
 * listing's `persisted` flag; the live-Agent probe stays only as a last resort.
 */
async function probeHandoffTarget(ctx, sessionId) {
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery
  if (query !== undefined && typeof query.listSessions === 'function') {
    try {
      const records = await query.listSessions()
      const record = Array.isArray(records) ? records.find((entry) => entry?.header?.id === sessionId) : undefined
      if (record === undefined) return { durable: false, reason: 'it is no longer listed' }
      if (record.persisted === true) return { durable: true, reason: 'its stored log is present' }
      if (record.live === true) return { durable: false, reason: 'its Agent is still in memory but its stored log is gone' }
      return { durable: false, reason: 'neither a stored log nor a live Agent remains' }
    } catch (error) {
      ctx.logger?.warn?.(`session_handoff: listing Sessions to verify ${sessionId} failed (${String(error)}); falling back to a live-Agent probe`)
    }
  }
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : ctx.sessionPersistence
  if (persistence !== undefined && typeof persistence.stat === 'function') {
    try {
      const snapshot = await persistence.stat(sessionId)
      if (snapshot !== undefined) return { durable: true, reason: 'persistence reports a stored log' }
      return { durable: false, reason: 'persistence reports no stored log' }
    } catch (error) {
      ctx.logger?.warn?.(`session_handoff: stat of previous new Session ${sessionId} failed (${String(error)}); falling back to a live-Agent probe`)
    }
  }
  try {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) {
      return { durable: false, reason: `resolveAgent reported ${String(resolved.error?.message ?? resolved.error)}` }
    }
    return { durable: true, reason: 'resolveAgent returned a live Agent (durability unverified)' }
  } catch (error) {
    return { durable: false, reason: `resolveAgent failed: ${String(error)}` }
  }
}

/** Register the tool. */
function createTool(ctx, config, completed, inFlight) {
  return {
    name: TOOL_NAME,
    description:
      'Create a durable handoff and continue the work in a fresh Session. Call this once, only at a clean checkpoint, when the <session-pressure> block reports level recommended or urgent. It writes a Markdown handoff plus a searchable transcript sidecar, snapshots this Session\'s subagents (optionally interrupting the ones still running, per config), opens a new Session in the same workspace, sends the continuation prompt with self-contained subagent resume prompts, and ends this turn. The new Session cannot see this conversation, so every argument must be self-contained.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The overarching goal of the work, in one or two sentences. Optional when the summary already states it.',
        },
        summary: {
          type: 'string',
          description: 'Current state of the project and the exact point where the work stands. This is the most important field.',
        },
        completed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Work that is finished and must not be redone. Include verification results.',
        },
        remaining: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered next steps. The fresh Session starts with the first item.',
        },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Decisions, constraints, conventions, and pitfalls the next Session must respect.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key file paths and what each one contains or why it matters. Use workspace-relative paths where possible.',
        },
        verification: {
          type: 'array',
          items: { type: 'string' },
          description: 'Commands run and their results: tests, builds, type checks, and any known failures.',
        },
        reason: {
          type: 'string',
          description: 'Why the handoff is happening now, for example long session, high step count, or context pressure.',
        },
        nextPrompt: {
          type: 'string',
          description: 'A self-contained prompt for the fresh Session. State what to do next, which files to read first, and how to verify the result. Do not refer to "the previous conversation".',
        },
        forceNew: {
          type: 'boolean',
          description: 'Create a replacement Session even when this Session already has a recorded handoff. Use when the recorded new Session was deleted or is no longer visible in the workspace.',
        },
        agentPreset: {
          type: 'string',
          description: 'Agent preset id for the fresh Session, chosen by the user in the handoff panel. Omit to inherit the current Session preset.',
        },
      },
      required: ['summary', 'nextPrompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['created', 'reused'] },
          newSessionId: { type: 'string' },
          handoffPath: { type: 'string' },
          transcriptPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          subagents: {
            type: 'object',
            properties: {
              available: { type: 'boolean' },
              total: { type: 'number' },
              running: { type: 'number' },
              interrupted: { type: 'number' },
              takeover: { type: 'number' },
              omitted: { type: 'number' },
            },
            required: ['available', 'total', 'running', 'interrupted', 'takeover', 'omitted'],
            additionalProperties: false,
          },
          message: { type: 'string' },
        },
        required: ['status', 'newSessionId', 'handoffPath', 'transcriptPath', 'subagents', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message }]
      },
      presentationMeta(_args, value) {
        return {
          newSessionId: value.newSessionId,
          handoffPath: value.handoffPath,
          transcriptPath: value.transcriptPath ?? null,
        }
      },
    },
    async execute(args, exec) {
      const agent = exec.agent ?? ctx.agents.currentInitiator()
      if (agent === undefined) throw new Error('session_handoff must run inside an agent Session')
      const session = agent.session
      const header = session.header
      if (header.origin === 'subagent' || header.parentSession !== undefined) {
        throw new Error('session_handoff is only available in a top-level Session, not in a subagent Session')
      }

      const running = inFlight.get(session.id)
      if (running !== undefined) return await running

      const operation = performHandoff({ ctx, config, session, args, exec })
      inFlight.set(session.id, operation)
      try {
        const result = await operation
        completed.set(session.id, result)
        return result
      } finally {
        inFlight.delete(session.id)
      }
    },
  }
}

/** Perform the handoff: document, fresh Session, continuation prompt. */
async function performHandoff(options) {
  const { ctx, config, session, args, exec } = options
  const cwd = session.header.cwd ?? process.cwd()
  const labels = LABELS[config.language] ?? LABELS.zh
  const now = new Date()
  const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY) ?? {
    turn: 0,
    step: 0,
    contextWindow: 0,
    lastInputTokens: 0,
    totalTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    handoffPending: [],
    handoffSucceeded: false,
    newSessionId: null,
  }

  const summary = String(args?.summary ?? '').trim()
  const nextPrompt = String(args?.nextPrompt ?? '').trim()
  const forceNew = args?.forceNew === true
  const requestedPreset = typeof args?.agentPreset === 'string' && args.agentPreset.trim() !== ''
    ? args.agentPreset.trim()
    : undefined
  if (summary === '') throw new Error('session_handoff requires a non-empty summary')
  if (nextPrompt === '') throw new Error('session_handoff requires a non-empty nextPrompt')

  const normalized = {
    goal: typeof args.goal === 'string' ? args.goal : undefined,
    summary,
    completed: stringList(args.completed),
    remaining: stringList(args.remaining),
    decisions: stringList(args.decisions),
    files: stringList(args.files),
    verification: stringList(args.verification),
    reason: typeof args.reason === 'string' ? args.reason : undefined,
    nextPrompt,
  }

  const directory = isAbsolute(config.handoffDir) ? config.handoffDir : join(cwd, config.handoffDir)
  const previousHandoff = await findExistingHandoff(directory, session.id, labels)
  const recordedId = previousHandoff !== undefined && typeof previousHandoff.newSessionId === 'string' && previousHandoff.newSessionId !== ''
    ? previousHandoff.newSessionId
    : undefined
  let previousTarget
  if (recordedId !== undefined && !forceNew) {
    previousTarget = await probeHandoffTarget(ctx, recordedId)
    if (!previousTarget.durable) {
      ctx.logger?.warn?.(`session_handoff: previous new Session ${recordedId} cannot be reused because ${previousTarget.reason}; creating a replacement`)
    }
  }
  if (previousHandoff !== undefined && recordedId !== undefined && !forceNew && previousTarget?.durable === true) {
    if (config.concludeTurn) exec.concludeTurn()
    const message = [
      'Handoff already completed for this Session.',
      `- New Session: ${recordedId}`,
      `- Handoff document: ${previousHandoff.path}`,
      ...(previousHandoff.transcriptPath !== undefined ? [`- Full transcript: ${previousHandoff.transcriptPath}`] : []),
      'Switch to the new Session in the sidebar to continue.',
    ].join('\n')
    return {
      status: 'reused',
      newSessionId: recordedId,
      handoffPath: previousHandoff.path,
      transcriptPath: previousHandoff.transcriptPath ?? null,
      subagents: subagentCounters(undefined, config),
      message,
    }
  }
  await mkdir(directory, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const safeSession = session.id.slice(-8).replace(/[^a-zA-Z0-9_-]/g, '') || 'session'

  let transcriptPath
  if (config.transcript) {
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      const transcript = buildTranscriptMarkdown({ session, cwd, now, config, events })
      transcriptPath = join(directory, `handoff-${stamp}-${safeSession}.transcript.md`)
      await writeFile(transcriptPath, transcript, 'utf8')
    } catch (error) {
      transcriptPath = undefined
      ctx.logger?.warn?.(`session_handoff could not write the transcript: ${String(error)}`)
    }
  }

  const subagents = await collectSubagents(ctx, session, config, exec.agent)
  const subagentStats = subagentCounters(subagents, config)

  const markdown = buildHandoffMarkdown({ args: normalized, session, cwd, now, config, state, transcriptPath, preset: requestedPreset, subagents })
  const handoffPath = join(directory, `handoff-${stamp}-${safeSession}.md`)
  await writeFile(handoffPath, markdown, 'utf8')

  let created
  const workspace = workspaceFor(ctx, cwd)
  const sameDirectory = workspace !== undefined && workspace.path.replace(/[\\/]+$/, '').toLowerCase() === cwd.replace(/[\\/]+$/, '').toLowerCase()
  try {
    const request = sameDirectory ? { workspaceId: workspace.id } : { cwd }
    const preset = requestedPreset ?? session.header.agentPreset
    if (preset !== undefined) request.agentPreset = preset
    created = await ctx.sessionController.create(request)
    if (workspace !== undefined && !sameDirectory) await workspace.attachSession?.(created.sessionId)
  } catch (error) {
    throw new Error(`The handoff document was written to ${handoffPath}, but creating the fresh Session failed: ${String(error)}`)
  }

  try {
    await writeFile(handoffPath, `${markdown.trimEnd()}\n\n- ${labels.newSession}: \`${created.sessionId}\`\n`, 'utf8')
  } catch (error) {
    ctx.logger?.warn?.(`session_handoff could not record the new Session id in the handoff document: ${String(error)}`)
  }

  const continuation = buildContinuationPrompt({
    handoffPath,
    summary: normalized.summary,
    nextPrompt: normalized.nextPrompt,
    config,
    transcriptPath,
    subagents,
  })
  try {
    await ctx.sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: continuation }],
      },
      exec.signal,
    )
  } catch (error) {
    throw new Error(`The fresh Session ${created.sessionId} was created, but the continuation prompt was rejected: ${String(error)}. The handoff document is at ${handoffPath}.`)
  }

  if (config.concludeTurn) exec.concludeTurn()

  const message = [
    'Handoff complete. A fresh Session is running.',
    `- New Session: ${created.sessionId}`,
    ...(recordedId !== undefined && previousTarget?.durable === false ? [`- Replaced: ${recordedId} (${previousTarget.reason})`] : []),
    `- Handoff document: ${handoffPath}`,
    ...(transcriptPath !== undefined ? [`- Full transcript: ${transcriptPath}`] : []),
    ...(subagentStats.available && subagentStats.total > 0
      ? [`- Subagents: ${subagentStats.total} tracked, ${subagentStats.running} running, ${subagentStats.interrupted} interrupt requested, ${subagentStats.takeover} handed over`]
      : []),
    '- Continuation prompt: queued in the new Session',
    'Switch to the new Session in the sidebar to continue.',
  ].join('\n')
  return { status: 'created', newSessionId: created.sessionId, handoffPath, transcriptPath: transcriptPath ?? null, subagents: subagentStats, message }
}

/** Read the current agent-preset roster, tolerating profiles without the registry. */
async function listAgentPresets(ctx) {
  const registry = ctx.agentPresets
  if (registry === undefined || typeof registry.remoteExportList !== 'function') return []
  try {
    const result = await registry.remoteExportList()
    const rows = Array.isArray(result?.presets) ? result.presets : []
    return rows
      .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
      .map((row) => ({
        id: row.id,
        name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
        ...(typeof row.description === 'string' && row.description !== '' ? { description: row.description } : {}),
        isDefault: row.isDefault === true,
        broken: row.broken !== undefined && row.broken !== false,
      }))
  } catch (error) {
    ctx.logger?.warn?.(`session_handoff: listing agent presets failed: ${String(error)}`)
    return []
  }
}

/** Register the pressure projection. */
function registerProjection(ctx, config, getPresets) {
  return ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 3,
    stateSchema: { parse: (value) => value },
    wire: {
      viewSchema: { parse: (value) => value },
      view: (state) => {
        const assessment = assess(state, config)
        return {
          turn: state.turn,
          step: state.step,
          contextWindow: state.contextWindow,
          lastInputTokens: state.lastInputTokens,
          totalTokens: state.totalTokens,
          ratio: assessment.ratio,
          level: assessment.level,
          metrics: [
            {
              id: 'turns',
              value: state.turn,
              watch: config.turnsWatch,
              soft: config.turnsSoft,
              urgent: config.turnsUrgent,
              level: assessment.turnLevel,
            },
            {
              id: 'steps',
              value: state.step,
              watch: config.stepsWatch,
              soft: config.stepsSoft,
              urgent: config.stepsUrgent,
              level: assessment.stepLevel,
            },
            {
              id: 'context',
              value: assessment.ratio,
              watch: config.contextWatch,
              soft: config.contextSoft,
              urgent: config.contextUrgent,
              level: assessment.contextLevel,
            },
          ],
          handoffPending: Array.isArray(state.handoffPending)
            ? state.handoffPending.length > 0
            : Boolean(state.handoffPending),
          handoffSucceeded: state.handoffSucceeded,
          newSessionId: state.newSessionId ?? null,
          autoOpenNewSession: config.autoOpenNewSession,
          handoffPrompt: config.handoffPrompt,
          presets: typeof getPresets === 'function' ? getPresets() : [],
        }
      },
    },
    init: () => ({
      turn: 0,
      step: 0,
      contextWindow: 0,
      lastInputTokens: 0,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      handoffPending: [],
      handoffSucceeded: false,
      newSessionId: null,
    }),
    apply: (state, event) => {
      switch (event.type) {
        case 'turn/start':
          return { ...state, turn: Number(event.data?.turn) || state.turn }
        case 'step/start':
          // event.data.step is the step index within one turn; the policy needs
          // the cumulative session step count, so count step/start events.
          return { ...state, step: state.step + 1 }
        case 'request/context':
          return {
            ...state,
            contextWindow: Number(event.data?.contextWindow) || state.contextWindow,
          }
        case 'assistant/message': {
          const usage = event.data?.usage
          if (usage === undefined || usage === null) return state
          const uncached = Number(usage.inputTokens) || 0
          const cacheRead = Number(usage.cacheReadTokens) || 0
          const cacheWrite = Number(usage.cacheWriteTokens) || 0
          const prompt = uncached + cacheRead + cacheWrite
          const output = Number(usage.outputTokens) || 0
          const total = Number(usage.totalTokens) || prompt + output
          return {
            ...state,
            lastInputTokens: prompt,
            totalTokens: state.totalTokens + total,
            inputTokens: state.inputTokens + prompt,
            cacheReadTokens: state.cacheReadTokens + cacheRead,
          }
        }
        case 'tool/call': {
          if (event.data?.name !== TOOL_NAME) return state
          const callId = String(event.data.callId)
          const pending = Array.isArray(state.handoffPending) ? state.handoffPending : []
          return {
            ...state,
            handoffPending: [...pending.filter((id) => id !== callId), callId].slice(-8),
          }
        }
        case 'tool/result': {
          const callId = String(event.data?.message?.toolCallId ?? event.data?.callId ?? '')
          const pending = Array.isArray(state.handoffPending) ? state.handoffPending : []
          if (!pending.includes(callId)) return state
          const handoffPending = pending.filter((id) => id !== callId)
          if (event.data?.error !== undefined) return { ...state, handoffPending }
          const newSessionId = event.data?.meta?.newSessionId
          return {
            ...state,
            handoffPending,
            handoffSucceeded: true,
            ...(typeof newSessionId === 'string' && newSessionId !== '' ? { newSessionId } : {}),
          }
        }
        default:
          return state
      }
    },
  })
}

export const inject = ['tools', 'systemPrompt', 'sessionProjections', 'sessionController', 'agents', 'workspaceRegistry', 'agentPresets']

/** Activate the bundle. */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const completed = new Map()
  const inFlight = new Map()
  let presets = []

  ctx.effect(() => {
    let stopped = false
    let presetTimer
    // Preset declarations may register just after this plugin activates. Keep
    // retrying briefly until the roster is non-empty, then stop polling.
    const refreshPresets = (attempt = 0) => {
      void listAgentPresets(ctx).then((rows) => {
        if (stopped) return
        if (rows.length > 0) {
          presets = rows
          return
        }
        if (attempt >= 20) return
        presetTimer = setTimeout(() => refreshPresets(attempt + 1), 500)
      })
    }
    refreshPresets()

    const disposers = [
      registerProjection(ctx, config, () => presets),
      ctx.systemPrompt.section({
        name: 'session-handoff-policy',
        order: 650,
        text: policyText(config),
      }),
      ctx.systemPrompt.context({
        name: 'session-handoff-pressure',
        order: 4500,
        text: (context) => {
          const agent = context?.agent ?? context?.scope
          if (agent?.session === undefined) return ''
          const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
          if (state === undefined) return ''
          return pressureText(state, assess(state, config), config)
        },
      }),
      ctx.tools.register(createTool(ctx, config, completed, inFlight)),
    ]
    return () => {
      stopped = true
      if (presetTimer !== undefined) clearTimeout(presetTimer)
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.()
        } catch (error) {
          ctx.logger?.warn?.(`session-handoff: cleanup failed: ${String(error)}`)
        }
      }
    }
  }, 'session-handoff activation')
}
