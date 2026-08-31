# M0 Spike 结论 — dsh-composer-tokens（V1–V4 + 决策门 G1）

- 日期：2026-08-29（半天窗口内完成）
- 作者：wanboy
- 对应 design.md §9 验证项 V1–V5；裁定 design.md §4.3 决策门 G1
- 全部实测证据来自本工作区 `.spike/` 与 `node_modules/` 及 DSH 发布包源码

---

## V1 — `@huggingface/tokenizers`：当前版本是纯 JS，无 WASM

**结论：design.md 中「Rust→WASM、需托管 15–20MB `.wasm`、异步 init、wasm 路径参数」的前提已随版本演进失效。**

| 项 | 实测 |
|---|---|
| 版本 | `0.1.3`（registry `latest`，`npm view` 核实） |
| 实现形态 | **纯 JavaScript**（README: "A lightweight tokenizer for the Web"，~8.3kB gzip，零依赖）；`dist/` 无任何 `.wasm`，无 `fetch/instantiate/atob` 调用 |
| 初始化 API | `new Tokenizer(tokenizerJson, tokenizerConfig)` —— **同步构造**；不再有 design 预期的 `fromString(tokenizer.json)` |
| 计数 API | `tokenizer.encode(text)` → `{ids, tokens, attention_mask}`，**同步**；`ids.length` 即 token 数 |
| `tokenizer_config.json` | **可选**：`config={}` 与真实 config 计数逐样本一致（DeepSeek/o200k/cl100k 三族均验证） |
| `add_special_tokens` | 普通文本下 `false` 与缺省结果一致；v1 固定 `false`（草稿不含模板 specials，帧成本由 seam 常数补偿） |

**精度实测**（`.spike/v1-test.mjs`，Node 22）：

- cl100k（Xenova/gpt-4 数据）：`"hello world" → ids=[15339,1917]`，与 OpenAI 官方文档逐位一致 ✓ 引擎数值精确。
- DeepSeek-V3 128k：`"hello world" → [33310,2058]`；中文 247 字符 → 146 tokens（≈0.59 tok/char）。
- 初始化耗时（含 JSON 解析后的 Tokenizer 构造）：DeepSeek 139ms / o200k 291ms / cl100k 160ms —— 一次性，可接受。
- 单次 encode：典型草稿 0.3–8ms —— 无须 Web Worker（v1 截断上限保护见下）。

> design.md §7「中文 ≈1–1.7 tokens/char」与 DeepSeek-128k 实测 0.59 不符：该数字更像是旧 GPT 系（≈0.9–1.0）或通用印象值。engine 以 tokenizer.json 为真值精确计数，验收口径以「与官方 tokenizer 逐位一致」为准（cl100k 已证明）。

---

## V2 — 资产服务面：`/plugins/<id>/` 只服务 client.js + client.js.map（确认）

- 源码证据：`@deepseek-ai/dsh-client-modules/lib/index.js`
  - `serveBundle`（L459–490）：仅当路径恰为 `/plugins/<id>/client.js` 或 `/plugins/<id>/client.js.map` 时映射到 package `exports["./client"]` 解析出的**单个文件**（L394–397 `clientPath = join(dirname(pkgPath), clientRel)`）；其余路径一律 404。
  - 扫描（L377–404）：读 package.json 的 `dsh.client`（`platform === "web"`）+ `exports["./client"]`；缺一即拒绝。
- **tsdown 构建探针**（v0.22.14 / rolldown v1.2.6）：
  - `format: cjs` + `banner/footer` 包装产出与官方 bundle 完全同构：`window.__ModuleLoader__.load({id, factory: (require) => { var module={exports:{}}; var exports=module.exports; ...exports.apply/inject; return module.exports; }})`，连 `Object.defineProperty(exports, Symbol.toStringTag, {value:"Module"})` 都一致 ✓
  - react 外置（`deps.neverBundle`）→ `require("react")`；`@huggingface/tokenizers` 内联进 bundle。
  - 注意：cjs 格式下 tsdown 强制 `platform=node`；产物以 `.cjs` 命名，需 `outExtensions: { cjs: ".js" }` 改回 `client.js`（服务端只认该文件）。
- **结论：不内联任何 tokenizer 数据进 bundle**（见 G1）。tsdown 资产 emit 能力在此方案下不再需要。

---

## V3 — 模型与串行化调用面（全部源码核实）

