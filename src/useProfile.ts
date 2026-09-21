import { useEffect, useMemo, useRef, useState } from "react";
import {
  latestSession,
  computeSessionMetrics,
} from "../shared/patterns";
import {
  aggregateHabits,
  applyConfirmation,
  applyUserCorrection,
  baselineStatus,
  baselineStatusLabel,
  candidatesFromAnalysis,
  computeFeedbackStats,
  computeHistoricalTrend,
  deriveKnownPatterns,
  emptyProfile,
  establishedHabits,
  findConflictingInferences,
  hasConversation,
  mergeInferenceCandidates,
  profileIdFor,
  updateBaseline,
} from "../shared/profile";
import { extractObservedFacts, observedMemoriesFromFacts } from "../shared/facts";
import { detectActivityEvents, recordActivityEvents } from "../shared/events";
import { mergeMemory } from "../shared/memory";
import { retrieveRelevantProfileContext } from "../shared/retrieval";
import {
  contextFromRelation,
  BASELINE_METRIC_KINDS,
  MAX_ACTIVITY_EVENTS,
  type BaselineMetricKind,
  type BaselineStatus,
  type ConfirmationVerdict,
  type DeepAnalysis,
  type HistoricalPatternTrend,
  type LongTermMemory,
  type Message,
  type Observation,
  type Pattern,
  type PersonProfile,
  type ProfileContextBundle,
  type Relation,
  type RelationshipContext,
} from "../shared/types";
import {
  adoptLegacyMemories,
  clearLongTerm,
  clearBaseline,
  deleteMemory,
  deleteProfile,
  getProfile,
  loadInterpretationFeedback,
  loadProfiles,
  resolveStorage,
  saveProfiles,
  upsertProfile,
  type StorageLike,
} from "./storage";

/**
 * 第三阶段：本地长期档案（PersonProfile）控制器。
 *
 * 这里是 local-first 的边界：
 *   - 基线的**更新**只发生在浏览器里，用 shared/profile.ts 的纯函数；
 *   - 服务端只收到一次请求的检索子集，用完即弃，不落盘；
 *   - 记忆的来源等级只能由用户确认提升，模型推断永远不能自动变成事实。
 *
 * 控制器不依赖 React，缓存、幂等、删除能力都能被直接测试。
 */

/** 内容指纹：不依赖随机生成的 message id，重新粘贴同一段聊天会得到同一个 id。 */
export function conversationIdFor(
  relation: Relation,
  session: Message[],
): string {
  const first = session[0];
  if (!first) return `conv:${relation}:empty`;
  const seed = `${relation}|${first.sender}|${first.timestamp ?? ""}|${first.text}`;
  let h = 2_166_136_261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return `conv:${(h >>> 0).toString(36)}`;
}

export type ProfileIdentity = {
  displayName: string;
  relation: Relation;
  relationshipContext?: RelationshipContext;
};

export type CommitInput = {
  conversationId: string;
  messages: Message[];
  observations: Observation[];
  analysis?: DeepAnalysis | null;
  /** ISO 时间戳，用于记忆 */
  now: string;
  /** 毫秒时间戳，用于基线与衰减 */
  at: number;
};

export type ConfirmInput = {
  contextKey: string;
  verdict: ConfirmationVerdict;
  confirmedParts: string[];
  analysis?: DeepAnalysis | null;
  now: string;
  at: number;
};

export type CorrectInput = {
  contextKey: string | null;
  content: string;
  contradictedIds: string[];
  now: string;
  at: number;
};

