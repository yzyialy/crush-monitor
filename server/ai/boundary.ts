import type {
  BoundaryMeta,
  BoundaryViolationCode,
  DeepAnalysis,
} from "../../shared/types";

/**
 * Interpretation Boundary（解读边界）。
 *
 * 规格要求：任何最终显示给用户的第二层结果不得
 *   A. 声称知道对方真实内心
 *   B. 使用伪精确关系概率
 *   C. 把 model_inferred 当事实
 *   D. 把单条消息推断成长期关系结论
 *   E. 给出操纵性建议
 *   F. 诊断对方人格/精神状态
 *   G. 根据性别套刻板印象
 *
 * 三级策略（避免一个字段违规就让整份结果作废）：
 *   Level 1  可安全软化 → 就地改写为可能性措辞
 *   Level 2  单字段违规 → 只移除该字段，其余照常返回
 *   Level 3  致命违规   → 由调用方安全重试一次，仍失败则整份拒绝
 *
 * 纯函数，无网络调用，不读环境变量，不打印任何内容。
 */

// ---------------------------------------------------------------------------
// B. 伪精确关系概率
// ---------------------------------------------------------------------------

/**
 * 检测伪精确数字。
 * 返回命中的片段，空数组表示通过。
 */
export function findPseudoPrecision(text: string): string[] {
  const pattern =
    /\d{1,3}(?:\.\d+)?\s*(?:%|％)|(?:概率|几率|可能性|把握)\s*(?:约|大约|为|是|有)?\s*\d{1,3}(?:\.\d+)?/g;
  const hits = text.match(pattern);
  return hits ? [...new Set(hits)] : [];
}

/** 第二层输出的可扫描部分。 */
export type ScanTarget = {
  summary: string;
  surfaceSignals: string[];
  latentEmotion: { reading: string; conflictsWith: string[] };
  latentIntent: { reading: string; conflictsWith: string[] };
  conversationState: { reading: string; surfaceSignals: string[] };
  alternativeInterpretations: { interpretation: string }[];
  nextAction: { direction: string; principle: string | null } | null;
  contradiction: { description: string } | null;
  turningPoint: { description: string } | null;
};

/** 收集一份输出里所有面向用户的文本。 */
export function boundaryTexts(output: ScanTarget): string[] {
  return [
    output.summary,
    ...output.surfaceSignals,
    output.latentEmotion.reading,
    ...output.latentEmotion.conflictsWith,
    output.latentIntent.reading,
    ...output.latentIntent.conflictsWith,
    output.conversationState.reading,
    ...output.conversationState.surfaceSignals,
    ...output.alternativeInterpretations.map((x) => x.interpretation),
    output.nextAction?.direction ?? "",
    output.nextAction?.principle ?? "",
    output.contradiction?.description ?? "",
    output.turningPoint?.description ?? "",
  ].filter((t) => t.length > 0);
}

/** 对整份输出做伪精确扫描。 */
export function scanPseudoPrecision(output: ScanTarget): string[] {
  return [...new Set(boundaryTexts(output).flatMap(findPseudoPrecision))];
}

// ---------------------------------------------------------------------------
// 违规规则
// ---------------------------------------------------------------------------

type Rule = { code: BoundaryViolationCode; label: string; patterns: RegExp[] };

/**
 * 致命规则：一旦命中，整份结果不可信，必须重试或拒绝。
 * 只收录高置信度的表达，宁可漏检也不要误伤正常措辞。
 */
const FATAL_RULES: Rule[] = [
  {
    code: "manipulative_advice",
    label: "操纵性建议",
    patterns: [
      /(故意|刻意)(不理|冷淡|晾着|拖着|不回)/,
      /(欲擒故纵|冷处理|吊着|拿捏|pua)/i,
      /让(她|他|对方)(主动|着急|吃醋|嫉妒|紧张)/,
      /(策略性|试探性|套路式)地?(回复|发送|表达)/,
      /(欺骗|隐瞒|伪造)(她|他|对方)?/,
      /逼(她|他|对方)/,
    ],
  },
  {
    code: "personality_diagnosis",
    label: "诊断人格或精神状态",
    patterns: [
      /(回避型|焦虑型|安全型|恐惧型)(依恋|人格)?/,
      /(自恋型|边缘型|表演型|强迫型)(人格)?/,
      /(人格障碍|抑郁症|焦虑症|心理疾病|精神问题)/,
      /(她|他|对方)的性格(就是|是|属于)/,
    ],
  },
  {
    code: "gender_stereotype",
    label: "性别刻板印象",
    patterns: [
      /(女生|女孩子|女人)(都|就是|天生|向来)/,
      /(男生|男人|男的)(都|就是|天生|向来)/,
    ],
  },
];

/**
 * 字段级规则：只影响承载它的那个字段，其余字段照常返回。
 */
