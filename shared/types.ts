export type Relation = "crush" | "new" | "couple";

/**
 * 媒体消息类型。
 *
 * 微信粘贴过来的语音、图片、表情包等只有占位标识（例如「[语音]」），
 * 内容本身是不可见的。用户可以在占位后面自己补一句描述/转述，
 * 这时系统把它标成 mediaKind，并让模型知道「这是转述，不是原始文字」。
 * 没有补描述的媒体消息仍然当作不可读处理，不参与分析。
 */
export type MediaKind =
  | "voice"
  | "image"
  | "video"
  | "sticker"
  | "file"
  | "location"
  | "link"
  | "other";

export type Message = {
  id: string;
  sender: "self" | "other";
  /**
   * 消息正文。
   * 媒体消息补了描述时，这里只放用户补充的描述本身（不含「[语音]」标记）；
   * 没补描述时保留原始占位文本。
   */
  text: string;
  timestamp: string | null;
  kind: "text" | "unreadable";
  /** 这条消息原本是哪种媒体（语音 / 图片 / 表情包…） */
  mediaKind?: MediaKind;
};
export type Parsed = {
  speaker: string;
  text: string;
  timestamp: string | null;
};
export type Judgment = {
  value: number | null;
  confidence: number;
  status: "clear" | "ambiguous" | "insufficient";
  probabilities: Record<string, number>;
};
export type LineResult = {
  id: string;
  score: Judgment;
  emotions?: Record<string, number>;
  intents?: Record<string, number>;
  replyType?: string;
  replyConfidence?: number;
  tone?: string;
  tones?: Record<string, number>;
  toneConfidence?: number;
};
export type Overview = {
  affinity: Judgment;
  stage: string;
  rapport?: Judgment;
  action: string;
  alternative?: string;
  evidenceId: string | null;
  actionEvidenceId: string | null;
};
export type Snapshot = {
  revision: number;
  messages: Message[];
  lines: Record<string, LineResult>;
  overview: Overview;
  relation: Relation;
  at: string;
  latencyMs: number;
  source: "live" | "fixture";
  comparable: boolean;
};
export type Task = "overview" | "other_messages" | "self_message";
export type AnalysisRequest = {
  revision: number;
  relation: Relation;
  messages: Message[];
  task: Task;
  targetIds: string[];
  /**
   * 本机版：这是一段**本机对话的 id**，只用于标记"这段聊天属于同一次会话"。
   * 服务端不认识它，也不会去读任何聊天记录 —— 消息一律随请求带来。
   */
  conversationId?: string | null;
};
export type AnalysisResponse = {
  revision: number;
  contextHash: string;
  model: string;
  rubricVersion: string;
  overview?: Overview;
  lines?: LineResult[];
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
};
export const MODEL = "jev-1.13.0";
export const RUBRIC = "crush-2026-09-19.4";
export const RELATIONS: Record<Relation, string> = {
  crush: "Crush / 暧昧中",
  new: "刚认识",
  couple: "恋爱中",
};
export const TONES: Record<string, string> = {
  warm: "关心靠近",
  playful: "俏皮试探",
  neutral: "平静交流",
  polite: "礼貌客气",
  upset: "不满委屈",
  closing: "回避收尾",
  unknown: "难以判断",
};
export const STAGES: Record<string, string> = {
  unknown: "信息不足",
  contact: "刚搭上线",
  flow: "聊得起来",
  flirt: "出现暧昧",
  date: "有具体约会安排",
  mutual: "明确互表心意",
};
export const ACTIONS: Record<string, { label: string; detail: string }> = {
  continue: { label: "顺着聊", detail: "接住刚才的话题，别急着切换频道。" },
  ask: {
    label: "轻轻追问",
    detail: "问一个具体、容易回答的小问题，把球轻轻递过去。",
  },
  empathize: {
    label: "先接情绪",
    detail: "先回应对方的感受，再考虑讲道理或给建议。",
  },
  flirt: {
    label: "轻轻调情",
    detail: "顺着已经被接住的玩笑，留一点刚刚好的暧昧。",
  },
  invite: {
    label: "试着约一下",
    detail: "把共同兴趣变成一个具体、没有压力的小邀约。",
  },
  clarify: {
    label: "直接问清",
    detail: "这句话有不止一种理解，温和确认比反复猜更有效。",
  },
  wait: {
    label: "等对方接球",
    detail: "球已经递出去了。先留一点空间，不用急着补发。",
  },
  close: {
    label: "今天先收尾",
    detail: "让聊天停在舒服的位置，下次还有话可说。",
  },
  respect: {
    label: "尊重边界",
    detail: "对方表达了拒绝或需要空间。尊重这个意思，停止推进。",
  },
  insufficient: {
    label: "再多一点上下文",
    detail: "这几句话还看不准，补上前后文再一起看看。",
  },
};
export function grade(n: number | null) {
  return n === null
    ? "看不准"
    : n >= 80
      ? "妙"
      : n >= 60
        ? "稳"
        : n >= 40
          ? "一般"
          : n >= 20
            ? "有点尬"
            : "刹车";
}
export function affinityLabel(n: number | null) {
  return n === null
    ? "心动信号，等待接收"
    : n >= 80
      ? "心动信号拉满"
      : n >= 60
        ? "有点来电"
        : n >= 40
          ? "有来有回"
          : n >= 20
            ? "比较克制"
            : "信号偏弱";
}
export function statusLabel(j?: Judgment) {
  return !j || j.status === "insufficient"
    ? "信息不足"
    : j.status === "clear"
      ? "判断较明确"
      : "有歧义";
}
export function meanQuality(
  messages: Message[],
  lines: Record<string, LineResult>,
) {
  const v = messages
    .filter((m) => m.sender === "self")
    .map((m) => lines[m.id]?.score.value)
    .filter((x): x is number => typeof x === "number");
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}
export function contextKey(messages: Message[], relation: Relation) {
  return JSON.stringify({ model: MODEL, rubric: RUBRIC, relation, messages });
}

