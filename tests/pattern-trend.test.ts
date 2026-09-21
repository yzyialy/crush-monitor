import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePatterns,
  computePatternTrend,
  describePatternTrend,
  detectExternalCauses,
  METRIC_DEFINITIONS,
  splitHalf,
} from "../shared/patterns";
import { buildTranslation, trendLabel } from "../shared/translation";
import { buildProviderInput } from "../server/ai/input";
import {
  buildPayload,
  createDeepSeekProvider,
  deepAnalysisOutput,
} from "../server/ai/deepseek";
import {
  DEEP_ANALYSIS_PROMPT_VERSION,
  contextFromRelation,
  type DeepAnalysisRequest,
  type Message,
  type Observation,
} from "../shared/types";

/**
 * 本轮补强测试：
 *   1. 所有核心指标的前后 baseline / delta
 *   2. counterpart-only 统计
 *   3. PatternTrend 确定性 + 外部原因
 *   4. RelationshipContext
 *   5. violationCodes 响应组装
 */

const SELF = "self" as const;
const OTHER = "other" as const;

type Row = [typeof SELF | typeof OTHER, string, string];

/**
 * 两段式对话：前半对方活跃，后半对方冷淡。
 *
 * 时间戳刻意设计成：
 *   - 前半两个会话（一轮由对方开启、一轮由我方开启）
 *   - 后半两个会话（都由我方开启）
 *   - 所有会话内间隔 < 30 分钟，避免 sliceSessions 把会话切碎
 *   - 后半我方的回复延迟更大
 */
const ROWS: Row[] = [
  // ---- 前半（9 月 5 日）----
  [OTHER, "今天怎么样？", "2026年09月05日 19:00"],
  [SELF, "还行，你呢", "2026年09月05日 19:05"],
  [OTHER, "我去看了个摄影展，人特别多，排了半小时队", "2026年09月05日 19:20"],
  [SELF, "听起来不错", "2026年09月05日 19:25"],
  [SELF, "对了，那个展在哪", "2026年09月05日 20:00"],
  [OTHER, "在美术馆，我发你定位，周末一起去吧", "2026年09月05日 20:10"],
  [SELF, "好", "2026年09月05日 20:15"],
  // ---- 后半（9 月 6 日）----
  [SELF, "今天怎么样", "2026年09月06日 19:00"],
  [OTHER, "还行", "2026年09月06日 19:25"],
  [SELF, "忙吗", "2026年09月06日 19:26"],
  [SELF, "周末还去那个展吗", "2026年09月06日 20:00"],
  [OTHER, "再说吧", "2026年09月06日 20:25"],
  [SELF, "好吧", "2026年09月06日 20:26"],
];

const messages: Message[] = ROWS.map(([sender, text, timestamp], i) => ({
  id: `t${i + 1}`,
  sender,
  text,
  timestamp,
  kind: "text" as const,
}));

const { baseline: baseMsgs, current: currMsgs } = splitHalf(messages);

/** 前半：正向情绪 + 主动意图；后半：中性/负向 + 收束意图。 */
function obsFor(ms: Message[], active: boolean): Observation[] {
  return ms
    .filter((m) => m.sender === "other")
    .map(
      (m): Observation => ({
        messageId: m.id,
        emotions: active
          ? { happy: 0.6, caring: 0.2 }
          : { calm: 0.5, annoyed: 0.3 },
        intents: active
          ? { share: 0.6, invite: 0.3 }
          : { close: 0.6, acknowledge: 0.3 },
        score: null,
        model: "jev-1.13.0",
        observedAt: "2026-09-21T00:00:00.000Z",
      }),
    );
}

const observations: Observation[] = [
  ...obsFor(baseMsgs, true),
  ...obsFor(currMsgs, false),
];

const patterns = computePatterns({ messages, observations });
const byKind = Object.fromEntries(patterns.map((p) => [p.kind, p]));

// ---------------------------------------------------------------------------
// 1-6. 各指标的前后 baseline / delta
// ---------------------------------------------------------------------------

