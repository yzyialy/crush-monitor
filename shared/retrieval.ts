import { establishedHabits, habitHints } from "./profile";
import { metricLabel, sessionMetricValues } from "./patterns";
import {
  INFERENCE_BACKGROUND_LIMIT,
  RETRIEVAL_LIMITS,
  RETRIEVAL_TOKEN_BUDGET,
  type BaselineMetricKind,
  type BehaviorBaseline,
  type CommunicationHabit,
  type DeepAnalysis,
  type HistoricalPatternTrend,
  type KnownPatternSource,
  type LongTermMemory,
  type MemoryKind,
  type Message,
  type Observation,
  type Pattern,
  type PersonProfile,
  type ProfileContextBundle,
  type SourceType,
  type TaggedMemory,
} from "./types";

/**
 * 记忆检索。
 *
 * 第二层模型不能每次吃完整历史：这里只挑出与当前对话相关的子集，
 * 并且按来源等级排序 —— user_confirmed > observed > model_inferred。
 * 冲突时用户确认的内容覆盖解释权重，但旧推断不会被物理删除，
 * 只是在检索里被降权或被排除（contradicted / expired 一律不参与）。
 *
 * 纯函数，无网络调用，token 预算固定。
 */

const SOURCE_TAG: Record<SourceType, TaggedMemory["source"]> = {
  user_confirmed: "USER_CONFIRMED",
  observed: "OBSERVED",
  model_inferred: "MODEL_INFERRED",
};

/** 来源等级：数值越大越优先，冲突时覆盖权重越高。 */
const SOURCE_RANK: Record<SourceType, number> = {
  user_confirmed: 3,
  observed: 2,
  model_inferred: 1,
};

/** 一直在检索里占位的记忆类型：未解决的事与边界不该被窗口挤掉。 */
const ALWAYS_INCLUDED: MemoryKind[] = ["unresolved", "boundary"];

/**
 * 粗略 token 估算：CJK 约 1 字 1 token，其余约 4 字符 1 token。
 * 只用于控制上下文体积，不参与任何判断。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 传输用的紧凑基线。
 *
 * 去掉增量累加器与原始样本窗口：服务端只读不写基线，
 * 更新永远发生在客户端（local-first），所以这些字段不需要出浏览器。
 * 但 lastValue / previousMean / previousMedian / previousSampleCount 必须保留，
 * 否则服务端算不出「排除本次」之后的参照值，两边数字会不一致。
 */
export function compactBaseline(
  baseline: BehaviorBaseline | null | undefined,
): BehaviorBaseline {
  const metrics: BehaviorBaseline["metrics"] = {};
  for (const [kind, metric] of Object.entries(baseline?.metrics ?? {})) {
    if (!metric) continue;
    metrics[kind as BaselineMetricKind] = {
      mean: metric.mean,
      median: metric.median,
      variance: metric.variance,
      sampleCount: metric.sampleCount,
      updatedAt: metric.updatedAt,
      weightSum: 0,
      weightedSum: 0,
      recent: [],
      lastValue: metric.lastValue,
      previousMean: metric.previousMean,
      previousMedian: metric.previousMedian,
      previousSampleCount: metric.previousSampleCount,
    };
  }
  return {
    sampleCount: baseline?.sampleCount ?? 0,
    conversationCount: baseline?.conversationCount ?? 0,
    firstObservedAt: baseline?.firstObservedAt ?? 0,
    lastObservedAt: baseline?.lastObservedAt ?? 0,
    metrics,
  };
}

/** 当前窗口里是否出现过这条记忆的证据消息。 */
function touchesWindow(memory: LongTermMemory, windowIds: Set<string>): boolean {
  return memory.sourceMessageIds.some((id) => windowIds.has(id));
}

