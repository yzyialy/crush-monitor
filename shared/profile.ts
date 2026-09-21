import { INTENTS } from "./intents";
import { EMOTIONS } from "./labels";
import {
  metricLabel,
  metricSpec,
  normalizeMetricDelta,
  sliceSessions,
} from "./patterns";
import {
  BASELINE_ESTABLISHED_ABOVE,
  BASELINE_INSUFFICIENT_BELOW,
  BASELINE_METRIC_KINDS,
  BASELINE_RECENT_LIMIT,
  BEHAVIOR_PATTERN_HIGH_RISK_MIN_CONVERSATIONS,
  BEHAVIOR_PATTERN_MIN_CONVERSATIONS,
  BEHAVIOR_PATTERN_MIN_RATIO,
  DECAY_BUCKETS,
  DECAY_MIN_WEIGHT,
  MAX_KNOWN_PATTERNS,
  MAX_INFERENCE_CANDIDATES,
  type ActivityEvent,
  type ActivityEventKind,
  type BaselineMetric,
  type BaselineMetricKind,
  type BaselineStatus,
  type BehaviorBaseline,
  type BehaviorPatternCandidate,
  type CommunicationHabit,
  type ConfirmationPart,
  type ConfirmationVerdict,
  type DeepAnalysis,
  type FeedbackStats,
  type HistoricalDelta,
  type HistoricalPatternTrend,
  type InferenceCandidate,
  type InferenceCandidateAspect,
  type InterpretationConfirmation,
  type InterpretationFeedback,
  type KnownPattern,
  type KnownPatternSource,
  type LongTermMemory,
  type MemoryKind,
  type MemoryStatus,
  type Message,
  type Observation,
  type PersonProfile,
  type Relation,
  type RelationshipContext,
  type Significance,
  type UserCorrection,
} from "./types";

/**
 * 第三阶段：跨会话行为基线。
 *
 * 这个文件只回答一个问题：
 *   「历史上我们观察到对方通常怎样互动，这一次哪里不同？」
 * 它不回答、也不允许任何人用它回答：
 *   「对方是什么样的人」。
 *
 * 全部函数都是纯函数：
 *   - 不读当前时间（需要时间的一律由调用方显式传入毫秒时间戳）
 *   - 不使用随机数
 *   - 同样输入必定得到同样输出
 * 长期基线永远由程序计算，LLM 只能解释结果。
 */

const DAY_MS = 86_400_000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const average = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

// ---------------------------------------------------------------------------
// 时间衰减
// ---------------------------------------------------------------------------

/**
 * 行为模式的权重随时间下降。
 * 一年前每天聊天不能直接当作今天的基线，否则「认识很久」会变成一种优势。
 * 分档简单、可配置、可测试，不做任何机器学习。
 */
export function decayWeight(daysAgo: number): number {
  if (!Number.isFinite(daysAgo) || daysAgo <= 0) return 1;
  for (const bucket of DECAY_BUCKETS)
    if (daysAgo <= bucket.maxDays) return bucket.weight;
  return DECAY_MIN_WEIGHT;
}

// ---------------------------------------------------------------------------
// 基线更新
// ---------------------------------------------------------------------------