// ---------------------------------------------------------------------------
// 双层分析总则
//   Evidence       原始消息，唯一事实来源
//   Observation    Jev 对单条消息的结构化判断
//   Interpretation DeepSeek 对上下文的解释（永远不是事实）
//   Pattern        程序从历史数据算出的统计量（LLM 不得编造）
//   Memory         跨会话的长期连续性
//   UserFeedback   用户对判断的修正，唯一能提升来源等级的力量
//   最终判断由用户负责。
// 本文件只定义类型与键，不含任何网络调用。
// ---------------------------------------------------------------------------

/** 深层分析整体状态。disabled 时不会产生任何 DeepSeek 请求。 */
export type DeepAnalysisStatus =
  | "ok"
  | "disabled"
  | "not_configured"
  | "insufficient_context"
  | "error";

/** 长期趋势方向。只允许程序依据历史数据计算，禁止模型直接编造。 */
export type Trend = "warming" | "stable" | "cooling" | "uncertain";

/** 不确定程度。定性分级，不是概率，不得与 confidence 混用。 */
export type UncertaintyLevel = "low" | "medium" | "high";

/**
 * 记忆来源等级。
 * model_inferred 永远不能自动升级为 user_confirmed —— 只有 UserFeedback 可以。
 */
export type SourceType = "observed" | "model_inferred" | "user_confirmed";

/** 事实层：指向原始消息的证据。quote 仅供本地展示，不得写入日志。 */
export type EvidenceRef = {
  messageId: string;
  quote: string;
  sender: "self" | "other";
  timestamp: string | null;
};

/** 观察层：Jev 的原始输出。保留原概率，不二次加工，不被上层覆盖。 */
export type Observation = {
  messageId: string;
  emotions: Record<string, number>;
  intents: Record<string, number>;
  score: Judgment | null;
  model: string;
  observedAt: string;
};

/**
 * 解释层的基本读法。
 * reading 必须保留可能性措辞（"对方可能有点不高兴"），
 * 除非证据明确到足以写成事实，否则禁止写成"对方不高兴"。
 */
export type LatentReading = {
  reading: string;
  /** 支持这一读法的消息 id */
  basedOn: string[];
  /** 与这一读法冲突的证据描述 */
  conflictsWith: string[];
};

export type AlternativeInterpretation = {
  interpretation: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
};

export type ConversationState = {
  reading: string;
  /** 表层可观察到的信号 */
  surfaceSignals: string[];
};

export type TurningPoint = {
  description: string;
  messageId: string | null;
} | null;

export type Contradiction = {
  description: string;
  /** 与哪条既有模式或记忆冲突，没有则为 null */
  against: string | null;
  messageIds: string[];
} | null;

export type NextAction = {
  /** 值得注意的方向。非命令式，禁止写成「你应该…」 */
  direction: string;
  /** 支撑这一方向的原则 */
  principle: string | null;
} | null;

/**
 * 边界违规类别。只记录类别，不记录违规原文 ——
 * 这样才能在保护隐私的前提下统计「模型更容易犯哪类错」。
 */
export type BoundaryViolationCode =
  | "mind_reading"
  | "personality_diagnosis"
  | "manipulative_advice"
  | "gender_stereotype"
  | "pseudo_precision"
  | "single_message_long_term"
  | "structural_invalid"
  | "other";

/** 解读边界的处理痕迹。只用于调试与透明度，不是给用户看的内容。 */
export type BoundaryMeta = {
  softenedFields: string[];
  removedFields: string[];
  retried: boolean;
  /**
   * 本次（含重试前那一次）触发过的违规类别，已去重。
   * 只有类别 code，没有原文，可以安全地记录与统计。
   */
  violationCodes?: BoundaryViolationCode[];
};

/**
 * 第二层完整输出。
 * 刻意不包含 affectionProbability / loveProbability 之类的伪精确数字。
 */
