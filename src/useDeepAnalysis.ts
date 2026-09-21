import { useEffect, useMemo, useRef, useState } from "react";
import { boundedContext, relevantEvents } from "../shared/memory";
import { retrieveRelevantProfileContext } from "../shared/retrieval";
import { buildTranslation } from "../shared/translation";
import {
  DEEP_ANALYSIS_DEFAULT_MODEL,
  DEEP_ANALYSIS_PROMPT_VERSION,
  deepContextKey,
  type DeepAnalysis,
  type DeepAnalysisRequest,
  type DeepAnalysisResponse,
  type HistoricalPatternTrend,
  type LineResult,
  type LongTermMemory,
  type Message,
  type Observation,
  type PersonProfile,
  type ProfileContextBundle,
  type Relation,
  type UserTranslation,
} from "../shared/types";

/**
 * 第二层（深度解读）的前端控制器。
 *
 * 与 useAnalysis 完全独立：第一层和第二层各自管理自己的状态，
 * 第二层从不自动触发，只有用户点击才会发出请求。
 *
 * 核心逻辑被拆成一个不依赖 React 的 controller，
 * 这样缓存失效、身份校验、stale 行为、过期请求取消都能被直接测试。
 */

export type DeepUiStatus =
  | "idle"
  | "loading"
  | "success"
  | "error"
  | "disabled"
  | "not_configured";

export type DeepAvailability =
  | "unknown"
  | "ready"
  | "disabled"
  | "not_configured";

/**
 * 第二层的身份：模型 + prompt 版本。
 * 两者都必须与服务端实际使用的一致，否则缓存会被错误复用。
 */
export type DeepIdentity = { model: string; promptVersion: number };

/** 服务端身份未知时的兜底值。 */
export const DEFAULT_DEEP_IDENTITY: DeepIdentity = {
  model: DEEP_ANALYSIS_DEFAULT_MODEL,
  promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
};

export type DeepInput = {
  /** 当前已导入的全部消息 */
  messages: Message[];
  relation: Relation;
  /** 当前关注的目标消息，null 表示整段对话 */
  targetId: string | null;
  /** 第一层的逐句结果，用作 observations */
  lines: Record<string, LineResult>;
  /** 第一层模型名，写进 observation 记录 */
  observationModel: string;
  memory?: LongTermMemory[];
  /**
   * 第三阶段：本地长期档案。
   * 检索在这里发生（需要当前观察），检索结果会随请求一起送出；
   * 服务端只读不存。
   */
  profile?: PersonProfile | null;
  /**
   * 第四阶段：对话在服务端的 id。
   * 有它时服务端从 SQLite 读消息与档案，客户端只负责发起与展示。
   */
  conversationId?: string | null;
};

export type DeepFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type DeepResult = {
  analysis: DeepAnalysis | null;
  translation: UserTranslation | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  latencyMs: number;
  model: string;
  promptVersion: number;
  /** 服务端算出的跨会话历史趋势（这次 vs 她平时） */
  historicalTrend?: HistoricalPatternTrend | null;
  /** 这次请求实际送出的检索上下文，用于「为什么系统这样认为」 */
  profileContext?: ProfileContextBundle | null;
};

export type DeepControllerState = {
  status: DeepUiStatus;
  /** 当前已展示结果对应的 contextKey */
  resultKey: string;
  /**
   * 当前展示的结果。注意：它可能是 stale 的 ——
   * 输入变化后我们不立即清空，而是保留展示并标记 isStale。
   */
  result: DeepResult | null;
  /** 展示中的结果是否基于较早的输入 */
  isStale: boolean;
  error: string;
  /** 第二层是否可用，启动时探测一次 */
  availability: DeepAvailability;
  /** 服务端实际使用的第二层身份，探测后才有值 */
  identity: DeepIdentity | null;
};

const IDLE: DeepControllerState = {
  status: "idle",
  resultKey: "",
  result: null,
  isStale: false,
  error: "",
  availability: "unknown",
  identity: null,
};

/** 把第一层的逐句结果转换成 observation 记录。 */
export function buildObservations(
  messages: Message[],
  lines: Record<string, LineResult>,
  model: string,
  now: string,
): Observation[] {
  return messages
    .filter((m) => m.kind === "text" && lines[m.id])
    .map((m) => {
      const line = lines[m.id];
      return {
        messageId: m.id,
        emotions: line.emotions ?? {},
        intents: line.intents ?? {},
        score: line.score ?? null,
        model,
        observedAt: now,
      };
    });
}

