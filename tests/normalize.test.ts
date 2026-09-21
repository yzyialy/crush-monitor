import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findRawIds,
  normalizeMessageReferences,
  resolveMessagePrefix,
} from "../server/ai/references";
import { createDeepSeekProvider, deepAnalysisOutput } from "../server/ai/deepseek";
import { summarizeRuns } from "../shared/diagnostics";
import { DEEP_ANALYSIS_PROMPT_VERSION } from "../shared/types";
import type {
  DeepAnalysis,
  DeepAnalysisRequest,
  Message,
} from "../shared/types";

/**
 * 本轮补丁测试：
 *   1. messageId 引用归一化（模型截断 ID -> 可读引用）
 *   2. boundary violationCodes 类别元数据
 *   3. 诊断统计辅助
 * 全部为纯本地测试，不访问网络。
 */

// 前两条前 8 位不同，第 1、3 条共享前 8 位（用于测歧义）
const messages: Message[] = [
  { id: "aaaaaaaa-1111-4111-8111-111111111111", sender: "self", text: "在干嘛？", timestamp: null, kind: "text" },
  { id: "bbbbbbbb-2222-4222-8222-222222222222", sender: "other", text: "洗澡", timestamp: null, kind: "text" },
  { id: "aaaaaaaa-3333-4333-8333-333333333333", sender: "other", text: "？", timestamp: null, kind: "text" },
];

const baseAnalysis = {
  status: "ok" as const,
  summary: "一段普通对话。",
  surfaceSignals: ["有来有回"],
  latentEmotion: { reading: "可能有点累", basedOn: [], conflictsWith: [] },
  latentIntent: { reading: "可能只是随口一说", basedOn: [], conflictsWith: [] },
  conversationState: { reading: "日常交流", surfaceSignals: [] },
  trend: "uncertain" as const,
  turningPoint: null,
  contradiction: null,
  uncertainty: "high" as const,
  nextAction: null,
  alternativeInterpretations: [
    {
      interpretation: "可能只是随口一说",
      supportingEvidence: [],
      contradictingEvidence: [],
    },
  ],
  evidence: [
    { messageId: messages[1].id, quote: "洗澡", sender: "other" as const, timestamp: null },
  ],
};

function draft(patch: Record<string, unknown> = {}): DeepAnalysis {
  const parsed = deepAnalysisOutput.parse({ ...baseAnalysis, ...patch });
  return {
    ...parsed,
    model: "deepseek-flash",
    promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
    latencyMs: 10,
    analyzedMessageIds: messages.map((m) => m.id),
  };
}

// ---------------------------------------------------------------------------
// 1. 前缀解析
// ---------------------------------------------------------------------------

test("8 位唯一前缀能正确匹配到消息序号", () => {
  assert.equal(resolveMessagePrefix("bbbbbbbb", messages), 2);
});

test("6-12 位前缀都支持，超出范围一律不匹配", () => {
  assert.equal(resolveMessagePrefix("bbbbbb", messages), 2); // 6 位
  assert.equal(resolveMessagePrefix("bbbbbbbb", messages), 2); // 8 位
  assert.equal(resolveMessagePrefix("bbbbbbbb-222", messages), 2); // 12 字符
  assert.equal(resolveMessagePrefix("bbbbb", messages), null); // 5 位，太短
  assert.equal(
    resolveMessagePrefix("bbbbbbbb-2222-4222", messages),
    null,
    "19 字符超出上限",
  );
});

test("共享前缀有歧义时返回 null，绝不猜", () => {
  assert.equal(resolveMessagePrefix("aaaaaaaa", messages), null);
  assert.equal(resolveMessagePrefix("aaaaaaaa-1111", messages), null);
});

test("不存在的 ID 不会匹配成功", () => {
  assert.equal(resolveMessagePrefix("cccccccc", messages), null);
  assert.equal(resolveMessagePrefix("deadbeef", messages), null);
});

// ---------------------------------------------------------------------------
// 2. 引用归一化
// ---------------------------------------------------------------------------

test("模型截断的 8 位 ID 被还原成「第 N 条消息」", () => {
  const result = normalizeMessageReferences(
    draft({
      latentIntent: {
        reading: "对方在 bbbbbbbb 中回答了自己的状态",
        basedOn: [],
        conflictsWith: [],
      },
    }),
    messages,
  );
  // 原有空格被保留（中文与数字间留空格符合中文排版习惯，不擅自改写模型文本）
  assert.equal(
    result.analysis.latentIntent.reading,
    "对方在 第 2 条消息 中回答了自己的状态",
  );
  assert.equal(result.resolved, 1);
  assert.equal(result.unresolved, 0);
});

