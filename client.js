/**
 * Session Handoff — Client half.
 *
 * A compact status strip in the composer dock. It reads the host-owned
 * `sessionHandoffPressure` projection (wired by index.js) and explains, in
 * plain language, whether this conversation is still healthy or should hand
 * off. The primary action puts a handoff request into the composer and sends
 * it, so the model can decide the exact checkpoint itself.
 *
 * No host RPC: the projection is the read path, and InputActions is the write
 * path. That keeps this half usable from an ordinary bundle.
 */

window.__ModuleLoader__.load({
  id: 'dsh-handoff-session',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PROJECTION_KEY = 'sessionHandoffPressure'

    const DICT = {
      zh: {
        title: '会话交接',
        subtitle: '长会话的健康检查',
        health: '健康',
        watch: '留意',
        recommended: '建议交接',
        urgent: '尽快交接',
        healthDesc: '会话还年轻，继续干活就好。',
        watchDesc: '上下文开始变长，留一个干净的检查点。',
        recommendedDesc: '现在适合在下一个检查点交接，避免后半程开始漏细节。',
        urgentDesc: '上下文已经很重，建议尽快收尾当前动作并交接。',
        context: '上下文',
        turns: '轮数',
        steps: '步数',
        mode: '下个会话模式',
        modeInherit: '继承当前模式',
        modeHint: '新会话用这个模式启动',
        modeBroken: '（不可用）',
        modeDefault: '默认',
        modePrompt: '下个会话模式：{name}（agentPreset: "{id}"）。请在调用 session_handoff 时把 agentPreset 设为 "{id}"。',
        threshold: '建议阈值',
        whyTitle: '为什么要交接',
        why: '长会话会累积上下文，模型更容易漏掉早期的决定。交接会把目标、已完成、待办、关键文件和验证结果写成文档，新会话从这份文档继续。',
        step1: '写入交接文档',
        step2: '开启新会话',
        step3: '自动继续工作',
        later: '稍后',
        now: '现在交接',
        early: '提前交接',
        handoff: '交接中…',
        done: '已交接',
        doneDesc: '本会话已完成交接，新会话已就绪。',
        openNew: '打开新会话',
        autoOpened: '已自动切换到新会话',
        sent: '已发送交接指令',
        noData: '等待会话数据…',
        open: '查看',
        close: '关闭',
        aria: '会话交接状态',
        note: '点击后会发送一条交接指令；模型会先判断当前是否处于可安全停下的检查点。',
        unavailable: '当前会话不可输入，无法发起交接。',
        handoffPrompt: '当前会话压力等级：{level}（上下文 {pct}，{turn} 轮，{step} 步）。请现在执行会话交接：先判断当前是否处于可安全停下的检查点；如果是，就写一份完整交接文档并调用 session_handoff 开启新会话；如果不是，请说明还差哪一步，完成后再交接。',
      },
      en: {
        title: 'Session handoff',
        subtitle: 'A health check for long conversations',
        health: 'Healthy',
        watch: 'Watch',
        recommended: 'Handoff recommended',
        urgent: 'Handoff soon',
        healthDesc: 'This conversation is still young. Keep working.',
        watchDesc: 'Context is growing. Keep the next clean checkpoint in mind.',
        recommendedDesc: 'A good moment to hand off at the next checkpoint, before details start slipping.',
        urgentDesc: 'Context is heavy. Wrap up the current atomic step and hand off soon.',
        context: 'Context',
        turns: 'Turns',
        steps: 'Steps',
        mode: 'Next session mode',
        modeInherit: 'Inherit current mode',
        modeHint: 'The fresh session starts with this mode',
        modeBroken: ' (unavailable)',
        modeDefault: 'default',
        modePrompt: 'Next session mode: {name} (agentPreset: "{id}"). When calling session_handoff, set agentPreset to "{id}".',
        threshold: 'Suggested at',
        whyTitle: 'Why hand off',
        why: 'Long conversations accumulate context, and the model can lose early decisions. A handoff writes the goal, completed work, remaining work, key files, and verification into a document; the new session continues from it.',
        step1: 'Write the handoff',
        step2: 'Open a fresh session',
        step3: 'Continue automatically',
        later: 'Later',
        now: 'Hand off now',
        early: 'Hand off early',
        handoff: 'Handing off…',
        done: 'Handed off',
        doneDesc: 'This conversation handed off and the new session is ready.',
        openNew: 'Open new session',
        autoOpened: 'Switched to the new session',
        sent: 'Handoff request sent',
        noData: 'Waiting for session data…',
        open: 'Details',
        close: 'Close',
        aria: 'Session handoff status',
        note: 'Clicking sends a handoff request. The model first checks whether this is a safe checkpoint.',
        unavailable: 'This session cannot accept input right now.',
        handoffPrompt: 'Current session pressure: {level} (context {pct}, {turn} turns, {step} steps). Please perform the session handoff now: first decide whether this is a safe checkpoint. If it is, write a complete handoff and call session_handoff to open a fresh session. If not, state exactly what remains, finish it, then hand off.',
      },
    }

    const LEVEL_COLOR = {
      low: 'var(--dsw-alias-state-success-primary, #16a34a)',
      watch: 'var(--dsw-alias-brand-primary, #2563eb)',
      recommended: 'var(--dsw-alias-state-warn-primary, #d97706)',
      urgent: 'var(--dsw-alias-state-error-primary, #dc2626)',
    }

    const LEVEL_RANK = { low: 0, watch: 1, recommended: 2, urgent: 3 }

    // Module-level so returning to the old Session does not bounce the user
    // into the new one again (the component remounts when the view changes).
    const autoOpenedSessions = new Set()

    function levelOf(value, watch, soft, urgent) {
      if (value >= urgent) return 'urgent'
      if (value >= soft) return 'recommended'
      if (value >= watch) return 'watch'
      return 'low'
    }

    function pct(value) {
      return `${Math.round(value * 100)}%`
    }

    function metricValue(id, metric, view) {
      if (id === 'context') {
        return {
          value: Number(view.ratio) || 0,
          display: pct(Number(view.ratio) || 0),
          soft: Number(metric.soft) || 0,
          urgent: Number(metric.urgent) || 1,
          softDisplay: pct(Number(metric.soft) || 0),
        }
      }
      return {
        value: Number(metric.value) || 0,
        display: String(Math.round(Number(metric.value) || 0)),
        soft: Number(metric.soft) || 0,
        urgent: Number(metric.urgent) || 1,
        softDisplay: String(Math.round(Number(metric.soft) || 0)),
      }
    }

    function levelLabel(t, level) {
      if (level === 'urgent') return t('urgent')
      if (level === 'recommended') return t('recommended')
      if (level === 'watch') return t('watch')
      return t('health')
    }

    function levelDesc(t, level) {
      if (level === 'urgent') return t('urgentDesc')
      if (level === 'recommended') return t('recommendedDesc')
      if (level === 'watch') return t('watchDesc')
      return t('healthDesc')
    }

    function MetricBar({ id, metric, view, t }) {
      const info = metricValue(id, metric, view)
      const ratio = Math.max(0, Math.min(1, info.value / (info.urgent || 1)))
      const softRatio = Math.max(0, Math.min(1, info.soft / (info.urgent || 1)))
      const color = LEVEL_COLOR[metric.level] ?? LEVEL_COLOR.low
      const label = id === 'turns' ? t('turns') : id === 'steps' ? t('steps') : t('context')
      return h(
        'div',
        { className: 'dsh-handoff-metric' },
        h(
          'div',
          { className: 'dsh-handoff-metric-head' },
          h('span', { className: 'dsh-handoff-metric-label' }, label),
          h(
            'span',
            { className: 'dsh-handoff-metric-value' },
            h('strong', null, info.display),
            h('span', { className: 'dsh-handoff-metric-soft' }, ` / ${info.softDisplay}`),
          ),
        ),
        h(
          'div',
          { className: 'dsh-handoff-track' },
          h('span', {
            className: 'dsh-handoff-fill',
            style: { width: `${Math.round(ratio * 100)}%`, background: color },
          }),
          h('span', {
            className: 'dsh-handoff-marker',
            style: { left: `${Math.round(softRatio * 100)}%` },
            title: `${t('threshold')} ${info.softDisplay}`,
          }),
        ),
      )
    }

    function HandoffStrip(props) {
      const { useProjection, inputActions, sessionId, t, getUiWorkspace, getSessions } = props
      const view = useProjection(PROJECTION_KEY)
      const [open, setOpen] = React.useState(false)
      const [sent, setSent] = React.useState(false)
      const [preset, setPreset] = React.useState('')
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
        }
      }, [open])

      React.useEffect(() => {
        const id = view?.newSessionId
        if (typeof id !== 'string' || id === '') return undefined
        if (view?.autoOpenNewSession === false) return undefined
        const api = getUiWorkspace?.()
        if (typeof api?.openSession !== 'function') return undefined
        const key = `${String(sessionId)}:${id}`
        if (autoOpenedSessions.has(key)) return undefined
        // Do not add the key until the navigation actually fires: a re-render
        // during these 350 ms must not burn the one-shot guard.
        // Deliberately no cleanup — the navigation is still wanted if the strip
        // unmounts while the old turn is concluding.
        setTimeout(() => {
          if (autoOpenedSessions.has(key)) return
          try {
            api.openSession(id)
            autoOpenedSessions.add(key)
          } catch {
            // The new Session may not be in the Client's list yet; refresh once
            // and retry. openSession is synchronous, so a throw here means the
            // navigation was refused rather than merely slow.
            Promise.resolve(getSessions?.()?.refresh?.())
              .then(() => {
                if (autoOpenedSessions.has(key)) return
                api.openSession(id)
                autoOpenedSessions.add(key)
              })
              .catch(() => {})
          }
        }, 350)
        return undefined
      }, [getSessions, getUiWorkspace, sessionId, view?.newSessionId, view?.autoOpenNewSession])

      React.useEffect(() => {
        if (!sent || view?.handoffPending === true || view?.handoffSucceeded === true) return undefined
        const timer = setTimeout(() => setSent(false), 8000)
        return () => clearTimeout(timer)
      }, [sent, view?.handoffPending, view?.handoffSucceeded])

      const level = view?.level ?? 'low'
      const ratio = Number(view?.ratio) || 0
      const turn = Number(view?.turn) || 0
      const step = Number(view?.step) || 0
      const presets = Array.isArray(view?.presets)
        ? view.presets.filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
        : []
      const succeeded = view?.handoffSucceeded === true
      const pending = view?.handoffPending === true || sent
      const accent = succeeded ? LEVEL_COLOR.low : LEVEL_COLOR[level] ?? LEVEL_COLOR.low
      const canOpen = succeeded && typeof view?.newSessionId === 'string' && view.newSessionId !== ''
      const statusLabel = succeeded ? t('done') : pending ? t('handoff') : levelLabel(t, level)
      // The pip mirrors the popover dot so the collapsed strip carries the same
      // signal without needing a word: green = healthy, blue = watch,
      // amber = recommended, red = urgent.
      const pipLevel = succeeded ? 'done' : pending ? 'pending' : level
      const pipColor = succeeded
        ? LEVEL_COLOR.low
        : pending
          ? LEVEL_COLOR.recommended
          : LEVEL_COLOR[level] ?? LEVEL_COLOR.low

      const requestHandoff = React.useCallback(() => {
        if (inputActions === undefined || succeeded) return
        let prompt = t('handoffPrompt')
          .replace('{pct}', pct(ratio))
          .replace('{turn}', String(turn))
          .replace('{step}', String(step))
          .replace('{level}', levelLabel(t, level))
        const chosen = presets.find((row) => row.id === preset)
        if (chosen !== undefined && chosen.broken !== true) {
          prompt += `\n\n${t('modePrompt').replace('{name}', chosen.name ?? chosen.id).replaceAll('{id}', chosen.id)}`
        }
        inputActions.setDraft(prompt)
        inputActions.submit()
        setSent(true)
        setOpen(false)
      }, [inputActions, level, preset, presets, ratio, step, succeeded, t, turn])

      const openNewSession = React.useCallback(() => {
        const id = view?.newSessionId
        if (typeof id !== 'string' || id === '') return
        const api = getUiWorkspace?.()
        if (typeof api?.openSession !== 'function') return
        try {
          api.openSession(id)
        } catch {
          Promise.resolve(getSessions?.()?.refresh?.())
            .then(() => api.openSession(id))
            .catch(() => {})
        }
      }, [getSessions, getUiWorkspace, view?.newSessionId])

      if (view === undefined || view === null) {
        return h(
          'div',
          { className: 'dsh-handoff-root', 'data-session-id': sessionId },
          h('style', { key: 'dsh-handoff-styles' }, styles),
          h(
            'div',
            { className: 'dsh-handoff-bar dsh-handoff-bar-muted', title: t('noData') },
            h('span', { className: 'dsh-handoff-pip dsh-handoff-pip-muted', 'aria-hidden': 'true' }),
            h('span', { className: 'dsh-handoff-title' }, t('title')),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsh-handoff-root', 'data-session-id': sessionId, ref: rootRef },
        h('style', { key: 'dsh-handoff-styles' }, styles),
        open &&
          h(
            'div',
            {
              className: 'dsh-handoff-pop',
              role: 'dialog',
              'aria-label': t('aria'),
              style: { '--handoff-accent': accent },
            },
            h(
              'div',
              { className: 'dsh-handoff-pop-head' },
              h(
                'div',
                { className: 'dsh-handoff-pop-title' },
                h('strong', null, t('title')),
                h('span', null, t('subtitle')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-handoff-icon-button',
                  'aria-label': t('close'),
                  onClick: () => setOpen(false),
                },
                '×',
              ),
            ),
            h(
              'div',
              { className: 'dsh-handoff-status', style: { background: `color-mix(in srgb, ${accent} 9%, transparent)`, borderColor: `color-mix(in srgb, ${accent} 22%, transparent)` } },
              h('span', { className: 'dsh-handoff-dot', style: { background: accent } }),
              h(
                'div',
                { className: 'dsh-handoff-status-copy' },
                h('strong', { style: { color: accent } }, statusLabel),
                h('p', null, succeeded ? t('doneDesc') : levelDesc(t, level)),
              ),
            ),
            h(
              'div',
              { className: 'dsh-handoff-metrics' },
              ...(Array.isArray(view.metrics) ? view.metrics : []).map((metric) =>
                h(MetricBar, { key: metric.id, id: metric.id, metric, view, t }),
              ),
            ),
            presets.length > 0 &&
              h(
                'div',
                { className: 'dsh-handoff-mode' },
                h(
                  'label',
                  { className: 'dsh-handoff-mode-label' },
                  t('mode'),
                  h(
                    'select',
                    {
                      className: 'dsh-handoff-mode-select',
                      value: preset,
                      onChange: (event) => setPreset(event.target.value),
                    },
                    h('option', { value: '' }, t('modeInherit')),
                    ...presets.map((row) =>
                      h(
                        'option',
                        { key: row.id, value: row.id, disabled: row.broken === true },
                        `${row.name ?? row.id}${row.isDefault === true ? ` · ${t('modeDefault')}` : ''}${row.broken === true ? t('modeBroken') : ''}`,
                      ),
                    ),
                  ),
                ),
                h('span', { className: 'dsh-handoff-mode-hint' }, t('modeHint')),
              ),
            h(
              'div',
              { className: 'dsh-handoff-why' },
              h('strong', null, t('whyTitle')),
              h('p', null, t('why')),
            ),
            h(
              'div',
              { className: 'dsh-handoff-flow' },
              h('span', null, t('step1')),
              h('span', { className: 'dsh-handoff-arrow' }, '→'),
              h('span', null, t('step2')),
              h('span', { className: 'dsh-handoff-arrow' }, '→'),
              h('span', null, t('step3')),
            ),
            h(
              'div',
              { className: 'dsh-handoff-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-handoff-button dsh-handoff-button-secondary',
                  onClick: () => setOpen(false),
                },
                t('later'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-handoff-button dsh-handoff-button-primary',
                  style: { background: accent },
                  onClick: canOpen ? openNewSession : requestHandoff,
                  disabled: canOpen ? false : inputActions === undefined || succeeded || pending,
                  title: inputActions === undefined ? t('unavailable') : undefined,
                },
                canOpen ? t('openNew') : succeeded ? t('done') : pending ? t('handoff') : level === 'low' ? t('early') : t('now'),
              ),
            ),
            h('p', { className: 'dsh-handoff-note' }, t('note')),
          ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-handoff-bar',
            'data-level': succeeded ? 'done' : pending ? 'pending' : level,
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': canOpen
              ? t('openNew')
              : `${t('title')} · ${t('context')} ${pct(ratio)} · ${t('turns')} ${turn} · ${t('steps')} ${step}`,
            title: canOpen
              ? `${t('openNew')} · ${view.newSessionId}`
              : `${levelLabel(t, level)} · ${t('context')} ${pct(ratio)} · ${t('turns')} ${turn} · ${t('steps')} ${step}`,
            style: {
              color:
                canOpen || level === 'recommended' || level === 'urgent'
                  ? accent
                  : 'var(--dsw-alias-label-secondary, rgba(0,0,0,.55))',
            },
            onClick: canOpen ? openNewSession : () => setOpen((value) => !value),
          },
          h('span', {
            className: 'dsh-handoff-pip',
            'data-level': pipLevel,
            'aria-hidden': 'true',
            style: { background: pipColor },
          }),
          h('span', { className: 'dsh-handoff-title' }, canOpen ? t('openNew') : t('title')),
        ),
      )
    }

    const styles = `      .dsh-handoff-root {
        position: relative;
        display: inline-flex;
        align-items: center;
        margin-left: auto;
        width: auto;
        min-height: 0;
        font-family: inherit;
        color: var(--dsw-alias-label-primary, #1a1a1a);
      }
      .dsh-handoff-bar {
        display: inline-flex;
        align-items: center;
        width: auto;
        min-height: 18px;
        margin: 0;
        padding: 0 4px;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .dsh-handoff-bar:hover {
        background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05));
      }
      .dsh-handoff-bar:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #2563eb);
        outline-offset: 1px;
      }
      .dsh-handoff-bar-muted { cursor: default; opacity: .55; }
      .dsh-handoff-title {
        font-size: 12px;
        font-weight: 500;
        line-height: 18px;
        white-space: nowrap;
      }
      .dsh-handoff-pip {
        display: inline-block;
        flex: 0 0 auto;
        width: 6px;
        height: 6px;
        margin-right: 6px;
        border-radius: 999px;
        background: var(--dsw-alias-state-success-primary, #16a34a);
      }
      .dsh-handoff-pip[data-level="recommended"],
      .dsh-handoff-pip[data-level="urgent"],
      .dsh-handoff-pip[data-level="pending"] {
        animation: dsh-handoff-pulse 1.8s ease-in-out infinite;
      }
      @keyframes dsh-handoff-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .55; }
      }
      @media (prefers-reduced-motion: reduce) {
        .dsh-handoff-pip { animation: none !important; }
      }
      .dsh-handoff-pip-muted { background: var(--dsw-alias-label-tertiary, rgba(0,0,0,.28)); }
      .dsh-handoff-pop {
        position: absolute;
        right: 0;
        bottom: calc(100% + 6px);
        left: auto;
        width: min(360px, calc(100vw - 24px));
        z-index: 40;
        max-height: min(62vh, 560px);
        overflow: auto;
        padding: 14px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
        border-radius: 12px;
        background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base, #fff));
        box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
      }
      .dsh-handoff-pop-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .dsh-handoff-pop-title { display: flex; flex-direction: column; gap: 2px; }
      .dsh-handoff-pop-title strong { font-size: 13px; }
      .dsh-handoff-pop-title span {
        color: var(--dsw-alias-label-secondary, rgba(0,0,0,.55));
        font-size: 11px;
      }
      .dsh-handoff-icon-button {
        width: 24px;
        height: 24px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-label-secondary, rgba(0,0,0,.55));
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .dsh-handoff-icon-button:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); }
      .dsh-handoff-status {
        display: flex;
        align-items: flex-start;
        gap: 9px;
        padding: 9px 10px;
        border: 1px solid;
        border-radius: 9px;
        margin-bottom: 12px;
      }
      .dsh-handoff-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        margin-top: 4px;
        flex: 0 0 auto;
      }
      .dsh-handoff-status-copy { display: flex; flex-direction: column; gap: 3px; }
      .dsh-handoff-status-copy strong { font-size: 12px; }
      .dsh-handoff-status-copy p {
        margin: 0;
        color: var(--dsw-alias-label-secondary, rgba(0,0,0,.65));
        font-size: 11px;
        line-height: 1.5;
      }
      .dsh-handoff-metrics { display: flex; flex-direction: column; gap: 9px; margin-bottom: 12px; }
      .dsh-handoff-mode {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
        font-size: 11px;
        color: var(--dsw-alias-label-secondary, rgba(0,0,0,.65));
      }
      .dsh-handoff-mode-label { display: inline-flex; align-items: center; gap: 6px; }
      .dsh-handoff-mode-select {
        min-height: 26px;
        max-width: 190px;
        padding: 0 6px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.14));
        border-radius: 7px;
        background: var(--dsw-alias-bg-layer-1, #fff);
        color: var(--dsw-alias-label-primary, #1a1a1a);
        font: inherit;
        font-size: 11px;
    }
      .dsh-handoff-mode-hint { font-size: 10px; opacity: .75; }
      .dsh-handoff-metric-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 4px;
        font-size: 11px;
      }
      .dsh-handoff-metric-label { color: var(--dsw-alias-label-secondary, rgba(0,0,0,.65)); }
      .dsh-handoff-metric-value strong { font-size: 11px; }
      .dsh-handoff-metric-soft { color: var(--dsw-alias-label-secondary, rgba(0,0,0,.45)); }
      .dsh-handoff-track {
        position: relative;
        height: 5px;
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.08));
        overflow: hidden;
      }
      .dsh-handoff-fill {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        border-radius: 999px;
        transition: width .18s ease, background .18s ease;
      }
      .dsh-handoff-marker {
        position: absolute;
        top: -2px;
        bottom: -2px;
        width: 1px;
        background: var(--dsw-alias-label-secondary, rgba(0,0,0,.35));
        opacity: .6;
      }
      .dsh-handoff-why {
        padding: 10px;
        border-radius: 9px;
        background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.03));
        margin-bottom: 10px;
      }
      .dsh-handoff-why strong { font-size: 11px; }
      .dsh-handoff-why p {
        margin: 4px 0 0;
        color: var(--dsw-alias-label-secondary, rgba(0,0,0,.65));
        font-size: 11px;
        line-height: 1.55;
      }
      .dsh-handoff-flow {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 5px;
        margin-bottom: 12px;
        color: var(--dsw-alias-label-secondary, rgba(0,0,0,.65));
        font-size: 11px;
      }
      .dsh-handoff-arrow { opacity: .5; }
      .dsh-handoff-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .dsh-handoff-button {
        min-height: 30px;
        padding: 0 12px;
        border-radius: 8px;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .dsh-handoff-button:disabled { opacity: .5; cursor: default; }
      .dsh-handoff-button-secondary {
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12));
        background: transparent;
        color: var(--dsw-alias-label-primary, #1a1a1a);
      }
      .dsh-handoff-button-secondary:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04)); }
      .dsh-handoff-button-primary {
        border: 1px solid transparent;
        color: #fff;
      }
      .dsh-handoff-button-primary:hover { filter: brightness(1.05); }
      .dsh-handoff-note {
        margin: 9px 0 0;
        color: var(--dsw-alias-label-secondary, rgba(0,0,0,.5));
        font-size: 10px;
        line-height: 1.5;
      }
    `

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'sessions'],
      apply(ctx) {
        const translate = ctx.locale?.bind?.('session-handoff')
        const t = (key) => {
          if (typeof translate === 'function') {
            try {
              const value = translate(key)
              if (typeof value === 'string' && value !== '') return value
            } catch {}
          }
          return DICT.zh[key] ?? key
        }

        ctx.effect(() => {
          const disposers = []
          try {
            disposers.push(ctx.locale.register('session-handoff', 'zh', DICT.zh))
            disposers.push(ctx.locale.register('session-handoff', 'en', DICT.en))
          } catch (error) {
            ctx.logger?.warn?.(`session-handoff ui: locale registration skipped: ${String(error)}`)
          }
          return () => {
            for (const dispose of disposers.reverse()) {
              try {
                dispose?.()
              } catch {}
            }
          }
        }, 'session-handoff ui strings')

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'session-handoff',
              order: 2,
            },
            (props) =>
              h(HandoffStrip, { ...props, t, getUiWorkspace: () => ctx.uiWorkspace, getSessions: () => ctx.sessions }),
          ),
        )
      },
    }
  },
})
