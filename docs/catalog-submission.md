# 上架官方目录（awesome-dsh-plugin）操作手册

目标：让 `dsh-handoff-session` 出现在 **dsh-market 的「插件市场」面板** 和 **官方「发现」页** 里，任何人不用加索引源就能搜到、安装。

这两处读的是同一份目录：`https://awesome-dsh-plugin.com/plugins.json`，由 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库的 `data/plugins/*.yml` 生成。**给 dsh-market 提 PR 没有用**——那是市场客户端本身的源码仓库，它的目录是写死的（`dshmarket/lib/regions.js:70`）。

所以"上架"= 往那个仓库提一个只加一个 YAML 文件的 PR。

---

## 已经准备好的东西

| 项目 | 状态 | 位置 |
| --- | --- | --- |
| `dsh.bundle` manifest（CI 第 2 项检查） | ✅ 有 | `package.json:34-37` |
| npm 包（预构建安装，免 `allowBuilds`） | ✅ 已发布 0.6.0 | `dsh-handoff-session` |
| 180×180 PNG 图标（只收 GitHub 托管的位图，SVG 会被拒） | ✅ 已生成 | `assets/icon-180.png` |
| 条目文件生成器 | ✅ | `market/prep-catalog-entry.mjs` |
| `LICENSE`（MIT） | ✅ | `LICENSE` |
| `.gitignore`（挡住 `.dsh/` 里的对话记录） | ✅ | `.gitignore` |
| GitHub 仓库 | ❌ 待建 | — |
| `package.json` 的 `repository` 字段 | ❌ 待写（生成器会自动写） | — |

> ⚠️ `.dsh/` 里是本机的交接文档和完整对话转录，**绝对不能进公开仓库**。`.gitignore` 已经挡住它了，建仓后 `git status` 里不该出现这个目录。

---

## 步骤 A：建 GitHub 仓库并推上去

> **状态：已完成**（2026-11-03 14:20 +08:00）。仓库 https://github.com/BlueOcean3214/dsh-handoff-session 已建（public）、`main` 已推送、`dsh-plugin` topic 与 About 描述已设。下面保留原始步骤，便于换仓库或重来一次。

这里没有 `gh` 命令行，用网页 + git 推送。

**A1. 本地初始化仓库**（在 `C:\Users\Santuo\Desktop\chajian` 里执行）：

```powershell
git init -b main
git add -A
git status --short          # 确认 .dsh/ 不在列表里
git commit -m "dsh-handoff-session 0.6.0"
```

如果 `git commit` 报 AUTHOR 未配置：

```powershell
git config user.name "你的名字"
git config user.email "你的邮箱"
```

**A2. 网页建空仓库**：GitHub → New repository → 名字填 `dsh-handoff-session` → **Public** → **不要**勾选 README / .gitignore / license（本地已经有了）→ Create。

**A3. 推送**：

```powershell
git remote add origin https://github.com/BlueOcean3214/dsh-handoff-session.git
git push -u origin main
```

首次推送会弹浏览器授权（GitHub 不再接受账号密码），按提示走一次即可。

---

## 步骤 B：仓库设置（两分钟，但漏了会被 CI 打回）

1. 仓库首页右上 **About** 旁的齿轮 → **Topics** 填 `dsh-plugin`（CI 检查这一项）。
2. Description 填一句和代码一致的话，例如：`Durable session handoff for DeepSeek Harness: pressure-aware handoff docs, a searchable transcript, and automatic continuation in a fresh Session.`
3. 确认仓库是 **Public**。

**然后等满 24 小时再提 PR**——CI 会自动检查"仓库创建满 1 天"，这是硬门槛，提前提会被拒。刚好差几个小时的，等几小时再提，不会有任何不良记录。

等待期间可以先做步骤 C 的本地部分（生成条目文件），把 PR 内容准备好。

---

## 步骤 C：生成条目文件并提 PR

**C1. 生成条目**（把 `BlueOcean3214` 换成真的，同时会把 `repository`/`homepage`/`bugs` 写进 `package.json`）：

```powershell
node market/prep-catalog-entry.mjs --owner BlueOcean3214
```

产物：`market/submission/BlueOcean3214__dsh-handoff-session.yml`，内容形如：

```yaml
url: https://github.com/BlueOcean3214/dsh-handoff-session
name: BlueOcean3214/dsh-handoff-session
category: session
description:
  en: 'Durable session handoff for DeepSeek Harness: pressure-aware handoff docs, a searchable transcript, and automatic continuation in a fresh Session.'
  zh: 为 DeepSeek Harness 提供会话交接：上下文压力到阈值时写交接文档与可搜索转录，并在新会话里自动继续。
icon: https://raw.githubusercontent.com/BlueOcean3214/dsh-handoff-session/main/assets/icon-180.png
```

