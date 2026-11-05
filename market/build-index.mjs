#!/usr/bin/env node
/**
 * 生成自托管插件市场索引（format 1），产物默认写到 market/index.json。
 *
 * format 1 只认两种来源，没有第三种：
 *   - npm：{ type: 'npm' }，安装参数 `<name>@<version>`，要求该包已发布到 npm；
 *   - git：{ type: 'git', url, commit }，安装参数 `git+<url>.git#<commit>`，要求是公开可访问的 https 仓库。
 * 所以本插件必须先「发 npm」或「推到公开仓库」之一，索引才真的能装。生成脚本不改变这一点。
 *
 * 用法：
 *   node market/build-index.mjs
 *   node market/build-index.mjs --name dsh-handoff --url https://github.com/<you>/dsh-handoff
 *   node market/build-index.mjs --name dsh-handoff --source git --url https://github.com/<you>/dsh-handoff
 *   node market/build-index.mjs --check --validator <path-to-@deepseek-ai/dsh-plugin-market-index/lib/index.js>
 *
 * 常用参数：
 *   --source npm|git        来源类型，默认 npm
 *   --name <包名>            默认读 package.json
 *   --version <版本>         默认读 package.json
 *   --url <https url>        git 模式必填；npm 模式会写进 homepage/repository（可选）
 *   --commit <40 位 sha>     git 模式，默认取 `git rev-parse HEAD`
 *   --timestamp <unix 秒>    覆盖 publishTimestamp；npm 模式会先查 registry
 *   --title-en/--title-zh    条目标题，默认 Session Handoff / 会话交接
 *   --description-en/--description-zh
 *   --category <id>          默认 session
 *   --registry <url>         npm 模式的私有 registry，写进 source.registry
 *   --index-title <文本>     索引标题（en），默认 Santuo plugins
 *   --index-title-zh <文本>  索引标题（zh），默认 Santuo 插件
 *   --out <file>             默认 market/index.json
 *   --dsh-range <range>      engines.dsh；不知道就留空（本机运行时是预发布版，任何 range 都难写对）
 *   --check                  生成后调用官方校验器自查
 *   --validator <spec>       校验器模块路径或包名，默认 @deepseek-ai/dsh-plugin-market-index
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (key === 'check') { out.check = true; continue }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    out[key] = value
    i += 1
  }
  return out
}

const pad = (n) => String(n).padStart(2, '0')

/** 本地时间戳（秒），给没有 registry 可查的 git 来源兜底。 */
function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

/** `git@github.com:o/r.git`、`https://github.com/o/r/` 一律归一到 https 且无 `.git` 后缀。 */
function normalizeGitUrl(raw) {
  let url = String(raw).trim()
  const scp = /^git@([^:]+):(.+)$/.exec(url)
  if (scp) url = `https://${scp[1]}/${scp[2]}`
  url = url.replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '').replace(/\/+$/, '')
  if (!/^https:\/\//.test(url)) throw new Error(`--url 必须是 https 地址（或 git@host:path 形式）：${raw}`)
  return url
}

function gitHeadCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new Error('当前目录不是 git 仓库（或没有提交）：git 模式必须给出 --commit。先 git init/push，或改用 --source npm')
  }
}

/** 查 npm registry 上这个版本的真实发布时间（Unix 秒）。查不到返回 null。 */
async function npmPublishTime(name, version, registry = 'https://registry.npmjs.org') {
  const url = `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}`
  const response = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null)
  if (!response || !response.ok) return null
  const body = await response.json().catch(() => null)
  const stamp = body?.time?.[version]
  if (!stamp) return null
  const seconds = Math.floor(Date.parse(stamp) / 1000)
  return Number.isFinite(seconds) ? seconds : null
}

function localizedText(en, zh) {
  return zh ? { en, zh } : { en }
}

const opts = parseArgs(process.argv.slice(2))

// 参数最终都会变成字符串；JSON 对象被当参数传进来时会静默变成 "[object Object]"
// 并写进索引标题（0.6.1 的 market/index.json 就是这样坏掉的），所以在这里拦一道。
for (const [key, value] of Object.entries(opts)) {
  if (typeof value === 'string' && value.includes('[object ')) {
    throw new Error(`--${key} 收到的是 "[object Object]"：调用方传了对象而不是字符串（检查 regen-index.mjs 这类包装脚本）。`)
  }
}

const sourceType = opts.source ?? 'npm'
if (sourceType !== 'npm' && sourceType !== 'git') throw new Error(`--source 只能是 npm 或 git：${sourceType}`)

const name = opts.name ?? pkg.name
const version = opts.version ?? pkg.version
const category = opts.category ?? 'session'
const outFile = resolve(root, opts.out ?? 'market/index.json')
const warnings = []

if (opts.name && opts.name !== pkg.name) {
  warnings.push(`索引里的包名是 ${opts.name}，但 package.json 里是 ${pkg.name}。发布前必须把 package.json.name 与 cordis.patch.yml 里的 name 一起改成 ${opts.name}，否则市场装上去会和包名对不上。`)
}
if (sourceType === 'npm') {
  if (pkg.private === true) warnings.push('package.json 还是 "private": true，npm 会拒绝发布。发之前删掉这一行。')
  if (name.startsWith('@local/') || name.startsWith('@local-')) warnings.push(`包名 ${name} 是本地占位名，npm 不接受，先改成可发布的正式名（例如 dsh-handoff）。`)
}