export function emptyBaseline(): BehaviorBaseline {
  return {
    sampleCount: 0,
    conversationCount: 0,
    firstObservedAt: 0,
    lastObservedAt: 0,
    metrics: {},
  };
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function varianceOf(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return average(values.map((v) => (v - mean) ** 2));
}

/**
 * 增量合并一个样本。
 *
 * mean 使用「带时间衰减的加权增量均值」：
 *   旧权重的有效值 = weightSum * decay(距上次更新的天数)
 * 这样不需要保留全部历史，也能让近期行为占更大权重。
 *
 * median / variance 取最近 BASELINE_RECENT_LIMIT 个原始样本，
 * 因为延迟分布很容易被极端值污染，只看均值会失真。
 */
function mergeMetric(
  previous: BaselineMetric | undefined,
  value: number,
  at: number,
  conversationId: string,
): BaselineMetric {
  const rounded = round2(value);
  if (!previous || previous.sampleCount === 0)
    return {
      mean: rounded,
      median: rounded,
      variance: 0,
      sampleCount: 1,
      updatedAt: at,
      weightSum: 1,
      weightedSum: round4(value),
      recent: [rounded],
      recentConversationIds: [conversationId],
      lastValue: rounded,
      previousMean: undefined,
      previousMedian: undefined,
      previousSampleCount: 0,
    };

  const decay = decayWeight(Math.max(0, at - previous.updatedAt) / DAY_MS);
  const weightSum = previous.weightSum * decay + 1;
  const weightedSum = previous.weightedSum * decay + value;
  /**
   * 样本与它的来源对话必须一一对齐。
   * 旧数据没有 id 时用空串占位：那段样本不能充当模式证据，
   * 但也不能让后面的样本错位。
   */
  const alignedIds = (previous.recent ?? []).map(
    (_value, index) => previous.recentConversationIds?.[index] ?? "",
  );
  const recent = [...previous.recent, rounded].slice(-BASELINE_RECENT_LIMIT);
  const recentConversationIds = [...alignedIds, conversationId].slice(
    -BASELINE_RECENT_LIMIT,
  );

  return {
    mean: round2(weightedSum / weightSum),
    median: round2(medianOf(recent)),
    variance: round2(varianceOf(recent)),
    sampleCount: previous.sampleCount + 1,
    updatedAt: at,
    weightSum: round4(weightSum),
    weightedSum: round4(weightedSum),
    recent,
    recentConversationIds,
    lastValue: rounded,
    // 并入本次之前的水平。「这次和她平时比」用的就是它，
    // 否则本次样本会把自己稀释进参照值里。
    previousMean: previous.mean,
    previousMedian:
      typeof previous.median === "number" ? previous.median : previous.mean,
    previousSampleCount: previous.sampleCount,
  };
}

export type SessionMetricsInput = {
  /** 这一段对话的唯一标识。同一段重复提交时由调用方先判重。 */
  conversationId: string;
  metrics: Partial<Record<BaselineMetricKind, number>>;
  at: number;
};

/**
 * 把一次会话的指标增量并入长期基线。
 *
 * 缺失或非有限值的指标一律跳过 —— 不补齐、不用 0 顶替，
 * 否则「样本不足」会被伪装成「取值为 0」。
 */
export function updateBaseline(
  previous: BehaviorBaseline | null | undefined,
  session: SessionMetricsInput,
): BehaviorBaseline {
  const base = previous ?? emptyBaseline();
  const metrics = { ...base.metrics };
  let samples = 0;

  for (const kind of BASELINE_METRIC_KINDS) {
    const value = session.metrics[kind];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    metrics[kind] = mergeMetric(
      metrics[kind],
      value,
      session.at,
      session.conversationId,
    );
    samples++;
  }

  const previousLast = base.lastObservedAt || session.at;
  return {
    sampleCount: base.sampleCount + samples,
    conversationCount: base.conversationCount + 1,
    firstObservedAt: base.firstObservedAt || session.at,
    lastObservedAt: Math.max(previousLast, session.at),
    metrics,
  };
}

/** 基线成熟度。历史不足时必须能被明确说出来。 */
export function baselineStatus(
  baseline: BehaviorBaseline | null | undefined,
): BaselineStatus {
  const count = baseline?.conversationCount ?? 0;
  if (count <= 0) return "none";
  if (count < BASELINE_INSUFFICIENT_BELOW) return "insufficient";
  if (count <= BASELINE_ESTABLISHED_ABOVE) return "early";
  return "established";
}

/** 给用户看的冷启动说明。历史不足时不假装已经认识这个人。 */
export function baselineStatusLabel(status: BaselineStatus, count = 0): string {
  if (status === "none") return "还没有历史样本";
  if (status === "insufficient")
    return `历史样本还不足（已记录 ${count} 次对话），当前只能基于这次对话分析`;
  if (status === "early") return `历史样本偏少（已记录 ${count} 次对话），比较结果仅供参考`;
  return `已积累 ${count} 次对话的历史基线`;
}

// ---------------------------------------------------------------------------
// 当前 vs 个人历史
// ---------------------------------------------------------------------------

/** 变化显著程度的分档阈值（归一化后的绝对值）。 */
export const SIGNIFICANCE_SMALL = 0.15;
export const SIGNIFICANCE_MODERATE = 0.3;
export const SIGNIFICANCE_LARGE = 0.5;

export function significanceOf(normalized: number): Significance {
  const n = Math.abs(normalized);
  if (!Number.isFinite(n) || n < SIGNIFICANCE_SMALL) return "none";
  if (n < SIGNIFICANCE_MODERATE) return "small";
  if (n < SIGNIFICANCE_LARGE) return "moderate";
  return "large";
}

/**
 * 取「她平时」的参照值。
 *
 * 关键细节：如果当前这次会话已经被并入基线（lastValue 与当前值相同），
 * 参照值必须换成 previousMean，也就是**排除本次**之后的水平。
 * 否则「这次和她平时比」会拿她去比她自己，样本越少 delta 越接近 0。
 * 延迟分布容易被极端值污染，所以它一律以中位数作参照。
 */
function referenceFor(
  kind: BaselineMetricKind,
  metric: BaselineMetric,
  current: number,
): { reference: number; median: number | null } {
  const alreadyCounted =
    typeof metric.lastValue === "number" &&
    Math.abs(metric.lastValue - round2(current)) < 1e-9 &&
    (metric.previousSampleCount ?? 0) >= 2;

  if (alreadyCounted) {
    const previousMean = metric.previousMean ?? metric.mean;
    const previousMedian = metric.previousMedian ?? previousMean;
    return {
      reference: kind === "reply_latency" ? previousMedian : previousMean,
      median: previousMedian,
    };
  }

  const median =
    typeof metric.median === "number" ? metric.median : null;
  return {
    reference: kind === "reply_latency" && median !== null ? median : metric.mean,
    median,
  };
}

/**
 * 当前会话 vs 个人历史。
 *
 * 与「会话内 delta」（前半段 vs 后半段）完全分开：
 * 一次会话可能前半热、后半冷，但整体仍高于个人历史水平，
 * 这两种信息必须能同时表达，不能混成一个 delta。
 *
 * 两个方向字段分工明确：
 *   delta           原始差值（当前值 - 平时值），保留指标自己的量纲方向
 *   normalizedDelta 已按「互动投入」方向取号：正数=比平时投入更多，
 *                   负数=比平时投入更少。延迟这类「越大越冷」的指标
 *                   必须靠它才能和其他指标放在一起比较。
 */
export function computeHistoricalDeltas(
  baseline: BehaviorBaseline | null | undefined,
  currentMetrics: Partial<Record<BaselineMetricKind, number>>,
): HistoricalDelta[] {
  if (!baseline) return [];
  const deltas: HistoricalDelta[] = [];

  for (const kind of BASELINE_METRIC_KINDS) {
    const metric = baseline.metrics[kind];
    const current = currentMetrics[kind];
    if (!metric || metric.sampleCount === 0) continue;
    if (typeof current !== "number" || !Number.isFinite(current)) continue;

    const { reference, median } = referenceFor(kind, metric, current);
    const orientation = metricSpec(kind)?.orientation ?? 1;
    const normalized =
      normalizeMetricDelta(kind, current, reference) * orientation;

    deltas.push({
      metric: kind,
      label: metricLabel(kind),
      current: round2(current),
      historical: round2(reference),
      historicalMedian: median === null ? null : round2(median),
      delta: round2(current - reference),
      normalizedDelta: round2(normalized),
      significance: significanceOf(normalized),
      sampleCount: metric.sampleCount,
    });
  }

  return deltas.sort(
    (a, b) => Math.abs(b.normalizedDelta) - Math.abs(a.normalizedDelta),
  );
}

export type HistoricalTrendOptions = {
  /** 最少需要多少次历史对话才允许给出方向。 */
  minConversations?: number;
};

/**
 * 跨会话历史趋势。
 *
 * 历史不足时 direction 固定为 uncertain 且 insufficientHistory=true，
 * 「不伪造 baseline」是硬要求，不能靠模型补救。
 */
export function computeHistoricalTrend(
  baseline: BehaviorBaseline | null | undefined,
  currentMetrics: Partial<Record<BaselineMetricKind, number>>,
  options: HistoricalTrendOptions = {},
): HistoricalPatternTrend {
  const minConversations =
    options.minConversations ?? BASELINE_INSUFFICIENT_BELOW;
  const status = baselineStatus(baseline);
  const deltas = computeHistoricalDeltas(baseline, currentMetrics);
  const conversations = baseline?.conversationCount ?? 0;
  const insufficient =
    status === "none" || status === "insufficient" || !deltas.length;

  const supportingMetrics: BaselineMetricKind[] = [];
  const conflictingMetrics: BaselineMetricKind[] = [];
  const scores: number[] = [];

  if (!insufficient) {
    for (const delta of deltas) {
      // normalizedDelta 已经按互动投入方向取过号，这里不能再乘一次
      const signed = delta.normalizedDelta;
      scores.push(signed);
      if (signed >= SIGNIFICANCE_SMALL) supportingMetrics.push(delta.metric);
      else if (signed <= -SIGNIFICANCE_SMALL)
        conflictingMetrics.push(delta.metric);
    }
  }

  const base: HistoricalPatternTrend = {
    scope: "historical",
    direction: "uncertain",
    confidence: "low",
    supportingMetrics: supportingMetrics.sort(),
    conflictingMetrics: conflictingMetrics.sort(),
    deltas,
    baselineStatus: status,
    comparedConversations: conversations,
    insufficientHistory: insufficient || !scores.length,
  };

  if (insufficient || !scores.length || conversations < minConversations)
    return { ...base, insufficientHistory: true };

  const avg = average(scores);
  const direction: HistoricalPatternTrend["direction"] =
    supportingMetrics.length >= 2 &&
    conflictingMetrics.length >= 2 &&
    Math.abs(avg) < SIGNIFICANCE_MODERATE
      ? "uncertain"
      : avg >= SIGNIFICANCE_SMALL
        ? "warming"
        : avg <= -SIGNIFICANCE_SMALL
          ? "cooling"
          : "stable";

  const dominant = Math.max(
    supportingMetrics.length,
    conflictingMetrics.length,
  );
  const confidence: HistoricalPatternTrend["confidence"] =
    direction === "uncertain"
      ? "low"
      : Math.abs(avg) >= SIGNIFICANCE_MODERATE && dominant >= 3
        ? "high"
        : Math.abs(avg) >= SIGNIFICANCE_SMALL && dominant >= 2
          ? "medium"
          : "low";

  return { ...base, direction, confidence };
}

/** 给模型阅读的历史趋势文本。数字只搬运，不加工。 */
export function describeHistoricalTrend(
  trend: HistoricalPatternTrend,
): string {
  if (trend.insufficientHistory)
    return `跨会话历史基线：样本不足（已记录 ${trend.comparedConversations} 次对话），本次不得做任何"她平时如何"的判断。`;
  const dir = {
    warming: "高于她平时的水平",
    stable: "与她平时的水平接近",
    cooling: "低于她平时的水平",
    uncertain: "与她平时的水平相比方向不明确",
  }[trend.direction];
  const parts = [
    `跨会话历史基线：本次互动投入${dir}（把握 ${trend.confidence}，基于 ${trend.comparedConversations} 次历史对话）`,
  ];
  if (trend.supportingMetrics.length)
    parts.push(`高于平时的指标：${trend.supportingMetrics.join("、")}`);
  if (trend.conflictingMetrics.length)
    parts.push(`低于平时的指标：${trend.conflictingMetrics.join("、")}`);
  parts.push(
    "这只说明这次与她自己平时的行为不同，不说明关系变好或变差，也不说明原因。",
  );
  return parts.join("。");
}

/** 给模型阅读的历史 delta 明细。 */
export function describeHistoricalDeltas(
  deltas: HistoricalDelta[],
): string[] {
  return deltas.map(
    (d) =>
      `${d.label}：本次 ${d.current}，她平时 ${d.historical}` +
      `（中位数 ${d.historicalMedian ?? "无"}，历史样本 ${d.sampleCount}），变化 ${d.delta > 0 ? "+" : ""}${d.delta}，显著程度 ${d.significance}`,
  );
}

// ---------------------------------------------------------------------------
// 个体语言习惯
// ---------------------------------------------------------------------------

/**
 * 第一版只做高频表达统计 + Jev 观察聚合，不做任何 NLP。
 * 目的很窄：让同一个高频表达不要每次都被重新解读成情绪信号。
 */
export const HABIT_EXPRESSIONS = [
  "哈哈",
  "嘿嘿",
  "嗯",
  "哦",
  "噢",
  "行",
  "好的",
  "好",
  "随你",
  "随便",
  "晚安",
  "在吗",
  "收到",
  "没事",
  "算了",
];

export const HABIT_MIN_OBSERVATIONS = 5;
export const HABIT_MIN_CONVERSATIONS = 2;
/** 跨这么多种语境出现时，判定为语气填充而不是情绪信号。 */
export const HABIT_CONTEXT_SPREAD = 3;
const HABIT_CONTEXT_LIMIT = 8;
/** 存储上限。低于阈值的习惯也会保留计数，否则永远攒不到阈值。 */
export const MAX_HABITS = 40;

/**
 * 是否已经足够稳定，可以拿来抑制误判。
 *
 * 注意：未达标的习惯**不会被丢弃**，只是不参与解读。
 * 丢弃计数会导致「只在一段对话里出现」的习惯永远攒不到第二段。
 */
export function habitIsEstablished(habit: CommunicationHabit): boolean {
  return (
    habit.observedCount >= HABIT_MIN_OBSERVATIONS &&
    habit.conversationCount >= HABIT_MIN_CONVERSATIONS
  );
}

export function establishedHabits(
  habits: CommunicationHabit[],
): CommunicationHabit[] {
  return habits.filter(habitIsEstablished);
}

const FILLER_MEANING =
  "更像语气填充，跨多种情绪语境出现，不宜单独当作情绪信号";

function topLabel(
  values: Record<string, number> | undefined,
  registry: Record<string, { label: string }>,
): string | null {
  if (!values) return null;
  let best: string | null = null;
  let bestValue = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  if (!best) return null;
  return registry[best]?.label ?? best;
}

function habitConfidence(
  observedCount: number,
  conversationCount: number,
): CommunicationHabit["confidence"] {
  if (observedCount >= 15 && conversationCount >= 3) return "high";
  if (observedCount >= 8 && conversationCount >= HABIT_MIN_CONVERSATIONS)
    return "medium";
  return "low";
}

/**
 * 把一段对话的表达统计并入既有习惯表。
 *
 * conversationIds 保证同一段聊天重复提交时不会把计数刷高。
 * 返回值包含**所有**已累计的表达（低于阈值的也在），
 * 否则一段对话里出现一次的习惯永远攒不到两段对话；
 * 是否可用于解读由 habitIsEstablished / establishedHabits 决定。
 */
export function aggregateHabits(
  input: {
    messages: Message[];
    observations: Observation[];
    conversationId: string;
    at: number;
  },
  previous: CommunicationHabit[] = [],
): CommunicationHabit[] {
  const counterpart = input.messages.filter(
    (m) => m.kind === "text" && m.sender === "other",
  );
  const byId = new Map(input.observations.map((o) => [o.messageId, o]));
  const merged = new Map(previous.map((h) => [h.expression, { ...h }]));

  for (const expression of HABIT_EXPRESSIONS) {
    let count = 0;
    const contexts = new Set<string>();
    for (const message of counterpart) {
      const occurrences = message.text.split(expression).length - 1;
      if (occurrences <= 0) continue;
      count += occurrences;
      const observation = byId.get(message.id);
      const emotion = topLabel(observation?.emotions, EMOTIONS);
      const intent = topLabel(observation?.intents, INTENTS);
      if (emotion) contexts.add(emotion);
      if (intent) contexts.add(intent);
    }

    const existing = merged.get(expression);
    if (count <= 0) {
      if (existing) merged.set(expression, existing);
      continue;
    }

    const ids = new Set(existing?.conversationIds ?? []);
    ids.add(input.conversationId);
    const allContexts = [
      ...new Set([...(existing?.contexts ?? []), ...contexts]),
    ].slice(0, HABIT_CONTEXT_LIMIT);
    /**
     * 同一段对话重复提交必须完全幂等：
     * 先减掉这段对话上次的贡献，再加上这次的实际次数。
     * 直接相加会把计数刷高，让一个普通表达假装成长期习惯。
     */
    const countsByConversation = { ...(existing?.countsByConversation ?? {}) };
    const previousContribution = countsByConversation[input.conversationId] ?? 0;
    countsByConversation[input.conversationId] = count;
    const observedCount =
      (existing?.observedCount ?? 0) - previousContribution + count;
    const conversationCount = ids.size;

    merged.set(expression, {
      expression,
      observedCount,
      conversationCount,
      contexts: allContexts,
      usualMeaning:
        allContexts.length >= HABIT_CONTEXT_SPREAD
          ? FILLER_MEANING
          : allContexts.length === 1
            ? `目前只出现在「${allContexts[0]}」语境`
            : "出现的语境还不稳定",
      confidence: habitConfidence(observedCount, conversationCount),
      lastObservedAt: input.at,
      conversationIds: [...ids],
      countsByConversation,
    });
  }

  return [...merged.values()]
    .filter((h) => h.observedCount > 0)
    .sort(
      (a, b) =>
        b.observedCount - a.observedCount ||
        a.expression.localeCompare(b.expression),
    )
    .slice(0, MAX_HABITS);
}

/**
 * 针对当前文本，给出「这是她平时的说话习惯」提示。
 * 它只压制误判，不产生任何结论。
 */
export function habitHints(
  text: string,
  habits: CommunicationHabit[],
): string[] {
  const hints: string[] = [];
  for (const habit of habits) {
    if (!habitIsEstablished(habit) || habit.confidence === "low") continue;
    if (!text.includes(habit.expression)) continue;
    hints.push(
      `「${habit.expression}」在历史 ${habit.observedCount} 次、${habit.conversationCount} 段对话里出现，跨 ${habit.contexts.length} 种语境，${habit.usualMeaning}。不要单独把它当成情绪或关系信号。`,
    );
  }
  return hints;
}

// ---------------------------------------------------------------------------
// 模型推断候选：看到一次不写长期记忆
// ---------------------------------------------------------------------------

const CANDIDATE_KEY_LIMIT = 40;

/** 候选内容太短时不足以成为可复现的模式，直接丢弃。 */
const CANDIDATE_MIN_LENGTH = 6;

/**
 * 判定两个推断「类似」的二元组重合下限（Jaccard）。
 *
 * 0.3 是实测值：用真实 DeepSeek 输出跑 5 轮对话后，同一面（都是意图读法）
 * 的推断之间最高相似度约 0.30，跨面之间普遍更低。阈值取 0.5 会让这条路径
 * 永远无法触发（43 条候选里一对都合不上），取 0.3 并加上「同一面」限制
 * 才能既让反复出现的读法归并，又不把无关内容混在一起。
 */
export const CANDIDATE_SIMILARITY_MIN = 0.3;

function aspectOf(candidate: InferenceCandidate): InferenceCandidateAspect {
  return candidate.aspect ?? "alternative";
}

function candidateKey(text: string): string {
  return text
    .replace(/[\s，。、！？；：""''（）()[\]{}~～!?.,;:]/g, "")
    .slice(0, CANDIDATE_KEY_LIMIT);
}

/** 中文二元组集合，用于判断两条推断是否指向同一个模式。 */
function grams(text: string): Set<string> {
  const clean = text.replace(/[\s，。、！？；：""''（）()[\]{}~～!?.,;:]/g, "");
  const set = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i++) set.add(clean.slice(i, i + 2));
  return set;
}

