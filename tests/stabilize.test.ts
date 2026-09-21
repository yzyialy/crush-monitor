import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEEP_ANALYSIS_DEFAULT_MODEL,
  DEEP_ANALYSIS_PROMPT_VERSION,
  MODEL,
  type DeepAnalysis,
  type DeepAnalysisRequest,
  type DeepAnalysisResponse,
  type Message,
} from "../shared/types";
import { buildTranslation } from "../shared/translation";
import {
  DEFAULT_DEEP_IDENTITY,
  buildDeepRequest,
  createDeepController,
  type DeepInput,
} from "../src/useDeepAnalysis";
import {
  enforceBoundary,
  MIND_READING_THRESHOLD,
} from "../server/ai/boundary";
import {
  MAX_BOUNDARY_RETRIES,
  createDeepSeekProvider,
  deepAnalysisOutput,
} from "../server/ai/deepseek";

/**
 * 稳定化测试：
 *   - 缓存身份（model / promptVersion）一致性
 *   - stale result 行为
 *   - Interpretation Boundary 三级策略与重试上限
 * 全部注入 mock，不访问网络，更不会调用 DeepSeek。
 */

const messages: Message[] = [
  { id: "m1", sender: "other", text: "今天好累", timestamp: "2026年09月19日 22:00", kind: "text" },
  { id: "m2", sender: "self", text: "辛苦了", timestamp: "2026年09月19日 22:05", kind: "text" },
  { id: "m3", sender: "other", text: "你怎么还没睡", timestamp: "2026年09月19日 22:06", kind: "text" },
];

const lines = {
  m1: { id: "m1", score: { value: null, confidence: 0.5, status: "ambiguous" as const, probabilities: {} }, emotions: { annoyed: 0.9 }, intents: { vent: 0.9 } },
  m3: { id: "m3", score: { value: null, confidence: 0.6, status: "ambiguous" as const, probabilities: {} }, emotions: { caring: 0.6 }, intents: { ask: 0.7 } },
};

const deepInput: DeepInput = {
  messages,
  relation: "crush",
  targetId: null,
  lines,
  observationModel: MODEL,
  memory: [],
};

const now = "2026-09-21T00:00:00.000Z";

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
  ],
  evidence: [{ messageId: "m1", quote: "今天好累", sender: "other", timestamp: null }],
  contradiction: null,
  uncertainty: "medium",
  nextAction: { direction: "留意之后对方是否主动开启话题", principle: "单条消息不构成长期判断" },
};

/** 组装一份完整的 DeepAnalysis（补齐服务端填写的字段）。 */
function draft(patch: Record<string, unknown> = {}): DeepAnalysis {
  const parsed = deepAnalysisOutput.parse({ ...validAnalysis, ...patch });
  return {
    ...parsed,
    model: DEEP_ANALYSIS_DEFAULT_MODEL,
    promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
    latencyMs: 100,
    analyzedMessageIds: ["m1", "m2", "m3"],
  };
}

const request: DeepAnalysisRequest = {
  revision: 1,
  relation: "crush",
  targetId: null,
  messages,
  observations: [],
  memory: [],
  patterns: [],
};

const okResponse = (model = DEEP_ANALYSIS_DEFAULT_MODEL): DeepAnalysisResponse => ({
  status: "ok",
  analysis: { ...draft(), model, promptVersion: DEEP_ANALYSIS_PROMPT_VERSION },
  error: null,
  model,
  promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
  latencyMs: 900,
  usage: { input_tokens: 900, output_tokens: 240 },
});

type FetchMode = "ok" | "fail" | "mismatch-model";