/**
 * 检索结果的稳定指纹，用于缓存失效。
 * 刻意不含 estimatedTokens / truncated 这类派生的体积字段。
 */
export function profileSignature(bundle: ProfileContextBundle): string {
  return JSON.stringify({
    status: bundle.baselineStatus,
    conversations: bundle.comparedConversations,
    baseline: bundle.baseline.metrics,
    confirmed: bundle.confirmed.map((m) => [m.source, m.content]),
    observed: bundle.observed.map((m) => [m.source, m.content]),
    inferred: bundle.inferred.map((m) => [m.source, m.content]),
    unresolved: bundle.unresolved.map((m) => [m.source, m.content]),
    habits: bundle.habits.map((h) => [h.expression, h.observedCount, h.usualMeaning]),
    patterns: bundle.knownPatterns.map((p) => [
      p.id,
      p.status,
      p.sourceType,
      p.evidenceCount,
    ]),
    corrections: bundle.corrections,
  });
}

/**
 * 构造第二层请求与其缓存键。
 *
 * 关键：缓存键里的 model / promptVersion 必须来自**服务端实际身份**，
 * 不能用前端常量硬编码 —— 否则服务端换了模型，前端会复用旧模型的解读。
 * 第三阶段的跨会话上下文同样参与缓存键：基线变了就不能复用旧解读。
 */
export function buildDeepRequest(
  input: DeepInput,
  now: string,
  identity: DeepIdentity = DEFAULT_DEEP_IDENTITY,
): {
  key: string;
  /**
   * 只由「这段对话本身」决定的键。
   * 跨会话基线变化不应该让当前解读变成 stale —— 那只是本地多记了一点历史，
   * 聊天内容并没有变。两者的区别靠这两个键分开表达。
   */
  inputKey: string;
  request: DeepAnalysisRequest;
  contextMessages: Message[];
  identity: DeepIdentity;
  profileContext: ProfileContextBundle | null;
} {
  const contextMessages = boundedContext(input.messages);
  const observations = buildObservations(
    contextMessages,
    input.lines,
    input.observationModel,
    now,
  );
  /**
   * 本机版：服务端没有聊天记录，也没有档案。
   * 消息与检索出来的跨会话上下文都必须随请求带上去 ——
   * 前端就是长期数据的唯一来源，服务端只读不存、用完即弃。
   */
  const memory = input.memory ?? [];
  const relevant = relevantEvents(memory, contextMessages);
  const profileContext = input.profile
    ? retrieveRelevantProfileContext({
        profile: input.profile,
        messages: contextMessages,
        observations,
      })
    : null;
  const signature = profileContext ? profileSignature(profileContext) : undefined;
  const base = {
    model: identity.model,
    promptVersion: identity.promptVersion,
    relation: input.relation,
    analysisMode: input.targetId ? "targeted" : "conversation",
    messages: contextMessages,
    memory: relevant,
    observations,
    conversationId: input.conversationId ?? null,
  };
  const key = deepContextKey({ ...base, profileSignature: signature });
  const inputKey = deepContextKey(base);
  const request: DeepAnalysisRequest = {
    revision: 1,
    relation: input.relation,
    targetId: input.targetId,
    messages: contextMessages,
    observations,
    // patterns 由服务端用 computePatterns 重新计算，这里不传
    memory: relevant,
    patterns: [],
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(profileContext ? { profile: profileContext } : {}),
  };
  return { key, inputKey, request, contextMessages, identity, profileContext };
}

/** /api/health 响应里第二层相关的字段 */
export type DeepHealth = {
  enabled?: boolean;
  configured?: boolean;
  model?: string;
  promptVersion?: number;
};

export type DeepController = {
  getState(): DeepControllerState;
  subscribe(listener: (state: DeepControllerState) => void): () => void;
  /** 启动时探测第二层可用性与实际身份。只读 /api/health，不发起任何模型调用。 */
  probe(): Promise<void>;
  /**
   * 输入变化时调用：取消在途请求、把当前结果标记为 stale，
   * 但不清空展示，也不自动重跑。
   */
  invalidate(): void;
  /** 用户点击深度解读 */
  run(key: string, request: DeepAnalysisRequest): Promise<void>;
  cancel(): void;
  /** 仅供测试与调试 */
  stats(): { calls: number; cached: number; aborted: number };
  reset(): void;
};

