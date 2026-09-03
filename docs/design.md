# dsh-composer-tokens 设计方案：输入框实时 Token 计数插件

| 项 | 值 |
|---|---|
| 状态 | Proposed（已过评审，进入实施） |
| 作者 | wanboy |
| 版本 | v0.1（初稿） |
| 适用 | DSH `0.1.1-rc.2`，web profile：`C:\Users\wbycl\.dsh\profiles\web` |
| 形态 | 纯客户端插件（v1），零后端改动 |

## 1. 背景与目标

### 1.1 问题

用户在输入框敲字时，无法预知「这次按下回车会花多少 token」。官方 `@deepseek-ai/dsh-token-meter` 是会话上下文与压缩的记账服务，不提供输入侧的实时预览。本插件在 composer 输入框提供该预览。

### 1.2 目标与成功标准

总公式：

$$
显示值 = 历史\ baseline + 草稿实时值
$$

- **历史 baseline**：不复算，直接读 DSH 已记好的真实 usage（见 §2，零后端改动即可拿到）。
- **草稿实时值**：输入时精确分词（引擎选定 `@huggingface/tokenizers`，见 §4.3），防抖刷新。

成功标准：

1. 在 `conversation.input.right`（输入框行内右侧）显示紧凑徽标：`≈12,345 · 38%`（预计输入 tokens + 上下文占用率）。
2. Tooltip 展开详情：基线 / 草稿 / 本次会话累计真实 usage / 模型名 / 口径标记（精确·估算）。
3. 打字时只有草稿部分刷新（防抖 250ms），历史基线稳定不闪。
4. 纯客户端插件，不修改后端，不动 web 应用源码。
5. 新会话、无 usage、未知模型、离线等边界情况可优雅降级（见 §6）。

## 2. 侦察结论

侦察结论全部来自已安装的 DSH 发布包源码与运行数据，非假设。来源索引见 §2.5。

### 2.1 「真实 usage」已存在且已被推送到浏览器

官方 token-meter 已随 web profile 运行（证据：`$DSH_HOME\storages\session_projcache.json` 中已持久化 `tokenUsage / contextPressure / contextBreakdown` 三行），注册了三个 session projection 单元：

| 投影 key | 线上 view 内容 | 语义 |
|---|---|---|
| `tokenUsage` | `{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`（totals） | 会话累计真实 bills（provider 上报，同 turn/step 去重替换） |
| `contextPressure` | `{contextWindow?, pressureTokens?, projectedTokens?}` | 下一次请求的 prompt 预计成本（锚定最近一次真实 usage，表面变化按官方启发式重估） |
| `contextBreakdown` | `{systemTokens, toolsTokens, messageTokens}` | 启发式构成（4 字符/token），仅作参考，不用于主显示 |

**关键字段 `contextPressure.projectedTokens` 就是「下一次请求的 prompt 会花多少 token」**，即为本方案 baseline。口径为输入侧：不含输出（输出不可预测，明示在 UI）。官方 README 明确该字段为 occupancy 显示设计：`真实样本 + 表面增量重估`，compaction 时正确收缩。

### 2.2 推送链路：浏览器端零代码即可消费

1. host 侧 `ctx.sessionProjections.snapshot(session)` 把每个已注册单元的 `wire.view`（经 viewSchema 校验）组成 `{asOfSeq, values}`；`drive()` 在事件变更时逐 key 通知。
2. 线上协议：`session.history` 响应尾页携带 `projections` 块；增量走 `session/projection` 帧 `{sessionId, key, value, seq}`。
3. 浏览器侧 `ProjectionValueStore.faceOf(key)` 提供订阅面；席位组件经 `useProjection("key")` 读取（goal 插件即此范式）。

### 2.3 输入框席位与草稿可达性

- composer 席位有五个：`conversation.input.dock`（上方条）、`conversation.input.left/right`（行内）、`conversation.input.overlay`、`conversation.composer.dock`。
- 渲染器契约：席位组件 props = 标准套件（`useProjection` / `sessionId` / `useSession` / `t` 等）+ entry inject + **render 时传入的 owner props（owner 优先）**。
- `renderSlot("conversation.input.right", zone)` 的 `zone = {session, input}`，`input` 为会话输入状态快照（含 `draft` / `draftRev` / `phase`）。父组件在每次输入变更时 re-render，故徽标组件每击键拿到新 `input.draft`。