/** 可切换行为的 controller fetch mock。 */
function controllerFetch() {
  const calls: DeepAnalysisRequest[] = [];
  let mode: FetchMode = "ok";
  const fn = async (_url: string, init: { body: string; signal: AbortSignal }) => {
    calls.push(JSON.parse(init.body) as DeepAnalysisRequest);
    if (mode === "fail")
      return {
        ok: false,
        status: 502,
        json: async () => ({
          status: "error",
          analysis: null,
          error: "第二层模型返回 HTTP 500",
          model: DEEP_ANALYSIS_DEFAULT_MODEL,
          promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
          latencyMs: 10,
          usage: null,
        }),
      };
    if (mode === "mismatch-model")
      return {
        ok: true,
        status: 200,
        json: async () => okResponse("别的模型"),
      };
    return { ok: true, status: 200, json: async () => okResponse() };
  };
  return {
    calls,
    fn,
    setMode: (next: FetchMode) => {
      mode = next;
    },
  };
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 一、缓存身份：model / promptVersion
// ---------------------------------------------------------------------------

test("1. 服务端 model 变化后 contextKey 必须变化（旧缓存不会被复用）", () => {
  const a = buildDeepRequest(deepInput, now, {
    model: DEEP_ANALYSIS_DEFAULT_MODEL,
    promptVersion: 1,
  });
  const b = buildDeepRequest(deepInput, now, {
    model: "deepseek-v4-pro",
    promptVersion: 1,
  });
  assert.notEqual(a.key, b.key, "换模型必须产生不同的缓存键");

  // 换回原模型仍然得到原来的键
  assert.equal(
    buildDeepRequest(deepInput, now, {
      model: DEEP_ANALYSIS_DEFAULT_MODEL,
      promptVersion: 1,
    }).key,
    a.key,
  );

  // promptVersion 变化同样失效
  assert.notEqual(
    buildDeepRequest(deepInput, now, { model: DEEP_ANALYSIS_DEFAULT_MODEL, promptVersion: 2 }).key,
    a.key,
  );
});

test("2. 响应 model 与服务端身份不一致时不得写入缓存", async () => {
  const mock = controllerFetch();
  const controller = createDeepController({ fetch: mock.fn, now: () => now });
  await controller.probe?.();
  mock.setMode("mismatch-model");

  await controller.run("k1", request);
  assert.equal(controller.getState().status, "success");
  assert.ok(controller.getState().result, "结果仍应展示");
  assert.equal(controller.stats().cached, 0, "身份不匹配不得写缓存");

  // 再点一次：因为没缓存，必须重新请求
  await controller.run("k1", request);
  assert.equal(mock.calls.length, 2, "未缓存的结果必须重新请求");
});

test("2b. 身份匹配时才写缓存，第二次同 key 直接复用", async () => {
  const mock = controllerFetch();
  const controller = createDeepController({ fetch: mock.fn, now: () => now });
  await controller.run("k1", request);
  assert.equal(controller.stats().cached, 1);
  await controller.run("k1", request);
  assert.equal(mock.calls.length, 1, "身份匹配的缓存应当被复用");
});

test("2c. probe 会用服务端实际 model 覆盖默认身份", async () => {
  const mock = controllerFetch();
  const controller = createDeepController({
    fetch: mock.fn,
    now: () => now,
    fetchHealth: async () => ({
      deep: { enabled: true, configured: true, model: "deepseek-v4-pro", promptVersion: 7 },
    }),
  });
  await controller.probe?.();
  assert.deepEqual(controller.getState().identity, {
    model: "deepseek-v4-pro",
    promptVersion: 7,
  });
  assert.notEqual(
    buildDeepRequest(deepInput, now, controller.getState().identity!).key,
    buildDeepRequest(deepInput, now, DEFAULT_DEEP_IDENTITY).key,
  );
});

// ---------------------------------------------------------------------------
// 二、stale result 行为
// ---------------------------------------------------------------------------

test("3. 输入变化后旧结果仍然存在，只被标记为 stale", async () => {
  const mock = controllerFetch();
  const controller = createDeepController({ fetch: mock.fn, now: () => now });
  await controller.run("k1", request);
  const before = controller.getState();
  assert.equal(before.isStale, false);
  assert.ok(before.result);

  controller.invalidate();
  const after = controller.getState();
  assert.ok(after.result, "旧结果不得被清空");
  assert.equal(after.isStale, true, "必须标记为 stale");
  assert.equal(after.status, "success", "展示状态保持可用");
});

test("4. 标记 stale 不会自动触发任何新请求", async () => {
  const mock = controllerFetch();
  const controller = createDeepController({ fetch: mock.fn, now: () => now });
  await controller.run("k1", request);
  assert.equal(mock.calls.length, 1);

  controller.invalidate();
  controller.invalidate();
  await wait(20);
  assert.equal(mock.calls.length, 1, "invalidate 绝不能自动重跑");
  assert.equal(controller.getState().isStale, true);
});

test("5. 新结果成功后 stale 被清除并替换内容", async () => {
  const mock = controllerFetch();
  const controller = createDeepController({ fetch: mock.fn, now: () => now });
  await controller.run("k1", request);
  controller.invalidate();
  assert.equal(controller.getState().isStale, true);

  await controller.run("k2", request);
  const state = controller.getState();
  assert.equal(state.isStale, false);
  assert.equal(state.resultKey, "k2");
  assert.equal(state.status, "success");
  assert.equal(mock.calls.length, 2);
});

test("6. 新请求失败时旧结果保留，且仍标记 stale", async () => {
  const mock = controllerFetch();
  const controller = createDeepController({ fetch: mock.fn, now: () => now });
  await controller.run("k1", request);
  const original = controller.getState().result;
  assert.ok(original);

  controller.invalidate();
  mock.setMode("fail");
  await controller.run("k2", request);

  const state = controller.getState();
  assert.equal(state.status, "error");
  assert.ok(state.error.length > 0);
  assert.deepEqual(state.result, original, "失败时旧结果必须原样保留");
  assert.equal(state.isStale, true, "仍然过期");
});

// ---------------------------------------------------------------------------
// 三、Interpretation Boundary 三级策略
// ---------------------------------------------------------------------------

test("7. 单字段违规不会让整份结果作废", () => {
  const outcome = enforceBoundary(
    draft({
      // long_term_from_single 属字段级：只移除承载它的字段
      latentIntent: { reading: "她根本不在乎你", basedOn: ["m3"], conflictsWith: [] },
    }),
  );
  assert.deepEqual(outcome.fatal, [], "不应判为致命");
  assert.deepEqual(outcome.meta.removedFields, ["latentIntent.reading"]);
  assert.equal(outcome.analysis.latentIntent.reading, "");
  // 其它字段完好保留
  assert.equal(outcome.analysis.summary, validAnalysis.summary);
  assert.deepEqual(outcome.analysis.surfaceSignals, validAnalysis.surfaceSignals);
  assert.equal(outcome.analysis.uncertainty, "medium");
  assert.ok(outcome.analysis.evidence.length > 0);
});

test("7b. 可软化表述走 Level 1，字段名被记录", () => {
  const outcome = enforceBoundary(
    draft({
      latentIntent: { reading: "她就是不想理你", basedOn: ["m3"], conflictsWith: [] },
    }),
  );
  assert.deepEqual(outcome.fatal, []);
  assert.equal(outcome.analysis.latentIntent.reading, "她可能不想理你");
  assert.ok(outcome.meta.softenedFields.includes("latentIntent.reading"));
  assert.deepEqual(outcome.meta.removedFields, []);
});

test("7c. 大量读心断言才是致命（达到阈值）", () => {
  const fields = [
    "她就是不想理你",
    "她其实是在生气",
    "她一定觉得你烦",
  ];
  assert.ok(fields.length >= MIND_READING_THRESHOLD);
  const outcome = enforceBoundary(
    draft({
      summary: fields[0],
      surfaceSignals: [fields[1], fields[2]],
    }),
  );
  assert.ok(outcome.fatal.length > 0);
  assert.equal(outcome.fatal[0].code, "mind_reading");
});

test("8. 严重违规触发一次自动安全重试", async () => {
  let call = 0;
  const provider = createDeepSeekProvider(
    {
      enabled: true,
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: DEEP_ANALYSIS_DEFAULT_MODEL,
      promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
      timeoutMs: 1000,
    },
    {
      fetch: async () => {
        call++;
        const output =
          call === 1
            ? { ...validAnalysis, summary: "她属于回避型依恋" } // 致命：人格诊断
            : validAnalysis;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              output: [
                { type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
        };
      },
    },
  );

  const outcome = await provider.interpret(request);
  assert.equal(call, 2, "应当恰好重试一次");
  assert.equal(outcome.boundary.retried, true);
  assert.equal(outcome.analysis.summary, validAnalysis.summary);
});

test("9. 第二次仍然违规时整份失败", async () => {
  let call = 0;
  const provider = createDeepSeekProvider(
    {
      enabled: true,
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: DEEP_ANALYSIS_DEFAULT_MODEL,
      promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
      timeoutMs: 1000,
    },
    {
      fetch: async () => {
        call++;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              output: [
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({ ...validAnalysis, summary: "她属于回避型依恋" }),
                    },
                  ],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
        };
      },
    },
  );

  await assert.rejects(
    () => provider.interpret(request),
    (error: unknown) =>
      (error as { code?: string }).code === "boundary_violation",
  );
  assert.equal(call, 2, "重试后仍违规就必须失败，不能继续尝试");
});

