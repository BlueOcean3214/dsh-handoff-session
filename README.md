# Session Handoff（会话交接）

DeepSeek Harness 的 Host + Client 插件：在长会话开始“降智”前，让模型自己判断一个合适的收尾点，写出交接文档，并在同一工作目录里自动开一个新会话继续干活。

它替代的手工流程是：让模型写交接文档 → 点“下一步” → 复制提示词 → 新建会话 → 粘贴。现在只需要模型调用一次 `session_handoff`。

## 它做了什么

1. **压力投影**：折叠每个会话的 `turn/start`、`step/start`、`request/context`、`assistant/message`、`tool/call`、`tool/result` 事件，得到轮数、步数、上下文占用、累计 token、缓存命中率。
2. **动态提示**：每次请求都会在运行时上下文里加入一段 `<session-pressure>`，告诉模型当前压力和 `level`（`low` / `watch` / `recommended` / `urgent`）。
3. **策略段**：系统提示里加入“会话寿命与交接”规则，明确只在 `recommended` / `urgent` 且处于可持久化检查点时调用工具。
4. **交接工具**：`session_handoff` 把目标、现状、已完成、待办、决策、关键文件、验证结果写进 `<cwd>/.dsh/handoffs/handoff-<时间>-<会话>.md`，同时在同目录写一份可检索的 `handoff-<时间>-<会话>.transcript.md`；用 `sessionController.create()` 新建会话；用 `sessionController.prompt()` 把“读交接文档 + 继续指令”发过去；最后结束旧回合。新会话只读摘要，缺细节时再按需 `grep` 转录，不会整份塞进上下文。
5. **界面**：`client.js` 在输入框下方右侧只放“会话交接”四个字，不占图标位、不挡内置状态；文字颜色随压力从次要色变成警告色/品牌色。点这四个字展开面板，能看到三项阈值进度和解释。点“现在交接”会直接把交接指令填进输入框并发送，不需要复制提示词。交接完成后会自动切到新会话，也可以手动点“打开新会话”。

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

- npm：`dsh-handoff-session@0.6.0`（2026-11-03 13:51）和 `@0.6.1`（14:29，带 `repository` 字段，npm 页面上已关联 GitHub 仓库）：`https://www.npmjs.com/package/dsh-handoff-session`，`npm i dsh-handoff-session` 与 `dsh plugin add dsh-handoff-session` 都验证可用。
- 自托管索引：**`https://raw.githubusercontent.com/BlueOcean3214/dsh-handoff-session/main/market/index.json`**（`Cache-Control: max-age=300`，内容就是仓库里的 `market/index.json`，`marketInstallTarget` = `dsh-handoff-session@0.6.1`）。
  - 也试过 `https://cdn.jsdelivr.net/npm/dsh-handoff-session/market/index.json`：能用，但 npm 包里的文件不可变，发版后 `publishTimestamp` 只能写预估值；而且 jsDelivr 对 `/npm/<pkg>/` 这种不固定版本的路径缓存 12 小时（回源节点之间还会不一致，`purge.jsdelivr.net` 也不保证立刻全清）。所以索引改由 Git 托管。
- 包名定为 `dsh-handoff-session`（`dsh-handoff` 已被 `zhijiangtang/dsh-handoff` 占用，而且对方也是会话交接类插件；`dsh-session-handoff`、`dsh-handoff-kit`、`dsh-continuity`、`dsh-session-continuity` 同样被占）。
- `package.json`：去掉 `private`，补 `license: MIT`、`keywords`、`publishConfig.access: public`；`cordis.patch.yml` 的 `insert.name` 与 `client.js` 的模块 `id` 已同步改名，`client-selftest.mjs` 里的断言也一起改了。
- 仓库素材：`LICENSE`（MIT）、`.gitignore`（挡住 `.dsh/` 里的对话记录）、`.gitattributes`（统一 LF）、`assets/icon-180.png`（180×180 市场卡片图标）。
- 公开仓库：**https://github.com/BlueOcean3214/dsh-handoff-session**（2026-11-03 14:20 建仓并推送 `main`，`dsh-plugin` topic 已加，`package.json` 的 `repository` / `homepage` / `bugs` 已指向它；`assets/icon-180.png` 经 raw.githubusercontent 验证返回 200 `image/png`；`v0.6.1` 标签已推）。
- 索引生成：`node market/regen-index.mjs`（读 `package.json` 的 name/version，标题描述沿用现有索引，默认调官方校验器；PowerShell 直接传中文参数会被 GBK 拆坏，所以走这个小脚本）。

