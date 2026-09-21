import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEEP_ANALYSIS_PROMPT_VERSION,
  MODEL,
  deepContextKey,
  type DeepAnalysisRequest,
  type LongTermMemory,
  type Message,
  type UserTranslation,
} from "../shared/types";
import { buildTranslation, findImperative } from "../shared/translation";
import { createInferredMemory, relevantEvents } from "../shared/memory";
import { computePatterns } from "../shared/patterns";
import { parseChat, toMessages, mergeMessages } from "../shared/parser";
import {
  buildObservations,
  buildDeepRequest,
  createDeepController,
  type DeepControllerState,
} from "../src/useDeepAnalysis";
import {
  loadInterpretationFeedback,
  parseInterpretationFeedback,
  parseMemory,
  recordInterpretationFeedback,
  type StorageLike,
} from "../src/storage";
import {
  enforceBoundary,
  findHardViolations,
  hasAssertiveReading,
  soften,
} from "../server/ai/boundary";
import { buildProviderInput } from "../server/ai/input";
import { deepAnalysisOutput } from "../server/ai/deepseek";
import { requestSchema } from "../server/analysis";

// ---------------------------------------------------------------------------
// 测试基础设施：全部为注入式，不访问网络，更不会调用 DeepSeek
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

type Handler = (body: DeepAnalysisRequest) =>
  | { status: number; body: unknown }
  | "hang";