export type DeepAnalysis = {
  status: DeepAnalysisStatus;
  model: string;
  summary: string;
  surfaceSignals: string[];
  latentEmotion: LatentReading;
  latentIntent: LatentReading;
  conversationState: ConversationState;
  trend: Trend;
  turningPoint: TurningPoint;
  alternativeInterpretations: AlternativeInterpretation[];
  evidence: EvidenceRef[];
  contradiction: Contradiction;
  uncertainty: UncertaintyLevel;
  nextAction: NextAction;
  /**
   * 对「这次和她平时相比」的程序化观察的补充解释。
   * 数字部分由程序给出（historicalTrend），模型只能补充含义，且可以为 null。
   */
  historicalNote?: string | null;
  analyzedMessageIds: string[];
  promptVersion: number;
  latencyMs: number;
  /** 边界处理痕迹。可选，由服务端填写，模型无法提供。 */
  boundary?: BoundaryMeta;
};

// ---------------------------------------------------------------------------
// 模式层：只能由程序计算
// ---------------------------------------------------------------------------

export type PatternKind =
  | "initiation_ratio"
  | "reply_latency"
  | "reply_length"
  | "question_density"
  | "continuation_rate"
  | "closing_ratio"
  | "emotion_drift"
  | "intent_drift"
  | "event_volume"
  | "baseline_delta";

export type Pattern = {
  kind: PatternKind;
  /** 人类可读的一句话说明 */
  label: string;
  /** 当前窗口（后半段）取值，单位由 kind 决定 */
  value: number;
  /** 前一段（前半段）取值，样本不足时为 null */
  baseline: number | null;
  /** value - baseline，样本不足时为 null */
  delta: number | null;
  /** 参与计算的消息条数 */
  sampleSize: number;
  /** 数据不足时不产出结论，由调用方决定是否展示 */
  sufficient: boolean;
};

// ---------------------------------------------------------------------------
// 互动投入趋势（由程序计算，不是感情趋势）
// ---------------------------------------------------------------------------

/**
 * 由程序算出的互动投入趋势。
 *
 * 命名刻意避开"感情/关系趋势"：cooling 表示「互动投入下降」这一
 * 可观察行为变化，不表示关系变差。UI 文案必须与此一致。
 */
export type PatternTrend = {
  /**
   * 作用范围。session 表示「当前这段聊天前半段 vs 后半段」，
   * 与历史基线（HistoricalPatternTrend）必须分开，不能混成一个 delta。
   */
  scope?: "session";
  direction: "warming" | "stable" | "cooling" | "uncertain";
  confidence: "low" | "medium" | "high";
  /** 指向 warming 的指标 */
  supportingMetrics: string[];
  /** 指向 cooling 的指标 */
  conflictingMetrics: string[];
  /** 对话中是否明确出现了现实外部原因（脚伤/加班/考试等） */
  externalCausePresent: boolean;
  /** 命中的外部原因类别，只来自对话里明确说过的内容 */
  externalCauses: string[];
};

/** 会话内趋势（前半段 vs 后半段）的显式命名。 */
export type SessionPatternTrend = PatternTrend;

/** 外部原因类别。只允许从对话中明确出现的现实原因归纳，不允许模型发明。 */
export type ExternalCause =
  | "work"
  | "illness"
  | "injury"
  | "exam"
  | "trip"
  | "family"
  | "other";

// ---------------------------------------------------------------------------
// 关系语境（先验背景，不是结论）
// ---------------------------------------------------------------------------

export type RelationshipType =
  | "new"
  | "friend"
  | "close_friend"
  | "crush"
  | "dating"
  | "couple"
  | "coworker"
  | "family"
  | "other";

export type Closeness = "low" | "medium" | "high" | "unknown";

export type ContactFrequency =
  | "rare"
  | "weekly"
  | "several_per_week"
  | "daily"
  | "very_frequent"
  | "unknown";

/**
 * 关系语境。
 *
 * 它只能改变「同一行为的基准解读权重」，不是结论，也不能覆盖证据：
 *   - 不因为 type=crush 就把普通关心解释成暧昧
 *   - 不因为 type=friend 就禁止识别潜在信号
 *   - 不把用户提供的关系类型当成对方的真实心理状态
 */
export type RelationshipContext = {
  type: RelationshipType;
  durationDays?: number;
  closeness: Closeness;
  contactFrequency: ContactFrequency;
  /** 平时说话的语气特征，例如「爱开玩笑」「简短直接」 */
  usualTone: string[];
  /**
   * 已知的长期行为模式，例如「回复一直很慢」。
   *
   * 这里是**用户自己写的**先验背景，条数有上限（MAX_KNOWN_PATTERNS），
   * 不允许系统无限追加自由文本。系统自身归纳出的模式必须走
   * PersonProfile.knownPatterns（KnownPattern，带证据数与生命周期）。
   */
  knownPatterns: string[];
  /** 系统归纳出的结构化模式。与上面的用户原话分开存储。 */
  knownPatternDetails?: KnownPattern[];
  /** 最近的情况，例如「对方在赶项目」 */
  recentContext: string[];
  sourceType: "user_provided" | "observed" | "mixed";
};

