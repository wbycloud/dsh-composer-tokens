# dsh-composer-tokens

DSH（DeepSeek Harness）web GUI 输入框实时 token 计数插件（纯客户端，v1）。

设计文档：`docs/design.md`（权威）· 实现前验证结论与决策门 G1：`docs/m0-spike.md`

## 形态

`conversation.input.right` 行内小徽标：

```
≈12,345 · 38%      ← 预计总 tokens（基线 + 草稿 + 消息帧常数）· 上下文占用率
```

- hover/focus 展开 Tooltip：基线（基于最近一次请求）、草稿增量、消息帧常数、会话累计真实 usage（tokenUsage 四桶）、输入缓存命中率、模型名、口径标记（精确/估算）。
- 打字 250ms 防抖刷新草稿部分；历史基线随 `session/projection` 帧自动更新，不闪。
- 基线口径：优先真实锚点 `projectedTokens`（已含系统提示词+工具定义，不重复计）；新会话首次请求前用 `contextBreakdown` 的官方启发式（系统+工具），仍无则用上次会话规模缓存占位（均标 `~`），首次发送后自动校准（docs/m0-spike.md「口径修正」）。
- `@skill` 等引用：引用文本按发送同路径计入草稿；技能内容体由 host 在请求侧展开，发送后自动进入基线校正（发送前不可预知是其固有口径）。
- 精确引擎不可用（未知模型 / 离线无缓存 / 加载失败 / 自定义 URL 失败）时显示 `~` 估算（`ceil(len/4)`，与官方 token-meter 启发式同口径）。

## 架构

```
src/client/
├─ index.ts            # apply(): locale.register + slots.inject("conversation.input.right")
├─ Badge.tsx           # 徽标组件（防抖、模型解析、引擎解析、Tooltip、空值守卫）
├─ engine/             # TokenizerEngine 接口 + JsBpeEngine + HeuristicEngine + EngineRegistry(LRU)
├─ data/               # 数据拉取（HF→hf-mirror 镜像链 + sha256 校验 + IndexedDB 缓存）
├─ family.ts           # modelId → 家族匹配（localStorage 可覆写）
├─ serialization.ts    # 草稿串行化（与发送路径一致的 occurrences 重组）
├─ compute.ts          # 显示公式、seam 常数表、占用率阈值、格式化
├─ debounce.ts         # 250ms trailing 防抖
├─ locales.ts          # zh / en
└─ tokenizer-data.ts   # 生成文件（scripts/prepare-tokenizer.mjs 产物）
```

数据家族（URL 以 commit sha 固定，sha256 校验）：

| family | 数据源 | 许可 |
|---|---|---|
| `deepseek` | `deepseek-ai/DeepSeek-V3` | DeepSeek MODEL_LICENSE + CODE(MIT) |
| `gpt-o200k` | `wellflat/o200k_base_tokenizer`（源自 OpenAI o200k，MIT） | repo 无明确许可，分发前复核 |
| `gpt-cl100k` | `Xenova/gpt-4`（源自 OpenAI cl100k，MIT） | 同上 |

## 开发

```bash
npm run prepare-tokenizer   # 下载/校验 tokenizer 数据，重新生成 tokenizer-data.ts
npm run bundle              # lib/client.js (+ .map) — 唯一被 /plugins/<id>/ 服务的文件
npm run watch               # 增量构建（配合 dev:web HMR）
npm test                    # node --test（count 精度对照官方 Rust tokenizers 0.23.1）
```

## 安装（web profile）

前置：构建产物 `lib/client.js`（改过源码就重跑 `npm run bundle`），Node ≥22、pnpm。

**v0.1 起插件自带 `dsh.bundle.patch`（`cordis.patch.yml`），安装后无需再手动加 loader 行。**

已发布到 npm 后（推荐）：

```bash
dsh plugin --profile web add dsh-composer-tokens
```

直接从 GitHub 装（npm 发布前可用）：

```bash
dsh plugin --profile web add github:wbycloud/dsh-composer-tokens
```

本地开发安装（link 依赖）：

```bash
# 1) 把包装进 profile（本地目录以 link 依赖安装；插件自带 patch，无需手动加行）
dsh plugin --profile web add D:\dsh-composer-tokens
```