let publishTimestamp = opts.timestamp ? Number(opts.timestamp) : undefined
let source
if (sourceType === 'npm') {
  source = opts.registry ? { type: 'npm', registry: opts.registry } : { type: 'npm' }
  if (publishTimestamp === undefined) {
    const looked = await npmPublishTime(name, version, opts.registry ?? 'https://registry.npmjs.org')
    if (looked === null) {
      warnings.push(`npm 上查不到 ${name}@${version}：索引可以生成，但用户点安装会失败。真正发布之后重新跑一次本脚本，用它查到的发布时间。`)
      publishTimestamp = nowSeconds()
    } else {
      publishTimestamp = looked
    }
  }
} else {
  const url = normalizeGitUrl(opts.url ?? '')
  if (!/^https:\/\/[^/]+\/[^/]+/.test(url)) throw new Error('git 模式必须给 --url https://github.com/<owner>/<repo>')
  const commit = opts.commit ?? gitHeadCommit()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`--commit 必须是 40 位小写 hex：${commit}`)
  source = { type: 'git', url, commit }
  if (publishTimestamp === undefined) publishTimestamp = nowSeconds()
}

const repositoryUrl = opts.url ? normalizeGitUrl(opts.url) : undefined
const homepage = opts.homepage ?? repositoryUrl

/**
 * 图标默认内联成 data URL：format 1 里相对路径按「索引 URL 的 origin」解析，
 * 索引还没托管到 https 时相对路径过不了校验，data URL 则到哪儿都能显示。
 * 想换成 GitHub 托管的 PNG，用 --icon https://.../icon.png 覆盖。
 */
function resolveIcon() {
  if (opts.icon) return opts.icon
  const file = join(root, 'icon.svg')
  if (!existsSync(file)) return undefined
  const bytes = readFileSync(file)
  if (bytes.byteLength > 32 * 1024) throw new Error('icon.svg 超过 32KiB，format 1 的 data URL 有上限；改用 --icon https://.../icon.png')
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`
}
const icon = resolveIcon()

const plugin = {
  name,
  title: localizedText(opts['title-en'] ?? 'Session Handoff', opts['title-zh'] ?? '会话交接'),
  description: localizedText(
    opts['description-en'] ?? 'Pressure-aware session handoff: writes a handoff doc before a long session degrades, then continues in a fresh session in the same workspace.',
    opts['description-zh'] ?? '长会话开始降智前自动写交接文档，并在同一工作目录开新会话继续干活；输入框下方带压力提示与“下个会话模式”选择。',
  ),
  ...(icon ? { icon } : {}),
  ...(homepage ? { homepage } : {}),
  ...(repositoryUrl ? { repository: { url: repositoryUrl } } : {}),
  metadata: {
    category,
    keywords: ['dsh-plugin', 'handoff', 'session', 'context-pressure', 'continuity'],
    labels: [],
    sortKeys: {},
  },
  versions: [
    {
      version,
      publishTimestamp,
      source,
      engines: opts['dsh-range'] ? { dsh: opts['dsh-range'] } : {},
    },
  ],
}

const index = {
  format: 1,
  title: localizedText(opts['index-title'] ?? 'Santuo plugins', opts['index-title-zh'] ?? 'Santuo 插件'),
  metadata: {
    categories: {
      session: { title: localizedText('Sessions & Messages', '会话与消息') },
      ui: { title: localizedText('Interface', '界面') },
      tools: { title: localizedText('Tools & Integrations', '工具与集成') },
    },
    labels: {},
    sortKeys: {},
  },
  plugins: [plugin],
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
if (existsSync(join(root, 'icon.svg'))) copyFileSync(join(root, 'icon.svg'), join(dirname(outFile), 'icon.svg'))

const installed = sourceType === 'npm'
  ? `${name}@${version}`
  : `git+${source.url}.git#${source.commit}`
console.log(`wrote ${outFile}`)
console.log(`entry: ${name} ${version} (${sourceType}) → marketInstallTarget: ${installed}`)
console.log(`publishTimestamp: ${publishTimestamp} (${new Date(publishTimestamp * 1000).toISOString()})`)

if (opts.check) {
  const spec = opts.validator ?? '@deepseek-ai/dsh-plugin-market-index'
  const looksLikePath = isAbsolute(spec) || spec.startsWith('.') || /^[A-Za-z]:[\\/]/.test(spec)
  const target = looksLikePath ? pathToFileURL(resolve(spec)).href : spec
  const module = await import(target).catch((error) => {
    console.error(`\n✗ 无法加载校验器 ${spec}：${error.message}`)
    console.error('  安装它：npm i -D @deepseek-ai/dsh-plugin-market-index')
    process.exit(1)
  })
  const parse = module.parseMarketIndex ?? module.default?.parseMarketIndex
  if (typeof parse !== 'function') throw new Error(`校验器 ${spec} 没有导出 parseMarketIndex`)
  const parsed = parse(index, `file://${outFile.replace(/\\/g, '/')}`)
  console.log(`✓ 校验通过：${parsed.plugins.length} 个插件`)
}

for (const warning of warnings) console.warn(`\n! ${warning}`)