test("10. 最大重试次数恒为 1，任何违规路径都不会超过 2 次调用", async () => {
  assert.equal(MAX_BOUNDARY_RETRIES, 1);

  // 结构损坏路径同样受这个上限约束
  let call = 0;
  const provider = createDeepSeekProvider(
    {
      enabled: true,
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: DEEP_ANALYSIS_DEFAULT_MODEL,
      promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
      timeoutMs: 1000,
    },
    {
      fetch: async () => {
        call++;
        return { ok: true, status: 200, text: async () => "{ 这不是合法结构 }" };
      },
    },
  );
  await assert.rejects(() => provider.interpret(request));
  assert.equal(call, 1 + MAX_BOUNDARY_RETRIES);
});

test("10b. 传输层错误不重试（重试只针对边界与结构问题）", async () => {
  let call = 0;
  const provider = createDeepSeekProvider(
    {
      enabled: true,
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: DEEP_ANALYSIS_DEFAULT_MODEL,
      promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
      timeoutMs: 1000,
    },
    {
      fetch: async () => {
        call++;
        return { ok: false, status: 500, text: async () => "{}" };
      },
    },
  );
  await assert.rejects(
    () => provider.interpret(request),
    (error: unknown) => (error as { code?: string }).code === "upstream",
  );
  assert.equal(call, 1, "上游错误不应当重试");
});