/** 用户自述长期模式的条数上限，避免自由文本无限堆叠。 */
export const MAX_KNOWN_PATTERNS = 20;

/** 由旧 relation 推导默认关系语境，保证旧请求仍然可用。 */
export function contextFromRelation(relation: Relation): RelationshipContext {
  const base = {
    closeness: "unknown" as Closeness,
    contactFrequency: "unknown" as ContactFrequency,
    usualTone: [] as string[],
    knownPatterns: [] as string[],
    recentContext: [] as string[],
    sourceType: "user_provided" as const,
  };
  if (relation === "couple")
    return { ...base, type: "dating", closeness: "high" };
  if (relation === "crush")
    return { ...base, type: "crush", closeness: "medium" };
  return { ...base, type: "new", closeness: "low" };
}

// ---------------------------------------------------------------------------
// 记忆层
// ---------------------------------------------------------------------------

export type MemoryKind =
  | "fact"
  | "event"
  | "preference"
  | "boundary"
  | "pattern"
  | "unresolved";

/**
 * 记忆生命周期。
 *   active      当前有效
 *   contradicted 被用户确认的事实推翻（保留历史，不删除）
 *   superseded  被更新的同类记忆取代
 *   expired     久未复现，已不再作为当前基线
 *   archived    用户明确拒绝
 * 只有用户反馈能把来源等级提升到 user_confirmed，任何状态都不会删除内容。
 */
export type MemoryStatus =
  | "active"
  | "archived"
  | "contradicted"
  | "superseded"
  | "expired";

export type LongTermMemory = {
  id: string;
  kind: MemoryKind;
  content: string;
  sourceMessageIds: string[];
  createdAt: string;
  lastConfirmedAt: string;
  status: MemoryStatus;
  /** 模型或规则的把握程度 0-1。不是真实概率，不得当作概率展示。 */
  confidence: number;
  sourceType: SourceType;
};

/** 用户对 AI 判断的修正。唯一能把 model_inferred 升级为 user_confirmed 的途径。 */
export type UserFeedback = {
  id: string;
  memoryId: string;
  verdict: "confirm" | "reject" | "correct";
  /** verdict 为 correct 时的用户原话 */
  correction: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// 用户翻译层：给用户看的统一结构，禁止写成命令式关系建议
// ---------------------------------------------------------------------------

export type UserTranslation = {
  /** 客观事实 */
  whatHappened: string[];
  /** 用户可能没有意识到的社交信号 */
  whatYouMightMiss: string[];
  /** 可能的解释（含支持与冲突证据） */
  possibleMeanings: AlternativeInterpretation[];
  /** 支持这些解释的消息 id */
  strongestEvidence: string[];
  /** 当前无法确定的内容 */
  uncertainty: string[];
  /** 下一步观察什么，而不是下一步做什么 */
  whatToWatchNext: string[];
  /**
   * 「和她平时相比」。
   * 只描述可观察的行为变化（比平时回得慢/短），
   * 禁止写成「她变冷淡了」这类关系结论。
   */
  comparedToUsual: string[];
};

// ---------------------------------------------------------------------------
// 第二层请求 / 响应
// ---------------------------------------------------------------------------

export type DeepAnalysisRequest = {
  revision: number;
  relation: Relation;
  /** 当前关注的目标消息；null 表示整段上下文 */
  targetId: string | null;
  messages: Message[];
  observations: Observation[];
  memory: LongTermMemory[];
  patterns: Pattern[];
  /**
   * 本机版的对话 id：只用于让前端把同一段对话的前后请求关联起来。
   * 服务端不读它，也不据此检索任何持久化数据。
   */
  conversationId?: string | null;
  /**
   * 关系语境。客户端可以提供；缺省时由 relation 推导。
   * 它只调整解读权重，不改变证据本身。
   */
  relationshipContext?: RelationshipContext;
  /**
   * 由服务端计算并填充的互动投入趋势。
   * 客户端传入的值会被服务端覆盖；模型的 trend 输出也不能覆盖它。
   */
  patternTrend?: PatternTrend;
  /**
   * 第三阶段：跨会话画像的临时上下文。
   * 只包含与当前对话相关的检索结果，由客户端从本地 profile 里选出，
   * 服务端不持久化它，用完即弃。
   */
  profile?: ProfileContextBundle;
  /** 由服务端计算并填充的跨会话历史趋势。客户端传入值一律被覆盖。 */
  historicalTrend?: HistoricalPatternTrend;
};

export type DeepAnalysisResponse = {
  status: DeepAnalysisStatus;
  analysis: DeepAnalysis | null;
  /** status 非 ok 时的可读原因 */
  error: string | null;
  model: string;
  promptVersion: number;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number } | null;
  /**
   * 由程序算出的互动投入趋势。前端用它做外部原因修正，
   * 不依赖模型自报的 trend。
   */
  patternTrend?: PatternTrend;
  /**
   * 由程序算出的跨会话历史趋势。
   * 与 patternTrend（会话内）严格分开，两者不得合并成一个 delta。
   */
  historicalTrend?: HistoricalPatternTrend;
};