export function inferenceSimilarity(a: string, b: string): number {
  const left = grams(a);
  const right = grams(b);
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const gram of left) if (right.has(gram)) hit++;
  return hit / (left.size + right.size - hit);
}

/**
 * 从一次解读里收集推断候选。
 * 这些都只是候选：单次出现绝不写进长期记忆。
 */
export function candidatesFromAnalysis(input: {
  analysis: DeepAnalysis;
  conversationId: string;
  at: number;
}): InferenceCandidate[] {
  const { analysis } = input;
  const messageIds = analysis.evidence.map((e) => e.messageId);
  const sources: {
    content: string;
    confidence: number;
    aspect: InferenceCandidateAspect;
  }[] = [
    { content: analysis.latentEmotion.reading, confidence: 0.5, aspect: "emotion" },
    { content: analysis.latentIntent.reading, confidence: 0.5, aspect: "intent" },
    ...analysis.alternativeInterpretations
      .slice(0, 3)
      .map((a) => ({
        content: a.interpretation,
        confidence: 0.4,
        aspect: "alternative" as const,
      })),
  ];

  const seen = new Set<string>();
  const candidates: InferenceCandidate[] = [];
  for (const source of sources) {
    const content = source.content.trim();
    if (content.length < CANDIDATE_MIN_LENGTH) continue;
    const key = candidateKey(content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      id: `cand:${key}`,
      content,
      kind: "pattern",
      aspect: source.aspect,
      sourceMessageIds: messageIds,
      conversationIds: [input.conversationId],
      firstSeenAt: input.at,
      lastSeenAt: input.at,
      observationCount: 1,
      confidence: Math.min(source.confidence, 0.6),
    });
  }
  return candidates;
}

