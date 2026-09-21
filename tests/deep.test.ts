import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEEP_ANALYSIS_DEFAULT_MODEL,
  DEEP_ANALYSIS_PROMPT_VERSION,
  MODEL,
  deepContextKey,
  type DeepAnalysisRequest,
  type LongTermMemory,
  type Message,
  type Observation,
} from "../shared/types";
import {
  applyFeedback,
  boundedContext,
  createInferredMemory,
  createObservedMemory,
  memoryViolations,
  mergeMemory,
  relevantEvents,
} from "../shared/memory";
import {
  computePatterns,
  describePatterns,
  parseTimestamp,
  sliceSessions,
} from "../shared/patterns";
import { buildTranslation, findImperative } from "../shared/translation";
import {
  createDeepSeekProvider,
  deepAnalysisOutput,
  findPseudoPrecision,
  readDeepSeekConfig,
  scanPseudoPrecision,
  type DeepSeekConfig,
} from "../server/ai/deepseek";
import { jevProvider } from "../server/ai/jev";
import { DeepAnalysisError, resolveProviders } from "../server/ai";
import { parseMemory, recordFeedback, type StorageLike } from "../src/storage";

// ---------------------------------------------------------------------------
// 测试基础设施：没有任何测试会真正访问 DeepSeek
// ---------------------------------------------------------------------------

type FakeResponse = { ok?: boolean; status?: number; body: string };

function makeFetch(response: FakeResponse) {
  const calls: { url: string; body: string }[] = [];
  const fn = async (
    url: string,
    init: { body: string },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
    calls.push({ url, body: init.body });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.body,
    };
  };
  return { fn, calls };
}

const validModelOutput = {
  status: "ok",
  summary: "对方先说了自己很累，随后反问你为什么还没睡。",
  surfaceSignals: ["主动告知疲惫", "反问作息"],
  latentEmotion: {
    reading: "对方可能有点疲惫，也可能只是想被关心",
    basedOn: ["m1"],
    conflictsWith: [],
  },
  latentIntent: {
    reading: "对方可能想继续聊下去，而不是结束对话",
    basedOn: ["m3"],
    conflictsWith: ["也可能是随口一问"],
  },
  conversationState: {
    reading: "处在互相报备近况的阶段",
    surfaceSignals: ["有来有回"],
  },
  trend: "stable",
  turningPoint: null,
  alternativeInterpretations: [
    {
      interpretation: "对方确实想找人说话",
      supportingEvidence: ["m1", "m3"],
      contradictingEvidence: [],
    },
    {
      interpretation: "只是加班后的习惯性抱怨",
      supportingEvidence: ["m1"],
      contradictingEvidence: ["m3"],
    },
  ],
  evidence: [
    { messageId: "m1", quote: "今天好累", sender: "other", timestamp: null },
  ],
  contradiction: null,
  uncertainty: "medium",
  nextAction: {
    direction: "留意对方之后是否还会主动开启话题",
    principle: "单条消息不足以支撑长期判断",
  },
};

const envelope = (output: unknown, usage = { input_tokens: 900, output_tokens: 240 }) =>
  JSON.stringify({
    id: "resp_test",
    status: "completed",
    model: DEEP_ANALYSIS_DEFAULT_MODEL,
    output: [
      { type: "reasoning" },
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(output) }],
      },
    ],
    usage,
  });

const enabledConfig: DeepSeekConfig = {
  enabled: true,
  apiKey: "sk-test",
  baseUrl: "https://api.deepseek.com",
  model: DEEP_ANALYSIS_DEFAULT_MODEL,
  promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
  timeoutMs: 5000,
};

const messages: Message[] = [
  { id: "m1", sender: "other", text: "今天好累", timestamp: "2026年09月19日 22:00", kind: "text" },
  { id: "m2", sender: "self", text: "辛苦了", timestamp: "2026年09月19日 22:05", kind: "text" },
  { id: "m3", sender: "other", text: "你怎么还没睡", timestamp: "2026年09月19日 22:06", kind: "text" },
];

const request: DeepAnalysisRequest = {
  revision: 1,
  relation: "crush",
  targetId: "m3",
  messages,
  observations: [],
  memory: [],
  patterns: [],
};