// ---------------------------------------------------------------------------
// 第二层配置与缓存
// ---------------------------------------------------------------------------

export const DEEP_ANALYSIS_DEFAULT_MODEL = "deepseek-flash";
export const DEEP_ANALYSIS_DEFAULT_BASE_URL = "https://api.deepseek.com";
/**
 * 改动 prompt 语义时必须递增，否则会错误复用旧缓存。
 * 2：第三阶段加入跨会话基线规则（来源权重 / 不把历史数字换算成概率）。
 * 3：长期模式改为程序统计优先，模型推断不得独自形成长期结论。
 */
export const DEEP_ANALYSIS_PROMPT_VERSION = 3;
/** 第二层默认上下文条数。 */
export const DEEP_CONTEXT_WINDOW = 36;
/** 超过这个间隔视为展开了新的一轮对话。 */
export const SESSION_GAP_MINUTES = 30;

/** 针对某次深度解读的反馈。本阶段只作为未来校准数据，不改变任何行为。 */
export type InterpretationFeedback = {
  id: string;
  /** 对应哪一次解读 */
  contextKey: string;
  verdict: "helpful" | "problem";
  /** verdict 为 problem 时的原因标签 */
  reasons: string[];
  /** 用户补充的实际情况 */
  note: string;
  createdAt: string;
};

/** problem 反馈的可选原因，与界面文案一一对应。 */
export const FEEDBACK_REASONS = [
  { key: "wrong_reading", label: "主要解释不对" },
  { key: "missed_signal", label: "漏掉重要信号" },
  { key: "overthinking", label: "把普通行为想复杂了" },
  { key: "too_certain", label: "太确定" },
  { key: "other", label: "其他" },
] as const;

/**
 * 第二层缓存键。
 * model / promptVersion / relation / 分析模式 / 消息内容 / 相关记忆 / 第一层观察
 * 任何一项变化都必须产生不同的键。
 */
export function deepContextKey(input: {
  model: string;
  promptVersion: number;
  relation: Relation;
  analysisMode: string;
  messages: Message[];
  memory: LongTermMemory[];
  /** 第一层观察也参与失效：重新分析后不应复用旧解读。 */
  observations?: {
    messageId: string;
    emotions: Record<string, number>;
    intents: Record<string, number>;
  }[];
  /**
   * 第三阶段：跨会话肖像也参与失效。
   * 基线、已确认事实或表达习惯变了，旧解读就不能复用。
   */
  profileSignature?: string;
  /** 服务端模式下的对话 id：换了对话就必须换缓存键 */
  conversationId?: string | null;
}) {
  return JSON.stringify({
    scope: "deep",
    model: input.model,
    promptVersion: input.promptVersion,
    relation: input.relation,
    analysisMode: input.analysisMode,
    conversationId: input.conversationId ?? null,
    messages: input.messages.map((m) => [
      m.id,
      m.sender,
      m.text,
      // 媒体类型参与失效：同一段描述，语音和图片对模型的含义不同
      m.mediaKind ?? null,
    ]),
    memory: input.memory.map((m) => [
      m.id,
      m.content,
      m.sourceType,
      m.lastConfirmedAt,
    ]),
    profileSignature: input.profileSignature ?? null,
    // 只取稳定字段，刻意不含 observedAt 这类时间戳
    observations: (input.observations ?? []).map((o) => [
      o.messageId,
      o.emotions,
      o.intents,
    ]),
  });
}

// ---------------------------------------------------------------------------
// 第三阶段：跨会话行为基线
//
// 这里记录的是「历史上我们观察到对方通常怎样互动」，
// 不是「对方是什么样的人」。任何字段都不得变成人格标签：
// 没有 attachment style，没有性格类型，没有喜欢概率。
// ---------------------------------------------------------------------------

/**
 * 可进入长期基线的指标：与 PatternKind 里真正可比的 8 项一一对应。
 * baseline_delta 是聚合量、event_volume 是长度量，都不进入历史基线，
 * 否则「聊得多」会被当成「关系变好」。
 */
export type BaselineMetricKind =
  | "initiation_ratio"
  | "reply_latency"
  | "reply_length"
  | "question_density"
  | "continuation_rate"
  | "closing_ratio"
  | "emotion_drift"
  | "intent_drift";

export const BASELINE_METRIC_KINDS: BaselineMetricKind[] = [
  "initiation_ratio",
  "reply_latency",
  "reply_length",
  "question_density",
  "continuation_rate",
  "closing_ratio",
  "emotion_drift",
  "intent_drift",
];

