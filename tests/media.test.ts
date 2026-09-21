import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest } from "../server/analysis";
import { buildPayload } from "../server/ai/deepseek";
import {
  hasMediaDescription,
  mediaNoun,
  mediaPromptText,
  parseMediaMarker,
} from "../shared/media";
import { mergeMessages, parseChat, toMessages } from "../shared/parser";
import { computeSessionMetrics } from "../shared/patterns";
import type { Message, Observation } from "../shared/types";

/**
 * 媒体消息（语音 / 图片 / 表情包）的测试。
 *
 * 核心约定：
 *   - 只有占位、没有补充内容 → 不可读，不参与分析（与以前一致）
 *   - 占位后面补了内容 → 参与分析，但模型必须知道「这是用户转述，不是原文」
 *   - 补的描述不能污染统计口径（长度按用户写的描述算，不含「[语音]」标记）
 */

const SELF = "self" as const;
const OTHER = "other" as const;

/** 用真实的解析链路构造消息，避免测试自己造一个假的输入。 */
function importChat(raw: string, self = "我"): Message[] {
  const parsed = parseChat(raw);
  return toMessages(parsed.messages, self);
}

test("1. 只认整条消息开头的占位，正文中间的方括号是普通文字", () => {
  assert.deepEqual(parseMediaMarker("[语音] 她说周末要加班"), {
    kind: "voice",
    label: "语音",
    note: "她说周末要加班",
  });
  assert.deepEqual(parseMediaMarker("[图片]一只橘猫"), {
    kind: "image",
    label: "图片",
    note: "一只橘猫",
  });
  assert.deepEqual(parseMediaMarker("[动画表情] 笑得打滚"), {
    kind: "sticker",
    label: "动画表情",
    note: "笑得打滚",
  });
  // 描述换行写在下面也要认
  assert.equal(parseMediaMarker("[语音]\n她说周末要加班")?.note, "她说周末要加班");

  // 只有占位：note 为空串
  assert.deepEqual(parseMediaMarker("[语音]"), {
    kind: "voice",
    label: "语音",
    note: "",
  });
  assert.deepEqual(parseMediaMarker("[语音]   "), {
    kind: "voice",
    label: "语音",
    note: "",
  });

  // 不认识的方括号、或不在开头 → 不是媒体占位
  assert.equal(parseMediaMarker("[笑死] 这也行"), null);
  assert.equal(parseMediaMarker("我发了[图片]你看到了吗"), null);
  assert.equal(parseMediaMarker("普通文本"), null);

  // 占位之后的所有内容都算补充描述（里面再出现方括号也照收）
  assert.deepEqual(parseMediaMarker("[语音]后[图片]"), {
    kind: "voice",
    label: "语音",
    note: "后[图片]",
  });
});

test("2. 没补内容的媒体消息仍然不可读，不参与分析", () => {
  const messages = importChat(
    ["对方 21:00", "[语音]", "对方 21:01", "[图片]", "我 21:02", "在吗"].join("\n"),
  );
  const voice = messages.find((m) => m.text === "[语音]")!;
  assert.equal(voice.kind, "unreadable");
  assert.equal(voice.mediaKind, "voice");
  assert.equal(hasMediaDescription(voice), false);

  const image = messages.find((m) => m.text === "[图片]")!;
  assert.equal(image.kind, "unreadable");
  assert.equal(image.mediaKind, "image");

  // 普通消息不带 mediaKind
  const plain = messages.find((m) => m.text === "在吗")!;
  assert.equal(plain.mediaKind, undefined);
  assert.equal(plain.kind, "text");
});

test("3. 补了内容的媒体消息变成可读，正文只保留用户写的描述", () => {
  const messages = importChat(
    [
      "对方 21:00",
      "[语音] 她说周末要加班，可能来不了",
      "对方 21:02",
      "[图片] 一张在加班的工位照片",
      "对方 21:04",
      "[动画表情] 笑得打滚",
      "我 21:05",
      "[语音] 我说那我改天再约",
    ].join("\n"),
  );

  const voice = messages[0];
  assert.equal(voice.kind, "text");
  assert.equal(voice.mediaKind, "voice");
  assert.equal(voice.sender, OTHER);
  // 正文不含「[语音]」标记，只保留描述本身
  assert.equal(voice.text, "她说周末要加班，可能来不了");
  assert.equal(hasMediaDescription(voice), true);

  const image = messages[1];
  assert.equal(image.mediaKind, "image");
  assert.equal(image.text, "一张在加班的工位照片");

  const sticker = messages[2];
  assert.equal(sticker.mediaKind, "sticker");
  assert.equal(mediaNoun(sticker.mediaKind!), "表情包");
  assert.equal(sticker.text, "笑得打滚");

  const mine = messages[3];
  assert.equal(mine.sender, SELF);
  assert.equal(mine.mediaKind, "voice");
  assert.equal(mine.text, "我说那我改天再约");
});

