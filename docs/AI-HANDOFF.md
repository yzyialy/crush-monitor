# crush-monitor-local 项目交接书（本机单机版 / local-first）

> 读者：一个看不到任何历史对话、只能读本文件 + 仓库源码的 AI 或新接手开发者。
> 目标：10 分钟内知道这是什么项目、代码长什么样、改动时必须遵守什么、想改某个东西该动哪个文件。
> 约定：**「已验证」= 本次交接时在本机实读代码或实读构建/测试日志确认过；「建议」= 经验判断，不是代码事实。**
> 本文所有常量、阈值、函数名、路由、路径均与代码逐字一致（核对基准：本机 Node v24.19.0 + 仓库当前工作树）。
> **本文件描述的是本机单机版**：没有账号、没有服务端数据库、长期数据全在浏览器里。
> `docs/DEPLOYMENT.md` 已改写成「本机运行与排障」（含 dist 缺失兜底、历史对话、非安全上下文三条）；`docs/ARCHITECTURE.md` 本次未逐字核对。
> **本文与代码不一致时以代码为准。**

---

## 1. 项目定位与当前状态

**一句话**：`crush-monitor-local` 是本机单机版的中文聊天分析工具 —— 第一层 Jev（TypeSafe，`jev-1.13.0`）逐句做情绪/意图观察，第二层 DeepSeek 做上下文解释，**所有数字（行为基线、趋势、模式）全部由程序计算**，而**长期数据只存在这台电脑的浏览器里**（local-first）。

数据放在哪，是本版本唯一真正改变的东西：

| 项 | 本机单机版 |
|---|---|
| 账号 / 登录 / session | **没有**（`server/` 里不存在任何认证代码） |
| 服务端数据库 | **没有**（没有 `server/db.ts`，没有 SQLite，没有 migration） |
| 长期档案（基线/记忆/模式/反馈） | 浏览器 `localStorage`，键名见 §5.2 |
| 聊天记录 | 浏览器 `localStorage`，键名见 §5.4 |
| 服务端职责 | 只做三件事：调 Jev、调 DeepSeek、把 `dist/` 发出去（外加把前端错误上报打进日志）。**不落盘任何聊天内容或长期数据** |
| 多设备同步 | **没有**。换一台电脑就是从零开始 |
| 乐观锁 / 409 冲突 | **没有**。本机只有一个写入者，`useWorkspace()` 的 `version` 恒为 `0`、`conflict` 恒为 `""` |

当前状态（已验证）：

- **测试：`tests/` 下 10 个测试文件、229 个用例，229 pass / 0 fail**（依据本机 `npm test`：`ℹ tests 229 / ℹ pass 229 / ℹ fail 0`，退出码 0）
- 档案结构版本：`PROFILE_SCHEMA_VERSION = 2`；基线口径：`BASELINE_VERSION = 1`
- 第二层 prompt 版本：`DEEP_ANALYSIS_PROMPT_VERSION = 3`
- 运行方式：本机 `npm run dev`（前端 :5178 / 后端 :3178）或 `npm run build && npm start`（只起后端，用 `dist/`；**dist 缺失时给中文提示页而不是 404**，见 §6）

---

## 2. 技术栈与运行方式

| 项 | 事实（来自 `package.json` / 代码） |
|---|---|
| 运行时 | Node `>=22.12.0`（engines）；本机实测 `v24.19.0` |
| 前端 | React `^19.1.0` + TypeScript `^5.8.0` + Vite `^6.3.0`（`@vitejs/plugin-react`） |
| 后端 | Express `^5.1.0` |
| 数据库 | **没有**。本机版不存在服务端持久化 |
| 校验 | zod `^3.24.0` |
| 测试 | `node:test`，经 `tsx` 运行 |
| 第一层模型 | `@typesafe-ai/sdk`，`MODEL = "jev-1.13.0"`，`RUBRIC = "crush-2026-09-19.4"` |
| 第二层模型 | DeepSeek 官方 Responses API（**不引 SDK**），默认 `DEEP_ANALYSIS_DEFAULT_MODEL = "deepseek-flash"` |

npm scripts 的实际作用（`package.json`，只有 7 个）：

| script | 做什么 |
|---|---|
| `dev` | `concurrently` 同时起 `tsx watch server/index.ts`（:3178）与 `vite --host 127.0.0.1`（:5178，`strictPort`，`/api` 代理到 `http://127.0.0.1:3178`） |
| `build` | `tsc --noEmit && node scripts/build-guide.mjs && vite build` → `dist/` |
| `start` | `tsx server/index.ts`；由 `express.static` 提供 `dist/`，非 `/api/` 未命中回退 `index.html` |
| `test` | `tsx --test tests/*.test.ts` |
| `check:live` | `tsx scripts/check-live.ts` —— **会真实调用 Jev 一次，消耗你自己的额度** |
| `setup` | `node scripts/setup.mjs`：把 `.env.example` 复制成 `.env`（已存在则保留） |
| `export:source` | `node scripts/export-source.mjs` |
| `guide:build` | `node scripts/build-guide.mjs`：生成 `public/guide.html` |

> 旧版本里的 `npm run user:add` / `user:list` / `user:passwd` / `user:disable` / `user:enable` 与 `npm run db:migrate` / `db:backup` / `db:stats` 这些脚本在本机版**已经不存在**（对应的 `scripts/user-cli.ts`、`scripts/db-cli.ts` 已删除）。不要再照旧文档去敲这些命令。

