import {
  SESSION_GAP_MINUTES,
  type LongTermMemory,
  type Message,
  type Observation,
  type Pattern,
  type PatternKind,
  type PatternTrend,
} from "./types";

/**
 * 模式引擎（deterministic）。
 *
 * 全部数字只来自程序计算：消息、时间戳、Jev 已给出的观察。
 * 任何 LLM 都不能产生或修改这些数字，只能解释它们。
 *
 * 核心结构是「会话内前后对比」：
 *   按时间排序 → 前半段 = baseline，后半段 = current → delta = current - baseline
 *
 * 硬约定（避免用户行为污染对方指标）：
 *   除 initiation_ratio 与 continuation_rate 需要看整个消息序列外，
 *   所有指标都**只统计 counterpart（对方）的行为**。
 *   例如 question_density 只算对方消息里的提问比例，
 *   不会因为用户问得多而把对方的提问密度拉高。
 *
 * 纯函数：不读当前时间，不用随机数，同样输入永远同样输出。
 */

const MINUTE = 60_000;

/**
 * 一轮对话的最大间隔。
 *
 * 超过它就算展开了新的一轮对话，因此跨天、隔夜的间隔不会被当成「回复延迟」，
 * 也不会污染长期基线。与 SESSION_GAP_MINUTES 同源，避免两处阈值漂移。
 */
export const CONVERSATION_GAP_MS = SESSION_GAP_MINUTES * MINUTE;

/** 正向与负向情绪分组，用于计算情绪漂移。 */
const POSITIVE_EMOTIONS = ["happy", "caring", "teasing", "shy"];
const NEGATIVE_EMOTIONS = ["angry", "sad", "annoyed", "disappointed"];

/** 体现主动靠近的意图，用于计算意图漂移。 */
const PROACTIVE_INTENTS = [
  "share",
  "care",
  "invite",
  "invite_hint",
  "flirt",
  "affection",
  "interest",
  "attention",
];

/** 提问的判定：问号，或句尾的「吗 / 呢」。 */
const QUESTION = /[?？]|(吗|呢)\s*$/;

/** 每半段的最少样本量，低于此值该指标判为 insufficient。 */
const MIN_SAMPLE = 2;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/**
 * 解析微信常见时间戳，返回可比较的毫秒数。
 * 一律按 UTC 解读墙上时间，避免运行环境时区影响结果。
 * 无法识别时返回 null —— 绝不用当前时间兜底。
 */
export function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const m = value
    .trim()
    .match(
      /^(\d{4})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
    );
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** 按时间间隔切分对话。没有可用时间戳时，整段视为一轮。 */
export function sliceSessions(messages: Message[]): Message[][] {
  const sessions: Message[][] = [];
  let current: Message[] = [];
  let last: number | null = null;
  for (const message of messages) {
    const at = parseTimestamp(message.timestamp);
    if (
      current.length &&
      at !== null &&
      last !== null &&
      at - last > CONVERSATION_GAP_MS
    ) {
      sessions.push(current);
      current = [];
    }
    current.push(message);
    if (at !== null) last = at;
  }
  if (current.length) sessions.push(current);
  return sessions;
}