/**
 * 单个指标的长期基线。
 *
 * 刻意不只存最后一次取值：
 *   mean        时间衰减加权后的均值（程序增量维护）
 *   median      最近若干个原始样本的中位数，延迟分布必须看它
 *   variance    最近若干个原始样本的总体方差
 *   sampleCount 历史累计样本数
 *   recent      有上限的原始样本窗口
 *   weightSum / weightedSum 增量累加器，保证只靠上一次结果就能更新
 */
export type BaselineMetric = {
  mean: number;
  median?: number;
  variance?: number;
  sampleCount: number;
  /** 毫秒时间戳。只作记录与衰减参考，不参与「现在几点」的判断。 */
  updatedAt: number;
  weightSum: number;
  weightedSum: number;
  recent: number[];
  /**
   * 最近一次并入的样本值。
   * 有了它，比较「这次 vs 她平时」时才能判断当前的这次是否已经在均值里，
   * 从而用 previousMean 精确地把本次排除掉。
   */
  lastValue?: number;
  /** 并入本次样本**之前**的均值与中位数。 */
  previousMean?: number;
  previousMedian?: number;
  previousSampleCount?: number;
  /**
   * 与 recent 一一对应的对话 id。
   * 有了它，「这个样本是哪一段对话贡献的」才是可追溯的，
   * 程序侧的行为模式才能拿真实证据数（不同对话数）说话。
   */
  recentConversationIds?: string[];
};

export type BehaviorBaseline = {
  /** 进入基线的样本总数（各指标累加） */
  sampleCount: number;
  /** 合并过的对话轮数 */
  conversationCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
  metrics: Partial<Record<BaselineMetricKind, BaselineMetric>>;
};

/** 基线成熟度。历史不足时必须显式说明，不允许假装认识这个人。 */
export type BaselineStatus = "none" | "insufficient" | "early" | "established";

/** 变化显著程度。定性分级，不是概率。 */
export type Significance = "none" | "small" | "moderate" | "large";

/**
 * 当前会话 vs 个人历史。
 * 与会话内的 Pattern.delta（前半段 vs 后半段）是两个不同的东西。
 */
export type HistoricalDelta = {
  metric: BaselineMetricKind;
  label: string;
  /** 本次会话取值 */
  current: number;
  /** 个人历史取值（衰减加权均值） */
  historical: number;
  /** 参考中位数，延迟这类易被极值污染的指标以它为准 */
  historicalMedian: number | null;
  delta: number;
  /** 归一化到 -1..1，跨指标可比 */
  normalizedDelta: number;
  significance: Significance;
  /** 进入基线的历史样本数 */
  sampleCount: number;
};

/**
 * 跨会话历史趋势。
 * 与会话内趋势（SessionPatternTrend）严格分开：
 * 一次会话可能「前半热、后半冷」，但整体仍高于个人历史水平，
 * 这种情况必须能被同时表达出来。
 */
export type HistoricalPatternTrend = {
  scope: "historical";
  direction: "warming" | "stable" | "cooling" | "uncertain";
  confidence: "low" | "medium" | "high";
  supportingMetrics: BaselineMetricKind[];
  conflictingMetrics: BaselineMetricKind[];
  deltas: HistoricalDelta[];
  baselineStatus: BaselineStatus;
  comparedConversations: number;
  /** 历史样本不足时为 true，此时 UI 不得写成「她平时…」 */
  insufficientHistory: boolean;
};

/**
 * 系统归纳出的长期行为模式。
 *
 * 证据驱动：只有达到明确门槛（不同对话数）的**程序统计**才会自动成为
 * `deterministic` 模式。模型自由文本推断不再自动晋升 ——
 * 它只能作为解释辅助，或被用户确认后才以 `user_confirmed` 出现。
 */
export type KnownPatternSource =
  | "deterministic"
  | "user_confirmed"
  | "model_inferred";

export type KnownPattern = {
  id: string;
  /** 稳定的模式键（例如 reply_length_short），同一模式永远同一个键。 */
  patternKey: string;
  description: string;
  /** 支持它的证据条数（程序侧模式里等于不同对话数）。 */
  evidenceCount: number;
  /** 支持它的对话段数。 */
  conversationCount: number;
  sourceType: KnownPatternSource;
  /** 这条模式建立在哪些指标上。 */
  supportingMetrics: string[];
  firstObservedAt: number;
  lastObservedAt: number;
  status: MemoryStatus;
};

/**
 * 程序侧的行为模式候选：只由基线、历史 delta、表达习惯与确定性事件统计产生，
 * 不含任何模型自由文本。
 */
export type BehaviorPatternCandidate = {
  key: string;
  metric?: string;
  direction?: "higher" | "lower" | "stable";
  /** 支持这条模式的不同对话 id */
  evidenceConversationIds: string[];
  /** 等于 evidenceConversationIds.length */
  evidenceCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
  sourceType: "deterministic";
  /**
   * 高风险解释（例如涉及单独相处、约见意愿）需要更高门槛才允许自动成为模式。
   */
  highRisk?: boolean;
  /** 程序算出的代表性取值，用于生成描述 */
  representative?: number;
  /** 依据这条候选生成的中文描述（只描述行为，不做人格或感情判断） */
  description: string;
};

