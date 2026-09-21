# 架构：双层分析系统

> **当前发布的形态是「本机单机版」（local-first）。**
> 长期数据与聊天记录都在浏览器 `localStorage`，服务端只有 `/api/health`、`/api/analyze`、
> `/api/deep-analysis` 三个接口加静态托管——没有账号、没有 session、没有数据库。
> 本文里凡提到「第四阶段」「服务端 SQLite」「多账号 / `user_id`」「session / CSRF」的段落，
> 都是**被本机版取代的历史描述**，只保留作为设计沿革的记录；
> 当前生效的数据层是 `src/storage.ts`（localStorage）+ `src/local-ops.ts`（无 React 编排层）
> + `src/useWorkspace.ts`（React 包装）。本机运行与排障见 `docs/DEPLOYMENT.md`。

## 一句话概括

**Jev 负责观察，DeepSeek 负责解释，程序负责统计，Memory 负责长期连续性，用户负责最终判断。**

这五条职责边界是整个系统最重要的约束，任何时候都不应互相越界。

## 数据流

```
Evidence ──▶ Observation ──▶ Interpretation ──▶ User Translation
   │              │                  ▲                 ▲
   │              │                  │                 │
   │              └──────┐           │                 │
   │                     ▼           │                 │
   └──────────────▶ Pattern ─────────┘                 │
                         │                             │
                         ▼                             │
                      Memory ──────────────────────────┘
                         ▲
                         │
                   UserFeedback（唯一能提升来源等级的力量）
```

每一层的定义与边界：

| 层 | 是什么 | 由谁产生 | 关键约束 |
|---|---|---|---|
| **Evidence** | 原始聊天消息、时间戳 | 用户粘贴 | 唯一的事实来源 |
| **Observation** | 单条消息的情绪/意图分布、表达质量分 | Jev（第一层） | 保留原始概率，不被上层改写 |
| **Interpretation** | 上下文层面的解读、多种可能、转折、矛盾 | DeepSeek（第二层） | 只能是解释，不能是事实；不得输出概率数字 |
| **Pattern** | 主动发起比例、回复延迟、情绪漂移等统计量 | 程序（纯函数） | LLM 不得计算或伪造这些数字 |
| **Memory** | 跨会话长期记忆 | 观察 / 模型推断 / 用户确认 | `model_inferred` 永不自动升级 |
| **UserTranslation** | 给用户看的六个部分 | 程序组装 + 过滤 | 严禁写成命令式关系建议 |

## 文件职责

> 下面是**第一到第三阶段**的文件树。第四阶段新增的服务端与前端文件
> （`server/db.ts`、`server/auth.ts`、`server/routes.ts`、`shared/profile-ops.ts`、
> `shared/facts.ts`、`shared/events.ts`、`shared/media.ts`、`shared/retrieval.ts`、
> `src/api.ts`、`src/useAuth.ts`、`src/useWorkspace.ts`、`src/LoginPage.tsx` 等）
> 见下文「第四阶段」一节的**文件职责**表。

```
shared/
  types.ts        全部类型、常量、contextKey / deepContextKey
  labels.ts       12 类情绪（第一层）
  intents.ts      35 类意图（第一层）
  rules.ts        第一层阈值判定：信息不足 / 有歧义 / 边界优先
  parser.ts       微信记录解析、合并、长度约束
  ratings.ts      回复评级
  patterns.ts     ★ 确定性统计引擎，第二层数字的唯一来源
  memory.ts       ★ 上下文窗口、相关记忆、来源等级不变量
  translation.ts  ★ UserTranslation 组装与命令式措辞过滤

server/
  analysis.ts     第一层实现（buildRequest + Jev 调用），未被改写
  index.ts        Express；/api/analyze 与 /api/deep-analysis 完全隔离
  ai/
    types.ts      Provider 接口、InterpretationOutcome、DeepAnalysisError
    jev.ts        第一层 provider，只是接口适配
    boundary.ts   ★ Interpretation Boundary：三级策略
    input.ts      ★ buildProviderInput：patterns 服务端重算的唯一入口
    deepseek.ts   ★ 第二层 provider：prompt、JSON Schema、安全重试、校验
    index.ts      Provider 注册表

src/
  useAnalysis.ts    第一层调度、缓存、并发
  useDeepAnalysis.ts ★ 第二层 controller + React 包装
  DeepPanel.tsx     ★ UserTranslation 七部分（含 comparedToUsual）+ 反馈 + 证据定位
  deep.css          ★ 深度解读样式（独立文件）
  storage.ts        ★ local-first 存储：长期记忆 + 解读反馈
  App.tsx           界面

docs/ARCHITECTURE.md  本文
```

## 为什么第一层必须独立

第一层和第二层是**两种不同的任务**：

- 第一层是**判断题**：给定一条消息，从固定候选里选，返回概率与把握。
  这类任务需要校准过的分布，Jev 的结构化判断正合适。
- 第二层是**解释题**：给定上下文，说明可能发生了什么、还有什么可能、哪里还不确定。
  这类任务需要语言能力，且必须允许说"不知道"。

如果把两层合成一次调用，解释会污染观察：模型倾向于让自己后面的解释和前面的判断自洽，
而且第一层可校准的概率会被生成式模型的自报数字替换。

所以：**第二层不得覆盖第一层，第一层不得写解释。**

## 关键不变量

由代码强制，并由测试守护：

1. **不做读心术**：prompt 明确禁止假定线下关系、附件内容、性别、历史
2. **可能性与事实分开**：`LatentReading.reading` 使用「可能」措辞；`Evidence` 只放原文
3. **第二层不覆盖第一层**：`Observation` 原样透传；第二层没有概率字段
4. **不伪造概率**：`findPseudoPrecision()` 扫描输出，命中即按致命违规处理
5. **单条消息不决定长期判断**：长期结论只能建立在 `patterns` 与 `memory` 上
6. **趋势数字由程序算**：`computePatterns()` 是纯函数，服务端重算，忽略客户端传入值
7. **好感分数不是唯一核心**：`DeepAnalysis` 没有好感概率字段
8. **帮助用户学会识别**：`whatYouMightMiss` 与 `whatToWatchNext` 提供观察方向，不替用户决策
9. **隐私**：日志只含 model / latency / status / 边界计数，绝不含聊天文本或违规原文
10. **local-first**：记忆与反馈存在浏览器 `localStorage`。中间有过一段「服务端 SQLite 持久化 + 多账号」的形态（见「第四阶段」），**发布版已经退回到本机单机**：长期数据（档案 / 基线 / 记忆 / 习惯 / 反馈）与聊天记录的真相源都在浏览器里，服务端只在单次分析时接收这次要用的片段，用完即弃、不落盘。

## 缓存身份：model + promptVersion

第二层的缓存键（`deepContextKey`）包含：

```
model + promptVersion + relation + analysisMode + 消息内容 + 相关记忆 + 第一层观察
```

其中 **model 与 promptVersion 必须来自服务端实际身份，不能是前端硬编码常量**。

流程：

1. 前端启动时读 `/api/health` 的 `deep.model` / `deep.promptVersion`
2. 用服务端报告的实际身份计算 `contextKey`
3. 写入缓存前**再次校验**：`response.model` 与 `response.promptVersion` 必须与当前身份一致
4. 不一致 → 不写缓存（结果仍展示，但下次点击会重新请求）
5. 服务端换模型 → `contextKey` 变化 → 旧缓存自然失效

这条链路防止的场景：服务端把 `DEEP_ANALYSIS_MODEL` 换成别的模型后，
前端仍拿旧模型的解读当新结果复用。

## stale result 行为

**"输入变化" 与 "清空展示" 是两件事。**

| 事件 | 行为 |
|---|---|
| 输入变化（消息/关系/第一层结果/记忆/身份） | 取消在途请求；当前结果标记 `isStale=true`；**不清空展示**；**不自动重跑** |
| 用户再次点击「深度解读」 | 发起新请求 |
| 新请求成功 | 替换旧结果，`isStale=false` |
| 新请求失败 | 旧结果**保留可查看**，`isStale` 维持原值 |

UI 在 `isStale` 时显示一行轻量提示：「聊天内容已变化，这份解读基于较早的上下文。」

这样用户正在阅读解读时，即使第一层重新分析，也不会看到内容突然消失。

## Interpretation Boundary 三级策略

**优先在 prompt 阶段避免**（`DEEP_ANALYSIS_INSTRUCTIONS` 第 9–13 条），程序层是兜底。

| 级别 | 情况 | 处理 |
|---|---|---|
| **Level 1** | 可安全软化的读心断言（「她就是…」「她其实…」「她一定…」） | 就地改写为可能语气，字段名记入 `softenedFields` |
| **Level 2** | 单字段违规（如某字段用单条消息推断长期关系） | **只移除该字段**（置空/过滤），其余字段照常返回，记入 `removedFields` |
| **Level 3** | 致命违规，或核心结构不可用 | **自动安全重试一次**，重试 prompt 明确要求只基于可观察证据；仍失败则整份拒绝 |

**仍然整份拒绝（致命）的情况**：

- 明确操纵、欺骗、胁迫对方的建议
- 明确精神疾病 / 人格障碍诊断
- 明确伪精确喜欢概率作为核心结论
- 明显性别刻板推断
- 大量内容都依赖「知道对方内心」的断言（达到 `MIND_READING_THRESHOLD`）

**重试上限恒为 1**（`MAX_BOUNDARY_RETRIES`），无论哪条路径都不会超过 2 次调用。
传输层错误（超时 / 网络 / HTTP）**不重试** —— 那是连接问题，换 prompt 没有意义。

处理痕迹记录在 `DeepAnalysis.boundary`：

```ts
{ softenedFields: string[]; removedFields: string[]; retried: boolean }
```

只含字段名与布尔值，供调试与透明度使用；前端普通模式不展示技术细节。

## 隐私边界

| 项 | 约定 |
|---|---|
| API key | 只在服务端 `.env`；前端源码零出现 |
| 前端请求目标 | 只调相对路径 `/api/deep-analysis`；`/api/health` 只回状态与身份 |
| 服务端日志 | `model / latency / status / code` + 边界**计数**，不含聊天文本与违规原文 |
| 错误信息 | 只带违规**类别**，不带违规原文 |
| 触发时机 | 只有用户点击才发请求 |
| DeepSeek 侧 | Responses API 恒为 `store: false` |
| 本地存储 | 记忆与反馈只存在浏览器 |

## 接口

### `POST /api/deep-analysis`

```jsonc
// 请求（patterns 由服务端重算，传入值被忽略）
{
  "revision": 1,
  "relation": "crush",
  "targetId": null,
  "messages": [ /* 最多 120 条 */ ],
  "observations": [ /* Jev 原始输出 */ ],
  "memory": [ /* 相关长期记忆 */ ]
}

// 响应
{
  "status": "ok",       // ok | disabled | not_configured | insufficient_context | error
  "analysis": { /* DeepAnalysis，含可选 boundary 元数据 */ },
  "error": null,
  "model": "deepseek-flash",
  "promptVersion": 3,
  "latencyMs": 1234,
  "usage": { "input_tokens": 1200, "output_tokens": 300 }
}
```

| 情况 | HTTP | status |
|---|---|---|
| 未启用（默认） | 200 | `disabled` |
| 缺 `DEEPSEEK_API_KEY` | 503 | `not_configured` |
| 超时 | 504 | `error` |
| 上游错误 | 502 | `error` |
| 输出不合法 / 越过边界（含重试后） | 502 | `error` |

**任何情况下 `/api/analyze` 都不受影响**：两条路由各自校验、各自限流、各自处理错误。

### `GET /api/health`

```jsonc
{
  "configured": true,
  "model": "jev-1.13.0",
  "deep": { "enabled": false, "configured": false, "model": "deepseek-flash", "promptVersion": 1 }
}
```

## 配置

```dotenv
TYPESAFE_API_KEY=           # 第一层，必需
DEEP_ANALYSIS_ENABLED=false # 第二层总开关，默认关闭
DEEP_ANALYSIS_MODEL=deepseek-flash
DEEP_ANALYSIS_PROMPT_VERSION=3   # 改动 prompt 语义时必须递增；代码默认值见 shared/types.ts
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DATA_DIR=                    # 可选；默认 <cwd>/data，生产建议写绝对路径
COOKIE_SECURE=false          # 上 HTTPS 后必须改 true
TRUST_PROXY=false            # 放在 nginx 后面时改 true，否则限速拿不到真实 IP
DEEP_ANALYSIS_TIMEOUT_MS=45000
```

第二层走 DeepSeek 官方 Responses API 的 `text.format` JSON Schema 结构化输出，
不引入任何模型 SDK —— 只用内置 `fetch`。

## Pattern Engine：指标定义与前后对比

所有指标都是**确定性纯函数**：不读当前时间、不用随机数，同输入必定同输出。

### 计算方式

