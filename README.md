# Session Handoff（会话交接）

DeepSeek Harness 的 Host + Client 插件：在长会话开始“降智”前，让模型自己判断一个合适的收尾点，写出交接文档，并在同一工作目录里自动开一个新会话继续干活。旧会话的子智能体会一起迁移：还在跑的先打断，没做完的任务写成自包含的接手提示词，由新会话重新派出子智能体接着做；会话里没有子智能体时，就是一次普通交接，行为和以前完全一样。

它替代的手工流程是：让模型写交接文档 → 点“下一步” → 复制提示词 → 新建会话 → 粘贴。现在只需要模型调用一次 `session_handoff`。

## 它做了什么

1. **压力投影**：折叠每个会话的 `turn/start`、`step/start`、`request/context`、`assistant/message`、`tool/call`、`tool/result` 事件，得到轮数、步数、上下文占用、累计 token、缓存命中率。
2. **动态提示**：每次请求都会在运行时上下文里加入一段 `<session-pressure>`，告诉模型当前压力和 `level`（`low` / `watch` / `recommended` / `urgent`）。
3. **策略段**：系统提示里加入“会话寿命与交接”规则，明确只在 `recommended` / `urgent` 且处于可持久化检查点时调用工具。
4. **交接工具**：`session_handoff` 把目标、现状、已完成、待办、决策、关键文件、验证结果写进 `<cwd>/.dsh/handoffs/handoff-<时间>-<会话>.md`，同时在同目录写一份可检索的 `handoff-<时间>-<会话>.transcript.md`；还会快照旧会话的子智能体（默认打断仍在跑的），把它们的任务和进度写进文档，并给每个没跑完的子智能体生成一段自包含的“接手提示词”，让新会话用自带 `subagent` 工具重新派出；随后用 `sessionController.create()` 新建会话；用 `sessionController.prompt()` 把“读交接文档 + 继续指令”发过去；最后结束旧回合。新会话只读摘要，缺细节时再按需 `grep` 转录，不会整份塞进上下文。
5. **界面**：`client.js` 在输入框下方右侧只放一个 6px 状态点 + “会话交接”四个字，不占图标位、不挡内置状态。状态点的颜色随压力从绿 → 蓝 → 琥珀 → 红逐级变化（绿=健康、蓝=留意、琥珀=建议交接、红=尽快交接；交接中为琥珀色脉冲，完成后变回绿色），「会话交接」四个字的颜色也跟着同一套等级色走；配色只用 DSH 调色板里真实存在的 token（`--dsw-alias-state-success/warn/error-primary` 与 `--dsw-static-blue-500`），不再用会被解析成近黑色的 `--dsw-alias-brand-primary`。点这四个字展开面板，能看到三项阈值进度和解释。点“现在交接”会直接把交接指令填进输入框并发送，不需要复制提示词。交接完成后会自动切到新会话，也可以手动点“打开新会话”。

新会话不会看到旧对话，所以工具参数里的 `summary` 和 `nextPrompt` 必须是自包含的。

## 安装

从 npm 装（包名 `dsh-handoff-session`）：

```
dsh plugin add dsh-handoff-session
```

装本地开发副本：在 DSH 里用 Plugin Manager 安装这个目录（绝对路径）：

```
C:\Users\Santuo\Desktop\chajian
```

对应调用是 `plugin_manager` 的 `install_bundle`，`target` 传上面的目录。安装后 `list_plugins` 里应出现 `Session Handoff / 会话交接`。

> 这个包是 Host + Client bundle，没有构建步骤。Host 半负责投影、提示和工具；Client 半是输入框下方的“会话交接”文字按钮，用一个投影读取压力，不依赖 Host RPC。装好后刷新一次 Web 页面，Client 半才会进入页面。
>
> 刷新请在 DeepSeek Harness 桌面窗口里做（Ctrl+R），或使用 `dsh web` 打印的带 token 地址。直接打开裸的 `http://127.0.0.1:<port>` 会返回 401 `dsh web authentication required`，这不是插件的问题。

## 发布到插件市场

市场读的是 format 1 的索引 JSON（`@deepseek-ai/dsh-plugin-market-index` 是唯一的校验器）。有两条路：

