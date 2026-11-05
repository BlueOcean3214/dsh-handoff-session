#!/usr/bin/env node
// 生成 awesome-dsh-plugin 的收录条目文件，并把 GitHub 仓库信息写回 package.json。
//
// 用法：
//   node market/prep-catalog-entry.mjs --owner <你的 GitHub 用户名> [--repo dsh-handoff-session] [--dry-run]
//
// 产物：market/submission/<owner>__<repo>.yml
//   → 把这个文件原样提交到 awesome-dsh-plugin 仓库的 data/plugins/ 下即可（一个 PR 只加这一个文件）。
//
// 同时（非 --dry-run 时）会写入 package.json 的 repository / homepage / bugs：
//   npm 包只有在 package.json.repository 指回收录的那个仓库时，才会和列表条目关联上（否则没有下载量数字）。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const pkgPath = resolve(process.cwd(), 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

const owner = arg('owner')
if (!owner) {
  console.error('缺少 --owner <GitHub 用户名>（例如 --owner Santuo）')
  process.exit(1)
}
const repo = arg('repo', pkg.name)
const branch = arg('branch', 'main')
const category = arg('category', 'session')
const dryRun = flag('dry-run')

const url = `https://github.com/${owner}/${repo}`
const icon = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/assets/icon-180.png`

// 描述必须与代码一致（维护者会逐条核对），所以这里直接沿用 package.json 的 description。
// 仓库里带有 README 的英文摘要时，优先用它，避免两处描述漂移。
const descriptionEn =
  arg('description-en') ??
  'Durable session handoff for DeepSeek Harness: pressure-aware handoff docs, a searchable transcript, and automatic continuation in a fresh Session. The status pip beside the input box shades from green to blue to amber to red as pressure rises.'
const descriptionZh =
  arg('description-zh') ??
  '为 DeepSeek Harness 提供会话交接：上下文压力到阈值时写交接文档与可搜索转录，并在新会话里自动继续；输入框下方状态点随压力从绿 → 蓝 → 琥珀 → 红逐级变色。'

// YAML 标量：含「: 」、以特殊字符开头、或含 # 时必须加引号（contributing.md 明写的前者）。
function yamlScalar(value) {
  const needsQuote = /: |^\s*[-?:,[\]{}#&*!|>'"%@`]|#|\s$/.test(value)
  return needsQuote ? `'${value.replace(/'/g, "''")}'` : value
}

const lines = [
  `# 提交到 awesome-dsh-plugin 的 data/plugins/ 目录，文件名必须是 ${owner}__${repo}.yml`,
  `# 生成命令：node market/prep-catalog-entry.mjs --owner ${owner} --repo ${repo}`,
  `url: ${url}`,
  `name: ${owner}/${repo}`,
  `category: ${category}`,
  'description:',
  `  en: ${yamlScalar(descriptionEn)}`,
  `  zh: ${yamlScalar(descriptionZh)}`,
  `icon: ${icon}`,
]
const yaml = lines.join('\n') + '\n'

const outPath = resolve(process.cwd(), 'market', 'submission', `${owner}__${repo}.yml`)

if (dryRun) {
  console.log('--- 将要写入的条目文件 ---')
  console.log(yaml)
  process.exit(0)
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, yaml, 'utf8')

pkg.repository = { type: 'git', url: `git+${url}.git` }
pkg.homepage = `${url}#readme`
pkg.bugs = { url: `${url}/issues` }
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

console.log(`条目文件：${outPath}`)
console.log(`package.json 已写入 repository/homepage/bugs → https://github.com/${owner}/${repo}`)
console.log('')
console.log('接下来：')
console.log(`  1. 把仓库推到 GitHub：git remote add origin ${url}.git && git push -u origin ${branch}`)
console.log('  2. 给仓库加 topic：dsh-plugin（仓库首页右上角 About → 齿轮 → Topics）')
console.log(`  3. fork awesome-dsh-plugin，把上面的 .yml 放到 data/plugins/${owner}__${repo}.yml，提 PR`)
console.log('  4. package.json 变了 → 发个补丁版本，npm 才会和条目关联上：npm version patch && npm publish')