### 2.4 客户端插件分发路径

- 插件包声明 `package.json` 的 `dsh.client`（`platform: "web"`、`inject` 列表）+ `exports["./client"]` 指向**构建好的** bundle。
- `@deepseek-ai/dsh-client-modules` host half 增量扫描 Loader 条目中的 `dsh.client` 包，服务 `/plugins/<id>/client.js` 与 `client.js.map`。**注意：只服务 bundle + map，不服务任意静态资产**——直接决定 WASM 与数据的托管策略（§4.3）。
- 装机：`dsh plugin --profile web add <包路径或 git>`；开发热更走 checkout 的 `pnpm run dev:web`（client-plugin HMR receiver 已激活）。
- 模型查询：`session.models({sessionId})` RPC；兜底 `host.describe` 的 `provider/model`。

### 2.5 来源索引

| 事实 | 出处 |
|---|---|
| 三个投影单元与 view 口径 | `@deepseek-ai\dsh-token-meter\lib\index.js`（tokenUsage L291-324、contextPressure L346-393、estimate L7-73） |
| 投影注册与 snapshot/drive | `@deepseek-ai\dsh-session-projection\lib\index.js` L122-133、L280-296 |
| `session/projection` 帧与 history 块 schema | `@deepseek-ai\dsh-client-connection\lib\client.js` L5640-5646、L5366-5371 |
| 浏览器投影存储 faceOf | `@deepseek-ai\dsh-client-runtime\lib\client.js` L5739-5824 |
| useProjection 标准座位 | `@deepseek-ai\dsh-client-ui-renderer\lib\client.js` L564、L620-634 |
| composer 席位与 zone | `@deepseek-ai\dsh-client-ui-conversation\lib\client.js` L7159、L7191-7194、L7241-7254 |
| goal 读投影 + dock 注册范式 | `@deepseek-ai\dsh-client-ui-goal\lib\client.js` L241-251、L410-437 |
| client bundle 扫描与服务 | `@deepseek-ai\dsh-client-modules\lib\index.js` L389-397、L467-473 |
| 模型查询 RPC | `@deepseek-ai\dsh-client-ui-model-selection\lib\client.js` L52 |
| 运行中 token-meter 生效证据 | `C:\Users\wbycl\.dsh\storages\session_projcache.json` |

## 3. 方案总览

### 3.1 架构

```text
┌─ 浏览器 ─────────────────────────────────────────────────┐
│ TokenMeterBadge（conversation.input.right 席位）          │
│  ├─ baseline  ← useProjection("contextPressure")         │
│  │      .projectedTokens（缺省→pressureTokens→0）         │
│  ├─ capacity ← .contextWindow                            │
│  ├─ 累计真实 ← useProjection("tokenUsage")               │
│  ├─ draft    ← ownerProps.input.draft（防抖 250ms）       │
│  │      （含 @引用串行化，见 §4.4）                        │
│  └─ engine   ← EngineRegistry[modelId]                    │
│        WasmEngine(@huggingface/tokenizers) /             │
│        HeuristicEngine（MiMo/离线/加载失败）               │
└──────────────────────────────────────────────────────────┘
```

### 3.2 显示公式

$$
total = projectedTokens + count(serializedDraft) + seam
$$

$$
occupancy = \min\left(100,\ \left\lfloor \frac{total}{contextWindow} \times 100 \right\rfloor\right)
$$

`seam` 为「新增一条 user 消息」的模板帧常数（§4.4）。

## 4. 详细设计

### 4.1 插件包结构