```
按时间排序（全部消息都有可解析时间戳时）
   ↓
前半段 = baseline，后半段 = current
   ↓
每个指标在两段上分别计算 → delta = current - baseline
```

任一半段样本不足时，该指标 `sufficient = false`，且 `baseline / delta` 都为 `null`。

### 硬约定：counterpart-only

除 `initiation_ratio` 与 `continuation_rate` 需要看整个消息序列外，
**所有指标只统计对方（counterpart）的行为** ——
不会因为用户问得多，就把对方的提问密度拉高。

### 指标定义表

| 指标 | 定义 | 方向 | 量纲 | 每半段最小样本 |
|---|---|---|---|---|
| `initiation_ratio` | 由对方开启的对话轮次 ÷ 总轮次（间隔 >30 分钟视为新一轮） | 越大越上升 | 绝对 | 2 轮 |
| `reply_latency` | 对方回复我方的平均延迟（分钟），只统计 self→other 的相邻切换 | **越大越下降** | 相对 | 2 次 |
| `reply_length` | 对方消息的平均字数 | 越大越上升 | 相对 | 2 条 |
| `question_density` | 对方消息中含问号或句尾「吗/呢」的比例 | 越大越上升 | 绝对 | 2 条 |
| `continuation_rate` | 对方发言（排除最后一条）之后紧跟我方消息的比例 | 越大越上升 | 绝对 | 2 条 |
| `closing_ratio` | 对方消息中最高概率意图为 `close` 的比例 | **越大越下降** | 绝对 | 2 条 |
| `emotion_drift` | 对方正负情绪净值（正向占比 − 负向占比，**可以为负**） | 越大越上升 | 绝对 | 有观察即可 |
| `intent_drift` | 对方主动靠近类意图占比 | 越大越上升 | 相对 | 有观察即可 |
| `event_volume` | 对方消息条数 | 越大越上升 | 相对 | 1 条 |
| `baseline_delta` | 相对前一段发生明显变化的指标数量 | 聚合（本身不再套 baseline） | — | 有可比指标 |

### 归一化

跨指标比较时把 delta 归一到 `-1..1`，再乘方向系数：

- `absolute`：`clamp(delta, -1, 1)`
- `relative`：`clamp(delta / |baseline|, -1, 1)`（baseline 为 0 时按符号取 ±1）
- 乘以 `orientation`（+1 / −1）得到「指向互动投入上升」的有符号分数

## PatternTrend：互动投入趋势

**由程序计算，不是感情趋势。**

```ts
type PatternTrend = {
  direction: "warming" | "stable" | "cooling" | "uncertain";
  confidence: "low" | "medium" | "high";
  supportingMetrics: string[];
  conflictingMetrics: string[];
  externalCausePresent: boolean;
  externalCauses: string[];
};
```

判定规则：

- 取所有 `sufficient` 指标归一化分数的平均
- `|avg| < 0.15` → `stable`；`≥ 0.15` → `warming`；`≤ −0.15` → `cooling`
- 上升与下降各 ≥2 个指标且差距很小 → `uncertain`（指标互相矛盾）
- 没有足够可比指标 → `uncertain`

UI 文案刻意避开「关系」二字：

| direction | 文案 |
|---|---|
| warming | 互动投入上升 |
| stable | 互动基本稳定 |
| cooling | **互动投入下降** |
| uncertain | 趋势不明确 |

### 趋势由程序主导

- 服务端计算 `patternTrend` 并写入请求
- **模型的 `trend` 输出不被采信**：`analysis.trend` 一律取 `patternTrend.direction`
- 模型若不同意，只能写在 `alternativeInterpretations` 或 `contradiction` 里

这消除了第二轮观察到的 trend 标签漂移（同场景出现 `uncertain / warming / uncertain`）。

## externalCausePresent：外部原因

来源**只允许**对话中明确出现的现实原因，不允许模型发明：

| 类别 | 触发词示例 |
|---|---|
| `work` | 加班、开会、项目、上线、工作忙、值班 |
| `illness` | 生病、感冒、发烧、医院、住院 |
| `injury` | 扭、受伤、疼、医生、复诊、养伤 |
| `exam` | 考试、复习、论文、答辩 |
| `trip` | 出差、外地、回老家、赶飞机 |
| `family` | 家里有事、家人、父母、照顾 |

当 **互动投入下降 + `externalCausePresent = true`** 时，翻译层必须给出修正：

> 互动投入有所下降，但对话中存在明确的现实外部原因（受伤），不能据此判断关系变化。

该修正会同时出现在「目前不能确定」与「接下来观察什么」两处。

## 关系语境：relationshipContext

旧字段 `relation` **保留**；未提供 `relationshipContext` 时由 `contextFromRelation()` 推导，
保证旧请求完全兼容。

```ts
type RelationshipContext = {
  type: "new" | "friend" | "close_friend" | "crush"
      | "dating" | "couple" | "coworker" | "family" | "other";
  durationDays?: number;
  closeness: "low" | "medium" | "high" | "unknown";
  contactFrequency: "rare" | "weekly" | "several_per_week" | "daily" | "very_frequent" | "unknown";
  usualTone: string[];
  knownPatterns: string[];
  recentContext: string[];
  sourceType: "user_provided" | "observed" | "mixed";
};
```

### 安全原则

`relationshipContext` 只能改变「同一行为的**基准解读权重**」，**不能**：

- 因为 `type=crush` 就把普通关心解释成暧昧
- 因为 `type=friend` 就禁止识别潜在信号
- 把用户提供的关系类型当成对方的真实心理状态

它在 prompt 中以**结构化描述**呈现（而不是一行 `relationship: crush`），并要求模型：
先按可观察行为分析 → 再用关系背景调整权重 → 关系背景不能覆盖证据。


两种反馈**完全分开**：

| 类型 | 存储键 | 作用 |
|---|---|---|
| 记忆反馈（第一阶段基础设施） | `crush-monitor.feedback.v1` | 唯一能把 `model_inferred` 提升为 `user_confirmed` 的入口 |
| **解读反馈**（界面上的「有帮助 / 有问题」） | `crush-monitor.deep-feedback.v1` | **只保存，不改变任何行为** |

解读反馈刻意不调用 `applyFeedback()`、不读写 `memory.v1`、不修改任何 `sourceType`。
它只是未来校准的数据来源。

## 第三阶段：跨会话行为基线

从「分析当前这段聊天」升级为「知道这个人平时是什么样，并判断这一次哪里不同」。

这一阶段只回答一个问题：

> 「历史上我们观察到对方通常怎样互动，这一次哪里不同？」

它不回答、也不允许任何人用它回答「对方是什么样的人」。所有字段都是行为统计，不含人格标签、依恋类型或喜欢概率。

### 第三阶段链路

```
Evidence（原始消息，唯一事实来源）
   │
   ▼
Jev Observation（每句的情绪/意图概率，第一层）
   │
   ▼
当前 Pattern（computeSessionMetrics / computePatterns，程序）
   │
   ├──▶ Historical Baseline（updateBaseline：本地、增量、带时间衰减）
   │                │
   ▼                ▼
Historical Delta（computeHistoricalDeltas：这次 vs 她平时）
   │
   ▼
DeepSeek Interpretation（只解释，不算数字）
   │
   ▼
UserTranslation（含 comparedToUsual）
   │
   ▼
UserFeedback（确认 / 纠错：唯一能提升来源等级的力量）
   │
   ▼
长期 Memory / Baseline 更新（第三阶段在浏览器里；第四阶段改到服务端，见「第四阶段」）
```

| 环节 | 由谁产生 | 关键约束 |
|---|---|---|
| Evidence | 用户粘贴 | 唯一的事实来源 |
| Jev Observation | 第一层 | 原始概率原样保留 |
| 当前 Pattern | `computeSessionMetrics` / `computePatterns`（纯函数） | LLM 不得计算或改写 |
| Historical Baseline | `updateBaseline`（纯函数，客户端） | 只由程序更新，LLM 不参与 |
| Delta | `computeHistoricalDeltas`（服务端重算） | 客户端传上来的数字被丢弃 |
| Interpretation | DeepSeek（第二层） | 只能是解释，不得输出概率数字 |
| UserTranslation | 程序组装 + 过滤 | 禁止关系结论与命令式措辞 |
| UserFeedback | 用户 | 唯一能把来源提升到 `user_confirmed` 的入口 |
| Memory / Baseline 更新 | 客户端控制器 | local-first（第四阶段起改由服务端写 SQLite，见「第四阶段」） |

时序上：基线更新在一次本地 `commit`（会话级，不需要第二层）里完成，历史 delta 在发起解读时由服务端用同一份基线重算。

### PersonProfile：档案结构

一段关系对应一个档案。id 由 `profileIdFor({ displayName, relation })` 派生，格式 `profile:<slug>:<relation>`（称呼小写并去掉非字母数字字符），同一段关系始终落到同一个档案。

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `string` | `profile:<slug>:<relation>` |
| `displayName?` | `string` | 对方称呼，仅本地展示 |
| `relationshipContext` | `RelationshipContext` | 先验语境，不是结论；缺省由 `contextFromRelation(relation)` 推导 |
| `createdAt` / `updatedAt` | `number` | 毫秒时间戳 |
| `baselineVersion` | `number` | 基线口径版本，新建时为 `1`（`BASELINE_VERSION = 1`）；口径改变时递增，旧基线不会被误当成新口径 |
| `behaviorBaseline` | `BehaviorBaseline` | 跨会话行为基线 |
| `memories` | `LongTermMemory[]` | 长期记忆，带来源等级与生命周期 |
| `knownPatterns` | `KnownPattern[]` | 系统归纳的长期模式，来源只可能是 `deterministic`（自动）/ `user_confirmed`（用户确认），带 `patternKey`、证据数、对话数与生命周期 |
| `habits` | `CommunicationHabit[]` | 个体表达习惯 |
| `inferenceCandidates` | `InferenceCandidate[]` | 模型推断候选，只作解释辅助，不自动成为长期结论（上限 `MAX_INFERENCE_CANDIDATES = 60`） |
| `activityEvents` | `ActivityEvent[]` | 确定性事件统计（邀约与答复），行为模式的证据来源之一（上限 `MAX_ACTIVITY_EVENTS = 200`） |
| `feedbackStats` | `FeedbackStats` | 只用于让系统了解自己的历史表现；不从存储读取，由 `computeFeedbackStats()` 按 `confirmations` / `corrections` 重算（客户端运行时另外把本机的解读反馈一起算进来） |
| `confirmations` | `InterpretationConfirmation[]` | 用户对每次解读的整体判定与逐项勾选 |
| `corrections` | `UserCorrection[]` | 用户纠错原话，以及因此被推翻的推断 id |
| `sourceConversationIds` | `string[]` | 已并入基线的对话 id（保留最近 512 条），`hasConversation()` 用它判重 |

这份档案记录的是**历史上我们观察到对方通常怎样互动**，不是**对方是什么样的人**。因此它没有依恋类型、性格类型、喜欢概率这类字段，也不允许从这些统计量推出它们。

### BehaviorBaseline 与 BaselineMetric

`BehaviorBaseline`：

| 字段 | 含义 |
|---|---|
| `sampleCount` | 进入基线的样本总数（每个有效指标 +1，累计） |
| `conversationCount` | 合并过的对话轮数，冷启动分档与检索都用它 |
| `firstObservedAt` / `lastObservedAt` | 首次 / 最近一次并入基线的时间（毫秒） |
| `metrics` | `Partial<Record<BaselineMetricKind, BaselineMetric>>` |

`BaselineMetricKind` 只有 8 项：`initiation_ratio`、`reply_latency`、`reply_length`、`question_density`、`continuation_rate`、`closing_ratio`、`emotion_drift`、`intent_drift`。基线与 delta 都只遍历这份白名单 `BASELINE_METRIC_KINDS`，因此聚合量 `baseline_delta` 与长度量 `event_volume` 不会进入历史基线（`BASELINE_EXCLUDED_KINDS` 与之一致），否则「聊得多」会被当成「关系变好」。

`BaselineMetric`：

| 字段 | 含义 |
|---|---|
| `mean` | 带时间衰减的加权均值 `weightedSum / weightSum`，代表「她近来是什么样」 |
| `median` | 最近 `recent` 窗口的中位数 |
| `variance` | 最近 `recent` 窗口的总体方差 |
| `sampleCount` | 该指标的历史累计样本数 |
| `updatedAt` | 上次并入的毫秒时间戳，只用于计算衰减间隔 |
| `weightSum` / `weightedSum` | 增量累加器，保证不保留全部历史也能更新 |
| `recent` | 原始样本窗口，长度上限 `BASELINE_RECENT_LIMIT = 20` |

**为什么延迟必须看 `median`**：延迟分布很容易被极端值污染（一次隔了很久才回），均值会被拉高，让平时的正常回复看起来像秒回。所以 `computeHistoricalDeltas()` 对 `reply_latency` 优先取 `median` 作参考值，其余指标取 `mean`；`HistoricalDelta.historicalMedian` 把中位数一并带出来。