// ---------------------------------------------------------------------------
// 四、移除的字段不进入用户可见内容
// ---------------------------------------------------------------------------

test("11. 被移除字段的内容不会出现在 UserTranslation 里", () => {
  const outcome = enforceBoundary(
    draft({
      summary: "她根本不在乎你",
      surfaceSignals: ["她从来不在意你", "有来有回"],
    }),
  );
  assert.ok(outcome.meta.removedFields.length > 0);
  const translation = buildTranslation(outcome.analysis);
  const text = JSON.stringify(translation);
  assert.equal(text.includes("根本不在乎"), false, "被移除的内容不得出现在翻译层");
  assert.equal(text.includes("从来不在意"), false);
  // 未被移除的信号照常保留
  assert.ok(text.includes("有来有回"));
});

test("11b. evidence 里的违规条目被过滤，其余保留", () => {
  const outcome = enforceBoundary(
    draft({
      evidence: [
        { messageId: "m1", quote: "今天好累", sender: "other", timestamp: null },
        { messageId: "m2", quote: "她根本不在乎你", sender: "self", timestamp: null },
      ],
    }),
  );
  assert.equal(outcome.analysis.evidence.length, 1);
  assert.equal(outcome.analysis.evidence[0].quote, "今天好累");
});

// ---------------------------------------------------------------------------
// 五、日志与错误信息不泄漏违规原文
// ---------------------------------------------------------------------------

test("12. 日志与错误信息都不包含违规原文", async () => {
  const violation = "她属于回避型依恋";
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

  let message = "";
  try {
    const provider = createDeepSeekProvider(
      {
        enabled: true,
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com",
        model: DEEP_ANALYSIS_DEFAULT_MODEL,
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
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({ ...validAnalysis, summary: violation }),
                    },
                  ],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
        }),
      },
    );
    await assert.rejects(() => provider.interpret(request), (error: unknown) => {
      message = (error as Error).message;
      return true;
    });
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
    console.info = original.info;
    console.debug = original.debug;
  }

  assert.ok(message.length > 0);
  assert.equal(message.includes(violation), false, "错误信息不得包含违规原文");
  assert.equal(
    captured.some((line) => line.includes(violation)),
    false,
    `日志里出现了违规原文：${captured.join(" | ")}`,
  );
});

test("12b. boundary metadata 只含字段名与布尔值", () => {
  const outcome = enforceBoundary(
    draft({ latentIntent: { reading: "她根本不在乎你", basedOn: [], conflictsWith: [] } }),
  );
  const meta = outcome.analysis.boundary!;
  assert.deepEqual(Object.keys(meta).sort(), [
    "removedFields",
    "retried",
    "softenedFields",
  ]);
  assert.equal(typeof meta.retried, "boolean");
  assert.ok(meta.removedFields.every((f) => typeof f === "string"));
  // 字段名里不含任何聊天内容
  assert.equal(JSON.stringify(meta).includes("不在乎"), false);
});