仍缺：

- 官方目录 PR：条目文件已生成在 `market/submission/BlueOcean3214__dsh-handoff-session.yml`，但 CI 要求**仓库创建满 1 天**，最早 2026-11-04 14:20（+08:00）之后才能提。步骤见 [`docs/catalog-submission.md`](docs/catalog-submission.md)。
  - 已经安排好自动提交：`market/open-catalog-pr.mjs`（幂等，先查目录/已有 PR，再 fork → 建分支 → 提交条目 → 开 PR，成功后会删掉 token 文件），由 Windows 计划任务 `dsh-handoff-catalog-pr` 在 2026-11-04 14:25 运行，日志写 `.dsh/catalog-pr.log`。手动补跑：`node market/open-catalog-pr.mjs`（`--dry-run` 只检查条件）。
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

默认值参考了用户截图里的 `22 轮 / 677 步 / 24%`：这个状态会落在 `recommended`，模型会在下一个干净检查点交接，而不是每轮都打扰。

### 转录旁路

交接时除了 `handoff-*.md`，还会在同一个目录写一份 `handoff-*.transcript.md`：

- 只收录人类 `user/message`、助手正文、`tool/call` 参数、`tool/result` 输出；默认不写 reasoning，也不写运行时注入；
- **不会**自动塞进新会话的上下文，新会话第一轮只读摘要；缺细节时再 `read`/`grep` 这份文件；
- 超过 `transcriptMaxChars` 时保留开头 25% 和结尾 75%，中间标注省略；
- 文件里可能含命令输出、文件内容等敏感信息，交接目录应按项目需要清理或加入 `.gitignore`。

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

> 工具列表是按回合生成的：安装/启用插件后，当前这一回合不会立刻多出 `session_handoff`，下一回合（或新会话）才会出现。这是正常现象。

## 行为边界

- 只对顶层会话开放；子代理会话调用会直接报错。
- 同一个旧会话成功后再次调用会返回同一个新会话（进程内幂等）；进程重启后靠交接文档里的“来源会话 / 新会话”两行识别已有交接，返回 `reused`，不会重复建会话。
- 如果记录的新会话已被删除，下一次 `session_handoff` 会通过会话列表的 `persisted` 标记（必要时回退到 `sessionPersistence.stat()` / `resolveAgent()`）判断它是否还能继续用；不能用时自动新建一个替换会话并写一份新交接文档，旧文档保留，后续读取按文件名取最新的一份。`forceNew: true` 可以跳过复用，强制新建。
- 交接面板里可以选择“下个会话模式”（agent preset，本机默认提供 `standard` / `ptc` / `minimal` / `cordis`），默认继承当前会话模式。选择后发送的交接指令会带上 `agentPreset: "<id>"`，模型调用 `session_handoff` 时传入该参数，新会话就用这个模式启动；模式列表来自 Host 的 `agentPresets` 服务，读取失败或列表为空时面板不显示这一行，交接仍然可用。
- 指定的 agent preset 不存在或已损坏时，创建新会话会失败；交接文档已经写好并保留，工具错误里带文档路径。
- 创建新会话或发送续接提示失败时，工具返回错误并保留交接文档路径，方便重试。
- 转录写入失败不会阻塞交接：文档照常生成，工具结果的 `transcriptPath` 为 `null`，Host 日志里有 warning。
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

> 本机没有可用的 Electron 浏览器（`dsh_browser_open` 报 browser provider unavailable），界面视觉验证由用户在真实桌面窗口里手工完成；`session-handoff` 占位已用 Client 的 `Slots.listSubTree` 确认 active。刷新后若状态栏仍不出现，先看浏览器控制台是否有 Client 半的加载错误。