```text
D:\dsh-composer-tokens\
├─ package.json              # name: dsh-composer-tokens
│                            #   "type": "module"
│                            #   "dsh": { "client": { "inject": ["slots","sessions","locale"], "platform": "web" } }
│                            #   "exports": { "./client": { "default": "./lib/client.js" }, ... }
│                            #   scripts: prepare-tokenizer / bundle(tsdown) / watch
├─ tsdown.config.ts / tsconfig.json
├─ src/
│  ├─ client/
│  │  ├─ index.ts            # apply(ctx)：locale.register + slots.inject("conversation.input.right", ...)
│  │  ├─ Badge.tsx           # 徽标组件（行内小数字 + Tooltip）
│  │  ├─ engine/
│  │  │  ├─ types.ts         # interface TokenizerEngine { count(text): number; exact: boolean }
│  │  │  ├─ wasm.ts          # WasmEngine：@huggingface/tokenizers 封装（懒初始化）
│  │  │  ├─ heuristic.ts     # HeuristicEngine：官方启发式同口径 ceil(len/4)
│  │  │  └─ registry.ts      # modelId → engine 映射、缓存、显式 override
│  │  └─ locales.ts          # zh / en 词典
│  └─ assets/                # tokenizer 数据（托管策略见 §4.3）
├─ scripts/prepare-tokenizer.mjs   # 构建期下载官方 tokenizer.json → 资产目录
└─ README.md
```

### 4.2 客户端注册

对齐 goal/plan 插件既有范式：

```ts
export const inject = ["slots", "sessions", "locale"];

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "composer-tokens: dictionaries");
  const sessions = ctx.sessions;
  ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
    name: "conversation.input.right",
    id: "composer-tokens",
    order: 10,
    locale: NS,
    inject: (sessionId) => ({ /* 模型解析等注入面 */ })
  }, TokenMeterBadge));
}
```

Badge 组件的数据读取（全部走既有机制）：

- `const input = props.input`（draft / draftRev；owner props 优先，已核实）。
- `const pressure = useProjection("contextPressure")`；`const usage = useProjection("tokenUsage")`。
- 模型：`sessions.models({ sessionId })`（组件内 `useEffect` 一次 + 监听切换事件）。

### 4.3 引擎层

**接口先行，实现可替换**（兜底优先级：Wasm → Heuristic）：

```ts
interface TokenizerEngine {
  count(text: string): number;
  exact: boolean;   // false 时 UI 显示「~」前缀
}
```

| 实现 | 适用 | 备注 |
|---|---|---|
| `WasmEngine` | DeepSeek / GPT / Qwen、GLM 等有公开 tokenizer.json 的模型 | `@huggingface/tokenizers` 加载官方 tokenizer.json；npm 零依赖，但本质是 Rust→WASM，浏览器需托管约 15–20MB 的 `.wasm`，初始化异步（懒加载） |
| `HeuristicEngine` | MiMo 等无公开词表 / 离线 / 引擎加载失败 | 与官方启发式同一口径 `ceil(len/4)`，展示带「估算」标记 |

模型 → 数据映射（URL/license 实现时验证，见 §9）：

- DeepSeek 系（deepseek-chat / V3 / R1）：`deepseek-ai/DeepSeek-V3` 仓库 `tokenizer.json`（128k BPE，约 6–7MB）。
- GPT 系（o200k 等）：`Xenova/o200k_base` 的 tokenizer.json，或复用 openai 官方 tiktoken 数据。
- MiMo / 未知：HeuristicEngine。
- 提供配置 override：`modelId → 数据源 URL`，允许用户自填。

**资产托管与加载（决策门 G1）**：`/plugins/<id>/client.js` 路由只服务 bundle + map（已核实），不服务任意静态资产。三条路按 M0 spike 结果裁定：

1. 嵌入 bundle：tokenizer.json base64 内联（约 +9MB），wasm 同样内联（约 20–27MB）——可行但 bundle 巨大。
2. 运行时拉取 + 本地缓存（推荐 spike 首选）：wasm / json 从固定 URL（jsDelivr / unpkg / HF hub，支持 CORS）fetch，写入 IndexedDB，离线命中缓存；加载完成前显示「…」，失败降级 Heuristic。
3. 混合：预打包最常用 1–2 个家族数据，其余运行时拉取。

> `@huggingface/tokenizers` 浏览器端确切初始化 API（`Tokenizer.fromString(json, { wasmPath? })` 等）随版本变动，M0 spike 锁版本并实测（§9 V1）。

### 4.4 草稿串行化