| 路径 | 谁审核 | 前提 |
| --- | --- | --- |
| 官方目录（awesome-dsh-plugin） | 维护者逐条核对 | 公开 GitHub 仓库 + `dsh-plugin` topic + 仓库创建满 1 天 + `package.json` 里声明 `dsh.bundle` |
| 自托管索引（本仓库这条） | 没人审核 | 索引挂在一个 https 地址上，用户自己把它加进 Index sources |

**format 1 只认两种来源**：`npm`（安装参数 `<name>@<version>`）和 `git`（安装参数 `git+<url>.git#<commit>`，commit 必须是 40 位小写 hex）。也就是说，代码必须先发到 npm 或推到公开仓库，索引才真的能装；纯本地目录没法被 format 1 表达。

### 生成索引

```bash
# npm 来源（推荐：装的时候不触发构建授权）
node market/build-index.mjs --name dsh-handoff-session

# 公开 git 仓库来源（有 GitHub 仓库之后）
node market/build-index.mjs --source git --name dsh-handoff-session --url https://github.com/<you>/dsh-handoff-session

# 生成后立刻用官方校验器自查
node market/build-index.mjs --name dsh-handoff-session --check --validator <path-to>/@deepseek-ai/dsh-plugin-market-index/lib/index.js
```

产物是 `market/index.json`（外加一份 `market/icon.svg`）。图标默认内联成 `data:` URL，所以索引挂在任何 https 目录下都能显示。常用参数：`--title-en/--title-zh`、`--description-en/--description-zh`、`--version`、`--timestamp`、`--category`、`--registry`、`--icon`、`--out`、`--dsh-range`（`engines.dsh`，值必须是 SemVer range）。

npm 来源会自动去 registry 查该版本的真实发布时间当 `publishTimestamp`；查不到就打警告（这时索引格式合法、但用户点安装会失败）。

### 托管 + 加源

1. 放进 Git 仓库用 raw 地址：`https://raw.githubusercontent.com/<owner>/<repo>/main/market/index.json`（本项目用的就是这条，`max-age=300`，5 分钟内生效，不需要任何额外服务）。也可以放 GitHub Pages（Settings → Pages → Deploy from branch → `/docs` 或根目录）。要注意 `https://cdn.jsdelivr.net/npm/<pkg>/market/index.json` 虽然能直接用，但 npm 包里的文件不可变、而且 jsDelivr 对不固定版本的路径缓存 12 小时，发新版后索引会滞后，除非每次都用 `@<version>` 固定路径。
2. DSH 里打开 Plugins → Discover，在 Index sources 里加这个 URL。
3. 刷新后列表里出现 `会话交接`，点安装即可；装的时候走的是上面那个 `marketInstallTarget`，所以 npm 包必须已经发出来（或 git commit 已经推上去）。

### 投稿到官方目录（可选）

**完整操作手册见 [docs/catalog-submission.md](docs/catalog-submission.md)**（建仓 → 加 topic → 等满 1 天 → 生成条目 → 提 PR → 合并后关联 npm）。要提交的内容就一个文件：

```powershell
node market/prep-catalog-entry.mjs --owner <你的 GitHub 用户名>
# → market/submission/<owner>__dsh-handoff-session.yml
```

同时会把 `repository` / `homepage` / `bugs` 写进 `package.json`（npm 包只有指回收录的仓库，才会和条目关联、显示下载量）。

规则要点：`awesome-dsh-plugin/awesome-dsh-plugin` 只加一个文件 `data/plugins/<owner>__<repo>.yml`（字段：`url`、`name`、`category`、`description.en`，可选 `zh` / `icon`），README 由脚本生成、不要手改。维护者的硬性检查：`package.json` 必须有 `dsh.bundle`（只写 `dsh.client` 是最常见的被拒原因）、仓库有真实可用代码、仓库创建满 1 天、仓库带 `dsh-plugin` topic、描述与代码一致。分类用 `session`（Sessions & Messages）。`icon` 只收 **GitHub 托管的位图**（SVG 和第三方图床会被拒），所以仓库里备了 `assets/icon-180.png`（由 `node market/make-icon.mjs` 生成）。