环境变量（只列 `server/` 实际读取的，已核对代码）：`TYPESAFE_API_KEY`、`PORT`（默认 `3178`）、`HOST`（默认 `127.0.0.1`）、`DEEP_ANALYSIS_ENABLED`（精确等于 `"true"` 才开启）、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEP_ANALYSIS_MODEL`、`DEEP_ANALYSIS_PROMPT_VERSION`、`DEEP_ANALYSIS_TIMEOUT_MS`（默认 `45000`）。

> ✅ 已修正：`.env.example` 曾把 `DEEP_ANALYSIS_PROMPT_VERSION` 写成 `1`，而代码默认值是 **3**（`shared/types.ts`）。现在 `.env.example` 已写 `3`。**建议**：自己写 `.env` 时要么显式写 `3`，要么删掉这一行直接用代码默认值 —— 写错会改变第二层缓存键，导致旧解读被错误复用。

---

## 3. 目录与文件职责表

### 3.1 `shared/`（前后端共用纯逻辑，18 个文件）

| 文件 | 负责什么 | 什么时候要动它 |
|---|---|---|
| `hash.ts` | ★ **不依赖安全上下文的 id 与哈希**：`randomId()`（randomUUID → getRandomValues → 时间戳+随机数）、`sha256Hex()`（subtle → 纯 JS）、`sha256HexSync()`。明文 HTTP + 局域网 IP 下 `crypto.randomUUID` / `crypto.subtle` 根本不存在，前端一律走这里 | 任何"生成 id / 算上下文哈希"的需求都从这里走；**不要在 `src/` 里直接写 `crypto.randomUUID()` 或 `crypto.subtle`**（§7 规则 16）。守护用例：`tests/insecure-context.test.ts` |
| `types.ts` | 全部共享类型与常量（`MODEL`/`RUBRIC`/`DEEP_ANALYSIS_PROMPT_VERSION`/`DEEP_ANALYSIS_DEFAULT_MODEL`/`DEEP_ANALYSIS_DEFAULT_BASE_URL`/`DEEP_CONTEXT_WINDOW`/`SESSION_GAP_MINUTES`/`PROFILE_STORAGE_KEY`/`PROFILE_SCHEMA_VERSION`/`BASELINE_VERSION`/`BEHAVIOR_PATTERN_*`/`RETRIEVAL_*`/`MAX_ACTIVITY_EVENTS`）、`contextKey`、`deepContextKey`、`contextFromRelation` | 改任何跨端结构、阈值、默认值时先来这里 |
| `labels.ts` | 12 类情绪的 label + 判定标准（`EMOTIONS`、`topEmotions`） | 改情绪体系；必须与第一层 prompt 同步 |
| `intents.ts` | 35 类意图（`INTENTS`、`topIntents`） | 改意图体系；同上 |
| `rules.ts` | 第一层答案的 zod 形状与阈值判定（`scoreAnswer`/`choiceAnswer`/`judgment`/`actionResult`/`safeStage`/`safeTone`/`percentages`） | 改第一层输出解析口径 |
| `parser.ts` | 微信/手动格式解析（`parseChat`/`toMessages`）、重叠合并（`mergeMessages`）、长度约束、`withinScope`/`recentScope`/`normalizedEditor` | 改粘贴格式支持、改「继续粘贴」的合并规则 |
| `ratings.ts` | 回复评级七档（`REPLY_RATINGS`、`replyRating`） | 改评级分档 |
| `patterns.ts` | ★ **确定性统计引擎**：`METRIC_DEFINITIONS`（指标定义表）、`computePatterns`/`computeSessionMetrics`/`computePatternTrend`/`sliceSessions`/`splitHalf`/`latestSession`/`normalizeMetricDelta`/`detectExternalCauses`/`describePatterns`/`describePatternTrend` | **所有数字的唯一来源**；改指标/阈值必须动它（见 §7 规则 1） |
| `profile.ts` | ★ **跨会话基线与长期模式**：`updateBaseline`/`decayWeight`/`baselineStatus`/`computeHistoricalDeltas`/`computeHistoricalTrend`/`describeComparedToUsual`；习惯 `aggregateHabits`/`habitHints`/`establishedHabits`；推断候选 `candidatesFromAnalysis`/`mergeInferenceCandidates`；模式 `BEHAVIOR_RULES`/`deriveBehaviorPatterns`/`promoteBehaviorPatterns`/`mergeKnownPatterns`/`deriveKnownPatterns`；确认纠错 `applyConfirmation`/`applyUserCorrection`/`confirmationParts`；`emptyProfile`/`profileIdFor`/`findConflictingInferences`/`computeFeedbackStats` | 改基线数学、模式门槛、确认/纠错语义时必须动它（高风险改动） |
| `profile-ops.ts` | 档案增量操作的**纯函数编排**（`commitConversationToProfile`/`confirmInProfile`/`correctInProfile`/`removeMemoryFromProfile`/`resetBaselineInProfile`/`applyFeedbackStats`/`sessionScope`） | 加一种「档案操作」：这里加纯函数 + `src/local-ops.ts` 暴露出去（本机版**没有**服务端路由分支要加） |
| `memory.ts` | 上下文窗口（`boundedContext`）、相关记忆（`relevantEvents`）、记忆创建/合并/不变量（`createObservedMemory`/`createInferredMemory`/`mergeMemory`/`memoryViolations`/`isUsableMemory`/`setMemoryStatus`）、**升级通道 `applyFeedback`** | 改记忆生命周期、改「什么能升级为 user_confirmed」 |
| `facts.ts` | 只从对方原话抽客观事实（`FACT_RULES`/`FORBIDDEN_FACT_WORDS`/`extractObservedFacts`/`observedMemoriesFromFacts`） | 想放宽/收紧「什么能自动成为 observed 记忆」 |
| `events.ts` | 确定性邀约/答复事件统计（`detectActivityEvents`/`recordActivityEvents`/`eventConversations`） | 改邀约与答复的关键词归类 |
| `media.ts` | 媒体占位识别与给模型的转述说明（`parseMediaMarker`/`hasMediaDescription`/`mediaNoun`/`mediaPromptText`） | 改语音/图片/表情包的处理方式（见 §7 规则 13） |
| `retrieval.ts` | 检索与预算：`retrieveRelevantProfileContext`、`compactBaseline`、`describeProfileContext`、`buildAuditTrace`、`estimateTokens`（内部还有 `RETRIEVAL_TOKEN_BUDGET = 1200` 的预算与丢弃顺序） | 改「送进第二层的长期上下文」范围与丢弃顺序 |
| `translation.ts` | ★ UserTranslation 组装（`buildTranslation`/`findImperative`/`trendLabel`）：过滤命令式建议、外部原因修正 | 改用户可见文案结构 |
| `diagnostics.ts` | 只读统计 `summarizeRuns`（区分 `rawCleanRate` 与 `finalAcceptRate`） | 想审计「模型本身干净」还是「被保护层救回来」 |
| `fixtures.ts` | 内置示例聊天（`examples`/`exampleText`/`fixtureSnapshot`） | `check:live` 与测试的输入数据 |

### 3.2 `server/`（后端，11 个文件 —— 本机版只剩「算一次」这件事）

| 文件 | 负责什么 | 什么时候要动它 |
|---|---|---|
| `index.ts` | 唯一的 Express 入口（**导入即 `app.listen`，测试不能 import 它**）：安全响应头、`express.json({ limit: "1mb" })`、`GET /api/health`、`POST /api/client-error`（前端错误上报，不要求登录）、`POST /api/analyze`（进程内限流）、`POST /api/deep-analysis`（独立限流 + 独立错误处理）、静态托管（委托给 `./static`）、错误中间件、启动日志。**没有任何持久化、没有认证、没有同源中间件** | 改分析接口流程、限流参数、服务启动行为 |
| `static.ts` | ★ `dist/` 托管与**「还没 build」的兜底**：`frontendEntryPath()`、`hasFrontendBuild(dir, exists?)`、`missingFrontendNotice(dir)`、`missingFrontendPage()`、`registerStatic(app, { dir, exists? })`。缺 `dist/index.html` 时**不崩**：所有非 `/api/` 路径返回 503 + 一段中文提示页（「请先运行 npm run build」），启动日志里同时打一句；返回 `boolean` 供启动日志用。`exists` 可注入，测试才能不依赖真实文件系统 | 改静态托管、改「没构建」的提示文案。守护用例：「本机 28」 |
| `deep-schema.ts` | ★ 第二层请求契约 `deepRequestSchema`（纯 schema，**无副作用，测试可直接 import**）。单独一个文件的原因就是 `index.ts` 有 `app.listen` 副作用 | 改第二层请求输入形状 |
| `analysis.ts` | 第一层 Jev 实现：`requestSchema`、`buildRequest`、三个 task（`overview`/`other_messages`/`self_message`）、SDK 调用与错误映射 | **改第一层 prompt / rubric / 模型时动它** |
| `ai/index.ts` | Provider 注册表 `resolveProviders()` | 换解释模型/接 GPT、Kimi、GLM 时只改这里 |
| `ai/types.ts` | `ObservationProvider` / `InterpretationProvider` 接口、`InterpretationOutcome`、`DeepAnalysisError`、`DeepAnalysisErrorCode` | 改 provider 契约 |
| `ai/jev.ts` | 把 `analysis.ts` 包成 `ObservationProvider`（纯接口适配） | 基本不用动；**不要在这条路径加第二层逻辑** |
| `ai/deepseek.ts` | 第二层 provider：`DEEP_ANALYSIS_INSTRUCTIONS`（系统 prompt）、`DEEP_ANALYSIS_SCHEMA`、`deepAnalysisOutput`（zod）、`buildPayload`、`extractOutputText`、`readDeepSeekConfig`、`MAX_BOUNDARY_RETRIES = 1`、安全重试、错误映射 | **改第二层 prompt / JSON Schema / 重试策略时动它** |
| `ai/boundary.ts` | ★ Interpretation Boundary：`FATAL_RULES`/`FIELD_RULES`/`SOFTEN_RULES`、`MIND_READING_THRESHOLD = 3`、`enforceBoundary`、`enforceBoundaryCompat` | **核心逻辑默认不要改**（见 §7 规则 12） |
| `ai/input.ts` | `buildProviderInput()`：服务端**重算** `patterns`/`patternTrend`/`historicalTrend`，丢弃客户端一切数字 | 改「服务端数字唯一来源」这条链路时 |
| `ai/references.ts` | messageId 归一化 `normalizeMessageReferences`：模型截断的 6–12 位前缀还原成「第 N 条消息」，有歧义降级为「相关消息」 | 用户可见文本里又出现裸 ID 时 |

已删除（本机版**没有**，也不要再创建）：`server/db.ts`、`server/auth.ts`、`server/routes.ts`、`tests/server.test.ts`、`scripts/user-cli.ts`、`scripts/db-cli.ts`。`tests/local-workspace.test.ts` 的「本机 25. 本机版已经没有任何账号 / 数据库模块」会断言这些文件确实不存在。

### 3.3 `src/`（前端，14 个文件：11 个 ts/tsx + 3 个 css）

| 文件 | 负责什么 | 什么时候要动它 |
|---|---|---|
| `App.tsx` | 主界面编排：粘贴/解析/第一层分析/深度解读/长期观察/设置/**历史对话面板**/出错红条。顶部三个纯函数：`parseStamp`（显式解析微信「2026年09月21日 17:19」格式）、`stampOf`（显示到分钟，解析不了原样返回）、`conversationName`（`第 N 段 · 时间 · 第一句`，用户改过名就用改的名字） | 改整体交互与布局 |
| `clientLog.ts` | ★ **前端错误上报**：`reportClientProblem(scope, error)` 与 `reportClientStep(step)`（点击面包屑），POST `/api/client-error`。只发错误文本 / 行号 / 页面路径 / UA，同会话最多 20（错误）+ 12（面包屑）条；**绝不发聊天内容或密钥**；发不出去就静默 | 加新的失败路径时顺手 `reportProblem`；**不要往 body 里塞任何聊天内容** |
| `main.tsx` | React 挂载入口 | 基本不动 |
| `storage.ts` | ★ **本机版的全部持久化**：档案读写与校验（`validateProfile`/`migrateProfilePayload`/`loadProfiles`/`saveProfiles`/`upsertProfile`/`deleteProfile`/`clearBaseline`/`deleteMemory`/`clearLongTerm`）、本机聊天（`loadChat`/`saveChat`/`localChat.*`/`fingerprintSeed`/`shortHash`/`migrateChatPayload`/`clearLocalChat`）、最近对话（`lastConversationFor`/`rememberConversation`）、记忆与反馈（`loadMemory`/`saveMemory`/`recordFeedback`/`loadFeedback`）、解读反馈（`loadInterpretationFeedback`/`recordInterpretationFeedback`）、旧数据检测（`legacyMigrated`/`detectLegacyProfile`/`loadLegacySnapshot`/`markLegacyMigrated`/`adoptLegacyMemories`） | **改 `PersonProfile` 或 `LocalConversation` 结构时必须同步改它**；所有键名都在这里 |
| `local-ops.ts` | ★ **无 React 的编排层**：`readProfile`/`withFeedbackStats`/`readProfileOp`/`writeProfileOp`/`removeProfile`/`buildConversationId`。它不发任何网络请求，测试可以直接驱动。**`writeProfileOp` 写失败时抛 `LocalStorageError`**（不再静默返回） | 加一种档案变更的编排；改对话 id 推导 |
| `useWorkspace.ts` | ★ **本机工作区（React 包装）**。返回结构：`ready/error/people/person/personId/conversationId/conversations/profile/version(恒 0)/conflict(恒空)/selectPerson/selectConversation/ensureRemote/loadMessages/loadStored/saveLines/commit/confirm/correct/suggestConflicts/removeMemory/resetBaseline/clearAll/removePerson/deleteConversation/startNewChat/openConversation/refreshConversations/renameConversation/renamePerson/refresh/legacy`。`ensureRemote` 失败时**抛出带原因的 Error**（不再静默 `return null`）；`conversationsOf()` 按 `updatedAt` 倒序并补齐 `messageCount/preview/lastMessageAt`；`saveLines()` 把第一层结果写回消息 | **长期数据与聊天记录只用它读写**（见 §7 规则 14、17） |
| `useProfile.ts` | 第三阶段的本地档案控制器（`createProfileStore`/`profileUiState`/`coldStartNotice`/`conversationIdFor`/`historyForSession`）。仍被 `App.tsx`（`conversationIdFor`/`historyForSession`/`profileUiState`）、`LongTermPanel.tsx`（`coldStartNotice`）、`tests/profile.test.ts`（`createProfileStore`）使用；最外层的 `useProfile()` hook 目前没有调用点 | 只读兼容与回归用；**新代码不要用它写长期数据**（用 `useWorkspace.ts`） |
| `useAnalysis.ts` | 第一层调度、缓存、并发 | 改第一层前端行为 |
| `useDeepAnalysis.ts` | ★ 第二层 controller：`createDeepController`（缓存键、stale、并发、取消、身份校验）+ React 包装 `useDeepAnalysis`、`buildObservations`/`buildDeepRequest`/`profileSignature` | 改深度解读的前端调度/缓存 |
| `DeepPanel.tsx` | UserTranslation 七部分展示 + 反馈 + 证据定位（`DeepPanel`、`DeepPrivacyNote`） | 改「深度解读」界面文案与结构 |
| `LongTermPanel.tsx` | 长期观察面板：历史样本、明显变化、已确认事实、观察中的模式、表达习惯、确认/纠错、审计、删除入口 | 改长期观察界面 |
| `style.css` / `deep.css` / `longterm.css` | 主界面 / 深度解读 / 长期观察样式 | 对应界面改样式 |

已删除（本机版**没有**）：`src/api.ts`、`src/useAuth.ts`、`src/LoginPage.tsx`、`src/login.css`。

### 3.4 `tests/`、`scripts/`、`docs/` 与根文件

| 文件 | 负责什么（用例数） |
|---|---|
| `tests/core.test.ts`（24） | 解析、重叠合并、评分边界、拒绝优先、长度约束、第一层判定 |
| `tests/deep.test.ts`（30） | 第二层 provider：输出结构校验、伪精确拦截、错误映射、日志不含正文、缓存键、provider 装配 |
| `tests/deep-ui.test.ts`（24） | `createDeepController`：缓存身份、stale、并发去重、取消、失败隔离、翻译层、密钥不外泄 |
| `tests/stabilize.test.ts`（19） | 边界三级策略、重试上限恒为 1、单字段违规不废整份、stale 时旧结果保留 |
| `tests/normalize.test.ts`（20） | messageId 前缀归一化与歧义降级 |
| `tests/pattern-trend.test.ts`（23） | 六项指标 baseline/delta、会话切分、趋势方向与确定性、外部原因、第二层不得覆盖 trend |
| `tests/profile.test.ts`（39） | 基线更新、习惯幂等、推断候选、模式门槛（3 段/4 段）、确认与纠错、检索预算、迁移 |
| `tests/media.test.ts`（7） | 媒体占位、补充描述、统计口径不受占位符影响、重复导入 |
| `tests/insecure-context.test.ts`（9） | ★ **非安全上下文回归**：没有 `randomUUID` / 没有 `subtle`（甚至 `crypto` 整体缺失）时 id 与哈希照常工作；纯 JS SHA-256 对 11 组向量与 `node:crypto` 逐字符一致；`parseChat → toMessages → sha256Hex(contextKey(...))` 整条链路不抛 |
| `tests/local-workspace.test.ts`（34） | ★ 本机版补测：持久化往返 / 档案 op（走本机真实编排路径）/ 旧 localStorage 与 schema 迁移 / 指纹顺序无关且位置索引不进指纹 / 源码与 `dist/assets` 无密钥与模型域名 / 服务端入口不再挂账号路由 + 已删文件确实不存在 / 第二层请求契约 / **dist 缺失不 404**（28）/ **历史对话排序·改名不改序·新对话不删历史·旧自动标题迁移**（29–32）/ **写不进存储时抛出带原因的 Error**（33）/ **第一层结果本机持久化且幂等**（34） |
| `scripts/check-live.ts` | 真实调用一次 Jev（用 `exampleText(0)`），打印 model/latency/usage/overview |
| `scripts/setup.mjs` | `.env.example` → `.env` |
| `scripts/build-guide.mjs` | 生成 `public/guide.html`（`npm run build` 会调用它） |
| `scripts/export-source.mjs` | 按白名单导出源码到 `artifacts/`，扫描密钥与家目录路径，命中即中止。注意它的敏感串闸门**只认 `TYPESAFE_API_KEY`，不认 `DEEPSEEK_API_KEY`**（建议补齐） |
| `docs/ARCHITECTURE.md` | 设计权威（旧口径，本次未逐字核对，用前先看 §1 的提醒） |
| `docs/DEPLOYMENT.md` | 本机版口径的「本机运行与排障」（**已与代码同步**：dist 缺失兜底、历史对话、改名与排序、存储写失败、非安全上下文、四个路由表都在里面） |
| `docs/USER-GUIDE.md` / `public/guide.html` | 面向用户的使用说明（guide.html 由 `npm run guide:build` 从 USER-GUIDE.md 生成，`npm run build` 会顺带跑） |
| `README.md` | 面向用户的功能与使用说明 |
| `package.json` / `tsconfig.json` / `vite.config.ts` / `.gitignore` | scripts 与依赖；`strict: true` + `noEmit`，include `src`/`shared`/`server`/`tests`/`scripts`；vite 端口 5178 + `/api` 代理 + watcher 忽略 `*.tmpdir`/`*.tmp-*` |
| `index.html` / `public/favicon.svg` / `LICENSE` | SPA 入口 / 图标 / MIT |

---

## 4. 分层架构（不可跨越的边界）

数据流与职责（`shared/types.ts` 顶部注释 + `server/ai/input.ts` 一致）：

```
Evidence ──▶ Observation ──▶ Interpretation ──▶ UserTranslation ──▶ 用户判断
   │              │                  ▲                 ▲
   └──────▶ Pattern ────────────────┘                 │
                  │                                    │
                  ▼                                    │
               Memory ─────────────────────────────────┘
                  ▲
            UserFeedback（唯一能提升来源等级的力量）