/**
 * 累积模型推断候选。
 *
 * 它**不再产生任何长期记忆**：模型自由文本不参与长期模式的晋升，
 * 只能作为解释辅助进入上下文，或被用户确认后才以 user_confirmed 出现。
 *
 * 归并仍然用相似度（二元组 Jaccard ≥ CANDIDATE_SIMILARITY_MIN）：
 * 那只是为了让候选列表不至于无限膨胀，与「是否成为长期结论」无关。
 * 阈值不再下调 —— 靠更低阈值把不同措辞强行合并，只会制造假模式。
 */
export function mergeInferenceCandidates(
  previous: InferenceCandidate[],
  incoming: InferenceCandidate[],
): InferenceCandidate[] {
  const merged = new Map(previous.map((c) => [c.id, { ...c }]));

  const absorb = (
    existing: InferenceCandidate,
    candidate: InferenceCandidate,
  ): InferenceCandidate => {
    const conversationIds = [
      ...new Set([...existing.conversationIds, ...candidate.conversationIds]),
    ];
    return {
      ...existing,
      sourceMessageIds: [
        ...new Set([
          ...existing.sourceMessageIds,
          ...candidate.sourceMessageIds,
        ]),
      ],
      conversationIds,
      observationCount: conversationIds.length,
      firstSeenAt: Math.min(existing.firstSeenAt, candidate.firstSeenAt),
      lastSeenAt: Math.max(existing.lastSeenAt, candidate.lastSeenAt),
      confidence: Math.max(existing.confidence, candidate.confidence),
    };
  };

  for (const candidate of incoming) {
    const exact = merged.get(candidate.id);
    if (exact) {
      merged.set(exact.id, absorb(exact, candidate));
      continue;
    }
    // 只和「同一面」的候选比较：情绪读法与意图读法即使措辞相似也不是同一条
    let best: InferenceCandidate | null = null;
    let bestScore = 0;
    for (const existing of merged.values()) {
      if (aspectOf(existing) !== aspectOf(candidate)) continue;
      const score = inferenceSimilarity(existing.content, candidate.content);
      if (score > bestScore) {
        best = existing;
        bestScore = score;
      }
    }
    if (best && bestScore >= CANDIDATE_SIMILARITY_MIN) {
      merged.set(best.id, absorb(best, candidate));
      continue;
    }
    merged.set(candidate.id, { ...candidate });
  }

  return [...merged.values()]
    .sort(
      (a, b) =>
        b.observationCount - a.observationCount || a.id.localeCompare(b.id),
    )
    .slice(0, MAX_INFERENCE_CANDIDATES);
}

// ---------------------------------------------------------------------------
// 系统归纳的长期模式（有上限、有生命周期）
// ---------------------------------------------------------------------------

/** 超过这么多天没有再观察到的模式标为 expired。 */
export const KNOWN_PATTERN_EXPIRY_DAYS = 180;

type BehaviorRule = {
  key: string;
  metric: BaselineMetricKind;
  direction: "higher" | "lower" | "stable";
  highRisk?: boolean;
  /** 单个样本是否支持这条模式 */
  test: (value: number) => boolean;
  describe: (input: {
    evidence: number;
    samples: number;
    representative: number;
  }) => string;
};

/**
 * 程序侧行为模式规则表。
 *
 * 这张表就是「她平时就是这样」的唯一来源：只读基线样本，不读任何模型文本。
 * 每条规则都必须能被单条样本判定，因此证据数天然等于「多少段不同对话支持它」。
 * 措辞一律停留在可观察行为上，不写人格、不写感情。
 */