发送时草稿经 `.trim()`；@引用在发送前由 `inputTriggers.serializeReference(source, ref)` 展开为完整文本。计数必须计**串行化后**文本：

- 无 @ 引用：`count(draft.trim())`，同步。
- 有 @ 引用：异步串行化全部引用后计数（与发送同路径）；展开完成前徽标先按 display 文本估算并标「~」。

**模板接缝常数（seam）**：`projectedTokens` 只定价既有表面，不含新增这条 user 消息的 JSON/角色帧；真实请求额外付出约 2–4 token。v1 用经验常数表（`user` 消息帧 ≈ 3，DeepSeek 系），v1.1 用校准闭环学习。

### 4.5 显示计算与文案

```text
draftTokens = engine.count(serializedDraft)
baseline    = pressure.projectedTokens ?? pressure.pressureTokens ?? 0
total       = baseline + draftTokens + seam
occupancy   = capacity ? min(100, round(total / capacity * 100)) : null
```

- 行内徽标：`≈12,345`；占用率超 80% 警示色、超 95% 红色；非精确引擎前缀 `~`。
- Tooltip 详情：基线 N · 草稿 +N · 会话累计真实 usage（tokenUsage 四桶合计）· 累计输入缓存命中率 · 模型名 · 口径（精确/估算）。缓存命中率 = `cacheReadTokens / (uncachedInputTokens + cacheReadTokens + cacheWriteTokens)`；输出 tokens 不参与分母。无输入 usage 时显示暂无数据。
- 空草稿：显示 baseline；新会话无 usage：baseline = 0，只显示草稿。
- 发送后：draft 清空，徽标回到 baseline；下一轮 `session/projection` 帧自动刷新 projectedTokens——自校准闭环天然成立，无需额外代码。
- 模型切换：engine 按新 modelId 懒加载替换；旧锚点属官方已知限制，Tooltip 注明「基于最近一次请求」。

### 4.6 防抖与性能

- 250ms trailing 防抖（`useEffect` + 定时器 + 局部 state）。React 每击键 re-render 是框架既定行为，但 tokenize 只在防抖后执行。
- wasm 懒初始化：首次需要时加载，loading 态显示「…」；初始化后同步计数。单次计数 <5ms（小草稿），大粘帖 <50ms，v1 不做 Web Worker，超长文本上限截断即可（优化项留档）。
- 引擎结果按 `(modelId, text)` 短签名 LRU 缓存，避免同文本重复计算。

### 4.7 校准闭环（v1.1，不入 v1）

发送后对比 $预测(baseline+draft+seam)$ 与新一轮 `pressureTokens` 实际值，学习每模型 seam 常数与线性偏差 $y \approx a \cdot x + b$，localStorage 持久化，UI 显示「已校准」。

## 5. 风险与降级

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| WASM 资产管道不通（/plugins 不服务静态资产） | 中/高 | 决策门 G1：嵌入 / 运行时拉取 + IndexedDB / 混合；兜底 Heuristic |
| 浏览器端 WASM API 版本漂移 | 中/中 | M0 spike 锁版本 + fixture 测试（§9 V1） |
| tokenizer.json 与线上 API 实际分词器偏差 | 低/低 | 校准闭环（v1.1）+ 口径标记 |
| `projectedTokens` 是启发式延展非真实值 | 必然/低 | UI 明示「基于最近一次请求」；真实值逐帧自动更新 |
| 离线环境资产取不到 | 中/低 | IndexedDB 缓存 + Heuristic 降级 |
| 新会话 / 无 usage | 必然/低 | baseline = 0，只显示草稿 |
| @引用串行化异步 | 必然/低 | 先按 display 计并标「~」，串行化后修正 |
| 每击键 re-render 性能 | 低/低 | 防抖 + 同步快计数 + 超长文本截断 |
| MiMo 等无词表 | 必然/低 | HeuristicEngine（与官方启发式同口径） |
| 席位在 hero/blank 态 zone 为 undefined | 必然/低 | 组件空值守卫（§9 V5） |

## 6. 边界情况