```

| 层 | 是什么 | 由谁产生 | 关键约束 |
|---|---|---|---|
| Evidence | 原始消息 + 时间戳 | 用户粘贴 | 唯一事实来源；**只存在浏览器里** |
| Observation | 逐句情绪/意图分布、表达质量分 | Jev（第一层） | 保留原始概率，不被上层改写 |
| Interpretation | 上下文解读、多种可能、矛盾 | DeepSeek（第二层） | 只能是解释；**不得输出概率数字** |
| Pattern | 主动发起比例、回复延迟、情绪漂移等统计量 | 程序纯函数 | **LLM 不得计算或伪造** |
| Memory | 跨会话长期记忆 | 观察/模型推断/用户确认 | `model_inferred` 永不自动升级 |
| UserTranslation | 给用户看的七个部分 | 程序组装 + 过滤 | 严禁命令式关系建议 |
| 最终判断 | 怎么理解对方、下一步做什么 | **用户本人** | 系统不替用户决定 |

一次第二层请求里，谁负责哪一段（本机版的**关键差异**）：

```
浏览器（唯一的数据源）                     服务端（只算一次，不落盘）
  ├ 本机聊天记录 localStorage
  ├ 档案 localStorage
  ├ boundedContext(最近 36 条)  ──────▶  deepRequestSchema 校验
  ├ retrieveRelevantProfileContext      buildProviderInput():
  │   → ProfileContextBundle              用 computePatterns 重算 patterns（丢弃客户端数字）
  └ POST /api/deep-analysis               用 computePatternTrend 算会话内趋势
        { messages, observations,         用 computeHistoricalTrend 算跨会话 delta
          memory, profile }          ◀──  返回 analysis + patternTrend + historicalTrend
  └ 解读结果写回浏览器缓存与档案
