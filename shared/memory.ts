import { recentScope } from "./parser";
import {
  DEEP_CONTEXT_WINDOW,
  type LongTermMemory,
  type MemoryKind,
  type Message,
  type SourceType,
  type UserFeedback,
} from "./types";

/**
 * 长期记忆与上下文窗口。
 *
 * 本文件的核心不变量：
 *   model_inferred 永远不能自动升级为 user_confirmed。
 * 唯一合法的提升通道是 applyFeedback()，也就是用户本人的确认或修正。
 * 任何自动流程（含第二层模型）产出的记忆都只能是 model_inferred 或 observed。
 */

/** 总是与当前对话相关的记忆类型：边界与未解决的事不该被窗口挤掉。 */
const ALWAYS_RELEVANT: MemoryKind[] = ["boundary", "unresolved"];

/**
 * 送给第二层的上下文窗口。
 * 先套用现有的 120 条 / 24000 字上限，再收敛到最近若干条，
 * 避免把整段历史塞进 prompt。
 */
export function boundedContext(
  messages: Message[],
  options: { window?: number } = {},
): Message[] {
  const window = options.window ?? DEEP_CONTEXT_WINDOW;
  if (window <= 0) return [];
  return recentScope(messages).slice(-window);
}

/** 单条记忆与当前窗口的相关度。只做加法，结果稳定可复现。 */
function relevance(memory: LongTermMemory, windowIds: Set<string>): number {
  let score = 0;
  if (memory.sourceMessageIds.some((id) => windowIds.has(id))) score += 2;
  if (ALWAYS_RELEVANT.includes(memory.kind)) score += 2;
  if (memory.sourceType === "user_confirmed") score += 1.5;
  if (memory.kind === "preference" || memory.kind === "fact") score += 1;
  if (memory.sourceType === "model_inferred") score += 0.5;
  return score;
}

/**
 * 挑选与当前对话相关的长期记忆。
 * 同分时按 id 排序，保证结果与输入顺序无关、可复现。
 */