空草稿、全新会话（无 projections）、模型切换（旧锚点）、compaction 后（projectedTokens 正确收缩）、@引用与 /command 草稿（按串行化计）、IME 组合输入（oninput 天然覆盖，防抖吞抖动）、超大粘帖（截断上限 + 提示）、多 tab（每 tab 独立投影存储，无冲突）、引擎加载失败 / 离线（Heuristic + 标记）、禁用插件（席位注册随 fiber dispose 干净移除）。

## 7. 测试与验收

单元：`count()` 精确性（中文 / 英文 / 代码 / emoji / 换行 / 尾部空白 / BPE 合并边界），seam 常数表，串行化计数路径，防抖时序。

集成（dev:web 手测）：中文长句、英文、代码块、粘贴大段、@引用、/命令、模型切换、新会话、发送后回落、占用率颜色阈值、离线降级。

验收数字：英文字符 ≈0.25–0.3 tokens/char（o200k）；中文 ≈1–1.7 tokens/char（DeepSeek 128k）；发送后下一轮 `pressureTokens` 与预测误差（v1 目标：中英文典型草稿偏差 <5%）。

## 8. 里程碑

- **M0（spike，半天）**：锁 `@huggingface/tokenizers` 版本，实测浏览器初始化 API + 资产托管路径，产出 V1–V4 结论，裁定决策门 G1。
- **M1（核心）**：引擎层 + 徽标席位 + 防抖 + 模型映射 + 兜底降级，dev:web 下可见。
- **M2（打磨）**：Tooltip 详情、占用率阈值色、@引用串行化精确计数、locale zh/en。
- **M3（可选）**：校准闭环 v1.1、Web Worker 大文本。

## 9. 实现前验证项

| 编号 | 验证内容 | 判定 |
|---|---|---|
| V1 | `@huggingface/tokenizers` 当前版本浏览器 API：初始化方式、wasm 路径参数、count 同步性、`fromString(tokenizer.json)` | 可 npm i 到工作区实测 |
| V2 | tsdown 是否支持 `src/assets/*` 作为 URL 资产 emit；`/plugins/<id>/client.js.map` 之外是否可服务其他文件（源码显示仅两者） | 决定 G1 |
| V3 | `dsh-api-remotes` 中 `session.models` / `host.describe` 的准确调用面 | 以模型选择插件为参照 |
| V4 | 各家族 tokenizer.json 的 URL、哈希、license（DeepSeek 随模型许可；o200k 数据源许可） | 打包分发前确认 |
| V5 | `conversation.input.right` 在 hero/blank 态不渲染（zone 为 undefined） | 空值守卫 |

## 10. 决策记录（ADR）

- **D0**：命名 `dsh-composer-tokens`，工作区 `D:\dsh-composer-tokens`，避开官方 `@deepseek-ai/dsh-token-meter`（语义不同：官方为记账服务，本插件为输入 UX 预览）。
- **D1**：引擎用 `@huggingface/tokenizers`（WASM）。已记录其与「纯 JS」认知的差异（Rust→WASM、需托管 wasm、异步 init）；备选纯 JS BPE 引擎（约 200 行、同步、bundle 小、复用同份数据）保留为接口后第二实现，M0 若 WASM 管道阻塞可无缝切换。
- **D2**：纯客户端插件 v1，零后端改动；host half（`ctx.tokenMeter.measure()` 精确基线）留作 v2 选项。
- **D3**：显示形态 = 输入框行内小徽标（`conversation.input.right`），Tooltip 承载详情。
- **D4**：baseline 采用 `contextPressure.projectedTokens`（口径：下一次请求的 prompt 输入侧成本）；`tokenUsage` 累计仅作详情展示。

## 11. 修订记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 方案评审通过后落盘 | 初稿：命名 D0、引擎 D1、形态 D3、纯客户端 D2、baseline 口径 D4 |
| v0.1.1 | 2026-08-31 | 徽标配色改为按**绝对 token 数**分级（<100k 绿 / 100k–300k 琥珀 / >300k 红，`costLevel`+`costStyles`）；§4.5「占用率超 80% 警示色、超 95% 红色」作废，占用率仅保留展示不进颜色（用户反馈：读徽标是看「这条消息花多少 token」，不是窗口占用率） |