test("1. reply_length 有 baseline / delta，且后半明显更短", () => {
  const p = byKind.reply_length;
  assert.equal(p.sufficient, true);
  assert.ok(p.baseline !== null && p.value !== null);
  assert.ok(p.baseline! > p.value!, `前半 ${p.baseline} 应大于后半 ${p.value}`);
  assert.equal(p.delta, Math.round((p.value - p.baseline!) * 100) / 100);
  assert.ok(p.delta! < 0);
});

test("2. question_density 有 baseline / delta，前半有提问后半没有", () => {
  const p = byKind.question_density;
  assert.equal(p.sufficient, true);
  assert.ok(p.baseline! > 0, "前半对方提过问");
  assert.equal(p.value, 0, "后半对方没提问");
  assert.ok(p.delta! < 0);
});

test("3. closing_ratio 有 baseline / delta，前半无收束意图后半有", () => {
  const p = byKind.closing_ratio;
  assert.equal(p.sufficient, true);
  assert.equal(p.baseline, 0);
  assert.ok(p.value! > 0);
  assert.ok(p.delta! > 0);
});

test("4. continuation_rate 有 baseline / delta", () => {
  const p = byKind.continuation_rate;
  assert.equal(p.sufficient, true);
  assert.ok(p.baseline !== null && p.value !== null);
  assert.equal(p.delta, Math.round((p.value - p.baseline!) * 100) / 100);
});

test("5. reply_latency 有 baseline / delta，后半回复更慢", () => {
  const p = byKind.reply_latency;
  assert.equal(p.sufficient, true);
  assert.ok(p.value! > p.baseline!, `后半延迟 ${p.value} 应大于前半 ${p.baseline}`);
  assert.ok(p.delta! > 0);
});

test("6. initiation_ratio 有 baseline / delta，前半对方主动过后半不再主动", () => {
  const p = byKind.initiation_ratio;
  assert.equal(p.sufficient, true);
  assert.ok(p.baseline! > 0, "前半有一轮由对方开启");
  assert.equal(p.value, 0, "后半两轮都由我方开启");
  assert.ok(p.delta! < 0);
});

test("6b. 所有核心指标都具备 baseline/delta 字段（样本足够时非 null）", () => {
  const core = [
    "initiation_ratio",
    "reply_latency",
    "reply_length",
    "question_density",
    "continuation_rate",
    "closing_ratio",
    "emotion_drift",
    "intent_drift",
    "event_volume",
  ];
  for (const kind of core) {
    const p = byKind[kind];
    assert.ok(p, `缺少指标 ${kind}`);
    assert.equal(p.sufficient, true, `${kind} 应当有足够样本`);
    assert.notEqual(p.baseline, null, `${kind} 缺少 baseline`);
    assert.notEqual(p.delta, null, `${kind} 缺少 delta`);
  }
  // 聚合指标保持聚合语义
  assert.equal(byKind.baseline_delta.baseline, null);
  assert.equal(byKind.baseline_delta.delta, null);
});

test("6c. 指标定义表覆盖 docs 里承诺的全部指标", () => {
  const kinds = METRIC_DEFINITIONS.map((m) => m.kind);
  assert.equal(kinds.length, 9);
  assert.deepEqual([...kinds].sort(), [
    "closing_ratio",
    "continuation_rate",
    "emotion_drift",
    "event_volume",
    "initiation_ratio",
    "intent_drift",
    "question_density",
    "reply_latency",
    "reply_length",
  ]);
});

// ---------------------------------------------------------------------------
// 7. counterpart-only：不被用户消息污染
// ---------------------------------------------------------------------------