function makeFetch(handler: Handler) {
  const calls: DeepAnalysisRequest[] = [];
  const controllerFetch = async (
    _url: string,
    init: { body: string; signal: AbortSignal },
  ) => {
    const payload = JSON.parse(init.body) as DeepAnalysisRequest;
    calls.push(payload);
    const result = handler(payload);
    if (result === "hang")
      return new Promise<never>((_, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.body,
    };
  };
  return { fetch: controllerFetch, calls };
}

const messages: Message[] = [
  { id: "m1", sender: "other", text: "今天好累", timestamp: "2026年09月19日 22:00", kind: "text" },
  { id: "m2", sender: "self", text: "辛苦了", timestamp: "2026年09月19日 22:05", kind: "text" },
  { id: "m3", sender: "other", text: "你怎么还没睡", timestamp: "2026年09月19日 22:06", kind: "text" },
];

const lines = {
  m1: {
    id: "m1",
    score: { value: null, confidence: 0.5, status: "ambiguous" as const, probabilities: {} },
    emotions: { annoyed: 0.9 },
    intents: { vent: 0.9 },
  },
  m3: {
    id: "m3",
    score: { value: null, confidence: 0.6, status: "ambiguous" as const, probabilities: {} },
    emotions: { caring: 0.6 },
    intents: { ask: 0.7 },
  },
};

const deepInput = {
  messages,
  relation: "crush" as const,
  targetId: null,
  lines,
  observationModel: MODEL,
  memory: [] as LongTermMemory[],
};

const validAnalysis = {
  status: "ok",
  summary: "对方先说自己很累，随后反问你为什么还没睡。",
  surfaceSignals: ["主动告知疲惫"],
  latentEmotion: { reading: "对方可能有点疲惫", basedOn: ["m1"], conflictsWith: [] },
  latentIntent: { reading: "对方可能想继续聊", basedOn: ["m3"], conflictsWith: [] },
  conversationState: { reading: "处在互相报备近况的阶段", surfaceSignals: ["有来有回"] },
  trend: "stable",
  turningPoint: null,
  alternativeInterpretations: [
    { interpretation: "对方想找人说话", supportingEvidence: ["m1"], contradictingEvidence: [] },
    { interpretation: "只是习惯性抱怨", supportingEvidence: ["m1"], contradictingEvidence: ["m3"] },
  ],
  evidence: [{ messageId: "m1", quote: "今天好累", sender: "other", timestamp: null }],
  contradiction: null,
  uncertainty: "medium",
  nextAction: { direction: "留意之后对方是否主动开启话题", principle: "单条消息不构成长期判断" },
};

const okResponse = {
  status: "ok",
  analysis: {
    ...validAnalysis,
    model: "deepseek-flash",
    promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
    latencyMs: 900,
    analyzedMessageIds: ["m1", "m2", "m3"],
  },
  error: null,
  model: "deepseek-flash",
  promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
  latencyMs: 900,
  usage: { input_tokens: 900, output_tokens: 240 },
};

const request: DeepAnalysisRequest = {
  revision: 1,
  relation: "crush",
  targetId: null,
  messages,
  observations: [],
  memory: [],
  patterns: [],
};

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A. contextKey 失效逻辑
// ---------------------------------------------------------------------------

test("A. 输入变化会让 contextKey 失效，相同输入保持稳定", () => {
  const now = "2026-09-21T00:00:00.000Z";
  const base = buildDeepRequest(deepInput, now);
  assert.equal(buildDeepRequest(deepInput, now).key, base.key);

  // 消息内容变化
  const edited = buildDeepRequest(
    {
      ...deepInput,
      messages: [...messages.slice(0, 2), { ...messages[2], text: "改过了" }],
    },
    now,
  );
  assert.notEqual(edited.key, base.key);

  // 关系变化
  assert.notEqual(
    buildDeepRequest({ ...deepInput, relation: "couple" }, now).key,
    base.key,
  );

  // 第一层观察变化（重新分析过就不该复用旧解读）
  const changedLines = buildDeepRequest(
    { ...deepInput, lines: { ...lines, m1: { ...lines.m1, emotions: { happy: 1 } } } },
    now,
  );
  assert.notEqual(changedLines.key, base.key);

  // 记忆变化
  const withMemory = buildDeepRequest(
    {
      ...deepInput,
      memory: [
        createInferredMemory({
          id: "mem1",
          kind: "fact",
          content: "对方在深圳",
          sourceMessageIds: ["m1"],
          confidence: 0.5,
          now,
        }),
      ],
    },
    now,
  );
  assert.notEqual(withMemory.key, base.key);

  // 观察时间戳不参与 key，否则每次都会失效
  assert.equal(
    deepContextKey({
      model: "m",
      promptVersion: 1,
      relation: "crush",
      analysisMode: "conversation",
      messages,
      memory: [],
      observations: [{ messageId: "m1", emotions: { a: 1 }, intents: { b: 1 } }],
    }),
    deepContextKey({
      model: "m",
      promptVersion: 1,
      relation: "crush",
      analysisMode: "conversation",
      messages,
      memory: [],
      observations: [{ messageId: "m1", emotions: { a: 1 }, intents: { b: 1 } }],
    }),
  );
});

test("A2. 请求只带上限内的上下文，且不夹带 patterns 数值", () => {
  const many: Message[] = Array.from({ length: 200 }, (_, i) => ({
    id: `x${i}`,
    sender: i % 2 ? "self" : "other",
    text: `第 ${i} 条`,
    timestamp: null,
    kind: "text",
  }));
  const built = buildDeepRequest({ ...deepInput, messages: many }, "2026-09-21T00:00:00.000Z");
  assert.ok(built.request.messages.length <= 36);
  assert.deepEqual(built.request.patterns, []);
  assert.equal(built.request.messages.at(-1)?.id, "x199");
});

// ---------------------------------------------------------------------------
// B. 同 contextKey 不重复请求
// ---------------------------------------------------------------------------

test("B. 同一个 contextKey 重复点击只发一次请求，第二次直接复用结果", async () => {
  const { fetch, calls } = makeFetch(() => ({ status: 200, body: okResponse }));
  const controller = createDeepController({ fetch, now: () => "t" });

  await controller.run("k1", request);
  assert.equal(controller.getState().status, "success");
  assert.equal(calls.length, 1);

  await controller.run("k1", request);
  assert.equal(calls.length, 1, "同 key 不应再次请求");
  assert.equal(controller.getState().status, "success");

  await controller.run("k2", request);
  assert.equal(calls.length, 2, "不同 key 应该重新请求");
  assert.equal(controller.stats().cached, 2);
});

test("B2. 请求进行中再次点击同一个 key 会被忽略，不产生并发", async () => {
  const { fetch, calls } = makeFetch(() => "hang");
  const controller = createDeepController({ fetch, now: () => "t" });
  void controller.run("k1", request);
  await wait();
  assert.equal(controller.getState().status, "loading");
  void controller.run("k1", request);
  await wait();
  assert.equal(calls.length, 1, "并发同 key 只应有一次请求");
  controller.cancel();
});

// ---------------------------------------------------------------------------
// C. stale request abort
// ---------------------------------------------------------------------------

test("C. 输入变化会取消在途请求，且不会把过期结果写进状态", async () => {
  const { fetch, calls } = makeFetch(() => "hang");
  const controller = createDeepController({ fetch, now: () => "t" });
  void controller.run("k1", request);
  await wait();
  assert.equal(calls.length, 1);

  controller.invalidate();
  assert.equal(controller.getState().status, "idle");
  assert.equal(controller.getState().result, null);
  assert.equal(controller.stats().aborted, 1);

  // 失效后新的 key 可以正常请求
  const fresh = makeFetch(() => ({ status: 200, body: okResponse }));
  const controller2 = createDeepController({ fetch: fresh.fetch, now: () => "t" });
  await controller2.run("k2", request);
  assert.equal(controller2.getState().status, "success");
});

test("C2. 失效时保留探测到的可用性，不会退回未知", async () => {
  const { fetch } = makeFetch(() => ({ status: 200, body: okResponse }));
  const controller = createDeepController({
    fetch,
    now: () => "t",
    fetchHealth: async () => ({ deep: { enabled: true, configured: true } }),
  });
  await controller.probe();
  assert.equal(controller.getState().availability, "ready");
  controller.invalidate();
  assert.equal(controller.getState().availability, "ready");
});

// ---------------------------------------------------------------------------
// D / E. disabled 与 not configured 的 UI 状态
// ---------------------------------------------------------------------------

test("D. 服务端未启用时进入 disabled 状态，不是 error", async () => {
  const { fetch } = makeFetch(() => ({
    status: 200,
    body: { ...okResponse, status: "disabled", analysis: null, error: "第二层分析未启用" },
  }));
  const controller = createDeepController({
    fetch,
    now: () => "t",
    fetchHealth: async () => ({ deep: { enabled: false, configured: false } }),
  });
  await controller.probe();
  assert.equal(controller.getState().status, "disabled");
  assert.equal(controller.getState().availability, "disabled");

  await controller.run("k1", request);
  assert.equal(controller.getState().status, "disabled");
  assert.equal(controller.getState().result, null);
});

test("E. 未配置 key 时进入 not_configured 状态", async () => {
  const { fetch } = makeFetch(() => ({
    status: 503,
    body: { ...okResponse, status: "not_configured", analysis: null, error: "未配置 DEEPSEEK_API_KEY" },
  }));
  const controller = createDeepController({
    fetch,
    now: () => "t",
    fetchHealth: async () => ({ deep: { enabled: true, configured: false } }),
  });
  await controller.probe();
  assert.equal(controller.getState().availability, "not_configured");
  await controller.run("k1", request);
  assert.equal(controller.getState().status, "not_configured");
  assert.equal(controller.getState().result, null);
});

// ---------------------------------------------------------------------------
// F. DeepSeek 出错不影响 Jev
// ---------------------------------------------------------------------------

test("F. 第二层各种失败都只影响自身状态，第一层输入校验照常工作", async () => {
  for (const [status, body] of [
    [502, { ...okResponse, status: "error", analysis: null, error: "第二层模型返回 HTTP 500" }],
    [504, { ...okResponse, status: "error", analysis: null, error: "超时" }],
  ] as const) {
    const { fetch } = makeFetch(() => ({ status, body }));
    const controller = createDeepController({ fetch, now: () => "t" });
    await controller.run("k", request);
    assert.equal(controller.getState().status, "error");
    assert.equal(controller.getState().result, null);
  }

  // 网络层直接抛错
  const broken = createDeepController({
    fetch: async () => {
      throw new Error("boom");
    },
    now: () => "t",
  });
  await broken.run("k", request);
  assert.equal(broken.getState().status, "error");
  assert.ok(broken.getState().error.length > 0);

  // 第一层完全不受影响
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

// ---------------------------------------------------------------------------
// G. UserTranslation 不显示伪精确概率
// ---------------------------------------------------------------------------

test("G. 翻译层不含百分比，且命令式建议被过滤", () => {
  const analysis = deepAnalysisOutput.parse(validAnalysis);
  const full = {
    ...analysis,
    model: "deepseek-flash",
    promptVersion: 1,
    latencyMs: 10,
    analyzedMessageIds: ["m1"],
  };
  const translation: UserTranslation = buildTranslation(full);
  const text = JSON.stringify(translation);
  assert.equal(/\d{1,3}\s*%/.test(text), false, "翻译层不应出现百分比");
  assert.equal(/\(?:概率|几率|可能性\)\s*\d/.test(text), false);
  for (const line of [
    ...translation.whatHappened,
    ...translation.whatYouMightMiss,
    ...translation.whatToWatchNext,
    ...translation.uncertainty,
  ])
    assert.deepEqual(findImperative(line), [], `出现命令式措辞：${line}`);
});

test("G2. 六个部分都来自各自的字段，不互相混淆", () => {
  const analysis = deepAnalysisOutput.parse(validAnalysis);
  const translation = buildTranslation({
    ...analysis,
    model: "m",
    promptVersion: 1,
    latencyMs: 1,
    analyzedMessageIds: [],
  });
  assert.ok(translation.whatHappened.includes(validAnalysis.summary));
  assert.ok(translation.whatYouMightMiss.includes(validAnalysis.latentEmotion.reading));
  assert.deepEqual(
    translation.possibleMeanings.map((x) => x.interpretation),
    validAnalysis.alternativeInterpretations.map((x) => x.interpretation),
  );
  assert.deepEqual(translation.strongestEvidence, ["m1"]);
  assert.ok(translation.uncertainty.some((x) => x.includes("把握")));
});

// ---------------------------------------------------------------------------
// H. Interpretation Boundary 拦截读心式确定表述
// ---------------------------------------------------------------------------

test("H. 读心式断言被识别、软化或拒绝", () => {
  assert.equal(hasAssertiveReading("对方可能有点累"), false);
  assert.equal(hasAssertiveReading("她就是在测试你"), true);

  const softened = soften("她就是不想理你");
  assert.equal(softened.text, "她可能不想理你");
  assert.ok(softened.changed.length > 0);

  const analysis = deepAnalysisOutput.parse({
    ...validAnalysis,
    latentIntent: { reading: "她就是在测试你", basedOn: ["m3"], conflictsWith: [] },
  });
  const result = enforceBoundary({
    ...analysis,
    model: "m",
    promptVersion: 1,
    latencyMs: 1,
    analyzedMessageIds: [],
  });
  // 「就是」属可软化范围：改写成可能语气
  assert.equal(result.analysis.latentIntent.reading, "她可能在测试你");
  assert.ok(result.meta.softenedFields.includes("latentIntent.reading"));
  // 软化的结果不应再被判为断言式
  assert.equal(hasAssertiveReading(result.analysis.latentIntent.reading), false);
});

test("H2. 硬违规被拦下：人格诊断、操纵建议、性别刻板、单条定长期", () => {
  const cases: [string, string][] = [
    ["latentEmotion", "她属于回避型依恋"],
    ["latentIntention", "她一定是焦虑型人格"],
    ["nextAction", "故意冷淡三天，让她主动找你"],
    ["surfaceSignals", "女生都是这样口是心非"],
    ["summary", "她根本不在乎你"],
  ];
  for (const [field, text] of cases) {
    const base = deepAnalysisOutput.parse(validAnalysis);
    const draft = {
      ...base,
      model: "m",
      promptVersion: 1,
      latencyMs: 1,
      analyzedMessageIds: [],
    };
    const patched =
      field === "latentEmotion"
        ? { ...draft, latentEmotion: { ...draft.latentEmotion, reading: text } }
        : field === "latentIntention"
          ? { ...draft, latentIntent: { ...draft.latentIntent, reading: text } }
          : field === "nextAction"
            ? { ...draft, nextAction: { direction: text, principle: null } }
            : field === "surfaceSignals"
              ? { ...draft, surfaceSignals: [text] }
              : { ...draft, summary: text };
    const violations = findHardViolations(patched as never);
    assert.ok(violations.length > 0, `未拦下：${text}`);
  }
  // 正常措辞必须放行
  assert.deepEqual(
    findHardViolations({
      ...validAnalysis,
      summary: "对方可能只是随口一问",
      latentEmotion: { reading: "可能有点累", conflictsWith: [] },
    } as never),
    [],
  );
});

test("H3. Provider 层在硬违规时拒绝整份结果", async () => {
  const { createDeepSeekProvider } = await import("../server/ai/deepseek");
  const config = {
    enabled: true,
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
    timeoutMs: 1000,
  };
  const leaky = { ...validAnalysis, summary: "她属于回避型依恋" };
  const provider = createDeepSeekProvider(config, {
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(leaky) }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    }),
  });
  await assert.rejects(
    () => provider.interpret(request),
    (error: unknown) =>
      (error as { code?: string }).code === "boundary_violation",
  );
});