/** 确定性事件类型：只从明确说过的邀约与答复里归纳。 */
export type ActivityEventKind =
  | "planned_invite_accepted"
  | "planned_invite_declined"
  | "same_day_invite_accepted"
  | "same_day_invite_declined"
  | "unspecified_invite_accepted"
  | "unspecified_invite_declined"
  | "counterpart_proposes_activity";

export type ActivityEvent = {
  kind: ActivityEventKind;
  conversationId: string;
  messageIds: string[];
  at: number;
};

/**
 * 个体语言习惯。
 *
 * 目的只有一个：避免同一个高频表达每次都被重新解读成情绪信号。
 * 例如「哈哈」在历史上跨多种情绪语境出现时，就应被当成语气填充，
 * 而不是「她在掩饰」「她开心」。
 */
export type CommunicationHabit = {
  expression: string;
  observedCount: number;
  conversationCount: number;
  /** 出现过的情绪/意图语境标签（来自 Jev 观察的 top1） */
  contexts: string[];
  usualMeaning: string;
  confidence: "low" | "medium" | "high";
  lastObservedAt: number;
  /**
   * 内部字段：已经统计过的对话 id。
   * 它保证同一段聊天被重复分析时不会把计数刷高，
   * conversationCount 就是它的长度。
   */
  conversationIds?: string[];
  /**
   * 内部字段：每段对话各自的出现次数。
   * 重复提交同一段对话时用它**覆盖**而不是累加，否则计数会被刷新。
   */
  countsByConversation?: Record<string, number>;
};

/**
 * 模型推断候选。
 * 看到一次不写长期记忆；只有跨多次不同对话反复出现才允许晋升为
 * LongTermMemory(kind="pattern", sourceType="model_inferred")。
 * 它永远不能自动变成 user_confirmed。
 */
export type InferenceCandidateAspect =
  | "emotion"
  | "intent"
  | "alternative";

export type InferenceCandidate = {
  id: string;
  content: string;
  kind: MemoryKind;
  /**
   * 这条推断来自解读的哪一面。
   * 只有同一面的推断才允许互相归并：情绪读法和意图读法即使措辞相似，
   * 也不是同一个模式。旧数据没有这个字段时按 alternative 处理。
   */
  aspect?: InferenceCandidateAspect;
  sourceMessageIds: string[];
  /** 出现过这一推断的不同对话 id */
  conversationIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  /** 等于 conversationIds.length，跨对话出现次数 */
  observationCount: number;
  confidence: number;
};

/** 只用于帮助系统理解自己的历史表现，不是对用户的评分。 */
export type FeedbackStats = {
  total: number;
  helpful: number;
  problematic: number;
  overinterpretation: number;
  underinterpretation: number;
  missedSignal: number;
  tooCertain: number;
  confirmedInterpretations: number;
  contradictedInterpretations: number;
};

/** 用户对一次解读的整体判定。 */
export type ConfirmationVerdict =
  | "mostly_correct"
  | "partly_correct"
  | "incorrect"
  | "unknown";

/**
 * 用户确认。即使选了「基本正确」，也只能确认用户明确勾选的那几部分，
 * 不能把整份解读里的所有模型推断一起升级成事实。
 */
export type InterpretationConfirmation = {
  id: string;
  contextKey: string;
  verdict: ConfirmationVerdict;
  /** 用户勾选确认的那几部分的 key */
  confirmedParts: string[];
  createdAt: string;
};

/** 可被用户逐项勾选确认的部分。key 由程序生成，可回溯到具体字段。 */
export type ConfirmationPart = {
  key: string;
  label: string;
  /** 该部分在解读里对应的原话，供用户核对自己在确认什么 */
  detail: string;
};

/** 用户纠错：唯一能推翻既有模型推断的力量。 */
export type UserCorrection = {
  id: string;
  contextKey: string | null;
  /** 用户原话，例如「不是，她那天只是发烧」 */
  content: string;
  /** 因此被标记为 contradicted 的记忆 id（内容仍然保留） */
  contradictedIds: string[];
  createdAt: string;
};

/** 送往第二层的记忆条目，带明确的来源标签。 */
export type TaggedMemory = {
  source: "USER_CONFIRMED" | "OBSERVED" | "MODEL_INFERRED";
  kind: MemoryKind;
  content: string;
  confidence: number;
};

/**
 * 一次请求携带的跨会话上下文。
 * 由客户端从本地 profile 里检索出相关子集，服务端只读不存。
 */
