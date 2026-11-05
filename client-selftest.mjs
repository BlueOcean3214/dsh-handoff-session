/**
 * Client-half smoke test without a browser.
 *
 * It exercises the module contract (window.__ModuleLoader__.load), the slot
 * registration, and a full render of both the compact strip and the expanded
 * popover. React is replaced by an eager, hook-compatible stub, so this is a
 * logic test rather than a pixel test.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client.js'), 'utf8')

let loaded
const stateQueue = []
const documentStub = {
  addEventListener() {},
  removeEventListener() {},
}

const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    if (typeof type === 'function') return type(merged)
    return { type, props: merged }
  },
  useState(initial) {
    const forced = stateQueue.shift()
    return [forced === undefined ? initial : forced, () => {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
  useCallback(fn) {
    return fn
  },
}

globalThis.document = documentStub
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

// Evaluate the module wrapper exactly as the page loader would.
new Function('window', source)(globalThis.window)

if (loaded === undefined) throw new Error('client module did not call __ModuleLoader__.load')
if (loaded.id !== 'dsh-handoff-session') throw new Error(`unexpected module id: ${loaded.id}`)

const moduleFace = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})

if (!Array.isArray(moduleFace.inject) || !moduleFace.inject.includes('slots')) {
  throw new Error('client module must inject slots')
}

let registration
const disposed = []
const ctx = {
  logger: { warn() {}, error() {} },
  effect(fn) {
    disposed.push(fn())
    return () => {}
  },
  locale: {
    bind: () => undefined,
    register: () => () => {},
  },
  slots: {
    inject(name, factory) {
      if (name !== 'conversation.composer.dock') throw new Error(`unexpected slot: ${name}`)
      factory()
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
}

moduleFace.apply(ctx)

if (registration === undefined) throw new Error('no slot registration')
if (registration.options.id !== 'session-handoff') throw new Error('unexpected slot id')
if (registration.options.name !== 'conversation.composer.dock') throw new Error('unexpected slot name')
if (registration.options.order !== 2) throw new Error('unexpected slot order')
if (typeof registration.component !== 'function') throw new Error('slot component is not a function')

const view = {
  turn: 21,
  step: 520,
  contextWindow: 262144,
  lastInputTokens: 162000,
  totalTokens: 3000000,
  ratio: 0.62,
  level: 'recommended',
  metrics: [
    { id: 'turns', value: 21, watch: 10, soft: 20, urgent: 30, level: 'recommended' },
    { id: 'steps', value: 520, watch: 250, soft: 500, urgent: 900, level: 'recommended' },
    { id: 'context', value: 0.62, watch: 0.4, soft: 0.6, urgent: 0.85, level: 'recommended' },
  ],
  handoffPending: false,
  handoffSucceeded: false,
  presets: [
    { id: 'standard', name: 'Standard', isDefault: true, broken: false },
    { id: 'ptc', name: 'PTC', isDefault: false, broken: false },
  ],
}

function render(props) {
  return registration.component({
    sessionId: 'session-test',
    useProjection: () => view,
    inputActions: { setDraft() {}, submit() {} },
    ...props,
  })
}

// Collapsed strip: four-character label only, no icon, badge, or meta row.
const collapsed = render({})
if (collapsed === undefined) throw new Error('collapsed render returned nothing')
const collapsedText = JSON.stringify(collapsed)
if (!collapsedText.includes('dsh-handoff-root')) {
  console.error(collapsedText.slice(0, 1200))
  throw new Error('collapsed render missing root class')
}
if (!collapsedText.includes('dsh-handoff-title')) throw new Error('collapsed render missing title')
if (collapsedText.includes('"dsh-handoff-mark"')) throw new Error('collapsed render must not contain an icon')
if (collapsedText.includes('dsh-handoff-badge')) throw new Error('collapsed render must not contain a badge')
if (collapsedText.includes('"dsh-handoff-meta"')) throw new Error('collapsed render must not contain a meta row')

// The collapsed strip carries a small status pip left of the title, coloured by
// the current pressure level (green healthy / blue watch / amber recommended /
// red urgent, plus pending and done).
function findPip(node) {
  if (node === null || typeof node !== 'object') return undefined
  const className = node.props?.className
  if (typeof className === 'string' && className.split(' ').includes('dsh-handoff-pip')) return node
  const children = node.props?.children ?? node.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findPip(child)
    if (found !== undefined) return found
  }
  return undefined
}

const collapsedPip = findPip(collapsed)
if (collapsedPip === undefined) throw new Error('collapsed render missing status pip')
if (collapsedPip.props['data-level'] !== 'recommended') {
  throw new Error(`unexpected pip level: ${String(collapsedPip.props['data-level'])}`)
}
if (collapsedPip.props['aria-hidden'] !== 'true') throw new Error('status pip must be aria-hidden')
if (typeof collapsedPip.props.style?.background !== 'string') throw new Error('status pip missing colour')

const lowPip = findPip(render({ useProjection: () => ({ ...view, level: 'low' }) }))
if (lowPip?.props['data-level'] !== 'low') throw new Error('healthy level must use the low pip')
const urgentPip = findPip(render({ useProjection: () => ({ ...view, level: 'urgent' }) }))
if (urgentPip?.props['data-level'] !== 'urgent') throw new Error('urgent level must use the urgent pip')
const pendingPip = findPip(render({ useProjection: () => ({ ...view, handoffPending: true }) }))
if (pendingPip?.props['data-level'] !== 'pending') throw new Error('pending handoff must use the pending pip')
const donePip = findPip(render({ useProjection: () => ({ ...view, handoffSucceeded: true }) }))
if (donePip?.props['data-level'] !== 'done') throw new Error('completed handoff must use the done pip')
// Regression guard: --dsw-alias-brand-primary resolves to neutral-bluish-1000
// (near black) in the DSH light palette, which painted the watch pip black.
const watchPip = findPip(render({ useProjection: () => ({ ...view, level: 'watch' }) }))
if (watchPip?.props['data-level'] !== 'watch') throw new Error('watch level must use the watch pip')
const watchPipColor = String(watchPip?.props.style?.background ?? '')
if (watchPipColor.includes('brand-primary')) {
  throw new Error(`watch pip must not use the near-black brand token: ${watchPipColor}`)
}
if (!watchPipColor.includes('blue')) throw new Error(`watch pip must be blue: ${watchPipColor}`)

// The label itself is always tinted with the level colour, never a neutral
// fallback that can render near-black on the dock.
function findBar(node) {
  if (node === null || typeof node !== 'object') return undefined
  const className = node.props?.className
  if (typeof className === 'string' && className.split(' ').includes('dsh-handoff-bar')) return node
  const children = node.props?.children ?? node.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findBar(child)
    if (found !== undefined) return found
  }
  return undefined
}
const collapsedBar = findBar(collapsed)
if (collapsedBar === undefined) throw new Error('collapsed render missing label button')
if (typeof collapsedBar.props.style?.color !== 'string') throw new Error('label must carry a level colour')
if (collapsedBar.props.style.color.includes('label-secondary')) {
  throw new Error('label must not fall back to the neutral secondary colour')
}

// Expanded popover (force every useState call: open=true, sent=false, preset=ptc).
let draft
stateQueue.push(true, false, 'ptc')
const expanded = render({ inputActions: { setDraft: (value) => { draft = value }, submit() {} } })
const expandedText = JSON.stringify(expanded)
if (!expandedText.includes('dsh-handoff-pop')) throw new Error('expanded render missing popover')
if (!expandedText.includes('dsh-handoff-metric')) throw new Error('expanded render missing metric rows')
if (!expandedText.includes('dsh-handoff-actions')) throw new Error('expanded render missing actions')
if (!expandedText.includes('dsh-handoff-mode-select')) throw new Error('expanded render missing mode picker')

// The chosen mode must reach the draft prompt as an explicit agentPreset id.
function findPrimary(node) {
  if (node === null || typeof node !== 'object') return undefined
  if (typeof node.props?.className === 'string' && node.props.className.includes('dsh-handoff-button-primary')) return node
  const children = node.props?.children ?? node.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findPrimary(child)
    if (found !== undefined) return found
  }
  return undefined
}
const primary = findPrimary(expanded)
if (primary === undefined) throw new Error('missing primary action')
primary.props.onClick()
if (typeof draft !== 'string' || !draft.includes('agentPreset: "ptc"')) {
  throw new Error(`handoff draft did not carry the chosen preset: ${String(draft)}`)
}

// Handoff already completed.
const succeeded = render({ useProjection: () => ({ ...view, handoffSucceeded: true }) })
if (!JSON.stringify(succeeded).includes('dsh-handoff-root')) throw new Error('succeeded render failed')

// No projection yet.
const waiting = render({ useProjection: () => undefined })
if (!JSON.stringify(waiting).includes('dsh-handoff-bar-muted')) throw new Error('waiting render failed')

console.log('client selftest: ok')