/**
 * 创建一个第二层控制器。
 * fetch / fetchHealth / now 全部注入：测试无需真实网络，也不会调用 DeepSeek。
 */
export function createDeepController(deps: {
  fetch: DeepFetch;
  now: () => string;
  fetchHealth?: () => Promise<unknown>;
}): DeepController {
  const cache = new Map<string, DeepResult>();
  const listeners = new Set<(state: DeepControllerState) => void>();
  let state: DeepControllerState = IDLE;
  let controller: AbortController | null = null;
  let inflightKey: string | null = null;
  let calls = 0;
  let aborted = 0;

  const emit = () => listeners.forEach((l) => l(state));
  const set = (patch: Partial<DeepControllerState>) => {
    state = { ...state, ...patch };
    emit();
  };

  /** 当前生效的身份：探测结果优先，未知时用兜底常量。 */
  const identity = () => state.identity ?? DEFAULT_DEEP_IDENTITY;

  /** 结果是否与当前服务端身份一致。 */
  const matchesIdentity = (result: DeepResult) => {
    const id = identity();
    return (
      result.model === id.model && result.promptVersion === id.promptVersion
    );
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats: () => ({ calls, cached: cache.size, aborted }),

    async probe() {
      if (!deps.fetchHealth) return;
      try {
        const payload = (await deps.fetchHealth()) as {
          deep?: DeepHealth;
        } | null;
        const deep = payload?.deep;
        if (!deep) return;

        const nextIdentity: DeepIdentity | null =
          typeof deep.model === "string" && deep.model
            ? {
                model: deep.model,
                promptVersion:
                  typeof deep.promptVersion === "number"
                    ? deep.promptVersion
                    : DEFAULT_DEEP_IDENTITY.promptVersion,
              }
            : null;

        if (!deep.enabled) {
          set({
            availability: "disabled",
            status: "disabled",
            error: "深度解读尚未启用",
            identity: nextIdentity,
          });
        } else if (!deep.configured) {
          set({
            availability: "not_configured",
            status: "not_configured",
            error: "深度解读尚未配置",
            identity: nextIdentity,
          });
        } else {
          set({ availability: "ready", identity: nextIdentity });
        }
      } catch {
        /* 探测失败不改变任何既有状态 */
      }
    },

    invalidate() {
      if (controller) {
        controller.abort();
        controller = null;
        aborted++;
      }
      inflightKey = null;
      if (state.result) {
        // 保留已展示内容，只标记过期。绝不自动重跑，也不清空。
        set({ isStale: true, error: "" });
      } else {
        set({ status: "idle", isStale: false, error: "" });
      }
    },

    cancel() {
      if (controller) {
        controller.abort();
        controller = null;
        aborted++;
      }
      inflightKey = null;
      set({ status: state.result ? "success" : "idle", error: "" });
    },

    reset() {
      cache.clear();
      if (controller) {
        controller.abort();
        controller = null;
        aborted++;
      }
      inflightKey = null;
      state = { ...IDLE, availability: state.availability, identity: state.identity };
      emit();
    },

    async run(key, request) {
      // 同一个 contextKey 已有**身份匹配**的结果：直接复用，不再发请求
      const cached = cache.get(key);
      if (cached && matchesIdentity(cached)) {
        set({
          status: "success",
          resultKey: key,
          result: cached,
          isStale: false,
          error: "",
        });
        return;
      }
      // 身份不匹配的旧缓存必须丢弃
      if (cached) cache.delete(key);
      // 同一个 contextKey 正在请求中：忽略重复点击
      if (inflightKey === key && state.status === "loading") return;

      if (controller) {
        controller.abort();
        aborted++;
      }
      const ctrl = new AbortController();
      controller = ctrl;
      inflightKey = key;
      set({ status: "loading", error: "" });

      try {
        calls++;
        const response = await deps.fetch("/api/deep-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: ctrl.signal,
        });
        const data = (await response.json()) as DeepAnalysisResponse;
        // 过期请求：期间输入已变化或被取消
        if (ctrl.signal.aborted || inflightKey !== key) return;

        if (data.status === "disabled") {
          set({ status: "disabled", error: data.error ?? "深度解读尚未启用" });
          return;
        }
        if (data.status === "not_configured") {
          set({
            status: "not_configured",
            error: data.error ?? "深度解读尚未配置",
          });
          return;
        }
        if (data.status !== "ok" || !data.analysis) {
          // 失败时保留旧结果与 stale 标记，用户可以继续查看
          set({
            status: "error",
            error: data.error ?? "深度解读未完成，请稍后重试",
          });
          return;
        }

        const result: DeepResult = {
          analysis: data.analysis,
          // 用户主要看到的是翻译层，而不是第二层原始 JSON。
          // 传入程序算出的互动趋势，让翻译层能做外部原因修正；
          // 再传入历史趋势，让翻译层能生成「和她平时相比」。
          translation: buildTranslation(
            data.analysis,
            data.patternTrend,
            data.historicalTrend,
          ),
          usage: data.usage,
          latencyMs: data.latencyMs,
          model: data.model,
          promptVersion: data.promptVersion,
          historicalTrend: data.historicalTrend ?? null,
          profileContext: request.profile ?? null,
        };

        // 写入缓存前再次校验身份：模型或 prompt 版本不一致一律不写
        if (matchesIdentity(result)) cache.set(key, result);

        set({
          status: "success",
          resultKey: key,
          result,
          isStale: false,
          error: "",
        });
      } catch (error) {
        if (ctrl.signal.aborted) return;
        // 失败不清空旧结果，stale 标记保持不变
        set({
          status: "error",
          error:
            (error as Error)?.name === "AbortError"
              ? "已取消"
              : "深度解读未完成，请稍后重试",
        });
      } finally {
        if (inflightKey === key) inflightKey = null;
        if (controller === ctrl) controller = null;
      }
    },
  };
}