**为什么 `recent` 有上限**：`median` 与 `variance` 只取最近 `BASELINE_RECENT_LIMIT = 20` 个原始样本。一是存储不随时间无限增长，二是「她最近什么样」比「很久以前的分布」更相关。超出上限时从最旧的样本开始丢弃。

### 基线更新：updateBaseline

```ts
updateBaseline(
  previous: BehaviorBaseline | null | undefined,
  session: SessionMetricsInput,   // { conversationId, metrics, at }
): BehaviorBaseline
```

纯函数、增量：不读当前时间、不用随机数，时间一律由调用方通过 `session.at` 传入。规则：

- 缺失或非有限值的指标一律 `continue` 跳过 —— **不补 0、不用 0 顶替**，否则「样本不足」会被伪装成「取值为 0」。
- `conversationCount` 每次调用 +1；`sampleCount` 只加本次有效指标的个数。
- `firstObservedAt` 取首次，`lastObservedAt` 取 `max`。
- 判重在调用方：`src/useProfile.ts` 的 `commit()` 先用 `hasConversation(profile, conversationId)` 判断，同一段对话不重复并入，避免刷新页面把样本刷高（`conversationId` 只作标识，`updateBaseline` 内部不使用它）。

时间衰减 `decayWeight(daysAgo)`（分档写在 `DECAY_BUCKETS` 与 `DECAY_MIN_WEIGHT`）：

| 距上次更新的天数 | 权重 |
|---|---|
| ≤ 30 | 1 |
| 31–90 | 0.7 |
| 91–180 | 0.4 |
| > 180 | 0.2 |

`daysAgo` 非有限值或 ≤ 0 时返回 1。衰减作用在增量累加器上：

```
decay        = decayWeight((at - previous.updatedAt) / 86_400_000)
weightSum'   = previous.weightSum   * decay + 1
weightedSum' = previous.weightedSum * decay + value
mean         = weightedSum' / weightSum'
```

一年前每天聊天不能直接当作今天的基线，否则「认识很久」会变成一种优势。`median` / `variance` / `recent` 取最近原始样本，不受衰减影响。

基线**只由程序计算**：模型既不更新它，也不计算 delta（prompt 规则 19）。

### 两种 baseline 必须分开

| 结构 | 比较对象 | `scope` | 产生者 |
|---|---|---|---|
| `SessionPatternTrend`（= `PatternTrend`） | 当前这段聊天前半段 vs 后半段 | `"session"` | `computePatternTrend()`，服务端填充 |
| `HistoricalPatternTrend` | 这次（最近一轮对话）vs 过去多次 | `"historical"` | `computeHistoricalTrend()`，服务端重算 |

例子：一次会话前半段热、后半段安静 → 会话内趋势是 `cooling`；但每个指标的归一化变化都 `< 0.15`（`significance === "none"`）→ 历史趋势仍是 `warming` / `stable`，即「会话内降温，整体仍在她平时水平之上」。`buildTranslation()` 对这种情况给一句修正：

> 这段对话内部后半段比前半段安静一些，但整体仍然接近她自己平时的水平，更可能只是这一段的节奏。

不能合并成一个 delta：两者的参照系不同 —— 一个是这段对话的内部对比，一个是她自己的历史分布。合并就会得到「她变冷了 / 她变热了」这种把两种变化混起来的结论。两个结构都带 `scope`，服务端也分别填充 `patternTrend` 与 `historicalTrend` 两个字段。

### HistoricalDelta：字段、归一化与分档

| 字段 | 含义 |
|---|---|
| `metric` | `BaselineMetricKind` |
| `label` | 中文标签，来自 `metricLabel(metric)` |
| `current` | 本次会话取值 |
| `historical` | 参考值：`reply_latency` 取 `median`（存在时），其余取 `mean` |
| `historicalMedian` | 参考中位数，没有时为 `null` |
| `delta` | `current - historical` |
| `normalizedDelta` | **已按互动投入方向取号**：正数 = 比平时投入更多，负数 = 比平时投入更少。延迟这类「越大越冷」的指标靠它才能与其他指标放在一起比较 |
| `significance` | `none` / `small` / `moderate` / `large` |
| `sampleCount` | 该指标进入基线的历史样本数 |

返回前按 `|normalizedDelta|` 降序排序，变化最大的排最前。

参考值还做了一个必要的修正：如果本次会话**已经**并入基线（`lastValue` 等于当前值且 `previousSampleCount >= 2`），参考值改用 `previousMean` / `previousMedian`，也就是把本次样本排除掉。否则「这次和她平时比」等于拿她去比她自己，样本越少 delta 越接近 0。

归一化与会话内 delta **共用同一个口径** `normalizeMetricDelta(kind, current, reference)`（`shared/patterns.ts`），所以「这次和她平时比」与「这次前后半段比」不会各算一套：

- `absolute` 量纲：`clamp(current - reference, -1, 1)`
- `relative` 量纲：`clamp((current - reference) / |reference|, -1, 1)`；`reference` 为 0 时按差值符号取 ±1，差值为 0 取 0
- 历史 delta 在此之上再乘 `metricSpec(kind).orientation`（+1 / -1），得到方向统一的 `normalizedDelta`；`computeHistoricalTrend` 直接用它，不再乘第二次

显著程度 `significanceOf(normalized)` 的分档：

| \|normalized\| | significance | 文案 |
|---|---|---|
| < 0.15（`SIGNIFICANCE_SMALL`） | `none` | 与她平时接近，不构成变化 |
| 0.15 – 0.3（`SIGNIFICANCE_MODERATE`） | `small` | 略微 |
| 0.3 – 0.5（`SIGNIFICANCE_LARGE`） | `moderate` | 明显 |
| ≥ 0.5 | `large` | 非常明显 |

`computeHistoricalTrend(baseline, currentMetrics, options)` 把 delta 汇总成方向：

- `insufficientHistory`：基线状态为 `none` / `insufficient`、没有任何 delta、或 `conversationCount < minConversations`（默认 `BASELINE_INSUFFICIENT_BELOW = 3`）时置 `true`，此时 `direction` 固定 `uncertain`、`confidence` 固定 `low`。
- 方向：每个 delta 乘指标方向系数 `orientation`；`|avg| < 0.15` → `stable`，`≥ 0.15` → `warming`，`≤ -0.15` → `cooling`；上升与下降各 ≥2 个指标且 `|avg| < 0.3` → `uncertain`（指标互相矛盾）。
- 把握：`uncertain` → `low`；`|avg| ≥ 0.3` 且主导指标数 ≥3 → `high`；`|avg| ≥ 0.15` 且主导指标数 ≥2 → `medium`；否则 `low`。
- `supportingMetrics` / `conflictingMetrics` 存 `BaselineMetricKind`（会话内那套存 `string`）。

### reply_latency 的 30 分钟规则

只统计「我方发言 → 对方紧接着回复」这一种相邻切换，并且必须同时满足：

```ts
prev.sender === "self" && curr.sender === "other"
gap = parseTimestamp(curr.timestamp) - parseTimestamp(prev.timestamp)
0 < gap <= CONVERSATION_GAP_MS
```

`CONVERSATION_GAP_MS = SESSION_GAP_MINUTES * 60_000`，即 30 分钟；它与 `sliceSessions()` 切分对话用的是同一个阈值，避免两处漂移。

- `gap <= 0` 视为脏数据，跳过。
- `gap > 30 分钟` 属于展开了新的一轮对话（跨天、隔夜），不是「回复慢」，不计入延迟。
- 一旦把跨天间隔计入，基线会被拉到几百分钟，正常回复看起来像秒回。
- 有效延迟少于 `MIN_SAMPLE = 2` 次时该指标判为样本不足（会话内对比时前后半段各自计数，长期基线用整段会话计数）。

### 冷启动：baselineStatus

`baselineStatus(baseline)` 按 `conversationCount` 分档：

| conversationCount | status | 含义 |
|---|---|---|
| 0 | `none` | 还没有历史样本 |
| 1–2（< `BASELINE_INSUFFICIENT_BELOW = 3`） | `insufficient` | 历史不足，只能基于这次对话分析 |
| 3–5（≤ `BASELINE_ESTABLISHED_ABOVE = 5`） | `early` | 有了一点历史，比较结果仅供参考 |
| ≥ 6 | `established` | 已积累历史基线 |

`baselineStatusLabel(status, count)` 给 UI 文案：

- `none` → 还没有历史样本
- `insufficient` → 历史样本还不足（已记录 N 次对话），当前只能基于这次对话分析
- `early` → 历史样本偏少（已记录 N 次对话），比较结果仅供参考
- `established` → 已积累 N 次对话的历史基线

`coldStartNotice(status)`（`src/useProfile.ts`）在 `none` / `insufficient` 时返回「历史样本还不足，当前只能基于这次对话分析。系统不会假装已经认识这个人。」，其余状态返回 `null`。

历史不足时禁止产生「她平时如何」的判断，这条约束有三层：

1. `computeHistoricalTrend()` 直接不给方向（`insufficientHistory = true`）；
2. `describeHistoricalTrend()` 给模型的文本写明「本次不得做任何『她平时如何』的判断」，`describeProfileContext()` 追加一行「【历史不足】」；
3. prompt 规则 21 禁止模型写「她平时如何」「和以前不一样」「她一直是」。

`retrieveRelevantProfileContext()` 内部的 `baselineStatusOf()` 是同口径的本地实现（同样按 3 / 5 分档）。

### 记忆生命周期

| status | 含义 | 是否参与解读 |
|---|---|---|
| `active` | 当前有效 | 参与 |
| `contradicted` | 被用户确认的事实推翻 | 不参与 |
| `superseded` | 被更新的同类记忆取代 | 不参与 |
| `expired` | 久未复现，已不再作为当前基线 | 不参与 |
| `archived` | 用户明确拒绝 | 不参与 |

- `isUsableMemory()` 只认 `active`；检索只从 `status === "active"` 的集合里挑，`contradicted` / `expired` / `superseded` / `archived` 一律不进解读上下文。
- **纠错只标状态、绝不删除历史**：`applyUserCorrection()` 把冲突的 `model_inferred` 标为 `contradicted`，内容与 id 都保留，随时可以复盘；`user_confirmed` 的记忆不会被纠错降级。
- **被推翻的推断不能复活**：`mergeMemory()` 里已经是 `contradicted` / `superseded` 的记忆遇到新的 `model_inferred` 时保持原状态，否则用户纠错会在下一轮分析里被自动抹掉。
- 模式会过期：`KNOWN_PATTERN_EXPIRY_DAYS = 180`，`deriveKnownPatterns()` 把超过 180 天没有再观察到的模式标 `expired`，重新观察到则回到 `active`；列表按来源强度与证据数排序并截到 `MAX_KNOWN_PATTERNS = 20`。
- 纠错同时会把对应候选从 `inferenceCandidates` 移除，并把派生的 `kp:user:*` 模式标为 `contradicted`。

### 程序侧归纳：她平时就是这样

长期行为模式**只由程序统计产生**，不依赖任何模型输出，因此永远可复现。它解决的是第三阶段最核心的误判来源：**一个一直很短、一直很快的回复，不该在每次分析时被当成变化信号**。

链路是两段式的：

```
BehaviorBaseline ─┐
HistoricalDelta   ├─→ deriveBehaviorPatterns() ─→ BehaviorPatternCandidate[]
CommunicationHabit│                                    │
ActivityEvent    ─┘                                    ▼
                              promoteBehaviorPatterns()（门槛过滤）
                                                       │
                                                       ▼
                                          KnownPattern（sourceType = deterministic）
```

`BehaviorPatternCandidate` 的字段：`key` / `metric` / `direction` / `evidenceConversationIds` / `evidenceCount`（= 不同对话数）/ `firstObservedAt` / `lastObservedAt` / `sourceType: "deterministic"` / `highRisk` / `representative` / `description`。

**证据必须真实可追溯**：每条基线的样本都通过 `BaselineMetric.recentConversationIds` 记住自己来自哪一段对话；没有对话 id 的旧样本不充当证据。候选还必须满足 `supporting / total >= BEHAVIOR_PATTERN_MIN_RATIO = 0.7`，否则那是波动而不是「平时就是这样」。

指标型规则（`BEHAVIOR_RULES`）：

| patternKey | 指标 | 判定 |
|---|---|---|
| `reply_length_short` / `reply_length_long` | `reply_length` | ≤ 6 字 / ≥ 30 字 |
| `reply_latency_fast` / `reply_latency_slow` | `reply_latency` | ≤ 5 分钟 / ≥ 120 分钟 |
| `initiates_conversation` / `rarely_initiates` | `initiation_ratio` | ≥ 0.5 / ≤ 0.2 |
| `asks_questions` / `rarely_asks` | `question_density` | ≥ 0.3 / ≤ 0.05 |
| `closes_conversation` | `closing_ratio` | ≥ 0.5 |
| `emotion_net_positive` / `emotion_net_negative` | `emotion_drift` | ≥ 0.5 / ≤ −0.2 |