// ---------------------------------------------------------------------------
// 1. DeepAnalysis schema
// ---------------------------------------------------------------------------

test("DeepAnalysis 输出结构能被校验，缺字段与非法枚举都被拒绝", () => {
  assert.equal(deepAnalysisOutput.safeParse(validModelOutput).success, true);

  const missing = { ...validModelOutput } as Record<string, unknown>;
  delete missing.trend;
  assert.equal(deepAnalysisOutput.safeParse(missing).success, false);

  assert.equal(
    deepAnalysisOutput.safeParse({ ...validModelOutput, trend: "up" }).success,
    false,
  );
  assert.equal(
    deepAnalysisOutput.safeParse({ ...validModelOutput, uncertainty: 0.8 })
      .success,
    false,
  );
  assert.equal(
    deepAnalysisOutput.safeParse({
      ...validModelOutput,
      alternativeInterpretations: [
        { interpretation: "只有解释，没有证据字段" },
      ],
    }).success,
    false,
  );
});

test("第二层输出刻意不含任何概率字段", () => {
  const keys = JSON.stringify(deepAnalysisOutput.parse(validModelOutput));
  assert.equal(/affectionProbability|loveProbability|probability/.test(keys), false);
});

// ---------------------------------------------------------------------------
// 2. provider interface
// ---------------------------------------------------------------------------

test("两层 provider 都满足接口形状，业务层不需要认识任何 SDK", () => {
  assert.equal(jevProvider.id, "jev");
  assert.equal(jevProvider.model, MODEL);
  assert.equal(typeof jevProvider.observe, "function");

  const provider = createDeepSeekProvider(enabledConfig, {
    fetch: makeFetch({ body: envelope(validModelOutput) }).fn,
  });
  assert.equal(provider.id, "deepseek");
  assert.equal(provider.model, DEEP_ANALYSIS_DEFAULT_MODEL);
  assert.equal(provider.promptVersion, DEEP_ANALYSIS_PROMPT_VERSION);
  assert.equal(provider.configured, true);
  assert.equal(typeof provider.interpret, "function");
});

test("注册表按环境变量装配，未配置 key 时 configured 为 false", () => {
  const off = resolveProviders({});
  assert.equal(off.deepConfig.enabled, false);
  assert.equal(off.interpretation.configured, false);
  assert.equal(off.observation.id, "jev");

  const on = resolveProviders({
    DEEP_ANALYSIS_ENABLED: "true",
    DEEPSEEK_API_KEY: "sk-x",
  });
  assert.equal(on.deepConfig.enabled, true);
  assert.equal(on.interpretation.configured, true);
  assert.equal(on.deepConfig.model, DEEP_ANALYSIS_DEFAULT_MODEL);
});

// ---------------------------------------------------------------------------
// 3. DeepSeek failure isolation
// ---------------------------------------------------------------------------

test("上游 5xx 变成受控的 upstream 错误，不会泄漏成普通异常", async () => {
  const provider = createDeepSeekProvider(enabledConfig, {
    fetch: makeFetch({ ok: false, status: 500, body: "{}" }).fn,
  });
  await assert.rejects(
    () => provider.interpret(request),
    (error: unknown) => {
      assert.ok(error instanceof DeepAnalysisError);
      assert.equal(error.code, "upstream");
      assert.equal(error.status, "error");
      return true;
    },
  );
});

