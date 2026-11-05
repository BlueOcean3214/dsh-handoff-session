// 重新生成 market/index.json。
//
// 为什么不直接用 PowerShell 调 build-index.mjs：Windows 控制台把中文参数按 GBK
// 传递给 node 时会被拆开（"--description-zh 为 DeepSeek…" 会变成多个参数），
// 所以所有参数都在这个小脚本里以数组形式传递，标题/描述从现有索引里读出来。
//
// 用法：
//   node market/regen-index.mjs                 # 用 package.json 的 name/version
//   node market/regen-index.mjs --no-check      # 跳过官方校验器（没装校验器时）
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const indexPath = resolve(here, 'index.json')

const defaults = {
  title: { en: 'Santuo plugins', zh: 'Santuo 插件' },
  description: {
    en: 'Plugins published by Santuo for DeepSeek Harness.',
    zh: 'Santuo 发布给 DeepSeek Harness 的插件。',
  },
  plugin: {
    title: { en: 'Session Handoff', zh: '会话交接' },
    description: {
      en: 'Pressure-aware session handoff: writes a handoff doc before a long session degrades, then continues in a fresh session in the same workspace. A status pip and its label shade from green to blue to amber to red as pressure rises.',
      zh: '长会话降智前自动写交接文档，并在同一工作目录开新会话继续；输入框下方常驻压力提示，状态点与文字颜色随压力从绿 → 蓝 → 琥珀 → 红逐级变化。',
    },
  },
}

const old = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : null
const oldPlugin = old?.plugins?.find((p) => p.name === pkg.name) ?? old?.plugins?.[0]

// 旧索引的 title 是 { en, zh } 对象，不能直接当命令行参数：字符串化会变成
// "[object Object]"（0.6.1 的索引标题就是这样坏的）。这里取字段，取不到就用默认值。
const pickText = (value, fallback) =>
  typeof value === 'string' && value.trim() !== '' && !value.includes('[object ') ? value : fallback

const indexTitleEn = pickText(old?.title?.en, defaults.title.en)
const indexTitleZh = pickText(old?.title?.zh, defaults.title.zh)

const args = [
  resolve(here, 'build-index.mjs'),
  '--name', pkg.name,
  '--version', pkg.version,
  '--source', 'npm',
  '--category', 'session',
  '--index-title', indexTitleEn,
  '--index-title-zh', indexTitleZh,
  '--title-en', oldPlugin?.title?.en ?? defaults.plugin.title.en,
  '--title-zh', oldPlugin?.title?.zh ?? defaults.plugin.title.zh,
  '--description-en', oldPlugin?.description?.en ?? defaults.plugin.description.en,
  '--description-zh', oldPlugin?.description?.zh ?? defaults.plugin.description.zh,
]

const validator = process.env.DSH_MARKET_VALIDATOR ??
  `${process.env.TEMP}\\pmi-verify\\node_modules\\@deepseek-ai\\dsh-plugin-market-index\\lib\\index.js`

if (!process.argv.includes('--no-check') && existsSync(validator)) {
  args.push('--check', '--validator', validator)
} else if (!process.argv.includes('--no-check')) {
  console.warn('warning: 没找到官方校验器，跳过校验（可用 DSH_MARKET_VALIDATOR 指定路径）')
}

const r = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
})
process.exit(r.status ?? 1)