test("7. 对方指标只统计对方消息，不受我方消息影响", () => {
  // 构造：我方疯狂提问、长回复；对方全部是简短陈述且从不提问
  const noisy: Message[] = [
    { id: "a1", sender: "other", text: "嗯", timestamp: "2026年09月05日 19:00", kind: "text" },
    { id: "a2", sender: "self", text: "你今天怎么样？吃了什么？去哪了？", timestamp: "2026年09月05日 19:01", kind: "text" },
    { id: "a3", sender: "other", text: "还行", timestamp: "2026年09月05日 19:10", kind: "text" },
    { id: "a4", sender: "self", text: "那明天呢？周末呢？有空吗？", timestamp: "2026年09月05日 19:11", kind: "text" },
    { id: "a5", sender: "other", text: "忙", timestamp: "2026年09月05日 19:20", kind: "text" },
    { id: "a6", sender: "self", text: "好吧好吧我知道了", timestamp: "2026年09月05日 19:21", kind: "text" },
    { id: "a7", sender: "other", text: "嗯", timestamp: "2026年09月05日 19:30", kind: "text" },
    { id: "a8", sender: "self", text: "那你先忙", timestamp: "2026年09月05日 19:31", kind: "text" },
  ];
  const p = computePatterns({ messages: noisy, observations: [] });
  const q = p.find((x) => x.kind === "question_density")!;
  assert.equal(q.value, 0, "对方从未提问，密度必须是 0（不受我方三连问影响）");
  assert.equal(q.baseline, 0);
});

test("7b. reply_length 只算对方消息字数", () => {
  const noisy: Message[] = [
    { id: "b1", sender: "other", text: "嗯", timestamp: "2026年09月05日 19:00", kind: "text" },
    { id: "b2", sender: "self", text: "这是一条非常非常长的我方消息用来测试污染".repeat(3), timestamp: "2026年09月05日 19:01", kind: "text" },
    { id: "b3", sender: "other", text: "好", timestamp: "2026年09月05日 19:10", kind: "text" },
    { id: "b4", sender: "self", text: "又是一条很长的消息".repeat(5), timestamp: "2026年09月05日 19:11", kind: "text" },
    { id: "b5", sender: "other", text: "嗯", timestamp: "2026年09月05日 19:20", kind: "text" },
    { id: "b6", sender: "self", text: "长长的我方消息".repeat(5), timestamp: "2026年09月05日 19:21", kind: "text" },
    { id: "b7", sender: "other", text: "好", timestamp: "2026年09月05日 19:30", kind: "text" },
    { id: "b8", sender: "self", text: "还是我方的话".repeat(5), timestamp: "2026年09月05日 19:31", kind: "text" },
  ];
  const p = computePatterns({ messages: noisy, observations: [] });
  const len = p.find((x) => x.kind === "reply_length")!;
  assert.ok(len.value! < 3, `对方平均字数应很小，实际 ${len.value}`);
});

// ---------------------------------------------------------------------------
// 8. 外部原因
// ---------------------------------------------------------------------------

test("8. 明确外部原因会被识别，并阻止把下降直接翻译成关系降温", () => {
  const injured: Message[] = [
    { id: "c1", sender: "other", text: "出来散步？", timestamp: "2026年09月01日 19:00", kind: "text" },
    { id: "c2", sender: "self", text: "行", timestamp: "2026年09月01日 19:02", kind: "text" },
    { id: "c3", sender: "other", text: "今天吃啥", timestamp: "2026年09月02日 19:00", kind: "text" },
    { id: "c4", sender: "self", text: "不知道", timestamp: "2026年09月02日 19:02", kind: "text" },
    { id: "c5", sender: "self", text: "晚上干嘛", timestamp: "2026年09月08日 19:00", kind: "text" },
    { id: "c6", sender: "other", text: "在家", timestamp: "2026年09月08日 19:30", kind: "text" },
    { id: "c7", sender: "self", text: "出来吃饭？", timestamp: "2026年09月08日 19:31", kind: "text" },
    { id: "c8", sender: "other", text: "算了，我脚还疼", timestamp: "2026年09月08日 20:00", kind: "text" },
    { id: "c9", sender: "self", text: "周末呢", timestamp: "2026年09月09日 19:00", kind: "text" },
    { id: "c10", sender: "other", text: "医生让我少走", timestamp: "2026年09月09日 20:00", kind: "text" },
  ];
  assert.ok(detectExternalCauses(injured).includes("injury"));

  const trend = computePatternTrend(computePatterns({ messages: injured, observations: [] }), injured);
  assert.equal(trend.externalCausePresent, true);
  assert.ok(trend.externalCauses.includes("injury"));

  // 下降 + 外部原因 -> 翻译层必须给出修正说明
  const analysis = deepAnalysisOutput.parse({
    status: "ok",
    summary: "最近几次邀约都被婉拒。",
    surfaceSignals: ["连续两次婉拒外出"],
    latentEmotion: { reading: "对方可能有点疲惫", basedOn: [], conflictsWith: [] },
    latentIntent: { reading: "对方可能只是不方便出门", basedOn: [], conflictsWith: [] },
    conversationState: { reading: "线下活动暂停", surfaceSignals: [] },
    trend: "cooling",
    turningPoint: null,
    alternativeInterpretations: [],
    evidence: [],
    contradiction: null,
    uncertainty: "high",
    nextAction: null,
  });
  const translation = buildTranslation(
    { ...analysis, model: "m", promptVersion: 1, latencyMs: 1, analyzedMessageIds: [] },
    trend,
  );
  const all = JSON.stringify(translation);
  assert.ok(all.includes("外部原因"), "必须说明存在外部原因");
  assert.ok(all.includes("受伤"), "必须点出具体原因");
  assert.ok(all.includes("不能据此判断关系变化"));
});