const FIELD_RULES: Rule[] = [
  {
    code: "single_message_long_term",
    label: "用单条消息推断长期关系",
    patterns: [
      /(这段关系|你们)(就是|已经)(完|结束|没救|走到头)/,
      /(她|他|对方)(根本|从来|一直)不(在乎|喜欢|在意|关心)你/,
      /(说明|证明)(她|他|对方)(一直|从来|根本)/,
    ],
  },
];

/** 断言式读心的软化规则。 */
const SOFTEN_RULES: [RegExp, string][] = [
  [/(她|他|对方)就是/g, "$1可能"],
  [/(她|他|对方)其实/g, "$1可能"],
  [/(她|他|对方)一定/g, "$1可能"],
  [/(她|他|对方)肯定/g, "$1可能"],
  [/(她|他|对方)明明/g, "$1看起来可能"],
  [/内心其实/g, "表面上看可能"],
  [/其实内心/g, "表面上可能"],
];

// 断言式读心：不要求后面一定跟「是」，因为「她一定觉得…」同样是断言
const ASSERTIVE = /(她|他|对方)(就是|其实|一定|肯定|明明)/;

/** 断言式读心的字段数量达到这个值，就认为整份输出建立在读心上。 */
export const MIND_READING_THRESHOLD = 3;

/** 文本是否包含断言式读心措辞。 */
export function hasAssertiveReading(text: string): boolean {
  return ASSERTIVE.test(text);
}

