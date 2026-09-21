import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviderInput } from "../server/ai/input";
import { buildPayload } from "../server/ai/deepseek";
import {
  extractObservedFacts,
  observedMemoriesFromFacts,
} from "../shared/facts";
import { mergeMemory } from "../shared/memory";
import {
  detectActivityEvents,
  eventConversations,
  recordActivityEvents,
} from "../shared/events";
import {
  CONVERSATION_GAP_MS,
  computePatterns,
  computePatternTrend,
  computeSessionMetrics,
  metricLabel,
  sliceSessions,
} from "../shared/patterns";
import {
  HABIT_CONTEXT_SPREAD,
  aggregateHabits,
  applyUserCorrection,
  baselineStatus,
  candidatesFromAnalysis,
  computeFeedbackStats,
  computeHistoricalDeltas,
  computeHistoricalTrend,
  decayWeight,
  describeComparedToUsual,
  describeHistoricalDeltas,
  deriveBehaviorPatterns,
  deriveKnownPatterns,
  emptyBaseline,
  emptyProfile,
  establishedHabits,
  habitHints,
  habitIsEstablished,
  mergeInferenceCandidates,
  mergeKnownPatterns,
  promoteBehaviorPatterns,
  significanceOf,
  updateBaseline,
  type SessionMetricsInput,
} from "../shared/profile";
import {
  buildAuditTrace,
  describeProfileContext,
  retrieveRelevantProfileContext,
} from "../shared/retrieval";
import { buildTranslation } from "../shared/translation";
import {
  BASELINE_ESTABLISHED_ABOVE,
  BASELINE_INSUFFICIENT_BELOW,
  BEHAVIOR_PATTERN_MIN_CONVERSATIONS,
  PROFILE_SCHEMA_VERSION,
  RETRIEVAL_LIMITS,
  RETRIEVAL_TOKEN_BUDGET,
  contextFromRelation,
  type BaselineMetric,
  type BaselineMetricKind,
  type BehaviorBaseline,
  type CommunicationHabit,
  type DeepAnalysis,
  type HistoricalPatternTrend,
  type InferenceCandidate,
  type InterpretationConfirmation,
  type InterpretationFeedback,
  type KnownPattern,
  type LongTermMemory,
  type Message,
  type Observation,
  type PatternTrend,
  type PersonProfile,
  type UserCorrection,
} from "../shared/types";
import {
  LONG_TERM_KEYS,
  clearBaseline,
  clearLongTerm,
  deleteMemory,
  deleteProfile,
  loadProfiles,
  migrateProfilePayload,
  saveProfiles,
  validateProfile,
  type StorageLike,
} from "../src/storage";
import { conversationIdFor, createProfileStore } from "../src/useProfile";

/**
 * 第三阶段（跨会话画像与长期基线）补测。
 *
 * 全部为纯函数 + 注入式假 storage：
 *   - 不打任何网络请求（DeepSeek / Typewise / fetch 都不碰）
 *   - 时间戳一律显式传入（UTC 墙上时间），被测函数不读「现在几点」
 *   - 断言以实现真实行为为准，不为让测试变绿而弱化
 */

const NOW = "2026-09-20T10:00:00.000Z";
const SELF = "self" as const;
const OTHER = "other" as const;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function fakeStorage(): { storage: StorageLike; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    },
  };
}

function msg(
  id: string,
  sender: typeof SELF | typeof OTHER,
  text: string,
  timestamp: string,
): Message {
  return { id, sender, text, timestamp, kind: "text" };
}

function obs(
  messageId: string,
  emotions: Record<string, number>,
  intents: Record<string, number>,
): Observation {
  return {
    messageId,
    emotions,
    intents,
    score: null,
    model: "jev-1.13.0",
    observedAt: NOW,
  };
}

function memory(
  patch: Partial<LongTermMemory> & { id: string },
): LongTermMemory {
  return {
    kind: "fact",
    content: `内容 ${patch.id}`,
    sourceMessageIds: [`src:${patch.id}`],
    createdAt: NOW,
    lastConfirmedAt: NOW,
    status: "active",
    confidence: 0.8,
    sourceType: "observed",
    ...patch,
  };
}

function baselineWith(patch: Partial<BehaviorBaseline> = {}): BehaviorBaseline {
  return {
    sampleCount: 0,
    conversationCount: 0,
    firstObservedAt: 0,
    lastObservedAt: 0,
    metrics: {},
    ...patch,
  };
}

function metricWith(patch: Partial<BaselineMetric> = {}): BaselineMetric {
  return {
    mean: 0,
    sampleCount: 1,
    updatedAt: 0,
    weightSum: 1,
    weightedSum: 0,
    recent: [],
    ...patch,
  };
}

const BASE_CTX = contextFromRelation("crush");

function profileWith(patch: Partial<PersonProfile> = {}): PersonProfile {
  return {
    ...emptyProfile({ id: "profile:test", relationshipContext: BASE_CTX, at: 0 }),
    ...patch,
  };
}

/** 注入式基线样本：时间显式传入。 */
function session(
  conversationId: string,
  metrics: Partial<Record<BaselineMetricKind, number>>,
  at = Date.UTC(2026, 8, 20, 10, 0),
): SessionMetricsInput {
  return { conversationId, metrics, at };
}

/** 一份合法的最小档案负载（迁移 / 校验用）。 */
function validProfilePayload(id: string): Record<string, unknown> {
  return {
    id,
    displayName: "小夏",
    relationshipContext: {
      type: "crush",
      closeness: "medium",
      contactFrequency: "weekly",
      usualTone: [],
      knownPatterns: [],
      recentContext: [],
      sourceType: "user_provided",
    },
    createdAt: 1,
    updatedAt: 1,
    baselineVersion: 1,
    memories: [],
    knownPatterns: [],
    habits: [],
    inferenceCandidates: [],
    confirmations: [],
    corrections: [],
    sourceConversationIds: [],
  };
}

/** 完整 DeepAnalysis。只喂给不联网的纯函数。 */
function analysisOf(patch: Partial<DeepAnalysis> = {}): DeepAnalysis {
  return {
    status: "ok",
    model: "deepseek-flash",
    summary: "对方先说自己很累，随后反问你为什么还没睡。",
    surfaceSignals: ["主动告知疲惫"],
    latentEmotion: {
      reading: "对方可能有点疲惫",
      basedOn: ["m1"],
      conflictsWith: [],
    },
    latentIntent: {
      reading: "对方可能想继续聊",
      basedOn: ["m3"],
      conflictsWith: [],
    },
    conversationState: {
      reading: "处在互相报备近况的阶段",
      surfaceSignals: ["有来有回"],
    },
    trend: "stable",
    turningPoint: null,
    alternativeInterpretations: [
      {
        interpretation: "对方想找人说话",
        supportingEvidence: ["m1"],
        contradictingEvidence: [],
      },
    ],
    evidence: [
      { messageId: "m1", quote: "今天好累", sender: "other", timestamp: null },
    ],
    contradiction: null,
    uncertainty: "medium",
    nextAction: null,
    analyzedMessageIds: ["m1"],
    promptVersion: 1,
    latencyMs: 900,
    ...patch,
  };
}

function candidate(
  content: string,
  conversationId: string,
  messageIds: string[],
): InferenceCandidate {
  return {
    id: `cand:${content}`,
    content,
    kind: "pattern",
    sourceMessageIds: messageIds,
    conversationIds: [conversationId],
    firstSeenAt: 1,
    lastSeenAt: 1,
    observationCount: 1,
    confidence: 0.5,
  };
}

// ---------------------------------------------------------------------------
// 1. 一轮对话的边界
// ---------------------------------------------------------------------------