test("完整 UUID 也被还原成可读引用", () => {
  const result = normalizeMessageReferences(
    draft({ summary: `参考 ${messages[1].id} 这条消息` }),
    messages,
  );
  assert.equal(result.analysis.summary, "参考 第 2 条消息 这条消息");
});

test("有歧义或不存在的前缀降级为「相关消息」，不猜", () => {
  const result = normalizeMessageReferences(
    draft({
      summary: "aaaaaaaa 与 cccccccc 都需要注意",
    }),
    messages,
  );
  assert.equal(result.analysis.summary, "相关消息 与 相关消息 都需要注意");
  assert.equal(result.unresolved, 2);
  assert.equal(result.resolved, 0);
});

test("英文前缀会被清理掉，不留「messageId 第 2 条消息」这种残留", () => {
  const result = normalizeMessageReferences(
    draft({ summary: "messageId bbbbbbbb 的情绪偏平静" }),
    messages,
  );
  assert.equal(result.analysis.summary.includes("messageId"), false);
  assert.equal(result.analysis.summary.includes("第 2 条消息"), true);
});

test("所有用户可见字段里都不再出现裸 ID", () => {
  const result = normalizeMessageReferences(
    draft({
      summary: "摘要提到 bbbbbbbb",
      surfaceSignals: ["信号 aaaaaaaa"],
      latentEmotion: { reading: "情绪基于 bbbbbbbb", basedOn: [], conflictsWith: ["与 cccccccc 冲突"] },
      latentIntent: { reading: "意图基于 bbbbbbbb", basedOn: [], conflictsWith: [] },
      conversationState: { reading: "状态参考 bbbbbbbb", surfaceSignals: ["信号 deadbeef"] },
      alternativeInterpretations: [
        {
          interpretation: "解释提到 bbbbbbbb",
          supportingEvidence: ["支持 bbbbbbbb"],
          contradictingEvidence: ["冲突 aaaaaaaa"],
        },
      ],
      nextAction: { direction: "方向参考 bbbbbbbb", principle: "原则参考 cccccccc" },
    }),
    messages,
  );
  const visible = JSON.stringify({
    summary: result.analysis.summary,
    surfaceSignals: result.analysis.surfaceSignals,
    latentEmotion: result.analysis.latentEmotion,
    latentIntent: result.analysis.latentIntent,
    conversationState: result.analysis.conversationState,
    alternatives: result.analysis.alternativeInterpretations,
    nextAction: result.analysis.nextAction,
  });
  assert.deepEqual(findRawIds(visible), [], `仍残留裸 ID：${visible}`);
});

test("strongestEvidence 与 evidence 保持完整 UUID 供点击定位", () => {
  const result = normalizeMessageReferences(draft(), messages);
  assert.equal(result.analysis.evidence[0].messageId, messages[1].id);
  assert.match(result.analysis.evidence[0].messageId, /^[0-9a-f-]{36}$/);
});

test("空消息列表时原样返回，不做任何替换", () => {
  const input = draft({ summary: "bbbbbbbb 提到了一条消息" });
  const result = normalizeMessageReferences(input, []);
  assert.equal(result.analysis.summary, input.summary);
  assert.equal(result.resolved + result.unresolved, 0);
});

// ---------------------------------------------------------------------------
// 3. violationCodes
// ---------------------------------------------------------------------------

const request: DeepAnalysisRequest = {
  revision: 1,
  relation: "crush",
  targetId: null,
  messages,
  observations: [],
  memory: [],
  patterns: [],
};

const config = {
  enabled: true,
  apiKey: "sk-test",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
  timeoutMs: 1000,
};

function providerFetch(outputs: unknown[]) {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    fn: async (_url: string, init: { body: string }) => {
      calls.push(init.body);
      const output = outputs[Math.min(i, outputs.length - 1)];
      i++;
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
  };
}

test("重试成功时，第一次的违规类别被保留下来", async () => {
  const bad = { ...baseAnalysis, summary: "她属于回避型依恋" }; // personality_diagnosis
  const mock = providerFetch([bad, baseAnalysis]);
  const provider = createDeepSeekProvider(config, { fetch: mock.fn });

  const outcome = await provider.interpret(request);
  assert.equal(outcome.boundary.retried, true);
  assert.deepEqual(outcome.boundary.violationCodes, ["personality_diagnosis"]);
  assert.equal(mock.calls.length, 2);
});

