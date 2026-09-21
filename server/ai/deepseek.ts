import { z } from "zod";
import { mediaPromptText } from "../../shared/media";
import { describePatterns, describePatternTrend } from "../../shared/patterns";
import {
  describeHistoricalDeltas,
  describeHistoricalTrend,
} from "../../shared/profile";
import { describeProfileContext } from "../../shared/retrieval";
import {
  DEEP_ANALYSIS_DEFAULT_BASE_URL,
  DEEP_ANALYSIS_DEFAULT_MODEL,
  DEEP_ANALYSIS_PROMPT_VERSION,
  type BoundaryMeta,
  type BoundaryViolationCode,
  type DeepAnalysis,
  type DeepAnalysisRequest,
  type DeepAnalysisStatus,
} from "../../shared/types";
import { enforceBoundary, type BoundaryViolation } from "./boundary";
import { normalizeMessageReferences } from "./references";
import {
  DeepAnalysisError,
  type InterpretationOutcome,
  type InterpretationProvider,
} from "./types";

/**
 * 第二层：DeepSeek 解释器。
 *
 * 设计要点：
 *   1. 只负责解释，不重新生成情绪/意图概率，也不计算长期趋势数字。
 *   2. 使用官方 Responses API 的 JSON Schema 结构化输出，不引入任何 SDK。
 *   3. 任何失败都被包成 DeepAnalysisError，绝不会冒泡成第一层故障。
 *   4. 输出必须通过 Interpretation Boundary（见 boundary.ts）。
 *   5. 本文件不打印任何聊天内容。日志只由上层记录
 *      model / latency / success / token usage。
 */

const DEFAULT_TIMEOUT_MS = 45_000;

/** 边界违规或结构损坏时最多安全重试 1 次。不允许无限重试。 */
export const MAX_BOUNDARY_RETRIES = 1;

/** 重试时追加的指令：只基于可观察证据重写。 */
export const BOUNDARY_RETRY_NOTE = [
  "上一份输出违反了解释边界。",
  "请只基于可观察证据重写：不得做人格或精神诊断，不得断言对方内心，",
  "不得给出操纵、欺骗或胁迫性建议，不得输出任何概率或百分比数字。",
].join("");

export type DeepSeekConfig = {
  /** 第一层与第二层的总开关，默认关闭。 */
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  promptVersion: number;
  timeoutMs: number;
};