test("4. 给模型看的正文必须说明这是转述", () => {
  const [described] = importChat("对方 21:00\n[语音] 她说周末要加班");
  const framed = mediaPromptText(described);
  assert.ok(framed.includes("对方"), framed);
  assert.ok(framed.includes("语音"), framed);
  assert.ok(framed.includes("转述"), `必须说明是转述：${framed}`);
  assert.ok(framed.includes("不是原始文字"), framed);
  assert.ok(framed.includes("她说周末要加班"), framed);

  // 我方发出的媒体也要区分归属
  const [mine] = importChat("我 21:00\n[图片] 我拍的猫");
  assert.ok(mediaPromptText(mine).includes("我方"), mediaPromptText(mine));

  // 没补内容的媒体：明确告诉模型内容不可见
  const [empty] = importChat("对方 21:00\n[图片]");
  const emptyText = mediaPromptText(empty);
  assert.ok(emptyText.includes("内容不可见"), emptyText);
  assert.ok(emptyText.includes("没有补充描述"), emptyText);

  // 普通消息一个字都不改
  const [plain] = importChat("对方 21:00\n今天很累");
  assert.equal(mediaPromptText(plain), "今天很累");
});

test("5. 描述不污染统计口径：长度只算用户写的描述", () => {
  const observations: Observation[] = [];
  const plain = "今天很累";
  const note = "她说周末要加班来不了";

  const [described] = importChat(`对方 21:02\n[语音] ${note}`);
  const [plainMessage] = importChat(`对方 21:00\n${plain}`);

  const withMedia: Message[] = [
    { ...plainMessage, id: "m1", timestamp: "2026-09-20 21:00" },
    { ...described, id: "m2", timestamp: "2026-09-20 21:02" },
  ];
  const metrics = computeSessionMetrics({ messages: withMedia, observations });
  assert.equal(
    metrics.reply_length,
    (Array.from(plain).length + Array.from(note).length) / 2,
    "回复长度必须等于用户写的描述长度，不含「[语音]」标记",
  );

  // 没补内容的媒体消息不进入统计
  const [empty] = importChat("对方 21:05\n[语音]");
  const after = computeSessionMetrics({
    messages: [...withMedia, { ...empty, id: "m3", timestamp: "2026-09-20 21:05" }],
    observations,
  });
  assert.equal(
    after.reply_length,
    metrics.reply_length,
    "不可读的媒体消息不能进入长度统计",
  );
});

test("6. 两条模型链路都会把媒体消息标成转述", () => {
  const messages = importChat(
    [
      "对方 21:00",
      "[语音] 她说周末要加班",
      "对方 21:02",
      "普通的一句话",
    ].join("\n"),
  );

  // 第一层（Jev）
  const request = buildRequest({
    revision: 1,
    relation: "crush",
    task: "other_messages",
    targetIds: [messages[0].id, messages[1].id],
    messages,
  }) as { state: { messages: { id: string; text: string }[] } };
  const voiceLine = request.state.messages.find((m) => m.id === messages[0].id)!;
  assert.ok(voiceLine.text.includes("转述"), voiceLine.text);
  assert.equal(voiceLine.text.includes("[语音]"), false, "不该把占位当成正文");
  const plainLine = request.state.messages.find((m) => m.id === messages[1].id)!;
  assert.equal(plainLine.text, "普通的一句话");

  // 第二层（DeepSeek）
  const payload = buildPayload({
    revision: 1,
    relation: "crush",
    targetId: null,
    messages,
    observations: [],
    memory: [],
    patterns: [],
  }) as { messages: { id: string; text: string }[] };
  const deepVoice = payload.messages.find((m) => m.id === messages[0].id)!;
  assert.ok(deepVoice.text.includes("转述"), deepVoice.text);
  assert.equal(payload.messages.find((m) => m.id === messages[1].id)!.text, "普通的一句话");
});

test("7. 重新粘贴同一段（含补充描述）不会被当成新消息", () => {
  const raw = [
    "我 21:00",
    "在吗",
    "对方 21:02",
    "[语音] 她说周末要加班",
    "我 21:03",
    "好",
  ].join("\n");

  const first = importChat(raw);
  const again = importChat(raw);
  const merged = mergeMessages(first, again);
  assert.equal(merged.added, 0, "同样的文本不该被当成新增");
  assert.equal(merged.messages.length, first.length);
  assert.deepEqual(
    merged.messages.map((m) => m.text),
    first.map((m) => m.text),
  );

  // 描述写得更完整时，那一条会被识别成不同内容（由用户决定怎么合并）
  const improved = importChat(raw.replace("她说周末要加班", "她说周末要加班，来不了"));
  assert.notDeepEqual(
    improved.map((m) => m.text),
    first.map((m) => m.text),
  );
});