/** 软化文本，返回改写后的内容与被改写的片段。 */
export function soften(text: string): { text: string; changed: string[] } {
  let next = text;
  const changed: string[] = [];
  for (const [pattern, replacement] of SOFTEN_RULES) {
    if (pattern.test(next)) {
      changed.push(next.match(pattern)?.[0] ?? "");
      next = next.replace(pattern, replacement);
    }
  }
  return { text: next, changed: [...new Set(changed)] };
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export type BoundaryViolation = {
  code: BoundaryViolationCode;
  label: string;
  /** 出问题的字段路径 */
  field: string;
  /** 刻意不带违规原文：避免它进入日志或错误信息 */
  sample: "";
};

export type BoundaryOutcome = {
  /** 处理后的结果：软化已改写、单字段违规已移除 */
  analysis: DeepAnalysis;
  fatal: BoundaryViolation[];
  fieldLevel: BoundaryViolation[];
  meta: BoundaryMeta;
};

/** 兼容既有调用方的精简结果。 */
export type BoundaryResult = {
  analysis: DeepAnalysis;
  softened: string[];
  violations: BoundaryViolation[];
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 收集所有面向用户的文本字段（用于统计读心覆盖面）。 */
function collectFields(analysis: DeepAnalysis): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  const push = (field: string, text: string | null | undefined) => {
    if (typeof text === "string" && text.trim()) out.push({ field, text });
  };
  push("summary", analysis.summary);
  analysis.surfaceSignals.forEach((t) => push("surfaceSignals", t));
  push("latentEmotion.reading", analysis.latentEmotion.reading);
  analysis.latentEmotion.conflictsWith.forEach((t) =>
    push("latentEmotion.conflictsWith", t),
  );
  push("latentIntent.reading", analysis.latentIntent.reading);
  analysis.latentIntent.conflictsWith.forEach((t) =>
    push("latentIntent.conflictsWith", t),
  );
  push("conversationState.reading", analysis.conversationState.reading);
  analysis.conversationState.surfaceSignals.forEach((t) =>
    push("conversationState.surfaceSignals", t),
  );
  analysis.alternativeInterpretations.forEach((x) =>
    push("alternativeInterpretations", x.interpretation),
  );
  push("nextAction.direction", analysis.nextAction?.direction);
  push("nextAction.principle", analysis.nextAction?.principle);
  push("contradiction.description", analysis.contradiction?.description);
  push("turningPoint.description", analysis.turningPoint?.description);
  analysis.evidence.forEach((e) => push("evidence.quote", e.quote));
  return out;
}

/**
 * 执行边界检查。
 *
 * retried 只用于在 metadata 里记录本次结果是否来自重试，不改变判定逻辑。
 */
export function enforceBoundary(
  analysis: DeepAnalysis,
  retried = false,
): BoundaryOutcome {
  const softenedFields: string[] = [];
  const removedFields: string[] = [];
  const fatal: BoundaryViolation[] = [];
  const fieldLevel: BoundaryViolation[] = [];

  // --- 致命判定：大量内容都建立在「知道对方内心」上 ---
  // 按条目数统计（而不是去重后的字段数）：一句话一个断言，
  // 同一字段里堆三句断言同样说明整份输出建立在读心上。
  const mindEntries = collectFields(analysis).filter((entry) =>
    hasAssertiveReading(entry.text),
  );
  if (mindEntries.length >= MIND_READING_THRESHOLD)
    fatal.push({
      code: "mind_reading",
      label: "大量内容依赖对内心的断言",
      // 只记录字段名，绝不记录原文
      field: [...new Set(mindEntries.map((entry) => entry.field))]
        .sort()
        .join(","),
      sample: "",
    });

  // --- 逐字段处理：先软化（Level 1），再判定移除（Level 2）或致命（Level 3）---
  const process = (
    text: string,
    field: string,
  ): { text: string; removed: boolean } => {
    const t = text.trim();
    if (!t) return { text, removed: false };

    const result = soften(text);
    if (result.changed.length) softenedFields.push(field);
    const next = result.text;

    for (const rule of FATAL_RULES) {
      if (rule.patterns.some((p) => p.test(next))) {
        fatal.push({ code: rule.code, label: rule.label, field, sample: "" });
        return { text: next, removed: false };
      }
    }
    if (findPseudoPrecision(next).length) {
      fatal.push({
        code: "pseudo_precision",
        label: "使用伪精确关系概率",
        field,
        sample: "",
      });
      return { text: next, removed: false };
    }
    for (const rule of FIELD_RULES) {
      if (rule.patterns.some((p) => p.test(next))) {
        fieldLevel.push({
          code: rule.code,
          label: rule.label,
          field,
          sample: "",
        });
        removedFields.push(field);
        return { text: "", removed: true };
      }
    }
    return { text: next, removed: false };
  };

  const summary = process(analysis.summary, "summary");
  const surfaceSignals = analysis.surfaceSignals
    .map((t) => process(t, "surfaceSignals").text)
    .filter((t) => t.trim().length > 0);
  const emotion = process(analysis.latentEmotion.reading, "latentEmotion.reading");
  const intent = process(analysis.latentIntent.reading, "latentIntent.reading");
  const stateReading = process(
    analysis.conversationState.reading,
    "conversationState.reading",
  );
  const stateSignals = analysis.conversationState.surfaceSignals
    .map((t) => process(t, "conversationState.surfaceSignals").text)
    .filter((t) => t.trim().length > 0);
  const alternatives = analysis.alternativeInterpretations
    .map((item) => ({
      ...item,
      interpretation: process(
        item.interpretation,
        "alternativeInterpretations",
      ).text,
    }))
    .filter((item) => item.interpretation.trim().length > 0);
  const nextAction = (() => {
    if (!analysis.nextAction) return null;
    const direction = process(analysis.nextAction.direction, "nextAction.direction");
    const principle = analysis.nextAction.principle
      ? process(analysis.nextAction.principle, "nextAction.principle").text
      : null;
    if (!direction.text.trim() && !principle?.trim()) return null;
    return { ...analysis.nextAction, direction: direction.text, principle };
  })();
  const turningPoint = (() => {
    if (!analysis.turningPoint) return null;
    const text = process(analysis.turningPoint.description, "turningPoint.description");
    return text.text.trim()
      ? { ...analysis.turningPoint, description: text.text }
      : null;
  })();
  const contradiction = (() => {
    if (!analysis.contradiction) return null;
    const text = process(
      analysis.contradiction.description,
      "contradiction.description",
    );
    return text.text.trim()
      ? { ...analysis.contradiction, description: text.text }
      : null;
  })();
  const evidence = analysis.evidence.filter(
    (item) => process(item.quote, "evidence.quote").text.trim().length > 0,
  );

  const uniq = (list: string[]) => [...new Set(list)].sort();
  const meta: BoundaryMeta = {
    softenedFields: uniq(softenedFields),
    removedFields: uniq(removedFields),
    retried,
  };

  return {
    analysis: {
      ...analysis,
      summary: summary.text,
      surfaceSignals,
      latentEmotion: { ...analysis.latentEmotion, reading: emotion.text },
      latentIntent: { ...analysis.latentIntent, reading: intent.text },
      conversationState: { reading: stateReading.text, surfaceSignals: stateSignals },
      alternativeInterpretations: alternatives,
      nextAction,
      turningPoint,
      contradiction,
      evidence,
      boundary: meta,
    },
    fatal,
    fieldLevel,
    meta,
  };
}

/** 一次调用拿到旧版返回形状，供不关心三级策略的调用方使用。 */
export function enforceBoundaryCompat(analysis: DeepAnalysis): BoundaryResult {
  const outcome = enforceBoundary(analysis);
  return {
    analysis: outcome.analysis,
    softened: outcome.meta.softenedFields,
    violations: outcome.fatal,
  };
}

/** 旧接口：只做硬违规扫描，返回全部违规（含字段级）。 */
export function findHardViolations(output: ScanTarget): BoundaryViolation[] {
  const found: BoundaryViolation[] = [];
  const fields = boundaryTexts(output);
  for (const rule of [...FATAL_RULES, ...FIELD_RULES]) {
    for (const text of fields) {
      if (rule.patterns.some((p) => p.test(text)))
        found.push({
          code: rule.code,
          label: rule.label,
          field: rule.code,
          sample: "",
        });
    }
  }
  for (const _hit of scanPseudoPrecision(output))
    found.push({
      code: "pseudo_precision",
      label: "使用伪精确关系概率",
      field: "pseudo_precision",
      sample: "",
    });
  return found;
}