export const BEHAVIOR_RULES: BehaviorRule[] = [
  {
    key: "reply_length_short",
    metric: "reply_length",
    direction: "lower",
    test: (v) => v <= 6,
    describe: ({ evidence, representative }) =>
      `历史上她的回复通常很短（${evidence} 段对话，平均约 ${round1(representative)} 字）`,
  },
  {
    key: "reply_length_long",
    metric: "reply_length",
    direction: "higher",
    test: (v) => v >= 30,
    describe: ({ evidence, representative }) =>
      `历史上她的回复通常很长（${evidence} 段对话，平均约 ${round1(representative)} 字）`,
  },
  {
    key: "reply_latency_fast",
    metric: "reply_latency",
    direction: "lower",
    test: (v) => v <= 5,
    describe: ({ evidence, representative }) =>
      `历史上她的回复通常很快（${evidence} 段对话，平均约 ${round1(representative)} 分钟）`,
  },
  {
    key: "reply_latency_slow",
    metric: "reply_latency",
    direction: "higher",
    test: (v) => v >= 120,
    describe: ({ evidence, representative }) =>
      `历史上她的回复通常较慢（${evidence} 段对话，平均约 ${round1(representative)} 分钟）`,
  },
  {
    key: "initiates_conversation",
    metric: "initiation_ratio",
    direction: "higher",
    test: (v) => v >= 0.5,
    describe: ({ evidence }) => `历史上多由她开启对话（${evidence} 段对话）`,
  },
  {
    key: "rarely_initiates",
    metric: "initiation_ratio",
    direction: "lower",
    test: (v) => v <= 0.2,
    describe: ({ evidence }) => `历史上多由我方开启对话（${evidence} 段对话）`,
  },
  {
    key: "asks_questions",
    metric: "question_density",
    direction: "higher",
    test: (v) => v >= 0.3,
    describe: ({ evidence }) => `历史上她比较常向你提问（${evidence} 段对话）`,
  },
  {
    key: "rarely_asks",
    metric: "question_density",
    direction: "lower",
    test: (v) => v <= 0.05,
    describe: ({ evidence }) => `历史上她很少向你提问（${evidence} 段对话）`,
  },
  {
    key: "closes_conversation",
    metric: "closing_ratio",
    direction: "higher",
    test: (v) => v >= 0.5,
    describe: ({ evidence }) => `历史上她更常用收尾的方式结束对话（${evidence} 段对话）`,
  },
  {
    key: "emotion_net_positive",
    metric: "emotion_drift",
    direction: "higher",
    test: (v) => v >= 0.5,
    describe: ({ evidence }) => `历史上她的正负情绪净值偏正向（${evidence} 段对话）`,
  },
  {
    key: "emotion_net_negative",
    metric: "emotion_drift",
    direction: "lower",
    test: (v) => v <= -0.2,
    describe: ({ evidence }) => `历史上她的正负情绪净值偏负向（${evidence} 段对话）`,
  },
];

/**
 * 事件型规则。
 * 全部标记 highRisk：它们更接近关系层面的解释，因此需要更多对话证据。
 */
const EVENT_RULES: {
  key: string;
  kind: ActivityEventKind;
  describe: (evidence: number) => string;
}[] = [
  {
    key: "accepts_planned_invitations",
    kind: "planned_invite_accepted",
    describe: (evidence) =>
      `历史上她接受过提前约好的安排（${evidence} 段对话）`,
  },
  {
    key: "declines_same_day_invitations",
    kind: "same_day_invite_declined",
    describe: (evidence) =>
      `历史上她较少接受当天临时的邀约（${evidence} 段对话）`,
  },
  {
    key: "counterpart_proposes_activity",
    kind: "counterpart_proposes_activity",
    describe: (evidence) =>
      `历史上她主动提出过一起活动（${evidence} 段对话）`,
  },
];

/**
 * 从基线与事件统计里归纳行为模式候选。
 *
 * 候选只是候选：是否成为长期模式由 promoteBehaviorPatterns 按门槛决定。
 * 这里不用、也不需要任何模型文本。
 */
export function deriveBehaviorPatterns(input: {
  baseline: BehaviorBaseline;
  activityEvents?: ActivityEvent[];
  at?: number;
}): BehaviorPatternCandidate[] {
  const { baseline } = input;
  const at = input.at ?? baseline.lastObservedAt;
  const candidates: BehaviorPatternCandidate[] = [];

  for (const rule of BEHAVIOR_RULES) {
    const metric = baseline.metrics[rule.metric];
    if (!metric) continue;
    const values = metric.recent ?? [];
    const ids = metric.recentConversationIds ?? [];
    if (!values.length) continue;

    const supporting: { id: string; value: number }[] = [];
    values.forEach((value, index) => {
      if (!Number.isFinite(value) || !rule.test(value)) return;
      const id = ids[index];
      // 没有对话 id 的旧样本不能充当证据：宁可少一条，也不虚报证据数
      if (!id) return;
      supporting.push({ id, value });
    });
    if (!supporting.length) continue;
    if (supporting.length / values.length < BEHAVIOR_PATTERN_MIN_RATIO) continue;

    const evidenceConversationIds = [...new Set(supporting.map((s) => s.id))];
    const representative =
      supporting.reduce((n, s) => n + s.value, 0) / supporting.length;
    candidates.push({
      key: rule.key,
      metric: rule.metric,
      direction: rule.direction,
      evidenceConversationIds,
      evidenceCount: evidenceConversationIds.length,
      firstObservedAt: baseline.firstObservedAt || at,
      lastObservedAt: baseline.lastObservedAt || at,
      sourceType: "deterministic",
      highRisk: rule.highRisk,
      representative: round2(representative),
      description: rule.describe({
        evidence: evidenceConversationIds.length,
        samples: supporting.length,
        representative,
      }),
    });
  }

  for (const rule of EVENT_RULES) {
    const ids = [
      ...new Set(
        (input.activityEvents ?? [])
          .filter((event) => event.kind === rule.kind)
          .map((event) => event.conversationId),
      ),
    ];
    if (!ids.length) continue;
    candidates.push({
      key: rule.key,
      metric: "activity_event",
      direction: "higher",
      evidenceConversationIds: ids,
      evidenceCount: ids.length,
      firstObservedAt: at,
      lastObservedAt: at,
      sourceType: "deterministic",
      highRisk: true,
      description: rule.describe(ids.length),
    });
  }

  return candidates.sort(
    (a, b) =>
      Number(Boolean(a.highRisk)) - Number(Boolean(b.highRisk)) ||
      b.evidenceCount - a.evidenceCount ||
      a.key.localeCompare(b.key),
  );
}

/**
 * 把达到门槛的候选晋升成长期模式。
 *
 * 门槛按「不同对话数」计算：
 *   - 一般行为模式：evidenceCount >= BEHAVIOR_PATTERN_MIN_CONVERSATIONS（3）
 *   - 高风险（涉及一起活动、约见这类关系解释）：
 *     evidenceCount >= BEHAVIOR_PATTERN_HIGH_RISK_MIN_CONVERSATIONS（4）
 */