test("8b. 没有外部原因时不会凭空添加修正说明", () => {
  const trend = computePatternTrend(patterns, messages);
  assert.equal(trend.externalCausePresent, false);
  const analysis = deepAnalysisOutput.parse({
    status: "ok",
    summary: "互动变少。",
    surfaceSignals: [],
    latentEmotion: { reading: "可能有点累", basedOn: [], conflictsWith: [] },
    latentIntent: { reading: "可能在忙", basedOn: [], conflictsWith: [] },
    conversationState: { reading: "互动减少", surfaceSignals: [] },
    trend: "cooling",
    turningPoint: null,
    alternativeInterpretations: [],
    evidence: [],
    contradiction: null,
    uncertainty: "high",
    nextAction: null,
  });
  const translation = buildTranslation(
    { ...analysis, model: "m", promptVersion: 1, latencyMs: 1, analyzedMessageIds: [] },
    trend,
  );
  assert.equal(JSON.stringify(translation).includes("外部原因"), false);
});

test("8c. 趋势文案不把 cooling 说成关系变差", () => {
  assert.equal(trendLabel("cooling"), "互动投入下降");
  assert.equal(trendLabel("warming"), "互动投入上升");
  assert.equal(trendLabel("stable"), "互动基本稳定");
  assert.equal(trendLabel("uncertain"), "趋势不明确");
  for (const t of ["warming", "stable", "cooling", "uncertain"] as const)
    assert.equal(/关系|感情|喜欢/.test(trendLabel(t)), false);
});

// ---------------------------------------------------------------------------
// 9-11. PatternTrend
// ---------------------------------------------------------------------------

test("9. PatternTrend 完全确定性：同输入多次计算结果一致", () => {
  const a = computePatternTrend(computePatterns({ messages, observations }), messages);
  const b = computePatternTrend(computePatterns({ messages, observations }), messages);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // 打乱输入顺序（带时间戳会重新排序）结果仍然一致
  const shuffled = computePatternTrend(
    computePatterns({ messages: [...messages].reverse(), observations }),
    [...messages].reverse(),
  );
  assert.equal(shuffled.direction, a.direction);
  assert.deepEqual(shuffled.supportingMetrics, a.supportingMetrics);
});

test("9b. 互动下降时 trend 为 cooling，且给出支持/冲突指标", () => {
  const trend = computePatternTrend(patterns, messages);
  assert.equal(trend.direction, "cooling");
  assert.ok(trend.conflictingMetrics.length >= 2, "应有多个指标指向下降");
  assert.ok(["low", "medium", "high"].includes(trend.confidence));
  assert.ok(describePatternTrend(trend).includes("互动投入下降"));
  assert.ok(describePatternTrend(trend).includes("不能修改它的方向"));
});