```

> **本项目的核心红线：LLM 永远不能产生或修改任何数字。** 基线、趋势、delta、模式全部由 `shared/patterns.ts` 与 `shared/profile.ts` 的纯函数算出；模型只能解释这些数字。代码强制点：
> - `server/ai/input.ts` 的 `buildProviderInput()` 用 `computePatterns()` / `computePatternTrend()` / `computeHistoricalTrend()` **在服务端重算**，丢弃客户端传入的一切数值；
> - 会话内趋势显式标 `scope: "session"`，跨会话趋势标 `scope: "historical"`，两者不得合并成一个 delta；
> - 测试守护：`pattern-trend.test.ts` 的「10. DeepSeek 不能覆盖程序算出的 trend」「11. friend 与 crush 的关系语境产生不同的 prompt input」，`deep-ui.test.ts` 的「K. 客户端传入的 pattern 数值会被服务端丢弃并重算」。

---

## 5. 数据模型

### 5.1 长期数据 / 聊天记录都在浏览器（服务端不落盘）

**服务端不落盘任何聊天内容或长期数据**：没有数据库文件、没有 `data/` 目录、没有账号表、没有运行记录表。每次请求把这次要分析的东西带上来，算完就丢。

浏览器 `localStorage` 的键（全部来自 `src/storage.ts` 与 `shared/types.ts`）**只有这些**：

| 键 | 内容 | 定义处 |
|---|---|---|
| `crush-monitor.profile.v1` | `{ version, profiles: PersonProfile[] }` | `PROFILE_STORAGE_KEY`（`shared/types.ts`） |
| `crush-monitor.chat.v1` | `{ version, people: [...] }`（本机聊天记录） | `LOCAL_CHAT_KEY` |
| `crush-monitor.last-conversation.v1` | `{ [personId]: conversationId }`（每人最近打开的对话） | `LOCAL_LAST_CONVERSATION_KEY` |
| `crush-monitor.memory.v1` | 第二阶段遗留的扁平记忆（会被 `adoptLegacyMemories` 收编后删掉） | `MEMORY_KEY` |
| `crush-monitor.feedback.v1` | 记忆确认/纠错反馈 `UserFeedback[]` | `FEEDBACK_KEY` |
| `crush-monitor.deep-feedback.v1` | 解读反馈 `InterpretationFeedback[]` | `DEEP_FEEDBACK_KEY` |
| `crush-monitor.migrated.v1` | 「旧数据已处理」的时间戳 | `MIGRATED_KEY` |

> 长期数据的四把 key 收在 `LONG_TERM_KEYS = [PROFILE_STORAGE_KEY, MEMORY_KEY, FEEDBACK_KEY, DEEP_FEEDBACK_KEY]`；`clearLongTerm()` **只删这四把**，`clearLocalChat()` 只删聊天那两把 —— 「清空长期观察」不等于「删掉我的聊天」。

### 5.2 `PersonProfile`（`localStorage` 的 `crush-monitor.profile.v1`）

JSON 结构（`shared/types.ts` 的 `PersonProfile`）：`id`、`displayName?`、`relationshipContext`、`createdAt`、`updatedAt`、`baselineVersion`、`behaviorBaseline`、`memories`、`knownPatterns`、`habits`、`activityEvents`、`inferenceCandidates`、`feedbackStats`、`confirmations`、`corrections`、`sourceConversationIds`。

- **`PROFILE_SCHEMA_VERSION = 2`**（v1 → v2：`KnownPattern` 增补 `patternKey`/`conversationCount`/`supportingMetrics`，来源 `"observed"` 迁移为 `"deterministic"`；`PersonProfile` 增补 `activityEvents`；基线增补 `recentConversationIds`）。
- `BASELINE_VERSION = 1`：任何影响 mean/median 计算的改动都必须递增。
- **每一次从存储读回来都要过 `validateProfile()`（`src/storage.ts`）**：坏 JSON、非法来源等级、手改出来的统计数字一律安全忽略，返回 `null` / 空数组，**绝不让应用打不开**。关键点：
  - 逐条校验记忆（`parseMemory`），最后再用 `memoryViolations()` 过滤一遍：凭空出现的 `user_confirmed` 进不来；
  - `feedbackStats` **不从存储读取**，而是由 `confirmations` / `corrections` 用 `computeFeedbackStats()` 重新算出；
  - `migrateProfilePayload()` 接受三种历史形态：`{version, profiles}`、无版本号的数组、缺 `version` 的对象；**版本号高于当前的直接返回空**（来自更新版本的数据不敢乱动）。
- 写入没有版本号、没有乐观锁：`saveProfiles()` 整体覆盖这一把 key。失败（例如配额满）时 `write()` 返回 `false`，**调用方目前不检查这个返回值**（见 §11）。
- 档案 id 由称呼 + 关系推出：`profileIdFor({ displayName, relation })`；`useWorkspace.scopeIdFor()` 是它的包装。

### 5.3 本机聊天的结构

```ts
LocalMessage      = { id, sender: "self" | "other", content, sentAt: string | null,
                      mediaKind: string | null, line?: LineResult | null }
LocalConversation = { id, title: string | null, createdAt, updatedAt, messages: LocalMessage[] }
StoredChat        = { version, people: { id, displayName, relationshipType: "crush" | "new" | "couple",
                                         createdAt, updatedAt, conversations: LocalConversation[] }[] }
```

- `LOCAL_CHAT_SCHEMA_VERSION = 1`；`migrateChatPayload()` 同样是防御式：坏字段逐条丢弃，来自更高版本的存储直接返回空。
- 没有正文的消息不入库：`useWorkspace.toImportPayload()` 只留 `kind === "text"` 且正文非空的；`localChat.appendMessages()` 再兜一层（空白正文直接算 `skipped`）。
- 删除入口分成两套、互不牵连：`deleteChatPerson()` / `deleteChatConversation()` 只删聊天；`deleteProfile()` 只删档案。
- **`LocalConversation.title` 的唯一含义是「用户自己起的名字」**（改名留空 = 恢复 `null`）。
  导入时**不再**把「第一句摘要」写进去 —— 那会让同一段聊天重复粘贴时看起来"名字都一样"。默认名字由界面现场算（`第 N 段 · 时间 · 第一句`，`src/App.tsx` 的 `conversationName`）。
  `parseLocalConversation()` 会把旧版本自动写进去的标题（恰好等于 `conversationTitle(messages)`）认回 `null`；用户真的改过的名字原样保留。守护用例：「本机 32」。
- 「历史对话」需要的东西由 `conversationsOf()` 现算：`messageCount`（条数）、`preview`（`conversationPreview()`：第一条有正文的消息，截 80 字）、`lastMessageAt`（`lastMessageAtOf()`：最后一条带时间的消息）。
- **第一层结果跟着消息一起存在本机**（`LocalMessage.line`）：服务端版存在 `messages.line_json`，本机版对应地存在这条消息对象上。写入口是 `localChat.saveLines()`（幂等：内容没变不写盘），由 `useWorkspace.saveLines()` 暴露、`App.tsx` 的一个 effect 在 `a.lines` 变化时调用；读出口就是 `loadStored()` 里的 `row.line`。
  **不存会怎样**：刷新页面或从「历史对话」打开某一段时只剩光秃秃的气泡，情绪/意图标签全没了，用户要么看到空白、要么再花一次额度重跑 Jev（这条是**真机实测发现的**，不是纸面推断）。坏 `line`（手改出来的）由 `parseStoredLine()` 丢弃，绝不影响消息本身。守护用例：「本机 34」。

### 5.4 消息去重指纹与对话 id（最重要的一条 id 规则）

| 项 | 规则 |
|---|---|
| 指纹种子 | `fingerprintSeed()` = `sender + "|" + (sentAt ?? "") + "|" + content` |
| 出现次数 | 该指纹在**本次导入**里出现的第几次（`#occurrence`） |
| 消息 id | `m:${shortHash(`${conversationId}|${seed}|#${occurrence}`)}` |
| **位置索引** | **绝不进指纹**。否则同一批消息换个顺序就会变成「全新消息」，重复导入会重复累计基线 |
| 对话 id | `buildConversationId({ personId, relation })` = `conv:${shortHash(`${personId}|${relation}`)}`，**稳定**：刷新页面/重开浏览器回到同一段，`commitConversationToProfile` 靠它判断「这段是否已经并入过」，基线不会被重复累计 |
| 幂等 | 同一个 id 已存在就跳过（`added 0 / skipped N`）；「同一秒两条一模一样的话」仍然各占一条 |