test("1. 30 分钟判一轮对话：5 分钟与 29 分钟算回复，31 分钟与隔夜不算", () => {
  const latency = (messages: Message[]) =>
    computeSessionMetrics({ messages, observations: [] }).reply_latency;

  assert.equal(CONVERSATION_GAP_MS, 30 * 60_000);

  // 单个样本不足以产出延迟（该指标最少 2 个样本）
  assert.equal(
    latency([
      msg("a1", SELF, "在吗", "2026年09月20日 10:00"),
      msg("a2", OTHER, "在的", "2026年09月20日 10:05"),
    ]),
    undefined,
  );

  // 5 分钟与 29 分钟都是合法回复间隔
  assert.equal(
    latency([
      msg("b1", SELF, "在吗", "2026年09月20日 10:00"),
      msg("b2", OTHER, "在的", "2026年09月20日 10:05"),
      msg("b3", SELF, "问你个事", "2026年09月20日 10:10"),
      msg("b4", OTHER, "说吧", "2026年09月20日 10:39"),
    ]),
    (5 + 29) / 2,
  );

  // 第三段间隔 31 分钟 > 30 分钟：它属于新的一轮对话，不进入延迟样本
  const mixed = [
    msg("c1", SELF, "在吗", "2026年09月20日 10:00"),
    msg("c2", OTHER, "在的", "2026年09月20日 10:05"),
    msg("c3", SELF, "问你个事", "2026年09月20日 10:10"),
    msg("c4", OTHER, "说吧", "2026年09月20日 10:39"),
    msg("c5", SELF, "在吗", "2026年09月20日 11:10"),
    msg("c6", OTHER, "在", "2026年09月20日 11:41"),
  ];
  assert.equal(latency(mixed), (5 + 29) / 2);
  // 31 分钟、隔夜这类间隔会被切成新的一轮对话
  assert.ok(sliceSessions(mixed).length >= 2);

  // 全部间隔都超过上限时，一个样本都不产出
  assert.equal(
    latency([
      msg("d1", SELF, "在吗", "2026年09月20日 10:00"),
      msg("d2", OTHER, "在", "2026年09月20日 10:31"),
      msg("d3", SELF, "忙吗", "2026年09月20日 10:40"),
      msg("d4", OTHER, "不忙", "2026年09月20日 11:11"),
    ]),
    undefined,
  );

  // 隔夜同样属于新的一轮对话，不会把基线拉到几百分钟
  assert.equal(
    latency([
      msg("e1", SELF, "晚安", "2026年09月20日 23:50"),
      msg("e2", OTHER, "晚安", "2026年09月21日 08:00"),
      msg("e3", SELF, "早", "2026年09月21日 08:10"),
      msg("e4", OTHER, "早", "2026年09月21日 08:40"),
    ]),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// 2-4. 基线增量、中位数、历史 delta
// ---------------------------------------------------------------------------

test("2. updateBaseline 是增量 running mean，且同一输入两次结果完全相同", () => {
  const at1 = Date.UTC(2026, 8, 20, 10, 0);
  const at2 = at1 + DAY;
  const at3 = at2 + DAY;

  const first = updateBaseline(null, session("c1", { reply_length: 10 }, at1));
  assert.equal(first.sampleCount, 1);
  assert.equal(first.conversationCount, 1);
  assert.equal(first.metrics.reply_length?.mean, 10);
  assert.equal(first.metrics.reply_length?.sampleCount, 1);
  assert.equal(first.firstObservedAt, at1);
  assert.equal(first.lastObservedAt, at1);

  // 并入同一个取值：mean 稳定不动
  const same = updateBaseline(first, session("c2", { reply_length: 10 }, at2));
  assert.equal(same.metrics.reply_length?.mean, 10);
  assert.equal(same.sampleCount, first.sampleCount + 1);
  assert.equal(same.conversationCount, 2);
  assert.equal(same.firstObservedAt, at1);
  assert.equal(same.lastObservedAt, at2);

  // 并入不同取值：mean 落在两者之间
  const between = updateBaseline(same, session("c3", { reply_length: 20 }, at3));
  const mean = between.metrics.reply_length!.mean;
  assert.ok(mean > 10 && mean < 20, `mean ${mean} 应落在 10 与 20 之间`);
  assert.equal(between.sampleCount, 3);
  assert.equal(between.conversationCount, 3);

  // 缺失与非有限值一律跳过，不用 0 顶替
  const skipped = updateBaseline(
    between,
    session("c4", { reply_length: Number.NaN, question_density: 0 }, at3 + DAY),
  );
  assert.equal(skipped.conversationCount, 4);
  assert.equal(skipped.sampleCount, 4);
  assert.equal(skipped.metrics.reply_length?.sampleCount, 3);
  assert.equal(skipped.metrics.question_density?.mean, 0);

  // 确定性：同一 (previous, session) 输入两次得到完全相同的输出
  const a = updateBaseline(same, session("c3", { reply_length: 20 }, at3));
  const b = updateBaseline(same, session("c3", { reply_length: 20 }, at3));
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
});

test("3. reply_latency 的 median 被保存，极端值不会把 median 拉到均值附近", () => {
  const at = (day: number) => Date.UTC(2026, 8, day, 10, 0);
  let baseline = updateBaseline(null, session("c1", { reply_latency: 1 }, at(1)));
  baseline = updateBaseline(baseline, session("c2", { reply_latency: 2 }, at(2)));
  baseline = updateBaseline(baseline, session("c3", { reply_latency: 3 }, at(3)));
  baseline = updateBaseline(baseline, session("c4", { reply_latency: 600 }, at(4)));

  const metric = baseline.metrics.reply_latency!;
  assert.equal(typeof metric.median, "number");
  // 4 个样本的中位数是中间两个的平均：(2 + 3) / 2
  assert.equal(metric.median, 2.5);
  assert.equal(metric.sampleCount, 4);
  assert.deepEqual(metric.recent, [1, 2, 3, 600]);
  // 均值被 600 分钟拉高，中位数不受影响
  assert.equal(metric.mean, 151.5);
  assert.ok(
    Math.abs(metric.median! - metric.mean!) > 50,
    `median ${metric.median} 不应被拉到均值 ${metric.mean} 附近`,
  );

  // 延迟的历史 delta 以中位数为参照，而不是被极端值污染的均值
  const delta = computeHistoricalDeltas(baseline, { reply_latency: 5 }).find(
    (d) => d.metric === "reply_latency",
  )!;
  assert.equal(delta.historical, 2.5);
  assert.equal(delta.historicalMedian, 2.5);
  assert.equal(delta.delta, 2.5);
});

test("4. computeHistoricalDeltas 的归一化与显著度分级，延迟参考中位数", () => {
  const baseline = baselineWith({
    sampleCount: 3,
    conversationCount: 3,
    metrics: {
      reply_length: metricWith({ mean: 16.4, median: 16.4, sampleCount: 9 }),
    },
  });

  const deltas = computeHistoricalDeltas(baseline, { reply_length: 7.2 });
  assert.equal(deltas.length, 1);
  const delta = deltas[0];
  assert.equal(delta.metric, "reply_length");
  assert.equal(delta.current, 7.2);
  assert.equal(delta.historical, 16.4);
  assert.equal(delta.delta, -9.2);
  // 相对量纲用相对变化率，并且被夹在 -1
  assert.equal(delta.normalizedDelta, -0.56);
  assert.ok(delta.normalizedDelta < 0);
  assert.ok(delta.normalizedDelta >= -1);
  assert.equal(delta.significance, "large");
  assert.equal(delta.significance, significanceOf((7.2 - 16.4) / 16.4));
  assert.equal(delta.sampleCount, 9);

  // 缺失该指标的基线不产出 delta
  assert.deepEqual(computeHistoricalDeltas(baseline, { reply_latency: 9 }), []);
  assert.deepEqual(computeHistoricalDeltas(null, { reply_length: 7.2 }), []);

  // significanceOf 阈值：0.15 / 0.3 / 0.5（用绝对值分级）
  assert.equal(significanceOf(0), "none");
  assert.equal(significanceOf(0.149), "none");
  assert.equal(significanceOf(0.15), "small");
  assert.equal(significanceOf(-0.29), "small");
  assert.equal(significanceOf(0.3), "moderate");
  assert.equal(significanceOf(-0.499), "moderate");
  assert.equal(significanceOf(0.5), "large");
  assert.equal(significanceOf(-1), "large");
  assert.equal(significanceOf(Number.NaN), "none");

  // 已经并入本次的基线：参照值换成「并入本次之前」的水平，不拿她比自己
  const at = (day: number) => Date.UTC(2026, 8, day, 10, 0);
  const c1 = updateBaseline(null, session("c1", { reply_length: 20 }, at(1)));
  const c2 = updateBaseline(c1, session("c2", { reply_length: 20 }, at(2)));
  const c3 = updateBaseline(c2, session("c3", { reply_length: 12 }, at(3)));
  assert.equal(c3.metrics.reply_length?.mean, 17.33);
  const countedDelta = computeHistoricalDeltas(c3, { reply_length: 12 })[0];
  assert.equal(countedDelta.historical, 20);
  assert.equal(countedDelta.delta, -8);
  assert.equal(countedDelta.significance, "moderate");
});

// ---------------------------------------------------------------------------
// 5. 会话内 delta 与历史 delta 必须分离
// ---------------------------------------------------------------------------

/**
 * 同一段对话同时满足两件事：
 *   - 会话内：前半段热、后半段冷 → patternTrend = cooling
 *   - 相对个人历史：整体仍高于她自己平时的水平 → historicalTrend = warming
 * 两种 delta 互相独立，不能被合并成一个。
 */
const SPLIT_SESSION: Message[] = [
  msg("s1", OTHER, "在的呀今天还好", "2026年09月20日 10:00"),
  msg("s2", SELF, "在吗", "2026年09月20日 10:03"),
  msg("s3", OTHER, "我跟你说个事情", "2026年09月20日 10:06"),
  msg("s4", SELF, "嗯嗯", "2026年09月20日 10:09"),
  msg("s5", OTHER, "嗯", "2026年09月20日 10:12"),
  msg("s6", SELF, "怎么了", "2026年09月20日 10:15"),
  msg("s7", OTHER, "好", "2026年09月20日 10:18"),
  msg("s8", SELF, "好吧", "2026年09月20日 10:21"),
];

const SPLIT_OBSERVATIONS: Observation[] = [
  obs("s1", { happy: 0.9 }, { share: 0.9 }),
  obs("s3", { happy: 0.9 }, { invite: 0.9 }),
  obs("s5", { happy: 0.5, annoyed: 0.4 }, { close: 0.4, share: 0.3 }),
  obs("s7", { happy: 0.5, annoyed: 0.4 }, { close: 0.4, share: 0.3 }),
];

/** 个人历史：她平时主动靠近的表达与正向情绪都偏弱（0.2）。 */
function weakHistoryBaseline(): BehaviorBaseline {
  const at = (day: number) => Date.UTC(2026, 8, day, 12, 0);
  let baseline = updateBaseline(
    null,
    session("hist-1", { intent_drift: 0.2, emotion_drift: 0.2 }, at(1)),
  );
  baseline = updateBaseline(
    baseline,
    session("hist-2", { intent_drift: 0.2, emotion_drift: 0.2 }, at(2)),
  );
  baseline = updateBaseline(
    baseline,
    session("hist-3", { intent_drift: 0.2, emotion_drift: 0.2 }, at(3)),
  );
  return baseline;
}

test("5. 会话内 cooling 与历史 warming 同时成立，scope 分别是 session / historical", () => {
  const patterns = computePatterns({
    messages: SPLIT_SESSION,
    observations: SPLIT_OBSERVATIONS,
  });
  const sessionTrend = computePatternTrend(patterns, SPLIT_SESSION);
  assert.equal(sessionTrend.direction, "cooling");
  assert.ok(sessionTrend.conflictingMetrics.length >= 2);
  assert.equal(sessionTrend.supportingMetrics.length, 0);

  const baseline = weakHistoryBaseline();
  const metrics = computeSessionMetrics({
    messages: SPLIT_SESSION,
    observations: SPLIT_OBSERVATIONS,
  }) as Partial<Record<BaselineMetricKind, number>>;
  const historicalTrend = computeHistoricalTrend(baseline, metrics);
  assert.equal(historicalTrend.insufficientHistory, false);
  assert.equal(historicalTrend.direction, "warming");
  assert.equal(historicalTrend.scope, "historical");
  assert.ok(historicalTrend.supportingMetrics.length >= 2);
  assert.ok(
    historicalTrend.deltas.some((d) => d.significance !== "none"),
    "历史 delta 应当有显著项",
  );
  // 同一份数据：会话内方向与历史方向相反，互相不影响
  assert.notEqual(sessionTrend.direction, historicalTrend.direction);

  const request = buildProviderInput({
    revision: 1,
    relation: "crush",
    targetId: null,
    messages: SPLIT_SESSION,
    observations: SPLIT_OBSERVATIONS,
    memory: [],
    patterns: [],
    profile: {
      baselineStatus: baselineStatus(baseline),
      comparedConversations: baseline.conversationCount,
      baseline,
      confirmed: [],
      currentFacts: [],
      observed: [],
      inferred: [],
      habits: [],
      knownPatterns: [],
      unresolved: [],
      corrections: [],
      estimatedTokens: 0,
      truncated: false,
    },
  });

  assert.equal(request.patternTrend?.scope, "session");
  assert.equal(request.patternTrend?.direction, "cooling");
  assert.equal(request.historicalTrend?.scope, "historical");
  assert.equal(request.historicalTrend?.direction, "warming");

  // 「和她平时相比」只吃历史趋势，不会被会话内 cooling 改写
  const translation = buildTranslation(
    analysisOf({ trend: "cooling" }),
    request.patternTrend,
    request.historicalTrend,
  );
  assert.ok(translation.comparedToUsual.length > 0);
  assert.ok(translation.comparedToUsual.join("\n").includes("她平时"));
});

test("5b. baselineStatus 分级：0 次 none、1-2 次 insufficient、3-5 次 early、6 次以上 established", () => {
  const at = (count: number) => baselineWith({ conversationCount: count });
  assert.equal(baselineStatus(null), "none");
  assert.equal(baselineStatus(at(0)), "none");
  assert.equal(baselineStatus(at(1)), "insufficient");
  assert.equal(
    baselineStatus(at(BASELINE_INSUFFICIENT_BELOW - 1)),
    "insufficient",
  );
  assert.equal(baselineStatus(at(BASELINE_INSUFFICIENT_BELOW)), "early");
  assert.equal(baselineStatus(at(BASELINE_ESTABLISHED_ABOVE)), "early");
  assert.equal(baselineStatus(at(BASELINE_ESTABLISHED_ABOVE + 1)), "established");
});

// ---------------------------------------------------------------------------
// 7. 时间衰减
// ---------------------------------------------------------------------------

test("7. decayWeight 分档正确，一年前的样本权重低于近期样本", () => {
  assert.equal(decayWeight(0), 1);
  assert.equal(decayWeight(1), 1);
  assert.equal(decayWeight(30), 1);
  assert.equal(decayWeight(31), 0.7);
  assert.equal(decayWeight(90), 0.7);
  assert.equal(decayWeight(91), 0.4);
  assert.equal(decayWeight(180), 0.4);
  assert.equal(decayWeight(181), 0.2);
  assert.equal(decayWeight(365), 0.2);
  assert.equal(decayWeight(Number.POSITIVE_INFINITY), 1);

  // 同一个旧样本（1），分别隔一天 / 隔一年并入同样的新值（100）。
  // 旧权重的有效值 = weightSum * decay(距上次更新的天数)：
  //   隔一天并入：(1 * 1 + 100) / (1 * 1 + 1) = 50.5       新旧权重相当
  //   隔一年并入：(1 * 0.2 + 100) / (1 * 0.2 + 1) ≈ 83.5   旧样本几乎失效
  const at = Date.UTC(2026, 8, 20, 10, 0);
  const old = updateBaseline(
    null,
    session("old", { reply_length: 1 }, at - 400 * DAY),
  );
  const oneDay = updateBaseline(
    old,
    session("new", { reply_length: 100 }, at - 400 * DAY + DAY),
  );
  const oneYear = updateBaseline(
    old,
    session("new", { reply_length: 100 }, at),
  );
  const oneDayMean = oneDay.metrics.reply_length!.mean!;
  const oneYearMean = oneYear.metrics.reply_length!.mean!;

  assert.ok(
    oneDayMean < oneYearMean,
    `一年前的旧样本被降权后，新值影响更大：${oneDayMean} 应小于 ${oneYearMean}`,
  );
  assert.ok(
    Math.abs(oneDayMean - 50.5) < 0.05,
    `隔一天并入 mean ≈ 50.5，实际 ${oneDayMean}`,
  );
  assert.ok(
    Math.abs(oneYearMean - 83.5) < 0.05,
    `隔一年并入 mean ≈ 83.5，实际 ${oneYearMean}`,
  );
});

// ---------------------------------------------------------------------------
// 8. 客观事实
// ---------------------------------------------------------------------------

test("8. extractObservedFacts 只保存客观事实，推测与评价一律不记录", () => {
  const messages: Message[] = [
    msg("f1", OTHER, "我脚扭了，走路一瘸一拐", "2026年09月20日 10:05"),
    msg("f2", OTHER, "周末考试，得好好复习", "2026年09月20日 10:10"),
    msg("f3", OTHER, "我不喜欢吃香菜", "2026年09月20日 10:15"),
    // 下面是推测或评价，一条都不能成为客观事实
    msg("f4", OTHER, "我这周可能要去外地出差", "2026年09月20日 10:00"),
    msg("f5", OTHER, "她最近有点疏远", "2026年09月20日 10:20"),
    msg("f6", OTHER, "她可能害羞", "2026年09月20日 10:25"),
    msg("f7", OTHER, "你是不是喜欢我", "2026年09月20日 10:30"),
    msg("f8", OTHER, "她是回避型", "2026年09月20日 10:35"),
  ];

  const facts = extractObservedFacts(messages);
  const contents = facts.map((f) => f.content);

  assert.ok(contents.some((c) => c.includes("脚扭了")));
  assert.ok(contents.some((c) => c.includes("周末考试")));
  assert.ok(contents.some((c) => c.includes("我不喜欢吃香菜")));

  // 带推测措辞的整句被丢弃
  assert.equal(
    contents.filter((c) => c.includes("外地出差")).length,
    0,
    "带推测措辞的句子不应被保存",
  );
  for (const word of ["疏远", "害羞", "喜欢我", "回避型"]) {
    assert.equal(
      contents.filter((c) => c.includes(word)).length,
      0,
      `「${word}」不应被写成客观事实`,
    );
  }

  for (const content of contents) {
    assert.ok(
      content.startsWith("对方说："),
      `事实必须以「对方说：」开头：${content}`,
    );
  }
  for (const fact of facts) {
    assert.ok(fact.sourceMessageIds.length > 0, `${fact.id} 缺 sourceMessageIds`);
    assert.ok(
      messages.some((m) => m.id === fact.sourceMessageIds[0]),
      `${fact.id} 的来源消息必须真实存在`,
    );
  }

  // 三个字的短事实同样要保留：「脚扭了」是典型的客观事实
  assert.deepEqual(
    extractObservedFacts([msg("g1", OTHER, "脚扭了", "2026年09月20日 09:55")]).map(
      (f) => f.content,
    ),
    ["对方说：脚扭了"],
  );
  // 放宽长度下限不会放进评价性内容：没有命中规则关键词的短句依然不保存
  assert.deepEqual(
    extractObservedFacts([msg("g2", OTHER, "好累", "2026年09月20日 09:56")]),
    [],
  );
  assert.deepEqual(
    extractObservedFacts([msg("g3", OTHER, "还行吧", "2026年09月20日 09:57")]),
    [],
  );

  const memories = observedMemoriesFromFacts(facts, NOW);
  assert.equal(memories.length, facts.length);
  for (const m of memories) {
    assert.equal(m.sourceType, "observed");
    assert.ok(m.confidence < 1, `observed 记忆不能是满分把握：${m.confidence}`);
    assert.equal(m.status, "active");
    assert.equal(m.createdAt, NOW);
    assert.ok(m.sourceMessageIds.length > 0);
  }
});

// ---------------------------------------------------------------------------
// 9-10. 模型推断：只累积候选，不产生任何长期结论
// ---------------------------------------------------------------------------

test("9. 自由文本推断不再自动晋升为长期模式，只累积候选", () => {
  const content = "对方可能希望被主动关心";
  let candidates = mergeInferenceCandidates([], [
    candidate(content, "conv-1", ["m1"]),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].observationCount, 1);

  // 跨 5 段不同对话反复出现，仍然只是候选
  for (const id of ["conv-2", "conv-3", "conv-4", "conv-5"])
    candidates = mergeInferenceCandidates(candidates, [
      candidate(content, id, [`m-${id}`]),
    ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].observationCount, 5);
  assert.deepEqual(candidates[0].conversationIds, [
    "conv-1",
    "conv-2",
    "conv-3",
    "conv-4",
    "conv-5",
  ]);

  // 候选本身永远不是记忆、也不是模式：deriveKnownPatterns 不会把它变成长期模式
  const profile = emptyProfile({
    id: "profile:test:crush",
    relationshipContext: contextFromRelation("crush"),
    at: 1,
  });
  const patterns = deriveKnownPatterns({
    baseline: profile.behaviorBaseline,
    habits: [],
    activityEvents: [],
    previous: profile.knownPatterns,
    at: 1,
  });
  assert.equal(
    patterns.some((p) => p.sourceType === "model_inferred"),
    false,
    "自由文本推断不得自动成为长期模式",
  );

  // 过短的推断连候选都不算
  const short = candidatesFromAnalysis({
    analysis: analysisOf({
      latentEmotion: { reading: "想聊", basedOn: [], conflictsWith: [] },
    }),
    conversationId: "conv-1",
    at: 1,
  });
  assert.equal(
    short.filter((c) => c.content === "想聊").length,
    0,
    "过短的推断不应进入候选",
  );
});

test("10. 候选合并仍是幂等的：同一段对话重复合并不增加计数", () => {
  const content = "对方可能想找人倾诉";
  const first = mergeInferenceCandidates([], [
    candidate(content, "conv-1", ["m1"]),
  ]);
  assert.equal(first[0].observationCount, 1);

  // 同一段对话重复合并不会增加计数
  const reMerged = mergeInferenceCandidates(first, [
    candidate(content, "conv-1", ["m1b"]),
  ]);
  assert.equal(reMerged[0].observationCount, 1);
  assert.deepEqual(reMerged[0].conversationIds, ["conv-1"]);

  const second = mergeInferenceCandidates(reMerged, [
    candidate(content, "conv-2", ["m2"]),
  ]);
  assert.equal(second[0].observationCount, 2);

  // 措辞略有不同但指向同一面的推断会被合并，累计的仍是不重复的对话数
  const fourth = mergeInferenceCandidates(second, [
    candidate("对方可能想找人倾诉一下", "conv-4", ["m4"]),
  ]);
  assert.equal(fourth.length, 1);
  assert.equal(fourth[0].observationCount, 3);
  assert.deepEqual(fourth[0].conversationIds, ["conv-1", "conv-2", "conv-4"]);
});

test("9b. 程序侧的确定性候选可以晋升为长期模式", () => {
  const at = 1_780_000_000_000;
  const baseline = [
    { reply_length: 2 },
    { reply_length: 3 },
    { reply_length: 2 },
    { reply_length: 2 },
  ].reduce(
    (acc, metrics, index) =>
      updateBaseline(acc, {
        conversationId: `conv-${index + 1}`,
        metrics,
        at: at + index * DAY,
      }),
    emptyBaseline(),
  );

  const candidates = deriveBehaviorPatterns({ baseline, at });
  const short = candidates.find((c) => c.key === "reply_length_short");
  assert.ok(short, "程序侧应产出「回复通常很短」候选");
  assert.equal(short!.sourceType, "deterministic");
  assert.equal(short!.evidenceCount, 4);
  assert.deepEqual(short!.evidenceConversationIds, [
    "conv-1",
    "conv-2",
    "conv-3",
    "conv-4",
  ]);
  assert.ok(short!.evidenceCount >= BEHAVIOR_PATTERN_MIN_CONVERSATIONS);

  const promoted = promoteBehaviorPatterns(candidates);
  const pattern = promoted.find((p) => p.patternKey === "reply_length_short");
  assert.ok(pattern, "达到门槛的程序侧候选必须能晋升");
  assert.equal(pattern!.sourceType, "deterministic");
  assert.equal(pattern!.patternKey, "reply_length_short");
  assert.equal(pattern!.conversationCount, 4);
  assert.deepEqual(pattern!.supportingMetrics, ["reply_length"]);
  assert.equal(pattern!.status, "active");
  assert.equal(pattern!.id, "kp:reply_length_short");
  assert.ok(pattern!.description.includes("回复通常很短"));
  // 只描述行为，不做人格判断
  for (const word of ["话少", "内向", "性格", "回避型", "人格", "冷淡"])
    assert.equal(
      pattern!.description.includes(word),
      false,
      `模式描述不应包含「${word}」`,
    );
});

test("9c. 门槛：少于 3 段对话不晋升，达到 3 段才晋升", () => {
  const at = 1_780_000_000_000;
  const build = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ reply_latency: 2 })).reduce(
      (acc, metrics, index) =>
        updateBaseline(acc, {
          conversationId: `conv-${index + 1}`,
          metrics,
          at: at + index * DAY,
        }),
      emptyBaseline(),
    );

  const two = deriveBehaviorPatterns({ baseline: build(2), at });
  const fastTwo = two.find((c) => c.key === "reply_latency_fast");
  assert.ok(fastTwo, "2 段对话仍会产出候选");
  assert.equal(fastTwo!.evidenceCount, 2);
  assert.equal(
    promoteBehaviorPatterns(two).some(
      (p) => p.patternKey === "reply_latency_fast",
    ),
    false,
    "少于 3 段对话不得晋升",
  );

  const three = deriveBehaviorPatterns({ baseline: build(3), at });
  assert.ok(
    promoteBehaviorPatterns(three).some(
      (p) => p.patternKey === "reply_latency_fast",
    ),
    "达到 3 段对话应晋升",
  );
});