test("9c. 指标互相矛盾时给出 uncertain 而不是硬下结论", () => {
  const conflicting = [
    { kind: "reply_length" as const, label: "", value: 20, baseline: 10, delta: 10, sampleSize: 4, sufficient: true },
    { kind: "question_density" as const, label: "", value: 0.6, baseline: 0.1, delta: 0.5, sampleSize: 4, sufficient: true },
    { kind: "reply_latency" as const, label: "", value: 60, baseline: 10, delta: 50, sampleSize: 4, sufficient: true },
    { kind: "closing_ratio" as const, label: "", value: 0.5, baseline: 0.1, delta: 0.4, sampleSize: 4, sufficient: true },
  ];
  const trend = computePatternTrend(conflicting, []);
  assert.equal(trend.direction, "uncertain");
  assert.ok(trend.supportingMetrics.length >= 2);
  assert.ok(trend.conflictingMetrics.length >= 2);
});

test("10. DeepSeek 不能覆盖程序算出的 trend", async () => {
  // 模型硬说 warming，但程序算出来是 cooling
  const modelSaysWarming = {
    status: "ok",
    summary: "互动变少。",
    surfaceSignals: [],
    latentEmotion: { reading: "可能有点累", basedOn: [], conflictsWith: [] },
    latentIntent: { reading: "可能在忙", basedOn: [], conflictsWith: [] },
    conversationState: { reading: "互动减少", surfaceSignals: [] },
    trend: "warming",
    turningPoint: null,
    alternativeInterpretations: [],
    evidence: [],
    contradiction: null,
    uncertainty: "high",
    nextAction: null,
  };
  const request = buildProviderInput({
    revision: 1,
    relation: "new",
    targetId: null,
    messages,
    observations,
    memory: [],
    patterns: [],
  });
  assert.equal(request.patternTrend?.direction, "cooling");

  const provider = createDeepSeekProvider(
    {
      enabled: true,
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
      timeoutMs: 1000,
    },
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output: [
              { type: "message", content: [{ type: "output_text", text: JSON.stringify(modelSaysWarming) }] },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
      }),
    },
  );
  const outcome = await provider.interpret(request);
  assert.equal(outcome.analysis.trend, "cooling", "必须以程序趋势为准");
});

// ---------------------------------------------------------------------------
// 11-12. RelationshipContext
// ---------------------------------------------------------------------------

test("11. friend 与 crush 的关系语境产生不同的 prompt input", () => {
  const base: DeepAnalysisRequest = {
    revision: 1,
    relation: "new",
    targetId: null,
    messages,
    observations,
    memory: [],
    patterns: [],
  };
  const asFriend = buildPayload(
    buildProviderInput({
      ...base,
      relationshipContext: {
        type: "friend",
        closeness: "high",
        contactFrequency: "several_per_week",
        usualTone: ["互相打趣"],
        knownPatterns: ["一直回复较慢"],
        recentContext: ["对方在赶项目"],
        sourceType: "user_provided",
      },
    }),
  );
  const asCrush = buildPayload(
    buildProviderInput({
      ...base,
      relationshipContext: {
        type: "crush",
        closeness: "medium",
        contactFrequency: "daily",
        usualTone: [],
        knownPatterns: [],
        recentContext: [],
        sourceType: "user_provided",
      },
    }),
  );
  assert.notEqual(
    JSON.stringify(asFriend.relationshipContext),
    JSON.stringify(asCrush.relationshipContext),
  );
  assert.equal((asFriend.relationshipContext as { type: string }).type, "friend");
  assert.equal((asCrush.relationshipContext as { type: string }).type, "crush");
  // 关系语境不同，但证据完全相同 —— 语境不能动证据
  assert.deepEqual(asFriend.messages, asCrush.messages);
  assert.deepEqual(asFriend.observations, asCrush.observations);
  assert.deepEqual(asFriend.patterns, asCrush.patterns);
});

test("11b. 不提供 relationshipContext 时由 relation 推导，旧请求保持兼容", () => {
  assert.equal(contextFromRelation("crush").type, "crush");
  assert.equal(contextFromRelation("new").type, "new");
  assert.equal(contextFromRelation("couple").type, "dating");

  const legacy = buildProviderInput({
    revision: 1,
    relation: "crush",
    targetId: null,
    messages,
    observations,
    memory: [],
    patterns: [],
  });
  assert.equal(legacy.relationshipContext?.type, "crush");
  assert.equal(legacy.relationshipContext?.sourceType, "user_provided");
});

