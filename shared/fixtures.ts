import {
  type Message,
  type Snapshot,
  type Judgment,
  type LineResult,
} from "./types";
export const examples = [
  {
    name: "先冷后暖",
    tag: "原来还有下一句",
    relation: "crush" as const,
    lines: [
      ["self", "周六要不要一起吃饭？"],
      ["other", "这周有点忙"],
      ["self", "那你先忙，等有空再说～"],
      ["other", "但周日晚上可以呀"],
      ["other", "你不是一直想去那家小酒馆吗？"],
      ["self", "你居然还记得，那周日我订位置"],
      ["other", "当然记得。和你说的话我都有认真听 :)"],
    ],
  },
  {
    name: "礼貌婉拒",
    tag: "体面收尾，也很妙",
    relation: "crush" as const,
    lines: [
      ["self", "周末要不要出去走走？"],
      ["other", "谢谢你，不过我只想和你做普通朋友。"],
      ["self", "明白，谢谢你直接告诉我。"],
      ["other", "也谢谢你的理解。"],
    ],
  },
  {
    name: "情侣拌嘴",
    tag: "先接情绪，再接话",
    relation: "couple" as const,
    lines: [
      ["other", "你今天都没怎么理我"],
      ["self", "工作有点多，刚刚忙完。"],
      ["other", "我知道你忙，但我也想被惦记一下。"],
      ["self", "是我没顾上，下次忙之前先和你说一声。今天累不累？"],
      ["other", "其实有点。你现在能陪我聊一会吗？"],
    ],
  },
];
export function exampleText(index: number) {
  return examples[index].lines
    .map(([s, t]) => `${s === "self" ? "我" : "Crush"}：${t}`)
    .join("\n");
}
const j = (value: number | null): Judgment => ({
  value,
  confidence: value === null ? 0.2 : 0.82,
  status: value === null ? "insufficient" : "clear",
  probabilities:
    value === null
      ? { "0": 0.2, "1": 0.2, "2": 0.2, "3": 0.2, "4": 0.2 }
      : { "3": 0.2, "4": 0.8 },
});
export function fixtureSnapshot(
  index: number,
  count: number,
  revision: number,
): Snapshot {
  const e = examples[index];
  const messages: Message[] = e.lines
    .slice(0, count)
    .map(([sender, text], i) => ({
      id: `fixture-${index}-${i}`,
      sender: sender as "self" | "other",
      text,
      timestamp: null,
      kind: "text",
    }));
  const lines: Record<string, LineResult> = {};
  const full = count === e.lines.length;
  const values =
    index === 0
      ? [72, null, 84, 79, 88, 86, 94]
      : index === 1
        ? [68, 12, 91, 38]
        : [42, 55, 54, 88, 73];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    lines[m.id] = {
      id: m.id,
      score: j(values[i]),
      ...(m.sender === "other"
        ? {
            tone:
              index === 0
                ? "warm"
                : index === 1
                  ? "polite"
                  : i === 0 || i === 2
                    ? "upset"
                    : "warm",
            tones: { warm: 0.8, neutral: 0.15, unknown: 0.05 },
            toneConfidence: 0.8,
          }
        : {}),
    };
  }
  return {
    revision,
    messages,
    lines,
    relation: e.relation,
    at: new Date().toISOString(),
    source: "fixture",
    latencyMs: 0,
    comparable: count > 2,
    overview: {
      affinity: j(
        index === 0
          ? full
            ? 86
            : count >= 4
              ? 74
              : null
          : index === 1
            ? 23
            : 64,
      ),
      stage:
        index === 0 && count >= 4 ? "date" : index === 0 ? "flow" : "contact",
      rapport: index === 2 ? j(72) : undefined,
      action:
        index === 1
          ? "respect"
          : index === 2
            ? "empathize"
            : full
              ? "continue"
              : count % 2
                ? "wait"
                : "clarify",
      evidenceId: messages.at(-1)?.id || null,
      actionEvidenceId: messages.at(-1)?.id || null,
    },
  };
}