test("9d. 高风险互动模式需要 4 段对话证据", () => {
  const at = 1_780_000_000_000;
  const events = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      kind: "planned_invite_accepted" as const,
      conversationId: `conv-${index + 1}`,
      messageIds: [`m${index + 1}`],
      at: at + index * DAY,
    }));
  const baseline = emptyBaseline();

  const three = deriveBehaviorPatterns({
    baseline,
    activityEvents: events(3),
    at,
  });
  const candidate = three.find((c) => c.key === "accepts_planned_invitations");
  assert.ok(candidate, "3 段对话也会产出高风险候选");
  assert.equal(candidate!.highRisk, true);
  assert.equal(
    promoteBehaviorPatterns(three).some(
      (p) => p.patternKey === "accepts_planned_invitations",
    ),
    false,
    "高风险模式 3 段对话不得晋升",
  );

  const four = deriveBehaviorPatterns({
    baseline,
    activityEvents: events(4),
    at,
  });
  const promoted = promoteBehaviorPatterns(four).find(
    (p) => p.patternKey === "accepts_planned_invitations",
  );
  assert.ok(promoted, "高风险模式需要 4 段对话才晋升");
  assert.equal(promoted!.sourceType, "deterministic");
  assert.equal(promoted!.conversationCount, 4);
  assert.ok(promoted!.description.includes("提前约好的安排"));
  // 仍然只描述行为，不写「她喜欢」
  assert.equal(promoted!.description.includes("她喜欢"), false);
  assert.equal(promoted!.description.includes("喜欢"), false);
});