```powershell
# 2) Windows 关键坑：pnpm link: 本机可能建成「指向目录的文件符号链接」，
#    跨盘时 Node 无法 stat/import（Cannot find package）。检查并重建为目录 junction：
node -e "const fs=require('node:fs');try{fs.readdirSync('C:/Users/wbycl/.dsh/profiles/web/node_modules/dsh-composer-tokens');console.log('OK')}catch(e){console.log('BROKEN')}"
#   BROKEN 时：
Remove-Item C:\Users\wbycl\.dsh\profiles\web\node_modules\dsh-composer-tokens
cmd /c mklink /J C:\Users\wbycl\.dsh\profiles\web\node_modules\dsh-composer-tokens D:\dsh-composer-tokens
```

```bash
# 3) 重启 GUI（dsh web）使 patch 生效；不想重启时可用动态 Cordis 工具 loader.create(...) 热补
# 4) 浏览器刷新 http://127.0.0.1:3080 → 输入框行内右侧出现徽标
```

> **老安装迁移**：v0.1 之前手动加过 loader 行的 profile（`cordis.patch.yml` 里的 `composer-tokens` 行）请删掉那一行——插件自带 patch 后重启会重复 insert 同一 id 而冲突。

> 本机当前状态（2026-08-31 定案）：**单源 = `dsh.profile.bundles`**。`dsh-composer-tokens` 已在 profile bundles 层（junction 指向本工作区），启动时由包自带的 `dsh.bundle.patch`（`cordis.patch.yml`）自动挂载 loader 条目；`profiles\web\cordis.patch.yml` 用户层**不再**含该行。因此：
> - 之后跑 `dsh plugin add/update dsh-composer-tokens` **安全且幂等**（reconcile 只会把它保持在 bundles，不再有重复 insert 冲突）；
> - 用户层 patch 文件被其它插件工具重写也不再影响徽标（来源是 bundles，不是那两行）；
> - 代价：bundles 是启动时组装的——改 bundles 后需重启 GUI 生效（本机现状即已重启后的稳定态）。
> - 诊断史（防再踩）：8-31 曾发现运行中 404——源头上是 8-29 用户层 patch 行被重写丢失 + 包当时无 `dsh.bundle` 声明（reconcile 跳过）；`watchUserPatches` 对 profile `cordis.patch.yml` 的热重载当前版本可用（改该文件秒级热生效，曾用于临时救回徽标）。

## 使用

- 位置：输入框行内最右侧、发送按钮左边。`≈`=真实锚点口径（基线已含系统/工具）；`~`=估算（新会话占位 / 未知模型 / 离线 / 加载中）。
- 颜色按**本次请求总 token 数**（基线+草稿+帧）分级：<100k 绿、100k–300k 琥珀、>300k 红（背景与边框同步着色；占用率仅保留在 Tooltip 中，不再驱动颜色）。
- 悬停（或键盘焦点）展开 Tooltip：预计总 tokens、基线及来源、固定开销（系统+工具）、草稿增量、消息帧、占用率、会话累计真实 usage、累计输入缓存命中率（缓存读取 / 输入总量）、模型与引擎精度、技能/引用口径。缓存命中率只在 provider usage 到达后显示，输出 tokens 不参与计算。
- 新会话首次请求前显示 `~上次会话规模` 占位；发送一条消息后自动校准并更新缓存。
- 模型覆写（可选）：

```js
localStorage.setItem("dsh-composer-tokens.overrides", JSON.stringify({
  "qwen-72b": "deepseek",          // 指定内置家族
  "my-model": "https://…/tokenizer.json"  // 或自定义 tokenizer.json URL
}));
```

## 卸载

```bash
dsh plugin --profile web remove dsh-composer-tokens
# v0.1 起 patch 随包（dsh.bundle），remove 即整体移除；仅老安装（手动加过 loader 行）需手工清掉那行
```

## 开发热更

checkout 的 `pnpm run dev:web` 激活 client-plugin HMR —— 改 bundle 源 → `npm run watch` 重编译 → 刷新 http://127.0.0.1:3080。

## 已知限制（v1）

- 模型切换无 wire 事件：`session.models` 每会话缓存 + 投影帧 3s 冷却重查（docs/m0-spike.md V3）。
- 超 10 万字符草稿：前段精确 + 尾部估算，Tooltip 标注。
- 不含输出 tokens（输出不可预测；`tokenUsage` 明细中可见输出桶）。
- seam 常数：全家族 3（v1.1 校准闭环）。
- 行内空间有限时徽标可能以省略号截断（"…" 尾部）；完整数值在 Tooltip 中可见。
- 装机即装即用：`dsh plugin add` 一键（patch 随包自带）；本机 pnpm link 符号链接需按 docs/m0-spike.md「装机与热更实证」重建为 junction（跨盘文件链接损坏问题）。