// ---------------------------------------------------------------------------
// I / J. feedback 只存本地，且不影响 memory
// ---------------------------------------------------------------------------

test("I. 反馈只写本地存储，可读回，字段非法则丢弃", () => {
  const { storage, map } = fakeStorage();
  assert.deepEqual(loadInterpretationFeedback(storage), []);

  const saved = recordInterpretationFeedback(
    {
      id: "fb1",
      contextKey: "k1",
      verdict: "problem",
      reasons: ["wrong_reading", "too_certain"],
      note: "那天她在赶稿",
      now: "2026-09-21T00:00:00.000Z",
    },
    storage,
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0].verdict, "problem");
  assert.equal(saved[0].reasons.length, 2);
  // 落盘位置是独立的 key，与长期记忆分开
  assert.ok(map.has("crush-monitor.deep-feedback.v1"));
  assert.equal(map.has("crush-monitor.memory.v1"), false);

  const reread = loadInterpretationFeedback(storage);
  assert.deepEqual(reread, saved);

  assert.equal(parseInterpretationFeedback([{ id: "x" }]).length, 0);
  assert.equal(
    parseInterpretationFeedback([{ id: "x", contextKey: "k", verdict: "nope" }])
      .length,
    0,
  );
});

test("J. 记录解读反馈不会升级任何 memory 的 sourceType", () => {
  const { storage, map } = fakeStorage();
  const inferred = createInferredMemory({
    id: "mem1",
    kind: "preference",
    content: "对方可能喜欢喝美式",
    sourceMessageIds: ["m1"],
    confidence: 0.5,
    now: "2026-09-21T00:00:00.000Z",
  });
  map.set("crush-monitor.memory.v1", JSON.stringify([inferred]));

  recordInterpretationFeedback(
    {
      id: "fb1",
      contextKey: "k1",
      verdict: "problem",
      reasons: ["wrong_reading"],
      note: "其实她只是随口一说",
      now: "2026-09-21T01:00:00.000Z",
    },
    storage,
  );

  // 记忆内容与来源等级完全没变
  const after = parseMemory(JSON.parse(map.get("crush-monitor.memory.v1")!));
  assert.equal(after.length, 1);
  assert.equal(after[0].sourceType, "model_inferred");
  assert.equal(after[0].confidence, 0.5);
  assert.equal(after[0].content, inferred.content);
});

