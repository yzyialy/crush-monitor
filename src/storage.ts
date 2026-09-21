import {
  applyFeedback,
  memoryViolations,
} from "../shared/memory";
import { randomId } from "../shared/hash";
import { computeFeedbackStats, emptyBaseline } from "../shared/profile";
import {
  MAX_ACTIVITY_EVENTS,
  PROFILE_SCHEMA_VERSION,
  PROFILE_STORAGE_KEY,
  LEGACY_PATTERN_SOURCE,
  type ActivityEvent,
  type BehaviorBaseline,
  type CommunicationHabit,
  type InferenceCandidate,
  type InterpretationConfirmation,
  type InterpretationFeedback,
  type KnownPattern,
  type KnownPatternSource,
  type LineResult,
  type LongTermMemory,
  type MemoryStatus,
  type PersonProfile,
  type RelationshipContext,
  type SourceType,
  type UserCorrection,
  type UserFeedback,
} from "../shared/types";

/**
 * 前端本地记忆持久化。
 *
 * local-first：长期记忆只存在浏览器里，不上传、不写服务端磁盘。
 * 服务端只在单次分析时接收相关记忆，用完即弃。
 *
 * 所有读取都做防御性校验：损坏或被手改的数据一律丢弃，
 * 不能让非法来源等级（例如凭空出现的 user_confirmed）进入系统。
 */

const MEMORY_KEY = "crush-monitor.memory.v1";
const FEEDBACK_KEY = "crush-monitor.feedback.v1";

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** 解析可用的存储后端。测试可注入，浏览器不可用时返回 null。 */
export function resolveStorage(injected?: StorageLike): StorageLike | null {
  if (injected) return injected;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* 隐私模式等场景下访问会抛错 */
  }
  return null;
}

const MEMORY_KINDS = [
  "fact",
  "event",
  "preference",
  "boundary",
  "pattern",
  "unresolved",
] as const;

const SOURCE_TYPES: SourceType[] = [
  "observed",
  "model_inferred",
  "user_confirmed",
];

/** 记忆生命周期状态。第三阶段扩展了 contradicted / superseded / expired。 */
const MEMORY_STATUSES: MemoryStatus[] = [
  "active",
  "archived",
  "contradicted",
  "superseded",
  "expired",
];

/** 逐条校验记忆。任何字段不合法就丢弃该条，不猜测、不修补。 */
export function parseMemory(raw: unknown): LongTermMemory[] {
  if (!Array.isArray(raw)) return [];
  const valid: LongTermMemory[] = [];
  for (const item of raw) {
    const m = item as Partial<LongTermMemory>;
    if (typeof m?.id !== "string" || !m.id) continue;
    if (!MEMORY_KINDS.includes(m.kind as (typeof MEMORY_KINDS)[number]))
      continue;
    if (typeof m.content !== "string" || !m.content) continue;
    if (!Array.isArray(m.sourceMessageIds)) continue;
    if (typeof m.createdAt !== "string" || typeof m.lastConfirmedAt !== "string")
      continue;
    if (m.status !== undefined && !MEMORY_STATUSES.includes(m.status as MemoryStatus))
      continue;
    if (typeof m.confidence !== "number") continue;
    if (!SOURCE_TYPES.includes(m.sourceType as SourceType)) continue;
    valid.push({
      id: m.id,
      kind: m.kind as LongTermMemory["kind"],
      content: m.content,
      sourceMessageIds: m.sourceMessageIds.filter(
        (x): x is string => typeof x === "string",
      ),
      createdAt: m.createdAt,
      lastConfirmedAt: m.lastConfirmedAt,
      // 旧数据没有 status 时按 active 处理
      status: (m.status as MemoryStatus) ?? "active",
      confidence: m.confidence,
      sourceType: m.sourceType as SourceType,
    });
  }
  // 违反不变量的数据一律不进入系统
  return valid.filter((m) => memoryViolations([m]).length === 0);
}

export function parseFeedback(raw: unknown): UserFeedback[] {
  if (!Array.isArray(raw)) return [];
  const valid: UserFeedback[] = [];
  for (const item of raw) {
    const f = item as Partial<UserFeedback>;
    if (typeof f?.id !== "string" || !f.id) continue;
    if (typeof f.memoryId !== "string" || !f.memoryId) continue;
    if (!["confirm", "reject", "correct"].includes(f.verdict as string))
      continue;
    valid.push({
      id: f.id,
      memoryId: f.memoryId,
      verdict: f.verdict as UserFeedback["verdict"],
      correction: typeof f.correction === "string" ? f.correction : null,
      createdAt: typeof f.createdAt === "string" ? f.createdAt : "",
    });
  }
  return valid;
}

function read<T>(
  key: string,
  parse: (raw: unknown) => T,
  storage?: StorageLike,
): T {
  const backend = resolveStorage(storage);
  if (!backend) return parse([]);
  try {
    const text = backend.getItem(key);
    return text ? parse(JSON.parse(text)) : parse([]);
  } catch {
    return parse([]);
  }
}

function write(key: string, value: unknown, storage?: StorageLike): boolean {
  const backend = resolveStorage(storage);
  if (!backend) return false;
  try {
    backend.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * 本机存储写入失败。
 *
 * 为什么要有这个类：`write()` 失败只返回 `false`，而调用方过去全都忽略返回值，
 * 于是「这段聊天根本没存下来」在界面上一片安静 —— 用户以为存好了，刷新才发现没了。
 * 现在写入失败一律抛出带原因的 Error，由界面显示出来。
 */
export class LocalStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStorageError";
  }
}

/**
 * 写本机存储，失败时**抛出带原因的 Error**（而不是静默返回 false）。
 *
 * `label` 只用于错误文案，例如「本机聊天记录」。
 */
export function writeStrict(
  key: string,
  value: unknown,
  label: string,
  storage?: StorageLike,
): void {
  const backend = resolveStorage(storage);
  if (!backend)
    throw new LocalStorageError(
      `无法保存${label}：浏览器不允许本页面使用本机存储。` +
        `常见原因：开了无痕 / 隐私窗口，或在浏览器设置里禁用了网站数据。`,
    );
  try {
    backend.setItem(key, JSON.stringify(value));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new LocalStorageError(
      `保存${label}失败：${reason}。` +
        `常见原因：本机存储已满（localStorage 一般只有 5MB 左右）——先删掉不用的聊天记录再试。`,
    );
  }
}

export const loadMemory = (storage?: StorageLike) =>
  read(MEMORY_KEY, parseMemory, storage);

export const saveMemory = (memory: LongTermMemory[], storage?: StorageLike) =>
  write(MEMORY_KEY, memory, storage);

export const loadFeedback = (storage?: StorageLike) =>
  read(FEEDBACK_KEY, parseFeedback, storage);