**对话列表的顺序与改名（一条容易踩的规则）**：

| 项 | 规则 |
|---|---|
| 排序 | `sortConversations()`：`updatedAt` 倒序 → `createdAt` 倒序 → `id` 倒序（稳定兜底）。与服务端 `ORDER BY c.updated_at DESC` 同口径 |
| 改名 | `renameChatConversation()` **只写 `title`，绝不碰 `updatedAt`**；留空 = `null`（恢复自动命名）。改个名字就把这段顶到最前面，用户会以为"顺序乱了"（服务端为此修过同一个 bug） |
| 新建空对话 | `localChat.emptyConversation(personId)` 找一段一条消息都没有的；`startNewChat()` 复用它，没有才 `createConversation()`。**绝不删除任何历史** |
| 换称呼 | `localChat.renamePerson()` + `saveProfiles()` 同步改显示名；**档案 id 不重算**（已有 id 的人不会因为改名被拆成两份档案） |
| 刷新后停在哪 | `crush-monitor.last-conversation.v1`（`rememberConversation()`）优先；没有记录就用排序后的第一段（最新的那段）。新开的空对话 `updatedAt` 最新，所以刷新会停回它上面 |

守护用例：`tests/local-workspace.test.ts` 的「本机 6/7/8/9/10/22」。注意一个**刻意的取舍**：单独再粘贴一条和之前某条完全相同的消息，指纹落到已存在的第 1 次出现上，于是被跳过（宁可少记，不可重复累计）—— 用例 9 明确断言了这个行为。

---

## 6. 接口一览（本机版只有四个路由 + 一个静态兜底）

约定：没有登录、没有 cookie、没有 `X-Requested-With` 校验、没有同源中间件；错误统一为 `{ "error": "..." }`；响应头固定带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`Cache-Control: no-store`；请求体上限 1MB（超限 413）。

| 方法 | 路径 | 作用 | 限流 |
|---|---|---|---|
| GET | `/api/health` | 健康检查 | 无 |
| POST | `/api/client-error` | 前端错误上报：校验（各字段有长度上限）后**打一行 `[client-error] scope=… msg=… href=… ua=…`**，返回 204。**不要求登录、不做同源校验**（出错时正是"页面都没跑起来"的时候） | 无 |
| POST | `/api/analyze` | 第一层：Jev 逐句情绪/意图/回复评级 | 每 IP 180 次/分钟、全局每小时 3000 次、并发 8 |
| POST | `/api/deep-analysis` | 第二层：DeepSeek 深度解读 | 每 IP 60 次/分钟、并发 2 |

静态：`GET /` 与其它非 `/api/` 路径返回 `dist/` 里的文件，未命中回退 `dist/index.html`（由 `server/static.ts` 的 `registerStatic()` 挂上）。
**`dist/index.html` 不存在时不 404**：所有非 `/api/` 路径返回 **503 + 一段中文提示页**（"先运行 `npm run build`"），启动日志里同时打印 `missingFrontendNotice()`；`/api/*` 完全不受影响。守护用例：「本机 28」。

**`GET /api/health`** 返回（逐字）：

```json
{ "ok": true, "mode": "local", "configured": false, "model": "jev-1.13.0",
  "deep": { "enabled": false, "configured": false, "model": "deepseek-flash", "promptVersion": 3 } }
```

`configured` = 服务端有 `TYPESAFE_API_KEY`；`deep.configured` = 第二层开启 **且** 有 `DEEPSEEK_API_KEY`。**没有 `auth` 字段，没有 `schemaVersion`，没有 `database`**（旧口径里的这些字段已经不存在）。

**`POST /api/analyze`**
- 请求：`server/analysis.ts` 的 `requestSchema`（聊天消息数组 + 长度/形状约束）。消息一律由请求体带来，**服务端没有聊天记录的副本**。
- 未配置 key → `503 {"error":"分析服务尚未配置，请在服务端设置 TYPESAFE_API_KEY"}`；schema 不过 → `400`；限流 → `429`。
- 返回：第一层结果 + `usage`。失败时映射：`401`/`403`/`422`/`429`/`529` 各有中文文案，其它统一 `502`。
- 日志只记 `route/status/latency/tokens`，**不记聊天内容**。

**`POST /api/deep-analysis`** 的输入约束（本机版最容易踩的地方）：

| 字段 | 约束 |
|---|---|
| `messages` | **必须非空**，但**不是**字段级 `.min(1)`，而是对象级 `.refine(v => Boolean(v.messages?.length))`。原因：`.min(1)` 会把「空数组 + 其它合法输入」这种组合直接打成字段错误；空数组本身无害（`server/index.ts` 里按 `data.messages ?? []` 取值），「这次请求到底有没有可分析的内容」统一由对象级判断兜底 |
| `conversationId` | **不需要，schema 里也没有这个字段**（`deepRequestSchema` 是普通 zod object，未声明的键会被丢掉）。前端 `buildDeepRequest()` 生成它只是为了做缓存键和前端关联；服务端另有 `.max()` 上限保护 |
| `relation` | 只能是 `"crush" | "new" | "couple"` |
| `observations` / `memory` | 可选；`memory` 上限 200 条，`observations` 上限 2000 条 |
| `profile` | 可选，浏览器检索出来的 **`ProfileContextBundle`**（`baselineStatus`/`baseline`/`confirmed`/`currentFacts`/`observed`/`inferred`/`habits`/`knownPatterns`/`unresolved`/`corrections`/`estimatedTokens`/`truncated`…）。**只校验结构，不采信里面的数字**：`historicalTrend` 由服务端用 `computeHistoricalTrend()` 重算 |

响应是一个信封：`{ status, analysis, error, model, promptVersion, latencyMs, usage, patternTrend, historicalTrend }`；`status` 取值 `"ok" | "disabled" | "not_configured" | "error" | "timeout"`。未启用 → `200 {status:"disabled"}`；没 key → `503 {status:"not_configured"}`；限流 → `429`；超时 → `504`；其它失败 → `502`。翻译层（UserTranslation）由**前端**用同一份 `shared/translation.ts` 构建，服务端不重复造一套口径。

---

## 7. 改动时必须遵守的硬规则（最重要的一节）