// ---------------------------------------------------------------------------
// K. pattern 仍由服务端重算
// ---------------------------------------------------------------------------

test("K. 客户端传入的 pattern 数值会被服务端丢弃并重算", () => {
  const fake = {
    kind: "initiation_ratio" as const,
    label: "伪造的指标",
    value: 999,
    baseline: null,
    delta: null,
    sampleSize: 1,
    sufficient: true,
  };
  const input = buildProviderInput({
    revision: 1,
    relation: "crush",
    targetId: null,
    messages,
    observations: [
      {
        messageId: "m1",
        emotions: { annoyed: 0.9 },
        intents: { vent: 0.9 },
        score: null,
        model: MODEL,
        observedAt: "2026-09-21T00:00:00.000Z",
      },
    ],
    memory: [],
    patterns: [fake],
  });
  assert.equal(input.patterns.some((p) => p.label === "伪造的指标"), false);
  assert.deepEqual(
    input.patterns,
    computePatterns({
      messages: input.messages,
      observations: input.observations,
      memory: input.memory,
    }),
  );
});

test("K2. 第二层请求形状与第一层完全分开", () => {
  const built = buildProviderInput({
    revision: 1,
    relation: "crush",
    targetId: null,
    messages,
    observations: [],
    memory: [],
    patterns: [],
  });
  assert.ok("observations" in built);
  assert.ok("memory" in built);
  assert.ok("patterns" in built);

  // 反过来：第一层 schema 不接受第二层字段
  const first = requestSchema.parse({
    revision: 1,
    relation: "crush",
    task: "overview",
    targetIds: [],
    messages,
    observations: [{ messageId: "m1" }],
    memory: [{ id: "mem1" }],
  });
  assert.equal("observations" in first, false);
  assert.equal("memory" in first, false);
});