/** 全部消息都有可解析时间戳时才按时间排序，否则保持原顺序。 */
function sortByTime(messages: Message[]): Message[] {
  const times = messages.map((m) => parseTimestamp(m.timestamp));
  if (times.some((t) => t === null)) return messages;
  return messages
    .map((m, i) => ({ m, i, t: times[i] as number }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/** 对半切：前半段当基线，后半段当当前。 */
export function splitHalf<T>(items: T[]): { baseline: T[]; current: T[] } {
  const mid = Math.floor(items.length / 2);
  return { baseline: items.slice(0, mid), current: items.slice(mid) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const average = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const chars = (text: string) => Array.from(text).length;
const readable = (messages: Message[]) =>
  messages.filter((m) => m.kind === "text");

/** 取观察里概率最高的一项，没有观察或全为 0 时返回 null。 */
function topKey(values: Record<string, number> | undefined): string | null {
  if (!values) return null;
  let best: string | null = null;
  let bestValue = -0;
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

/** 一组观察中命中给定标签集合的比例。 */
function shareOf(
  items: { top: string | null }[],
  keys: string[],
): number | null {
  const known = items.filter((x) => x.top !== null);
  if (!known.length) return null;
  const hit = known.filter((x) => keys.includes(x.top as string)).length;
  return round2(hit / known.length);
}

// ---------------------------------------------------------------------------
// 外部原因检测（只认对话里明确说过的现实原因）
// ---------------------------------------------------------------------------

const EXTERNAL_CAUSE_PATTERNS: { key: string; patterns: RegExp[] }[] = [
  {
    key: "work",
    patterns: [/加班/, /开会/, /项目/, /上线/, /排期/, /工作(很)?忙/, /忙不过来/, /赶工/, /值班/],
  },
  { key: "illness", patterns: [/生病/, /感冒/, /发烧/, /不舒服/, /医院/, /挂水/, /住院/] },
  { key: "injury", patterns: [/扭/, /受伤/, /摔/, /拉伤/, /医生/, /复诊/, /养伤/, /疼/] },
  { key: "exam", patterns: [/考试/, /复习/, /备考/, /论文/, /答辩/, /期末/] },
  { key: "trip", patterns: [/出差/, /外地/, /回老家/, /赶飞机/, /赶车/] },
  { key: "family", patterns: [/家里(有点|有)?事/, /家人/, /父母/, /照顾/] },
];

/** 返回对话中明确出现的外部原因类别。 */
export function detectExternalCauses(messages: Message[]): string[] {
  const text = messages.map((m) => m.text).join("\n");
  return EXTERNAL_CAUSE_PATTERNS.filter((c) =>
    c.patterns.some((p) => p.test(text)),
  ).map((c) => c.key);
}

// ---------------------------------------------------------------------------
// 指标定义
// ---------------------------------------------------------------------------

type MetricContext = {
  /** 该半段的全部消息，已按时间排序 */
  messages: Message[];
  /** 该半段的对方消息（仅可读文本） */
  counterpart: Message[];
  observations: Observation[];
};

type MetricResult = { value: number; sampleSize: number } | null;

type MetricSpec = {
  kind: PatternKind;
  label: string;
  /** +1：数值越大越说明「互动投入上升」；-1：越大越说明下降 */
  orientation: 1 | -1;
  /** absolute：delta 直接可比；relative：用相对变化率归一化 */
  scale: "absolute" | "relative";
  compute: (ctx: MetricContext) => MetricResult;
};

const counterpartObservations = (ctx: MetricContext): Observation[] => {
  const ids = new Set(ctx.counterpart.map((m) => m.id));
  return ctx.observations.filter((o) => ids.has(o.messageId));
};

/**
 * 指标定义表。这张表就是 docs/ARCHITECTURE.md 里指标定义的唯一来源。
 */
export const METRIC_DEFINITIONS: MetricSpec[] = [
  {
    kind: "initiation_ratio",
    label: "对方主动开启对话轮次的比例",
    orientation: 1,
    scale: "absolute",
    compute: (ctx) => {
      const sessions = sliceSessions(ctx.messages);
      if (sessions.length < MIN_SAMPLE) return null;
      const initiated = sessions.filter(
        (s) => s[0]?.sender === "other",
      ).length;
      return { value: round2(initiated / sessions.length), sampleSize: sessions.length };
    },
  },
  {
    kind: "reply_latency",
    label: "对方回复我方的平均延迟（分钟）",
    orientation: -1,
    scale: "relative",
    /**
     * 只统计「我方发言 → 对方紧接着回复」这一种间隔，并且
     * 0 < gap <= CONVERSATION_GAP_MS。
     *
     * 跨天、隔夜的间隔不是「回复慢」，而是新的一轮对话，
     * 一旦计入会把基线拉到几百分钟，让正常回复看起来像秒回。
     */
    compute: (ctx) => {
      const latencies: number[] = [];
      for (let i = 1; i < ctx.messages.length; i++) {
        const prev = ctx.messages[i - 1];
        const curr = ctx.messages[i];
        if (prev.sender !== "self" || curr.sender !== "other") continue;
        const from = parseTimestamp(prev.timestamp);
        const to = parseTimestamp(curr.timestamp);
        if (from === null || to === null) continue;
        const gap = to - from;
        // 非正间隔是脏数据；超过一轮对话上限的间隔属于新会话
        if (gap <= 0 || gap > CONVERSATION_GAP_MS) continue;
        latencies.push(gap / MINUTE);
      }
      if (latencies.length < MIN_SAMPLE) return null;
      return { value: round1(average(latencies)), sampleSize: latencies.length };
    },
  },
  {
    kind: "reply_length",
    label: "对方消息平均字数",
    orientation: 1,
    scale: "relative",
    compute: (ctx) =>
      ctx.counterpart.length < MIN_SAMPLE
        ? null
        : {
            value: round1(average(ctx.counterpart.map((m) => chars(m.text)))),
            sampleSize: ctx.counterpart.length,
          },
  },
  {
    kind: "question_density",
    label: "对方消息中提问的比例",
    orientation: 1,
    scale: "absolute",
    compute: (ctx) => {
      if (ctx.counterpart.length < MIN_SAMPLE) return null;
      const asked = ctx.counterpart.filter((m) => QUESTION.test(m.text)).length;
      return {
        value: round2(asked / ctx.counterpart.length),
        sampleSize: ctx.counterpart.length,
      };
    },
  },
  {
    kind: "continuation_rate",
    label: "对方发言后我方接上的比例",
    orientation: 1,
    scale: "absolute",
    compute: (ctx) => {
      // 衡量「对方的发言是否把对话继续下去，而不是终结」
      const eligible: number[] = [];
      ctx.messages.forEach((m, i) => {
        if (m.sender === "other" && i < ctx.messages.length - 1) eligible.push(i);
      });
      if (eligible.length < MIN_SAMPLE) return null;
      const continued = eligible.filter(
        (i) => ctx.messages[i + 1].sender === "self",
      ).length;
      return {
        value: round2(continued / eligible.length),
        sampleSize: eligible.length,
      };
    },
  },
  {
    kind: "closing_ratio",
    label: "对方消息中意图为结束聊天的比例",
    orientation: -1,
    scale: "absolute",
    compute: (ctx) => {
      const items = counterpartObservations(ctx).map((o) => ({
        top: topKey(o.intents),
      }));
      const known = items.filter((x) => x.top !== null);
      if (known.length < MIN_SAMPLE) return null;
      const closing = known.filter((x) => x.top === "close").length;
      return { value: round2(closing / known.length), sampleSize: known.length };
    },
  },
  {
    kind: "emotion_drift",
    label: "对方正负情绪净值",
    orientation: 1,
    scale: "absolute",
    compute: (ctx) => {
      const items = counterpartObservations(ctx).map((o) => ({
        top: topKey(o.emotions),
      }));
      const positive = shareOf(items, POSITIVE_EMOTIONS);
      const negative = shareOf(items, NEGATIVE_EMOTIONS);
      if (positive === null && negative === null) return null;
      return {
        value: round2((positive ?? 0) - (negative ?? 0)),
        sampleSize: items.filter((x) => x.top !== null).length,
      };
    },
  },
  {
    kind: "intent_drift",
    label: "对方主动靠近类意图占比",
    orientation: 1,
    scale: "absolute",
    compute: (ctx) => {
      const items = counterpartObservations(ctx).map((o) => ({
        top: topKey(o.intents),
      }));
      const proactive = shareOf(items, PROACTIVE_INTENTS);
      if (proactive === null) return null;
      return {
        value: proactive,
        sampleSize: items.filter((x) => x.top !== null).length,
      };
    },
  },
  {
    kind: "event_volume",
    label: "对方消息条数",
    orientation: 1,
    scale: "relative",
    compute: (ctx) =>
      ctx.counterpart.length < 1
        ? null
        : { value: ctx.counterpart.length, sampleSize: ctx.counterpart.length },
  },
];

const METRIC_BY_KIND = new Map(METRIC_DEFINITIONS.map((s) => [s.kind, s]));

/** 指标的静态定义（方向与量纲）。供基线、delta 与翻译层共用同一张表。 */
export function metricSpec(kind: PatternKind): MetricSpec | null {
  return METRIC_BY_KIND.get(kind) ?? null;
}

/** 指标的中文标签。未知指标回退成 kind 本身。 */
export function metricLabel(kind: PatternKind): string {
  return METRIC_BY_KIND.get(kind)?.label ?? String(kind);
}

/**
 * 把「当前值相对参照值」的变化归一化到 -1..1。
 *
 * 这是跨指标可比的唯一口径：绝对量纲的指标直接用差值，
 * 相对量纲的指标用相对变化率。会话内 delta 与历史 delta 都走这里，
 * 保证「这次和她平时比」与「这次前半段和后半段比」不会各算一套。
 */
export function normalizeMetricDelta(
  kind: PatternKind,
  current: number,
  reference: number,
): number {
  const spec = METRIC_BY_KIND.get(kind);
  const delta = current - reference;
  if (!spec || spec.scale === "absolute")
    return Math.max(-1, Math.min(1, delta));
  const base = Math.abs(reference);
  if (base === 0) return delta > 0 ? 1 : delta < 0 ? -1 : 0;
  return Math.max(-1, Math.min(1, delta / base));
}

/**
 * 从模式列表里取出每个可比指标当前的取值（后半段）。
 * 长期基线的更新输入就是这份取值表。
 */
export function sessionMetricValues(
  patterns: Pattern[],
): Partial<Record<PatternKind, number>> {
  const values: Partial<Record<PatternKind, number>> = {};
  for (const p of patterns) {
    if (!p.sufficient) continue;
    if (!Number.isFinite(p.value)) continue;
    values[p.kind] = p.value;
  }
  return values;
}

/** 模式定义表末尾追加的聚合量，不参与历史基线。 */
export const BASELINE_EXCLUDED_KINDS: PatternKind[] = [
  "baseline_delta",
  "event_volume",
];

/** 取最后一段对话（最近一轮）。历史比较只针对「这一次」。 */
export function latestSession(messages: Message[]): Message[] {
  const sessions = sliceSessions(sortByTime(messages));
  return sessions.at(-1) ?? [];
}

/**
 * initiation_ratio（对方主动开启对话的比例）本质上是**跨会话**统计：
 * 单独一轮对话里只有一个人开启，算不出比例。
 *
 * 因此它以「最近若干轮对话」为窗口，其余指标仍然只看最近这一轮。
 * 这样每一条指标都有明确、可复现的取样范围。
 */
export const INITIATION_WINDOW_SESSIONS = 4;

/**
 * 计算整段消息上的指标取值（不分前后半段）。
 *
 * 这是长期基线与历史 delta 的唯一输入：
 * 「这次她怎么样」必须看整段对话，而不是只看后半段。
 * 与 computePatterns 共用同一张指标表，口径不会漂移。
 *
 * windowMessages 只用于 initiation_ratio 这类跨会话指标；
 * 不传时退化为「就在 messages 上算」。
 */
export function computeSessionMetrics(input: {
  messages: Message[];
  observations: Observation[];
  windowMessages?: Message[];
}): Partial<Record<PatternKind, number>> {
  const ctx = buildContext(sortByTime(input.messages), input.observations);
  const values: Partial<Record<PatternKind, number>> = {};
  const window = input.windowMessages?.length
    ? buildContext(
        sliceSessions(sortByTime(input.windowMessages))
          .slice(-INITIATION_WINDOW_SESSIONS)
          .flat(),
        input.observations,
      )
    : null;

  for (const spec of METRIC_DEFINITIONS) {
    let result: MetricResult = null;
    try {
      const target = spec.kind === "initiation_ratio" && window ? window : ctx;
      result = spec.compute(target);
    } catch {
      result = null;
    }
    if (result && Number.isFinite(result.value)) values[spec.kind] = result.value;
  }
  return values;
}

// ---------------------------------------------------------------------------
// 主计算
// ---------------------------------------------------------------------------

export type PatternInput = {
  messages: Message[];
  observations: Observation[];
  memory?: LongTermMemory[];
};

function buildContext(
  messages: Message[],
  observations: Observation[],
): MetricContext {
  return {
    messages: readable(messages),
    counterpart: readable(messages).filter((m) => m.sender === "other"),
    observations,
  };
}

/**
 * 计算全部模式。
 *
 * 每个指标都在「前半段 / 后半段」上分别计算：
 *   baseline = 前半段取值，value = 后半段取值，delta = value - baseline
 * 任一半段样本不足时，该指标 sufficient=false 且 baseline/delta 为 null。
 */
export function computePatterns(input: PatternInput): Pattern[] {
  const ordered = sortByTime(input.messages);
  const { baseline: baseMsgs, current: currMsgs } = splitHalf(ordered);
  const baseCtx = buildContext(baseMsgs, input.observations);
  const currCtx = buildContext(currMsgs, input.observations);

  const patterns: Pattern[] = [];
  for (const spec of METRIC_DEFINITIONS) {
    let base: MetricResult = null;
    let curr: MetricResult = null;
    try {
      base = spec.compute(baseCtx);
      curr = spec.compute(currCtx);
    } catch {
      base = null;
      curr = null;
    }
    const sufficient = base !== null && curr !== null;
    patterns.push({
      kind: spec.kind,
      label: spec.label,
      value: curr?.value ?? 0,
      baseline: base?.value ?? null,
      delta:
        sufficient && base && curr
          ? round2(curr.value - base.value)
          : null,
      sampleSize: (base?.sampleSize ?? 0) + (curr?.sampleSize ?? 0),
      sufficient,
    });
  }

  // 聚合指标：有多少个指标相对前一段发生了明显变化
  const comparable = patterns.filter((p) => p.sufficient && p.delta !== null);
  const drifted = comparable.filter(
    (p) => Math.abs(normalizeDelta(p, METRIC_BY_KIND.get(p.kind)!)) >= 0.15,
  ).length;
  patterns.push({
    kind: "baseline_delta",
    label: "相对前一段发生明显变化的指标数量",
    value: drifted,
    baseline: null,
    delta: null,
    sampleSize: comparable.length,
    sufficient: comparable.length > 0,
  });

  return patterns;
}

/** 把 delta 归一化到 -1..1，便于跨指标比较。 */
function normalizeDelta(p: Pattern, spec: MetricSpec): number {
  return normalizeMetricDelta(
    p.kind,
    p.value,
    p.baseline ?? p.value,
  );
}

const TREND_THRESHOLD = 0.15;
const TREND_STRONG = 0.3;

/**
 * 由模式算出互动投入趋势。完全确定性，同输入必定同输出。
 *
 * 注意这衡量的是「互动投入」这一可观察行为，不是感情：
 * cooling 只表示互动投入下降，不表示关系变差。
 */
export function computePatternTrend(
  patterns: Pattern[],
  messages: Message[],
): PatternTrend {
  const externalCauses = detectExternalCauses(messages);
  const supporting: string[] = [];
  const conflicting: string[] = [];
  const scores: number[] = [];

  for (const p of patterns) {
    const spec = METRIC_BY_KIND.get(p.kind);
    if (!spec || !p.sufficient || p.delta === null) continue;
    const signed = normalizeDelta(p, spec) * spec.orientation;
    scores.push(signed);
    if (signed >= TREND_THRESHOLD) supporting.push(p.kind);
    else if (signed <= -TREND_THRESHOLD) conflicting.push(p.kind);
  }

  const externalCausePresent = externalCauses.length > 0;

  if (scores.length === 0)
    return {
      direction: "uncertain",
      confidence: "low",
      supportingMetrics: [],
      conflictingMetrics: [],
      externalCausePresent,
      externalCauses,
    };

  const avg = average(scores);
  let direction: PatternTrend["direction"];
  if (supporting.length >= 2 && conflicting.length >= 2 && Math.abs(avg) < TREND_STRONG)
    direction = "uncertain"; // 指标互相矛盾
  else if (avg >= TREND_THRESHOLD) direction = "warming";
  else if (avg <= -TREND_THRESHOLD) direction = "cooling";
  else direction = "stable";

  const dominant = Math.max(supporting.length, conflicting.length);
  const confidence: PatternTrend["confidence"] =
    direction === "uncertain"
      ? "low"
      : Math.abs(avg) >= TREND_STRONG && dominant >= 3
        ? "high"
        : Math.abs(avg) >= TREND_THRESHOLD && dominant >= 2
          ? "medium"
          : "low";

  return {
    direction,
    confidence,
    supportingMetrics: supporting.sort(),
    conflictingMetrics: conflicting.sort(),
    externalCausePresent,
    externalCauses,
  };
}

/** 把模式转成给第二层模型阅读的紧凑文本。数字只做搬运，不做加工。 */
export function describePatterns(patterns: Pattern[]): string[] {
  return patterns.map((p) => {
    if (!p.sufficient)
      return `${p.label}：样本不足（n=${p.sampleSize}）`;
    const base =
      p.baseline === null
        ? ""
        : `，前一段 ${p.baseline}，当前 ${p.value}，变化 ${p.delta !== null && p.delta > 0 ? "+" : ""}${p.delta}`;
    return `${p.label}：${p.value}（n=${p.sampleSize}${base}）`;
  });
}

/** 把互动投入趋势转成给模型阅读的文本。 */
export function describePatternTrend(trend: PatternTrend): string {
  const dir = {
    warming: "互动投入上升",
    stable: "互动基本稳定",
    cooling: "互动投入下降",
    uncertain: "趋势不明确",
  }[trend.direction];
  const parts = [`程序计算的互动投入趋势：${dir}（把握 ${trend.confidence}）`];
  if (trend.supportingMetrics.length)
    parts.push(`支持上升的指标：${trend.supportingMetrics.join("、")}`);
  if (trend.conflictingMetrics.length)
    parts.push(`支持下降的指标：${trend.conflictingMetrics.join("、")}`);
  if (trend.externalCausePresent)
    parts.push(
      `对话中出现明确的现实外部原因（${trend.externalCauses.join("、")}），互动变化可能由它解释`,
    );
  parts.push(
    "趋势由程序计算，你只能解释它，不能修改它的方向；若你认为趋势与实际不符，请写在 alternativeInterpretations 或 contradiction 里。",
  );
  return parts.join("。");
}
