import { detectActivityEvents, recordActivityEvents } from "./events";
import { extractObservedFacts, observedMemoriesFromFacts } from "./facts";
import { mergeMemory } from "./memory";
import { computeSessionMetrics, latestSession } from "./patterns";
import {
  aggregateHabits,
  applyConfirmation,
  applyUserCorrection,
  candidatesFromAnalysis,
  computeFeedbackStats,
  deriveKnownPatterns,
  hasConversation,
  mergeInferenceCandidates,
  updateBaseline,
} from "./profile";
import {
  BASELINE_METRIC_KINDS,
  MAX_ACTIVITY_EVENTS,
  type BaselineMetricKind,
  type ConfirmationVerdict,
  type DeepAnalysis,
  type InterpretationFeedback,
  type Message,
  type Observation,
  type PersonProfile,
} from "./types";

/**
 * 档案变更的**纯函数编排层**。
 *
 * 这些函数从浏览器的 useProfile 控制器里抽出来，抽的时候是为了让服务端能
 * 直接调用；本机版回到浏览器里跑，仍然走同一份代码 —— 口径不会因为
 * 数据搬回本地就变两套。
 *
 * 保持纯函数：不读当前时间（`now` / `at` 由调用方传入）、不做 IO、
 * 不碰 localStorage，同样的输入必定得到同样的输出。
 */

/** 从会话指标里挑出进入长期基线的那几项。 */
function baselineMetrics(
  values: Partial<Record<string, number>>,
): Partial<Record<BaselineMetricKind, number>> {
  const out: Partial<Record<BaselineMetricKind, number>> = {};
  for (const kind of BASELINE_METRIC_KINDS) {
    const value = values[kind];
    if (typeof value === "number" && Number.isFinite(value)) out[kind] = value;
  }
  return out;
}

/** 会话涉及的消息集合：行为指标只看最近一轮，跨会话指标看整个窗口。 */
export function sessionScope(messages: Message[]): Message[] {
  const session = latestSession(messages);
  return session.length ? session : messages;
}

export type CommitConversationInput = {
  conversationId: string;
  messages: Message[];
  observations: Observation[];
  /** 第二层解读结果。没有时只做会话级更新（基线 / 习惯 / 事实 / 事件）。 */
  analysis?: DeepAnalysis | null;
  /** ISO 时间戳，用于记忆 */
  now: string;
  /** 毫秒时间戳，用于基线与衰减 */
  at: number;
};

/**
 * 把一段对话并入档案。
 *
 * 幂等：同一个 conversationId 重复提交不会重复累计基线样本，
 * 推断候选也按「对话 + 相似度」归并，不会因为重复分析而虚增。
 */
export function commitConversationToProfile(
  profile: PersonProfile,
  input: CommitConversationInput,
): PersonProfile {
  const target = sessionScope(input.messages);
  let next = profile;

  if (!hasConversation(next, input.conversationId)) {
    const metrics = baselineMetrics(
      computeSessionMetrics({
        messages: target,
        observations: input.observations,
        // 最近这一轮之外的会话只用于跨会话指标（对方主动开口比例）
        windowMessages: input.messages,
      }) as Partial<Record<string, number>>,
    );
    next = {
      ...next,
      behaviorBaseline: updateBaseline(next.behaviorBaseline, {
        conversationId: input.conversationId,
        metrics,
        at: input.at,
      }),
      habits: aggregateHabits(
        {
          messages: target,
          observations: input.observations,
          conversationId: input.conversationId,
          at: input.at,
        },
        next.habits,
      ),
      memories: mergeMemory(
        next.memories,
        observedMemoriesFromFacts(extractObservedFacts(target), input.now),
      ),
      activityEvents: recordActivityEvents(
        next.activityEvents,
        detectActivityEvents(target, input.conversationId, input.at),
        MAX_ACTIVITY_EVENTS,
      ),
      sourceConversationIds: [
        ...next.sourceConversationIds,
        input.conversationId,
      ].slice(-512),
    };
  }

  /**
   * 模型推断只累积候选，不产生长期结论；这条路径重复执行是幂等的。
   */
  if (input.analysis) {
    next = {
      ...next,
      inferenceCandidates: mergeInferenceCandidates(
        next.inferenceCandidates,
        candidatesFromAnalysis({
          analysis: input.analysis,
          conversationId: input.conversationId,
          at: input.at,
        }),
      ),
    };
  }

  return {
    ...next,
    knownPatterns: deriveKnownPatterns({
      baseline: next.behaviorBaseline,
      habits: next.habits,
      activityEvents: next.activityEvents,
      previous: next.knownPatterns,
      at: input.at,
    }),
    updatedAt: input.at,
  };
}