test("操纵性建议与伪精确概率分别记录类别", async () => {
  const manipulative = { ...baseAnalysis, nextAction: { direction: "故意冷淡三天，让她主动找你", principle: null } };
  const a = await createDeepSeekProvider(config, {
    fetch: providerFetch([manipulative, baseAnalysis]).fn,
  }).interpret(request);
  assert.deepEqual(a.boundary.violationCodes, ["manipulative_advice"]);

  const precise = { ...baseAnalysis, summary: "对方喜欢你 82%" };
  const b = await createDeepSeekProvider(config, {
    fetch: providerFetch([precise, baseAnalysis]).fn,
  }).interpret(request);
  assert.deepEqual(b.boundary.violationCodes, ["pseudo_precision"]);
});

test("结构损坏被记为 structural_invalid", async () => {
  const mock = providerFetch(["这不是 JSON", baseAnalysis]);
  const outcome = await createDeepSeekProvider(config, { fetch: mock.fn }).interpret(request);
  assert.deepEqual(outcome.boundary.violationCodes, ["structural_invalid"]);
  assert.equal(outcome.boundary.retried, true);
});

test("两次都违规时类别合并去重（第二次失败不吞掉第一次）", async () => {
  const bad = { ...baseAnalysis, summary: "她属于回避型依恋" };
  const mock = providerFetch([bad, bad]);
  const provider = createDeepSeekProvider(config, { fetch: mock.fn });
  await assert.rejects(
    () => provider.interpret(request),
    (error: unknown) => (error as { code?: string }).code === "boundary_violation",
  );
  assert.equal(mock.calls.length, 1 + 1, "重试上限仍为 1");
});

test("完全干净时 violationCodes 为空数组", async () => {
  const outcome = await createDeepSeekProvider(config, {
    fetch: providerFetch([baseAnalysis]).fn,
  }).interpret(request);
  assert.deepEqual(outcome.boundary.violationCodes, []);
  assert.equal(outcome.boundary.retried, false);
});

test("provider 端到端：返回结果里的截断 ID 已被归一化", async () => {
  const withIds = {
    ...baseAnalysis,
    latentIntent: {
      reading: "对方在 bbbbbbbb 中回答了自己的状态",
      basedOn: [],
      conflictsWith: [],
    },
  };
  const outcome = await createDeepSeekProvider(config, {
    fetch: providerFetch([withIds]).fn,
  }).interpret(request);
  assert.equal(
    outcome.analysis.latentIntent.reading,
    "对方在 第 2 条消息 中回答了自己的状态",
  );
  assert.deepEqual(findRawIds(outcome.analysis.latentIntent.reading), []);
});

// ---------------------------------------------------------------------------
// 4. 诊断统计
// ---------------------------------------------------------------------------

test("诊断统计能区分「模型本身干净」和「被保护层救回来」", () => {
  const stats = summarizeRuns([
    { accepted: true, retried: false, softenedFields: [], removedFields: [] },
    { accepted: true, retried: false, softenedFields: ["summary"], removedFields: [] },
    { accepted: true, retried: false, softenedFields: [], removedFields: ["latentIntent.reading"] },
    {
      accepted: true,
      retried: true,
      softenedFields: [],
      removedFields: [],
      violationCodes: ["personality_diagnosis"],
    },
    {
      accepted: false,
      retried: true,
      softenedFields: [],
      removedFields: [],
      violationCodes: ["manipulative_advice", "personality_diagnosis"],
    },
  ]);

  assert.equal(stats.total, 5);
  assert.equal(stats.rawCleanRate, 0.2, "只有第 1 条是原始就干净");
  assert.equal(stats.softenedRate, 0.2);
  assert.equal(stats.removedRate, 0.2);
  assert.equal(stats.retryRate, 0.4);
  assert.equal(stats.finalAcceptRate, 0.8, "5 条里 4 条最终可用");
  assert.deepEqual(stats.violationCodeCounts, {
    personality_diagnosis: 2,
    manipulative_advice: 1,
  });
});

test("空输入不会产生除零错误", () => {
  const stats = summarizeRuns([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.rawCleanRate, 0);
  assert.equal(stats.finalAcceptRate, 0);
  assert.deepEqual(stats.violationCodeCounts, {});
});

test("没有 violationCodes 字段的旧结果也能统计", () => {
  const stats = summarizeRuns([
    { accepted: true, retried: false, softenedFields: [], removedFields: [] },
  ]);
  assert.equal(stats.rawCleanRate, 1);
  assert.deepEqual(stats.violationCodeCounts, {});
});