| # | 规则 | 为什么 | 违反了会怎样 |
|---|---|---|---|
| 1 | **LLM 不得计算或改写任何数字**（基线、趋势、delta、模式）。数字只有一个来源：`shared/patterns.ts` / `shared/profile.ts` | 模型自报数字不可校准、不可复算；同一份历史两次调用会给出不同结论 | 用户看到自相矛盾的「她平时怎样」；`pattern-trend.test.ts`/`deep-ui.test.ts` 的「服务端丢弃客户端数字」「DeepSeek 不能覆盖 trend」直接失败；`buildProviderInput` 的重算变成摆设 |
| 2 | **`model_inferred` 永远不能自动升级为 `user_confirmed`**，唯一通道是用户确认（`applyConfirmation`，与 `memory.ts` 的 `applyFeedback`） | 来源等级是「什么能当事实」的唯一闸门；自动升级等于让模型猜测变成事实 | `tests/local-workspace.test.ts`「本机 14」与 `profile.test.ts` 的相关用例失败；系统开始把猜测当事实展示，这是产品层面最严重的越界 |
| 3 | **长期行为模式只由程序统计产生**（`deriveBehaviorPatterns` + `promoteBehaviorPatterns`；门槛：一般模式 `BEHAVIOR_PATTERN_MIN_CONVERSATIONS = 3` 段对话、高风险（约见/一起活动类）`BEHAVIOR_PATTERN_HIGH_RISK_MIN_CONVERSATIONS = 4` 段，且需占该指标样本 `BEHAVIOR_PATTERN_MIN_RATIO = 0.7`）。模型自由文本不得自动成为 `KnownPattern` | 「她平时就是这样」必须是可复算的统计结论 | 模型文本被当成长期事实；`profile.test.ts`「9. 自由文本推断不再自动晋升为长期模式」「9c/9d. 门槛」失败 |
| 4 | **导入 ≠ 分析**：把消息写进本机存储（`ensureRemote` → `localChat.appendMessages`）绝不能触发任何模型调用 | 导入是纯存储行为；用户明确要求「导入不花钱、不自动分析」 | 一次导入偷偷消耗 Jev/DeepSeek 额度；未配置 key 时导入直接报错 |
| 5 | **消息去重指纹只能是 `sender + sentAt + content + 本次导入内该内容的出现次数`**，位置索引**绝不能**进指纹（见 §5.4） | 位置一进指纹，同一批消息换个顺序就变成全新消息 | 重复导入把消息重复入库、基线重复累计；`tests/local-workspace.test.ts`「本机 7/8/9」失败 |
| 6 | **对话 id 必须由 `buildConversationId({ personId, relation })` 推出**，不能换成随机 id、不能把时间戳掺进去 | `commitConversationToProfile` 用对话 id 判断「这段是否已经并入过基线」 | 刷新一次页面就新开一段对话，基线被同一段聊天反复累计；用例「本机 13/22」失败 |
| 7 | **`localStorage` 的键名不得随意改动**；要改就必须同时写迁移（像 `migrateProfilePayload` / `migrateChatPayload` 那样），并且旧的键要能被读出来 | 键名就是用户数据的地址；改了等于把老用户的数据丢掉 | 用户升级后档案/聊天全空；且没有服务端备份可以恢复 |
| 8 | **所有从存储读回来的东西都必须走防御式校验**（`validateProfile` / `migrateProfilePayload` / `parseMemory` / `memoryViolations` / `migrateChatPayload`），不许相信存储里的来源等级与统计数字；`feedbackStats` 必须重算 | localStorage 是用户可以手改的、损坏的、跨版本留下的 | 手改一个 `sourceType: "user_confirmed"` 就能让模型猜测变成事实；应用可能整页打不开 |
| 9 | **日志不得含聊天正文、API key**；前端 bundle 不得含任何密钥 | 日志是纯文本、会被 tail 与归档；bundle 任何人都能下载 | 隐私泄露；`tests/deep-ui.test.ts` 与 `tests/local-workspace.test.ts`「本机 23」失败（后者同时扫 `src/*.ts(x)` 与 `dist/assets/*.js`，查找 `DEEPSEEK_API_KEY`/`TYPESAFE_API_KEY`/`process.env.DEEPSEEK`/`process.env.TYPESAFE` 以及 `sk-…`/`apikey_…` 形态的密钥） |
| 10 | **测试不得真实调用 DeepSeek 或 Jev**（`tests/` 里一行真实模型网络调用都不许有），也不许 import `server/index.ts` | 测试要能离线、免费、可重复地跑；`index.ts` 导入即 `app.listen`，会给测试留一个关不掉的监听 | `npm test` 会花额度、会因网络抖动变红；测试进程挂住不退出。这就是 `server/deep-schema.ts` 被单独拆出来的唯一原因 |
| 11 | **`src/useProfile.ts` 是遗留模块**。新代码不要用它写长期数据，用 `src/useWorkspace.ts`（或它下面的 `src/local-ops.ts`） | 两套写法会把同一份档案写出两种口径 | 档案数字对不上；`useProfile` 里那套 `createProfileStore` 与 `useWorkspace` 的编排会逐渐分叉 |
| 12 | **不要改**：Jev rubric / 模型、DeepSeek 安全 prompt 的语义、`server/ai/boundary.ts` 的核心逻辑、Pattern 数学定义、baseline 数学定义、`RelationshipContext` 语义、`UserCorrection` 语义 | 这些都是被测试与文档逐条守护的口径 | 分析结论前后不可比；`pattern-trend.test.ts`/`profile.test.ts`/`stabilize.test.ts` 大面积失败 |
| 13 | **媒体占位符补充的描述必须标成「用户手动转述，不是原始文字」**（`mediaPromptText()` 的输出前缀），没补描述的媒体消息仍然跳过、且不计入统计口径 | 转述不是原话；把转述当原话会让模型读出根本不存在的语气 | 模型把「[图片]」当成对方打的字；`media.test.ts` 与「本机 11」失败 |
| 14 | **长期数据与聊天记录的读写只走 `src/useWorkspace.ts` / `src/local-ops.ts` / `src/storage.ts` 这条链**，界面层不要自己 `localStorage.setItem` | 校验、迁移、反馈统计重算都在这条链上 | 绕过校验的数据会带着非法来源等级进来（见规则 8） |
| 15 | **第二层 prompt 语义与 `DEEP_ANALYSIS_PROMPT_VERSION`（当前 3）不得改动**；确需改 prompt 时必须同时递增版本号 | prompt 语义变了而版本号没变，前端会错误复用旧缓存 | 用户看到旧 prompt 的解读配着新模型的标签；`deep.test.ts` 的缓存键用例失败 |
| 16 | **`src/` 与 `shared/` 里不得直接出现 `crypto.randomUUID()` / `crypto.subtle`**，一律走 `shared/hash.ts` 的 `randomId()` / `sha256Hex()` | 这两个 API 只在安全上下文（HTTPS / localhost）存在；明文 HTTP + 局域网 IP 下调用即抛，异常被吞掉就是「点了没反应」。哈希还必须与 `node:crypto` 逐字节一致，否则前端会报「分析上下文不匹配」 | 局域网访问的用户整条分析链路失效；`tests/insecure-context.test.ts` 失败 |
| 17 | **「开始新对话（保留历史）」绝不删数据**：只能新建或复用一段空对话；`renameConversation` 只写 `title`、**不得动 `updatedAt`**；所有保存失败必须抛出带原因的 Error（不许静默 `return null` / `return false`） | 用户明确要求不许删历史；改个名字把顺序打乱会被当成 bug；静默失败使用户以为数据存好了 | 历史被毁 / 列表顺序乱跳 / 用户数据丢失且毫不知情。守护用例：「本机 29–33」 |

---

## 8. 常见修改任务的索引

