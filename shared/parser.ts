import { randomId } from "./hash";
import { parseMediaMarker } from "./media";
import type { Message, Parsed } from "./types";
const time =
  "(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}\\s+)?\\d{1,2}:\\d{2}(?::\\d{2})?";
const header = new RegExp(`^(.{1,40}?)\\s+(${time})$`);
const bracket = new RegExp(`^\\[(${time})\\]\\s*(.{1,40}?)[：:]\\s*(.*)$`);
export function parseChat(raw: string): {
  messages: Parsed[];
  warnings: string[];
} {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const messages: Parsed[] = [];
  const warnings: string[] = [];
  const nativeFormat = lines.some((l) =>
    /^\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}/.test(l.trim()),
  );
  let current: Parsed | undefined;
  const push = () => {
    if (current?.text.trim())
      messages.push({ ...current, text: current.text.trim() });
    current = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1]?.trim();
    if (
      line.trim() &&
      next &&
      /^\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}(?::\d{2})?$/.test(next)
    ) {
      push();
      current = { speaker: line.trim(), timestamp: next, text: "" };
      i++;
      continue;
    }
    if (!line.trim()) {
      if (current) current.text += "\n";
      continue;
    }
    const b = line.match(bracket);
    const h = line.match(header);
    const inline = line.match(/^([^\s：:<>]{1,24})[：:]\s*(.*)$/);
    if (!nativeFormat && b) {
      push();
      current = { speaker: b[2], timestamp: b[1], text: b[3] };
      continue;
    }
    if (!nativeFormat && h) {
      push();
      current = { speaker: h[1], timestamp: h[2], text: "" };
      continue;
    }
    if (
      !nativeFormat &&
      inline &&
      !/^https?$/.test(inline[1]) &&
      !/^\d+$/.test(inline[1])
    ) {
      push();
      current = { speaker: inline[1], timestamp: null, text: inline[2] };
      continue;
    }
    if (current) {
      current.text += (current.text ? "\n" : "") + line;
    } else {
      current = { speaker: "未分配", timestamp: null, text: line };
      warnings.push("有文本未识别出说话人，请校正。");
    }
  }
  push();
  const speakers = new Set(messages.map((m) => m.speaker));
  if (speakers.size > 2)
    warnings.push("识别到两人以上或正文中的冒号，请校正消息边界和角色。");
  if (!messages.length) warnings.push("还没有可以读取的聊天文本。");
  return { messages, warnings: [...new Set(warnings)] };
}
export function toMessages(parsed: Parsed[], self: string): Message[] {
  return parsed.map((m) => {
    const sender = m.speaker === self ? "self" : "other";
    const media = parseMediaMarker(m.text);
    /**
     * 媒体消息分两种：
     *   - 只有占位、没有补充 → 保持不可读（不参与分析）
     *   - 占位后面补了内容 → 当成可读正文，并记下 mediaKind，
     *     让模型知道这是用户转述/描述，不是对方原文
     */
    if (!media)
      return {
        id: randomId(),
        sender,
        text: m.text,
        timestamp: m.timestamp,
        kind: "text" as const,
      };
    return {
      id: randomId(),
      sender,
      text: media.note ? media.note : m.text,
      timestamp: m.timestamp,
      kind: media.note ? ("text" as const) : ("unreadable" as const),
      mediaKind: media.kind,
    };
  });
}
function equal(a: Message, b: Message) {
  return (
    a.sender === b.sender &&
    a.text === b.text &&
    (!a.timestamp || !b.timestamp || a.timestamp === b.timestamp)
  );
}
export type Merge = {
  messages: Message[];
  added: number;
  overlap: number;
  ambiguous: boolean;
  duplicate: boolean;
};
export function mergeMessages(
  old: Message[],
  incoming: Message[],
  mode: "auto" | "append" | "skip" = "auto",
): Merge {
  if (mode === "append")
    return {
      messages: [...old, ...incoming],
      added: incoming.length,
      overlap: 0,
      ambiguous: false,
      duplicate: false,
    };
  if (!old.length)
    return {
      messages: incoming,
      added: incoming.length,
      overlap: 0,
      ambiguous: false,
      duplicate: false,
    };
  // An exact batch is not ambiguous: explicitly repeated import.
  if (
    old.length === incoming.length &&
    old.every((m, i) => equal(m, incoming[i]))
  )
    return {
      messages: old,
      added: 0,
      overlap: incoming.length,
      ambiguous: false,
      duplicate: true,
    };
  let overlap = 0;
  for (let n = Math.min(old.length, incoming.length); n > 0; n--) {
    if (old.slice(-n).every((m, i) => equal(m, incoming[i]))) {
      overlap = n;
      break;
    }
  }
  const contained =
    incoming.length > 1 &&
    old.some(
      (_, i) =>
        i + incoming.length <= old.length &&
        incoming.every((m, j) => equal(old[i + j], m)),
    );
  if (contained)
    return {
      messages: old,
      added: 0,
      overlap: incoming.length,
      ambiguous: false,
      duplicate: true,
    };
  const interior =
    overlap === 0 && incoming.some((m) => old.some((o) => equal(o, m)));
  const matches =
    overlap > 0
      ? old.filter(
          (_, i) =>
            i + overlap <= old.length &&
            incoming.slice(0, overlap).every((m, j) => equal(old[i + j], m)),
        ).length
      : 0;
  const stamp = (s: string | null) =>
    s && /^\d{4}/.test(s)
      ? Date.parse(
          s
            .replace("年", "-")
            .replace("月", "-")
            .replace("日", "")
            .replace(" ", "T"),
        )
      : NaN;
  const firstNew = incoming[overlap];
  const backwards =
    firstNew && stamp(firstNew.timestamp) < stamp(old.at(-1)!.timestamp);
  const ambiguous =
    mode === "auto" &&
    ((overlap === 1 && !incoming[0].timestamp) ||
      interior ||
      matches > 1 ||
      Boolean(backwards));
  return {
    messages: [...old, ...incoming.slice(overlap)],
    added: incoming.length - overlap,
    overlap,
    ambiguous,
    duplicate: false,
  };
}
export function withinScope(messages: Message[]) {
  return (
    messages.length <= 120 &&
    Array.from(messages.map((m) => m.text).join("")).length <= 24000
  );
}
export function recentScope(messages: Message[]) {
  const result: Message[] = [];
  let chars = 0;
  for (const m of [...messages].reverse()) {
    const len = Array.from(m.text).length;
    if (result.length === 120 || chars + len > 24000) break;
    result.unshift(m);
    chars += len;
  }
  return result;
}
export function normalizedEditor(messages: Parsed[]) {
  return messages.map((m) => `${m.speaker}：${m.text}`).join("\n");
}
