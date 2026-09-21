import type { BoundaryViolationCode } from "./types";

/**
 * 诊断统计辅助。
 *
 * 只用本地已有的结果数组算统计：不做持久化、不上报、不写文件。
 *
 * 关键区分：
 *   rawCleanRate    —— 模型**原始**输出就干净的比例（保护层完全没介入）
 *   finalAcceptRate —— 最终被接受的比例（含被保护层救回来的）
 *
 * 两者差距越大，说明系统的可靠性越依赖保护层，而不是模型本身。
 * 只看 finalAcceptRate 会把这两种情况混为一谈。
 */

export type DeepRunOutcome = {
  /** 最终是否拿到了可用结果 */
  accepted: boolean;
  /** 是否发生过重试 */
  retried: boolean;
  softenedFields: string[];
  removedFields: string[];
  /** 本次（含重试前）触发过的违规类别 */
  violationCodes?: BoundaryViolationCode[];
};

export type DeepRunStats = {
  total: number;
  rawCleanRate: number;
  softenedRate: number;
  removedRate: number;
  retryRate: number;
  finalAcceptRate: number;
  violationCodeCounts: Record<string, number>;
};

const rate = (part: number, total: number) =>
  total === 0 ? 0 : Math.round((part / total) * 1000) / 1000;

export function summarizeRuns(runs: DeepRunOutcome[]): DeepRunStats {
  const total = runs.length;

  const violationCodeCounts: Record<string, number> = {};
  for (const run of runs)
    for (const code of run.violationCodes ?? [])
      violationCodeCounts[code] = (violationCodeCounts[code] ?? 0) + 1;

  // 「原始就干净」= 既没重试，也没有软化和字段移除
  const rawClean = runs.filter(
    (r) =>
      !r.retried &&
      r.softenedFields.length === 0 &&
      r.removedFields.length === 0,
  ).length;

  return {
    total,
    rawCleanRate: rate(rawClean, total),
    softenedRate: rate(
      runs.filter((r) => r.softenedFields.length > 0).length,
      total,
    ),
    removedRate: rate(
      runs.filter((r) => r.removedFields.length > 0).length,
      total,
    ),
    retryRate: rate(runs.filter((r) => r.retried).length, total),
    finalAcceptRate: rate(runs.filter((r) => r.accepted).length, total),
    violationCodeCounts,
  };
}