### 发布准备状态

已发布：

- npm：`dsh-handoff-session@0.6.0`（2026-11-03 13:51）、`@0.6.1`（14:29，带 `repository` 字段，npm 页面上已关联 GitHub 仓库）、`@0.7.0`（2026-11-05 14:44，新增「会话交接」左侧 6px 压力状态点，颜色顺序绿→蓝→琥珀→红）和 `@0.7.1`（2026-11-05，修掉 watch 档把 `--dsw-alias-brand-primary` 当蓝色用、结果渲染成近黑的问题，改用 `--dsw-static-blue-500`；文字颜色一律跟随等级色；描述文案补上「颜色随压力逐级变化」）：`https://www.npmjs.com/package/dsh-handoff-session`，`npm i dsh-handoff-session` 与 `dsh plugin add dsh-handoff-session` 都验证可用。
- 自托管索引：**`https://raw.githubusercontent.com/BlueOcean3214/dsh-handoff-session/main/market/index.json`**（`Cache-Control: max-age=300`，内容就是仓库里的 `market/index.json`，`marketInstallTarget` = `dsh-handoff-session@0.7.1`）。
  - 也试过 `https://cdn.jsdelivr.net/npm/dsh-handoff-session/market/index.json`：能用，但 npm 包里的文件不可变，发版后 `publishTimestamp` 只能写预估值；而且 jsDelivr 对 `/npm/<pkg>/` 这种不固定版本的路径缓存 12 小时（回源节点之间还会不一致，`purge.jsdelivr.net` 也不保证立刻全清）。所以索引改由 Git 托管。
- 包名定为 `dsh-handoff-session`（`dsh-handoff` 已被 `zhijiangtang/dsh-handoff` 占用，而且对方也是会话交接类插件；`dsh-session-handoff`、`dsh-handoff-kit`、`dsh-continuity`、`dsh-session-continuity` 同样被占）。
- `package.json`：去掉 `private`，补 `license: MIT`、`keywords`、`publishConfig.access: public`；`cordis.patch.yml` 的 `insert.name` 与 `client.js` 的模块 `id` 已同步改名，`client-selftest.mjs` 里的断言也一起改了。
- 仓库素材：`LICENSE`（MIT）、`.gitignore`（挡住 `.dsh/` 里的对话记录）、`.gitattributes`（统一 LF）、`assets/icon-180.png`（180×180 市场卡片图标）。
- 公开仓库：**https://github.com/BlueOcean3214/dsh-handoff-session**（2026-11-03 14:20 建仓并推送 `main`，`dsh-plugin` topic 已加，`package.json` 的 `repository` / `homepage` / `bugs` 已指向它；`assets/icon-180.png` 经 raw.githubusercontent 验证返回 200 `image/png`；`v0.6.1` 标签已推）。
- 索引生成：`node market/regen-index.mjs`（读 `package.json` 的 name/version，标题描述沿用现有索引，默认调官方校验器；PowerShell 直接传中文参数会被 GBK 拆坏，所以走这个小脚本）。

仍缺：

- 官方目录 PR：**#11897 已于 2026-11-04 00:56（+08:00）合并**，条目 `data/plugins/BlueOcean3214__dsh-handoff-session.yml` 已进 `awesome-dsh-plugin`；官方「发现」页与 `dsh-market` 面板（`https://awesome-dsh-plugin.com/plugins.json`）都能搜到，详情页 `https://awesome-dsh-plugin.com/p/BlueOcean3214/dsh-handoff-session/`。后续改标题/分类直接给该 YAML 提小 PR 即可，不用重发 npm。
- `screenshots.json`（可选）：仓库根放 1–8 张截图能让详情页更好看，需要真实界面截图后再加。
- `engines.dsh`：本机运行时是预发布版（`@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.3`），写死 range 容易把预发布版排除掉，暂时留空。