### `session.models` RPC（当前模型）

- 路径：`ctx.get("connection")?.api.sessions.models({ sessionId })`（`dsh-client-connection` L6286；`ctx.provide("connection", handle)` L10315；handle.api 含全部 RPC 域）。
- 返回：`{ result: { ok: true, value: { current: {provider, model, reasoningEffort?}, routable, groups: [{id, name, models:[{id, name}]}], failures } } }`（L5374–5380）。
- `host.describe()` → `{provider?, model?}` 是 **host 默认模型**，非会话级 —— 兜底仅在没有会话时可用，v1 不依赖。
- **会话级当前模型 id = `result.value.current.model`**。
- 模型切换**没有** wire 事件（`session/selectModel` 只是 RPC + 客户端私有 store）。故采用：per-session 缓存 + 投影 tick 冷却重查（3s 去重）+ 发送结束/新会话时重查；失效兜底 heuristic。见「应用层微调」。

### `inputTriggers` 串行化（发送同路径，§4.4）

- `ctx.inputTriggers`（`InputTriggerService`，`dsh-client-ui-input-trigger` L630/673）：`inputTriggers.sessionOf(actx)`（actx=`sessions.scope(sessionId)`）得到 per-session controller。
- 发送路径（`dsh-client-ui-conversation` L1315–1340）：对每个 occurrence `o`（含 `offset/length/source/ref`）→ `controller.serializeReference(o.source, o.ref, signal)`，重组为 `draft.slice(0,offset)+serialized+...`，最后 `.trim()`。
- **Badge 复用同一算法**：occurrences 从 ownerProps.input.occurrences 取（InputMachine snapshot L484 含 occurrences）。inputTriggers 不可用（插件缺失/错误）→ 降级 display 估算 + 「~」。

### 渲染器席位契约（§2.3 复核）

- 席位 props 组装顺序：kit(标准套件) → entry inject → slot inject → **owner props 覆盖**（`dsh-client-ui-renderer` L620–626）；标准套件含 `useSession/useSessions/useWorkspaces/useInput/useProjection/t/sessionId/renderSlot…`（L555–598）。
- `conversation.input.right` 由 `renderSlot("conversation.input.right", zone)` 渲染，`zone = {session, input}`，**hero/blank 态 `zone===undefined` 时不渲染**（`dsh-client-ui-conversation` L7191–7194、L7241–7242）—— 空值守卫天然成立，仍加防御。
- `input` 快照含 `draft / draftRev / phase / occurrences / claim / imageIds`（L472–484）。

---

## V4 — tokenizer 数据：URL / 哈希 / 许可（已下载并验证）

下载路径说明：本机 **Windows Schannel 全部 HTTPS 失败**（`curl.exe`/`Invoke-WebRequest` → `SEC_E_NO_CREDENTIALS`）；**Node 的 OpenSSL 正常**（npm 装包即证）。因此一律用 Node fetch（`scripts/prepare-tokenizer.mjs` 已验证可复现：下载→sha256 校验→生成 `src/client/tokenizer-data.ts`）。

| family | 数据源（固定 commit） | 文件 | 大小 | sha256 | 许可 |
|---|---|---|---|---|---|
| `deepseek` | `deepseek-ai/DeepSeek-V3@e815299b…` | tokenizer.json / config | 7,847,652 / 3,128 | `621ac2e3…` / `637bcd1a…` | DeepSeek `LICENSE-MODEL`（模型许可）+ `LICENSE-CODE`（MIT） |
| `gpt-o200k` | `wellflat/o200k_base_tokenizer@6284f558…` | tokenizer.json / config | 27,864,518 / 147 | `27f8a5a5…` / `f213bebc…` | 数据源自 OpenAI o200k_base（tiktoken，MIT）；**repo 无明确许可 → 对外分发前需复核** |
| `gpt-cl100k` | `Xenova/gpt-4@1d9f1f1b…` | tokenizer.json / config | 4,233,780 / 460 | `239eb235…` / `185a09e9…` | 数据源自 OpenAI cl100k_base（tiktoken，MIT）；repo 无 license 文件 → 同上 |

- CORS：huggingface.co 与 hf-mirror.com 均回显请求 Origin（`Access-Control-Allow-Origin: <origin>`，`Vary: Origin`）—— **浏览器运行时 fetch 无跨域障碍**（已实测）。
- 运行时下载链：primary `huggingface.co` → fallback `hf-mirror.com`（国内网络友好）；URL 以 commit sha 固定不可变。
- o200k 的 tokenizer.json 达 27.8MB：仅命中该家族时才拉取，IndexedDB 缓存后不重复。