事件型规则（`shared/events.ts`，全部 `highRisk`）：

| patternKey | 事件 | 说明 |
|---|---|---|
| `accepts_planned_invitations` | `planned_invite_accepted` | 「历史上她接受过提前约好的安排」 |
| `declines_same_day_invitations` | `same_day_invite_declined` | 「历史上她较少接受当天临时的邀约」 |
| `counterpart_proposes_activity` | `counterpart_proposes_activity` | 「历史上她主动提出过一起活动」 |

**门槛**（按不同对话数）：

| 类型 | 门槛 |
|---|---|
| 一般行为模式 | `evidenceCount >= BEHAVIOR_PATTERN_MIN_CONVERSATIONS = 3` |
| 高风险（一起活动、约见这类更接近关系解释） | `evidenceCount >= BEHAVIOR_PATTERN_HIGH_RISK_MIN_CONVERSATIONS = 4` |

- 自动产生的模式 `sourceType` 只能是 `"deterministic"`；措辞只描述可观察行为，**不写**「她是话少的人」「她喜欢…」「她害怕…」「她是…型」。
- **模式是当前证据的视图**：`deterministic` 模式每一轮都由当前基线重新生成；一旦现在的数据不再支持它（例如她最近开始写长消息），`deriveKnownPatterns()` 会把它标成 `expired`（内容保留可复盘），而不是让旧描述一直挂着当结论。重新被支持则回到 `active`。
- 这些模式会随检索一起进入第二层，标为 `【已知模式·程序统计】`，让「她一直这样」在解读时就参与进来，而不是事后靠用户自己判断。

### 确定性事件统计：邀约与答复

`shared/events.ts` 只做一件事：找出「我方明确发出邀约 → 对方明确答复」这种可核对的结构，并归类成可统计的事件。关键词判定刻意保守：

- 邀约必须**同时**命中邀约词（`INVITE`）与活动词（`ACTIVITY`）。因此「周末有空吗」这种只有邀约词、没有具体活动的说法**不会**被当成邀约；
- 只有对方的紧随回复里出现明确的接受 / 拒绝措辞才算一次答复；两可时以拒绝为准（「这周可能不行」同时可能命中接受词，必须先判拒绝）；「到时候看」「可能有」这类含糊措辞两边都不算 —— 那是没答应，归到接受等于把不确定统计成愿意；
- 时间类型由 `PLANNED` / `SAME_DAY` 判定，说不清的一律记 `unspecified_*`；
- 同一段对话里同一种事件只保留一次（`recordActivityEvents()` 按「对话 + 类型」去重，上限 `MAX_ACTIVITY_EVENTS = 200`）。

它只产出事件计数，不产出任何动机或感情解释。因为门槛高（高风险模式需要 4 段对话）且判定保守，这套统计在真实验证里通常不会触发 —— 这是刻意的：宁可没有这条模式，也不要拿一句「周末有空吗」编出「她更愿意和你单独活动」。

### 媒体消息：语音 / 图片 / 表情包

微信复制出来的语音、图片、表情包等没有正文，只有占位标识。用户可以在占位后面自己补一句描述或转述，系统必须让模型知道「这是转述，不是原文」。

`shared/media.ts` 负责识别（`MEDIA_MARKERS` 覆盖 语音 / 图片 / 视频 / 动画表情 / 表情包 / 表情 / 文件 / 位置 / 链接 / 小程序 / 音乐 / 转账 / 红包 / 聊天记录 / 引用 / 撤回消息 / 不支持的消息）：

| 粘贴内容 | `kind` | `mediaKind` | `text` |
|---|---|---|---|
| `[语音]` | `unreadable` | `voice` | `[语音]`（原样保留） |
| `[语音] 她说周末要加班` | `text` | `voice` | `她说周末要加班` |
| `[图片] 一只橘猫` | `text` | `image` | `一只橘猫` |
| `[动画表情] 笑得打滚` | `text` | `sticker` | `笑得打滚` |
| `我发了[图片]你看到了吗` | `text` | — | 原样（识别只认整条消息开头的占位） |

- **没补内容**：照旧当不可读，不参与分析、不进入任何统计。
- **补了内容**：正文只取用户写的那段（不含 `[语音]` 标记），因此 `reply_length` 之类的数字不会被占位符污染；同时 `mediaKind` 让 UI 显示来源标签、让模型知道这是转述。
- **两条模型链路的正文都由 `mediaPromptText()` 渲染**（`server/analysis.ts` 的 `buildRequest` 与 `server/ai/deepseek.ts` 的 `buildPayload`）：
  - 有描述 → `【对方发来的语音，以下内容由用户手动转述或描述，不是原始文字】她说周末要加班`
  - 没有描述 → `【对方发来的图片，内容不可见，用户没有补充描述】`
  - 普通消息一字符都不改。
- 统计口径一律用**原始** `text`：`computePatterns` / `computeSessionMetrics` / 事实抽取 / 事件统计都读本地消息，不认识 `mediaPromptText`，所以数字与 UI 看到的一致。
- `mediaKind` 参与第二层缓存键（`deepContextKey`）：同一段描述，标成语音和标成图片对模型的含义不同，不能复用同一个解读。

### 什么能自动成为 observed memory

`shared/facts.ts` 只允许「高确定性的客观事实」自动进入 `observed` 长期记忆，以下条件全部满足才写入：

| 条件 | 规则 |
|---|---|
| 发送者 | 只能来自**对方本人说过的句子**（`sender === "other"` 且 `kind === "text"`） |
| 可定位 | 必须能定位到明确的 `messageId`，写进 `sourceMessageIds` |
| 句子长度 | 3–60 字（`MIN_SENTENCE` / `MAX_SENTENCE`）：下限取 3 是为了容纳「脚扭了」这类中文里的三字事实，仍然必须命中规则关键词，所以不会放进评价性内容 |
| 措辞 | 句子里出现任何 `FORBIDDEN_FACT_WORDS` 就**整句丢弃** |
| 规则 | 必须命中 `FACT_RULES` 之一 |
| 内容 | 一律**引用原话**：`对方说：${sentence}`，不做任何转述 |
| 数量 | 每段对话最多 `MAX_FACTS_PER_CONVERSATION = 4` 条；id 重复（`mem:fact:<hash>`）不再写入 |

`FACT_RULES`：

| key | kind | label | 触发词 |
|---|---|---|---|
| `work` | `event` | 工作安排 | 加班、项目、上线、出差、开会、值班、排期、赶工 |
| `study` | `event` | 学业安排 | 考试、复习、备考、论文、答辩、期末 |
| `health` | `event` | 身体状况 | 生病、感冒、发烧、不舒服、医院、挂水、住院、扭到、扭了、受伤、摔了 |
| `trip` | `event` | 出行安排 | 出差、外地、回老家、赶飞机、赶车 |
| `preference` | `preference` | 个人偏好 | 不喜欢、不爱吃、讨厌、最怕、受不了、吃不了 |

`FORBIDDEN_FACT_WORDS`（命中即整句丢弃）：

```
可能 也许 大概 似乎 好像 应该 其实 有点 感觉 疏远 冷淡 暧昧 喜欢我 回避型 焦虑型
```

转换后的记忆：`status = "active"`、`sourceType = "observed"`、`confidence = 0.8`（原话引用接近确定，但满分只留给用户确认），`kind` 取自命中的规则。

因此这条路径永远不可能产出「她最近有点疏远」「她可能害羞」「她喜欢你」「她是回避型」这类内容。

### InferenceCandidate 与晋升

**单次出现绝不写长期记忆。**

- 来源：`candidatesFromAnalysis()` 从一次解读里取 `latentEmotion.reading`（0.5，`aspect: "emotion"`）、`latentIntent.reading`（0.5，`aspect: "intent"`）与前 3 条 `alternativeInterpretations`（0.4，`aspect: "alternative"`），`confidence = min(来源把握, 0.6)`。
- id：`cand:${candidateKey(content)}`，key 去掉标点空白后截前 40 字（`CANDIDATE_KEY_LIMIT`），同样的推断文本稳定落到同一个候选。
- `kind` 固定 `"pattern"`；`observationCount` 等于 `conversationIds.length`，记的是**不同对话数**。
- **归并必须同一面**：只有 `aspect` 相同的候选才会互相比较 —— 情绪读法与意图读法即使措辞相似，也不是同一个模式；旧数据缺 `aspect` 时按 `alternative` 处理。
- 合并：`mergeInferenceCandidates()` 先按 id 合并，否则在**同一面**里取相似度最高且 `>= CANDIDATE_SIMILARITY_MIN = 0.3` 的候选归并（`inferenceSimilarity()` 是二元组 Jaccard）。阈值 0.3 来自实测：真实输出里同一面推断的最高相似度约 0.30。阈值不再下调 —— 靠更低阈值把不同措辞强行合并，只会制造假模式。
- 归并后取对话 id 与来源消息 id 的并集，`confidence` 取较大值；同一段聊天重复提交不会把刷高计数。列表截到 `MAX_INFERENCE_CANDIDATES = 60`。

**这条路径只累积候选，不产生任何长期结论**（`mergeInferenceCandidates()` 的返回值就是 `InferenceCandidate[]`）：

| 能做 | 不能做 |
|---|---|
| 作为解释辅助进入检索上下文（`INFERENCE_BACKGROUND_LIMIT = 3` 条，标签 `【模型推断·弱背景】`） | 自动晋升为 `LongTermMemory(kind="pattern")` |
| 被用户在确认界面逐项确认，确认后成为 `user_confirmed` 的记忆与模式 | 自动成为 `KnownPattern` |
| 与程序统计出的模式一起被看到（后者权重更高） | 覆盖或推翻 `deterministic` / `user_confirmed` 的同键模式 |

> 实测依据：真实 DeepSeek 输出下，5 段对话产出 38–43 条候选，跨对话归并几乎不触发。与其继续调阈值，不如让长期结论改由程序统计承担（见「程序侧归纳」一节），模型文本退回解释辅助的位置。

旧档案里已经存在的 `model_inferred` 模式不会被删除，而是由 `deriveKnownPatterns()` 标为 `superseded`：内容保留可复盘，但不再参与解读。

### 模式来源优先级

`mergeKnownPatterns()` 用同一套优先级解决冲突（`user_confirmed` > `deterministic` > `model_inferred`）：

- 低优先级**永远不能覆盖**高优先级的同键模式 —— 模型自由文本推不翻有证据支撑的行为模式；
- 同级时只有证据更强才替换描述，否则仅刷新观察时间；
- 被用户纠正推翻（`contradicted`）的模式不会因为重新统计而复活；
- 不在输入里的既有模式（例如用户自己确认的）原样保留。

### 用户确认与纠错

确认界面给四个整体判定（`ConfirmationVerdict`）：基本正确（`mostly_correct`）、部分正确（`partly_correct`）、不正确（`incorrect`）、还不知道（`unknown`）。

`confirmationParts(analysis, candidates)` 生成可逐项勾选的部分：

| key | 内容 |
|---|---|
| `emotion` | `latentEmotion.reading` |
| `intent` | `latentIntent.reading` |
| `interp:0` / `interp:1` / `interp:2` | 前 3 条 `alternativeInterpretations[].interpretation` |
| `memory:<candidateId>` | 前 4 条推断候选的 `content` |

`applyConfirmation(profile, ...)` 的硬规则：

- 只处理 `confirmedParts` 里明确列出的 key；**即使用户选「基本正确」，也只有勾选项升级**，没勾选的 `model_inferred` 保持原样。
- `memory:<candidateId>` → 把既有的 `mem:pattern:<candidateId>`（或 id 等于 `candidateId` 的那条）升级为 `sourceType = "user_confirmed"`、`confidence = 1`、`status = "active"`；同时生成一条 `kp:user:<candidateId>` 的 `KnownPattern`（`sourceType = "user_confirmed"`）。这是模型推断成为长期结论的**唯一**合法路径。
- 其余 key → 新建一条记忆，id 为 `mem:confirmed:<contextKey>:<key>`（截断到 160 字符），`kind = "event"`，内容统一带前缀 `用户确认：`（`CONFIRMED_PREFIX`），`confidence = 1`，`sourceType = "user_confirmed"`。
- 同一个 `contextKey` 只保留最新一次确认。

纠错流程：

1. 用户写下实际情况，`findConflictingInferences(memories, correction)` 用中文二元组重合度找出可能冲突的 `model_inferred`（重合 ≥ `CORRECTION_OVERLAP_MIN = 2`），**只建议，不自动改任何东西**；
2. 用户勾选后 `applyUserCorrection()` 先把用户原话保存为 `mem:correction:<id>`（`kind = "fact"`、`sourceType = "user_confirmed"`、`confidence = 1`）；
3. 被勾选的推断标 `contradicted`，内容与 id 都保留，**永不删除**，以后可以复盘；`user_confirmed` 的记忆不受影响；
4. 对应候选从 `inferenceCandidates` 移除，派生的 `kp:user:*`（以及旧档案里的 `kp:<candidateId>`）模式标 `contradicted`；`deterministic` 模式不受影响；
5. `feedbackStats` 随后由 `computeFeedbackStats()` 重算（纠错计入 `contradictedInterpretations`）。