（`description.en` 里有 `: `，所以生成器自动加了引号——不加引号 YAML 会解析失败。）

**C2. 提交 `repository` 字段**：`package.json` 变了，先推上去：

```powershell
git add package.json market/submission .gitignore assets LICENSE
git commit -m "Add catalog entry, icon and repository metadata"
git push
```

**C3. 提 PR**：

1. 打开 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin → Fork。
2. 在 fork 里新建文件 `data/plugins/BlueOcean3214__dsh-handoff-session.yml`，粘贴上面的内容。
3. Commit → 回到上游仓库页面，点 **Compare & pull request**。
4. PR 标题：`Add BlueOcean3214/dsh-handoff-session`。
5. PR 正文（简短说明 + 自检，能明显减少来回）：

```markdown
Adds dsh-handoff-session, category `session`.

- package.json declares `dsh.bundle` (patch: `cordis.patch.yml`) and `dsh.client` (platform: web).
- Also published on npm as `dsh-handoff-session`; its `repository` field points back at this repo.
- Watches turn / step / context thresholds and, when one is crossed, writes a handoff doc plus a
  searchable transcript, then opens a fresh Session in the same workspace with a continuation prompt.
- Only touches the one new file; no other entries modified.
```

一个 PR 只加一个文件。**不要手工改两个 README**（它们是生成的，改了就冲突）。

---

## 步骤 D：CI 和评审会查什么

按顺序跑：

1. **Entry count** —— 每个 PR 最多 3 条（我们只加 1 条）。
2. **`dsh.bundle`** —— 从仓库 `package.json` 读取。只有 `dsh.client` 的会被拒（这是最常见的打回原因，我们有）。
3. **Repo age** —— ≥ 1 天。
4. **awesome-lint + 站点构建** —— 双语一致性、日期、分隔符。

CI 通过只是**前置条件**。维护者会实际读仓库，重点看：

- **描述是否名副其实**（夸大是打回的头号原因；我们的描述只写了实际做的四件事：阈值检测、写文档、写转录、开新会话继续）。
- 分类是否贴合（`session` = Sessions & Messages，贴合；即使不贴合也是维护者直接改，不会打回）。
- 是否已有同功能条目 —— **`zhijiangtang/dsh-handoff` 已在列表里，也是会话交接类**。规则的原文是"两个插件做同一件事时先来者保留位置，但这只是平局时的排序依据，不是既得利益；更好维护的、或确实做了新东西的会被收录"。我们和它的差别需要能说清楚，见下面的"差异化"。
- 是否纯聚合包（不是，我们自己有行为）。
- 依赖是否指向原作者（我们没有依赖别人的插件）。

### 差异化（写 PR 正文或答复维护者时用得上）

`dsh-handoff` 是一个**导出**工具：把会话导出成文档。我们这个做的是**自动接力**：按轮数/步数/上下文压力三档阈值被动检测 → 到点写交接文档 + 可搜索转录 sidecar（不是把整份对话塞进文档）→ **在同一个工作区新建 Session 并把继续指令发过去**，旧会话可以留着做证据。另外带输入框上方的压力面板和「下个会话模式」下拉框。

写的时候不要贬低对方，只陈述"它导出，我们接力"。

---

## 步骤 E：合并之后

1. **网站自动重建**，`plugins.json` 出现我们这条；dsh-market 面板下一次抓取时就能搜到（不用你做任何事）。
2. **npm 下载量关联**：只有 `package.json.repository` 指回收录的仓库时才会关联。所以合并后发一个补丁版本：

   ```powershell
   npm version patch      # 0.6.1
   npm publish            # 仍然需要 bypass-2FA token 或 6 位 OTP
   ```

   之后 `market/index.json` 也要重新生成一次（新的版本号和发布时间）：

   ```powershell
   node market/build-index.mjs --name dsh-handoff-session --check --validator "<校验器路径>"
   ```

3. 之后想改截图/描述：截图的 `screenshots.json` 放在**你自己仓库**里（1–8 张，相对路径，不改不用提 PR）；条目里只改自己那一行。

---

## 常见打回原因对照

| 打回原因 | 我们的情况 |
| --- | --- |
| 只声明 `dsh.client`，没有 `dsh.bundle` | ✅ 两个都有 |
| 仓库创建不足 1 天 | ⏳ 建仓后等 24 小时再提 PR |
| 缺 `dsh-plugin` topic | ⏳ 步骤 B 补 |
| 描述夸大 / 与代码不符 | ✅ 只写实际行为，维护者能逐条对上 |
| 手工改了 README | ✅ 只加一个 yml |
| 图标是 SVG 或第三方图床 | ✅ PNG，GitHub raw 托管 |
| PR 动了别人的条目 | ✅ 只新增一个文件 |
| 纯聚合包（只有依赖清单） | ✅ 自身有行为 |
