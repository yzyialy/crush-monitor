import type { DeepAnalysis, Message } from "../../shared/types";

/**
 * messageId 引用归一化。
 *
 * 真实现象：模型为了省 token，会把 UUID 截断成 8 位（例如 540f42b5），
 * 并写进「你可能漏掉的信号」「可能是什么意思」这些用户可见的文本里，
 * 结果用户看到的是看不懂的乱码片段。
 *
 * 处理策略（在服务端做，不指望模型每次都听话）：
 *   1. 以本次请求的 messages 完整 messageId 为唯一合法来源；
 *   2. 文本里出现完整 UUID -> 还原成「第 N 条消息」；
 *   3. 出现 6-12 位前缀且**能唯一匹配** -> 同样还原；
 *   4. 匹配不到或有歧义 -> 不猜，降级为「相关消息」。
 *
 * 机器字段（evidence[].messageId、strongestEvidence）保持完整 UUID 不动：
 * 它们是用来点击定位的，不直接展示给用户。
 */

/** 完整 UUID（大小写不敏感） */
const FULL_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * 独立出现的 6-12 位十六进制片段，且至少含一个字母。
 * 前后不能紧邻字母或数字，避免误伤正常词汇（如 "abcdefg"）。
 */
const SHORT_ID = /(?<![0-9a-zA-Z])[0-9a-f]{6,12}(?![0-9a-zA-Z])/gi;

/** 清理替换后残留的英文前缀，例如「messageId 第 2 条消息」-> 「第 2 条消息」 */
const ID_LABEL = /\bmessage\s*id\b\s*(?=第 \d+ 条消息|相关消息)/gi;

const MIN_PREFIX = 6;
const MAX_PREFIX = 12;

export type ReferenceNormalization = {
  analysis: DeepAnalysis;
  /** 成功还原成「第 N 条消息」的次数 */
  resolved: number;
  /** 无法唯一匹配、降级成「相关消息」的次数 */
  unresolved: number;
};

/**
 * 用前缀唯一匹配一条消息，返回它的 1-based 序号。
 * 匹配到 0 条或多条都返回 null —— 绝不猜测。
 */
export function resolveMessagePrefix(
  prefix: string,
  messages: Message[],
): number | null {
  const p = prefix.toLowerCase();
  if (p.length < MIN_PREFIX || p.length > MAX_PREFIX) return null;
  let hit = -1;
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i].id.toLowerCase().startsWith(p)) continue;
    if (hit >= 0) return null; // 出现第二个匹配 -> 有歧义
    hit = i;
  }
  return hit >= 0 ? hit + 1 : null;
}

type Counters = { resolved: number; unresolved: number };

function normalizeText(
  text: string,
  messages: Message[],
  counters: Counters,
): string {
  if (!text) return text;

  // 先处理完整 UUID，避免它的片段被下一条规则重复命中
  let next = text.replace(FULL_UUID, (raw) => {
    const index = messages.findIndex((m) => m.id === raw);
    if (index >= 0) {
      counters.resolved++;
      return `第 ${index + 1} 条消息`;
    }
    counters.unresolved++;
    return "相关消息";
  });

  // 再处理被模型截断的前缀
  next = next.replace(SHORT_ID, (raw) => {
    const index = resolveMessagePrefix(raw, messages);
    if (index !== null) {
      counters.resolved++;
      return `第 ${index} 条消息`;
    }
    counters.unresolved++;
    return "相关消息";
  });

  return next.replace(ID_LABEL, "");
}

/**
 * 对整个 DeepAnalysis 的所有用户可见文本做归一化。
 * 纯函数，不修改输入；machineId 字段原样保留。
 */
export function normalizeMessageReferences(
  analysis: DeepAnalysis,
  messages: Message[],
): ReferenceNormalization {
  if (!messages.length)
    return { analysis, resolved: 0, unresolved: 0 };

  const counters: Counters = { resolved: 0, unresolved: 0 };
  const fix = (t: string) => normalizeText(t, messages, counters);

  const analysisOut: DeepAnalysis = {
    ...analysis,
    summary: fix(analysis.summary),
    surfaceSignals: analysis.surfaceSignals.map(fix),
    latentEmotion: {
      ...analysis.latentEmotion,
      reading: fix(analysis.latentEmotion.reading),
      conflictsWith: analysis.latentEmotion.conflictsWith.map(fix),
    },
    latentIntent: {
      ...analysis.latentIntent,
      reading: fix(analysis.latentIntent.reading),
      conflictsWith: analysis.latentIntent.conflictsWith.map(fix),
    },
    conversationState: {
      reading: fix(analysis.conversationState.reading),
      surfaceSignals: analysis.conversationState.surfaceSignals.map(fix),
    },
    alternativeInterpretations: analysis.alternativeInterpretations.map(
      (item) => ({
        ...item,
        interpretation: fix(item.interpretation),
        supportingEvidence: item.supportingEvidence.map(fix),
        contradictingEvidence: item.contradictingEvidence.map(fix),
      }),
    ),
    nextAction: analysis.nextAction
      ? {
          direction: fix(analysis.nextAction.direction),
          principle: analysis.nextAction.principle
            ? fix(analysis.nextAction.principle)
            : null,
        }
      : null,
    contradiction: analysis.contradiction
      ? {
          ...analysis.contradiction,
          description: fix(analysis.contradiction.description),
        }
      : null,
    turningPoint: analysis.turningPoint
      ? {
          ...analysis.turningPoint,
          description: fix(analysis.turningPoint.description),
        }
      : null,
    // evidence 与 strongestEvidence 是机器字段，保持完整 UUID
  };

  return {
    analysis: analysisOut,
    resolved: counters.resolved,
    unresolved: counters.unresolved,
  };
}

/** 判断一段文本里是否还残留裸 ID（供测试与诊断使用）。 */
export function findRawIds(text: string): string[] {
  const ids = [
    ...(text.match(FULL_UUID) ?? []),
    ...(text.match(SHORT_ID) ?? []),
  ];
  return [...new Set(ids)];
}