面板文案与这个语义一致：「已记下你的纠正，并把 N 条相关推断标为『已被推翻』。历史推断不会删除，以后可以复盘。」

### CommunicationHabit：个体语言习惯

第一版只做高频表达统计 + Jev 观察聚合，不做 NLP。目的很窄：让同一个高频表达不要每次都被重新解读成情绪信号。

统计对象是 `HABIT_EXPRESSIONS` 里的 15 个表达：

```
哈哈 嘿嘿 嗯 哦 噢 行 好的 好 随你 随便 晚安 在吗 收到 没事 算了
```

| 字段 | 含义 |
|---|---|
| `observedCount` | 累计出现次数（按字符串出现次数计，不是消息条数） |
| `conversationCount` | 出现过它的不同对话数（`conversationIds.length`） |
| `contexts` | 出现过的情绪/意图语境标签（取该条消息 Jev 观察里概率最高的 top1），上限 8 种 |
| `usualMeaning` | 语境数 ≥ `HABIT_CONTEXT_SPREAD = 3` → 「更像语气填充，跨多种情绪语境出现，不宜单独当作情绪信号」；= 1 → 「目前只出现在「X」语境」；否则「出现的语境还不稳定」 |
| `confidence` | ≥15 次且 ≥3 段对话 → `high`；≥8 次且 ≥2 段 → `medium`；否则 `low` |
| `lastObservedAt` | 最近一次出现的时间 |
| `conversationIds` | 内部字段，保证同一段聊天重复提交不会把计数刷高 |

计数**永远是累积存储的**：`aggregateHabits()` 保留所有出现过的表达（上限 `MAX_HABITS = 40`），包括只在一段对话里出现的；是否可用于解读由 `habitIsEstablished()` 判定 —— `observedCount >= HABIT_MIN_OBSERVATIONS = 5` 且 `conversationCount >= HABIT_MIN_CONVERSATIONS = 2`。这一点很关键：如果低于阈值就直接丢弃，一个只在单段对话里高频出现的表达永远攒不到第二段对话。`establishedHabits()` 用于展示与检索，`habitHints(text, habits)` 在已达标、把握非 `low` 且当前文本含该表达时给出提示，用于抑制「哈哈 = 开心 / 暧昧 / 掩饰」这类误判：**它只压制误判，不产生任何结论**。

### Memory Retrieval：检索顺序与预算

`retrieveRelevantProfileContext({ profile, messages, observations, budget })` 是纯函数，无网络调用，token 预算固定（默认 `RETRIEVAL_TOKEN_BUDGET = 1200`）。选择顺序是：

| 优先级 | 内容 |
|---|---|
| 1 | `user_confirmed`（你确认过的事实与模式） |
| 2 | 当前事实（`currentFacts`：与这段对话直接相关的客观事实） |
| 3 | 已成立的程序统计模式（`knownPatterns`，`sourceType != model_inferred`） |
| 4 | 观察事实（`observed`） |
| 5 | 表达习惯（`establishedHabits`） |
| 6 | 未解决事件（`unresolved`） |
| 7 | 模型推断弱背景（`inferred`，最多 `INFERENCE_BACKGROUND_LIMIT = 3` 条） |

打分（`scoreMemory`，只做加法，结果可复现）：来源等级 `user_confirmed 3 / observed 2 / model_inferred 1` 乘 2；命中当前窗口消息 +3；`unresolved` / `boundary` +3；与当前文本词面重合 +2；`fact` / `preference` +1；`model_inferred` −1。分数 ≤ 0 的丢弃，排序为分数降序 → 来源等级降序 → id 升序。

每级还有硬上限 `RETRIEVAL_LIMITS`：`confirmed` 6 条、`currentFacts` 6 条、`observed` 6 条、`inferred` 3 条、`habits` 6 条、`patterns` 4 条；`corrections` 带最近 3 条。

送进 prompt 时每一条都带来源标签，并且**输出顺序就是优先级顺序**：

| 来源 | 标签 |
|---|---|
| `user_confirmed` | `【用户确认】` |
| 当前事实 | `【当前事实】` |
| 已知模式 | `【已知模式·程序统计】` / `【已知模式·用户确认】` |
| `observed` | `【观察事实】` |
| 表达习惯 | `【表达习惯】` |
| `unresolved` | `【观察事实】（未解决）` |
| `model_inferred` | `【模型推断·弱背景】` |

`describeProfileContext()` 还输出 `【历史基线状态】`、`【历史不足】`、`【历史基线】<指标>：平时约 mean（中位数 median），样本 N`、`【用户纠错】`，并在末尾声明权重顺序：用户确认 > 当前事实 > 程序统计的已知模式 > 观察事实 > 表达习惯 > 未解决事件 > 模型推断，以及门槛说明与「模型推断不得独自形成长期结论」。

预算与截断：`estimateTokens()` 按 CJK 约 1 字 1 token、其余约 4 字符 1 token 估算；默认 `RETRIEVAL_TOKEN_BUDGET = 1200`。超预算时按 `TRIM_LADDER` 从低到高裁剪 —— **模型推断 → 未解决事件 → 表达习惯 → 观察事实 → 稳定模式 → 当前事实**，并把裁掉的层级记进 `trimmed`。`user_confirmed` 永不裁剪：宁可超预算，也不丢用户确认的内容。`compactBaseline()` 在传输前去掉增量累加器与原始样本窗口（`weightSum = 0`、`weightedSum = 0`、`recent = []`），但保留 `lastValue` / `previousMean` / `previousMedian` / `previousSampleCount`，否则服务端算不出「排除本次」的参照值。

### 第二层输入的新增字段

`buildPayload()`（`server/ai/deepseek.ts`）在原有字段之外新增三块：

| 字段 | 来源 | 内容 |
|---|---|---|
| `historicalBaseline` | `describeHistoricalTrend(request.historicalTrend)` | 一句话的历史趋势与高于/低于平时的指标；没有历史时为 `null` |
| `historicalDeltas` | `describeHistoricalDeltas(deltas)` | 每条一行：`标签：本次 X，她平时 Y（中位数 Z，历史样本 N），变化 ±D，显著程度 S` |
| `profileContext` | `describeProfileContext(request.profile)` | 带来源标签的检索结果 + 基线行 + 习惯 + 纠错；没有 profile 时为空数组 |

数字只有一个来源：`server/ai/input.ts` 的 `buildProviderInput()` 用客户端上送的原始基线，配合**服务端自己算出的**本次指标重算 `historicalTrend`：

```ts
historicalTrend: computeHistoricalTrend(profile.baseline, sessionMetrics)
```

其中 `sessionMetrics` 来自 `computeSessionMetrics({ messages: latestSession(messages), observations })`。**客户端传来的 delta 一律被丢弃**（`profileBundleSchema` 里 `historicalTrend` 是 `z.unknown().optional()`，只为兼容旧请求保留）。同理 `patterns` 与 `patternTrend` 也是服务端重算的。

历史比较只针对最近一轮对话（`latestSession()`）：`boundedContext()` 里可能还有前几轮，把它们算进来会让「这次」失真。

`DEEP_ANALYSIS_INSTRUCTIONS` 的第三阶段规则：

| 规则 | 要点 |
|---|---|
| 17 | `profileContext` 每条都带来源标签：用户确认 > 当前事实 > 程序统计的已知模式 > 观察事实 > 表达习惯 > 未解决事件 > 模型推断，模型推断不得当作事实，也不得独自形成长期结论 |
| 18 | 【用户确认】与模型判断冲突时以用户确认为准，并在 `contradiction` 里说明冲突 |
| 19 | 历史基线 / delta 由程序计算，只能解释含义：不得自己算 delta、不得改写数值、不得说成感情变化 |
| 20 | 「她平时就是这样」的指标不构成变化；【表达习惯】里的高频表达不得单独解读成情绪、暧昧或掩饰 |
| 21 | 基线状态为 `none` / `insufficient` 时禁止写跨会话判断，只在 `historicalNote` 里说明历史样本不足 |
| 22 | 跨会话比较只能描述可观察的行为变化，不得升级成关系结论，也不得给人格标签或喜欢概率 |
| 23 | `historicalNote` 只能补充「这次与她平时相比」的含义，可以写 `null`，数字部分由程序给出 |

### UserTranslation 新增区域

| 字段 | 类型 | 说明 |
|---|---|---|
| `comparedToUsual` | `string[]` | 「和她平时相比」 |
| `historicalNote?` | `string \| null` | `DeepAnalysis.historicalNote`，模型对历史比较的补充说明，可为 `null` |

`buildTranslation(analysis, patternTrend, historicalTrend)` 这样组装 `comparedToUsual`：`describeComparedToUsual(historicalTrend)` 的行 + 「会话内降温但历史无变化」的修正句 + `analysis.historicalNote`（有才加）。全部经 `keep()` 过滤，命令式措辞（`IMPERATIVE_WORDS`：应该、应当、必须、一定要、务必、赶紧、马上、立刻、建议你、你需要、你最好）一律丢弃。

`describeComparedToUsual(trend)` 的措辞规则：

- `insufficientHistory` 为真 → 只给一行 `baselineStatusLabel(...)`，不写任何比较结论。
- 显著程度非 `none` 的 delta 取绝对值最大的前 3 条：`她这次的<指标短名><非常明显|明显|略微><慢于/快于/高于/低于/更多于/更少于平时>（本次 X，她平时约 Y，基于 N 次历史样本）。`
- `significance === "none"` 且属于 `STYLE_METRICS`（`reply_length`、`reply_latency`）的指标取前 2 条，写成「和她平时的水平接近，这本身不构成变化」——一直如此的行为不该被当成信号。
- 都没有时给一行「这次的行为指标和她平时的水平接近，没有观察到明显不同。」；最后一行始终是基线状态说明。

**只描述行为变化，禁止关系结论**：方向词只有「慢于平时 / 快于平时」「高于平时 / 低于平时」「更多于平时 / 更少于平时」，不会出现「她变冷淡了」「她对你不感兴趣了」。

`historicalNote` 只是模型补充：数字由程序给出，模型可以写 `null`。审计视图（`buildAuditTrace`）把它列在「模型补充的历史说明」下，没有时显示「（模型没有补充说明）」。

面板现状：`DeepPanel` 展示七个部分 —— `whatHappened` / 「和她平时相比」（`comparedToUsual`）/ `whatYouMightMiss` / `possibleMeanings` / `strongestEvidence` / `uncertainty` / `whatToWatchNext`。`LongTermPanel` 的「最近明显变化」则直接渲染 `historicalTrend.deltas` 的数字明细，并注明会话内趋势与历史趋势分开计算、两者不会合并成一个结论。

### local-first 与隐私边界（第三阶段）

