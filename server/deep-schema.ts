import { z } from "zod";
import { DEEP_CONTEXT_WINDOW } from "../shared/types";

/**
 * 第二层（深度分析）请求契约。
 *
 * 单独一个模块，是因为它必须能被测试直接导入：
 * `server/index.ts` 在导入时就 `app.listen`，测试里 import 它会留下一个不会关闭的监听。
 * 这里只有纯 schema，没有任何副作用。
 */

export const apiMessageSchema = z.object({
  id: z.string().min(1).max(80),
  sender: z.enum(["self", "other"]),
  text: z.string().min(1).max(24000),
  timestamp: z.string().max(80).nullable(),
  kind: z.enum(["text", "unreadable"]),
  mediaKind: z
    .enum([
      "voice",
      "image",
      "video",
      "sticker",
      "file",
      "location",
      "link",
      "other",
    ])
    .optional(),
});

export const observationSchema = z.object({
  messageId: z.string().min(1).max(80),
  emotions: z.record(z.number()),
  intents: z.record(z.number()),
  score: z.unknown().nullable(),
  model: z.string().max(80),
  observedAt: z.string().max(80),
});

export const memorySchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum([
    "fact",
    "event",
    "preference",
    "boundary",
    "pattern",
    "unresolved",
  ]),
  content: z.string().min(1).max(600),
  sourceMessageIds: z.array(z.string().max(80)).max(50),
  createdAt: z.string().max(80),
  lastConfirmedAt: z.string().max(80),
  status: z.enum([
    "active",
    "archived",
    "contradicted",
    "superseded",
    "expired",
  ]),
  confidence: z.number().min(0).max(1),
  sourceType: z.enum(["observed", "model_inferred", "user_confirmed"]),
});

const taggedMemorySchema = z.object({
  source: z.enum(["USER_CONFIRMED", "OBSERVED", "MODEL_INFERRED"]),
  kind: z.enum([
    "fact",
    "event",
    "preference",
    "boundary",
    "pattern",
    "unresolved",
  ]),
  content: z.string().max(600),
  confidence: z.number().min(0).max(1),
});

const baselineMetricSchema = z.object({
  mean: z.number(),
  median: z.number().optional(),
  variance: z.number().optional(),
  sampleCount: z.number(),
  updatedAt: z.number(),
  weightSum: z.number(),
  weightedSum: z.number(),
  recent: z.array(z.number()).max(64),
  recentConversationIds: z.array(z.string().max(80)).max(64),
  lastValue: z.number().optional(),
  previousMean: z.number().optional(),
  previousMedian: z.number().optional(),
  previousSampleCount: z.number().optional(),
});

/**
 * 跨会话检索结果。
 *
 * 全部数字（基线、历史 delta、模式阈值）都由服务端用 shared 的纯函数
 * 重新计算，客户端带上来的一律只当输入。所以这里只校验结构，不采信语义。
 */
const profileBundleSchema = z.object({
  baselineStatus: z.enum(["none", "insufficient", "developing", "established"]),
  comparedConversations: z.number(),
  baseline: z.object({
    sampleCount: z.number(),
    conversationCount: z.number(),
    firstObservedAt: z.number(),
    lastObservedAt: z.number(),
    metrics: z.record(baselineMetricSchema),
  }),
  confirmed: z.array(taggedMemorySchema).max(200),
  currentFacts: z.array(taggedMemorySchema).max(200),
  observed: z.array(taggedMemorySchema).max(200),
  inferred: z.array(taggedMemorySchema).max(200),
  habits: z
    .array(
      z.object({
        expression: z.string().max(120),
        observedCount: z.number(),
        conversationCount: z.number(),
        contexts: z.array(z.string().max(120)).max(16),
        usualMeaning: z.string().max(600),
        confidence: z.enum(["low", "medium", "high"]),
        lastObservedAt: z.number(),
        conversationIds: z.array(z.string().max(80)).max(64),
        countsByConversation: z.record(z.number()),
      }),
    )
    .max(64),
  knownPatterns: z
    .array(
      z.object({
        id: z.string().max(80),
        patternKey: z.string().max(120),
        description: z.string().max(600),
        evidenceCount: z.number(),
        conversationCount: z.number(),
        sourceType: z.enum(["deterministic", "user_confirmed", "model_inferred"]),
        supportingMetrics: z.array(z.string().max(80)).max(12),
        firstObservedAt: z.number(),
        lastObservedAt: z.number(),
        status: z.enum([
          "active",
          "archived",
          "contradicted",
          "superseded",
          "expired",
        ]),
      }),
    )
    .max(64),
  unresolved: z.array(taggedMemorySchema).max(200),
  corrections: z.array(z.string().max(600)).max(256),
  estimatedTokens: z.number(),
  truncated: z.boolean(),
  trimmed: z.array(z.string().max(80)).max(32).optional(),
  historicalTrend: z.unknown().optional(),
});

const relationshipContextSchema = z.object({
  type: z.enum([
    "new",
    "friend",
    "close_friend",
    "crush",
    "dating",
    "couple",
    "coworker",
    "family",
    "other",
  ]),
  durationDays: z.number().int().nonnegative().max(40000).optional(),
  closeness: z.enum(["low", "medium", "high", "unknown"]),
  contactFrequency: z.enum([
    "rare",
    "weekly",
    "several_per_week",
    "daily",
    "very_frequent",
    "unknown",
  ]),
  usualTone: z.array(z.string().max(60)).max(12),
  knownPatterns: z.array(z.string().max(120)).max(20),
  recentContext: z.array(z.string().max(120)).max(20),
  sourceType: z.enum(["user_provided", "observed", "mixed"]),
});

export const deepRequestSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    relation: z.enum(["crush", "new", "couple"]),
    targetId: z.string().max(80).nullable(),
    /**
     * 本机版没有服务端聊天记录：消息一律由浏览器随请求带来。
     *
     * 刻意**不**在这里写 `.min(1)`：字段级的"必须有内容"会在「空数组 + 别的
     * 有效输入」这种组合上把请求直接打成 400。空数组本身是无害的
     * （`server/index.ts` 里用 `data.messages ?? []` 取值，再由下面的 refine 兜底）。
     * 「这次请求到底有没有可分析的内容」统一由对象级校验判断。
     */
    messages: z.array(apiMessageSchema).max(DEEP_CONTEXT_WINDOW * 3).optional(),
    observations: z.array(observationSchema).max(2000).optional(),
    memory: z.array(memorySchema).max(200).optional(),
    relationshipContext: relationshipContextSchema.optional(),
    profile: profileBundleSchema.optional(),
  })
  .refine((v) => Boolean(v.messages?.length), {
    message: "本机版需要请求自带消息（messages 不能为空）",
  });