export const saveFeedback = (feedback: UserFeedback[], storage?: StorageLike) =>
  write(FEEDBACK_KEY, feedback, storage);

/**
 * 记录一次用户反馈，并把结果应用到记忆上。
 * 这是客户端唯一会把记忆提升为 user_confirmed 的入口。
 */
export function recordFeedback(
  input: {
    id: string;
    memoryId: string;
    verdict: UserFeedback["verdict"];
    correction?: string | null;
    now: string;
  },
  storage?: StorageLike,
): { memory: LongTermMemory[]; feedback: UserFeedback[] } {
  const feedback: UserFeedback = {
    id: input.id,
    memoryId: input.memoryId,
    verdict: input.verdict,
    correction: input.correction ?? null,
    createdAt: input.now,
  };
  const memory = loadMemory(storage).map((m) =>
    applyFeedback(m, feedback, input.now),
  );
  const history = [...loadFeedback(storage), feedback];
  saveMemory(memory, storage);
  saveFeedback(history, storage);
  return { memory, feedback: history };
}

export function clearAll(storage?: StorageLike): void {
  const backend = resolveStorage(storage);
  if (!backend) return;
  try {
    backend.removeItem(MEMORY_KEY);
    backend.removeItem(FEEDBACK_KEY);
    backend.removeItem(DEEP_FEEDBACK_KEY);
    backend.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 深度解读反馈
//
// 刻意与长期记忆完全分开：
//   本阶段的反馈只是未来校准数据，不修改 Jev、不修改 rubric、
//   不修改 affinity，也不升级任何 memory 的 sourceType。
//   用户明确确认某个事实时如何升级为 user_confirmed，留到后续阶段设计。
// ---------------------------------------------------------------------------

const DEEP_FEEDBACK_KEY = "crush-monitor.deep-feedback.v1";

const VERDICTS = ["helpful", "problem"] as const;

export function parseInterpretationFeedback(
  raw: unknown,
): InterpretationFeedback[] {
  if (!Array.isArray(raw)) return [];
  const valid: InterpretationFeedback[] = [];
  for (const item of raw) {
    const f = item as Partial<InterpretationFeedback>;
    if (typeof f?.id !== "string" || !f.id) continue;
    if (typeof f.contextKey !== "string" || !f.contextKey) continue;
    if (!VERDICTS.includes(f.verdict as (typeof VERDICTS)[number])) continue;
    valid.push({
      id: f.id,
      contextKey: f.contextKey,
      verdict: f.verdict as InterpretationFeedback["verdict"],
      reasons: Array.isArray(f.reasons)
        ? f.reasons.filter((x): x is string => typeof x === "string")
        : [],
      note: typeof f.note === "string" ? f.note : "",
      createdAt: typeof f.createdAt === "string" ? f.createdAt : "",
    });
  }
  return valid;
}

export const loadInterpretationFeedback = (storage?: StorageLike) =>
  read(DEEP_FEEDBACK_KEY, parseInterpretationFeedback, storage);

/**
 * 记录一次解读反馈。
 * 只写本地存储，不读写 memory，也不触发任何升级逻辑。
 */
export function recordInterpretationFeedback(
  input: {
    id: string;
    contextKey: string;
    verdict: InterpretationFeedback["verdict"];
    reasons?: string[];
    note?: string;
    now: string;
  },
  storage?: StorageLike,
): InterpretationFeedback[] {
  const entry: InterpretationFeedback = {
    id: input.id,
    contextKey: input.contextKey,
    verdict: input.verdict,
    reasons: input.reasons ?? [],
    note: input.note ?? "",
    createdAt: input.now,
  };
  const history = [...loadInterpretationFeedback(storage), entry];
  write(DEEP_FEEDBACK_KEY, history, storage);
  return history;
}

// ---------------------------------------------------------------------------
// 第三阶段：PersonProfile 本地档案
//
// local-first 的边界在这里：
//   - 基线、记忆、习惯、反馈统计全部只存在浏览器里；
//   - 服务端只在单次请求里收到「检索后的相关子集」，用完即弃；
//   - 任何损坏或被手改的数据一律安全忽略，绝不让应用打不开；
//   - 删除能力只删自己拥有的 key，绝不碰原始聊天记录。
// ---------------------------------------------------------------------------

export type StoredProfiles = { version: number; profiles: PersonProfile[] };

const RELATION_TYPES = [
  "new",
  "friend",
  "close_friend",
  "crush",
  "dating",
  "couple",
  "coworker",
  "family",
  "other",
] as const;

const CLOSENESS = ["low", "medium", "high", "unknown"] as const;
const CONTACT = [
  "rare",
  "weekly",
  "several_per_week",
  "daily",
  "very_frequent",
  "unknown",
] as const;
const CONTEXT_SOURCE = ["user_provided", "observed", "mixed"] as const;

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const strArray = (value: unknown, limit = 64): string[] =>
  Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string").slice(0, limit)
    : [];

function parseRelationshipContext(raw: unknown): RelationshipContext | null {
  const r = raw as Partial<RelationshipContext> | undefined;
  if (!r || typeof r !== "object") return null;
  if (!RELATION_TYPES.includes(r.type as (typeof RELATION_TYPES)[number]))
    return null;
  return {
    type: r.type as RelationshipContext["type"],
    durationDays:
      typeof r.durationDays === "number" && Number.isFinite(r.durationDays)
        ? r.durationDays
        : undefined,
    closeness: CLOSENESS.includes(r.closeness as (typeof CLOSENESS)[number])
      ? (r.closeness as RelationshipContext["closeness"])
      : "unknown",
    contactFrequency: CONTACT.includes(
      r.contactFrequency as (typeof CONTACT)[number],
    )
      ? (r.contactFrequency as RelationshipContext["contactFrequency"])
      : "unknown",
    usualTone: strArray(r.usualTone, 12),
    knownPatterns: strArray(r.knownPatterns, 20),
    recentContext: strArray(r.recentContext, 20),
    sourceType: CONTEXT_SOURCE.includes(
      r.sourceType as (typeof CONTEXT_SOURCE)[number],
    )
      ? (r.sourceType as RelationshipContext["sourceType"])
      : "user_provided",
  };
}

/** 损坏的基线回退为空基线：宁可重新冷启动，也不带坏数据跑。 */
function parseBaseline(raw: unknown): BehaviorBaseline {
  const b = raw as Partial<BehaviorBaseline> | undefined;
  if (!b || typeof b !== "object") return emptyBaseline();
  const metrics: BehaviorBaseline["metrics"] = {};
  for (const [kind, value] of Object.entries(b.metrics ?? {})) {
    const m = value as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") continue;
    if (typeof m.mean !== "number" || !Number.isFinite(m.mean)) continue;
    metrics[kind as keyof BehaviorBaseline["metrics"]] = {
      mean: m.mean,
      median: typeof m.median === "number" ? m.median : undefined,
      variance: typeof m.variance === "number" ? m.variance : undefined,
      sampleCount: Math.max(0, Math.round(finite(m.sampleCount))),
      updatedAt: finite(m.updatedAt),
      weightSum: finite(m.weightSum),
      weightedSum: finite(m.weightedSum),
      recent: Array.isArray(m.recent)
        ? m.recent
            .filter((x): x is number => typeof x === "number")
            .slice(-64)
        : [],
      recentConversationIds: Array.isArray(m.recentConversationIds)
        ? strArray(m.recentConversationIds, 64)
        : [],
      lastValue: typeof m.lastValue === "number" ? m.lastValue : undefined,
      previousMean:
        typeof m.previousMean === "number" ? m.previousMean : undefined,
      previousMedian:
        typeof m.previousMedian === "number" ? m.previousMedian : undefined,
      previousSampleCount:
        typeof m.previousSampleCount === "number"
          ? m.previousSampleCount
          : undefined,
    };
  }
  return {
    sampleCount: Math.max(0, Math.round(finite(b.sampleCount))),
    conversationCount: Math.max(0, Math.round(finite(b.conversationCount))),
    firstObservedAt: finite(b.firstObservedAt),
    lastObservedAt: finite(b.lastObservedAt),
    metrics,
  };
}

function parseHabits(raw: unknown): CommunicationHabit[] {
  if (!Array.isArray(raw)) return [];
  const out: CommunicationHabit[] = [];
  for (const item of raw) {
    const h = item as Partial<CommunicationHabit>;
    if (typeof h?.expression !== "string" || !h.expression) continue;
    const confidence = ["low", "medium", "high"].includes(
      h.confidence as string,
    )
      ? (h.confidence as CommunicationHabit["confidence"])
      : "low";
    const conversationIds = strArray(h.conversationIds, 64);
    const countsByConversation: Record<string, number> = {};
    if (h.countsByConversation && typeof h.countsByConversation === "object")
      for (const [key, value] of Object.entries(h.countsByConversation))
        if (typeof value === "number" && Number.isFinite(value))
          countsByConversation[key] = value;
    out.push({
      expression: h.expression,
      observedCount: Math.max(0, Math.round(finite(h.observedCount))),
      conversationCount: Math.max(
        conversationIds.length,
        Math.round(finite(h.conversationCount)),
      ),
      contexts: strArray(h.contexts, 16),
      usualMeaning: typeof h.usualMeaning === "string" ? h.usualMeaning : "",
      confidence,
      lastObservedAt: finite(h.lastObservedAt),
      conversationIds,
      countsByConversation,
    });
  }
  return out.slice(0, 64);
}

/** 已知模式的来源。迁移时把 v1 的 "observed" 映射成 "deterministic"。 */
const PATTERN_SOURCES: KnownPatternSource[] = [
  "deterministic",
  "user_confirmed",
  "model_inferred",
];

function parsePatternSource(raw: unknown): KnownPatternSource | null {
  if (PATTERN_SOURCES.includes(raw as KnownPatternSource))
    return raw as KnownPatternSource;
  // 存储版本 1 用的是记忆来源等级，"observed" 等于程序统计
  if (raw === LEGACY_PATTERN_SOURCE) return "deterministic";
  return null;
}

function parseKnownPatterns(raw: unknown): KnownPattern[] {
  if (!Array.isArray(raw)) return [];
  const out: KnownPattern[] = [];
  for (const item of raw) {
    const p = item as Partial<KnownPattern> & { sourceType?: unknown };
    if (typeof p?.id !== "string" || !p.id) continue;
    if (typeof p.description !== "string" || !p.description) continue;
    const sourceType = parsePatternSource(p.sourceType);
    if (!sourceType) continue;
    if (!MEMORY_STATUSES.includes(p.status as MemoryStatus)) continue;
    // v1 没有 patternKey：用 id 兜底，保证迁移后仍然唯一稳定
    const patternKey =
      typeof p.patternKey === "string" && p.patternKey
        ? p.patternKey
        : p.id.replace(/^kp:/, "");
    out.push({
      id: p.id,
      patternKey,
      description: p.description,
      evidenceCount: Math.max(0, Math.round(finite(p.evidenceCount))),
      conversationCount: Math.max(
        0,
        Math.round(finite(p.conversationCount, finite(p.evidenceCount))),
      ),
      sourceType,
      supportingMetrics: strArray(p.supportingMetrics, 12),
      firstObservedAt: finite(p.firstObservedAt),
      lastObservedAt: finite(p.lastObservedAt),
      status: p.status as MemoryStatus,
    });
  }
  return out.slice(0, 64);
}

function parseActivityEvents(raw: unknown): ActivityEvent[] {
  if (!Array.isArray(raw)) return [];
  const kinds = [
    "planned_invite_accepted",
    "planned_invite_declined",
    "same_day_invite_accepted",
    "same_day_invite_declined",
    "unspecified_invite_accepted",
    "unspecified_invite_declined",
    "counterpart_proposes_activity",
  ];
  const out: ActivityEvent[] = [];
  for (const item of raw) {
    const e = item as Partial<ActivityEvent>;
    if (!kinds.includes(e?.kind as string)) continue;
    if (typeof e.conversationId !== "string" || !e.conversationId) continue;
    out.push({
      kind: e.kind as ActivityEvent["kind"],
      conversationId: e.conversationId,
      messageIds: strArray(e.messageIds, 16),
      at: finite(e.at),
    });
  }
  return out.slice(0, MAX_ACTIVITY_EVENTS);
}

function parseCandidates(raw: unknown): InferenceCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: InferenceCandidate[] = [];
  for (const item of raw) {
    const c = item as Partial<InferenceCandidate>;
    if (typeof c?.id !== "string" || !c.id) continue;
    if (typeof c.content !== "string" || !c.content) continue;
    const conversationIds = strArray(c.conversationIds, 64);
    const aspects = ["emotion", "intent", "alternative"];
    out.push({
      id: c.id,
      content: c.content,
      kind: (MEMORY_KINDS.includes(c.kind as (typeof MEMORY_KINDS)[number])
        ? c.kind
        : "pattern") as InferenceCandidate["kind"],
      aspect: aspects.includes(c.aspect as string)
        ? (c.aspect as InferenceCandidate["aspect"])
        : "alternative",
      sourceMessageIds: strArray(c.sourceMessageIds, 64),
      conversationIds,
      firstSeenAt: finite(c.firstSeenAt),
      lastSeenAt: finite(c.lastSeenAt),
      observationCount: Math.max(
        conversationIds.length,
        Math.round(finite(c.observationCount)),
      ),
      confidence: Math.min(1, Math.max(0, finite(c.confidence))),
    });
  }
  return out.slice(0, 128);
}

function parseConfirmations(raw: unknown): InterpretationConfirmation[] {
  if (!Array.isArray(raw)) return [];
  const verdicts = [
    "mostly_correct",
    "partly_correct",
    "incorrect",
    "unknown",
  ];
  const out: InterpretationConfirmation[] = [];
  for (const item of raw) {
    const c = item as Partial<InterpretationConfirmation>;
    if (typeof c?.id !== "string" || !c.id) continue;
    if (typeof c.contextKey !== "string" || !c.contextKey) continue;
    if (!verdicts.includes(c.verdict as string)) continue;
    out.push({
      id: c.id,
      contextKey: c.contextKey,
      verdict: c.verdict as InterpretationConfirmation["verdict"],
      confirmedParts: strArray(c.confirmedParts, 16),
      createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
    });
  }
  return out.slice(0, 256);
}

function parseCorrections(raw: unknown): UserCorrection[] {
  if (!Array.isArray(raw)) return [];
  const out: UserCorrection[] = [];
  for (const item of raw) {
    const c = item as Partial<UserCorrection>;
    if (typeof c?.id !== "string" || !c.id) continue;
    if (typeof c.content !== "string" || !c.content) continue;
    out.push({
      id: c.id,
      contextKey: typeof c.contextKey === "string" ? c.contextKey : null,
      content: c.content,
      contradictedIds: strArray(c.contradictedIds, 128),
      createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
    });
  }
  return out.slice(0, 256);
}

/**
 * 校验一份档案。
 * 任何关键字段不合法就返回 null（安全忽略），不修补、不猜测。
 * feedbackStats 不从存储读取，而是由 confirmations / corrections 重新算出，
 * 避免手改出来的统计数字进入系统。
 */
export function validateProfile(raw: unknown): PersonProfile | null {
  const p = raw as Partial<PersonProfile> | undefined;
  if (!p || typeof p !== "object") return null;
  if (typeof p.id !== "string" || !p.id) return null;
  const relationshipContext = parseRelationshipContext(p.relationshipContext);
  if (!relationshipContext) return null;

  const confirmations = parseConfirmations(p.confirmations);
  const corrections = parseCorrections(p.corrections);
  const memories = parseMemory(p.memories);

  return {
    id: p.id,
    displayName:
      typeof p.displayName === "string" && p.displayName
        ? p.displayName
        : undefined,
    relationshipContext,
    createdAt: finite(p.createdAt),
    updatedAt: finite(p.updatedAt),
    baselineVersion: Math.max(1, Math.round(finite(p.baselineVersion, 1))),
    behaviorBaseline: parseBaseline(p.behaviorBaseline),
    memories,
    knownPatterns: parseKnownPatterns(p.knownPatterns),
    habits: parseHabits(p.habits),
    activityEvents: parseActivityEvents(p.activityEvents),
    inferenceCandidates: parseCandidates(p.inferenceCandidates),
    feedbackStats: computeFeedbackStats({ confirmations, corrections }),
    confirmations,
    corrections,
    sourceConversationIds: strArray(p.sourceConversationIds, 512),
  };
}

/**
 * 迁移任意历史形态的档案数据。
 *
 * 支持：
 *   { version: 1, profiles: [...] }  当前格式
 *   [ ...profiles ]                  早期无版本号的数组
 *   { profiles: [...] }              缺 version
 * 版本号高于当前（来自更新的版本）时安全忽略而不是破坏它。
 */
export function migrateProfilePayload(raw: unknown): StoredProfiles {
  const empty: StoredProfiles = {
    version: PROFILE_SCHEMA_VERSION,
    profiles: [],
  };
  if (!raw) return empty;

  if (Array.isArray(raw)) {
    const profiles = raw
      .map(validateProfile)
      .filter((p): p is PersonProfile => p !== null);
    return { version: PROFILE_SCHEMA_VERSION, profiles };
  }
  if (typeof raw !== "object") return empty;

  const payload = raw as { version?: unknown; profiles?: unknown };
  const version =
    typeof payload.version === "number" && Number.isFinite(payload.version)
      ? payload.version
      : 0;
  // 来自更高版本的存储：不认识的字段不敢丢，直接忽略
  if (version > PROFILE_SCHEMA_VERSION) return empty;
  if (!Array.isArray(payload.profiles)) return empty;

  const profiles = payload.profiles
    .map(validateProfile)
    .filter((p): p is PersonProfile => p !== null);
  return { version: PROFILE_SCHEMA_VERSION, profiles };
}

export const loadProfiles = (storage?: StorageLike): PersonProfile[] =>
  read(PROFILE_STORAGE_KEY, (raw) => migrateProfilePayload(raw).profiles, storage);

export function saveProfiles(
  profiles: PersonProfile[],
  storage?: StorageLike,
): boolean {
  const payload: StoredProfiles = {
    version: PROFILE_SCHEMA_VERSION,
    profiles,
  };
  return write(PROFILE_STORAGE_KEY, payload, storage);
}

export function getProfile(
  id: string,
  storage?: StorageLike,
): PersonProfile | null {
  return loadProfiles(storage).find((p) => p.id === id) ?? null;
}

/** 写入或替换一份档案。 */
export function upsertProfile(
  profile: PersonProfile,
  storage?: StorageLike,
): PersonProfile[] {
  const existing = loadProfiles(storage);
  const index = existing.findIndex((p) => p.id === profile.id);
  const next = [...existing];
  if (index < 0) next.push(profile);
  else next[index] = profile;
  saveProfiles(next, storage);
  return next;
}

/**
 * 删除某个人的档案（含其基线、记忆、习惯、反馈统计）。
 * 原始聊天记录不属于档案，因此不会被删除。
 */
export function deleteProfile(
  id: string,
  storage?: StorageLike,
): PersonProfile[] {
  const next = loadProfiles(storage).filter((p) => p.id !== id);
  saveProfiles(next, storage);
  return next;
}

/** 清空某个人的历史基线，保留记忆与推理候选。 */
export function clearBaseline(
  profileId: string,
  storage?: StorageLike,
): PersonProfile[] {
  const profiles = loadProfiles(storage).map((p) =>
    p.id === profileId
      ? {
          ...p,
          behaviorBaseline: emptyBaseline(),
          sourceConversationIds: [],
          updatedAt: Date.now(),
        }
      : p,
  );
  saveProfiles(profiles, storage);
  return profiles;
}

/** 删除单条记忆。 */
export function deleteMemory(
  profileId: string,
  memoryId: string,
  storage?: StorageLike,
): PersonProfile[] {
  const profiles = loadProfiles(storage).map((p) =>
    p.id === profileId
      ? {
          ...p,
          memories: p.memories.filter((m) => m.id !== memoryId),
          updatedAt: Date.now(),
        }
      : p,
  );
  saveProfiles(profiles, storage);
  return profiles;
}

/**
 * 清空全部长期数据。
 *
 * 只删除本模块自己拥有的 key，绝不触碰原始聊天记录：
 * 「清空长期观察」不等于「删掉我的聊天」。
 */
export const LONG_TERM_KEYS = [
  PROFILE_STORAGE_KEY,
  MEMORY_KEY,
  FEEDBACK_KEY,
  DEEP_FEEDBACK_KEY,
];

export function clearLongTerm(storage?: StorageLike): void {
  const backend = resolveStorage(storage);
  if (!backend) return;
  try {
    for (const key of LONG_TERM_KEYS) backend.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 旧本地数据检测（本机版）
//
// 本机版的长期档案就存在浏览器里（见下面的 LOCAL_MESSAGES_KEY / PROFILE_STORAGE_KEY），
// 这里只保留「检测 + 读取快照」这条只读能力给 UI 用：浏览器里如果留着更早
// 版本写下的档案结构，也能按当前结构安全读出来。检测本身不写任何数据。
// ---------------------------------------------------------------------------

export const MIGRATED_KEY = "crush-monitor.migrated.v1";

export type LegacySummary = {
  profiles: number;
  memories: number;
  habits: number;
  patterns: number;
  confirmations: number;
  corrections: number;
  /** 旧版本地并没有持久化聊天记录，这里恒为 0，保留字段以便以后扩展 */
  conversations: number;
};

export type LegacySnapshot = {
  profiles: (PersonProfile & { displayName?: string })[];
  conversations: {
    title: string;
    messages: {
      sender: string;
      content: string;
      sentAt: string | null;
      mediaKind?: string | null;
    }[];
  }[];
  summary: LegacySummary;
};

/** 是否已经迁移过。用户点过"不用了"也算，避免反复打扰。 */
export function legacyMigrated(storage?: StorageLike): boolean {
  const backend = resolveStorage(storage);
  if (!backend) return true;
  try {
    return Boolean(backend.getItem(MIGRATED_KEY));
  } catch {
    return true;
  }
}

/**
 * 检测旧版长期数据。
 * 已经迁移过、或确实没有数据时返回 null。
 */
export function detectLegacyProfile(
  storage?: StorageLike,
): { summary: LegacySummary } | null {
  if (legacyMigrated(storage)) return null;
  const profiles = loadProfiles(storage);
  if (!profiles.length) return null;
  return { summary: summarizeLegacy(profiles) };
}

/** 读取完整的旧数据快照（只在用户确认迁移后调用）。 */
export function loadLegacySnapshot(storage?: StorageLike): LegacySnapshot | null {
  const profiles = loadProfiles(storage);
  if (!profiles.length) return null;
  return {
    profiles,
    // 旧版本没有把聊天记录写进 localStorage，所以这里没有可迁移的会话
    conversations: [],
    summary: summarizeLegacy(profiles),
  };
}

/** 标记"本地旧数据已处理"。 */
export function markLegacyMigrated(storage?: StorageLike): void {
  const backend = resolveStorage(storage);
  if (!backend) return;
  try {
    backend.setItem(MIGRATED_KEY, new Date().toISOString());
  } catch {
    /* 忽略 */
  }
}

function summarizeLegacy(profiles: PersonProfile[]): LegacySummary {
  return {
    profiles: profiles.length,
    memories: profiles.reduce((n, p) => n + p.memories.length, 0),
    habits: profiles.reduce((n, p) => n + p.habits.length, 0),
    patterns: profiles.reduce((n, p) => n + p.knownPatterns.length, 0),
    confirmations: profiles.reduce((n, p) => n + p.confirmations.length, 0),
    corrections: profiles.reduce((n, p) => n + p.corrections.length, 0),
    conversations: 0,
  };
}

/**
 * 一次性迁移第二阶段遗留的扁平记忆。
 *
 * 第二阶段把记忆存在 crush-monitor.memory.v1 里，没有「人」的概念。
 * 第三阶段第一次建立档案时把它们收编进该档案，来源等级原样保留，
 * 然后清掉旧 key，避免同一份数据被两个地方读到。
 */
export function adoptLegacyMemories(
  profileId: string,
  storage?: StorageLike,
): PersonProfile[] | null {
  const backend = resolveStorage(storage);
  if (!backend) return null;
  let legacy: LongTermMemory[] = [];
  try {
    const text = backend.getItem(MEMORY_KEY);
    legacy = text ? parseMemory(JSON.parse(text)) : [];
  } catch {
    legacy = [];
  }
  const profiles = loadProfiles(storage);
  const index = profiles.findIndex((p) => p.id === profileId);
  if (index < 0) return null;

  const profile = profiles[index];
  const merged = [...profile.memories];
  for (const memory of legacy) {
    if (memoryViolations([memory]).length) continue;
    if (merged.some((m) => m.id === memory.id)) continue;
    merged.push(memory);
  }
  profiles[index] = { ...profile, memories: merged };
  saveProfiles(profiles, storage);
  try {
    backend.removeItem(MEMORY_KEY);
  } catch {
    /* 忽略 */
  }
  return profiles;
}

// ---------------------------------------------------------------------------
// 本机版：工作区（人 / 对话 / 消息）
//
// 本机版的边界：
//   - 长期数据（档案、基线、记忆、模式、反馈统计）在浏览器 localStorage；
//   - 聊天记录同样只在本机；服务端只在单次分析请求里收到这次要分析的消息；
//   - 服务端不落盘任何聊天内容，也没有账号概念；
//   - 「导入」这条路径不产生任何模型调用：它只写本地存储。
// ---------------------------------------------------------------------------

const LOCAL_CHAT_KEY = "crush-monitor.chat.v1";
const LOCAL_LAST_CONVERSATION_KEY = "crush-monitor.last-conversation.v1";

export const LOCAL_CHAT_SCHEMA_VERSION = 1;

/** 本机消息：服务端已经不在，但结构沿用第四阶段的导入载荷，便于对照。 */
export type LocalMessage = {
  id: string;
  sender: "self" | "other";
  content: string;
  sentAt: string | null;
  mediaKind: string | null;
  /**
   * 第一层（Jev）的分析结果，跟着消息一起存在本机。
   *
   * 为什么必须存：不存的话「刷新页面 / 从历史对话打开某一段」就只剩光秃秃的
   * 气泡，情绪与意图标签全没了 —— 要么重跑一遍 Jev（花额度），要么体验回退。
   * 服务端版把 `line_json` 存在 messages 表里，本机版对应地存在这里。
   * 字段可选：老数据没有它是正常的。
   */
  line?: LineResult | null;
};

export type LocalConversation = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: LocalMessage[];
};

export type StoredChat = {
  version: number;
  people: {
    id: string;
    displayName: string;
    relationshipType: "crush" | "new" | "couple";
    createdAt: string;
    updatedAt: string;
    conversations: LocalConversation[];
  }[];
};

export const emptyChat = (): StoredChat => ({
  version: LOCAL_CHAT_SCHEMA_VERSION,
  people: [],
});

const MEDIA_KINDS = [
  "voice",
  "image",
  "video",
  "sticker",
  "file",
  "location",
  "link",
  "other",
] as const;

/**
 * 消息去重指纹的种子。
 *
 * 规则与第四阶段服务端完全一致：
 *   sender + sentAt + content + 该内容在**本次导入里出现的第几次**
 * 位置索引绝不进指纹 —— 否则同一批消息换一次顺序就会变成"新消息"。
 */
export function fingerprintSeed(message: {
  sender: string;
  content: string;
  sentAt: string | null;
}): string {
  return `${message.sender}|${message.sentAt ?? ""}|${message.content}`;
}

/** 稳定的小哈希（没有安全含义，只用于生成确定性 id）。 */
export function shortHash(text: string): string {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 随机 id。
 *
 * 走 `shared/hash.ts` 的 `randomId()`：优先 `crypto.randomUUID`，
 * 拿不到（**明文 HTTP + 局域网 IP 访问时它根本不存在**）就用
 * `crypto.getRandomValues`，再不行才退到时间戳 + 随机数。
 * 直接写 `crypto.randomUUID()` 会让非安全上下文里的导入整条挂掉。
 */
export function newLocalId(prefix: string): string {
  return `${prefix}-${randomId()}`;
}

/**
 * 校验存下来的第一层结果。
 *
 * 只认「有字符串 id 的对象」：坏数据当作没有（宁可少显示几个标签，
 * 也不能让一条手改记录把整份聊天读崩）。数字本身不做语义校验 ——
 * 那些数字是 Jev 给的观察值，重算属于第一层的事，不在这里做。
 */
function parseStoredLine(raw: unknown): LineResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const line = raw as Partial<LineResult>;
  if (typeof line.id !== "string" || !line.id) return null;
  return raw as LineResult;
}

function parseLocalMessage(raw: unknown): LocalMessage | null {
  const m = raw as Partial<LocalMessage> | undefined;
  if (!m || typeof m !== "object") return null;
  if (typeof m.id !== "string" || !m.id) return null;
  if (m.sender !== "self" && m.sender !== "other") return null;
  if (typeof m.content !== "string" || !m.content.trim()) return null;
  const mediaKind =
    typeof m.mediaKind === "string" &&
    MEDIA_KINDS.includes(m.mediaKind as (typeof MEDIA_KINDS)[number])
      ? (m.mediaKind as LocalMessage["mediaKind"])
      : null;
  const line = parseStoredLine(m.line);
  return {
    id: m.id,
    sender: m.sender,
    content: m.content,
    sentAt: typeof m.sentAt === "string" ? m.sentAt : null,
    mediaKind,
    ...(line ? { line } : {}),
  };
}

function parseLocalConversation(raw: unknown): LocalConversation | null {
  const c = raw as Partial<LocalConversation> | undefined;
  if (!c || typeof c !== "object") return null;
  if (typeof c.id !== "string" || !c.id) return null;
  const at = typeof c.createdAt === "string" ? c.createdAt : "";
  const messages = Array.isArray(c.messages)
    ? c.messages
        .map(parseLocalMessage)
        .filter((m): m is LocalMessage => m !== null)
    : [];
  /**
   * 旧版本的导入会把「第一句摘要」自动写进 `title`。
   *
   * 升级后 `title` 的含义收窄成「用户自己起的名字」——「第 N 段 · 时间 · 第一句」
   * 这种默认名字由界面现场算（见 `src/App.tsx` 的 `conversationName`）。
   * 如果不管，历史对话列表里每一段都只剩一句摘要，同一段聊天重复粘贴时
   * 看起来「名字都一样」（用户投诉过这一点）。
   *
   * 迁移规则是确定性的：title 恰好等于「由自己第一条消息推出的标题」→ 认成自动命名。
   * 取舍：用户如果把某段对话改名成和自动标题一字不差的字符串，那次改名会被忽略。
   */
  const storedTitle = typeof c.title === "string" && c.title ? c.title : null;
  const autoTitle = conversationTitle(messages);
  return {
    id: c.id,
    title: storedTitle && storedTitle !== autoTitle ? storedTitle : null,
    createdAt: at,
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : at,
    messages,
  };
}

/**
 * 迁移任意历史形态的工作区数据。
 * 任何字段不合法就安全忽略（丢弃），绝不把坏数据带进系统。
 */
export function migrateChatPayload(raw: unknown): StoredChat {
  const empty = emptyChat();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const payload = raw as { version?: unknown; people?: unknown };
  if (
    typeof payload.version === "number" &&
    Number.isFinite(payload.version) &&
    payload.version > LOCAL_CHAT_SCHEMA_VERSION
  )
    return empty; // 来自更高版本：不认识就不动它
  if (!Array.isArray(payload.people)) return empty;
  const people: StoredChat["people"] = [];
  for (const item of payload.people) {
    const p = item as Partial<StoredChat["people"][number]> | undefined;
    if (!p || typeof p !== "object") continue;
    if (typeof p.id !== "string" || !p.id) continue;
    const relationshipType = (
      ["crush", "new", "couple"] as const
    ).includes(p.relationshipType as "crush")
      ? (p.relationshipType as "crush" | "new" | "couple")
      : "crush";
    const at = typeof p.createdAt === "string" ? p.createdAt : "";
    people.push({
      id: p.id,
      displayName:
        typeof p.displayName === "string" && p.displayName
          ? p.displayName
          : "对方",
      relationshipType,
      createdAt: at,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : at,
      conversations: Array.isArray(p.conversations)
        ? p.conversations
            .map(parseLocalConversation)
            .filter((c): c is LocalConversation => c !== null)
        : [],
    });
  }
  return { version: LOCAL_CHAT_SCHEMA_VERSION, people };
}

export const loadChat = (storage?: StorageLike): StoredChat =>
  read(LOCAL_CHAT_KEY, migrateChatPayload, storage);

export function saveChat(data: StoredChat, storage?: StorageLike): boolean {
  return write(
    LOCAL_CHAT_KEY,
    { version: LOCAL_CHAT_SCHEMA_VERSION, people: data.people },
    storage,
  );
}

/**
 * 写本机聊天记录；失败时**抛出带原因的 Error**。
 *
 * 所有会改动聊天数据的入口都走这条：用户点了「分析聊天」，如果这段记录
 * 其实没落到 localStorage 里，他必须当场知道（见 `LocalStorageError`）。
 */
export function saveChatStrict(
  data: StoredChat,
  storage?: StorageLike,
): StoredChat {
  writeStrict(
    LOCAL_CHAT_KEY,
    { version: LOCAL_CHAT_SCHEMA_VERSION, people: data.people },
    "本机聊天记录",
    storage,
  );
  return data;
}

/** 删除某个人的全部本机聊天记录（档案不在这里，见 deleteProfile）。 */
export function deleteChatPerson(
  personId: string,
  storage?: StorageLike,
): StoredChat {
  const data = loadChat(storage);
  const next: StoredChat = {
    version: LOCAL_CHAT_SCHEMA_VERSION,
    people: data.people.filter((p) => p.id !== personId),
  };
  saveChatStrict(next, storage);
  return next;
}

export function deleteChatConversation(
  personId: string,
  conversationId: string,
  storage?: StorageLike,
): StoredChat {
  const data = loadChat(storage);
  const next: StoredChat = {
    version: LOCAL_CHAT_SCHEMA_VERSION,
    people: data.people.map((p) =>
      p.id === personId
        ? {
            ...p,
            conversations: p.conversations.filter((c) => c.id !== conversationId),
          }
        : p,
    ),
  };
  saveChatStrict(next, storage);
  return next;
}

/**
 * 「历史对话」列表的排序：最近更新的排最前。
 *
 * 与服务端 `ORDER BY c.updated_at DESC` 同口径；再拿 createdAt、id 做
 * 稳定兜底，保证同一份数据每次渲染顺序完全一致（否则列表会自己跳来跳去）。
 */
export function sortConversations(
  conversations: LocalConversation[],
): LocalConversation[] {
  return [...conversations].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * 一段对话的「第一句摘要」。
 *
 * 按存储顺序取第一条有正文的消息，截 80 字，与服务端的
 * `substr(m.content, 1, 80)` 保持同一个观感（本机没有消息级 createdAt，
 * 所以用导入顺序——它就是用户粘贴的顺序）。
 */
export function conversationPreview(
  messages: LocalMessage[],
  limit = 80,
): string | null {
  const first = messages.find((m) => m.content.trim());
  if (!first) return null;
  const text = first.content.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 一段对话里最后一条带时间的消息的时间（没有就返回 null）。 */
export function lastMessageAtOf(messages: LocalMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].sentAt) return messages[i].sentAt;
  return null;
}

/**
 * 给某一段对话改名（空字符串 = 恢复自动命名）。
 *
 * **刻意不动 `updatedAt`**：改个名字就把这段对话顶到列表最前面，
 * 用户会以为「顺序乱了」。服务端为此专门修过一次无条件写 updated_at 的 bug，
 * 本机版同样必须守住这条（见 `tests/local-workspace.test.ts`）。
 */
export function renameChatConversation(
  personId: string,
  conversationId: string,
  title: string,
  storage?: StorageLike,
): StoredChat {
  const data = loadChat(storage);
  const clean = title.trim();
  const next: StoredChat = {
    version: LOCAL_CHAT_SCHEMA_VERSION,
    people: data.people.map((person) =>
      person.id === personId
        ? {
            ...person,
            conversations: person.conversations.map((c) =>
              c.id === conversationId ? { ...c, title: clean ? clean : null } : c,
            ),
          }
        : person,
    ),
  };
  saveChatStrict(next, storage);
  return next;
}

/**
 * 改「对方称呼」。
 *
 * 只动工作区里的显示名，**不碰任何一条聊天记录**，也不改档案 id
 * （id 由称呼推导，但这里只改显示名，已有 id 保持不变 —— 否则改个称呼
 * 就会把整份长期档案拆成两份）。
 */
export function renameChatPerson(
  personId: string,
  displayName: string,
  at: string,
  storage?: StorageLike,
): StoredChat {
  const data = loadChat(storage);
  const clean = displayName.trim();
  if (!clean) throw new LocalStorageError("称呼不能为空");
  const next: StoredChat = {
    version: LOCAL_CHAT_SCHEMA_VERSION,
    people: data.people.map((person) =>
      person.id === personId
        ? { ...person, displayName: clean, updatedAt: at }
        : person,
    ),
  };
  saveChatStrict(next, storage);
  return next;
}

/** 记住每个人最近打开的那段对话，刷新页面后自动回到同一段。 */
type LastMap = Record<string, string>;

function readLast(storage?: StorageLike): LastMap {
  return read(
    LOCAL_LAST_CONVERSATION_KEY,
    (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: LastMap = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>))
        if (typeof value === "string" && value) out[key] = value;
      return out;
    },
    storage,
  );
}