test("11c. 关系语境里禁止出现结论性断言", () => {
  const context = contextFromRelation("crush");
  const text = JSON.stringify(context);
  // 语境只是先验背景，不该带「对方喜欢我」这类判断
  assert.equal(/喜欢|爱你|好感|确定/.test(text), false);
});

// ---------------------------------------------------------------------------
// 13. violationCodes 响应组装
// ---------------------------------------------------------------------------

test("13. violationCodes 会写进 analysis.boundary（客户端可读）", async () => {
  const bad = {
    status: "ok",
    summary: "她属于回避型依恋", // personality_diagnosis
    surfaceSignals: [],
    latentEmotion: { reading: "可能有点累", basedOn: [], conflictsWith: [] },
    latentIntent: { reading: "可能在忙", basedOn: [], conflictsWith: [] },
    conversationState: { reading: "互动减少", surfaceSignals: [] },
    trend: "uncertain",
    turningPoint: null,
    alternativeInterpretations: [],
    evidence: [],
    contradiction: null,
    uncertainty: "high",
    nextAction: null,
  };
  const good = { ...bad, summary: "对方回复变短。" };
  let call = 0;
  const provider = createDeepSeekProvider(
    {
      enabled: true,
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
      timeoutMs: 1000,
    },
    {
      fetch: async () => {
        const output = call++ === 0 ? bad : good;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              output: [
                { type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        };
      },
    },
  );
  const request = buildProviderInput({
    revision: 1,
    relation: "new",
    targetId: null,
    messages,
    observations,
    memory: [],
    patterns: [],
  });
  const outcome = await provider.interpret(request);
  assert.equal(outcome.boundary.retried, true);
  // 关键：客户端读到的位置是 analysis.boundary
  assert.deepEqual(outcome.analysis.boundary?.violationCodes, [
    "personality_diagnosis",
  ]);
  assert.deepEqual(outcome.boundary.violationCodes, ["personality_diagnosis"]);
});

test("13b. 干净输出时 violationCodes 是空数组而不是 undefined", async () => {
  const clean = {
    status: "ok",
    summary: "对方回复变短。",
    surfaceSignals: [],
    latentEmotion: { reading: "可能有点累", basedOn: [], conflictsWith: [] },
    latentIntent: { reading: "可能在忙", basedOn: [], conflictsWith: [] },
    conversationState: { reading: "互动减少", surfaceSignals: [] },
    trend: "uncertain",
    turningPoint: null,
    alternativeInterpretations: [],
    evidence: [],
    contradiction: null,
    uncertainty: "high",
    nextAction: null,
  };
  const provider = createDeepSeekProvider(
    {
      enabled: true,
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
      timeoutMs: 1000,
    },
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output: [
              { type: "message", content: [{ type: "output_text", text: JSON.stringify(clean) }] },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
      }),
    },
  );
  const outcome = await provider.interpret(
    buildProviderInput({
      revision: 1,
      relation: "new",
      targetId: null,
      messages,
      observations,
      memory: [],
      patterns: [],
    }),
  );
  assert.deepEqual(outcome.analysis.boundary?.violationCodes, []);
});

// ---------------------------------------------------------------------------
// 14. 其它回归
// ---------------------------------------------------------------------------

test("14. 指标定义都有唯一 kind，且方向与量纲已标注", () => {
  const kinds = METRIC_DEFINITIONS.map((m) => m.kind);
  assert.equal(new Set(kinds).size, kinds.length);
  for (const spec of METRIC_DEFINITIONS) {
    assert.ok([1, -1].includes(spec.orientation), `${spec.kind} 缺少方向`);
    assert.ok(["absolute", "relative"].includes(spec.scale));
    assert.ok(spec.label.length > 0);
  }
  // 延迟与收束是反向指标：越大越说明投入下降
  assert.equal(METRIC_DEFINITIONS.find((m) => m.kind === "reply_latency")?.orientation, -1);
  assert.equal(METRIC_DEFINITIONS.find((m) => m.kind === "closing_ratio")?.orientation, -1);
});