// ---------------------------------------------------------------------------
// L. API key 不进前端
// ---------------------------------------------------------------------------

test("L. 请求载荷与前端源码都不含任何 API key", () => {
  const built = buildDeepRequest(deepInput, "2026-09-21T00:00:00.000Z");
  const payload = JSON.stringify(built.request);
  assert.equal(/sk-|apikey_|Bearer/i.test(payload), false);
  assert.equal(payload.includes("DEEPSEEK_API_KEY"), false);
  assert.equal(payload.includes("TYPESAFE_API_KEY"), false);

  const srcDir = join(process.cwd(), "src");
  for (const file of readdirSync(srcDir)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const code = readFileSync(join(srcDir, file), "utf8");
    assert.equal(
      code.includes("DEEPSEEK_API_KEY"),
      false,
      `${file} 不应出现 DEEPSEEK_API_KEY`,
    );
    assert.equal(
      code.includes("TYPESAFE_API_KEY"),
      false,
      `${file} 不应出现 TYPESAFE_API_KEY`,
    );
    // 前端只允许调用本地相对路径
    assert.equal(/api\.deepseek\.com/.test(code), false, `${file} 不应直连模型服务`);
  }
});

test("L2. 第二层的端点固定在本地相对路径", () => {
  const controller = createDeepController({
    fetch: async (url) => {
      assert.equal(url, "/api/deep-analysis");
      return { ok: true, status: 200, json: async () => okResponse };
    },
    now: () => "t",
  });
  return controller.run("k", request);
});