| 项 | 约定 |
|---|---|
| 档案存储（**第三阶段的历史描述**，第四阶段已改为服务端 SQLite，见下文「第四阶段」一节） | 只在浏览器 `localStorage`，键 `crush-monitor.profile.v1`（`PROFILE_STORAGE_KEY`），版本 `PROFILE_SCHEMA_VERSION = 2`（v1 → v2：`KnownPattern` 增补 `patternKey` / `conversationCount` / `supportingMetrics`，来源 `"observed"` 迁移为 `"deterministic"`；`PersonProfile` 增补 `activityEvents`，基线增补 `recentConversationIds`） |
| 其他本地键 | `crush-monitor.memory.v1`、`crush-monitor.feedback.v1`、`crush-monitor.deep-feedback.v1` |
| 基线更新位置 | 只在客户端（`src/useProfile.ts` 的 `commit()`），服务端只读不写。**第四阶段起改为服务端读取并写回 SQLite**（见「第四阶段：服务端持久化与多账号」） |
| 上传内容 | 只有检索后的子集（`ProfileContextBundle`），且 `compactBaseline()` 去掉累加器与原始样本窗口，预算 `RETRIEVAL_TOKEN_BUDGET = 1200` tokens；不足时先丢模型推断，永不丢用户确认 |
| 服务端持久化 | 无。`buildProviderInput()` 是纯函数，不落盘、不缓存 |
| 响应头 | 所有响应带 `Cache-Control: no-store`（另有 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`） |
| 服务端日志 | 只记录 `model / latency / softened / removed / retried / history`（基线状态名）与违规**类别**计数 `codes`，不含聊天文本、记忆内容、纠错原话 |
| 缓存失效 | `deepContextKey()` 的 `profileSignature` 含基线指标、检索到的记忆、习惯与纠错：基线变了就不会复用旧解读 |

### 数据迁移与删除能力

`migrateProfilePayload(raw)` 兼容三种历史形态，返回 `{ version, profiles }`：

| 输入 | 处理 |
|---|---|
| `{ version: 1, profiles: [...] }` | 当前格式 |
| `[...profiles]` | 早期无版本号的数组 |
| `{ profiles: [...] }` | 缺 `version`，按 0 处理 |
| `version > PROFILE_SCHEMA_VERSION` | 来自更新的版本：**安全忽略**，返回空列表，不破坏原数据 |

容错原则：

- `validateProfile()`：`id` 或 `relationshipContext` 不合法、类型不对的整份档案返回 `null` 丢弃，不修补、不猜测；
- `parseMemory()`：逐条校验，字段不合法或违反 `memoryViolations()` 不变量的条目直接丢弃；旧数据没有 `status` 时按 `active` 处理；
- `feedbackStats` 一律由 `confirmations` / `corrections` 重算，不从存储读取，手改的统计数字进不了系统；
- 读取时 `JSON.parse` 失败、或存储后端不可用（隐私模式），一律返回空集合，应用照常启动；
- 基线损坏回退为 `emptyBaseline()`：宁可重新冷启动，也不带坏数据跑；
- `adoptLegacyMemories()` 一次性把第二阶段的扁平记忆（`crush-monitor.memory.v1`）收编进新档案，来源等级原样保留，然后删掉旧键，避免同一份数据被两处读到。

删除能力（全部只动长期数据）：

| 函数 | 作用 |
|---|---|
| `deleteProfile(id)` | 删除这个人的整份档案（含基线、记忆、习惯、反馈统计） |
| `clearBaseline(profileId)` | 清空 `behaviorBaseline` 与 `sourceConversationIds`，保留记忆与推断候选 |
| `deleteMemory(profileId, memoryId)` | 删除单条记忆 |
| `clearLongTerm()` | 删除 `LONG_TERM_KEYS` 四个键：档案、记忆、反馈、解读反馈 |
| `clearAll()` | 删除同一组四个键（早期入口） |

**这些操作都不会删除原始聊天记录**：聊天记录不在这些 key 里，「清空长期观察」不等于「删掉我的聊天」。面板上也写了同一句话。

### 第三阶段明确不做

- 人格诊断、依恋类型标签（回避型 / 焦虑型 / 人格障碍）
- 用单一数字表示「对方有多喜欢我」，或任何伪精确概率作为结论
- 情绪操纵策略（欲擒故纵、故意冷淡、让对方吃醋）
- 自动发送 / 自动回复消息，自动读取微信数据库，后台监听
- 自动把 inference 当事实：没有用户确认，就没有 `user_confirmed`
- 把「聊得多 / 回得快」直接当作关系变化（`event_volume` 不进基线）
- 用单条消息推断长期关系，或替用户决定下一步做什么

### 第三阶段文件职责

| 文件 | 负责 |
|---|---|
| `shared/profile.ts` | 基线更新（`updateBaseline` / `decayWeight`）、成熟度（`baselineStatus` / `baselineStatusLabel`）、历史 delta 与趋势（`computeHistoricalDeltas` / `computeHistoricalTrend` / `describeComparedToUsual`）、语言习惯（`aggregateHabits` / `habitIsEstablished` / `establishedHabits` / `habitHints`）、推断候选累积（`candidatesFromAnalysis` / `mergeInferenceCandidates` / `inferenceSimilarity`）、行为模式候选与晋升（`BEHAVIOR_RULES` / `deriveBehaviorPatterns` / `promoteBehaviorPatterns` / `mergeKnownPatterns` / `deriveKnownPatterns`）、确认与纠错（`confirmationParts` / `applyConfirmation` / `applyUserCorrection`）、档案（`profileIdFor` / `emptyProfile` / `hasConversation`） |
| `shared/events.ts` | 确定性事件统计：`detectActivityEvents`（邀约与答复的关键词归类）、`recordActivityEvents`（按对话 + 类型去重）、`eventConversations` |
| `shared/media.ts` | 媒体占位识别（`parseMediaMarker` / `hasMediaDescription` / `mediaNoun`）与给模型看的转述说明（`mediaPromptText`） |
| `shared/facts.ts` | 客观事实抽取（`extractObservedFacts` / `FACT_RULES` / `FORBIDDEN_FACT_WORDS`）与转换（`observedMemoriesFromFacts`） |
| `shared/retrieval.ts` | 记忆检索（公开 API 只有 `retrieveRelevantProfileContext`；预算裁剪 `enforceBudget` 与 `TRIM_LADDER` 是模块内部的，不导出）、传输用紧凑基线（`compactBaseline`）、给模型的带标签文本（`describeProfileContext`）、审计视图（`buildAuditTrace`） |
| `shared/memory.ts` | 上下文窗口（`boundedContext`）、相关记忆（`relevantEvents`）、记忆合并与不变量（`mergeMemory` / `memoryViolations` / `isUsableMemory` / `setMemoryStatus`）、用户反馈升级入口（`applyFeedback`） |
| `shared/translation.ts` | `UserTranslation` 组装与命令式措辞过滤，含新增的 `comparedToUsual` |
| `shared/patterns.ts` | 指标定义与计算（`METRIC_DEFINITIONS` / `computePatterns` / `computeSessionMetrics`）、归一化（`normalizeMetricDelta`）、会话内趋势（`computePatternTrend`）、会话切分（`sliceSessions` / `latestSession`） |
| `src/storage.ts` | 档案的本地持久化与校验（`loadProfiles` / `saveProfiles` / `validateProfile`）、迁移（`migrateProfilePayload`）、旧记忆收编（`adoptLegacyMemories`）、删除能力（`deleteProfile` / `clearBaseline` / `deleteMemory` / `clearLongTerm`） |
| `src/useProfile.ts` | 本地控制器：会话提交（`commit`：基线 + 习惯 + 事实）、确认与纠错、检索与历史趋势、React 包装 `useProfile()`、UI 状态（`profileUiState` / `coldStartNotice`）、对话内容指纹（`conversationIdFor`） |
| `src/LongTermPanel.tsx` | 长期观察面板：历史样本、最近明显变化、已确认事实、观察事实、观察中的模式、表达习惯、确认与纠错界面、审计视图、删除入口 |
| `server/ai/input.ts` | `buildProviderInput()`：服务端重算 `patterns` / `patternTrend` / `historicalTrend`，只采信客户端带来的原始基线 |
| `server/ai/deepseek.ts` | 第二层 provider：`DEEP_ANALYSIS_INSTRUCTIONS`（含规则 17–23）、JSON Schema、`buildPayload()`（新增 `historicalBaseline` / `historicalDeltas` / `profileContext`）、安全重试与校验 |

## 第四阶段：服务端持久化与多账号（**已被本机版取代，仅作设计沿革保留**）

> 这一整章描述的形态**已经不在发布版里**：`server/db.ts`、`server/auth.ts`、`server/routes.ts`、
> `src/api.ts`、`src/useAuth.ts`、`src/LoginPage.tsx` 都已删除，`DATA_DIR` / `COOKIE_SECURE` /
> `TRUST_PROXY` 与 `user:*` / `db:*` 脚本也一并去掉。
> 现在长期数据回到浏览器 `localStorage`，服务端只做模型调用与静态托管。
> 阅读本章时请把它当成"我们试过什么、为什么退回来"的记录，而不是当前实现。

前三个阶段长期数据存在浏览器 `localStorage`（local-first，见「local-first 与隐私边界（第三阶段）」）。第四阶段把真相源整体搬到服务端 SQLite，并加上账号与 session。这一章只讲**存储、身份与写入路径**的变化，不改分析口径。

### 第四阶段链路

改造前的链路（本地版）：

```
Browser（localStorage = 长期数据真相源）
   │
   ├── 分析链路（前端编排：useProfile 控制器）
   ▼
浏览器写档案 → localStorage
```

改造后的链路：

```
Browser（只保留 UI 状态与草稿）
   │
   ▼
Auth / Session（cookie → session → currentUserId）
   │
   ▼
API（server/routes.ts：资源隔离、校验、乐观锁、限流）
   │
   ▼
