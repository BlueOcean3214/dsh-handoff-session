// 向 awesome-dsh-plugin 官方目录提收录 PR（幂等）。
//
// 前置条件：仓库 BlueOcean3214/dsh-handoff-session 建满 24 小时（CI 硬检查）。
// 用法：
//   node market/open-catalog-pr.mjs --dry-run     # 只检查条件，不动远端
//   node market/open-catalog-pr.mjs               # 真正 fork + 提 PR
//   node market/open-catalog-pr.mjs --force       # 跳过 24 小时等待
//
// token 从 .dsh/gh-token.txt 读（该目录已在 .gitignore 里）；提 PR 成功后脚本会删掉它。
// 也可以用环境变量 GH_TOKEN 覆盖。
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'BlueOcean3214'
const REPO = 'dsh-handoff-session'
const BASE = 'awesome-dsh-plugin/awesome-dsh-plugin'
const ENTRY = `${OWNER}__${REPO}.yml`
const BRANCH = `add-${REPO}`
const TOKEN_FILE = resolve(root, '.dsh/gh-token.txt')
const API = 'https://api.github.com'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const force = args.has('--force')

const token = process.env.GH_TOKEN?.trim() ||
  (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '')
if (!token) {
  console.error(`缺少 token：放在 ${TOKEN_FILE} 或设置环境变量 GH_TOKEN`)
  process.exit(2)
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-handoff-session-catalog-pr',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!res.ok && res.status !== 404) {
    const msg = typeof body === 'object' && body?.message ? body.message : text
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${msg}`)
  }
  return { status: res.status, body }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

const log = (...a) => console.log(...a)

const me = (await api('/user')).body
log(`账号：${me.login}`)
if (me.login.toLowerCase() !== OWNER.toLowerCase()) {
  console.error(`token 属于 ${me.login}，不是 ${OWNER}，停止`)
  process.exit(2)
}

// 1. 仓库年龄（CI 检查项）
const repo = (await api(`/repos/${OWNER}/${REPO}`)).body
const created = new Date(repo.created_at)
const readyAt = new Date(created.getTime() + 24 * 3600 * 1000)
const now = new Date()
log(`仓库建仓：${created.toISOString()}  满 24 小时：${readyAt.toISOString()}`)
if (now < readyAt && !force) {
  const mins = Math.ceil((readyAt - now) / 60000)
  log(`还没到时间，还差约 ${mins} 分钟。到点后重跑，或加 --force 跳过。`)
  process.exit(3)
}
log('仓库年龄检查：通过')

// 2. 是否已经有 PR / 已经收录
const baseRepo = (await api(`/repos/${BASE}`)).body
const baseBranch = baseRepo.default_branch
const existing = await api(`/repos/${BASE}/contents/data/plugins/${ENTRY}`)
if (existing.status === 200) {
  log(`目录里已经有 data/plugins/${ENTRY} —— 可能已合并，无需再提。`)
  process.exit(0)
}
const openPrs = (await api(`/repos/${BASE}/pulls?state=open&head=${OWNER}:${BRANCH}`)).body
if (Array.isArray(openPrs) && openPrs.length > 0) {
  log(`已有开着的 PR：${openPrs[0].html_url}`)
  process.exit(0)
}
log('目录里还没有这个条目，也没有开着的 PR')

const entryText = readFileSync(resolve(root, 'market/submission', ENTRY), 'utf8')
if (!/^url:\s*https:\/\/github\.com\/BlueOcean3214\/dsh-handoff-session$/m.test(entryText)) {
  console.error('条目文件里的 url 不对，先检查 market/submission/' + ENTRY)
  process.exit(2)
}

if (dryRun) {
  log('\n[dry-run] 条件全满足。实际运行会：')
  log(`  1. fork ${BASE} → ${OWNER}/awesome-dsh-plugin`)
  log(`  2. 建分支 ${BRANCH}，在 data/plugins/${ENTRY} 放条目`)
  log(`  3. 向 ${BASE} 提 PR`)
  process.exit(0)
}

// 3. fork
const forkPath = `/repos/${OWNER}/awesome-dsh-plugin`
const forkExists = (await api(forkPath)).status === 200
if (!forkExists) {
  log('正在 fork…')
  await api(`/repos/${BASE}/forks`, { method: 'POST', body: JSON.stringify({ default_branch_only: true }) })
  for (let i = 0; i < 30; i++) {
    await sleep(4000)
    if ((await api(forkPath)).status === 200) break
  }
  if ((await api(forkPath)).status !== 200) {
    console.error('fork 没有在 2 分钟内出现，稍后重跑脚本即可（已完成的步骤会跳过）')
    process.exit(4)
  }
} else {
  log('fork 已存在，直接用')
}

// 4. 分支 + 提交
let baseSha
for (let i = 0; i < 10; i++) {
  const b = await api(`${forkPath}/branches/${baseBranch}`)
  if (b.status === 200) { baseSha = b.body.commit.sha; break }
  await sleep(4000)
}
if (!baseSha) { console.error('读不到 fork 的默认分支，稍后重跑'); process.exit(4) }
log(`fork 默认分支 ${baseBranch} @ ${baseSha.slice(0, 7)}`)

const branchRef = await api(`${forkPath}/git/ref/heads/${BRANCH}`)
if (branchRef.status !== 200) {
  await api(`${forkPath}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: baseSha }),
  })
  log(`已建分支 ${BRANCH}`)
} else {
  log(`分支 ${BRANCH} 已存在`)
}