/** 记忆里是否有词出现在当前对话里。只做字符级包含，不做任何推断。 */
function sharesTerms(memory: LongTermMemory, text: string): boolean {
  const clean = memory.content.replace(/[\s，。、！？；：「」]/g, "");
  const grams: string[] = [];
  for (let i = 0; i + 1 < clean.length; i += 3) grams.push(clean.slice(i, i + 2));
  return grams.some((gram) => gram.length === 2 && text.includes(gram));
}

function scoreMemory(
  memory: LongTermMemory,
  windowIds: Set<string>,
  text: string,
): number {
  let score = SOURCE_RANK[memory.sourceType] * 2;
  if (touchesWindow(memory, windowIds)) score += 3;
  if (ALWAYS_INCLUDED.includes(memory.kind)) score += 3;
  if (sharesTerms(memory, text)) score += 2;
  if (memory.kind === "fact" || memory.kind === "preference") score += 1;
  if (memory.sourceType === "model_inferred") score -= 1;
  return score;
}

/**
 * 检索与当前对话相关的跨会话上下文。
 *
 * 输出只包含：
 *   1. 当前涉及的相关事实
 *   2. 与当前行为变化有关的基线
 *   3. 相关的语言习惯
 *   4. 最近的重要事件
 *   5. 未解决的事（永远带上）
 *   6. user_confirmed 的内容优先
 */