test("9e. model_inferred 不能覆盖 deterministic，user_confirmed 优先级最高", () => {
  const base: KnownPattern = {
    id: "kp:reply_length_short",
    patternKey: "reply_length_short",
    description: "历史上她的回复通常很短（4 段对话，平均约 2.2 字）",
    evidenceCount: 4,
    conversationCount: 4,
    sourceType: "deterministic",
    supportingMetrics: ["reply_length"],
    firstObservedAt: 1,
    lastObservedAt: 2,
    status: "active",
  };

  // 模型推断不得覆盖程序统计
  const merged = mergeKnownPatterns([base], [
    {
      ...base,
      id: "kp:model",
      description: "她其实不太想理你",
      sourceType: "model_inferred",
      evidenceCount: 99,
      status: "active",
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceType, "deterministic");
  assert.equal(merged[0].description, base.description);

  // 用户确认可以覆盖程序统计
  const confirmed = mergeKnownPatterns([base], [
    {
      ...base,
      id: "kp:user",
      description: "用户确认：她回复短是因为在上班",
      sourceType: "user_confirmed",
      evidenceCount: 1,
      status: "active",
    },
  ]);
  assert.equal(confirmed[0].sourceType, "user_confirmed");
  assert.ok(confirmed[0].description.startsWith("用户确认："));

  // 被用户纠正推翻的模式不会因重新统计而复活
  const contradicted = mergeKnownPatterns(
    [{ ...base, status: "contradicted" }],
    [base],
  );
  assert.equal(contradicted[0].status, "contradicted");

  // 旧档案里的 model_inferred 模式会被标为 superseded，而不是继续 active
  const legacy = deriveKnownPatterns({
    baseline: emptyBaseline(),
    habits: [],
    activityEvents: [],
    previous: [{ ...base, sourceType: "model_inferred", status: "active" }],
    at: 10,
  });
  assert.equal(legacy[0].sourceType, "model_inferred");
  assert.equal(legacy[0].status, "superseded");
});

test("9f. deterministic 模式必须持续被证据支持，否则转为 expired", () => {
  const at = 1_780_000_000_000;
  const DAY = 86_400_000;
  const build = (lengths: number[]) =>
    lengths.reduce(
      (acc, value, index) =>
        updateBaseline(acc, {
          conversationId: `conv-${index + 1}`,
          metrics: { reply_length: value },
          at: at + index * DAY,
        }),
      emptyBaseline(),
    );

  // 前 4 段对话一直很短 → 形成 deterministic 模式
  const short = build([2, 3, 2, 2]);
  const first = deriveKnownPatterns({
    baseline: short,
    habits: [],
    activityEvents: [],
    previous: [],
    at,
  });
  assert.equal(
    first.some((p) => p.patternKey === "reply_length_short"),
    true,
  );

  // 之后她开始写长消息：新窗口不再支持「回复通常很短」
  const later = build([2, 3, 40, 45, 50, 42]);
  const next = deriveKnownPatterns({
    baseline: later,
    habits: [],
    activityEvents: [],
    previous: first,
    at: at + 10 * DAY,
  });
  const stale = next.find((p) => p.patternKey === "reply_length_short");
  assert.ok(stale, "不再被支持的模式要保留可复盘");
  assert.equal(stale!.status, "expired", "不再被证据支持时不得继续 active");
  // 不再是 active，因此不会进入检索上下文
  const bundle = retrieveRelevantProfileContext({
    profile: profileWith({
      knownPatterns: next,
      behaviorBaseline: later,
    }),
    messages: [msg("m1", OTHER, "今天很累", "2026年09月20日 10:00")],
  });
  assert.equal(
    bundle.knownPatterns.some((p) => p.patternKey === "reply_length_short"),
    false,
    "expired 模式不得进入解读上下文",
  );
});

// ---------------------------------------------------------------------------
// 11-12. 用户纠错与来源优先级
// ---------------------------------------------------------------------------

test("11. 用户纠错把冲突推断标为 contradicted（内容与 id 都在），并新增 user_confirmed 事实", () => {
  const inferred = memory({
    id: "mem:pattern:cand:对方可能不太想理我",
    kind: "pattern",
    content: "对方可能不太想理我",
    sourceType: "model_inferred",
    confidence: 0.6,
  });
  const other = memory({ id: "mem:fact:x", content: "对方说：脚扭了" });
  const profile = profileWith({
    memories: [inferred, other],
    inferenceCandidates: [candidate("对方可能不太想理我", "conv-1", ["m1"])],
  });

  const correction: UserCorrection = {
    id: "corr-1",
    contextKey: "ctx-1",
    content: "不是，她那天只是发烧",
    contradictedIds: [inferred.id],
    createdAt: NOW,
  };
  const corrected = applyUserCorrection(profile, {
    correction,
    now: NOW,
    at: 1,
  });

  // 数组长度不减：旧推断保留，新事实追加
  assert.equal(corrected.memories.length, profile.memories.length + 1);
  const stillThere = corrected.memories.find((m) => m.id === inferred.id)!;
  assert.equal(stillThere.status, "contradicted");
  assert.equal(stillThere.content, inferred.content);
  assert.equal(stillThere.sourceType, "model_inferred");

  const fact = corrected.memories.find(
    (m) => m.id === "mem:correction:corr-1",
  )!;
  assert.equal(fact.sourceType, "user_confirmed");
  assert.equal(fact.content, "不是，她那天只是发烧");
  assert.equal(fact.status, "active");
  assert.equal(fact.confidence, 1);
  assert.deepEqual(corrected.corrections[0].contradictedIds, [inferred.id]);
  assert.equal(corrected.feedbackStats.contradictedInterpretations, 1);

  // 被推翻的推断不再被检索选中
  const bundle = retrieveRelevantProfileContext({
    profile: corrected,
    messages: [msg("m1", OTHER, "她那天发烧了", "2026年09月20日 10:00")],
  });
  const all = [
    ...bundle.confirmed,
    ...bundle.observed,
    ...bundle.inferred,
    ...bundle.unresolved,
  ];
  assert.equal(
    all.filter((m) => m.content === inferred.content).length,
    0,
    "contradicted 的推断不应进入检索上下文",
  );
  assert.ok(bundle.confirmed.some((m) => m.content === "不是，她那天只是发烧"));

  // 新的 model_inferred 不能把它复活
  const revived = mergeMemory(corrected.memories, [
    memory({
      id: inferred.id,
      kind: "pattern",
      content: inferred.content,
      sourceType: "model_inferred",
      confidence: 0.6,
    }),
  ]);
  assert.equal(revived.length, corrected.memories.length);
  assert.equal(revived.find((m) => m.id === inferred.id)!.status, "contradicted");
});

test("12. 检索优先 user_confirmed，其次 observed，最后 model_inferred", () => {
  const profile = profileWith({
    memories: [
      memory({
        id: "mem:i1",
        kind: "pattern",
        content: "推断内容一",
        sourceType: "model_inferred",
        confidence: 0.6,
      }),
      memory({ id: "mem:o1", content: "观察内容一" }),
      memory({
        id: "mem:c1",
        content: "用户确认：她只是发烧",
        sourceType: "user_confirmed",
        confidence: 1,
      }),
      memory({ id: "mem:o2", content: "观察内容二" }),
      memory({
        id: "mem:c2",
        content: "用户确认：她最近在赶项目",
        sourceType: "user_confirmed",
        confidence: 1,
      }),
    ],
  });

  const bundle = retrieveRelevantProfileContext({
    profile,
    messages: [msg("m1", OTHER, "今天好累", "2026年09月20日 10:00")],
  });

  assert.deepEqual(bundle.confirmed.map((m) => m.content), [
    "用户确认：她只是发烧",
    "用户确认：她最近在赶项目",
  ]);
  assert.deepEqual(
    bundle.observed.map((m) => m.content),
    ["观察内容一", "观察内容二"],
  );
  assert.deepEqual(bundle.inferred.map((m) => m.content), ["推断内容一"]);

  for (const item of bundle.confirmed)
    assert.equal(item.source, "USER_CONFIRMED");
  for (const item of bundle.observed) assert.equal(item.source, "OBSERVED");
  for (const item of bundle.inferred) assert.equal(item.source, "MODEL_INFERRED");
  assert.ok(bundle.confirmed[0].confidence > bundle.inferred[0].confidence);

  const lines = describeProfileContext(bundle);
  assert.ok(lines.includes("【用户确认】用户确认：她只是发烧"));
  assert.ok(lines.includes("【观察事实】观察内容一"));
  assert.ok(lines.includes("【模型推断·弱背景】推断内容一"));
  // 权重顺序：用户确认 > 当前事实 > 程序统计的已知模式 > … > 模型推断
  assert.ok(
    lines.some((l) =>
      l.includes(
        "用户确认 > 当前事实 > 程序统计的已知模式 > 观察事实 > 表达习惯 > 未解决事件 > 模型推断",
      ),
    ),
    lines.join("\n"),
  );
  // 输出顺序也必须遵守优先级：用户确认最前，模型推断最后
  const indexOf = (needle: string) =>
    lines.findIndex((line) => line.includes(needle));
  assert.ok(indexOf("【用户确认】") < indexOf("【观察事实】"));
  assert.ok(indexOf("【观察事实】") < indexOf("【模型推断·弱背景】"));
});

// ---------------------------------------------------------------------------
// 13. 表达习惯
// ---------------------------------------------------------------------------

test("13. habit 按对话去重累计，跨 3 种语境判为语气填充，提示不含人格与概率措辞", () => {
  const convA = [msg("a1", OTHER, "哈哈哈哈哈哈", "2026年09月18日 21:00")];
  const convB = [msg("b1", OTHER, "哈哈好", "2026年09月19日 21:00")];
  const convC = [msg("c1", OTHER, "哈哈，好的", "2026年09月20日 21:00")];
  const observations = [
    obs("a1", { happy: 0.9 }, { share: 0.9 }),
    obs("b1", { shy: 0.9 }, { tease: 0.9 }),
    obs("c1", { annoyed: 0.9 }, { close: 0.9 }),
  ];

  // 第 1 段对话：累计 3 次，只有 1 段对话
  const afterA = aggregateHabits(
    { messages: convA, observations, conversationId: "conv-a", at: 1 },
    [],
  );
  assert.equal(afterA.length, 1);
  assert.equal(afterA[0].expression, "哈哈");
  assert.equal(afterA[0].observedCount, 3);
  assert.equal(afterA[0].conversationCount, 1);
  assert.equal(afterA[0].confidence, "low");

  // 第 2 段不同对话：累计 4 次、跨 2 段
  const afterB = aggregateHabits(
    { messages: convB, observations, conversationId: "conv-b", at: 2 },
    afterA,
  );
  const habitB = afterB.find((h) => h.expression === "哈哈")!;
  assert.equal(habitB.observedCount, 4);
  assert.equal(habitB.conversationCount, 2);
  assert.deepEqual(habitB.conversationIds, ["conv-a", "conv-b"]);

  // 第 3 段不同对话：累计 5 次、跨 3 段，跨 ≥3 种语境 → 语气填充
  const afterC = aggregateHabits(
    { messages: convC, observations, conversationId: "conv-c", at: 3 },
    afterB,
  );
  const habit = afterC.find((h) => h.expression === "哈哈")!;
  assert.equal(habit.observedCount, 5);
  assert.equal(habit.conversationCount, 3);
  assert.deepEqual(habit.conversationIds, ["conv-a", "conv-b", "conv-c"]);
  assert.ok(
    habit.contexts.length >= HABIT_CONTEXT_SPREAD,
    `语境数 ${habit.contexts.length} 应达到 ${HABIT_CONTEXT_SPREAD}`,
  );
  assert.ok(
    habit.usualMeaning.includes("语气填充"),
    `跨多种语境应判为语气填充：${habit.usualMeaning}`,
  );

  // 只有把握不为 low 的习惯才会给出提示
  const established: CommunicationHabit[] = [
    {
      expression: "哈哈",
      observedCount: 8,
      conversationCount: 2,
      contexts: ["开心", "分享近况", "害羞", "逗你"],
      usualMeaning: "更像语气填充，跨多种情绪语境出现，不宜单独当作情绪信号",
      confidence: "medium",
      lastObservedAt: 3,
      conversationIds: ["conv-a", "conv-b"],
    },
    {
      expression: "谢谢",
      observedCount: 9,
      conversationCount: 2,
      contexts: ["平静"],
      usualMeaning: "出现的语境还不稳定",
      confidence: "low",
      lastObservedAt: 3,
      conversationIds: ["conv-a", "conv-b"],
    },
  ];
  const hints = habitHints("今天怎么样哈哈谢谢", established);
  assert.equal(hints.length, 1);
  assert.ok(hints[0].includes("哈哈"));
  assert.deepEqual(habitHints("今天怎么样", established), []);
  const banned = ["人格", "回避型", "焦虑型", "依恋", "自恋", "性格", "概率", "%"];
  for (const word of banned)
    assert.ok(!hints[0].includes(word), `提示不应包含「${word}」：${hints[0]}`);
});

// ---------------------------------------------------------------------------
// 14. 检索预算
// ---------------------------------------------------------------------------

test("14. 检索上下文受 token 预算约束，超预算时标记 truncated", () => {
  const filler = "这是一条很长的历史记忆内容，用来把上下文体积推上去。".repeat(6);
  const memories: LongTermMemory[] = [];
  for (let i = 0; i < 40; i++)
    memories.push(memory({ id: `mem:observed-${i}`, content: `观察${i}：${filler}` }));
  for (let i = 0; i < 20; i++)
    memories.push(
      memory({
        id: `mem:inferred-${i}`,
        kind: "pattern",
        content: `推断${i}：${filler}`,
        sourceType: "model_inferred",
        confidence: 0.6,
      }),
    );
  for (let i = 0; i < 3; i++)
    memories.push(
      memory({
        id: `mem:confirmed-${i}`,
        content: `用户确认${i}：${filler}`,
        sourceType: "user_confirmed",
        confidence: 1,
      }),
    );

  const bundle = retrieveRelevantProfileContext({
    profile: profileWith({ memories }),
    messages: [msg("m1", OTHER, "今天好累", "2026年09月20日 10:00")],
  });

  assert.equal(RETRIEVAL_TOKEN_BUDGET, 1200);
  assert.ok(
    bundle.estimatedTokens <= RETRIEVAL_TOKEN_BUDGET,
    `估算 ${bundle.estimatedTokens} 不应超过预算 ${RETRIEVAL_TOKEN_BUDGET}`,
  );
  assert.equal(bundle.truncated, true);
  assert.ok(bundle.confirmed.length <= RETRIEVAL_LIMITS.confirmed);
  assert.ok(bundle.observed.length <= RETRIEVAL_LIMITS.observed);
  assert.ok(bundle.inferred.length <= RETRIEVAL_LIMITS.inferred);
  assert.ok(
    bundle.confirmed.length +
      bundle.currentFacts.length +
      bundle.observed.length +
      bundle.inferred.length <
      memories.length,
    "超预算时必须丢弃部分内容",
  );

  // 预算充足时同一份数据不截断，且能取满各来源上限
  const roomy = retrieveRelevantProfileContext({
    profile: profileWith({ memories }),
    messages: [msg("m1", OTHER, "今天好累", "2026年09月20日 10:00")],
    budget: 10_000,
  });
  assert.equal(roomy.truncated, false);
  assert.ok(roomy.estimatedTokens <= 10_000);
  assert.ok(roomy.observed.length > bundle.observed.length);
  assert.equal(roomy.inferred.length, RETRIEVAL_LIMITS.inferred);
});

test("14b. 裁剪顺序：模型推断最先丢，用户确认与稳定模式最后丢", () => {
  const filler = "很长的内容".repeat(20);
  const confirmed: LongTermMemory[] = [
    memory({
      id: "mem:c1",
      content: `用户确认：她那天只是发烧 ${filler}`,
      sourceType: "user_confirmed",
      confidence: 1,
    }),
    memory({
      id: "mem:c2",
      content: `用户确认：她在赶项目 ${filler}`,
      sourceType: "user_confirmed",
      confidence: 1,
    }),
  ];
  const patterns = [
    {
      id: "kp:reply_length_short",
      patternKey: "reply_length_short",
      description: `历史上她的回复通常很短 ${filler}`,
      evidenceCount: 4,
      conversationCount: 4,
      sourceType: "deterministic" as const,
      supportingMetrics: ["reply_length"],
      firstObservedAt: 1,
      lastObservedAt: 2,
      status: "active" as const,
    },
    {
      id: "kp:rarely_initiates",
      patternKey: "rarely_initiates",
      description: `历史上多由我方开启对话 ${filler}`,
      evidenceCount: 4,
      conversationCount: 4,
      sourceType: "deterministic" as const,
      supportingMetrics: ["initiation_ratio"],
      firstObservedAt: 1,
      lastObservedAt: 2,
      status: "active" as const,
    },
  ];
  const inferred: LongTermMemory[] = Array.from({ length: 3 }, (_, i) =>
    memory({
      id: `mem:i${i}`,
      kind: "pattern",
      content: `推断${i}：${filler}`,
      sourceType: "model_inferred",
      confidence: 0.6,
    }),
  );

  // 预算刚好只够放下用户确认 + 稳定模式
  const profile = profileWith({
    memories: [...confirmed, ...inferred],
    knownPatterns: patterns,
  });
  // 先量出「不裁剪」时的体积，再把预算压到只差丢掉模型推断就能装下的位置
  const full = retrieveRelevantProfileContext({
    profile,
    messages: [msg("m1", OTHER, "今天好累", "2026年09月20日 10:00")],
    budget: 100_000,
  });
  const inferredCost = full.inferred.reduce(
    (total, item) => total + JSON.stringify(item).length / 2,
    0,
  );
  const budget = Math.max(200, Math.floor(full.estimatedTokens - inferredCost / 2));
  const bundle = retrieveRelevantProfileContext({
    profile,
    messages: [msg("m1", OTHER, "今天好累", "2026年09月20日 10:00")],
    budget,
  });

  assert.equal(bundle.truncated, true);
  // 模型推断最先被丢
  assert.deepEqual(
    bundle.inferred,
    [],
    "预算不足时模型推断必须最先被裁掉",
  );
  assert.equal(bundle.trimmed?.[0], "model_inferred");
  // 用户确认永远保留
  assert.equal(bundle.confirmed.length, 2);
  // 稳定行为模式不能比模型推断先丢
  assert.equal(
    bundle.trimmed?.includes("known_patterns"),
    false,
    `稳定模式不应先于模型推断被丢掉：${JSON.stringify(bundle.trimmed)}`,
  );
  assert.equal(bundle.knownPatterns.length, 2);
  assert.ok(bundle.estimatedTokens <= budget);

  // 用户确认即使单独超预算也不会被裁剪
  const tiny = retrieveRelevantProfileContext({
    profile,
    messages: [msg("m1", OTHER, "今天好累", "2026年09月20日 10:00")],
    budget: 10,
  });
  assert.equal(tiny.confirmed.length, 2, "用户确认的内容永不裁剪");
  assert.equal(tiny.inferred.length, 0);
});

// ---------------------------------------------------------------------------
// 15-20. 反馈统计、迁移、损坏数据、删除能力
// ---------------------------------------------------------------------------

test("15. computeFeedbackStats 的计数与映射正确", () => {
  const feedback: InterpretationFeedback[] = [
    {
      id: "fb1",
      contextKey: "ctx1",
      verdict: "helpful",
      reasons: [],
      note: "",
      createdAt: NOW,
    },
    {
      id: "fb2",
      contextKey: "ctx1",
      verdict: "problem",
      reasons: ["missed_signal", "too_certain"],
      note: "",
      createdAt: NOW,
    },
    {
      id: "fb3",
      contextKey: "ctx2",
      verdict: "problem",
      reasons: ["overthinking"],
      note: "",
      createdAt: NOW,
    },
    {
      id: "fb4",
      contextKey: "ctx3",
      verdict: "problem",
      reasons: ["wrong_reading", "other"],
      note: "",
      createdAt: NOW,
    },
  ];
  const confirmations: InterpretationConfirmation[] = [
    {
      id: "cf1",
      contextKey: "ctx1",
      verdict: "mostly_correct",
      confirmedParts: ["emotion"],
      createdAt: NOW,
    },
    {
      id: "cf2",
      contextKey: "ctx2",
      verdict: "partly_correct",
      confirmedParts: ["interp:0"],
      createdAt: NOW,
    },
    {
      id: "cf3",
      contextKey: "ctx3",
      verdict: "incorrect",
      confirmedParts: [],
      createdAt: NOW,
    },
    {
      id: "cf4",
      contextKey: "ctx4",
      verdict: "mostly_correct",
      confirmedParts: [],
      createdAt: NOW,
    },
  ];
  const corrections: UserCorrection[] = [
    {
      id: "corr-1",
      contextKey: "ctx3",
      content: "不是这样",
      contradictedIds: [],
      createdAt: NOW,
    },
  ];

  const stats = computeFeedbackStats({
    interpretationFeedback: feedback,
    confirmations,
    corrections,
  });

  assert.equal(stats.total, 4);
  assert.equal(stats.helpful, 1);
  assert.equal(stats.problematic, 3);
  // missed_signal → missedSignal；too_certain → tooCertain
  assert.equal(stats.missedSignal, 1);
  assert.equal(stats.tooCertain, 1);
  // overthinking → overinterpretation；wrong_reading → underinterpretation
  assert.equal(stats.overinterpretation, 1);
  assert.equal(stats.underinterpretation, 1);
  // mostly_correct / partly_correct 且有勾选 → confirmed
  assert.equal(stats.confirmedInterpretations, 2);
  // incorrect 1 条 + 纠错 1 条
  assert.equal(stats.contradictedInterpretations, 2);

  assert.deepEqual(computeFeedbackStats({}), {
    total: 0,
    helpful: 0,
    problematic: 0,
    overinterpretation: 0,
    underinterpretation: 0,
    missedSignal: 0,
    tooCertain: 0,
    confirmedInterpretations: 0,
    contradictedInterpretations: 0,
  });
});

test("16. migrateProfilePayload 支持三种历史格式，高版本安全忽略", () => {
  const good = validProfilePayload("profile:good");

  const versioned = migrateProfilePayload({ version: 1, profiles: [good] });
  assert.equal(versioned.version, PROFILE_SCHEMA_VERSION);
  assert.equal(versioned.profiles.length, 1);
  assert.equal(versioned.profiles[0].id, "profile:good");

  const bare = migrateProfilePayload([good]);
  assert.equal(bare.profiles.length, 1);
  assert.equal(bare.version, PROFILE_SCHEMA_VERSION);

  const noVersion = migrateProfilePayload({ profiles: [good] });
  assert.equal(noVersion.profiles.length, 1);

  // 来自更高版本：安全忽略，不破坏
  const future = migrateProfilePayload({
    version: PROFILE_SCHEMA_VERSION + 1,
    profiles: [good],
  });
  assert.deepEqual(future.profiles, []);
  assert.equal(future.version, PROFILE_SCHEMA_VERSION);

  // 垃圾输入一律得到空数组
  assert.deepEqual(migrateProfilePayload(null).profiles, []);
  assert.deepEqual(migrateProfilePayload(undefined).profiles, []);
  assert.deepEqual(migrateProfilePayload("垃圾").profiles, []);
  assert.deepEqual(migrateProfilePayload(42).profiles, []);
  assert.deepEqual(migrateProfilePayload({}).profiles, []);
  assert.deepEqual(
    migrateProfilePayload({ version: 1, profiles: "x" }).profiles,
    [],
  );
  assert.deepEqual(
    migrateProfilePayload({ version: 1, profiles: [{ id: "" }] }).profiles,
    [],
  );
});

test("17. 损坏的档案被安全忽略，只保留合法条目且不抛异常", () => {
  // 缺 id
  assert.equal(validateProfile({ relationshipContext: BASE_CTX }), null);
  assert.equal(validateProfile({ id: "", relationshipContext: BASE_CTX }), null);
  // 缺 / 非法 relationshipContext
  assert.equal(validateProfile({ id: "p1" }), null);
  assert.equal(
    validateProfile({ id: "p1", relationshipContext: { type: "灵魂伴侣" } }),
    null,
  );
  // 非对象与垃圾
  assert.equal(validateProfile(null), null);
  assert.equal(validateProfile("垃圾"), null);
  assert.equal(validateProfile(42), null);

  const good = validProfilePayload("profile:good");
  assert.equal(validateProfile(good)?.id, "profile:good");

  const { storage, map } = fakeStorage();
  map.set("crush-monitor.profile.v1", "{{{");
  assert.deepEqual(loadProfiles(storage), []);
  map.set("crush-monitor.profile.v1", JSON.stringify("垃圾"));
  assert.deepEqual(loadProfiles(storage), []);
  map.set("crush-monitor.profile.v1", JSON.stringify({}));
  assert.deepEqual(loadProfiles(storage), []);
  // 一条合法 + 一条损坏的混合数组
  map.set(
    "crush-monitor.profile.v1",
    JSON.stringify({ version: 1, profiles: [good, { id: "broken" }] }),
  );
  const loaded = loadProfiles(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "profile:good");
});

test("18. 删除单条 memory 后该条消失，其余保留", () => {
  const { storage } = fakeStorage();
  const profile = profileWith({
    id: "profile:del-memory",
    memories: [
      memory({ id: "mem:a", content: "对方说：脚扭了" }),
      memory({ id: "mem:b", content: "对方说：周末考试" }),
      memory({ id: "mem:c", content: "对方说：不喜欢吃香菜" }),
    ],
  });
  saveProfiles([profile], storage);
  assert.equal(loadProfiles(storage)[0].memories.length, 3);

  const next = deleteMemory("profile:del-memory", "mem:b", storage);
  const after = next.find((p) => p.id === "profile:del-memory")!;
  assert.deepEqual(
    after.memories.map((m) => m.id),
    ["mem:a", "mem:c"],
  );
  assert.deepEqual(
    loadProfiles(storage)[0].memories.map((m) => m.id),
    ["mem:a", "mem:c"],
  );
  // 其它档案不受影响
  assert.equal(deleteMemory("profile:不存在", "mem:a", storage).length, 1);
});

test("19. 删除 profile 后 loadProfiles 为空", () => {
  const { storage } = fakeStorage();
  saveProfiles([profileWith({ id: "profile:gone" })], storage);
  assert.equal(loadProfiles(storage).length, 1);
  assert.deepEqual(deleteProfile("profile:gone", storage), []);
  assert.deepEqual(loadProfiles(storage), []);
});

test("20. 清空 baseline 不删记忆，clearLongTerm 只删自己的 key", () => {
  const { storage, map } = fakeStorage();
  let baseline = updateBaseline(null, session("conv-1", { reply_length: 10 }, 1));
  baseline = updateBaseline(baseline, session("conv-2", { reply_length: 12 }, 2));
  assert.equal(baseline.conversationCount, 2);

  const profile = profileWith({
    id: "profile:clear",
    behaviorBaseline: baseline,
    sourceConversationIds: ["conv-1", "conv-2"],
    memories: [memory({ id: "mem:keep", content: "对方说：周末考试" })],
  });
  saveProfiles([profile], storage);
  assert.equal(loadProfiles(storage)[0].memories.length, 1);

  const cleared = clearBaseline("profile:clear", storage);
  const after = cleared.find((p) => p.id === "profile:clear")!;
  assert.equal(after.behaviorBaseline.conversationCount, 0);
  assert.deepEqual(after.sourceConversationIds, []);
  assert.deepEqual(after.behaviorBaseline.metrics, {});
  // 原始 conversation 与记忆都还在
  assert.equal(after.memories.length, 1);
  assert.equal(after.memories[0].id, "mem:keep");
  assert.equal(loadProfiles(storage)[0].memories.length, 1);

  // clearLongTerm 只删 LONG_TERM_KEYS 里的 key
  map.set("crush-monitor.saved.v1", JSON.stringify({ conversations: 3 }));
  map.set("unrelated", "keep-me");
  clearLongTerm(storage);
  assert.equal(
    map.get("crush-monitor.saved.v1"),
    JSON.stringify({ conversations: 3 }),
  );
  assert.equal(map.get("unrelated"), "keep-me");
  for (const key of LONG_TERM_KEYS)
    assert.equal(map.get(key), undefined, `${key} 应被删除`);
  assert.deepEqual(loadProfiles(storage), []);
});

// ---------------------------------------------------------------------------
// 21. 来源标签进入 DeepSeek 输入
// ---------------------------------------------------------------------------

test("21. 送往 DeepSeek 的上下文带三种来源标签与权重说明", () => {
  const facts = extractObservedFacts([
    msg("m1", OTHER, "我不喜欢吃香菜", "2026年09月20日 10:00"),
  ]);
  assert.ok(facts.length > 0);
  const observed = observedMemoriesFromFacts(facts, NOW);
  const confirmed = memory({
    id: "mem:confirmed-1",
    content: "用户确认：她那天只是发烧",
    sourceType: "user_confirmed",
    confidence: 1,
  });
  const inferred = memory({
    id: "mem:inferred-1",
    kind: "pattern",
    content: "对方可能不太想理我",
    sourceType: "model_inferred",
    confidence: 0.6,
  });
  const profile = profileWith({
    memories: [...observed, confirmed, inferred],
    behaviorBaseline: baselineWith({
      conversationCount: 1,
      sampleCount: 1,
      metrics: {
        reply_length: metricWith({ mean: 12.5, median: 12.5, sampleCount: 1 }),
      },
    }),
  });

  const bundle = retrieveRelevantProfileContext({
    profile,
    messages: [msg("m1", OTHER, "我不喜欢吃香菜", "2026年09月20日 10:00")],
  });
  const text = describeProfileContext(bundle).join("\n");

  assert.ok(text.includes("【用户确认】"), text);
  assert.ok(text.includes("【当前事实】"), text);
  assert.ok(text.includes("【模型推断·弱背景】"), text);
  assert.ok(
    text.includes("用户确认 > 当前事实 > 程序统计的已知模式"),
    "必须有一行说明权重顺序",
  );
  assert.ok(
    text.includes("模型推断永远只是弱背景"),
    "必须说明模型推断不得独自形成长期结论",
  );

  const request = buildProviderInput({
    revision: 1,
    relation: "crush",
    targetId: null,
    messages: [msg("m1", OTHER, "我不喜欢吃香菜", "2026年09月20日 10:00")],
    observations: [],
    memory: [],
    patterns: [],
    profile: bundle,
  });

  // buildPayload 是纯函数，不联网
  const payload = buildPayload(request);
  assert.ok(
    Array.isArray(payload.profileContext) && payload.profileContext.length > 0,
  );
  assert.ok(
    (payload.profileContext as string[]).join("\n").includes("【用户确认】"),
  );
  assert.equal(typeof payload.historicalBaseline, "string");
  assert.ok(Array.isArray(payload.historicalDeltas));
  assert.ok(
    (payload.historicalBaseline as string).includes("跨会话历史基线"),
    payload.historicalBaseline as string,
  );
});

// ---------------------------------------------------------------------------
// 22-24. UserTranslation「和她平时相比」
// ---------------------------------------------------------------------------

const HISTORY_WITH_DELTA: HistoricalPatternTrend = {
  scope: "historical",
  direction: "warming",
  confidence: "medium",
  supportingMetrics: ["intent_drift"],
  conflictingMetrics: [],
  deltas: [
    {
      metric: "reply_length",
      label: "对方消息平均字数",
      current: 20,
      historical: 12,
      historicalMedian: 12,
      delta: 8,
      normalizedDelta: 0.67,
      significance: "large",
      sampleCount: 6,
    },
  ],
  baselineStatus: "established",
  comparedConversations: 6,
  insufficientHistory: false,
};

const SESSION_COOLING: PatternTrend = {
  direction: "cooling",
  confidence: "medium",
  supportingMetrics: [],
  conflictingMetrics: ["reply_length"],
  externalCausePresent: false,
  externalCauses: [],
};

test("22. comparedToUsual 出现「她平时」，历史不足时说明样本不足，会话内 cooling 时补充说明", () => {
  const translation = buildTranslation(
    analysisOf({ trend: "stable" }),
    SESSION_COOLING,
    HISTORY_WITH_DELTA,
  );
  assert.ok(translation.comparedToUsual.length > 0);
  const text = translation.comparedToUsual.join("\n");
  assert.ok(text.includes("平时"), text);
  assert.ok(text.includes("她平时"), text);

  // 历史不足：用 baselineStatusLabel 的措辞说明样本不够
  const thin: HistoricalPatternTrend = {
    ...HISTORY_WITH_DELTA,
    direction: "uncertain",
    confidence: "low",
    supportingMetrics: [],
    deltas: [],
    baselineStatus: "insufficient",
    comparedConversations: 2,
    insufficientHistory: true,
  };
  assert.ok(
    buildTranslation(analysisOf({ trend: "stable" }), SESSION_COOLING, thin)
      .comparedToUsual.join("\n")
      .includes("历史样本还不足"),
  );

  // 会话内 cooling 但历史全部 significance none：额外说明「仍然接近她自己平时的水平」
  const noDelta: HistoricalPatternTrend = {
    ...HISTORY_WITH_DELTA,
    direction: "stable",
    supportingMetrics: [],
    deltas: [
      {
        metric: "reply_length",
        label: "对方消息平均字数",
        current: 12,
        historical: 12.4,
        historicalMedian: 12.4,
        delta: -0.4,
        normalizedDelta: -0.03,
        significance: "none",
        sampleCount: 6,
      },
    ],
  };
  assert.ok(
    buildTranslation(analysisOf({ trend: "cooling" }), SESSION_COOLING, noDelta)
      .comparedToUsual.join("\n")
      .includes("仍然接近她自己平时的水平"),
  );

  // 不传历史趋势时这一节为空，而不是拿会话内 delta 顶替
  assert.deepEqual(
    buildTranslation(analysisOf({ trend: "cooling" }), SESSION_COOLING)
      .comparedToUsual,
    [],
  );
});

test("23. 历史不足时不伪造 baseline：方向 uncertain、把握 low、不产生 delta 描述行", () => {
  const at = Date.UTC(2026, 8, 20, 10, 0);
  const one = updateBaseline(null, session("c1", { reply_length: 10 }, at));
  const two = updateBaseline(one, session("c2", { reply_length: 11 }, at + 1000));

  const cases: {
    label: string;
    baseline: BehaviorBaseline | null;
    count: number;
  }[] = [
    { label: "0 次", baseline: null, count: 0 },
    { label: "1 次", baseline: one, count: 1 },
    { label: "2 次", baseline: two, count: 2 },
  ];

  for (const item of cases) {
    const trend = computeHistoricalTrend(item.baseline, { reply_length: 12 });
    assert.equal(trend.insufficientHistory, true, `${item.label} 应标记历史不足`);
    assert.equal(trend.direction, "uncertain", item.label);
    assert.equal(trend.confidence, "low", item.label);
    assert.equal(trend.comparedConversations, item.count, item.label);
    assert.equal(trend.scope, "historical");

    const lines = describeComparedToUsual(trend);
    assert.equal(lines.length, 1, `${item.label} 只应有一行说明`);
    const line = lines[0];
    // 历史不足时只说明样本不够，不产出任何 delta 描述
    assert.equal(line.includes("她这次"), false, line);
    assert.equal(/本次 [\d.]/.test(line), false, `不应出现 delta 描述：${line}`);
    assert.ok(
      line.includes("还没有历史样本") || line.includes("历史样本还不足"),
      line,
    );
  }

  // 一次样本都没有时如实说「还没有历史样本」
  assert.ok(
    describeComparedToUsual(
      computeHistoricalTrend(null, { reply_length: 12 }),
    )[0].includes("还没有历史样本"),
  );
  assert.ok(
    describeComparedToUsual(
      computeHistoricalTrend(two, { reply_length: 12 }),
    )[0].includes("历史样本还不足"),
  );
});

test("24. 外部原因修正与历史 delta 描述可以同时工作", () => {
  const patternTrend: PatternTrend = {
    ...SESSION_COOLING,
    externalCausePresent: true,
    externalCauses: ["injury"],
  };

  const translation = buildTranslation(
    analysisOf({ trend: "cooling" }),
    patternTrend,
    HISTORY_WITH_DELTA,
  );

  const uncertainty = translation.uncertainty.join("\n");
  const watch = translation.whatToWatchNext.join("\n");
  assert.ok(uncertainty.includes("外部原因"), uncertainty);
  assert.ok(uncertainty.includes("不能据此判断关系变化"), uncertainty);
  assert.ok(watch.includes("外部原因"), watch);
  assert.ok(translation.comparedToUsual.length > 0);
  assert.ok(
    translation.comparedToUsual.join("\n").includes("她平时"),
    translation.comparedToUsual.join("\n"),
  );
});

// ---------------------------------------------------------------------------
// 25-26. 输出侧禁令
// ---------------------------------------------------------------------------

const BANNED_LABELS = [
  "回避型",
  "焦虑型",
  "人格",
  "依恋",
  "自恋",
  "抑郁",
  "类型的人",
  "性格",
];

/** 审计视图里那句「不得用它做人格判断」是禁令本身，不是人格标签。 */
const PROHIBITION_LINE = "也不得用它做人格判断";

/**
 * 收集「系统输出给用户 / 模型」的全部字符串。
 * 覆盖：检索描述、历史 delta 描述、翻译层、审计视图。
 */
function collectOutputs(): string[] {
  const facts = extractObservedFacts([
    msg("m1", OTHER, "我不喜欢吃香菜", "2026年09月20日 10:00"),
  ]);
  const observed = observedMemoriesFromFacts(facts, NOW);
  const confirmed = memory({
    id: "mem:confirmed-1",
    content: "用户确认：她那天只是发烧",
    sourceType: "user_confirmed",
    confidence: 1,
  });
  const inferred = memory({
    id: "mem:inferred-1",
    kind: "pattern",
    content: "对方可能不太想理我",
    sourceType: "model_inferred",
    confidence: 0.6,
  });
  const unresolvedMemory = memory({
    id: "mem:unresolved-1",
    kind: "unresolved",
    content: "还没说清周末到底去不去",
    sourceType: "model_inferred",
    confidence: 0.5,
  });
  const habit: CommunicationHabit = {
    expression: "哈哈",
    observedCount: 8,
    conversationCount: 2,
    contexts: ["开心", "分享近况", "害羞", "逗你"],
    usualMeaning: "更像语气填充，跨多种情绪语境出现，不宜单独当作情绪信号",
    confidence: "medium",
    lastObservedAt: 3,
    conversationIds: ["conv-a", "conv-b"],
  };
  const baseline = baselineWith({
    sampleCount: 12,
    conversationCount: 6,
    metrics: {
      reply_latency: metricWith({ mean: 12, median: 8, sampleCount: 6 }),
      reply_length: metricWith({ mean: 16.4, median: 15, sampleCount: 6 }),
    },
  });
  const profile = profileWith({
    memories: [...observed, confirmed, inferred, unresolvedMemory],
    habits: [habit],
    knownPatterns: [
      {
        id: "kp:habit:哈哈",
        patternKey: "habit:哈哈",
        description: "常用「哈哈」作为语气填充（7 次 / 3 段对话）",
        evidenceCount: 7,
        conversationCount: 3,
        sourceType: "deterministic",
        supportingMetrics: ["reply_length"],
        firstObservedAt: 1,
        lastObservedAt: 3,
        status: "active",
      },
    ],
    behaviorBaseline: baseline,
  });

  const windowMessages = [
    msg("m1", OTHER, "我不喜欢吃香菜，哈哈", "2026年09月20日 10:00"),
  ];
  const bundle = retrieveRelevantProfileContext({
    profile,
    messages: windowMessages,
  });
  const metrics = { reply_latency: 20, reply_length: 7.2 };
  const deltas = computeHistoricalDeltas(baseline, metrics);
  const historicalTrend = computeHistoricalTrend(baseline, metrics);
  const patternTrend: PatternTrend = {
    ...SESSION_COOLING,
    externalCausePresent: true,
    externalCauses: ["injury"],
  };
  const analysis = analysisOf({ trend: "cooling" });
  const translation = buildTranslation(analysis, patternTrend, historicalTrend);
  const audit = buildAuditTrace({
    bundle,
    historicalTrend,
    habits: profile.habits,
    messages: windowMessages,
    analysis,
  });

  return [
    ...describeProfileContext(bundle),
    ...describeComparedToUsual(historicalTrend),
    ...describeHistoricalDeltas(deltas),
    ...audit.facts,
    ...audit.habits,
    ...audit.historical,
    ...audit.current,
    ...audit.interpretation.map((i) => i.detail),
    ...audit.bySource.flatMap((s) => s.items),
    ...audit.excluded,
    ...translation.comparedToUsual,
    ...translation.whatHappened,
    ...translation.whatYouMightMiss,
    ...translation.uncertainty,
    ...translation.whatToWatchNext,
  ];
}

test("25. 所有输出都不含人格标签", () => {
  const outputs = collectOutputs();
  assert.ok(outputs.length > 0);
  assert.ok(
    outputs.some((line) => line.includes(PROHIBITION_LINE)),
    "来源权重说明本身必须存在",
  );
  for (const line of outputs) {
    if (line.includes(PROHIBITION_LINE)) continue;
    for (const word of BANNED_LABELS)
      assert.ok(!line.includes(word), `输出不应包含「${word}」：${line}`);
  }
});

test("26. 所有输出都不含好感概率或百分比数字", () => {
  const outputs = collectOutputs();
  assert.ok(outputs.length > 0);
  for (const line of outputs) {
    assert.equal(/[0-9]+%/.test(line), false, `输出不应包含百分比数字：${line}`);
    assert.equal(line.includes("概率"), false, `输出不应包含「概率」：${line}`);
    assert.equal(
      line.includes("喜欢你的可能性"),
      false,
      `输出不应包含好感可能性：${line}`,
    );
  }

  // 显著程度用语是允许的，只有「概率」两个字被禁止
  const deltas = computeHistoricalDeltas(
    baselineWith({
      sampleCount: 6,
      conversationCount: 6,
      metrics: {
        reply_length: metricWith({ mean: 16.4, median: 15, sampleCount: 6 }),
      },
    }),
    { reply_length: 7.2 },
  );
  const deltaLine = describeHistoricalDeltas(deltas)[0];
  assert.ok(deltaLine.includes("显著程度"), deltaLine);
  assert.equal(deltaLine.includes("概率"), false);
});

test("28. 程序侧归纳「她平时就是这样」，且措辞不越界", () => {
  const at = 1_780_000_000_000;
  const DAY = 86_400_000;
  const build = (
    metrics: Partial<Record<BaselineMetricKind, number>>[],
  ) =>
    metrics.reduce(
      (baseline, values, index) =>
        updateBaseline(baseline, {
          conversationId: `conv-${index}`,
          metrics: values,
          at: at + index * DAY,
        }),
      emptyBaseline(),
    );

  // 一直是极短回复：回复长度稳定在 2 字附近
  const short = build([
    { reply_length: 2, reply_latency: 1.5 },
    { reply_length: 2, reply_latency: 2 },
    { reply_length: 2.2, reply_latency: 1.8 },
    { reply_length: 1.8, reply_latency: 2.2 },
    { reply_length: 2, reply_latency: 2 },
  ]);
  const shortPatterns = promoteBehaviorPatterns(
    deriveBehaviorPatterns({ baseline: short, at }),
  );
  const lengthPattern = shortPatterns.find((p) =>
    p.patternKey.includes("reply_length_short"),
  );
  assert.ok(lengthPattern, "稳定的短回复应被归纳成模式");
  assert.ok(lengthPattern!.description.includes("回复通常很短"));
  assert.equal(lengthPattern!.sourceType, "deterministic");
  assert.ok(lengthPattern!.conversationCount >= 4);

  // 措辞只能停留在可观察行为上，不能变成人格判断
  for (const pattern of shortPatterns) {
    for (const word of ["话少", "内向", "冷淡", "性格", "回避型", "人格"]) {
      assert.equal(
        pattern.description.includes(word),
        false,
        `模式描述不应包含「${word}」：${pattern.description}`,
      );
    }
  }

  // 波动很大的回复长度不构成「平时就是这样」
  const noisy = build([
    { reply_length: 2 },
    { reply_length: 30 },
    { reply_length: 5 },
    { reply_length: 40 },
    { reply_length: 3 },
  ]);
  assert.equal(
    deriveBehaviorPatterns({ baseline: noisy, at }).some((p) =>
      p.key.includes("reply_length"),
    ),
    false,
    "波动大时不应归纳成稳定模式",
  );

  // 谁先开口：历史上基本由我方开启
  const mine = build([
    { initiation_ratio: 0 },
    { initiation_ratio: 0 },
    { initiation_ratio: 0 },
    { initiation_ratio: 0 },
  ]);
  const mineCandidates = deriveBehaviorPatterns({ baseline: mine, at });
  assert.ok(
    mineCandidates.some((p) => p.key === "rarely_initiates"),
    JSON.stringify(mineCandidates.map((p) => p.key)),
  );

  const hers = build([
    { initiation_ratio: 1 },
    { initiation_ratio: 1 },
    { initiation_ratio: 1 },
    { initiation_ratio: 0.8 },
  ]);
  assert.ok(
    promoteBehaviorPatterns(deriveBehaviorPatterns({ baseline: hers, at })).some(
      (p) => p.description.includes("多由她开启对话"),
    ),
  );

  // 样本不足（只有 2 段对话）时不产出任何模式
  assert.deepEqual(
    promoteBehaviorPatterns(
      deriveBehaviorPatterns({
        baseline: build([{ reply_length: 2 }, { reply_length: 2 }]),
        at,
      }),
    ),
    [],
  );
});

test("30. emotion_drift 文案是「正负情绪净值」，因为它可以取负值", () => {
  const label = metricLabel("emotion_drift");
  assert.equal(label, "对方正负情绪净值");
  assert.equal(label.includes("占比"), false, "该指标是差值，不能叫占比");

  // 会话内指标表与历史 delta 都使用同一个标签
  const patterns = computePatterns({
    messages: [
      msg("e1", OTHER, "一般", "2026年09月20日 10:00"),
      msg("e2", OTHER, "还行", "2026年09月20日 10:05"),
    ],
    observations: [
      obs("e1", { annoyed: 0.9 }, { close: 0.9 }),
      obs("e2", { sad: 0.9 }, { close: 0.9 }),
    ],
  });
  const metric = patterns.find((p) => p.kind === "emotion_drift");
  assert.ok(metric);
  assert.equal(metric!.label, "对方正负情绪净值");

  // 允许为负：负向情绪占多数时净值 < 0
  const negative = computeSessionMetrics({
    messages: [
      msg("n1", OTHER, "算了", "2026年09月20日 10:00"),
      msg("n2", OTHER, "不想说", "2026年09月20日 10:05"),
    ],
    observations: [
      obs("n1", { annoyed: 0.9 }, { close: 0.9 }),
      obs("n2", { disappointed: 0.9 }, { refuse: 0.9 }),
    ],
  });
  assert.ok(
    (negative.emotion_drift ?? 0) < 0,
    `负向情绪应给出负净值：${negative.emotion_drift}`,
  );

  // 「和她平时相比」的文案同样使用新措辞
  const deltas = computeHistoricalDeltas(
    baselineWith({
      sampleCount: 6,
      conversationCount: 6,
      metrics: {
        emotion_drift: metricWith({ mean: -0.5, median: -0.5, sampleCount: 6 }),
      },
    }),
    { emotion_drift: -0.2 },
  );
  const delta = deltas.find((d) => d.metric === "emotion_drift")!;
  assert.equal(delta.label, "对方正负情绪净值");
  const compared = describeComparedToUsual(
    computeHistoricalTrend(
      baselineWith({
        sampleCount: 6,
        conversationCount: 6,
        metrics: {
          emotion_drift: metricWith({ mean: -0.5, median: -0.5, sampleCount: 6 }),
        },
      }),
      { emotion_drift: -0.2 },
    ),
  ).join("\n");
  assert.ok(compared.includes("正负情绪净值"), compared);
  assert.equal(compared.includes("正向情绪占比"), false);
});

test("31. 旧版（schema v1）档案能正常迁移", () => {
  const legacy = {
    id: "profile:旧档案:crush",
    displayName: "旧档案",
    relationshipContext: contextFromRelation("crush"),
    createdAt: 1,
    updatedAt: 2,
    baselineVersion: 1,
    behaviorBaseline: {
      sampleCount: 4,
      conversationCount: 4,
      firstObservedAt: 1,
      lastObservedAt: 2,
      metrics: {
        // v1 的基线没有 recentConversationIds
        reply_length: {
          mean: 2,
          median: 2,
          variance: 0,
          sampleCount: 4,
          updatedAt: 2,
          weightSum: 4,
          weightedSum: 8,
          recent: [2, 2, 2, 2],
        },
      },
    },
    memories: [
      {
        id: "mem:fact:old",
        kind: "event",
        content: "对方说：脚扭了",
        sourceMessageIds: ["m1"],
        createdAt: "2026-09-01T00:00:00.000Z",
        lastConfirmedAt: "2026-09-01T00:00:00.000Z",
        status: "active",
        confidence: 0.8,
        sourceType: "observed",
      },
    ],
    knownPatterns: [
      {
        // v1 的模式没有 patternKey / conversationCount / supportingMetrics
        id: "kp:stable:reply_length",
        description: "历史上她的回复长度一直稳定在约 2 字",
        evidenceCount: 4,
        sourceType: "observed",
        firstObservedAt: 1,
        lastObservedAt: 2,
        status: "active",
      },
    ],
    habits: [],
    inferenceCandidates: [],
    feedbackStats: {},
    confirmations: [],
    corrections: [],
    sourceConversationIds: ["conv:old"],
  };

  const migrated = migrateProfilePayload({ version: 1, profiles: [legacy] });
  assert.equal(migrated.version, PROFILE_SCHEMA_VERSION);
  assert.equal(migrated.profiles.length, 1, "v1 档案必须能迁移进来");

  const profile = migrated.profiles[0];
  assert.equal(profile.id, legacy.id);
  assert.equal(profile.memories.length, 1);
  assert.equal(profile.memories[0].sourceType, "observed");

  // "observed" → "deterministic"，并补齐 v2 新增字段
  const pattern = profile.knownPatterns[0];
  assert.equal(pattern.sourceType, "deterministic");
  assert.equal(pattern.patternKey, "stable:reply_length");
  assert.equal(pattern.conversationCount, 4);
  assert.deepEqual(pattern.supportingMetrics, []);
  assert.equal(pattern.status, "active");

  // v2 新增的字段有安全的默认值
  assert.deepEqual(profile.activityEvents, []);
  assert.deepEqual(
    profile.behaviorBaseline.metrics.reply_length?.recentConversationIds,
    [],
  );
  assert.deepEqual(profile.confirmations, []);
  assert.deepEqual(profile.corrections, []);

  // 迁移后的档案可以直接参与检索，不需要额外修补
  const bundle = retrieveRelevantProfileContext({
    profile,
    messages: [msg("m1", OTHER, "今天好累", "2026年09月20日 10:00")],
  });
  assert.equal(bundle.knownPatterns.length, 1);
  assert.equal(bundle.knownPatterns[0].sourceType, "deterministic");

  // 版本高于当前时不破坏数据：安全忽略
  assert.deepEqual(
    migrateProfilePayload({ version: PROFILE_SCHEMA_VERSION + 1, profiles: [legacy] })
      .profiles,
    [],
  );
});

test("32. 确定性事件统计：邀约与答复归类正确且保守", () => {
  const invite = (id: string, text: string, day: string) =>
    msg(id, SELF, text, day);
  const reply = (id: string, text: string, day: string) =>
    msg(id, OTHER, text, day);

  // 提前约好 → 接受
  const planned = detectActivityEvents(
    [
      invite("a1", "这周末要不要一起去看展", "2026年09月19日 20:00"),
      reply("a2", "好啊 我买票", "2026年09月19日 20:05"),
    ],
    "conv-planned",
    1,
  );
  assert.deepEqual(
    planned.map((e) => e.kind),
    ["planned_invite_accepted"],
  );
  assert.deepEqual(planned[0].messageIds, ["a1", "a2"]);

  // 当天临时 → 拒绝（「这周可能不行」同时命中接受词，必须先判拒绝）
  const sameDay = detectActivityEvents(
    [
      invite("b1", "今晚要不要一起吃饭", "2026年09月19日 18:00"),
      reply("b2", "今晚可能不行 有事", "2026年09月19日 18:03"),
    ],
    "conv-same-day",
    2,
  );
  assert.deepEqual(
    sameDay.map((e) => e.kind),
    ["same_day_invite_declined"],
  );

  // 对方主动提出一起活动
  const hers = detectActivityEvents(
    [
      reply("c1", "下周那家新开的店 要不要一起去试试", "2026年09月19日 19:00"),
      msg("c2", SELF, "去啊", "2026年09月19日 19:02"),
    ],
    "conv-hers",
    3,
  );
  assert.deepEqual(
    hers.map((e) => e.kind),
    ["counterpart_proposes_activity"],
  );

  // 保守：只有邀约词、没有活动词，不算邀约
  assert.deepEqual(
    detectActivityEvents(
      [
        invite("d1", "周末有空吗", "2026年09月19日 20:00"),
        reply("d2", "这周可能不行", "2026年09月19日 20:04"),
      ],
      "conv-vague",
      4,
    ),
    [],
  );
  // 保守：答复含糊（没有明确的接受或拒绝措辞）不归类
  assert.deepEqual(
    detectActivityEvents(
      [
        invite("e1", "要不要一起去看电影", "2026年09月19日 20:00"),
        reply("e2", "到时候看吧", "2026年09月19日 20:04"),
      ],
      "conv-unknown",
      5,
    ),
    [],
  );

  // 同一段对话里同一种事件只记一次
  const repeated = detectActivityEvents(
    [
      invite("f1", "明天要不要一起吃饭", "2026年09月19日 12:00"),
      reply("f2", "好啊", "2026年09月19日 12:02"),
      invite("f3", "那明天要不要一起去看电影", "2026年09月19日 12:05"),
      reply("f4", "好呀", "2026年09月19日 12:07"),
    ],
    "conv-repeat",
    6,
  );
  assert.equal(repeated.length, 1, "同一段对话同一种事件只记一次");

  // 跨对话去重：同一段对话重复提交不会让证据数翻倍
  const once = recordActivityEvents([], planned);
  const twice = recordActivityEvents(once, planned);
  assert.equal(twice.length, 1);
  assert.deepEqual(eventConversations(twice, "planned_invite_accepted"), [
    "conv-planned",
  ]);
});

test("33. 事件证据达到 4 段对话时才形成高风险模式", () => {
  const at = 1_780_000_000_000;
  const DAY = 86_400_000;
  const events = Array.from({ length: 4 }, (_, index) => ({
    kind: "planned_invite_accepted" as const,
    conversationId: `conv-${index + 1}`,
    messageIds: [`m${index + 1}`],
    at: at + index * DAY,
  }));

  const candidates = deriveBehaviorPatterns({
    baseline: emptyBaseline(),
    activityEvents: events,
    at,
  });
  const planned = candidates.find(
    (c) => c.key === "accepts_planned_invitations",
  );
  assert.ok(planned);
  assert.equal(planned!.highRisk, true);
  assert.equal(planned!.evidenceCount, 4);
  assert.equal(planned!.metric, "activity_event");

  const patterns = promoteBehaviorPatterns(candidates);
  const pattern = patterns.find(
    (p) => p.patternKey === "accepts_planned_invitations",
  );
  assert.ok(pattern, "4 段对话证据应形成高风险模式");
  assert.equal(pattern!.sourceType, "deterministic");
  assert.equal(pattern!.conversationCount, 4);
  // 只描述可观察行为
  for (const word of ["她喜欢", "她害怕", "她是", "类型"]) {
    assert.equal(
      pattern!.description.includes(word),
      false,
      `高风险模式描述越界：${pattern!.description}`,
    );
  }
});

test("29. 会话重复提交不会让基线样本被重复计入", () => {
  const at = 1_780_000_000_000;
  const { storage } = fakeStorage();
  const store = createProfileStore({
    storage,
    now: () => at,
    id: () => "fixed",
  });
  store.useIdentity({
    displayName: "重复测试",
    relation: "crush",
    relationshipContext: contextFromRelation("crush"),
  });
  const messages: Message[] = [
    msg("r1", SELF, "在吗", "2026-09-20 21:00"),
    msg("r2", OTHER, "在", "2026-09-20 21:02"),
    msg("r3", SELF, "忙吗", "2026-09-20 21:03"),
    msg("r4", OTHER, "不太忙", "2026-09-20 21:05"),
  ];
  const observations: Observation[] = messages.map((m, i) => ({
    messageId: m.id,
    emotions: { calm: 0.8 },
    intents: { answer: 0.8 },
    score: null,
    model: "jev-1.13.0",
    observedAt: NOW,
  }));
  const conversationId = conversationIdFor("crush", messages);
  const commit = () =>
    store.commit({
      conversationId,
      messages,
      observations,
      analysis: null,
      now: NOW,
      at,
    });

  commit();
  const first = store.getProfile()!.behaviorBaseline.conversationCount;
  commit();
  commit();
  const after = store.getProfile()!.behaviorBaseline.conversationCount;
  assert.equal(first, 1);
  assert.equal(after, 1, "同一段对话重复提交不应增加基线样本");
  assert.equal(store.getProfile()!.sourceConversationIds.length, 1);
});

test("27. 同一段对话重复提交时表达习惯的计数完全幂等", () => {
  const conversation: Message[] = [
    {
      id: "h1",
      sender: "other",
      text: "哈哈哈哈 好玩",
      timestamp: "2026-09-20 21:00",
      kind: "text",
    },
  ];
  const observations: Observation[] = [
    {
      messageId: "h1",
      emotions: { happy: 0.9 },
      intents: { share: 0.9 },
      score: null,
      model: "jev-1.13.0",
      observedAt: NOW,
    },
  ];
  const input = {
    messages: conversation,
    observations,
    conversationId: "conv-a",
    at: 1_700_000_000_000,
  };

  const first = aggregateHabits(input, []);
  const habit = first.find((h) => h.expression === "哈哈")!;
  assert.equal(habit.observedCount, 2);
  assert.equal(habit.conversationCount, 1);

  // 同一段对话再提交两次：计数一个字都不能涨
  const second = aggregateHabits({ ...input, at: input.at + 1000 }, first);
  const third = aggregateHabits({ ...input, at: input.at + 2000 }, second);
  const after = third.find((h) => h.expression === "哈哈")!;
  assert.equal(after.observedCount, 2);
  assert.equal(after.conversationCount, 1);
  assert.deepEqual(after.conversationIds, ["conv-a"]);

  // 换一段对话才累加，两段对话后达到可用的习惯门槛
  const other = aggregateHabits(
    {
      ...input,
      conversationId: "conv-b",
      at: input.at + 3000,
    },
    third,
  ).find((h) => h.expression === "哈哈")!;
  assert.equal(other.observedCount, 4);
  assert.equal(other.conversationCount, 2);
  assert.equal(habitIsEstablished(other), false, "4 次还不够 5 次门槛");

  const established = aggregateHabits(
    {
      ...input,
      conversationId: "conv-c",
      at: input.at + 4000,
    },
    aggregateHabits({ ...input, conversationId: "conv-b", at: input.at + 3000 }, third),
  ).find((h) => h.expression === "哈哈")!;
  assert.equal(established.observedCount, 6);
  assert.equal(habitIsEstablished(established), true);
  assert.equal(establishedHabits([established]).length, 1);
});