export function promoteBehaviorPatterns(
  candidates: BehaviorPatternCandidate[],
  options: {
    minConversations?: number;
    highRiskMinConversations?: number;
  } = {},
): KnownPattern[] {
  const min = options.minConversations ?? BEHAVIOR_PATTERN_MIN_CONVERSATIONS;
  const highRiskMin =
    options.highRiskMinConversations ??
    BEHAVIOR_PATTERN_HIGH_RISK_MIN_CONVERSATIONS;

  return candidates
    .filter((candidate) => {
      const threshold = candidate.highRisk ? highRiskMin : min;
      // 两个条件都要满足：对应档位的门槛，以及不少于一般门槛的不同对话数
      return (
        candidate.evidenceCount >= threshold && candidate.evidenceCount >= min
      );
    })
    .map((candidate) => ({
      id: `kp:${candidate.key}`,
      patternKey: candidate.key,
      description: candidate.description,
      evidenceCount: candidate.evidenceCount,
      conversationCount: candidate.evidenceConversationIds.length,
      sourceType: "deterministic" as const,
      supportingMetrics: candidate.metric ? [candidate.metric] : [],
      firstObservedAt: candidate.firstObservedAt,
      lastObservedAt: candidate.lastObservedAt,
      status: "active" as const,
    }));
}

/** 证据强度：用户确认 > 程序统计 > 模型推断。冲突时高者胜。 */
const PATTERN_RANK: Record<KnownPatternSource, number> = {
  model_inferred: 1,
  deterministic: 2,
  user_confirmed: 3,
};

/**
 * 合并模式集合。
 *
 * 关键规则：`model_inferred` 永远不能覆盖 `deterministic` 或 `user_confirmed`
 * 的同键模式 —— 模型自由文本不能推翻有证据支撑的行为模式。
 * 不在 incoming 里的既有模式（例如用户自己确认的）会原样保留。
 */
export function mergeKnownPatterns(
  existing: KnownPattern[],
  incoming: KnownPattern[],
): KnownPattern[] {
  const merged = new Map<string, KnownPattern>();
  for (const pattern of existing) merged.set(pattern.patternKey, pattern);

  for (const pattern of incoming) {
    const current = merged.get(pattern.patternKey);
    if (!current) {
      merged.set(pattern.patternKey, pattern);
      continue;
    }
    const rank = PATTERN_RANK[pattern.sourceType];
    const currentRank = PATTERN_RANK[current.sourceType];
    if (rank < currentRank) continue;
    if (rank === currentRank && pattern.evidenceCount <= current.evidenceCount) {
      // 证据没有变强时只刷新观察时间，不覆盖描述
      merged.set(pattern.patternKey, {
        ...current,
        lastObservedAt: Math.max(current.lastObservedAt, pattern.lastObservedAt),
        status:
          current.status === "contradicted" ? current.status : pattern.status,
      });
      continue;
    }
    merged.set(pattern.patternKey, {
      ...current,
      ...pattern,
      firstObservedAt: Math.min(
        current.firstObservedAt || pattern.firstObservedAt,
        pattern.firstObservedAt || current.firstObservedAt,
      ),
      // 被用户纠正推翻的模式不因重新统计而复活
      status:
        current.status === "contradicted" ? current.status : pattern.status,
    });
  }

  return [...merged.values()];
}

/**
 * 归纳长期模式。
 *
 * 自动产生的只有 deterministic（程序统计 + 表达习惯 + 确定性事件）。
 * 模型推断的旧模式会被标为 superseded：它不参与解读，但内容保留可复盘。
 */
export function deriveKnownPatterns(input: {
  baseline: BehaviorBaseline;
  habits: CommunicationHabit[];
  activityEvents?: ActivityEvent[];
  previous: KnownPattern[];
  at: number;
}): KnownPattern[] {
  const generated: KnownPattern[] = [
    ...promoteBehaviorPatterns(
      deriveBehaviorPatterns({
        baseline: input.baseline,
        activityEvents: input.activityEvents,
        at: input.at,
      }),
    ),
  ];

  for (const habit of input.habits) {
    if (!habitIsEstablished(habit) || habit.confidence === "low") continue;
    // 「语气填充」这类长说明只取核心词，避免拼出不通顺的句子
    const meaning = habit.usualMeaning.startsWith("更像语气填充")
      ? "语气填充"
      : habit.usualMeaning.replace(/^目前只出现在/, "只在");
    generated.push({
      id: `kp:habit:${habit.expression}`,
      patternKey: `habit:${habit.expression}`,
      description: `常用「${habit.expression}」作为${meaning}（${habit.observedCount} 次 / ${habit.conversationCount} 段对话）`,
      evidenceCount: habit.observedCount,
      conversationCount: habit.conversationCount,
      sourceType: "deterministic",
      supportingMetrics: ["reply_length"],
      firstObservedAt: habit.lastObservedAt,
      lastObservedAt: habit.lastObservedAt,
      status: "active",
    });
  }

  const observedAt = new Map<string, number>();
  for (const pattern of generated)
    observedAt.set(pattern.patternKey, pattern.lastObservedAt);

  /**
   * deterministic 模式是「当前基线的视图」，必须由当前证据支撑。
   * 一旦现在的数据不再支持它（例如她最近开始写长消息），
   * 就打上 expired，而不是让旧描述一直挂着当结论。
   */
  const stillSupported = new Set(generated.map((p) => p.patternKey));
  const carried = input.previous.map((pattern) =>
    pattern.sourceType === "deterministic" &&
    pattern.status === "active" &&
    !stillSupported.has(pattern.patternKey)
      ? { ...pattern, status: "expired" as MemoryStatus }
      : pattern,
  );

  const expiryMs = KNOWN_PATTERN_EXPIRY_DAYS * DAY_MS;
  return mergeKnownPatterns(carried, generated)
    .map((pattern) => {
      // 模型推断不再自动成为长期模式：内容保留，状态标为已被取代
      const stale =
        pattern.sourceType === "model_inferred" && pattern.status === "active";
      /**
       * 当前数据是否仍然支持这条模式。
       * 只有 deterministic 模式需要「当前证据」；用户确认与旧模型推断不受影响。
       */
      const supportedNow =
        pattern.sourceType !== "deterministic" ||
        stillSupported.has(pattern.patternKey);
      const last = Math.max(
        observedAt.get(pattern.patternKey) ?? 0,
        pattern.lastObservedAt,
      );
      const tooOld =
        supportedNow &&
        !stale &&
        last > 0 &&
        input.at - last > expiryMs &&
        input.at >= last;

      let status: MemoryStatus;
      if (pattern.status === "contradicted") status = "contradicted";
      else if (stale) status = "superseded";
      // 证据不再支持：标 expired，而不是让旧描述一直挂着当结论
      else if (!supportedNow) status = "expired";
      else if (tooOld) status = "expired";
      // 重新被证据支持则回到 active
      else if (pattern.status === "expired") status = "active";
      else status = pattern.status;

      return { ...pattern, lastObservedAt: last, status };
    })
    .sort(
      (a, b) =>
        PATTERN_RANK[b.sourceType] - PATTERN_RANK[a.sourceType] ||
        b.evidenceCount - a.evidenceCount ||
        a.patternKey.localeCompare(b.patternKey),
    )
    .slice(0, MAX_KNOWN_PATTERNS);
}

// ---------------------------------------------------------------------------
// 用户确认 / 纠错
// ---------------------------------------------------------------------------