export function retrieveRelevantProfileContext(input: {
  profile: PersonProfile;
  messages: Message[];
  observations?: Observation[];
  budget?: number;
}): ProfileContextBundle {
  const budget = input.budget ?? RETRIEVAL_TOKEN_BUDGET;
  const windowIds = new Set(input.messages.map((m) => m.id));
  const text = input.messages.map((m) => m.text).join("\n");

  // contradicted / expired / superseded / archived 一律不进入解读上下文
  const active = input.profile.memories.filter((m) => m.status === "active");
  const ranked = active
    .map((memory) => ({
      memory,
      score: scoreMemory(memory, windowIds, text),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        SOURCE_RANK[b.memory.sourceType] - SOURCE_RANK[a.memory.sourceType] ||
        a.memory.id.localeCompare(b.memory.id),
    )
    .map((entry) => entry.memory);

  const limitFor = (source: SourceType, fallback: number) =>
    source === "user_confirmed"
      ? RETRIEVAL_LIMITS.confirmed
      : source === "observed"
        ? RETRIEVAL_LIMITS.observed
        : fallback;

  const taken: Record<SourceType, LongTermMemory[]> = {
    user_confirmed: [],
    observed: [],
    model_inferred: [],
  };
  for (const memory of ranked) {
    const bucket = taken[memory.sourceType];
    if (bucket.length >= limitFor(memory.sourceType, RETRIEVAL_LIMITS.inferred))
      continue;
    bucket.push(memory);
  }

  const toTagged = (memory: LongTermMemory): TaggedMemory => ({
    source: SOURCE_TAG[memory.sourceType],
    kind: memory.kind,
    content: memory.content,
    confidence: memory.confidence,
  });

  /**
   * 「当前事实」= 与这段对话直接相关的客观事实（其来源消息就在窗口里，
   * 或者内容与当前对话共享词面）。它的优先级仅次于用户确认：
   * 「对方说这周项目上线」比任何长期模式都更该被看到。
   */
  const isCurrentFact = (memory: LongTermMemory) =>
    touchesWindow(memory, windowIds) || sharesTerms(memory, text);
  const currentFacts = taken.observed
    .filter(isCurrentFact)
    .slice(0, RETRIEVAL_LIMITS.currentFacts)
    .map(toTagged);
  const currentIds = new Set(
    taken.observed.filter(isCurrentFact).slice(0, RETRIEVAL_LIMITS.currentFacts).map((m) => m.id),
  );
  const observed = taken.observed.filter((m) => !currentIds.has(m.id));

  // 未解决事件永远带上，即使它不在上面的排序里
  const unresolvedExtra = active.filter(
    (m) => m.kind === "unresolved" && !ranked.includes(m),
  );

  /**
   * 模型推断只作为解释辅助：旧档案里的 model_inferred 记忆与最近的候选
   * 合并成弱背景，条数有硬上限，且在预算不足时**最先**被裁掉。
   */
  const inferenceCandidates = [...input.profile.inferenceCandidates]
    .sort(
      (a, b) =>
        b.observationCount - a.observationCount || a.id.localeCompare(b.id),
    )
    .slice(0, INFERENCE_BACKGROUND_LIMIT)
    .map<TaggedMemory>((candidate) => ({
      source: "MODEL_INFERRED",
      kind: candidate.kind,
      content: candidate.content,
      confidence: candidate.confidence,
    }));
  const inferred = [...taken.model_inferred.map(toTagged), ...inferenceCandidates]
    .filter(
      (item, index, list) =>
        list.findIndex((other) => other.content === item.content) === index,
    )
    .slice(0, RETRIEVAL_LIMITS.inferred);

  const habits = rankHabits(input.profile.habits, text);
  /**
   * 只有 active 的程序统计（或用户确认）模式才进入解读上下文。
   * 模型推断的模式即便还留在旧档案里，也不能作为「已知模式」出现。
   */
  const knownPatterns = input.profile.knownPatterns
    .filter((p) => p.status === "active" && p.sourceType !== "model_inferred")
    .sort(
      (a, b) =>
        PATTERN_SOURCE_RANK[b.sourceType] - PATTERN_SOURCE_RANK[a.sourceType] ||
        b.evidenceCount - a.evidenceCount ||
        a.patternKey.localeCompare(b.patternKey),
    )
    .slice(0, RETRIEVAL_LIMITS.patterns);

  const bundle: ProfileContextBundle = {
    baselineStatus: baselineStatusOf(input.profile),
    comparedConversations: input.profile.behaviorBaseline.conversationCount,
    baseline: compactBaseline(input.profile.behaviorBaseline),
    confirmed: taken.user_confirmed.map(toTagged),
    currentFacts,
    observed: observed.map(toTagged),
    inferred,
    habits,
    knownPatterns,
    unresolved: unresolvedExtra
      .filter((m) => m.sourceType !== "observed")
      .map(toTagged),
    corrections: input.profile.corrections.slice(-3).map((c) => c.content),
    estimatedTokens: 0,
    truncated: false,
  };

  return enforceBudget(bundle, budget);
}

function baselineStatusOf(profile: PersonProfile) {
  const count = profile.behaviorBaseline.conversationCount;
  if (count <= 0) return "none" as const;
  if (count < 3) return "insufficient" as const;
  if (count <= 5) return "early" as const;
  return "established" as const;
}

/** 与当前对话相关的语言习惯排在前面；没有命中的按出现次数排。 */
function rankHabits(
  habits: CommunicationHabit[],
  text: string,
): CommunicationHabit[] {
  return establishedHabits(habits)
    .map((habit) => ({
      habit,
      score: (text.includes(habit.expression) ? 10 : 0) + habit.observedCount,
    }))
    .sort((a, b) => b.score - a.score || a.habit.expression.localeCompare(b.habit.expression))
    .slice(0, RETRIEVAL_LIMITS.habits)
    .map((entry) => entry.habit);
}

/**
 * 超预算时的裁剪阶梯，顺序就是优先级的倒序：
 *   模型推断 → 未解决事件 → 表达习惯 → 观察事实 → 稳定模式 → 当前事实
 * 用户确认的内容**永不裁剪**。
 *
 * 硬要求：宁可丢模型推断，也不要丢用户确认或稳定行为模式。
 */
const TRIM_LADDER: {
  label: string;
  apply: (bundle: ProfileContextBundle) => ProfileContextBundle;
}[] = [
  {
    label: "model_inferred",
    apply: (bundle) => ({ ...bundle, inferred: [] }),
  },
  {
    label: "unresolved",
    apply: (bundle) => ({ ...bundle, unresolved: bundle.unresolved.slice(0, 1) }),
  },
  {
    label: "habits",
    apply: (bundle) => ({ ...bundle, habits: bundle.habits.slice(0, 3) }),
  },
  {
    label: "observed",
    apply: (bundle) => ({ ...bundle, observed: bundle.observed.slice(0, 2) }),
  },
  {
    label: "known_patterns",
    apply: (bundle) => ({
      ...bundle,
      knownPatterns: bundle.knownPatterns.slice(0, 3),
    }),
  },
  {
    label: "current_facts",
    apply: (bundle) => ({
      ...bundle,
      currentFacts: bundle.currentFacts.slice(0, 2),
    }),
  },
];

/** 计算上下文体积，超预算时按优先级从低到高丢弃。 */
function enforceBudget(
  bundle: ProfileContextBundle,
  budget: number,
): ProfileContextBundle {
  const cost = (b: ProfileContextBundle) =>
    estimateTokens(
      JSON.stringify({ ...b, estimatedTokens: 0, truncated: false, trimmed: [] }),
    );

  let next = bundle;
  const trimmed: string[] = [];

  for (const step of TRIM_LADDER) {
    if (cost(next) <= budget) break;
    next = step.apply(next);
    trimmed.push(step.label);
  }

  return {
    ...next,
    estimatedTokens: cost(next),
    truncated: trimmed.length > 0,
    trimmed,
  };
}

// ---------------------------------------------------------------------------
// 给模型阅读的文本：每条都带明确的来源标签
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<TaggedMemory["source"], string> = {
  USER_CONFIRMED: "【用户确认】",
  OBSERVED: "【观察事实】",
  MODEL_INFERRED: "【模型推断·弱背景】",
};

/** 已知模式的来源标签。deterministic = 程序统计，不是模型猜的。 */
const PATTERN_SOURCE_LABEL: Record<KnownPatternSource, string> = {
  deterministic: "程序统计",
  user_confirmed: "用户确认",
  model_inferred: "模型推断",
};

/** 进入检索时的模式来源排序：用户确认 > 程序统计 > 模型推断。 */
const PATTERN_SOURCE_RANK: Record<KnownPatternSource, number> = {
  user_confirmed: 3,
  deterministic: 2,
  model_inferred: 1,
};

export function describeProfileContext(
  bundle: ProfileContextBundle,
): string[] {
  const lines: string[] = [];

  lines.push(
    `【历史基线状态】已记录 ${bundle.comparedConversations} 次对话，成熟度 ${bundle.baselineStatus}`,
  );
  if (bundle.baselineStatus === "none" || bundle.baselineStatus === "insufficient")
    lines.push(
      "【历史不足】本次不得写「她平时如何」「和以前不一样」这类跨会话判断。",
    );

  for (const metric of Object.entries(bundle.baseline.metrics)) {
    const value = metric[1];
    if (!value) continue;
    lines.push(
      `【历史基线】${metricLabel(metric[0] as BaselineMetricKind)}：平时约 ${value.mean}` +
        (typeof value.median === "number" ? `（中位数 ${value.median}）` : "") +
        `，样本 ${value.sampleCount}`,
    );
  }

  for (const item of bundle.confirmed)
    lines.push(`${SOURCE_LABEL[item.source]}${item.content}`);
  // 与当前对话直接相关的事实排在稳定模式之前
  for (const item of bundle.currentFacts)
    lines.push(`【当前事实】${item.content}`);
  for (const item of bundle.knownPatterns)
    lines.push(`【已知模式·${PATTERN_SOURCE_LABEL[item.sourceType]}】${item.description}`);
  for (const item of bundle.observed)
    lines.push(`${SOURCE_LABEL[item.source]}${item.content}`);
  for (const habit of bundle.habits)
    lines.push(
      `【表达习惯】「${habit.expression}」出现 ${habit.observedCount} 次、跨 ${habit.conversationCount} 段对话，${habit.usualMeaning}`,
    );
  for (const item of bundle.unresolved)
    lines.push(`${SOURCE_LABEL[item.source]}（未解决）${item.content}`);
  for (const item of bundle.inferred)
    lines.push(`${SOURCE_LABEL[item.source]}${item.content}`);
  for (const correction of bundle.corrections)
    lines.push(`【用户纠错】${correction}`);

  if (lines.length > 1)
    lines.push(
      "来源权重：用户确认 > 当前事实 > 程序统计的已知模式 > 观察事实 > 表达习惯 > " +
        "未解决事件 > 模型推断。只有达到证据门槛（至少 3 段不同对话，涉及一起活动这类" +
        "关系解释需要 4 段）的程序统计才会成为已知模式；模型推断永远只是弱背景，" +
        "不得当作事实，也不得用它做人格判断或长期结论。",
    );

  return lines;
}

// ---------------------------------------------------------------------------
// 「为什么系统这样认为」：让用户能审计系统
// ---------------------------------------------------------------------------

export type AuditTrace = {
  facts: string[];
  habits: string[];
  historical: string[];
  current: string[];
  interpretation: { label: string; detail: string }[];
  bySource: { source: TaggedMemory["source"]; items: string[] }[];
  excluded: string[];
};

/**
 * 组装审计视图。
 * 事实、历史、当前、解释分开列出，用户可以逐段核对系统凭什么这样说。
 */
export function buildAuditTrace(input: {
  bundle: ProfileContextBundle;
  patterns?: Pattern[];
  historicalTrend?: HistoricalPatternTrend | null;
  analysis?: DeepAnalysis | null;
  habits?: CommunicationHabit[];
  messages?: Message[];
}): AuditTrace {
  const { bundle } = input;
  const metricValues = input.patterns
    ? sessionMetricValues(input.patterns)
    : {};

  const current = Object.entries(metricValues)
    .filter(([, value]) => typeof value === "number")
    .map(([kind, value]) => `${metricLabel(kind as BaselineMetricKind)}：${value}`);

  const historical = Object.entries(bundle.baseline.metrics)
    .map(([kind, metric]) =>
      metric
        ? `${metricLabel(kind as BaselineMetricKind)}：平时约 ${metric.mean}（样本 ${metric.sampleCount}）`
        : "",
    )
    .filter(Boolean);

  const trendDelta = input.historicalTrend?.deltas ?? [];
  for (const delta of trendDelta)
    historical.push(
      `本次 ${delta.current} vs 她平时 ${delta.historical}（${delta.significance === "none" ? "看不出变化" : delta.significance}）`,
    );

  const habitLines = input.habits
    ? habitHints(
        (input.messages ?? []).map((m) => m.text).join("\n"),
        input.habits,
      )
    : bundle.habits.map(
        (h) =>
          `「${h.expression}」${h.observedCount} 次 / ${h.conversationCount} 段对话：${h.usualMeaning}`,
      );

  const analysis = input.analysis;

  return {
    facts: bundle.observed
      .filter((m) => m.source === "OBSERVED" && m.kind !== "unresolved")
      .map((m) => m.content),
    habits: habitLines,
    historical,
    current,
    interpretation: analysis
      ? [
          { label: "整体", detail: analysis.summary },
          { label: "情绪读法", detail: analysis.latentEmotion.reading },
          { label: "意图读法", detail: analysis.latentIntent.reading },
          ...analysis.alternativeInterpretations.map((a) => ({
            label: "可能解释",
            detail: a.interpretation,
          })),
          {
            label: "模型补充的历史说明",
            detail: analysis.historicalNote ?? "（模型没有补充说明）",
          },
        ]
      : [],
    bySource: [
      { source: "USER_CONFIRMED" as const, items: bundle.confirmed.map((m) => m.content) },
      { source: "OBSERVED" as const, items: bundle.observed.map((m) => m.content) },
      { source: "MODEL_INFERRED" as const, items: bundle.inferred.map((m) => m.content) },
    ],
    excluded: [
      "被用户纠正推翻的推断（contradicted）",
      "过期的模式（expired）",
      "用户拒绝的记忆（archived）",
    ],
  };
}