SQLite（data/crush-monitor.sqlite：唯一长期真相源）
```

| 层 | 位置 | 负责 |
|---|---|---|
| Browser | `src/App.tsx` / `useAuth` / `useWorkspace` | 登录态展示、选中的人与对话、草稿、乐观锁版本号、发请求 |
| Auth / Session | `server/auth.ts` | 密码哈希、session 签发与校验、登录限速、cookie 属性 |
| API | `server/routes.ts`、`server/index.ts` | 参数校验、资源隔离、乐观锁、去重入库、限流、日志 |
| SQLite | `server/db.ts` | schema、migration、`toBind` 绑定约定、online backup |

**分析链路本身没有变**：Messages → Jev → Observation → Pattern → Baseline → DeepSeek → Boundary → UserTranslation → Feedback → Profile。变的是两端的取数与落库位置：输入的消息与档案改为服务端从 SQLite 读，输出的档案改为服务端写回 SQLite，中间每一环的规则与前三阶段完全一致。

### SQLite 技术选择

| 决定 | 理由 |
|---|---|
| 用 Node 内置 `node:sqlite`（`DatabaseSync`） | 零原生依赖：本地 Windows 与服务器 Ubuntu 跑同一套代码，不需要 `node-gyp`，部署时没有编译步骤 |
| 同一套代码两端通用 | `package.json` 只要求 `node >= 22.12.0`，服务器上装 Node 就够，没有「本地能跑服务器装不上」的构建差异 |
| 自带 online backup | `backupDatabase(destination, db)` 基于 `node:sqlite` 的 `backup()`，一致性快照，数据库正在写入时也能备份，不必停服务 |
| 不引入 better-sqlite3 | 它是原生模块，本地与服务器两端都要过编译；换来的性能在单机单进程的用量下不是瓶颈 |
| 驱动可替换 | 所有 SQLite 细节收在 `server/db.ts`，换驱动只改这一个文件 |

启动时固定开启的 PRAGMA：

| PRAGMA | 值 | 意义 |
|---|---|---|
| `journal_mode` | `WAL` | 读写互不阻塞：分析请求读消息与写入导入可以并发（`:memory:` 不支持 WAL，代码里忽略失败） |
| `foreign_keys` | `ON` | 外键约束与级联删除真正生效；不开这一项，`ON DELETE CASCADE` 是空话 |
| `busy_timeout` | `5000` | 并发写撞锁时等 5 秒而不是立刻报错 |
| `synchronous` | `NORMAL` | 与 WAL 搭配的常规选择，避免每次提交都强制落盘 |

绑定值约定：`node:sqlite` 只接受 `null` / `number` / `bigint` / `string` / `Uint8Array`，**不接受 `boolean` 与 `undefined`**。所以所有参数统一走 `toBind()`：`boolean → 0/1`、`undefined → null`、非有限数字 → `null`、其余对象 → `JSON.stringify`。查询入口是 `all()` / `get()` / `run()`，写操作用 `transaction(db, fn)`（`BEGIN IMMEDIATE`，回调抛错回滚）。

数据库文件默认在 `<项目根>/data/crush-monitor.sqlite`（`DATA_DIR` 可覆盖），**不在** Vite 静态产物目录里，也不由 `express.static` 暴露。

### 数据表

9 张表。8 张业务表由 v1 `init` 建立，v2 `message_lines` 又给 `messages` 加了一列。

| 表 | 主要字段 | 用途 |
|---|---|---|
| `users` | `id`、`username`、`password_hash`、`enabled`、`created_at`、`updated_at`、`last_login_at` | 账号。`username` 唯一；`enabled = 0` 表示禁用 |
| `sessions` | `id`（token 的 sha256）、`user_id`、`created_at`、`expires_at`、`last_seen_at` | 登录状态。只存哈希，明文 token 只在 cookie 里 |
| `people` | `id`、`user_id`、`display_name`、`relationship_type`、`relationship_json`、`archived`、`created_at`、`updated_at` | 一段关系（一个人）。`relationship_json` 是界面填的关系语境 |
| `conversations` | `id`、`user_id`、`person_id`、`title`、`source`、`archived`、`created_at`、`updated_at` | 一段聊天。`source` 默认 `paste` |
| `messages` | `id`、`user_id`、`conversation_id`、`sender`、`content`、`sent_at`、`source_message_id`、`media_kind`、`line_json`、`created_at` | 原始消息，分析链路的证据来源。`line_json` 存第一层（Jev）的逐句结果 |
| `person_profiles` | `person_id`、`user_id`、`schema_version`、`profile_json`、`version`、`created_at`、`updated_at` | 长期档案，整体 JSON + 乐观锁 |
| `analysis_runs` | `id`、`user_id`、`person_id`、`conversation_id`、`kind`、`model`、`prompt_version`、`created_at`、`latency_ms`、`boundary_retried`、`violation_codes`、`input_tokens`、`output_tokens`、`result_json` | 每次分析的计量与最终结果 |
| `feedback` | `id`、`user_id`、`person_id`、`conversation_id`、`kind`、`context_key`、`verdict`、`reasons`、`note`、`created_at` | 解读反馈 / 确认 / 纠错，`kind` 分开存放，语义不混 |
| `schema_migrations` | `version`、`name`、`applied_at` | 已执行的 migration 记录 |

**为什么第一层结果存在 `messages.line_json` 而不是单独一张表**：它与消息一对一、生命周期完全一致（删消息就该一起删），JSON 列不需要额外 JOIN，也不会出现"消息没了但观察还在"的孤儿行。写入点在 `/api/analyze` 成功之后（服务端自己知道结果，不经过客户端）；读取时随 `GET /api/conversations/:id/messages` 一起返回，前端用它把标签直接恢复出来 —— 换设备或刷新页面**不需要重新调用 Jev**。坏 JSON 只丢那一条的标签，不影响消息本身。

`people`、`conversations`、`messages`、`person_profiles`、`analysis_runs`、`feedback` 都带 `user_id`：既是级联删除的入口，也是资源隔离的过滤条件。所有资源查询一律写成 `WHERE id = ? AND user_id = ?`。

两个关键约束：

| 约束 | 位置 | 作用 |
|---|---|---|
| `UNIQUE(conversation_id, source_message_id) WHERE source_message_id IS NOT NULL` | `messages` 的唯一索引 `idx_messages_dedupe` | 去重的**硬保证**：同一段对话里同一个外部消息 id 只能有一条。应用层算错也不会写进第二条，重复导入不重复累计 |
| `UNIQUE(user_id, display_name)` | `people` 表 | 同一账号下不允许两个人重名（`POST /api/people` 撞上返回 409）；不同账号之间可以重名，互不影响 |

### migration 机制

`MIGRATIONS` 是 `{ version, name, sql }` 的数组，只追加，不修改。已发布的 SQL 不允许改动 —— 需要调整时新增一条 migration，老库与新库走同一条路径。

启动时 `openDatabase()` 自动跑：

1. `CREATE TABLE IF NOT EXISTS schema_migrations`；
2. 读出已应用的 `version` 集合；
3. 逐个跳过已应用的，其余在 `BEGIN` / `COMMIT` 里执行 SQL 并插入 `schema_migrations(version, name, applied_at)`；失败则 `ROLLBACK` 后抛错，服务启动失败而不是带着半截 schema 跑。

`SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version` 始终等于最新 migration 的版本号，`/api/health` 与导出文件里的 `schemaVersion` 都用它。CLI 另提供 `npm run db:migrate` / `db:stats` / `db:backup`。

### 认证设计

| 项 | 实现 |
|---|---|
| 密码哈希 | Argon2id（`@node-rs/argon2` 的 `hash` / `verify`），参数：`memoryCost = 19456`、`timeCost = 2`、`parallelism = 1`。改动参数必须递增，否则旧哈希无法验证 |
| 存什么 | 只存哈希，明文密码不落库、不落日志、不进任何响应 |
| 密码长度 | 至少 `PASSWORD_MIN_LENGTH = 8` 位，上限 200（schema 层） |
| 用户名 | `normalizeUsername()`：小写字母、数字、下划线、点、减号，2–32 位，首字符必须是字母或数字；一律转小写 |
| 登录限速 | 按「IP + 用户名」计数：15 分钟窗口（`WINDOW_MS`）内失败 5 次（`MAX_ATTEMPTS`）即封禁 15 分钟（`BLOCK_MS`），命中时返回 429 与剩余分钟数；登录成功 `clearLoginFailures()` 清零 |
| 账号枚举 | 用户名不存在、密码错误、账号被禁用一律返回同一句「用户名或密码不正确」，不区分原因 |
| 不改动的语义 | 不开放自助注册。建号、禁用、启用、改密都由管理员用 CLI：`npm run user:add` / `user:disable` / `user:enable` / `user:passwd` / `user:list`（`scripts/user-cli.ts`），密码只在终端交互输入，不接受命令行参数 |

### session 设计

| 项 | 实现 |
|---|---|
| token | `randomBytes(32).toString("base64url")`，32 字节随机值 |
| 库里存什么 | 只存 `sha256(token)` 的十六进制串，作为 `sessions.id`；明文 token 只出现在 cookie 里。比对用 `timingSafeEqual` |
| cookie | 名 `cm_session`（`SESSION_COOKIE_NAME`），属性 `Path=/`、`HttpOnly`、`SameSite=Lax`、`Max-Age`；`Secure` 由环境变量 `COOKIE_SECURE` 控制，上了 HTTPS 必须开 |
| 有效期 | `SESSION_TTL_MS = 30 天`；`expires_at` 过期即失效 |
| `last_seen_at` | 节流刷新：距上次记录不足 60 秒不写库 |
| 改密 / 禁用 | `setUserPassword()` 与 `setUserEnabled(false)` 会删掉该用户全部 session，旧登录态立即失效；`POST /api/auth/password` 改密后同样删除并清 cookie，返回 `relogin: true` |
| 过期清理 | `purgeExpiredSessions()`：启动时执行（`startupMaintenance()`，启动日志会打印清理条数），请求校验时遇到过期 session 也顺手删除 |
| 登出 | `POST /api/auth/logout` 删除该 session 并回写 `Max-Age=0` 的 cookie |

认证中间件 `createAuthMiddleware(db)` 导出 `requireAuth` 与 `requireSameOrigin`，业务接口与分析接口共用同一套，保证 `/api/analyze`、`/api/deep-analysis` 与 `/api/people/*` 的认证口径一致。

### 用户隔离是硬要求

三条规则，全文件适用：

1. 身份只来自 session：`req.auth.userId` 由 `resolveSession()` 推导，**从不**采信请求体或查询串里的 `user_id`；
2. 每个资源级查询都带 `user_id = ?`，等价于 `WHERE id = ? AND user_id = currentUserId`；
3. 前端传什么 id 都只是「想操作哪个资源」，能不能操作由服务端查出来的归属决定。

反例（错法）：

| 错法 | 后果 |
|---|---|
| `SELECT * FROM people WHERE id = ?` | 任何登录用户拿到别人的 person id 就能读到对方的人、档案与对话 |
| `UPDATE person_profiles SET ... WHERE person_id = ?` | 能覆盖别人的档案，甚至把乐观锁版本推到双方都对不上 |
| `DELETE FROM conversations WHERE id = ?` | 能删掉别人的聊天与消息（外键级联会连消息一起带走） |
| 改从 body 读 `userId` | 隔离直接失效：改一个字段就能读到任意账号的数据 |

正确写法统一走 `findPerson(db, userId, personId)` / `findConversation(db, userId, conversationId)`，它们内部就带 `AND user_id = ?`，查不到一律 `notFound()`（404「资源不存在或不属于当前账号」）。跨账号传合法 id 返回 404 而不是 403，避免泄漏「这个 id 存在」。

### conversation / message 存储

| 层 | 取值 |
|---|---|
| DB | `sender ∈ ('self','counterpart')`，由 `CHECK` 约束保证 |
| API | `sender ∈ ('self','other')`，`toApiSender()` 读时映射，`toDbSender()` 写时反向映射 |
| 输入 schema | 为兼容旧客户端同时接受三种写法（`z.enum(["self","other","counterpart"])`），落库前一律归一化 |

这样 `shared/types.ts` 的 `Message.sender`（`self` / `other`）不需要知道 DB 的用词，前端也只认 `self` / `other`。

消息去重：`source_message_id` 或导入指纹。规则是 —— 客户端带了外部消息 id 就用它；没带时用 `sender | sentAt | content` 作为种子，加上**该内容在本次导入里出现的第几次**（从 1 开始），拼成 `sender|sentAt|content|#N` 后取 sha256 前 40 位作为 `source_message_id`（`fp:` 前缀）。

| 设计点 | 原因 |
|---|---|
| 指纹里含出现次数 | 容纳「同一秒发了两条一模一样的话」这种真实情况，第一条与第二条不会被当成同一条 |
| 位置索引**不**进指纹 | 位置一进指纹，同一批消息换一次顺序就变成全新消息，重复导入必然重复入库 |
| 写入用 `INSERT OR IGNORE` | 冲突判定的最终裁决是 `idx_messages_dedupe` 唯一索引，不依赖应用层先查后写 |
| 返回 `{ added, skipped }` | 调用方（含测试）能直接看到「新增几条、跳过几条」 |

导入 API `POST /api/import` 的完整流程，整段在一个事务里：

1. 校验入参（最多 2000 条消息，单条 `content ≤ 4000`）；
2. 找或建 person：带 `personId` 就查（不属于当前账号直接报错），否则用 `displayName` 找同账号同名的人，没有才新建（`contextFromRelation(relationshipType ?? "crush")`）；
3. 找或建 conversation：带 `conversationId` 就查并校验它与 person 匹配，否则新建（`title`、`source ?? "paste"`）；
4. `insertMessages()` 按上面的规则批量去重写入，返回 `added` / `skipped`；
5. 更新 `conversations.updated_at` 与 `people.updated_at`；
6. 返回 `{ personId, conversationId, added, skipped, profileVersion }`。

**导入不触发任何模型分析**：这条路径只写消息，不调用 Jev，也不调用 DeepSeek。导入完成后是否分析由用户点击决定，档案版本原样带回，不做任何隐式更新。

### PersonProfile 存储方式

整份档案以 JSON 存在 `person_profiles.profile_json`（`src/storage.ts` 的 `validateProfile` 负责结构），不拆成关系表。

| 环节 | 实现 |
|---|---|
| 写前 | `validateProfile(body.profile)`，返回 `null` 就拒绝写入（400「档案结构不合法，已拒绝写入」）；字段级语义仍由 `shared/types.ts` 定义，不在服务端重写一套 |
| 读时 | `JSON.parse` → `validateProfile`，结构不合法的部分按规则丢弃/重算（`feedbackStats` 永远由 `confirmations` / `corrections` 重算） |
| 损坏数据 | `parseStoredProfile()` 捕获异常返回 `null`，等价于「还没有档案」，接口不会因为一条坏 JSON 挂掉；分析路径同理，坏档案只让这次分析按无档案处理 |
| 不拆表的原因 | 第一版不按字段查询：档案的读取单位始终是「整份」，字段级检索由 `retrieveRelevantProfileContext` 在内存里做。拆成几十张表只是把同一份口径复制到两处 |

两个字段容易混：

| 字段 | 含义 | 变了会怎样 |
|---|---|---|
| `schema_version` | 档案**结构**版本，写入时取 `PROFILE_SCHEMA_VERSION`（当前 2） | 结构升级时递增，旧档案需要迁移 |
| `version` | **乐观锁**版本，整数，从 1 开始，每次成功写入 +1 | 与结构无关，是并发控制的依据；前端 409 里拿到的就是它 |

### 乐观锁

写入一律是 `UPDATE person_profiles SET ... WHERE person_id = ? AND user_id = ? AND version = ?`。受影响行数为 0 就说明期间有别人改过：

| 情况 | 服务端行为 | 前端行为 |
|---|---|---|
| `expectedVersion` 命中 | 200，返回新的 `version`（旧版本 + 1） | 更新本地版本号 |
| `expectedVersion` 不命中 | 409 `{ error: "档案已被其他设备修改", conflict: true, version: <当前版本> }` | 抛出 `ConflictError`，重新拉取最新档案，并把冲突提示交给 UI（「这份档案刚被另一台设备修改过，已为你刷新到最新版本」），不静默覆盖 |
| 首次写入（`expectedVersion = 0`） | `INSERT`；若因并发已存在则转成更新路径 | 同上 |

档案增量操作 `POST /api/people/:id/profile/ops` 在同一事务内做两件事：先按 `expectedVersion` 与当前版本比对（不等直接返回 409），再执行纯函数并把新档案写回（`expectedVersion` 用事务内读到的当前版本）。

**第一版不做 CRDT**：没有字段级合并、没有自动冲突消解。两个设备几乎同时改同一份档案时，后来者拿到 409，由用户决定下一步，而不是由系统猜。

### 档案更新的位置变化

| 阶段 | 编排在哪儿 | 存档在哪儿 |
|---|---|---|
| 第三阶段 | 浏览器控制器（`src/useProfile.ts` 的 `commit()`），前端自己算档案 | 浏览器 `localStorage` |
| 第四阶段 | `shared/profile-ops.ts` 的纯函数，**服务端调用** | 服务端 `person_profiles` |

`shared/profile-ops.ts` 提供五个函数：`commitConversationToProfile`（会话并入档案：基线 / 习惯 / 事实 / 事件 / 推断候选 / 已知模式）、`confirmInProfile`、`correctInProfile`、`removeMemoryFromProfile`、`resetBaselineInProfile`；`applyFeedbackStats` 用来把 `feedback` 表里的解读反馈算进统计。它们是纯函数：不读当前时间（`now` / `at` 由调用方传）、不做 IO、不依赖 `localStorage`，同样的输入必定得到同样的输出。

服务端在 `/people/:id/profile/ops` 里按 `op` 调用这些函数：`commit`（消息由服务端从 SQLite 读，只有 `observations` 与 `conversationId` 来自客户端）、`confirm`、`correct`、`removeMemory`、`resetBaseline`。

要点是**口径只有一份**：浏览器与服务端运行的是同一份代码，不是「前端算一套、服务端再算一套」。前端不再本地计算档案内容，只发请求。

### 前端改造

| 文件 | 变化 |
|---|---|
| `src/api.ts` | 服务端 API 客户端。所有请求 `credentials: "include"`（cookie 决定身份）；非 GET 请求带 `X-Requested-With: crush-monitor` 头；401 抛 `AuthError`、409 抛 `ConflictError`（带当前 `version`）、其余非 2xx 抛 `ApiError` |
| `src/useAuth.ts` | 登录态：页面加载时探一次 `/api/auth/me`，401 即未登录。真相源在服务端，前端不保存长期身份凭证 |
| `src/useWorkspace.ts` | 工作区状态：people / person / conversations / profile / version、`ensureRemote()`（把本地解析出的消息同步到服务端并取回带服务端 id 的消息）、`loadMessages()`、`commit` / `confirm` / `correct` / `removeMemory` / `resetBaseline`（都走 `api.profileOp()`）、旧数据迁移状态；`versionRef` 保存乐观锁版本，收到 `ConflictError` 就重新拉档案并把提示交给 UI（`conflict` 字段） |
| `src/App.tsx` | `auth.status === "anon"` 时渲染登录页 `LoginPage`，其余渲染主界面；旧数据迁移提示也在这一层（`ws.legacy`） |

浏览器**只保留 UI 状态与草稿**：当前选中的人与对话、输入框内容、待展示的冲突与迁移提示、本地记录的乐观锁 `version`。这些都不是真相源，刷新页面后一律以服务端返回为准。

### 旧 localStorage 数据迁移

只在用户点确认后才上传，**绝不静默上传**：

| 步骤 | 实现 |
|---|---|
| 检测 | `useWorkspace` 挂载时调 `detectLegacyProfile()`（内部先看 `legacyMigrated()`，再读旧档案）；有数据则进入 `detected` 状态 |
| 提示 | `App.tsx` 展示旧数据摘要（档案 / 记忆 / 习惯 / 模式 / 已确认条数），只读 `summarizeLegacy()` 的结果，此时**没有任何请求发出** |
| 用户确认 | 点「迁移」才进入 `migrating`：`loadLegacySnapshot()` 读快照 |
| 上传 | 逐份 `PUT /api/people/:id/profile`（带上服务端当前 `version`）。服务端已有档案时**跳过**并在报告里说明，不覆盖服务器数据 |
| 标记 | 成功后 `markLegacyMigrated()` 写入 `crush-monitor.migrated.v1`（`MIGRATED_KEY`）；点「不用了」也写同一个键，避免反复打扰 |
| 报告 | 逐项列出「已导入 X：记忆 N 条、习惯 N 条、模式 N 条」或「已跳过」 |

**旧版本没有持久化聊天记录**，所以第四阶段没有可迁移的会话：`loadLegacySnapshot()` 的 `conversations` 恒为空数组（`LegacySummary.conversations` 字段保留但恒为 0）。档案内部结构的迁移仍由 `migrateProfilePayload()` 负责，规则不变。

### 分析接口的改造

| 接口 | 有 `conversationId` | 没有 `conversationId` |
|---|---|---|
| `POST /api/analyze` | 先按 `id + user_id` 校验对话归属，再从 `messages` 读最近 240 条（`ORDER BY COALESCE(sent_at, created_at) DESC, id DESC LIMIT 240` 后反转成升序），组装成 Jev 输入；客户端自带的 `messages` 被服务端读出的数据取代 | 保留兼容的一次性分析模式：直接用请求体里的消息，**不落盘、无任何持久化副作用** |
| `POST /api/deep-analysis` | 校验归属后从 SQLite 读消息（最近 `DEEP_CONTEXT_WINDOW * 3` 条）、读 `person_profiles` 的档案并做 `retrieveRelevantProfileContext()` 检索，`memory` 由服务端填充；请求体里的 `profile` 只当参考、不写库 | 一次性路径：用请求体里的 `messages` / `memory` / `profile`，同样不落盘 |

共同点：

- 两个接口都走 `requireSameOrigin` + `requireAuth`，身份与业务接口同源；
- 客户端只能指定「分析哪段对话」与第一层产出的 `observations`，不能指定长期档案内容；
- 档案损坏时按「没有档案」处理，这次分析照常进行；
- 分析链路的每一环（Jev / Pattern / Baseline / DeepSeek / Boundary / UserTranslation）都没改，改的只是输入来自哪儿。

### analysis_runs 记录什么

| 记录 | 字段 |
|---|---|
| 归属 | `user_id`、`person_id`、`conversation_id` |
| 身份 | `kind`（`jev` / `deep`）、`model`、`prompt_version` |
| 计量 | `created_at`、`latency_ms`、`input_tokens`、`output_tokens` |
| 安全过程 | `boundary_retried`（是否因边界保护重试）、`violation_codes`（违规**类别**代码，不存原文） |
| 结果 | `result_json`：最终安全结果（第二层是 `{ analysis, translation }`，即已经过 Boundary 与翻译过滤的成品） |

**不记录**：隐藏推理过程、首次违规的原文、完整的 prompt、任何密钥。

这些数据用于三件事：`GET /api/analysis-runs` 审计、`GET /api/account/usage` 配额统计（按用户统计运行次数与 token，第一版只做展示不做计费）、出问题时按 `runId` 定位。第一层的 `/api/analyze` 也写一条 `kind = "jev"` 的记录，但不带 `result_json`。

### 删除与导出

级联规则（都靠外键 + `ON DELETE CASCADE`，并在事务里执行）：

| 操作 | 结果 |
|---|---|
| 删 person（`DELETE /api/people/:id`） | `conversations` → `messages` / `person_profiles` / `analysis_runs` / `feedback` 一起走 |
| 删 conversation（`DELETE /api/conversations/:id`） | 消息与挂在这次对话上的运行记录、反馈一起走；**档案保留**（`person_profiles` 挂在 person 上，与单次对话无关） |
| 删账号数据（`DELETE /api/account/data`） | 清掉该账号的 `people`（级联带走其余），再兜一次没有挂 person 的 `conversations` / `person_profiles` / `analysis_runs` / `feedback`；**账号本身保留**，只有管理员能用 CLI 删号 |

导出（`GET /api/account/export`）：

- 只包含当前账号的数据：`account`（id 与用户名）、`people`、`conversations`、`messages`、`profiles`、`feedback`、`analysisRuns`、`exportedAt`、`schemaVersion`；
- 每个查询都带 `WHERE user_id = ?`，导出范围就是这个人自己的数据；
- **不含任何密钥**：没有 `password_hash`、没有 session、没有 API key，`users` 表只取 id 与用户名；
- 响应带 `Content-Disposition: attachment; filename="crush-monitor-export.json"`。

### 安全措施清单

已实现：

| 措施 | 实现位置 |
|---|---|
| 业务接口全部要求认证 | `createAuthMiddleware` 的 `requireAuth`，`/api/analyze` 与 `/api/deep-analysis` 也挂 |
| session token 只存哈希 | `hashToken()`（sha256），明文只在 cookie |
| 资源隔离 | 每个查询 `AND user_id = ?`，身份只来自 session |
| 密码哈希 | Argon2id（19456 / 2 / 1），不自己实现算法 |
| 登录限速 | 15 分钟 5 次 → 封禁 15 分钟，按 IP + 用户名 |
| API 限流 | `/api/analyze`：按「用户 + IP」180 次/分钟、全局每小时 3000 次、并发 8；`/api/deep-analysis`：60 次/分钟、并发 2 |
| CSRF | 非 GET 请求必须带 `X-Requested-With: crush-monitor`，或 `Origin` / `Referer` 与 `Host` 同源（`requireSameOrigin`）；`SameSite=Lax` 是第三层保险 |
| 请求体上限 | `express.json({ limit: "1mb" })`，超限返回 413 |
| 响应头 | `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`Cache-Control: no-store`；`app.disable("x-powered-by")` |
| 错误信息 | 对外只说「输入格式或体积不受支持」，不返回 stack 与内部细节 |
| 日志脱敏 | 见下一节；测试里直接断言聊天正文不进日志 |
| bundle 无密钥 | 密钥只在服务端环境变量；测试断言构建产物中没有 key |
| 数据库不在静态目录 | `data/` 不经 `express.static` 暴露 |
| 备份 | `backupDatabase()` 基于 `node:sqlite` 的 online backup，一致性快照 |

**尚未实现：HTTPS**。原因很直接 —— 当前没有域名，没有可签证书的地址。上线域名与证书后需要设置 `COOKIE_SECURE=true`（否则 cookie 不带 `Secure`），并在反向代理后设置 `TRUST_PROXY=true` 才能拿到真实 IP 用于限速。细节见 `DEPLOYMENT.md`。

### 日志规范

允许记录（对照 `server/index.ts` 的实际格式）：

| 内容 | 例子 |
|---|---|
| 用户 id、路由、状态码、延迟 | `[analyze] user=u_ab12 route=/api/analyze status=200 latency=1834ms tokens=1200/260` |
| token 用量 | 同上 `tokens=a/b` |
| 边界处理计数与违规**类别** | `[deep-analysis] ... softened=1 removed=0 retried=true history=established codes=manipulative_advice` |
| 模型与失败原因类别 | `model=deepseek-flash status=error code=timeout` |
| 数据库错误码 | `[error] <ErrorName> code=<SQLITE_CODE>` |
| 启动信息 | 端口、数据库**路径**、schema 版本、key 是否配置、第二层是否开启、清理的过期 session 数 |

禁止记录：

- 密码、密码哈希、session token（明文或哈希）；
- API key（`TYPESAFE_API_KEY` / `DEEPSEEK_API_KEY`）；
- 聊天正文、记忆内容、纠错原话；
- 隐藏推理、首次违规的原文、完整 prompt；
- request body 与 cookie 原文。

错误日志同理：`[analyze] user=... status=<code>`、`[deep-analysis] ... status=... code=...` 只记状态与错误代码类别，不记内容。

### 测试

服务端集成测试（`tests/server.test.ts`，22 个用例）的做法：

| 做法 | 实现 |
|---|---|
| 真实 HTTP | 起一个真的 express 实例监听随机端口（`app.listen(0, "127.0.0.1")`），用 `fetch` 打 `/api/*`，不 mock 路由层 |
| 真实 cookie | 从 `Set-Cookie` 里取出 `cm_session=...`，后续请求原样带上；也真的走 CSRF 头 |
| 内存 SQLite | 每个用例 `openDatabase(":memory:")`，互不影响；不碰 `data/` 下的真实库 |
| 不调用真实模型 | 全程不调用 Jev 与 DeepSeek；只验证路由、隔离、存储与计量 |

覆盖的点：密码哈希与登录（含禁用账号、账号枚举防护）、session 过期与清理、logout 使 session 立即失效、未认证一律 401、CSRF 拦截、跨账号读写删隔离、同名 person 可在不同账号共存、重复导入不重复入库、重复导入不让基线重复累计、乐观锁 409 不静默覆盖、非法档案被拒与损坏档案不挂接口、旧本地数据未确认不上传、多设备同账号看到同一份档案、删除的级联范围、导出的数据范围与「不含密钥」、token 用量按账号分开统计、日志不含聊天正文、前端构建产物不含密钥、session token 高熵且库里只有 hash。

测试总数从第三阶段的 186 增加到 208（新增 22 个服务端集成用例），`npm test` 全部通过。

### 第四阶段明确不做

- WebSocket 实时协同（多设备靠重新拉取与乐观锁，不做推送）
- CRDT / 自动冲突合并（冲突显式暴露给用户）
- 把 PersonProfile 拆成几十张关系表
- 微服务、独立后端服务拆分
- Docker / 容器化部署
- 开放注册（账号只能由管理员用 CLI 创建）
- 改动 Jev / DeepSeek / Boundary / Pattern 的核心逻辑（本阶段只搬存储与身份，不动分析口径）

## 本阶段仍未做的事情

- 自动发送/回复微信消息，自动读取微信数据库，后台监听
- 猜测现实关系，替用户决定下一步做什么
- 用单一数字表示「对方有多喜欢我」
- 把模型猜测升格为事实（`model_inferred` 永不自动变成 `user_confirmed`）
- 让模型自由文本自动形成长期行为模式（`KnownPattern` 只能来自程序统计或用户确认）
- 目标消息级解读（`targetId` 目前恒为 `null`）
- 真实 DeepSeek 调用的验证（缺 key）