/** 从环境变量读取配置。参数化以便测试，不读真实 env 也能构造。 */
export function readDeepSeekConfig(
  env: Record<string, string | undefined> = process.env,
): DeepSeekConfig {
  const timeout = Number(env.DEEP_ANALYSIS_TIMEOUT_MS);
  const version = Number(env.DEEP_ANALYSIS_PROMPT_VERSION);
  return {
    enabled: (env.DEEP_ANALYSIS_ENABLED || "").trim().toLowerCase() === "true",
    apiKey: (env.DEEPSEEK_API_KEY || "").trim(),
    baseUrl: (env.DEEPSEEK_BASE_URL || DEEP_ANALYSIS_DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    model: (env.DEEP_ANALYSIS_MODEL || DEEP_ANALYSIS_DEFAULT_MODEL).trim(),
    promptVersion:
      Number.isFinite(version) && version > 0
        ? version
        : DEEP_ANALYSIS_PROMPT_VERSION,
    timeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// 系统指令：把「不做读心术」写成硬约束
// ---------------------------------------------------------------------------

export const DEEP_ANALYSIS_INSTRUCTIONS = [
  "你在帮助一个逻辑能力强、但不擅长识别暗示、语气、潜台词和关系细微变化的人读懂一段中文聊天。",
  "你的工作不是读心，也不是替他做决定，而是把这段交流里值得注意的社会信号翻译成结构化、可解释、可复盘的信息。",
  "",
  "必须遵守：",
  "1. 不做读心术。只能依据给定文本推断，不得假定看不到的线下关系、附件内容、性别或历史。",
  "2. 严格区分可能性与事实。「对方可能有点不高兴」可以；「对方不高兴」除非证据非常明确，否则禁止。",
  "3. 禁止输出任何概率、百分比、分数。不要写「对方喜欢你 82%」这类伪精确数字。",
  "4. 不要重新判断情绪或意图的类别与概率。那已经由第一层模型给出，见 observations，你只能引用。",
  "5. 不要自己计算或改写长期趋势数字。那已经由程序算好，见 patterns，你只能解释它们的含义。",
  "6. 不要用单条消息推断长期关系。长期判断必须建立在 patterns 和 memory 上。",
  "7. 证据不足时明确写出不确定，而不是给出一个听起来确定的猜测。",
  "8. 不要写成命令式的关系建议。nextAction 只写「值得注意的方向」，不要写「你应该发消息」这类指令。",
  "9. 禁止声称知道对方的真实内心。不要写「她就是…」「她其实…」「她一定…」「她内心…」，除非是在引用原话。",
  "10. 禁止诊断对方的人格或精神状态，禁止使用回避型、焦虑型、人格障碍等标签去描述对方。",
  "11. 禁止操纵性建议，例如故意冷淡、欲擒故纵、让对方吃醋、策略性回复。",
  "12. 禁止根据性别做一般化推断。",
  "13. 禁止用单条消息推断长期关系结论，例如「她从来不在乎你」。",
  "14. 关系背景（relationshipContext）只是先验语境，不是结论：它只能调整同一行为的解读权重，不能覆盖证据。",
  "15. 不要因为关系类型是 crush 就把普通关心解释成暧昧，也不要因为是 friend 就拒绝识别潜在信号。同样的行为在不同关系背景下意义可能不同，但关系类型不能替代证据。",
  "16. 互动投入趋势由程序计算并给出，你只能解释它的原因，不能把它改成别的方向。若你认为与实际不符，写在 alternativeInterpretations 或 contradiction 里。",
  "",
  "第三阶段补充规则（跨会话基线）：",
  "17. 输入里的 profileContext 每条都带来源标签：【用户确认】权重最高，【观察事实】次之，【模型推断·弱背景】只能作为弱背景，不得当作事实使用。",
  "18. 【用户确认】的内容与你的判断冲突时，以用户确认为准，并在 contradiction 里说明冲突，而不是坚持自己的读法。",
  "19. 历史基线（historicalBaseline / historicalDeltas）由程序计算，你只能解释它的含义：不得自己算 delta，不得改写数值，不得把它说成感情变化。",
  "20. 「她平时就是这样」的指标不构成变化。若某个指标本次与她平时接近，不要把它列为信号；【表达习惯】里列出的高频表达（例如「哈哈」）属于个人语言习惯，不得单独解读成情绪、暧昧或掩饰。",
  "21. 基线状态为 none / insufficient 时，禁止写「她平时如何」「和以前不一样」「她一直是」这类跨会话判断；此时只在 historicalNote 里说明历史样本不足。",
  "22. 跨会话比较只能描述**可观察的行为变化**（比平时回得慢、比平时短、比平时少主动），不得升级成关系结论（她变冷淡了、她对你不感兴趣了），也不得给出人格标签或喜欢概率。",
  "23. historicalNote 只能补充「这次与她平时相比」的含义，可以写 null。数字部分由程序给出，你不得重复计算或修改。",
  "24. 输入里的所有数字（patterns、historicalBaseline、historicalDeltas、history）都是程序算出的原始值，只能原样引用或改写成相对描述（比平时更长/更慢）。不得把它们换算成百分比、倍数、比例或任何形式的概率，也不得据此给出关系成立的可能性。",
  "25. 【已知模式·程序统计】是达到证据门槛（至少 3 段不同对话，涉及一起活动这类关系解释需要 4 段）的程序结论，比你的推断可信；【模型推断·弱背景】只是待验证的猜测，不得独自形成长期结论，也不得被写成「她就是这样的人」。",
  "26. 你没有任何权限把猜测变成长期结论。只有用户确认过的内容（【用户确认】）才是事实；其余都必须在措辞上保持可能性。",
  "",
  "回答时请覆盖这几点：",
  "- 当前发生了哪些值得注意的社会信号（surfaceSignals）",
  "- 这些信号可能意味着什么（latentEmotion / latentIntent）",
  "- 有没有多个合理解释（alternativeInterpretations），以及哪个当前证据更充分",
  "- 什么信息仍然不知道（uncertainty）",
  "- 是否出现了相对于既有模式或记忆的转折（turningPoint / trend / contradiction）",
  "- 用户本人可能漏看了什么",
  "- 如果需要行动，什么原则值得注意（nextAction）",
  "",
  "只输出符合给定 JSON schema 的内容，不要任何额外文字。",
].join("\n");

// ---------------------------------------------------------------------------
// 输出结构：JSON Schema 给模型，zod 在本地做严格校验
// ---------------------------------------------------------------------------

const readingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reading", "basedOn", "conflictsWith"],
  properties: {
    reading: { type: "string" },
    basedOn: { type: "array", items: { type: "string" } },
    conflictsWith: { type: "array", items: { type: "string" } },
  },
} as const;

export const DEEP_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "surfaceSignals",
    "latentEmotion",
    "latentIntent",
    "conversationState",
    "trend",
    "turningPoint",
    "alternativeInterpretations",
    "evidence",
    "contradiction",
    "uncertainty",
    "nextAction",
    "historicalNote",
  ],
  properties: {
    status: {
      type: "string",
      enum: ["ok", "insufficient_context"],
      description: "证据是否足以做出解释",
    },
    summary: { type: "string", description: "这段交流发生了什么，一段话" },
    surfaceSignals: {
      type: "array",
      items: { type: "string" },
      description: "表层可观察到的信号，不含推断",
    },
    latentEmotion: readingSchema,
    latentIntent: readingSchema,
    conversationState: {
      type: "object",
      additionalProperties: false,
      required: ["reading", "surfaceSignals"],
      properties: {
        reading: { type: "string" },
        surfaceSignals: { type: "array", items: { type: "string" } },
      },
    },
    trend: {
      type: "string",
      enum: ["warming", "stable", "cooling", "uncertain"],
      description: "必须与 patterns 中的数字一致，不得凭空判断",
    },
    turningPoint: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["description", "messageId"],
          properties: {
            description: { type: "string" },
            messageId: { type: ["string", "null"] },
          },
        },
        { type: "null" },
      ],
    },
    alternativeInterpretations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "interpretation",
          "supportingEvidence",
          "contradictingEvidence",
        ],
        properties: {
          interpretation: { type: "string" },
          supportingEvidence: { type: "array", items: { type: "string" } },
          contradictingEvidence: { type: "array", items: { type: "string" } },
        },
      },
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["messageId", "quote", "sender", "timestamp"],
        properties: {
          messageId: { type: "string" },
          quote: { type: "string" },
          sender: { type: "string", enum: ["self", "other"] },
          timestamp: { type: ["string", "null"] },
        },
      },
    },
    contradiction: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["description", "against", "messageIds"],
          properties: {
            description: { type: "string" },
            against: { type: ["string", "null"] },
            messageIds: { type: "array", items: { type: "string" } },
          },
        },
        { type: "null" },
      ],
    },
    uncertainty: { type: "string", enum: ["low", "medium", "high"] },
    historicalNote: {
      type: ["string", "null"],
      description:
        "对「这次与她平时相比」的程序化数字的补充解释；历史不足或无需补充时为 null",
    },
    nextAction: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["direction", "principle"],
          properties: {
            direction: { type: "string" },
            principle: { type: ["string", "null"] },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

const reading = z.object({
  reading: z.string().min(1).max(600),
  basedOn: z.array(z.string()).max(24),
  conflictsWith: z.array(z.string()).max(24),
});

export const deepAnalysisOutput = z.object({
  status: z.enum(["ok", "insufficient_context"]),
  summary: z.string().min(1).max(2000),
  surfaceSignals: z.array(z.string().min(1)).max(12),
  latentEmotion: reading,
  latentIntent: reading,
  conversationState: z.object({
    reading: z.string().min(1).max(600),
    surfaceSignals: z.array(z.string().min(1)).max(12),
  }),
  trend: z.enum(["warming", "stable", "cooling", "uncertain"]),
  turningPoint: z
    .object({
      description: z.string().min(1).max(600),
      messageId: z.string().nullable(),
    })
    .nullable(),
  alternativeInterpretations: z
    .array(
      z.object({
        interpretation: z.string().min(1).max(600),
        supportingEvidence: z.array(z.string()).max(24),
        contradictingEvidence: z.array(z.string()).max(24),
      }),
    )
    .max(5),
  evidence: z
    .array(
      z.object({
        messageId: z.string(),
        quote: z.string().max(600),
        sender: z.enum(["self", "other"]),
        timestamp: z.string().nullable(),
      }),
    )
    .max(20),
  contradiction: z
    .object({
      description: z.string().min(1).max(600),
      against: z.string().nullable(),
      messageIds: z.array(z.string()).max(20),
    })
    .nullable(),
  uncertainty: z.enum(["low", "medium", "high"]),
  /**
   * 历史补充说明。
   * JSON Schema 里它是必填（模型应当显式给出 null），
   * 但本地校验刻意放宽：模型偶尔漏字段不应该让整份输出报废。
   */
  historicalNote: z.string().max(600).nullable().optional(),
  nextAction: z
    .object({
      direction: z.string().min(1).max(600),
      principle: z.string().nullable(),
    })
    .nullable(),
});

/**
 * 伪精确数字与解读边界的实现都已移入 boundary.ts 统一维护。
 * 这里保留导出，避免既有调用方与第一阶段测试失效。
 */
export {
  findPseudoPrecision,
  scanPseudoPrecision,
  enforceBoundary,
  enforceBoundaryCompat,
  soften,
  findHardViolations,
  hasAssertiveReading,
  MIND_READING_THRESHOLD,
  type BoundaryOutcome,
  type BoundaryViolation,
} from "./boundary";

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/** 送进模型的状态。只搬运既有结论，不做二次加工。 */
export function buildPayload(request: DeepAnalysisRequest) {
  return {
    relation: request.relation,
    // 结构化的关系语境：先验背景，不是结论
    relationshipContext: request.relationshipContext ?? null,
    focusMessageId: request.targetId,
    messages: request.messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      // 媒体消息补了描述时，明确告诉模型这是用户转述，不是原始文字
      text: mediaPromptText(m),
      timestamp: m.timestamp,
    })),
    observations: request.observations.map((o) => ({
      messageId: o.messageId,
      emotions: topThree(o.emotions),
      intents: topThree(o.intents),
    })),
    patterns: describePatterns(request.patterns),
    // 互动投入趋势：由程序计算并给定，模型只能解释
    patternTrend: request.patternTrend
      ? describePatternTrend(request.patternTrend)
      : null,
    /**
     * 第三阶段：跨会话基线。
     * 每条记忆都带来源标签，模型必须知道权重顺序：
     * USER_CONFIRMED > OBSERVED > MODEL_INFERRED。
     */
    historicalBaseline: request.historicalTrend
      ? describeHistoricalTrend(request.historicalTrend)
      : null,
    historicalDeltas: request.historicalTrend
      ? describeHistoricalDeltas(request.historicalTrend.deltas)
      : [],
    profileContext: request.profile
      ? describeProfileContext(request.profile)
      : [],
    memory: request.memory.map((m) => ({
      id: m.id,
      kind: m.kind,
      content: m.content,
      sourceType: m.sourceType,
    })),
  };
}