export function emptyFeedbackStats(): FeedbackStats {
  return {
    total: 0,
    helpful: 0,
    problematic: 0,
    overinterpretation: 0,
    underinterpretation: 0,
    missedSignal: 0,
    tooCertain: 0,
    confirmedInterpretations: 0,
    contradictedInterpretations: 0,
  };
}

/**
 * 只用于让系统了解自己的历史表现。
 * 刻意不做成「用户性格评分」，也不反馈进任何 prompt。
 */
export function computeFeedbackStats(input: {
  interpretationFeedback?: InterpretationFeedback[];
  confirmations?: InterpretationConfirmation[];
  corrections?: UserCorrection[];
}): FeedbackStats {
  const stats = emptyFeedbackStats();
  const feedback = input.interpretationFeedback ?? [];

  stats.total = feedback.length;
  for (const entry of feedback) {
    if (entry.verdict === "helpful") {
      stats.helpful++;
      continue;
    }
    stats.problematic++;
    if (entry.reasons.includes("missed_signal")) stats.missedSignal++;
    if (entry.reasons.includes("too_certain")) stats.tooCertain++;
    if (entry.reasons.includes("overthinking")) stats.overinterpretation++;
    if (entry.reasons.includes("wrong_reading")) stats.underinterpretation++;
  }

  for (const confirmation of input.confirmations ?? []) {
    if (confirmation.verdict === "incorrect") {
      stats.contradictedInterpretations++;
      continue;
    }
    if (
      (confirmation.verdict === "mostly_correct" ||
        confirmation.verdict === "partly_correct") &&
      confirmation.confirmedParts.length
    )
      stats.confirmedInterpretations++;
  }

  stats.contradictedInterpretations += (input.corrections ?? []).length;
  return stats;
}

/**
 * 可被用户逐项勾选确认的部分。
 *
 * 即使用户选了「基本正确」，系统也只能升级用户真正勾选的那几项，
 * 不能把整份解读里的所有推断一起变成事实。
 */
export function confirmationParts(
  analysis: DeepAnalysis,
  candidates: InferenceCandidate[] = [],
): ConfirmationPart[] {
  const parts: ConfirmationPart[] = [
    {
      key: "emotion",
      label: "对方当时的情绪读法",
      detail: analysis.latentEmotion.reading,
    },
    {
      key: "intent",
      label: "对方当时的意图读法",
      detail: analysis.latentIntent.reading,
    },
  ];
  analysis.alternativeInterpretations.slice(0, 3).forEach((item, index) => {
    parts.push({
      key: `interp:${index}`,
      label: `可能解释 ${index + 1}`,
      detail: item.interpretation,
    });
  });
  for (const candidate of candidates.slice(0, 4))
    parts.push({
      key: `memory:${candidate.id}`,
      label: "模型推断的模式",
      detail: candidate.content,
    });
  return parts.filter((p) => p.detail.trim().length > 0);
}

/** 用户确认后的记忆内容统一带上这个前缀，避免与对方原话混淆。 */
export const CONFIRMED_PREFIX = "用户确认：";

/**
 * 应用一次用户确认。
 *
 * 硬规则：
 *   - 只升级 confirmedParts 里明确列出的内容；
 *   - 没有任何一条 model_inferred 会因为「整体判对了」而自动升级；
 *   - 用户没勾选的部分保持原样。
 */
export function applyConfirmation(
  profile: PersonProfile,
  input: {
    confirmation: InterpretationConfirmation;
    analysis?: DeepAnalysis | null;
    now: string;
    at: number;
  },
): PersonProfile {
  const { confirmation } = input;
  const confirmed = new Set(confirmation.confirmedParts);
  let memories = [...profile.memories];
  const confirmedPatterns: KnownPattern[] = [];

  for (const key of confirmed) {
    if (key.startsWith("memory:")) {
      const candidateId = key.slice("memory:".length);
      const candidate = profile.inferenceCandidates.find(
        (c) => c.id === candidateId,
      );
      memories = memories.map((m) =>
        m.id === `mem:pattern:${candidateId}` || m.id === candidateId
          ? {
              ...m,
              sourceType: "user_confirmed" as const,
              confidence: 1,
              status: "active" as const,
              lastConfirmedAt: input.now,
            }
          : m,
      );
      /**
       * 用户确认过的模型推断可以成为长期模式 —— 这是它唯一的合法路径。
       * 它带着 user_confirmed 来源，优先级高于程序统计与模型推断。
       */
      if (candidate)
        confirmedPatterns.push({
          id: `kp:user:${candidateId}`.slice(0, 160),
          patternKey: `user:${candidateId}`.slice(0, 160),
          description: `${CONFIRMED_PREFIX}${candidate.content}`,
          evidenceCount: Math.max(1, candidate.observationCount),
          conversationCount: Math.max(1, candidate.conversationIds.length),
          sourceType: "user_confirmed",
          supportingMetrics: [],
          firstObservedAt: candidate.firstSeenAt,
          lastObservedAt: input.at,
          status: "active",
        });
      continue;
    }

    const part = confirmationPartDetail(input.analysis, key);
    if (!part) continue;
    const id = `mem:confirmed:${confirmation.contextKey}:${key}`.slice(0, 160);
    if (memories.some((m) => m.id === id)) continue;
    memories.push({
      id,
      kind: "event",
      content: `${CONFIRMED_PREFIX}${part}`,
      sourceMessageIds: input.analysis
        ? input.analysis.evidence.map((e) => e.messageId)
        : [],
      createdAt: input.now,
      lastConfirmedAt: input.now,
      status: "active",
      confidence: 1,
      sourceType: "user_confirmed",
    });
  }

  const confirmations = [
    ...profile.confirmations.filter((c) => c.contextKey !== confirmation.contextKey),
    confirmation,
  ];

  return {
    ...profile,
    memories,
    knownPatterns: mergeKnownPatterns(profile.knownPatterns, confirmedPatterns),
    confirmations,
    updatedAt: input.at,
    feedbackStats: computeFeedbackStats({
      confirmations,
      corrections: profile.corrections,
    }),
  };
}

function confirmationPartDetail(
  analysis: DeepAnalysis | null | undefined,
  key: string,
): string | null {
  if (!analysis) return null;
  if (key === "emotion") return analysis.latentEmotion.reading;
  if (key === "intent") return analysis.latentIntent.reading;
  const match = key.match(/^interp:(\d+)$/);
  if (match)
    return (
      analysis.alternativeInterpretations[Number(match[1])]?.interpretation ??
      null
    );
  return null;
}

/** 中文二元组，用于在纠错时找出可能冲突的推断。只做确定性比对。 */
function bigrams(text: string): Set<string> {
  const clean = text.replace(/[\s，。、！？；：""''（）()[\]{}~～!?.,;:]/g, "");
  const grams = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i++) grams.add(clean.slice(i, i + 2));
  return grams;
}

/** 判定冲突的二元组重合下限。 */
export const CORRECTION_OVERLAP_MIN = 2;

/**
 * 找出可能被用户纠错推翻的模型推断。
 * 只**建议**，最终由用户勾选；这里绝不自动改任何东西。
 */