export type ConfirmInput = {
  contextKey: string;
  verdict: ConfirmationVerdict;
  confirmedParts: string[];
  analysis?: DeepAnalysis | null;
  now: string;
  at: number;
};

/**
 * 应用用户确认。
 * 只有用户明确勾选的部分会升级为 user_confirmed —— 这条语义没变。
 */
export function confirmInProfile(
  profile: PersonProfile,
  input: ConfirmInput,
): PersonProfile {
  const previous = profile.confirmations.find(
    (c) => c.contextKey === input.contextKey,
  );
  const confirmation = {
    // 同一次解读只保留最新一次确认：id 沿用旧的，保证幂等
    id: previous?.id ?? `confirm:${shortHash(input.contextKey)}`,
    contextKey: input.contextKey,
    verdict: input.verdict,
    confirmedParts: [...new Set(input.confirmedParts)],
    createdAt: input.now,
  };
  return applyConfirmation(profile, {
    confirmation,
    analysis: input.analysis ?? null,
    now: input.now,
    at: input.at,
  });
}

export type CorrectInput = {
  contextKey: string | null;
  content: string;
  contradictedIds: string[];
  now: string;
  at: number;
};

/**
 * 应用用户纠错。
 * 只标状态、绝不删除历史推断；user_confirmed 的内容不会被降级。
 */
export function correctInProfile(
  profile: PersonProfile,
  input: CorrectInput,
): PersonProfile {
  const content = input.content.trim();
  if (!content) return profile;
  const contradictedIds = [...new Set(input.contradictedIds)].sort();
  return applyUserCorrection(profile, {
    correction: {
      id: `correct:${shortHash(`${content}|${contradictedIds.join(",")}|${input.now}`)}`,
      contextKey: input.contextKey,
      content,
      contradictedIds,
      createdAt: input.now,
    },
    now: input.now,
    at: input.at,
  });
}

/** 删除单条记忆。 */
export function removeMemoryFromProfile(
  profile: PersonProfile,
  memoryId: string,
  at: number,
): PersonProfile {
  return {
    ...profile,
    memories: profile.memories.filter((m) => m.id !== memoryId),
    updatedAt: at,
  };
}

/** 清空历史基线，但保留记忆与推断候选。 */
export function resetBaselineInProfile(
  profile: PersonProfile,
  at: number,
): PersonProfile {
  return {
    ...profile,
    behaviorBaseline: {
      sampleCount: 0,
      conversationCount: 0,
      firstObservedAt: 0,
      lastObservedAt: 0,
      metrics: {},
    },
    sourceConversationIds: [],
    knownPatterns: profile.knownPatterns.map((p) =>
      p.sourceType === "deterministic"
        ? { ...p, status: "expired" as const }
        : p,
    ),
    updatedAt: at,
  };
}

/** 重算反馈统计（解读反馈 + 确认 + 纠错一起算，仅用于系统自我理解）。 */
export function applyFeedbackStats(
  profile: PersonProfile,
  interpretationFeedback: InterpretationFeedback[] = [],
): PersonProfile {
  return {
    ...profile,
    feedbackStats: computeFeedbackStats({
      interpretationFeedback,
      confirmations: profile.confirmations,
      corrections: profile.corrections,
    }),
  };
}

/** 稳定的小哈希，用于生成确定性 id（没有安全含义）。 */
function shortHash(text: string): string {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0).toString(36);
}