> 发布细节：`npm publish` 首次上传返回 `202` + “being processed”，registry 里先出现一个 `0.0.0-stage` 占位版本，这次约 1 分钟后 `dist-tags.latest` 才变成 `0.6.1`——这是 npm 的暂存机制，不是失败。账号开了 2FA 时用带 bypass-2FA 的 granular token 一次性发布（`--//registry.npmjs.org/:_authToken=...`），不要写进 `.npmrc`。
>
> 注意：npm 包内那份 `market/index.json` 的 `publishTimestamp` 是发布前生成时估的（`1793687327`，差 66 秒），仓库里的那份才是 registry 的真实时间（`1793687393`）。索引现在从 Git 托管，所以以后不用再为此重发版本。

## 配置

配置在 `cordis.patch.yml` 的 `config` 里。改完把 bundle 关掉再打开（`plugin_manager` 的 `set_bundle`），Host 会重新读取包内 patch；只改 JS 不会热更新 Host 半。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `turnsWatch` / `turnsSoft` / `turnsUrgent` | 10 / 20 / 30 | 轮数阈值 |
| `stepsWatch` / `stepsSoft` / `stepsUrgent` | 250 / 500 / 900 | 步数阈值 |
| `contextWatch` / `contextSoft` / `contextUrgent` | 0.40 / 0.60 / 0.85 | 上下文占用比例阈值 |
| `handoffDir` | `.dsh/handoffs` | 相对会话 cwd 的交接文档目录 |
| `language` | `zh` | 文档和续接提示语言，`zh` 或 `en` |
| `concludeTurn` | `true` | 交接成功后立刻结束旧回合 |
| `autoOpenNewSession` | `true` | 交接成功后 Client 半自动切到新会话 |
| `transcript` | `true` | 额外导出一份可检索的完整转录旁路 |
| `transcriptMaxChars` | `120000` | 转录字符上限，超出时省略中段 |
| `transcriptReasoning` | `false` | 是否把模型 reasoning 也写进转录 |
| `transcriptToolOutput` | `true` | 是否把工具参数和工具结果写进转录 |
| `subagents` | `interrupt` | 子智能体处理方式：`off` 忽略 / `keep` 只记录 / `interrupt` 记录并打断仍在跑的 |
| `subagentTakeover` | `true` | 给每个未完成子智能体生成接手提示词，交给新会话重新派出 |
| `subagentMaxItems` | `8` | 详细记录多少个直接子智能体（0–50） |
| `subagentChars` | `900` | 子智能体任务/进度每段最多保留多少字符（200–8000） |

默认值参考了用户截图里的 `22 轮 / 677 步 / 24%`：这个状态会落在 `recommended`，模型会在下一个干净检查点交接，而不是每轮都打扰。

### 转录旁路

交接时除了 `handoff-*.md`，还会在同一个目录写一份 `handoff-*.transcript.md`：

- 只收录人类 `user/message`、助手正文、`tool/call` 参数、`tool/result` 输出；默认不写 reasoning，也不写运行时注入；
- **不会**自动塞进新会话的上下文，新会话第一轮只读摘要；缺细节时再 `read`/`grep` 这份文件；
- 超过 `transcriptMaxChars` 时保留开头 25% 和结尾 75%，中间标注省略；
- 文件里可能含命令输出、文件内容等敏感信息，交接目录应按项目需要清理或加入 `.gitignore`。

### 子智能体交接

交接时 Host 会调用 `subagents.listDescendants(sessionId)`，取这个会话名下的子智能体会话：

- 只详细读 **直接子级**（`depth: 1`），最多 `subagentMaxItems` 个；更深的孙级只统计 running 数、不单独成节，因为它们的任务属于各自父级。
- 每个子智能体记下：标签、会话 id、模式（`continuable` / `one-shot` / …）、交接时状态（running / inactive）、原任务（第一条人类 user/message）、最近进展（最后一条助手正文）、最后调用的工具、轮次/步数、最后回合是否 `completed`。
- `subagents: interrupt` 时，对所有仍在 running 的后代调用 `subagents.interrupt(id, authority)`（父 Agent 在线用 `{kind:'ancestor', agent}`，否则用 `{kind:'user', parentSessionId}`）。这是 fire-and-forget：工具只保证“已发出打断请求”，不等待子会话真正停下。
- 新会话**无法给旧子智能体发消息**（旧子级挂在旧父会话下），所以续接提示里附 `## 子智能体接手`：每个未完成子智能体一段 fenced 的接手提示词（原任务、已做进度、最后工具、核对现状/只补缺口的步骤），由新会话用自带 `subagent` 工具重新派出。已 `completed` 的子智能体只进文档，不进接手清单。
- 子智能体日志读失败只记 warning，不阻塞交接；读不到内容时文档仍列会话 id 和状态。
- `subagentTakeover: false` 只写文档、不生成接手提示词；`subagents: off` 完全不碰子智能体。