export type ProfileStore = {
  getProfile(): PersonProfile | null;
  subscribe(listener: (profile: PersonProfile | null) => void): () => void;
  /** 切换当前关注的人。会按需建立档案并收编第二阶段的遗留记忆。 */
  useIdentity(identity: ProfileIdentity): PersonProfile | null;
  commit(input: CommitInput): PersonProfile | null;
  confirm(input: ConfirmInput): PersonProfile | null;
  correct(input: CorrectInput): PersonProfile | null;
  suggestConflicts(content: string): LongTermMemory[];
  retrieve(input: {
    messages: Message[];
    observations: Observation[];
  }): ProfileContextBundle | null;
  history(input: {
    messages: Message[];
    observations: Observation[];
  }): HistoricalPatternTrend | null;
  /** 只删档案，不动原始聊天记录。 */
  removeProfile(): void;
  /** 只清基线，记忆与推理候选保留。 */
  resetBaseline(): void;
  removeMemory(memoryId: string): void;
  /** 清空全部长期数据，仍然不动原始聊天记录。 */
  clearAll(): void;
  setRelationshipContext(context: RelationshipContext): void;
};

const toBaselineMetrics = (
  values: Partial<Record<string, number>>,
): Partial<Record<BaselineMetricKind, number>> => {
  const out: Partial<Record<BaselineMetricKind, number>> = {};
  for (const kind of BASELINE_METRIC_KINDS) {
    const value = values[kind];
    if (typeof value === "number" && Number.isFinite(value)) out[kind] = value;
  }
  return out;
};