---

## 决策门 G1 裁定：**运行时拉取 + IndexedDB 缓存（design 方案 2），且无 wasm 需要托管**

| 候选 | 裁定 |
|---|---|
| 1 嵌入 bundle | 否决：client.js 以 `cache-control: no-cache` 且无 validator 服务（serveBundle L481–484），每次刷新都全量重下；内联 7.5MB+ 数据使 HMR 与首屏双贬损 |
| **2 运行时拉取 + IndexedDB** | **采纳**：bundle 保持 ~60KB；按需拉取命中家族数据（sha256 校验 + IDB 缓存）；离线命中缓存仍精确，缓存缺失降级 Heuristic；CORS 已验证；国内网络 hf-mirror 兜底 |
| 3 混合 | 不必要：wasm 已不存在，唯一资产是 JSON；打包嵌入的收益（离线首用精确）被 no-cache 重下代价压过。若未来需要，可把 cl100k(4MB) 混入 bundle 作默认离线兜底 —— 留作 v1.1 优化项 |

**降级链：精确引擎（DeepSeek/o200k/cl100k，命中缓存或在线）→ HeuristicEngine（`ceil(len/4)`，UI 标「~」：未知模型 / MiMo / 离线且无缓存 / 拉取失败）。**

---

## 应用层微调（经核实后对 design 的细化，均不推翻已定决策）

1. **D1 落地方式**：`@huggingface/tokenizers@0.1.3` 本身即设计文档列出的「备选纯 JS BPE 引擎」形态（同步、bundle 小、复用同份数据），且它就是要在 npm 上安装的那个包 —— 无资产管道阻塞，无需切换实现。`JsBpeEngine` 沿用 design 接口 (`count(text): number; exact: boolean`)，仅命名保留为 `WasmEngine` 的接口层（内部实现为纯 JS）。
2. **模型刷新策略**（无切换事件）：`session.models` 每会话缓存；重查触发 = 挂载 / sessionId 变化 / 投影帧到达（3s 冷却）/ 草稿回合结束；失败 → heuristic 兜底。Tooltip 显示模型名与「基于最近一次请求」。
3. **@引用串行化**：`inputTriggers.sessionOf(actx)` 不可得或 serializeReference 抛错 → 按 display 文本估算并标「~」（与 design §4.4 一致）。
4. **超长文本**：>100,000 字符截断计数，超出部分按 heuristic 补计并标「~」（v1 上限保护，文档写明）。
5. **seam 常数表**：v1 全族 `seam = 3`（design §3.2 默认），表结构预留 per-family 覆盖。
6. **验收口径修正**：以「与官方 tokenizer 逐位一致」（cl100k 已对 OpenAI 文档验证）为准；design §7 中文 1–1.7 tok/char 与 DeepSeek-128k 实测 0.59 不符，标注为文档旧值。

## 环境事实（追加记录）

- 本机 Node v22.20.0 / npm 10.9.3；npm 需 `--cache <工作区内路径>` 与 `--legacy-peer-deps`（npm 10 的 arborist peer 解析 bug）。
- GUI 运行于 http://127.0.0.1:3080（dev:web 已激活，client-plugin HMR 可用）。
- web profile：`C:\Users\wbycl\.dsh\profiles\web`（薄壳：bundles = dsh-base / dsh-web-app + dsh-market）。

## 装机与热更实证（2026-08-29，做 127.0.0.1:3080 验收时）