## 已验证

- `node --check index.js` 通过，`node selftest.mjs` 输出 `selftest: ok`。
- `node --check client.js` 通过，`node client-selftest.mjs` 输出 `client selftest: ok`（用假 React/模块加载器渲染折叠态、展开态、已交接态和无投影态）。
- bundle 已用 `plugin_manager install_bundle` 安装到 `desktop` profile，Host 激活成功；实时运行时上下文里能看到 `<session-pressure ...>`，`context_tokens` 为完整 prompt（含缓存命中），`cache_read` 为合理百分比。
- 在 Host 内做过一次 smoke test：`sessionController.create()` 成功创建新会话，`sessionController.prompt()` 被接受，新会话第一轮回复了 `HANDOFF-OK`，会话日志里能看到 `user/message` → `assistant/message` → `turn/end: completed`。
- 转录旁路用真实会话日志（3445 个事件）验证过：生成文件被正确截断到上限，开头保留首轮用户目标，结尾保留最近工具输出；`selftest.mjs` 也断言了用户消息、助手正文和工具结果都进入转录。
- 工具栏目的注册已用 `cordis_inspect_query` 的 `Tool.listTools` 确认存在。
- `Slots.listSubTree` 已确认：刷新后 `conversation.composer.dock` 出现 `session-handoff`（order 2，active），与内置 `activity`/`usage` 并列。
- 真实 GUI（desktop profile，0.5.1 时代验证；当前已升到 0.6.0 并改名为 `dsh-handoff-session`）已由用户确认：`Ctrl+R` 刷新后“会话交接”入口可见，弹层里“下个会话模式”下拉框列出 `标准` / `PTC` / `极简` / `创造` 并能选中“创造模式”；`plugin_manager list_plugins` 同时显示 `include:preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis` 均 active，`include:session-handoff` active。
- 真实 GUI 已确认自动跳转有效：交接后界面自动切到新会话，无需手动点“打开新会话”。选中“创造模式”后交接文档头部记 `Agent 预设: cordis`，新会话的工具集里也确实带 `cordis_inspect_*`（Agent Teams 同样可用），说明下拉选择按 `提示词 → agentPreset → 创建请求` 全链路生效。
- 子智能体交接（0.8.0）在真实 GUI 里跑过一遍：旧会话派出 `quick`（已完成）与 `slow`（`Start-Sleep -Seconds 600`）两个子智能体后立即交接；交接文档出现 `## 子智能体 (2/2)`，`slow` 状态为“交接时仍在运行，已请求打断”；续接提示里出现 `## 子智能体接手` 与 `slow` 的自包含接手提示（原任务、已有进度、最后工具）。此时 `slow` 的后台作业在交接瞬间被 `kill`（会话日志 `status: killed`，`turn/end: aborted`），600 秒后也没有写出 `slow-done.txt`，进程表无残留。

> 工具列表是按回合生成的：安装/启用插件后，当前这一回合不会立刻多出 `session_handoff`，下一回合（或新会话）才会出现。这是正常现象。

## 行为边界