export function findConflictingInferences(
  memories: LongTermMemory[],
  correction: string,
): LongTermMemory[] {
  const target = bigrams(correction);
  if (!target.size) return [];
  return memories
    .filter((m) => m.sourceType === "model_inferred" && m.status === "active")
    .map((m) => {
      const grams = bigrams(m.content);
      let hit = 0;
      for (const gram of grams) if (target.has(gram)) hit++;
      return { memory: m, hit };
    })
    .filter((entry) => entry.hit >= CORRECTION_OVERLAP_MIN)
    .sort((a, b) => b.hit - a.hit || a.memory.id.localeCompare(b.memory.id))
    .map((entry) => entry.memory);
}

/**
 * 应用一次用户纠错。
 *
 * 1. 保存用户确认的事实（user_confirmed）；
 * 2. 把冲突的 model_inferred 标为 contradicted；
 * 3. 绝不删除历史推断，状态与内容都留着，以后可以复盘；
 * 4. user_confirmed 在检索与解读里优先级最高。
 */
export function applyUserCorrection(
  profile: PersonProfile,
  input: {
    correction: UserCorrection;
    now: string;
    at: number;
  },
): PersonProfile {
  const { correction } = input;
  const targets = new Set(correction.contradictedIds);
  const contradicted: string[] = [];

  const memories = profile.memories.map((m) => {
    if (!targets.has(m.id)) return m;
    // 用户确认的内容不会被纠错降级；只有模型推断会被标记
    if (m.sourceType === "user_confirmed") return m;
    contradicted.push(m.id);
    return { ...m, status: "contradicted" as const };
  });

  const factId = `mem:correction:${correction.id}`;
  if (!memories.some((m) => m.id === factId))
    memories.push({
      id: factId,
      kind: "fact",
      content: correction.content,
      sourceMessageIds: [],
      createdAt: input.now,
      lastConfirmedAt: input.now,
      status: "active",
      confidence: 1,
      sourceType: "user_confirmed",
    });

  const stored: UserCorrection = { ...correction, contradictedIds: contradicted };

  // 被标记为 contradicted 的推断不再参与模式归纳
  const candidates = profile.inferenceCandidates.filter(
    (c) => !contradicted.includes(`mem:pattern:${c.id}`),
  );
  /**
   * 被推翻的推断如果曾被用户确认成长期模式，那条模式也要作废 ——
   * 但只标状态，内容与证据都保留，方便以后复盘。
   */
  const knownPatterns = profile.knownPatterns.map((p) => {
    const confirmedCandidate = p.id.startsWith("kp:user:")
      ? `mem:pattern:${p.id.slice("kp:user:".length)}`
      : null;
    const contradictedPattern =
      (confirmedCandidate && contradicted.includes(confirmedCandidate)) ||
      contradicted.includes(`mem:pattern:${p.patternKey}`);
    return contradictedPattern && p.sourceType !== "deterministic"
      ? { ...p, status: "contradicted" as const }
      : p;
  });

  const corrections = [
    ...profile.corrections.filter((c) => c.id !== stored.id),
    stored,
  ];

  return {
    ...profile,
    memories,
    inferenceCandidates: candidates,
    knownPatterns,
    corrections,
    updatedAt: input.at,
    feedbackStats: computeFeedbackStats({
      confirmations: profile.confirmations,
      corrections,
    }),
  };
}

// ---------------------------------------------------------------------------
// 档案
// ---------------------------------------------------------------------------

/** 由对方称呼与关系类型派生稳定的档案 id。同一段关系始终落到同一个档案。 */
export function profileIdFor(input: {
  displayName?: string;
  relation: Relation;
}): string {
  const slug = (input.displayName ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "");
  return `profile:${slug || "unknown"}:${input.relation}`;
}

export function emptyProfile(input: {
  id: string;
  displayName?: string;
  relationshipContext: RelationshipContext;
  at: number;
}): PersonProfile {
  return {
    id: input.id,
    displayName: input.displayName,
    relationshipContext: { ...input.relationshipContext },
    createdAt: input.at,
    updatedAt: input.at,
    baselineVersion: 1,
    behaviorBaseline: emptyBaseline(),
    memories: [],
    knownPatterns: [],
    habits: [],
    activityEvents: [],
    inferenceCandidates: [],
    feedbackStats: emptyFeedbackStats(),
    confirmations: [],
    corrections: [],
    sourceConversationIds: [],
  };
}

/** 已经并入过基线的对话不重复计入，避免刷新页面把样本刷高。 */
export function hasConversation(
  profile: PersonProfile,
  conversationId: string,
): boolean {
  return profile.sourceConversationIds.includes(conversationId);
}

/** 把用户自述的长期模式限制在硬上限内，防止自由文本无限堆叠。 */
export function boundedKnownPatterns(patterns: string[]): string[] {
  return patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, MAX_KNOWN_PATTERNS);
}

/** 「和她平时相比」的文案。只描述行为变化，禁止关系结论。 */
export function describeComparedToUsual(
  trend: HistoricalPatternTrend,
): string[] {
  if (trend.insufficientHistory)
    return [baselineStatusLabel(trend.baselineStatus, trend.comparedConversations)];

  const lines: string[] = [];
  const notable = trend.deltas.filter((d) => d.significance !== "none");
  const stable = trend.deltas.filter((d) => d.significance === "none");

  for (const delta of notable.slice(0, 3)) {
    const direction = deltaWord(delta);
    if (!direction) continue;
    const magnitude =
      delta.significance === "large"
        ? "非常明显"
        : delta.significance === "moderate"
          ? "明显"
          : "略微";
    lines.push(
      `她这次的${deltaShortLabel(delta.metric)}${magnitude}${direction}（本次 ${delta.current}，她平时约 ${delta.historical}，基于 ${delta.sampleCount} 次历史样本）。`,
    );
  }

  for (const delta of stable.slice(0, 2)) {
    if (!STYLE_METRICS.includes(delta.metric)) continue;
    lines.push(
      `她的${deltaShortLabel(delta.metric)}这次是 ${delta.current}，和她平时的水平（约 ${delta.historical}）接近，这本身不构成变化。`,
    );
  }

  if (!lines.length)
    lines.push("这次的行为指标和她平时的水平接近，没有观察到明显不同。");
  lines.push(baselineStatusLabel(trend.baselineStatus, trend.comparedConversations));
  return lines;
}

/** 反映「她说话风格」的指标：一直如此就不该被当成信号。 */
export const STYLE_METRICS: BaselineMetricKind[] = [
  "reply_length",
  "reply_latency",
];

function deltaShortLabel(metric: BaselineMetricKind): string {
  return (
    {
      initiation_ratio: "主动开口比例",
      reply_latency: "回复速度",
      reply_length: "回复长度",
      question_density: "提问频率",
      continuation_rate: "接话比例",
      closing_ratio: "收尾比例",
      emotion_drift: "正负情绪净值",
      intent_drift: "主动靠近的表达",
    } as Record<BaselineMetricKind, string>
  )[metric];
}

/** 变化方向的中文措辞。一律描述行为，不描述感情。 */
function deltaWord(delta: HistoricalDelta): string | null {
  const spec = metricSpec(delta.metric);
  if (!spec) return null;
  const up = delta.delta > 0;
  if (delta.metric === "reply_latency") return up ? "慢于平时" : "快于平时";
  if (delta.metric === "closing_ratio")
    return up ? "更多于平时" : "更少于平时";
  return up ? "高于平时" : "低于平时";
}

export type { ConfirmationVerdict };