| 我想改 X | 看这些文件 | 注意什么 |
|---|---|---|
| 调整指标或阈值 | `shared/patterns.ts`（`METRIC_DEFINITIONS`、会话切分与趋势阈值）、`shared/types.ts`（`SESSION_GAP_MINUTES = 30`、`BEHAVIOR_PATTERN_*`、`BASELINE_VERSION`、`DECAY_BUCKETS`/`DECAY_MIN_WEIGHT`、`RETRIEVAL_TOKEN_BUDGET = 1200`/`RETRIEVAL_LIMITS`、`MAX_ACTIVITY_EVENTS = 200`） | 先跑 `pattern-trend.test.ts`；改 baseline 数学必须递增 `BASELINE_VERSION`；遵守规则 1、12 |
| 改第一层 prompt | `server/analysis.ts`（`buildRequest`）、`shared/labels.ts`、`shared/intents.ts`、`shared/types.ts` 的 `RUBRIC` | 改 `RUBRIC` 会让 `contextKey` 变化（缓存失效）；`tests/core.test.ts` 会断言请求形状 |
| 改第二层 prompt | `server/ai/deepseek.ts`（`DEEP_ANALYSIS_INSTRUCTIONS`、`DEEP_ANALYSIS_SCHEMA`） | **必须递增 `DEEP_ANALYSIS_PROMPT_VERSION`**（规则 15），否则旧缓存被错误复用；同时更新 `.env`（若显式设置过）；`tests/deep.test.ts` 会核对缓存键与拒绝路径 |
| 改解读边界规则 | `server/ai/boundary.ts`（`FATAL_RULES`/`FIELD_RULES`/`SOFTEN_RULES`/`MIND_READING_THRESHOLD = 3`） | 规则 12：核心逻辑默认不改；改规则要动 `tests/stabilize.test.ts` 与 `shared/diagnostics.ts` 的类别统计；违规**类别**（`BoundaryViolationCode`）只能记 code，不能记原文 |
| 改 UserTranslation 文案 | `shared/translation.ts`（`buildTranslation`/`findImperative`）、`src/DeepPanel.tsx` | 命令式建议必须被 `findImperative` 过滤；「互动降温 + 明确外部原因」不得直接写成关系变差；`tests/deep-ui.test.ts`「翻译层不含百分比、命令式建议被过滤」 |
| 加一个新的长期模式 | `shared/profile.ts`（`BEHAVIOR_RULES`/`EVENT_RULES` → `deriveBehaviorPatterns` → `promoteBehaviorPatterns`）、必要时 `shared/events.ts` | 规则 3：只能来自程序统计；高风险模式要 `highRisk: true`（门槛 4 段）；措辞不得涉及人格或感情；`tests/profile.test.ts` |
| 改前端界面 | `src/App.tsx` + 对应 `*.css`；深度解读 `DeepPanel.tsx`，长期观察 `LongTermPanel.tsx`（**没有登录页了**） | 长期数据一律经 `src/useWorkspace.ts`，不要新开 localStorage 键（规则 7、14） |
| 改一个接口 | `server/index.ts`（路由）+ `server/deep-schema.ts`（第二层 schema）；前端在 `src/useDeepAnalysis.ts` / `src/useAnalysis.ts` 里对应改 | 能抽成纯 schema 的就别塞进 `index.ts`（测试 import 不了它，见规则 10）；加跨端形状时同步 `shared/types.ts`；日志别带正文 |
| 改存储里存什么 | `src/storage.ts` 的解析函数 + `shared/types.ts` | 必须同时写防御式解析与迁移（规则 7、8）；在 `tests/local-workspace.test.ts` 补往返用例 |
| 改保存失败的表现 | `src/storage.ts`（`writeStrict`/`saveChatStrict`/`LocalStorageError`）、`src/local-ops.ts`（`writeProfileOp`）、`src/useWorkspace.ts`（`ensureRemote`/`runOp`）、`src/App.tsx`（`reportProblem`） | 规则 17：**不许静默失败**（返回 `null` / `false` 就走回老路了）；错误文案要说清"为什么 + 怎么办"。用例「本机 33」 |
| 改导入去重规则 | `src/storage.ts` 的 `fingerprintSeed()` / `localChat.appendMessages()` | 规则 5：位置索引绝不进指纹；`tests/local-workspace.test.ts` 的「本机 6–10」是最直接的断言点 |
| 改媒体处理 | `shared/media.ts`（`parseMediaMarker`/`hasMediaDescription`/`mediaPromptText`）、`src/useWorkspace.ts` 的 `toImportPayload` | 规则 13；`tests/media.test.ts` + 「本机 11」 |
| 换一台电脑 / 重装 | 没有迁移工具 —— 只能手工拷浏览器数据或重新导入（见 §11） | 这就是本机版最大的结构性代价，见 §10 |
| 改「历史对话 / 新对话 / 改名」 | `src/App.tsx`（`parseStamp`/`stampOf`/`conversationName` + `historyOpen` 面板 + `openHistory`/`removeHistory`/`renameHistory`/`savePersonName`）、`src/useWorkspace.ts`（`startNewChat`/`openConversation`/`refreshConversations`/`renameConversation`/`renamePerson`/`conversationsOf`）、`src/storage.ts`（`sortConversations`/`conversationPreview`/`lastMessageAtOf`/`renameChatConversation`/`renameChatPerson`/`emptyConversation`） | 规则 17：不许删历史、改名不许动 `updatedAt`；时间必须显式解析微信中文格式且**不截断**（`parseStamp`）；序号 + 时间缺一不可。用例「本机 29–32」 |
| 改「出错可见 / 上报」 | `src/App.tsx`（`problem` 状态 + `reportProblem` + 全局 `error`/`unhandledrejection`）、`src/clientLog.ts`、`server/index.ts` 的 `/api/client-error` | **上报体里绝不能加聊天内容或密钥**；只有错误文本 / 路径 / UA。用例「本机 24」（入口里该有的路由还在） |
| 改「没构建前端时的提示」 | `server/static.ts`（`missingFrontendNotice` / `missingFrontendPage` / `registerStatic`）+ `server/index.ts` 的启动日志 | 提示文案里必须留着 `npm run build` 这几个字（测试断言它）；别让它挡住 `/api/*`。用例「本机 28」 |

---

## 9. 开发与测试工作流

```bash
npm run dev                 # 本地开发：前端 :5178、后端 :3178，/api 由 vite 代理
npm run build && npm start  # 只起后端：用 dist/ 里的已构建前端
npm test                    # 全部测试：离线、不花额度、不写任何真实数据
```

- 实测结果（本机 `npm test` 实跑）：**`tests 229` / `suites 0` / `pass 229` / `fail 0` / `cancelled 0` / `skipped 0` / `todo 0`，退出码 0。**
- `dev` 与 `start` 的区别：`dev` 用 `tsx watch` 热重启后端 + Vite dev server（HMR）；`start` 跑一次后端进程并提供 `dist/` 静态文件，是本机日常使用的方式。
- `build` = `tsc --noEmit`（**类型错误会让构建失败**）`&& node scripts/build-guide.mjs && vite build`。改完代码至少要跑一次 `npm run build`。
- 本机版**没有**部署环节（详见 §10）。

真实模型检查：

```bash
npm run check:live   # 用 shared/fixtures.ts 的 exampleText(0) 真调一次 Jev，打印 model/latency/usage/overview
```

- 会**消耗你自己的 TypeSafe 额度**，需要 `.env` 里有 `TYPESAFE_API_KEY`。
- 它只覆盖第一层；第二层（DeepSeek）没有对应的 live 脚本（`DEEP_ANALYSIS_ENABLED=true` 后可在界面里验证）。

**不调用真实模型也能验证的做法**（新测试请照抄这套）：

| 场景 | 做法 |
|---|---|
| 第二层 provider | 依赖注入假 `fetch`：`createDeepSeekProvider(config, { fetch: mock.fn })`，`mock` 返回构造好的 Responses API 信封（见 `tests/deep.test.ts`、`tests/normalize.test.ts`、`tests/pattern-trend.test.ts`） |
| 前端深度解读 controller | `createDeepController({ fetch, fetchHealth, now })` 注入假 fetch 与假时钟（见 `tests/deep-ui.test.ts`、`tests/stabilize.test.ts`） |
| 档案 / 存储 / 本机工作区 | 注入式假 `StorageLike`（一个 `Map` 实现），直接驱动 `localChat`、`local-ops` 与 `shared/profile-ops` 的纯函数，**不用起浏览器也不起服务端**（见 `tests/local-workspace.test.ts`、`tests/profile.test.ts`） |
| 第二层请求契约 | 直接 import `server/deep-schema.ts` 的 `deepRequestSchema` 做 `safeParse` 断言（**不要** import `server/index.ts`，它有 `app.listen` 副作用） |
| 密钥不外泄 | 已有守卫：`tests/local-workspace.test.ts`「本机 23」扫 `src/*.ts(x)` 与 `dist/assets/*.js`（`dist` 不存在时跳过）；`tests/deep-ui.test.ts` 另有一道。**改前端时别把密钥名写进 `src/`**（另见 §11 的道具缺口） |

加测试的规矩（建议）：

1. 纯函数/规则改动 → 加进对应的 `tests/*.test.ts`，不要新建文件凑数；本机存储与工作区相关的改动加进 `tests/local-workspace.test.ts`；
2. 涉及「不许发生的事」（不写日志、不外泄密钥、不重复累计、不自动升级来源、不留服务端持久化）→ **必须有断言**，这类回归最贵；
3. 任何测试都不许打真实模型域名，不许 import `server/index.ts`；
4. 断言尽量对着**用户可见字符串**（文案、标签）而不是内部字段名，避免重构就红一片。

---

## 10. 本机版怎么用、怎么升级（没有部署）

本机版的「上线」就是两句话：

```bash
npm install          # 依赖（本机只需要 Node）
npm run build        # 生成 dist/
npm start            # 打开 http://127.0.0.1:3178
```

- 只在开发时用 `npm run dev`（HMR）。
- `.env` 不做版本控制（`.env.example` 是模板，`npm run setup` 会复制）。密钥只在这台电脑上。
- 想让同一局域网里的手机/平板也能打开：把 `.env` 的 `HOST` 改成 `0.0.0.0`。**这会把这个无认证的服务暴露给同网段**（见 §11）。
- 升级代码：直接替换代码目录 → `npm install` → `npm run build` → 重启 `npm start`。**升级前请先备份浏览器数据**（本机版没有服务端备份，见 §11）。
- 旧文档里的服务器/systemd/反向代理/`npm run db:backup` 那一套在本机版**不适用**，不要把那些步骤套过来。