- 只对顶层会话开放；子代理会话调用会直接报错。
- 同一个旧会话成功后再次调用会返回同一个新会话（进程内幂等）；进程重启后靠交接文档里的“来源会话 / 新会话”两行识别已有交接，返回 `reused`，不会重复建会话。
- 如果记录的新会话已被删除，下一次 `session_handoff` 会通过会话列表的 `persisted` 标记（必要时回退到 `sessionPersistence.stat()` / `resolveAgent()`）判断它是否还能继续用；不能用时自动新建一个替换会话并写一份新交接文档，旧文档保留，后续读取按文件名取最新的一份。`forceNew: true` 可以跳过复用，强制新建。
- 交接面板里可以选择“下个会话模式”（agent preset，本机默认提供 `standard` / `ptc` / `minimal` / `cordis`），默认继承当前会话模式。选择后发送的交接指令会带上 `agentPreset: "<id>"`，模型调用 `session_handoff` 时传入该参数，新会话就用这个模式启动；模式列表来自 Host 的 `agentPresets` 服务，读取失败或列表为空时面板不显示这一行，交接仍然可用。
- 指定的 agent preset 不存在或已损坏时，创建新会话会失败；交接文档已经写好并保留，工具错误里带文档路径。
- 创建新会话或发送续接提示失败时，工具返回错误并保留交接文档路径，方便重试。
- 转录写入失败不会阻塞交接：文档照常生成，工具结果的 `transcriptPath` 为 `null`，Host 日志里有 warning。
- 子智能体只快照交接那一刻的状态；打断是“发请求不等待”，旧子智能体可能还会跑完当前一步才停。新会话拿到的是任务与进度摘要，不是旧子会话本身；它必须用 `subagent` 重新派出，旧子智能体的完整日志仍可从侧边栏进入。
- 子智能体日志读失败、`subagents` 服务不存在时交接照常进行：文档里不出现子智能体小节或只列会话 id，工具结果的 `subagents.available` 为 `false`。
- 旧会话不会自动删除；它保留完整记录，用户可以在侧边栏手动归档。
- 交接成功后，Client 半默认自动切到新会话；`autoOpenNewSession: false` 可以关掉自动跳转，状态栏会保留“打开新会话”按钮。若前端没有加载 Client 半，仍可从侧边栏进入新会话，工具结果里也写明了新会话 id 和文档路径。

## 手动验证

1. 安装后刷新一次 Web 页面；输入框下方右侧应出现“会话交接”四个字。点开它能看到上下文、轮数、步数三项进度。
2. 新开一个会话，让它做一件小事，然后直接说“调用 session_handoff 演示一下”，确认：
   - 生成了 `.dsh/handoffs/*.md` 和同名的 `*.transcript.md`；
   - 侧边栏出现新会话，界面自动跳过去（或点状态栏里的“打开新会话”）；
   - 新会话第一轮自动开始，并引用了交接文档；
   - 旧会话最后一条是工具结果。
3. 点开“会话交接”面板，在“下个会话模式”下拉里能看到本机全部 preset（默认 profile 是 `Standard` / `PTC` / `极简` / `创造`，镜像里标 `· 默认` 的那个是当前默认 preset）；选“创造模式”再点“现在交接”，新会话的 Agent 预设应是 `cordis`（交接文档头部的“Agent 预设”一行会写着它）；面板里选“继承当前模式”时，新会话与旧会话模式一致。下拉框只在 Host 读到了 preset 列表时出现，为空时整行隐藏、交接仍可用。
4. 交接完成后界面应自动切到新会话（`autoOpenNewSession: false` 时留在原地，状态栏出现“打开新会话”）；手动点状态栏的“打开新会话”也应能切过去。
5. 在新会话里追一句“上一轮那个命令的完整输出是什么”，它应该去 `grep` 转录文件，而不是说“看不到旧对话”。
6. 把阈值临时调低（例如 `turnsSoft: 1`）可以看到“会话交接”四个字从次要色变成警告色，`<session-pressure>` 也同步变化。
7. 子智能体验证：让旧会话用 `subagent` 派一个耗时任务，在它还在跑时交接。交接文档应有 `## 子智能体` 小节，续接提示应有 `## 子智能体接手`；新会话应能用 `subagent` 按提示词重新派出，且旧会话侧边栏里的子会话状态变为已打断/已结束。

> 本机没有可用的 Electron 浏览器（`dsh_browser_open` 报 browser provider unavailable），界面视觉验证由用户在真实桌面窗口里手工完成；`session-handoff` 占位已用 Client 的 `Slots.listSubTree` 确认 active。刷新后若状态栏仍不出现，先看浏览器控制台是否有 Client 半的加载错误。