/** 默认 fetch：只走本地 server，API key 永远不出现在前端。 */
const browserFetch: DeepFetch = (input, init) =>
  fetch(input, init) as unknown as ReturnType<DeepFetch>;

/**
 * React 包装。
 *
 * 输入变化时：取消在途请求、把已有结果标记为 stale，但**保留展示**，
 * 且不会自动重新请求 —— 必须由用户再次点击。
 */
export function useDeepAnalysis(input: DeepInput) {
  const controllerRef = useRef<DeepController | null>(null);
  if (!controllerRef.current)
    controllerRef.current = createDeepController({
      fetch: browserFetch,
      now: () => new Date().toISOString(),
      fetchHealth: async () => (await fetch("/api/health")).json(),
    });
  const [state, setState] = useState<DeepControllerState>(
    controllerRef.current.getState(),
  );
  useEffect(() => {
    const controller = controllerRef.current!;
    const unsubscribe = controller.subscribe(setState);
    // 启动时探测一次第二层可用性与实际身份；不会发起任何模型调用
    void controller.probe();
    return () => {
      unsubscribe();
    };
  }, []);

  // 缓存键使用服务端实际身份，而不是前端硬编码的常量
  const identity = state.identity ?? DEFAULT_DEEP_IDENTITY;
  const { key, inputKey, request, profileContext } = useMemo(
    () => buildDeepRequest(input, new Date().toISOString(), identity),
    [
      input.messages,
      input.relation,
      input.targetId,
      input.lines,
      input.memory,
      input.profile,
      input.conversationId,
      identity.model,
      identity.promptVersion,
    ],
  );

  /**
   * 输入或身份变化 → 旧结果标记 stale、在途请求取消（不清空、不自动重跑）。
   * 这里用的是 inputKey：跨会话基线变化不算「输入变了」。
   */
  useEffect(() => {
    controllerRef.current!.invalidate();
  }, [inputKey]);

  const run = useMemo(
    () => () => controllerRef.current!.run(key, request),
    [key, request],
  );

  return {
    ...state,
    key,
    inputKey,
    request,
    /** 本次请求实际送出的检索上下文（无档案时为 null） */
    profileContext,
    run,
    cancel: () => controllerRef.current!.cancel(),
    reset: () => controllerRef.current!.reset(),
    stats: () => controllerRef.current!.stats(),
    /** 没有可分析的消息时按钮应当不可用 */
    canRun: input.messages.length > 0,
    /** 结果仍然对应当前输入（未过期） */
    fresh: state.status === "success" && !state.isStale,
    /** 有没有可展示的内容（可能是 stale 的） */
    hasContent: Boolean(state.result),
  };
}