---

## 11. 已知风险与待办（读代码与日志得出，**未验证的行为不写进来**）

| 项 | 状态与说明 |
|---|---|
| **localStorage 容量上限与清理策略** | 已验证（静态）：`src/storage.ts` 只依赖 `localStorage`，没有任何体积控制。聊天记录会随每次导入无上限增长，档案里的 `memories`/`habits`（各 64 条上限）/`knownPatterns`（64 条）/`activityEvents`（`MAX_ACTIVITY_EVENTS = 200`）有上限，但**聊天消息没有任何上限**。浏览器配额（通常 5MB 量级）满了以后 `localStorage.setItem` 会抛异常。**这一版已经不再静默**：`writeStrict()` / `saveChatStrict()` / `writeProfileOp()` 会抛出 `LocalStorageError`，界面顶部的红条直接写出原因与办法（「本机存储已满…先删掉不用的聊天记录再试」），守护用例「本机 33」。**仍未做**：容量提示、一键导出/导入、自动截断策略 —— 也就是"快满了"目前只能等它写失败才知道 |
| **数据只在浏览器里：清浏览器数据即永久丢失** | 已验证（静态）：全部长期数据与聊天记录都在 `localStorage`，没有导出/导入功能（`clearLongTerm`/`clearLocalChat` 只有删、没有备份）。清理浏览器数据、换浏览器、用隐私模式、重装系统 = 数据没了，**没有任何恢复路径**。也没有「换电脑怎么带走数据」的工具 |
| **单机无并发保护** | 已验证（静态）：`useWorkspace` 的 `version` 恒 `0`、`conflict` 恒 `""`，没有乐观锁。同一个浏览器里开两个标签页分别改档案时，后写的那次会整体覆盖 key（`saveProfiles` 全量覆盖），**没有冲突检测**。单人使用一般碰不到，但这不是「不会发生」 |
| **HTTP 明文 + 局域网 IP（历史上真的炸过）** | 已验证：服务端起在 `http://127.0.0.1:3178`（或 `HOST=0.0.0.0`），纯 HTTP、无 TLS、无认证。两件事要分开看：① 绑 `127.0.0.1` 时只有本机能访问；改成 `0.0.0.0` 后**同网段任何人都能打开并看到全部聊天记录与档案**（没有任何登录）。② 用「局域网 / 公网 IP + 明文 HTTP」打开页面时，浏览器不把它当安全上下文，`crypto.randomUUID` 与 `crypto.subtle` **会不存在** —— 这正是「点开始分析没反应」的真实事故原因（异常被吞、界面一片安静）。②已修：`shared/hash.ts` 兜底 + `tests/insecure-context.test.ts`；①仍然只是建议（文档里已写明**别用局域网 IP 当日常入口**，但没有代码强制） |
| **没有账号：看得到这台电脑浏览器的人就看得到全部数据** | 已验证（静态）：没有登录、没有加密，数据是明文 JSON 存在浏览器存储里。任何能用这台电脑的人（同事、家人、共用账号）打开浏览器就能读 `crush-monitor.*`。这不是缺陷，是本机版的定位；但接手者必须知道，并在做「分享/截图/同步」类需求前想清楚 |
| **`dist/assets` 与 `DEEP_ANALYSIS_DEFAULT_BASE_URL`** | 已验证（实测）：`shared/types.ts` 里存在常量 `DEEP_ANALYSIS_DEFAULT_BASE_URL = "https://api.deepseek.com"`，它被 `server/ai/deepseek.ts` 引用。我**实测扫了当前产物** `dist/assets/index-Di41wxDV.js`（357.02 kB）：`api.deepseek.com` 出现 **0 次**，`DEEPSEEK_API_KEY`/`TYPESAFE_API_KEY` 各 **0 次**（这个常量经 tree-shaking 没有进 bundle）。**风险仍然真实**：只要哪天在 `src/` 里 import 了它（或 dev 构建不做 tree-shaking 时），默认域名就会进 bundle；而现有的「无密钥」守卫用例**只查密钥形态，不查域名**，所以这类回归不会被测试拦住。**建议**：给守卫加一条「bundle 里不得出现 `api.deepseek.com`」的断言，或把这个默认值搬到 `server/` 侧 |
| **`test` / `serve` 的端口冲突** | 已验证（静态）：`vite.config.ts` 是 `strictPort`（5178），服务端默认 3178。`npm run dev` 之外的第二个实例、或另一个占用 5178/3178 的程序，会让启动直接失败；`test` 本身不监听端口（假 fetch + 注入式存储），不冲突。**建议**：多开时用 `PORT` 环境变量错开 |
| **`src/DeepPanel.tsx` 的解读反馈文案** | 已验证（实读代码，`src/DeepPanel.tsx:231`）：文案已经改成「反馈只保存在这台电脑的浏览器里（不上传任何服务器）」——与 `recordInterpretationFeedback()` 只写 `crush-monitor.deep-feedback.v1` 一致，**这条旧口径已经修掉了** |
| **`dist/` 缺失时的第一印象** | 已验证（实跑测试「本机 28」+ 实读 `server/static.ts`）：`npm start` 而没 `npm run build` 时，终端打印中文提示、页面返回 503 + 一段"先运行 npm run build"的说明页，`/api/*` 正常。**仍未做**：自动触发构建（有意不做，构建会引一堆副作用） |
| **`reply_latency` 只统计 30 分钟内的回复** | 已验证：`patterns.ts` 里 `gap <= 0 || gap > CONVERSATION_GAP_MS`（`SESSION_GAP_MINUTES = 30`）被跳过，跨天/隔夜不算「回复慢」。这是刻意的，不是 bug；改它会让基线口径变化，必须递增 `BASELINE_VERSION` |
| **模型推断晋升门槛在实际数据下很少触发** | 已验证（保守设计）：`model_inferred` 永不自动升级（规则 2）；`deterministic` 模式需 3 段（高风险 4 段）**不同对话**支持，且要占该指标样本 ≥ 0.7。真实用户攒不够对话段数，长期面板常常显示「样本不足」。这是设计取向，不是缺陷；若想放宽，必须同时接受误报代价 |
| **`src/useProfile.ts` 是遗留模块** | 已验证（实读）：`App.tsx` 仍 import `conversationIdFor`/`historyForSession`/`profileUiState`，`LongTermPanel.tsx` import `coldStartNotice`，`tests/profile.test.ts` import `createProfileStore`；最外层的 `useProfile()` hook 目前没有调用点。**建议**：把三个 UI 辅助函数搬到 `local-ops.ts` 或独立小文件后再删这个模块，否则它会一直和 `useWorkspace` 并存 |
| **旧文档滞后** | 已处理：`docs/DEPLOYMENT.md` 已改写成本机版口径（dist 缺失兜底、历史对话与改名、存储写失败、非安全上下文、四个路由表），本文 §3.2/§3.3/§5/§6/§7/§9/§11 也已同步。`docs/ARCHITECTURE.md` 仍是旧口径（服务端持久化那一版），**本次没有逐字核对**，读它之前先读本文 |
| **其它** | 不做 WebSocket 推送、不做 CRDT 自动合并、不开放注册、不拆微服务、不用 Docker；`targetId` 目标消息级解读目前恒为 `null` |

---

## 12. 一句话交接

这个项目最不能碰的三件事：**① 数字的唯一来源**（基线/趋势/delta/模式只能来自 `shared/patterns.ts` 与 `shared/profile.ts`，LLM 只准解释）；**② 来源等级的闸门**（`model_inferred` 永不自动升级为 `user_confirmed`，长期模式只由程序统计或用户确认产生）；**③ 本机数据的地址与校验**（长期数据只住在浏览器 `localStorage` 的那几把 key 里，读写必须经过 `src/storage.ts` 的防御式校验与迁移，消息指纹里绝不带位置索引 —— 服务端永远不落盘）。
其余的改动（文案、界面、存储结构 + 迁移、接口、限流参数）都可以做，但每次都要跑 `npm test`（229 个用例）并至少跑一次 `npm run build`；改存储结构时，记得同时写迁移用例与「清空浏览器数据就没了」的提示。

补一条同样重要的：**这个项目要让陌生人"第一次就能跑起来"** —— `npm start` 而没 `npm run build` 时页面与日志都要说清下一步（§6），任何"点了没反应"都要在界面上有红条、在终端里有 `[client-error]` 一行（§7 规则 17）。
