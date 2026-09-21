import { boundedContext, relevantEvents } from "../../shared/memory";
import {
  computePatternTrend,
  computePatterns,
  computeSessionMetrics,
  latestSession,
} from "../../shared/patterns";
import { computeHistoricalTrend } from "../../shared/profile";
import {
  contextFromRelation,
  type BaselineMetricKind,
  type DeepAnalysisRequest,
} from "../../shared/types";

/**
 * 把客户端请求整理成第二层 provider 的输入。
 *
 * 硬规则：
 *   1. patterns 一律由服务端用 computePatterns 重新计算，
 *      客户端传入的任何数值都被丢弃。
 *   2. patternTrend（会话内互动趋势）由程序计算并填充，
 *      客户端传入值被忽略，模型也不能覆盖它。
 *   3. historicalTrend（跨会话历史趋势）同样由程序重新计算：
 *      客户端只负责把本地基线与检索到的相关记忆带上来，
 *      delta 数字一律在服务端算，避免前端算一套、后端算一套。
 *   4. 关系语境缺省时由 relation 推导，保证旧请求仍然可用。
 *
 * 纯函数，无网络调用，不持久化任何内容。
 */
export function buildProviderInput(
  data: DeepAnalysisRequest,
): DeepAnalysisRequest {
  const observations = data.observations;
  const messages = boundedContext(data.messages);
  const patterns = computePatterns({
    messages,
    observations,
    memory: data.memory,
  });
  const memory = relevantEvents(data.memory, messages);
  // 会话内趋势必须显式标记 scope=session，
  // 否则会和历史趋势被读成同一个 delta。
  const patternTrend = {
    ...computePatternTrend(patterns, messages),
    scope: "session" as const,
  };

  /**
   * 历史比较只针对「最近这一轮对话」：
   * boundedContext 里可能还有前几轮，把它们算进来会让「这次」失真。
   */
  const session = latestSession(messages);
  const sessionMetrics = computeSessionMetrics({
    messages: session.length ? session : messages,
    observations,
    // initiation_ratio 是跨会话指标，需要一个跨会话窗口
    windowMessages: messages,
  });

  const profile = data.profile
    ? {
        ...data.profile,
        // 历史 delta 由服务端重新计算，客户端传来的任何数字都不采信
        historicalTrend: computeHistoricalTrend(
          data.profile.baseline,
          sessionMetrics as Partial<Record<BaselineMetricKind, number>>,
        ),
      }
    : undefined;

  return {
    revision: data.revision,
    relation: data.relation,
    targetId: data.targetId,
    messages,
    observations,
    memory,
    patterns,
    relationshipContext:
      data.relationshipContext ?? contextFromRelation(data.relation),
    patternTrend,
    profile,
    historicalTrend: profile?.historicalTrend,
  };
}