export function createProfileStore(deps: {
  storage?: StorageLike;
  now: () => number;
  id?: () => string;
}): ProfileStore {
  const storage = deps.storage;
  const makeId = deps.id ?? (() => `${deps.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const listeners = new Set<(profile: PersonProfile | null) => void>();
  let profile: PersonProfile | null = null;

  const emit = () => listeners.forEach((l) => l(profile));
  const persist = (next: PersonProfile) => {
    const existing = loadProfiles(storage);
    const index = existing.findIndex((p) => p.id === next.id);
    const list = [...existing];
    if (index < 0) list.push(next);
    else list[index] = next;
    saveProfiles(list, storage);
  };

  /** 反馈统计把「解读反馈」也一起算进来：它同样是本地数据。 */
  const withStats = (next: PersonProfile): PersonProfile => ({
    ...next,
    feedbackStats: computeFeedbackStats({
      interpretationFeedback: loadInterpretationFeedback(storage),
      confirmations: next.confirmations,
      corrections: next.corrections,
    }),
  });

  const apply = (next: PersonProfile | null) => {
    if (!next) return null;
    profile = withStats(next);
    persist(profile);
    emit();
    return profile;
  };

  return {
    getProfile: () => profile,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    useIdentity(identity) {
      const id = profileIdFor({
        displayName: identity.displayName,
        relation: identity.relation,
      });
      const existing = getProfile(id, storage);
      if (existing) {
        profile = withStats(existing);
        emit();
        return profile;
      }
      const created = emptyProfile({
        id,
        displayName: identity.displayName,
        relationshipContext:
          identity.relationshipContext ??
          contextFromRelation(identity.relation),
        at: deps.now(),
      });
      upsertProfile(created, storage);
      // 一次性收编第二阶段遗留的扁平记忆（如果有）
      adoptLegacyMemories(id, storage);
      profile = withStats(getProfile(id, storage) ?? created);
      emit();
      return profile;
    },

    commit(input) {
      if (!profile) return null;
      const session = latestSession(input.messages);
      const target = session.length ? session : input.messages;
      let next = profile;

      // A. 会话级：基线 / 表达习惯 / 客观事实。这些都不需要第二层。
      if (!hasConversation(next, input.conversationId)) {
        const metrics = toBaselineMetrics(
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
          // 确定性事件统计：邀约与答复，只做关键词归类，不做任何推断
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
       * B. 解读级：只累积推断候选。
       * 模型自由文本不再产生长期记忆，也不参与长期模式晋升 ——
       * 它只能作为解释辅助，或被用户确认后才升级。
       * 重复提交同一段对话这里仍然是幂等的。
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

      return apply({
        ...next,
        knownPatterns: deriveKnownPatterns({
          baseline: next.behaviorBaseline,
          habits: next.habits,
          activityEvents: next.activityEvents,
          previous: next.knownPatterns,
          at: input.at,
        }),
        updatedAt: input.at,
      });
    },

    confirm(input) {
      if (!profile) return null;
      const contextKey = input.contextKey;
      if (!contextKey) return null;
      // 同一次解读只保留最新的一次确认
      const previous = profile.confirmations.find(
        (c) => c.contextKey === contextKey,
      );
      const confirmation = {
        id: previous?.id ?? `confirm:${makeId()}`,
        contextKey,
        verdict: input.verdict,
        confirmedParts: [...new Set(input.confirmedParts)],
        createdAt: input.now,
      };
      return apply(
        applyConfirmation(profile, {
          confirmation,
          analysis: input.analysis ?? null,
          now: input.now,
          at: input.at,
        }),
      );
    },

    correct(input) {
      if (!profile) return null;
      return apply(
        applyUserCorrection(profile, {
          correction: {
            id: `correct:${makeId()}`,
            contextKey: input.contextKey,
            content: input.content.trim(),
            contradictedIds: [...new Set(input.contradictedIds)],
            createdAt: input.now,
          },
          now: input.now,
          at: input.at,
        }),
      );
    },

    suggestConflicts(content) {
      if (!profile) return [];
      return findConflictingInferences(profile.memories, content);
    },

    retrieve(input) {
      if (!profile) return null;
      return retrieveRelevantProfileContext({
        profile,
        messages: input.messages,
        observations: input.observations,
      });
    },

    history(input) {
      if (!profile) return null;
      const session = latestSession(input.messages);
      const target = session.length ? session : input.messages;
      return computeHistoricalTrend(
        profile.behaviorBaseline,
        toBaselineMetrics(
          computeSessionMetrics({
            messages: target,
            observations: input.observations,
            windowMessages: input.messages,
          }) as Partial<Record<string, number>>,
        ),
      );
    },

    removeProfile() {
      if (!profile) return;
      deleteProfile(profile.id, storage);
      profile = null;
      emit();
    },

    resetBaseline() {
      if (!profile) return;
      const list = clearBaseline(profile.id, storage);
      const next = list.find((p) => p.id === profile?.id) ?? null;
      if (next) apply(next);
    },

    removeMemory(memoryId) {
      if (!profile) return;
      const list = deleteMemory(profile.id, memoryId, storage);
      const next = list.find((p) => p.id === profile?.id) ?? null;
      if (next) apply(next);
    },

    clearAll() {
      clearLongTerm(storage);
      profile = null;
      emit();
    },

    setRelationshipContext(context) {
      if (!profile) return;
      apply({ ...profile, relationshipContext: context });
    },
  };
}

/** 当前状态是否已经积累了足够的历史。 */
export type ProfileUiState = {
  profile: PersonProfile | null;
  status: BaselineStatus;
  statusLabel: string;
  /** 已确认事实（sourceType=user_confirmed） */
  confirmed: LongTermMemory[];
  observed: LongTermMemory[];
  inferred: LongTermMemory[];
  unresolved: LongTermMemory[];
  habits: PersonProfile["habits"];
  knownPatterns: PersonProfile["knownPatterns"];
  conversations: number;
  feedbackStats: PersonProfile["feedbackStats"];
  estimatedTokens: number;
};

export function profileUiState(
  profile: PersonProfile | null,
  estimatedTokens = 0,
): ProfileUiState {
  const status = baselineStatus(profile?.behaviorBaseline);
  const memories = profile?.memories ?? [];
  const active = memories.filter((m) => m.status === "active");
  return {
    profile,
    status,
    statusLabel: baselineStatusLabel(
      status,
      profile?.behaviorBaseline.conversationCount ?? 0,
    ),
    confirmed: active.filter((m) => m.sourceType === "user_confirmed"),
    observed: active.filter((m) => m.sourceType === "observed"),
    /**
     * 模型推测只列出候选，而且明确标注「不作为长期结论」。
     * 它们不会再自动变成记忆或模式。
     */
    inferred: [...(profile?.inferenceCandidates ?? [])]
      .sort(
        (a, b) =>
          b.observationCount - a.observationCount || a.id.localeCompare(b.id),
      )
      .slice(0, 4)
      .map((candidate) => ({
        id: candidate.id,
        kind: "pattern" as const,
        content: candidate.content,
        sourceMessageIds: candidate.sourceMessageIds,
        createdAt: new Date(candidate.firstSeenAt).toISOString(),
        lastConfirmedAt: new Date(candidate.lastSeenAt).toISOString(),
        status: "active" as const,
        confidence: candidate.confidence,
        sourceType: "model_inferred" as const,
      })),
    unresolved: active.filter((m) => m.kind === "unresolved"),
    // 只把已经稳定的表达习惯展示给用户；计数不够的仍然留在档案里继续累积
    habits: establishedHabits(profile?.habits ?? []),
    knownPatterns:
      profile?.knownPatterns.filter((p) => p.status === "active") ?? [],
    conversations: profile?.behaviorBaseline.conversationCount ?? 0,
    feedbackStats: profile?.feedbackStats ?? computeFeedbackStats({}),
    estimatedTokens,
  };
}

/** 还没有任何历史时，明确告诉用户「我不认识这个人」。 */
export function coldStartNotice(status: BaselineStatus): string | null {
  if (status === "none" || status === "insufficient")
    return "历史样本还不足，当前只能基于这次对话分析。系统不会假装已经认识这个人。";
  return null;
}

/**
 * React 包装（localStorage 版）。
 *
 * **第四阶段之后应用不再使用它**：长期档案的真相源已搬到服务端 SQLite，
 * 界面走 `src/useWorkspace.ts`。这里保留是为了：
 *   1. 读取旧版本遗留的本地档案（迁移用，见 storage.ts 的 detectLegacyProfile）；
 *   2. 让第三阶段的回归测试继续能直接驱动控制器。
 * 新代码请不要再用它写长期数据。
 */
export function useProfile(identity: ProfileIdentity) {
  const storage = useMemo(() => resolveStorage() ?? undefined, []);
  const controllerRef = useRef<ProfileStore | null>(null);
  if (!controllerRef.current)
    controllerRef.current = createProfileStore({
      storage,
      now: () => Date.now(),
    });
  const [profile, setProfile] = useState<PersonProfile | null>(null);

  useEffect(() => {
    const controller = controllerRef.current!;
    return controller.subscribe(setProfile);
  }, []);

  useEffect(() => {
    controllerRef.current!.useIdentity(identity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.displayName, identity.relation, identity.relationshipContext]);

  const controller = controllerRef.current;

  const retrieve = useMemo(
    () =>
      (input: { messages: Message[]; observations: Observation[] }) =>
        controller.retrieve(input),
    [controller],
  );

  return {
    profile,
    retrieve,
    history: (input: { messages: Message[]; observations: Observation[] }) =>
      controller.history(input),
    commit: (input: CommitInput) => controller.commit(input),
    confirm: (input: ConfirmInput) => controller.confirm(input),
    correct: (input: CorrectInput) => controller.correct(input),
    suggestConflicts: (content: string) => controller.suggestConflicts(content),
    removeProfile: () => controller.removeProfile(),
    resetBaseline: () => controller.resetBaseline(),
    removeMemory: (id: string) => controller.removeMemory(id),
    clearAll: () => controller.clearAll(),
    setRelationshipContext: (context: RelationshipContext) =>
      controller.setRelationshipContext(context),
  };
}

/** 供 UI 复用的历史趋势：给定基线与会话指标，算「这次和她平时比」。 */
export function historyForSession(input: {
  profile: PersonProfile | null;
  messages: Message[];
  observations: Observation[];
  patterns?: Pattern[];
}): HistoricalPatternTrend | null {
  if (!input.profile) return null;
  const session = latestSession(input.messages);
  const target = session.length ? session : input.messages;
  return computeHistoricalTrend(
    input.profile.behaviorBaseline,
    toBaselineMetrics(
      computeSessionMetrics({
        messages: target,
        observations: input.observations,
        windowMessages: input.messages,
      }) as Partial<Record<string, number>>,
    ),
  );
}