export function lastConversationFor(
  personId: string,
  storage?: StorageLike,
): string | null {
  return readLast(storage)[personId] ?? null;
}

export function rememberConversation(
  personId: string,
  conversationId: string,
  storage?: StorageLike,
): void {
  const map = readLast(storage);
  map[personId] = conversationId;
  write(LOCAL_LAST_CONVERSATION_KEY, map, storage);
}

/**
 * 本机工作区读写。
 *
 * 全部接受注入的 storage，测试可以直接用内存实现驱动，不依赖浏览器。
 */
export const localChat = {
  load: (storage?: StorageLike) => loadChat(storage),
  save: (data: StoredChat, storage?: StorageLike) => saveChat(data, storage),
  /** 与 save 一样，但失败时抛错（界面要能说出「没保存成功」） */
  saveStrict: (data: StoredChat, storage?: StorageLike) =>
    saveChatStrict(data, storage),

  person: (personId: string, storage?: StorageLike) =>
    loadChat(storage).people.find((p) => p.id === personId) ?? null,

  conversations: (personId: string, storage?: StorageLike) =>
    localChat.person(personId, storage)?.conversations ?? [],

  /** 按最近更新倒序的对话列表（「历史对话」面板用的就是这个顺序） */
  conversationsSorted: (personId: string, storage?: StorageLike) =>
    sortConversations(localChat.conversations(personId, storage)),

  conversation: (
    personId: string,
    conversationId: string,
    storage?: StorageLike,
  ) =>
    localChat
      .conversations(personId, storage)
      .find((c) => c.id === conversationId) ?? null,

  /**
   * 找一段「空对话」（一条消息都没有）——「开始新对话（保留历史）」要复用它。
   * 每次点都新建一段空的话，列表里会堆满没用的空记录。
   */
  emptyConversation: (personId: string, storage?: StorageLike) =>
    sortConversations(localChat.conversations(personId, storage)).find(
      (c) => c.messages.length === 0,
    ) ?? null,

  /** 给某一段对话改名（空字符串 = 恢复自动命名，且不改变排序） */
  renameConversation: renameChatConversation,

  /** 改「对方称呼」（只改显示名，不动聊天记录） */
  renamePerson: renameChatPerson,

  /**
   * 新建或补全一个人，返回工作区里的最新状态。
   * 已存在时只更新称呼，不动已有的对话。
   */
  ensurePerson(
    input: {
      id: string;
      displayName: string;
      relationshipType: "crush" | "new" | "couple";
      at: string;
    },
    storage?: StorageLike,
  ): StoredChat {
    const data = loadChat(storage);
    const index = data.people.findIndex((p) => p.id === input.id);
    const people = [...data.people];
    if (index < 0) {
      people.push({
        id: input.id,
        displayName: input.displayName || "对方",
        relationshipType: input.relationshipType,
        createdAt: input.at,
        updatedAt: input.at,
        conversations: [],
      });
    } else {
      people[index] = {
        ...people[index],
        displayName: input.displayName || people[index].displayName,
        relationshipType: input.relationshipType,
        updatedAt: input.at,
      };
    }
    const next: StoredChat = { version: LOCAL_CHAT_SCHEMA_VERSION, people };
    saveChatStrict(next, storage);
    return next;
  },

  /** 建立一段新的对话。 */
  createConversation(
    input: { personId: string; title?: string | null; at: string },
    storage?: StorageLike,
  ): LocalConversation | null {
    const data = loadChat(storage);
    const person = data.people.find((p) => p.id === input.personId);
    if (!person) return null;
    const conversation: LocalConversation = {
      id: `conv-${newLocalId("c")}`,
      title: input.title ?? null,
      createdAt: input.at,
      updatedAt: input.at,
      messages: [],
    };
    person.conversations = [...person.conversations, conversation];
    person.updatedAt = input.at;
    saveChatStrict(data, storage);
    return conversation;
  },

  /**
   * 把一段聊天并进对话，返回实际新增的消息与本次的跳过去重数。
   *
   * 去重规则：指纹 = sender + sentAt + content + 本次导入内的出现次数。
   * 同一个 id 已经存在就跳过，因此「重复粘贴同一段聊天」是幂等的，
   * 而"同一秒发了两条一模一样的话"仍然各占一条。
   */
  appendMessages(
    input: {
      personId: string;
      conversationId: string;
      messages: {
        sender: string;
        content: string;
        sentAt?: string | null;
        mediaKind?: string | null;
      }[];
      at: string;
      title?: string | null;
    },
    storage?: StorageLike,
  ): {
    added: LocalMessage[];
    addedCount: number;
    skippedCount: number;
    conversationId: string;
  } {
    const data = loadChat(storage);
    const person = data.people.find((p) => p.id === input.personId);
    if (!person)
      return { added: [], addedCount: 0, skippedCount: 0, conversationId: input.conversationId };
    let conversation = person.conversations.find(
      (c) => c.id === input.conversationId,
    );
    if (!conversation) {
      conversation = {
        id: input.conversationId,
        title: input.title ?? null,
        createdAt: input.at,
        updatedAt: input.at,
        messages: [],
      };
      person.conversations = [...person.conversations, conversation];
    }
    const existing = new Set(conversation.messages.map((m) => m.id));
    const seen = new Map<string, number>();
    const added: LocalMessage[] = [];
    let skippedCount = 0;
    for (const raw of input.messages) {
      const sender = raw.sender === "self" ? "self" : "other";
      const content = typeof raw.content === "string" ? raw.content : "";
      if (!content.trim()) {
        skippedCount++;
        continue;
      }
      const sentAt =
        typeof raw.sentAt === "string" && raw.sentAt ? raw.sentAt : null;
      const seed = fingerprintSeed({ sender, content, sentAt });
      const occurrence = (seen.get(seed) ?? 0) + 1;
      seen.set(seed, occurrence);
      const id = `m:${shortHash(`${input.conversationId}|${seed}|#${occurrence}`)}`;
      if (existing.has(id)) {
        skippedCount++;
        continue;
      }
      existing.add(id);
      const mediaKind =
        typeof raw.mediaKind === "string" &&
        MEDIA_KINDS.includes(raw.mediaKind as (typeof MEDIA_KINDS)[number])
          ? (raw.mediaKind as LocalMessage["mediaKind"])
          : null;
      added.push({ id, sender, content, sentAt, mediaKind });
    }
    conversation.messages = [...conversation.messages, ...added];
    conversation.updatedAt = input.at;
    if (input.title && !conversation.title) conversation.title = input.title;
    person.updatedAt = input.at;
    saveChatStrict(data, storage);
    return {
      added,
      addedCount: added.length,
      skippedCount,
      conversationId: conversation.id,
    };
  },

  /**
   * 把第一层（Jev）的结果写回消息上。
   *
   * 服务端版存在 messages.line_json 里；本机版存在同一条消息对象上。
   * 这样「刷新页面」「从历史对话打开某一段」都能直接显示已经分析好的
   * 情绪/意图标签，**不必再花一次额度重跑 Jev**。
   *
   * 只有真的改到了东西才写盘：分析过程会分很多批返回，避免每批都白写一遍。
   */
  saveLines(
    input: {
      personId: string;
      conversationId: string;
      lines: Record<string, LineResult>;
    },
    storage?: StorageLike,
  ): { updated: number } {
    const entries = Object.entries(input.lines);
    if (!entries.length) return { updated: 0 };
    const data = loadChat(storage);
    const person = data.people.find((p) => p.id === input.personId);
    const conversation = person?.conversations.find(
      (c) => c.id === input.conversationId,
    );
    if (!conversation) return { updated: 0 };
    let updated = 0;
    conversation.messages = conversation.messages.map((message) => {
      const line = input.lines[message.id];
      if (!line) return message;
      const previous = message.line ?? null;
      if (previous && JSON.stringify(previous) === JSON.stringify(line))
        return message;
      updated++;
      return { ...message, line };
    });
    if (!updated) return { updated: 0 };
    saveChatStrict(data, storage);
    return { updated };
  },
};

/** 由一段对话的第一条消息推出一个人类可读的标题。 */
export function conversationTitle(messages: { content: string }[]): string | null {
  const first = messages.find((m) => m.content.trim());
  if (!first) return null;
  const text = first.content.trim().replace(/\s+/g, " ");
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

/**
 * 清空本机版的聊天记录与「最近打开」记忆。
 *
 * 刻意与 clearLongTerm（只删长期档案）分开：调用方想清哪一半就清哪一半，
 * 不会出现「点了一个按钮顺手把不该删的也删了」。
 */
export function clearLocalChat(storage?: StorageLike): void {
  const backend = resolveStorage(storage);
  if (!backend) return;
  try {
    backend.removeItem(LOCAL_CHAT_KEY);
    backend.removeItem(LOCAL_LAST_CONVERSATION_KEY);
  } catch {
    /* 忽略 */
  }
}