function topThree(values: Record<string, number>) {
  return Object.entries(values)
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([key, value]) => ({ key, value }));
}

/** 从 Responses API 响应里取出纯文本输出。 */
export function extractOutputText(payload: unknown): string {
  const output = (payload as { output?: unknown })?.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

function parseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice =
    start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(slice);
  } catch {
    throw new DeepAnalysisError(
      "invalid_output",
      "第二层模型没有返回可解析的 JSON",
    );
  }
}

/** 与 parseJson 相同，但失败返回 null；用于可以安全重试的解析路径。 */
function safeParseJson(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * 创建第二层解释器。
 * fetch 可注入，测试时无需真实网络。
 */
export function createDeepSeekProvider(
  config: DeepSeekConfig = readDeepSeekConfig(),
  options: { fetch?: FetchLike } = {},
): InterpretationProvider {
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init) as never);

  /**
   * 发起一次模型调用。
   * 传输层错误（超时 / 网络 / HTTP）不重试：那是连接问题，换 prompt 没有意义。
   */
  async function send(
    retried: boolean,
    input: string,
    signal?: AbortSignal,
  ): Promise<{
    raw: string;
    usage: { input_tokens: number; output_tokens: number } | null;
  }> {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(`${config.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          instructions: retried
            ? `${DEEP_ANALYSIS_INSTRUCTIONS}\n\n${BOUNDARY_RETRY_NOTE}`
            : DEEP_ANALYSIS_INSTRUCTIONS,
          input,
          // 结构化输出：schema 由官方 Responses API 保证
          text: {
            format: {
              type: "json_schema",
              name: "deep_analysis",
              schema: DEEP_ANALYSIS_SCHEMA,
            },
          },
          // 这是判断题式的结构化任务，不需要长链思考
          reasoning: { effort: "none" },
          max_output_tokens: 4000,
          stream: false,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if ((error as Error)?.name === "TimeoutError")
        throw new DeepAnalysisError(
          "timeout",
          `第二层模型未在 ${config.timeoutMs}ms 内返回`,
        );
      throw new DeepAnalysisError(
        "upstream",
        `无法连接第二层模型：${(error as Error).message}`.slice(0, 200),
      );
    }

    const raw = await response.text();
    if (!response.ok)
      throw new DeepAnalysisError(
        "upstream",
        `第二层模型返回 HTTP ${response.status}`.slice(0, 200),
      );
    return { raw, usage: readUsage(raw) };
  }

  return {
    id: "deepseek",
    model: config.model,
    promptVersion: config.promptVersion,
    configured: config.enabled && Boolean(config.apiKey),

    async interpret(request, signal): Promise<InterpretationOutcome> {
      if (!config.enabled)
        throw new DeepAnalysisError(
          "disabled",
          "第二层分析未启用",
          "disabled",
        );
      if (!config.apiKey)
        throw new DeepAnalysisError(
          "not_configured",
          "未配置 DEEPSEEK_API_KEY",
          "not_configured",
        );

      const started = Date.now();
      const input = JSON.stringify(buildPayload(request));
      let lastFatal: BoundaryViolation | null = null;
      /**
       * 本次请求（含重试前那一次）出现过的违规类别，去重。
       * 只存 code，不存任何原文，因此可以安全记录与统计。
       */
      const violationCodes = new Set<BoundaryViolationCode>();

      // 至多 (1 + MAX_BOUNDARY_RETRIES) 次调用。
      // 只有「边界严重违规」与「核心结构不可用」才重试。
      for (let attempt = 0; attempt <= MAX_BOUNDARY_RETRIES; attempt++) {
        const retried = attempt > 0;
        const { raw, usage } = await send(retried, input, signal);

        const parsed = deepAnalysisOutput.safeParse(
          safeParseJson(extractOutputText(safeParseJson(raw))),
        );
        if (!parsed.success) {
          violationCodes.add("structural_invalid");
          // 核心结构已不可用：允许安全重试一次
          if (attempt < MAX_BOUNDARY_RETRIES) continue;
          throw new DeepAnalysisError(
            "invalid_output",
            "第二层模型输出不符合约定结构",
          );
        }

        const latencyMs = Date.now() - started;
        const draft: DeepAnalysis = {
          ...parsed.data,
          status: parsed.data.status as DeepAnalysisStatus,
          // 趋势由程序主导：模型的 trend 输出不被采信
          trend: request.patternTrend?.direction ?? parsed.data.trend,
          model: config.model,
          promptVersion: config.promptVersion,
          latencyMs,
          // 由服务端填写，避免模型自报上下文范围
          analyzedMessageIds: request.messages.map((m) => m.id),
        };

        // 解读边界：Level 1 软化、Level 2 单字段移除、Level 3 致命
        const outcome = enforceBoundary(draft, retried);
        if (outcome.fatal.length) {
          for (const violation of outcome.fatal)
            violationCodes.add(violation.code);
          lastFatal = outcome.fatal[0];
          if (attempt < MAX_BOUNDARY_RETRIES) continue;
          // 重试后仍然违规：整份拒绝。
          // 错误信息只带类别，绝不带违规原文，避免它进入日志或前端。
          throw new DeepAnalysisError(
            lastFatal.code === "pseudo_precision"
              ? "pseudo_precision"
              : "boundary_violation",
            `第二层输出越过解读边界（${lastFatal.label}）`,
          );
        }

        // 通过边界后，把模型截断的 messageId 还原成人类可读引用
        const normalized = normalizeMessageReferences(
          outcome.analysis,
          request.messages,
        );

        // 边界元数据必须同时写进 analysis.boundary ——
        // 那才是客户端唯一能读到的位置（第二轮暴露的组装 bug）。
        const boundaryMeta: BoundaryMeta = {
          ...(outcome.meta as BoundaryMeta),
          violationCodes: [...violationCodes].sort(),
        };
        return {
          analysis: { ...normalized.analysis, boundary: boundaryMeta },
          model: config.model,
          usage,
          latencyMs,
          boundary: boundaryMeta,
        };
      }

      // 循环内必定 return 或 throw，这里仅为类型收尾
      throw new DeepAnalysisError(
        "boundary_violation",
        `第二层输出越过解读边界${lastFatal ? `（${lastFatal.label}）` : ""}`,
      );
    },
  };
}

function readUsage(raw: string): {
  input_tokens: number;
  output_tokens: number;
} | null {
  try {
    const usage = (JSON.parse(raw) as { usage?: unknown }).usage as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    if (!usage) return null;
    return {
      input_tokens: Number(usage.input_tokens) || 0,
      output_tokens: Number(usage.output_tokens) || 0,
    };
  } catch {
    return null;
  }
}