export type ProfileContextBundle = {
  baselineStatus: BaselineStatus;
  comparedConversations: number;
  /** 原始基线。历史 delta 由服务端用程序重新计算，客户端传的 delta 一律忽略。 */
  baseline: BehaviorBaseline;
  /** 已检索的相关记忆，按来源与优先级分好组 */
  confirmed: TaggedMemory[];
  /**
   * 与当前对话直接相关的事实（外部/当前事实）。
   * 优先级仅次于 user_confirmed：例如「对方说这周项目上线」。
   */
  currentFacts: TaggedMemory[];
  observed: TaggedMemory[];
  inferred: TaggedMemory[];
  habits: CommunicationHabit[];
  knownPatterns: KnownPattern[];
  /** 未解决事件永远带上，权重最高 */
  unresolved: TaggedMemory[];
  /** 用户最近的纠错原话，用于压制已被推翻的解释 */
  corrections: string[];
  /** 检索估算 token，用于审计 */
  estimatedTokens: number;
  /** 是否因为预算被截断 */
  truncated: boolean;
  /** 因为预算被丢掉的层级（按丢弃顺序） */
  trimmed?: string[];
  /**
   * 由服务端用程序重新计算的历史趋势。
   * 客户端传上来的 delta 一律被丢弃：数字只有一个来源。
   */
  historicalTrend?: HistoricalPatternTrend;
};

/** 一个人（一段关系）的长期档案。本地存储，不上传。 */
export type PersonProfile = {
  id: string;
  displayName?: string;
  relationshipContext: RelationshipContext;
  createdAt: number;
  updatedAt: number;
  /** 基线口径版本。算法改变时递增，旧基线不会被误当成新口径。 */
  baselineVersion: number;
  behaviorBaseline: BehaviorBaseline;
  memories: LongTermMemory[];
  knownPatterns: KnownPattern[];
  habits: CommunicationHabit[];
  /** 确定性事件统计（邀约与答复）。只从对话里明确说过的内容归纳。 */
  activityEvents: ActivityEvent[];
  inferenceCandidates: InferenceCandidate[];
  feedbackStats: FeedbackStats;
  confirmations: InterpretationConfirmation[];
  corrections: UserCorrection[];
  /** 已经并入基线的对话 id，保证同一段聊天不会被重复计入 */
  sourceConversationIds: string[];
};

/** 第三阶段存储版本。结构变化时递增并写迁移。 */
export const PROFILE_SCHEMA_VERSION = 2;

/** 存储版本 1 的已知模式来源标记，迁移时映射到 deterministic。 */
export const LEGACY_PATTERN_SOURCE = "observed";
export const PROFILE_STORAGE_KEY = "crush-monitor.profile.v1";

/** 基线口径版本：任何影响 mean/median 计算的改动都必须递增。 */
export const BASELINE_VERSION = 1;

/** 冷启动阈值（按会话数）。 */
export const BASELINE_INSUFFICIENT_BELOW = 3;
export const BASELINE_ESTABLISHED_ABOVE = 5;

/** 时间衰减权重分档（天）。越近的行为权重越高。 */
export const DECAY_BUCKETS: { maxDays: number; weight: number }[] = [
  { maxDays: 30, weight: 1 },
  { maxDays: 90, weight: 0.7 },
  { maxDays: 180, weight: 0.4 },
];
export const DECAY_MIN_WEIGHT = 0.2;

/** 单指标保留的原始样本窗口长度。 */
export const BASELINE_RECENT_LIMIT = 20;

/**
 * 行为模式自动成为 KnownPattern 的最低门槛（不同对话数）。
 * 少于这个数就不允许自动成模式。
 */
export const BEHAVIOR_PATTERN_MIN_CONVERSATIONS = 3;

/**
 * 高风险模式的门槛：涉及「更愿意和你单独活动」这类关系解释时，
 * 需要更多对话证据才允许自动成模式。
 */
export const BEHAVIOR_PATTERN_HIGH_RISK_MIN_CONVERSATIONS = 4;

/** 模式候选还需要占到该指标样本的这个比例，才算「平时就是这样」。 */
export const BEHAVIOR_PATTERN_MIN_RATIO = 0.7;

/** 档案里保留的确定性事件上限。 */
export const MAX_ACTIVITY_EVENTS = 200;

/**
 * 模型推断候选在检索里最多带几条。
 * 它们只是解释辅助，永远排在最后，也永远最先被裁掉。
 */
export const INFERENCE_BACKGROUND_LIMIT = 3;

/** 档案里保留的推断候选上限（只用于控制体积，与晋升无关）。 */
export const MAX_INFERENCE_CANDIDATES = 60;

/**
 * 检索预算（估算 token）。
 * 1200 是第三阶段调优后的值：够放下用户确认 + 当前事实 + 稳定模式 + 习惯，
 * 同时保证模型推断只占很小一块。
 */
export const RETRIEVAL_TOKEN_BUDGET = 1200;

/** 每个来源等级最多检索多少条。 */
export const RETRIEVAL_LIMITS = {
  confirmed: 6,
  /** 与当前对话直接相关的客观事实 */
  currentFacts: 6,
  observed: 6,
  inferred: 3,
  habits: 6,
  patterns: 4,
} as const;
