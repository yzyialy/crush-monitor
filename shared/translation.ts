import { describeComparedToUsual, STYLE_METRICS } from "./profile";
import type {
  DeepAnalysis,
  HistoricalPatternTrend,
  PatternTrend,
  Trend,
  UncertaintyLevel,
  UserTranslation,
} from "./types";

/**
 * 用户翻译层。
 *
 * 把第二层的解释整理成用户能读的结构，并在这里做最后一道闸门：
 *   1. 任何命令式的关系建议都不得进入这一层；
 *   2. 互动投入下降 + 存在明确外部原因时，不能简单呈现为「互动降温」。
 *
 * 这一层只组装与过滤，不产生新判断，也不做任何模型调用。
 */

const IMPERATIVE_WORDS = [
  "应该",
  "应当",
  "必须",
  "一定要",
  "务必",
  "赶紧",
  "马上",
  "立刻",
  "建议你",
  "你需要",
  "你最好",
];

/** 返回文本中出现的命令式措辞，空数组表示通过。 */
export function findImperative(text: string): string[] {
  return IMPERATIVE_WORDS.filter((word) => text.includes(word));
}

/**
 * 趋势文案。
 * 刻意用「互动投入」而不是「关系」：cooling 只表示可观察的互动变化，
 * 不表示感情变差。
 */
const TREND_LABEL: Record<Trend, string> = {
  warming: "互动投入上升",
  stable: "互动基本稳定",
  cooling: "互动投入下降",
  uncertain: "趋势不明确",
};

const UNCERTAINTY_LABEL: Record<UncertaintyLevel, string> = {
  low: "整体把握较高",
  medium: "整体把握一般",
  high: "整体把握很低",
};

/** 外部原因的中文标签。key 与 shared/patterns.ts 的检测表一致。 */
const CAUSE_LABEL: Record<string, string> = {
  work: "工作繁忙",
  illness: "身体不适",
  injury: "受伤",
  exam: "考试或学业压力",
  trip: "出差或出行",
  family: "家庭事务",
  other: "其他现实原因",
};

const causeText = (causes: string[]) =>
  causes.map((c) => CAUSE_LABEL[c] ?? c).join("、");

/** 过滤掉空串与命令式句子。 */
function keep(items: string[]): string[] {
  return items
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && findImperative(x).length === 0);
}

/**
 * 组装用户翻译。
 * patternTrend 可选：传入时用于外部原因修正。
 * historicalTrend 可选：传入时生成「和她平时相比」。
 */
export function buildTranslation(
  analysis: DeepAnalysis,
  patternTrend?: PatternTrend,
  historicalTrend?: HistoricalPatternTrend | null,
): UserTranslation {
  const { latentEmotion, latentIntent, conversationState } = analysis;

  // 客观事实：只放描述性内容，不放解释。
  const whatHappened = keep([analysis.summary, ...analysis.surfaceSignals]);

  // 可能被忽略的信号：带「可能」措辞的读法 + 对话状态里的表层信号。
  const whatYouMightMiss = keep([
    latentEmotion.reading,
    latentIntent.reading,
    ...conversationState.surfaceSignals,
  ]);

  /**
   * 外部原因修正：
   * 互动投入下降 + 对话里有明确现实原因时，
   * 不能把下降直接呈现为关系层面的结论。
   */
  const externalCorrection =
    patternTrend?.externalCausePresent && analysis.trend === "cooling"
      ? `互动投入有所下降，但对话中存在明确的现实外部原因（${causeText(
          patternTrend.externalCauses,
        )}），不能据此判断关系变化。`
      : null;

  // 不确定的部分：把握分级 + 各读法里未被排除的冲突证据。
  const uncertainty = keep([
    UNCERTAINTY_LABEL[analysis.uncertainty],
    ...(externalCorrection ? [externalCorrection] : []),
    ...(analysis.status === "insufficient_context"
      ? ["当前证据不足以支撑确定性解释"]
      : []),
    ...latentEmotion.conflictsWith,
    ...latentIntent.conflictsWith,
    ...(analysis.contradiction ? [analysis.contradiction.description] : []),
  ]);

  /**
   * 「和她平时相比」。
   *
   * 会话内趋势（前半段 vs 后半段）与历史基线（这次 vs 过去多次）必须分开表达，
   * 否则会出现「她变冷了」这种把两种 delta 混在一起的结论。
   */
  const withinUsualRange =
    historicalTrend &&
    !historicalTrend.insufficientHistory &&
    analysis.trend === "cooling" &&
    historicalTrend.deltas.every((d) => d.significance === "none")
      ? "这段对话内部后半段比前半段安静一些，但整体仍然接近她自己平时的水平，更可能只是这一段的节奏。"
      : null;

  const comparedToUsual = keep([
    ...(historicalTrend ? describeComparedToUsual(historicalTrend) : []),
    ...(withinUsualRange ? [withinUsualRange] : []),
    // 模型只能补充含义，数字部分由程序给出；它也可能是 null
    ...(analysis.historicalNote ? [analysis.historicalNote] : []),
  ]);

  // 下一步观察什么（不是做什么）。
  const whatToWatchNext = keep([
    ...(externalCorrection ? [externalCorrection] : []),
    ...(analysis.nextAction ? [analysis.nextAction.direction] : []),
    ...(analysis.nextAction?.principle
      ? [`背后的原则：${analysis.nextAction.principle}`]
      : []),
    TREND_LABEL[analysis.trend],
    ...(analysis.turningPoint
      ? [`留意转折：${analysis.turningPoint.description}`]
      : []),
    // 一直如此的行为特征不该被当成变化信号
    ...(historicalTrend
      ? historicalTrend.deltas
          .filter(
            (d) =>
              STYLE_METRICS.includes(d.metric) && d.significance === "none",
          )
          .map(
            (d) =>
              `${d.label}这次与她平时接近（本次 ${d.current}，平时约 ${d.historical}），不必把它当成变化。`,
          )
      : []),
  ]);

  const strongestEvidence = [
    ...new Set([
      ...analysis.evidence.map((e) => e.messageId),
      ...(analysis.turningPoint?.messageId
        ? [analysis.turningPoint.messageId]
        : []),
    ]),
  ];

  return {
    whatHappened,
    whatYouMightMiss,
    possibleMeanings: analysis.alternativeInterpretations,
    strongestEvidence,
    uncertainty,
    whatToWatchNext,
    comparedToUsual,
  };
}

/** 趋势的中文文案，供 UI 复用。 */
export function trendLabel(trend: Trend): string {
  return TREND_LABEL[trend];
}