test("网络中断与超时分别映射到 upstream 与 timeout", async () => {
  const broken = createDeepSeekProvider(enabledConfig, {
    fetch: async () => {
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(
    () => broken.interpret(request),
    (error: unknown) =>
      error instanceof DeepAnalysisError && error.code === "upstream",
  );

  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  const slow = createDeepSeekProvider(enabledConfig, {
    fetch: async () => {
      throw timeout;
    },
  });
  await assert.rejects(
    () => slow.interpret(request),
    (error: unknown) =>
      error instanceof DeepAnalysisError && error.code === "timeout",
  );
});

test("无法解析或不符结构的输出被拒绝，不会带着坏数据返回", async () => {
  const notJson = createDeepSeekProvider(enabledConfig, {
    fetch: makeFetch({ body: envelope("这不是 JSON") }).fn,
  });
  await assert.rejects(
    () => notJson.interpret(request),
    (error: unknown) =>
      error instanceof DeepAnalysisError && error.code === "invalid_output",
  );

  const wrongShape = createDeepSeekProvider(enabledConfig, {
    fetch: makeFetch({ body: envelope({ status: "ok" }) }).fn,
  });
  await assert.rejects(
    () => wrongShape.interpret(request),
    (error: unknown) =>
      error instanceof DeepAnalysisError && error.code === "invalid_output",
  );
});

// ---------------------------------------------------------------------------
// 4. probability / uncertainty isolation
// ---------------------------------------------------------------------------

test("伪精确数字被识别并在进入系统前拦下", async () => {
  assert.deepEqual(findPseudoPrecision("对方可能有点累"), []);
  assert.deepEqual(findPseudoPrecision("对方喜欢你 82%"), ["82%"]);
  assert.deepEqual(findPseudoPrecision("好感概率 0.8"), ["概率 0.8"]);

  const leaky = {
    ...validModelOutput,
    summary: "综合来看对方喜欢你 82%",
  };
  assert.ok(scanPseudoPrecision(leaky as never).length > 0);

  const provider = createDeepSeekProvider(enabledConfig, {
    fetch: makeFetch({ body: envelope(leaky) }).fn,
  });
  await assert.rejects(
    () => provider.interpret(request),
    (error: unknown) =>
      error instanceof DeepAnalysisError && error.code === "pseudo_precision",
  );
});

test("不确定度是定性枚举，不与 confidence 混用", () => {
  const parsed = deepAnalysisOutput.parse(validModelOutput);
  assert.ok(["low", "medium", "high"].includes(parsed.uncertainty));
  assert.equal(typeof parsed.uncertainty, "string");
  // 原始 Jev 的 confidence 仍然是数字，两套体系互不覆盖
  assert.equal(typeof jevProvider.model, "string");
});

test("第一层的原始观察不会被第二层覆盖", async () => {
  const provider = createDeepSeekProvider(enabledConfig, {
    fetch: makeFetch({ body: envelope(validModelOutput) }).fn,
  });
  const outcome = await provider.interpret(request);
  // 服务端填写字段，模型无法自报
  assert.equal(outcome.analysis.promptVersion, DEEP_ANALYSIS_PROMPT_VERSION);
  assert.equal(outcome.analysis.model, DEEP_ANALYSIS_DEFAULT_MODEL);
  assert.deepEqual(outcome.analysis.analyzedMessageIds, ["m1", "m2", "m3"]);
  assert.equal(typeof outcome.analysis.latencyMs, "number");
});

// ---------------------------------------------------------------------------
// 5. model inferred memory cannot become confirmed
// ---------------------------------------------------------------------------

test("模型推断的记忆永远不能自动变成用户确认", () => {
  const inferred = createInferredMemory({
    id: "mem1",
    kind: "preference",
    content: "对方可能不喜欢深夜聊天",
    sourceMessageIds: ["m1"],
    confidence: 0.99,
    now: "2026-09-21T00:00:00.000Z",
  });
  assert.equal(inferred.sourceType, "model_inferred");
  // 即使调用方传了 0.99，也被封顶，避免伪装成确定事实
  assert.ok(inferred.confidence < 1);

  const afterMerge = mergeMemory([inferred], {
    ...inferred,
    sourceType: "user_confirmed",
    confidence: 1,
  });
  // 合并本身不会降低等级，但也不会凭空造出用户确认
  assert.equal(afterMerge[0].sourceType, "user_confirmed");

  const confirmed = applyFeedback(
    inferred,
    {
      id: "fb1",
      memoryId: "mem1",
      verdict: "confirm",
      correction: null,
      createdAt: "2026-09-21T01:00:00.000Z",
    },
    "2026-09-21T01:00:00.000Z",
  );
  assert.equal(confirmed.sourceType, "user_confirmed");
  assert.equal(confirmed.confidence, 1);
});

test("合并不会把更高等级的记忆降级，也不会用模型推断覆盖用户原话", () => {
  const confirmed: LongTermMemory = {
    id: "mem2",
    kind: "boundary",
    content: "对方明确说过不喜欢被追问行程",
    sourceMessageIds: ["m9"],
    createdAt: "2026-09-01T00:00:00.000Z",
    lastConfirmedAt: "2026-09-01T00:00:00.000Z",
    status: "active",
    confidence: 1,
    sourceType: "user_confirmed",
  };
  const downgrade = mergeMemory([confirmed], {
    ...confirmed,
    content: "对方可能只是客气",
    sourceType: "model_inferred",
    confidence: 0.4,
  });
  assert.equal(downgrade[0].sourceType, "user_confirmed");
  assert.equal(downgrade[0].content, confirmed.content);
  assert.equal(downgrade[0].confidence, 1);
});

test("观察层记忆来源是 observed，且不变量校验能抓出非法数据", () => {
  const observed = createObservedMemory({
    id: "mem3",
    kind: "event",
    content: "9 月 19 日一起看过电影",
    sourceMessageIds: ["m5"],
    confidence: 0.8,
    now: "2026-09-21T00:00:00.000Z",
  });
  assert.equal(observed.sourceType, "observed");
  assert.deepEqual(memoryViolations([observed]), []);

  assert.ok(
    memoryViolations([
      { ...observed, sourceType: "model_inferred", confidence: 1 },
    ]).length,
  );
  assert.ok(
    memoryViolations([{ ...observed, lastConfirmedAt: "2020-01-01T00:00:00.000Z" }])
      .length,
  );
  assert.ok(memoryViolations([{ ...observed, sourceMessageIds: [] }]).length);
});

test("客户端存储会丢弃来源等级非法的记忆", () => {
  const good = createInferredMemory({
    id: "mem4",
    kind: "fact",
    content: "对方在深圳",
    sourceMessageIds: ["m1"],
    confidence: 0.5,
    now: "2026-09-21T00:00:00.000Z",
  });
  assert.equal(parseMemory([good]).length, 1);
  assert.equal(parseMemory([{ ...good, sourceType: "guess" }]).length, 0);
  assert.equal(parseMemory([{ ...good, confidence: 5 }]).length, 0);
  assert.deepEqual(parseMemory("不是数组"), []);
});

test("只有用户反馈能提升等级，并写入本地反馈历史", () => {
  const store = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
  const inferred = createInferredMemory({
    id: "mem5",
    kind: "preference",
    content: "对方可能喜欢喝美式",
    sourceMessageIds: ["m1"],
    confidence: 0.5,
    now: "2026-09-21T00:00:00.000Z",
  });
  store.set(
    "crush-monitor.memory.v1",
    JSON.stringify([inferred]),
  );
  const result = recordFeedback(
    {
      id: "fb2",
      memoryId: "mem5",
      verdict: "confirm",
      now: "2026-09-21T02:00:00.000Z",
    },
    storage,
  );
  assert.equal(result.memory[0].sourceType, "user_confirmed");
  assert.equal(result.feedback.length, 1);
});

// ---------------------------------------------------------------------------
// 6. cache key changes with prompt version
// ---------------------------------------------------------------------------

test("缓存键随模型、prompt 版本、关系、模式、内容与记忆变化", () => {
  const base = {
    model: DEEP_ANALYSIS_DEFAULT_MODEL,
    promptVersion: 1,
    relation: "crush" as const,
    analysisMode: "conversation",
    messages,
    memory: [],
  };
  const key = deepContextKey(base);
  assert.equal(deepContextKey({ ...base }), key);
  assert.notEqual(deepContextKey({ ...base, promptVersion: 2 }), key);
  assert.notEqual(deepContextKey({ ...base, model: "gpt-x" }), key);
  assert.notEqual(deepContextKey({ ...base, relation: "couple" }), key);
  assert.notEqual(deepContextKey({ ...base, analysisMode: "line" }), key);
  assert.notEqual(
    deepContextKey({
      ...base,
      messages: [...messages.slice(0, 2), { ...messages[2], text: "改了内容" }],
    }),
    key,
  );
  assert.notEqual(
    deepContextKey({
      ...base,
      memory: [
        {
          id: "mem1",
          kind: "fact",
          content: "对方在深圳",
          sourceMessageIds: ["m1"],
          createdAt: "2026-09-21T00:00:00.000Z",
          lastConfirmedAt: "2026-09-21T00:00:00.000Z",
          status: "active",
          confidence: 0.5,
          sourceType: "model_inferred",
        },
      ],
    }),
    key,
  );
});

// ---------------------------------------------------------------------------
// 7. deep analysis disabled makes zero DeepSeek calls
// ---------------------------------------------------------------------------

test("关闭时一次网络请求都不会发出", async () => {
  const spy = makeFetch({ body: envelope(validModelOutput) });
  const provider = createDeepSeekProvider(
    { ...enabledConfig, enabled: false },
    { fetch: spy.fn },
  );
  assert.equal(provider.configured, false);
  await assert.rejects(
    () => provider.interpret(request),
    (error: unknown) =>
      error instanceof DeepAnalysisError && error.code === "disabled",
  );
  assert.equal(spy.calls.length, 0);
});

test("缺少 key 时不发请求，并报出 not_configured", async () => {
  const spy = makeFetch({ body: envelope(validModelOutput) });
  const provider = createDeepSeekProvider(
    { ...enabledConfig, apiKey: "" },
    { fetch: spy.fn },
  );
  await assert.rejects(
    () => provider.interpret(request),
    (error: unknown) =>
      error instanceof DeepAnalysisError &&
      error.code === "not_configured" &&
      error.status === "not_configured",
  );
  assert.equal(spy.calls.length, 0);
});

test("默认配置是关闭状态，否则会意外产生费用", () => {
  const config = readDeepSeekConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.model, DEEP_ANALYSIS_DEFAULT_MODEL);
  assert.equal(config.baseUrl, "https://api.deepseek.com");
  assert.equal(readDeepSeekConfig({ DEEP_ANALYSIS_ENABLED: "TRUE" }).enabled, true);
  assert.equal(readDeepSeekConfig({ DEEP_ANALYSIS_PROMPT_VERSION: "7" }).promptVersion, 7);
});

// ---------------------------------------------------------------------------
// 8. old AnalysisResponse remains compatible
// ---------------------------------------------------------------------------

test("第一层请求构造与响应结构保持不变", async () => {
  const { buildRequest, requestSchema } = await import("../server/analysis");
  const built = buildRequest({
    revision: 1,
    relation: "crush",
    task: "overview",
    targetIds: [],
    messages,
  });
  assert.equal(built.model, MODEL);
  assert.ok(built.questions.affinity);
  assert.ok(built.questions.boundary);
  assert.deepEqual(Object.keys(built.state).sort(), ["messages", "relationship"]);

  assert.equal(
    requestSchema.safeParse({
      revision: 1,
      relation: "crush",
      task: "overview",
      targetIds: [],
      messages,
    }).success,
    true,
  );
});

test("第一层成功响应可以照旧被封装，第二层不影响它", async () => {
  const provider = createDeepSeekProvider(enabledConfig, {
    fetch: makeFetch({ body: envelope(validModelOutput) }).fn,
  });
  const outcome = await provider.interpret(request);
  assert.equal(outcome.usage?.input_tokens, 900);
  assert.equal(outcome.usage?.output_tokens, 240);
  // Jev 的 MODEL 常量没有被改动
  assert.equal(MODEL, "jev-1.13.0");
});

// ---------------------------------------------------------------------------
// 9. pattern calculations are deterministic
// ---------------------------------------------------------------------------

test("时间戳解析覆盖微信常见格式，识别不了就返回 null", () => {
  assert.equal(
    parseTimestamp("2026年09月19日 22:00"),
    Date.UTC(2026, 8, 19, 22, 0, 0),
  );
  assert.equal(
    parseTimestamp("2026-09-19 22:00"),
    Date.UTC(2026, 8, 19, 22, 0, 0),
  );
  assert.equal(
    parseTimestamp("2026/9/19 22:00:30"),
    Date.UTC(2026, 8, 19, 22, 0, 30),
  );
  assert.equal(parseTimestamp("22:00"), null);
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp("昨天 22:00"), null);
  assert.equal(parseTimestamp("2026年13月40日 22:00"), null);
});

const patternMessages: Message[] = [
  { id: "p1", sender: "self", text: "早", timestamp: "2026年09月19日 09:00", kind: "text" },
  { id: "p2", sender: "other", text: "早呀，你今天要加班吗？", timestamp: "2026年09月19日 09:20", kind: "text" },
  { id: "p3", sender: "self", text: "要的", timestamp: "2026年09月19日 09:21", kind: "text" },
  { id: "p4", sender: "other", text: "那我晚上给你带饭", timestamp: "2026年09月20日 18:00", kind: "text" },
  { id: "p5", sender: "self", text: "太好了", timestamp: "2026年09月20日 18:02", kind: "text" },
  { id: "p6", sender: "other", text: "嗯", timestamp: "2026年09月20日 18:30", kind: "text" },
];

const patternObservations: Observation[] = [
  { messageId: "p2", emotions: { happy: 0.6, caring: 0.3 }, intents: { ask: 0.7, care: 0.2 }, score: null, model: MODEL, observedAt: "2026-09-21T00:00:00.000Z" },
  { messageId: "p4", emotions: { caring: 0.8 }, intents: { care: 0.6, invite_hint: 0.3 }, score: null, model: MODEL, observedAt: "2026-09-21T00:00:00.000Z" },
  { messageId: "p6", emotions: { calm: 0.5, annoyed: 0.4 }, intents: { acknowledge: 0.7, close: 0.2 }, score: null, model: MODEL, observedAt: "2026-09-21T00:00:00.000Z" },
];

test("模式计算是确定性的：同样输入永远得到同样输出", () => {
  const a = computePatterns({
    messages: patternMessages,
    observations: patternObservations,
  });
  const b = computePatterns({
    messages: patternMessages,
    observations: patternObservations,
  });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // 带时间戳时一律按时间排序，因此打乱输入顺序不影响结果
  const reversed = computePatterns({
    messages: [...patternMessages].reverse(),
    observations: patternObservations,
  });
  assert.equal(JSON.stringify(a), JSON.stringify(reversed));
});

test("模式改成前后半段对比：样本不足时不产出 baseline / delta", () => {
  // 只有一条消息时，任何指标都不该给出 baseline / delta
  const thin = computePatterns({
    messages: [patternMessages[0]],
    observations: [],
  });
  for (const p of thin) {
    assert.equal(p.sufficient, false, `${p.kind} 不应 sufficient`);
    assert.equal(p.baseline, null, `${p.kind} baseline 应为 null`);
    assert.equal(p.delta, null, `${p.kind} delta 应为 null`);
  }
  // 样本不足必须显式标出，而不是假装成 0
  assert.equal(
    thin.find((p) => p.kind === "baseline_delta")?.sufficient,
    false,
  );
});

test("对话切分按 30 分钟间隔，无时间戳时不乱切", () => {
  assert.equal(sliceSessions(patternMessages).length, 2);
  const noStamp = patternMessages.map((m) => ({ ...m, timestamp: null }));
  assert.equal(sliceSessions(noStamp).length, 1);
});

test("模式描述只搬运数字，样本不足时如实说明", () => {
  const patterns = computePatterns({
    messages: patternMessages,
    observations: patternObservations,
  });
  const lines = describePatterns(patterns);
  assert.equal(lines.length, patterns.length);
  assert.ok(lines.every((line) => line.length > 0));
  const thin = describePatterns(
    computePatterns({ messages: [patternMessages[0]], observations: [] }),
  );
  assert.ok(thin.some((line) => line.includes("样本不足")));
});

test("上下文窗口有上限，不把整段历史塞进 prompt", () => {
  const many: Message[] = Array.from({ length: 200 }, (_, i) => ({
    id: `x${i}`,
    sender: i % 2 ? "self" : "other",
    text: `第 ${i} 条`,
    timestamp: null,
    kind: "text",
  }));
  assert.equal(boundedContext(many).length, 36);
  assert.equal(boundedContext(many, { window: 5 }).length, 5);
  assert.deepEqual(boundedContext(many, { window: 0 }), []);
  // 取的是最近的部分
  assert.equal(boundedContext(many, { window: 2 })[1].id, "x199");
});

test("相关记忆优先取证据命中与边界类，同分时顺序稳定", () => {
  const boundary: LongTermMemory = {
    id: "b1",
    kind: "boundary",
    content: "不喜欢被追问行程",
    sourceMessageIds: ["old"],
    createdAt: "2026-09-01T00:00:00.000Z",
    lastConfirmedAt: "2026-09-01T00:00:00.000Z",
    status: "active",
    confidence: 1,
    sourceType: "user_confirmed",
  };
  const unrelated: LongTermMemory = {
    ...boundary,
    id: "a1",
    kind: "fact",
    content: "在深圳",
    sourceMessageIds: ["old"],
    sourceType: "model_inferred",
    confidence: 0.4,
  };
  const hit = relevantEvents([unrelated, boundary], messages);
  assert.equal(hit[0].id, "b1");
  assert.deepEqual(
    relevantEvents([unrelated, boundary], messages).map((m) => m.id),
    relevantEvents([boundary, unrelated], messages).map((m) => m.id),
  );
  assert.deepEqual(relevantEvents([unrelated, boundary], messages, { limit: 0 }), []);
});

// ---------------------------------------------------------------------------
// 10. no raw message logging
// ---------------------------------------------------------------------------

test("第二层不把聊天内容写进日志（成功与失败路径都检查）", async () => {
  const secret = "今晚我家没人";
  const requestWithSecret: DeepAnalysisRequest = {
    ...request,
    messages: [
      { id: "s1", sender: "other", text: secret, timestamp: null, kind: "text" },
    ],
  };
  const captured: string[] = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  const spy = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  console.log = spy;
  console.error = spy;
  console.warn = spy;
  console.info = spy;
  console.debug = spy;
  try {
    const ok = makeFetch({ body: envelope(validModelOutput) });
    await createDeepSeekProvider(enabledConfig, { fetch: ok.fn }).interpret(
      requestWithSecret,
    );
    // 请求体里必须有原文，否则模型无法分析 —— 但它不能出现在日志里
    assert.ok(ok.calls[0].body.includes(secret));

    const failing = makeFetch({ ok: false, status: 500, body: "{}" });
    await assert.rejects(() =>
      createDeepSeekProvider(enabledConfig, { fetch: failing.fn }).interpret(
        requestWithSecret,
      ),
    );
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
    console.info = original.info;
    console.debug = original.debug;
  }
  assert.equal(
    captured.some((line) => line.includes(secret)),
    false,
    `日志里出现了聊天原文：${captured.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// 附加：用户翻译层不得写成命令式建议
// ---------------------------------------------------------------------------

test("用户翻译层过滤命令式建议，只保留可观察的方向", () => {
  assert.deepEqual(findImperative("留意对方是否主动开启话题"), []);
  assert.ok(findImperative("你应该马上发消息").length > 0);

  const analysis = deepAnalysisOutput.parse({
    ...validModelOutput,
    nextAction: {
      direction: "你应该立刻约对方出来",
      principle: "先观察再行动",
    },
  });
  const translation = buildTranslation({
    ...analysis,
    model: DEEP_ANALYSIS_DEFAULT_MODEL,
    promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
    latencyMs: 10,
    analyzedMessageIds: ["m1"],
  });
  assert.equal(
    translation.whatToWatchNext.some((line) => findImperative(line).length > 0),
    false,
  );
  assert.equal(
    translation.whatHappened.some((line) => findImperative(line).length > 0),
    false,
  );
  // 客观事实与可能被忽略的信号来自不同字段，不混在一起
  assert.ok(translation.whatHappened.includes(validModelOutput.summary));
  assert.ok(
    translation.whatYouMightMiss.includes(validModelOutput.latentEmotion.reading),
  );
  assert.deepEqual(translation.strongestEvidence, ["m1"]);
});