1. `pnpm add D:\dsh-composer-tokens`（在 profile 目录）将包装入 profile（link 依赖）；`dsh plugin add` 对无 `dsh.bundle` 的纯 client 插件只做 pnpm 安装，不改 composition。
2. **关键坑**：pnpm 的 `link:` 在本机创建的是「指向目录的文件符号链接」，Node 跨盘 `stat/readdir` 失败（ENOENT）→ 运行中 host 无法 import 该包（`Cannot find package 'dsh-composer-tokens' imported from C:\...profiles\web\`）。修复：`Remove-Item` 后 `cmd /c mklink /J node_modules\dsh-composer-tokens D:\dsh-composer-tokens` 重建为目录 junction。
3. profile 的 `cordis.patch.yml` 加一行 `- id: composer-tokens / name: 'dsh-composer-tokens'`（官方 client 插件同款行）。本部署的 hmr `registerConfig` 未对 profile patch 生效（manifest rev 不变），故运行中 host 不热加载该行。
4. **无重启热补验证**（动态 Cordis Host 工具，会话级、不持久）：`ctx.get('loader').create({id:'composer-tokens', name:'dsh-composer-tokens'})` → 条目 fiber ACTIVE → 产出：`/plugins/dsh-composer-tokens/client.js` 200、boot manifest rev 变化且含新条目 `{inject:[slots,sessions,locale]}`、浏览器刷新后 `conversation.input.right` occupants 出现 `composer-tokens`。
5. **持久化路径**：上述 loader.create 不写盘（Loader.write() 为空）；进程重启后由 `cordis.patch.yml` 行 + 已修复的 junction 生效加载。重启前如需手工恢复可用同一 create 工具（会话级）。
6. 客户端激活验证（无法看浏览器 DOM 时的服务端代理）：`/plugins/<id>/client.js` 200 + boot manifest 条目 + `Slots.listSubTree("conversation.input.right")` 的 occupants 含 `{id:"composer-tokens", active:true}`。

## 口径修正：新会话固定开销（2026-08-29，评审反馈后）

**问题**：新对话（未发请求）徽标显示 ≈0；用户指出首次请求实际含系统提示词（persona/技能/时间上下文等）与工具定义。

**实证**：
- 老会话基线**已含系统+工具成本**，不得叠加：`contextPressure` 锚点 `pressureTokens` = provider 真实 inputTokens，或 `estimateHeader(nextHeader) + anchorSurface` 二者取大（`dsh-token-meter/lib/index.js` L596–616）；`estimateHeader = estimateSystemTokens + estimateToolsTokens`（L71–73，4 字符/token + 4 overhead）。
- 浏览器端现成的启发式值：`contextBreakdown` view = `{systemTokens, toolsTokens, messageTokens}`（L166–213），每次 `request/header` 按 host 组装的真实封套重算（L188–192）——已含全部 system 注入与工具 JSON。
- 新会话限制：header 仅在请求发起时广播；发送前浏览器拿不到 host 侧才组装的 system 文本 → 纯客户端只能占位，首次发送后自动校正。
- skill：`@skill` 引用在浏览器侧 `inputTriggers` 的 reference 源 `codec.serialize = ref`（`dsh-client-ui-reference/lib/client.js` L97–99）返回引用文本，草稿计数已按发送同路径计入；skill 内容体（`<skill_content>` 块，`dsh-skill` L57–70）由 host 在请求侧展开，发送前不可预知、发送后进入表面/封套由既有基线自校正覆盖。

**定案（纯客户端 v1）**：
```
baseline 优先级：
1) projectedTokens ?? pressureTokens          // 真实锚点（已含系统+工具，不双计）
2) contextBreakdown.systemTokens + toolsTokens // 有 header 广播后的官方启发式
3) localStorage 缓存 lastFixedTokens           // 上次会话规模占位（新会话发前）
4) 0                                            // 首次使用；Tooltip 提示“首次请求后校准”
```
- 缓存键 `dsh-composer-tokens.lastFixedTokens`，在 breakdown 变化时写入（仅 token 数，无敏感内容）。
- 徽标 `~` 判定扩展：baseline 非真实锚点（breakdown/last-fixed 占位）时标 `~`，anchor 时标 `≈`。
- Tooltip 新增：固定开销行（系统提示词+工具定义，官方口径估算）、基线来源标注、技能/引用口径说明、首次校准提示；`messageTokens` 不进总和（表面已由 projectedTokens 定价），仅备展示。
- 老会话数值与修正前一致（防双计专测覆盖）。

## 动态插件产物工具形态备忘（调试记录）

`harness.defineTool` 必须显式调用（`registerTool` 直接注册会被拒）；`parameters.additionalProperties` 需 true 或省略；`output.render` 必须返回 content blocks 数组 `[{type:'text',text}]`；render 收到的 value 是**冻结代理**——`JSON.stringify/String` 输出失真（`{}`），须用属性访问/`Object.keys` + 手写序列化；execute 返回对象时字段保留，返回 JSON 字符串会被反序列化。沙箱守卫拦截一切 `ctx` 对象访问（如 `loader.ctx`），服务方法可正常调用。