const filePath = `data/plugins/${ENTRY}`
const putRes = await api(`${forkPath}/contents/${filePath}`, {
  method: 'PUT',
  body: JSON.stringify({
    message: `Add ${OWNER}/${REPO}`,
    content: Buffer.from(entryText, 'utf8').toString('base64'),
    branch: BRANCH,
  }),
})
log(putRes.status === 201 ? `已提交 ${filePath}` : `提交返回 ${putRes.status}（可能已存在，继续）`)

// 5. PR
const body = [
  '### 这是什么',
  '',
  `${OWNER}/${REPO} —— DeepSeek Harness 的会话交接插件。它在上下文压力（轮数 / 步数 / 上下文占比）到达阈值前写一份交接文档，同时把当前对话导出成可搜索的转录 sidecar，然后建一个新 Session、把工作目录和继续指令一起带过去。`,
  '',
  '### 与 `zhijiangtang/dsh-handoff` 的区别',
  '',
  '对方是「导出」工具（把会话导出成文档），本插件是「自动接力」：阈值检测由宿主压力数据驱动，交接后自动创建并跳到新 Session，新会话第一轮会先读交接文档；输入框旁还有一个压力面板，可以在面板里选择下个会话的 Agent 预设。',
  '',
  '### 检查项',
  '',
  `- [x] \`package.json\` 声明了 \`dsh.bundle\`（patch 在 \`cordis.patch.yml\`）与 \`dsh.client\`（web，immediate）`,
  `- [x] 仓库带 \`dsh-plugin\` topic，建仓时间 ${created.toISOString()}`,
  '- [x] 已发布 npm：`dsh-handoff-session@0.6.1`，`repository` 指回本仓库',
  '- [x] 条目里没有 `npm:` 字段（按 contributing.md，关联是自动采集的）',
  '',
  '本地自测：`node selftest.mjs`、`node client-selftest.mjs` 均通过。',
].join('\n')

const pr = await api(`/repos/${BASE}/pulls`, {
  method: 'POST',
  body: JSON.stringify({
    title: `Add ${OWNER}/${REPO} (session handoff)`,
    head: `${OWNER}:${BRANCH}`,
    base: baseBranch,
    body,
  }),
})
if (pr.status === 201) {
  log(`\nPR 已创建：${pr.body.html_url}`)
  if (existsSync(TOKEN_FILE)) {
    unlinkSync(TOKEN_FILE)
    log('已删除 .dsh/gh-token.txt（token 不再需要用）')
  }
} else {
  log(`创建 PR 返回 ${pr.status}：${JSON.stringify(pr.body)}`)
  process.exit(5)
}