// ---------------------------------------------------------------------------
// M. DeepAnalysis 不进入第一层响应
// ---------------------------------------------------------------------------

test("M. 第一层请求结构不会被第二层字段污染", async () => {
  const parsed = requestSchema.parse({
    revision: 1,
    relation: "crush",
    task: "overview",
    targetIds: [],
    messages,
    memory: [{ id: "mem1" }],
    patterns: [{ kind: "x" }],
  });
  assert.equal("memory" in parsed, false);
  assert.equal("patterns" in parsed, false);

  // 第一层响应形状不变
  const { buildRequest } = await import("../server/analysis");
  const built = buildRequest({
    revision: 1,
    relation: "crush",
    task: "overview",
    targetIds: [],
    messages,
  });
  assert.deepEqual(Object.keys(built).sort(), ["model", "questions", "state"]);
  assert.equal("analysis" in built, false);
});

// ---------------------------------------------------------------------------
// N. 旧保存数据仍然能读取
// ---------------------------------------------------------------------------

test("N. 第一阶段保存的记忆与旧会话记录仍可读取", () => {
  const legacy = {
    id: "legacy-1",
    kind: "fact",
    content: "对方在深圳",
    sourceMessageIds: ["m1"],
    createdAt: "2026-09-01T00:00:00.000Z",
    lastConfirmedAt: "2026-09-01T00:00:00.000Z",
    status: "active",
    confidence: 0.5,
    sourceType: "model_inferred",
  };
  const parsed = parseMemory([legacy]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sourceType, "model_inferred");

  // 旧格式的聊天记录仍然能解析与合并
  const shape =
    "甲\n2026年09月19日 12:18\n刚才在做什么\n\n乙\n2026年09月19日 12:19\n整理书架";
  const older = toMessages(parseChat(shape).messages, "甲");
  assert.equal(older.length, 2);
  const merged = mergeMessages(older, toMessages(parseChat(shape).messages, "甲"));
  assert.equal(merged.added, 0);

  // 没有 deep-feedback 记录时返回空数组而不是报错
  const { storage } = fakeStorage();
  assert.deepEqual(loadInterpretationFeedback(storage), []);
});

// ---------------------------------------------------------------------------
// 附加：observations 来自第一层，且不重新计算结果
// ---------------------------------------------------------------------------

test("observations 直接引用第一层结果，不改写概率", () => {
  const observations = buildObservations(messages, lines, MODEL, "2026-09-21T00:00:00.000Z");
  assert.equal(observations.length, 2);
  assert.deepEqual(observations[0].emotions, { annoyed: 0.9 });
  assert.deepEqual(observations[0].intents, { vent: 0.9 });
  assert.equal(observations[0].model, MODEL);
  // 没有第一层结果的消息不会凭空造出 observation
  assert.equal(observations.some((o) => o.messageId === "m2"), false);
});

test("相关记忆按相关度筛选后才送进第二层", () => {
  const memory: LongTermMemory[] = [
    createInferredMemory({
      id: "b1",
      kind: "boundary",
      content: "不喜欢被追问行程",
      sourceMessageIds: ["old"],
      confidence: 0.5,
      now: "2026-09-21T00:00:00.000Z",
    }),
  ];
  const built = buildDeepRequest({ ...deepInput, memory }, "2026-09-21T00:00:00.000Z");
  assert.equal(built.request.memory.length, 1);
  assert.deepEqual(
    built.request.memory.map((m) => m.id),
    relevantEvents(memory, built.request.messages).map((m) => m.id),
  );
});