export function relevantEvents(
  memory: LongTermMemory[],
  messages: Message[],
  options: { limit?: number } = {},
): LongTermMemory[] {
  const limit = options.limit ?? 12;
  if (limit <= 0) return [];
  const windowIds = new Set(messages.map((m) => m.id));
  return memory
    .filter((m) => m.status === "active")
    .map((m) => ({ memory: m, score: relevance(m, windowIds) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.memory.id.localeCompare(b.memory.id),
    )
    .slice(0, limit)
    .map((entry) => entry.memory);
}

/**
 * 由 Jev 观察直接产生的记忆。
 * 观察层有原始文本作依据，来源记为 observed —— 仍然不等于用户确认。
 */
export function createObservedMemory(input: {
  id: string;
  kind: MemoryKind;
  content: string;
  sourceMessageIds: string[];
  confidence: number;
  now: string;
}): LongTermMemory {
  return {
    id: input.id,
    kind: input.kind,
    content: input.content,
    sourceMessageIds: [...input.sourceMessageIds],
    createdAt: input.now,
    lastConfirmedAt: input.now,
    status: "active",
    confidence: clamp(input.confidence),
    sourceType: "observed",
  };
}

/**
 * 由模型解释产生的记忆。
 * 无论调用方传入什么，来源都被强制写成 model_inferred，
 * 并且 confidence 被封顶，避免伪装成确定事实。
 */
export function createInferredMemory(input: {
  id: string;
  kind: MemoryKind;
  content: string;
  sourceMessageIds: string[];
  confidence: number;
  now: string;
}): LongTermMemory {
  return {
    id: input.id,
    kind: input.kind,
    content: input.content,
    sourceMessageIds: [...input.sourceMessageIds],
    createdAt: input.now,
    lastConfirmedAt: input.now,
    status: "active",
    confidence: Math.min(clamp(input.confidence), 0.6),
    sourceType: "model_inferred",
  };
}

/** 把任意数值收敛到 0-1，非有限值按 0 处理。 */
function clamp(n: number) {
  return !Number.isFinite(n) ? 0 : Math.min(1, Math.max(0, n));
}

/** 来源等级，用于合并时避免被更低等级覆盖。 */
const RANK: Record<SourceType, number> = {
  model_inferred: 0,
  observed: 1,
  user_confirmed: 2,
};

/**
 * 合并一条新记忆。
 * 规则：
 *   - 已存在同 id 时绝不降低来源等级，也绝不由模型推断覆盖用户确认的内容；
 *   - 新记忆的等级更高时才替换内容；
 *   - 等级相同时保留原内容，仅刷新证据与时间。
 * 这条路径永远无法把 model_inferred 变成 user_confirmed。
 */
export function mergeMemory(
  existing: LongTermMemory[],
  incoming: LongTermMemory[] | LongTermMemory,
): LongTermMemory[] {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  return list.reduce((acc, item) => mergeOne(acc, item), existing);
}

function mergeOne(
  existing: LongTermMemory[],
  incoming: LongTermMemory,
): LongTermMemory[] {
  const index = existing.findIndex((m) => m.id === incoming.id);
  if (index < 0) return [...existing, incoming];
  const current = existing[index];
  const upgraded = RANK[incoming.sourceType] > RANK[current.sourceType];
  /**
   * 被用户纠正过或被取代的记忆，不能被同一批模型推断重新激活。
   * 否则「用户纠错」会在下一轮分析里被自动抹掉。
   */
  const frozen =
    (current.status === "contradicted" || current.status === "superseded") &&
    incoming.sourceType === "model_inferred";
  const merged: LongTermMemory = {
    ...current,
    sourceMessageIds: [
      ...new Set([...current.sourceMessageIds, ...incoming.sourceMessageIds]),
    ],
    lastConfirmedAt: incoming.lastConfirmedAt,
    confidence: upgraded ? incoming.confidence : current.confidence,
    content: upgraded ? incoming.content : current.content,
    sourceType: upgraded ? incoming.sourceType : current.sourceType,
    status: frozen ? current.status : incoming.status,
  };
  const next = [...existing];
  next[index] = merged;
  return next;
}

/**
 * 应用用户反馈。这是系统里唯一能产生 user_confirmed 的入口。
 * 拒绝会归档该条记忆，确认与修正会把它提升为 user_confirmed。
 */
export function applyFeedback(
  memory: LongTermMemory,
  feedback: UserFeedback,
  now: string,
): LongTermMemory {
  if (feedback.memoryId !== memory.id) return memory;
  if (feedback.verdict === "reject")
    return { ...memory, status: "archived", lastConfirmedAt: now };
  if (feedback.verdict === "correct")
    return {
      ...memory,
      content: feedback.correction ?? memory.content,
      sourceType: "user_confirmed",
      confidence: 1,
      lastConfirmedAt: now,
      status: "active",
    };
  return {
    ...memory,
    sourceType: "user_confirmed",
    confidence: 1,
    lastConfirmedAt: now,
    status: "active",
  };
}

/**
 * 检查记忆集合是否违反不变量。
 * 返回违规说明列表，空数组表示通过。
 * 这是纯校验，不修改输入，供写入前检查与测试使用。
 */
export function memoryViolations(memory: LongTermMemory[]): string[] {
  const issues: string[] = [];
  for (const m of memory) {
    if (m.confidence < 0 || m.confidence > 1)
      issues.push(`${m.id}: confidence 越界`);
    if (m.sourceType === "model_inferred" && m.confidence >= 1)
      issues.push(`${m.id}: 模型推断的记忆不能是满分把握`);
    if (m.sourceType === "user_confirmed" && m.confidence !== 1)
      issues.push(`${m.id}: 用户确认的记忆把握应为 1`);
    if (m.lastConfirmedAt < m.createdAt)
      issues.push(`${m.id}: lastConfirmedAt 早于 createdAt`);
    // 用户确认的记忆可以没有来源消息（来源就是用户本人），
    // 但 model_inferred 与 observed 必须能指回原始消息。
    if (m.sourceType !== "user_confirmed" && !m.sourceMessageIds.length)
      issues.push(`${m.id}: 缺少 sourceMessageIds`);
  }
  return issues;
}

/**
 * 记忆生命周期里，哪些状态还能参与解读。
 * contradicted / superseded / expired / archived 一律不参与，
 * 但它们的**内容不会被删除**，随时可以复盘。
 */
export function isUsableMemory(memory: LongTermMemory): boolean {
  return memory.status === "active";
}

/** 改变记忆状态。只改生命周期，绝不删除内容、也不改来源等级。 */
export function setMemoryStatus(
  memory: LongTermMemory,
  status: LongTermMemory["status"],
  now: string,
): LongTermMemory {
  return { ...memory, status, lastConfirmedAt: now };
}
