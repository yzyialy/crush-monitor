import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseChat,
  toMessages,
  mergeMessages,
  withinScope,
  recentScope,
} from "../shared/parser";
import { grade, meanQuality } from "../shared/types";
import { judgment, actionResult, percentages } from "../shared/rules";
import { buildRequest, requestSchema } from "../server/analysis";
const realShape =
  "甲\n2026年09月19日 12:18\n刚才在做什么\n\n乙\n2026年09月19日 12:19\n整理书架\n\n乙\n2026年09月19日 12:19\n发现几本旧书\n\n乙\n2026年09月19日 12:19\n翻着翻着就看入迷了\n\n甲\n2026年09月19日 12:20\n听起来是个悠闲的下午";
const msg = (text: string) => toMessages(parseChat(text).messages, "我");
test("真实微信三行头格式：5条消息、连续同人、时间完整", () => {
  const r = parseChat(realShape);
  assert.equal(r.messages.length, 5);
  assert.deepEqual(
    r.messages.map((m) => m.speaker),
    ["甲", "乙", "乙", "乙", "甲"],
  );
  assert.equal(r.messages[1].timestamp, "2026年09月19日 12:19");
  assert.deepEqual(r.warnings, []);
});
test("微信格式的正文冒号、引用、空行不拆成发言人", () => {
  const r = parseChat(
    "甲\n2026年09月19日 12:18\n计划：先吃饭\n\n> 乙：你说呢\n然后散步\n\n乙\n2026年09月19日 12:19\n好",
  );
  assert.equal(r.messages.length, 2);
  assert.match(r.messages[0].text, /计划：先吃饭\n\n> 乙：你说呢\n然后散步/);
});
test("手动格式支持多行、连续同人、emoji与附件", () => {
  const r = msg("我：hi\n第二行\n对方：😊\n对方：[图片]");
  assert.equal(r.length, 3);
  assert.equal(r[0].timestamp, null);
  assert.equal(r[2].kind, "unreadable");
});
test("未知角色不强行交替", () =>
  assert.ok(parseChat("没有说话人的一句话").warnings.length));
test("多人需校正", () =>
  assert.ok(parseChat("甲：a\n乙：b\n丙：c").warnings.length));
test("同记录重复导入保留ID且不追加", () => {
  const old = msg("我：a\n对方：b");
  const r = mergeMessages(old, msg("我：a\n对方：b"));
  assert.equal(r.added, 0);
  assert.equal(r.messages[0].id, old[0].id);
});
test("两条连续重叠只追加尾部", () => {
  const old = msg("我：a\n对方：b\n我：c");
  const r = mergeMessages(old, msg("对方：b\n我：c\n对方：d"));
  assert.equal(r.overlap, 2);
  assert.equal(r.added, 1);
  assert.equal(r.messages.length, 4);
});
test("重复嗯字不能全局吞掉", () => {
  const old = msg("我：a\n对方：嗯");
  const r = mergeMessages(old, msg("对方：嗯\n我：新的一句"));
  assert.equal(r.ambiguous, true);
  assert.equal(
    mergeMessages(old, msg("对方：嗯"), "append").messages.length,
    3,
  );
});
test("中间记录重叠需要确认", () => {
  assert.equal(
    mergeMessages(msg("我：a\n对方：b\n我：c"), msg("对方：b\n我：修改"))
      .ambiguous,
    true,
  );
});
test("评分边界完整，null不是0", () =>
  assert.deepEqual([null, 0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(grade), [
    "看不准",
    "刹车",
    "刹车",
    "有点尬",
    "有点尬",
    "一般",
    "一般",
    "稳",
    "稳",
    "妙",
    "妙",
  ]));
const sc = {
  type: "score",
  score: 3.8,
  confidence: 0.9,
  probabilities: { "3": 0.2, "4": 0.8 },
};
const ev = {
  type: "choice",
  choice: "sufficient",
  confidence: 0.9,
  probabilities: { sufficient: 1 },
};
test("低证据或低置信保留评分，状态独立且confidence不乘数值", () => {
  assert.equal(judgment(sc, ev).value, 95);
  assert.equal(judgment({ ...sc, confidence: 0.2 }, ev).status, "insufficient");
  assert.equal(judgment(sc, { ...ev, choice: "insufficient" }).value, 95);
  assert.equal(judgment({ ...sc, confidence: 0.2 }, ev).value, 95);
});
test("拒绝优先，等待不建议连续追问", () => {
  const action = {
    type: "choice",
    choice: "flirt",
    confidence: 0.9,
    probabilities: { flirt: 0.8, invite: 0.2 },
  };
  assert.equal(
    actionResult(
      action,
      { type: "noul", noul: 0.9 },
      { type: "noul", noul: 0.9 },
    ).action,
    "respect",
  );
  assert.equal(
    actionResult(
      action,
      { type: "noul", noul: 0.1 },
      { type: "noul", noul: 0.8 },
    ).action,
    "wait",
  );
});
test("分布显示总计100而不是99", () =>
  assert.equal(
    percentages({ a: 1, b: 1, c: 1 }).reduce((s, e) => s + e.value, 0),
    100,
  ));
test("我方请求物理移除未来消息", () => {
  const messages = msg("对方：你好\n我：周末散步吗\n对方：未来的秘密");
  const r = buildRequest({
    messages,
    relation: "crush",
    revision: 1,
    task: "self_message",
    targetIds: [messages[1].id],
  });
  assert.equal(r.state.messages.length, 2);
  assert.ok(!JSON.stringify(r).includes("未来的秘密"));
});
test("拒绝重复ID和错误目标角色", () => {
  const m = msg("我：hi");
  assert.equal(
    requestSchema.safeParse({
      messages: [m[0], m[0]],
      relation: "crush",
      revision: 1,
      task: "overview",
      targetIds: [],
    }).success,
    false,
  );
  assert.equal(
    requestSchema.safeParse({
      messages: m,
      relation: "crush",
      revision: 1,
      task: "other_messages",
      targetIds: [m[0].id],
    }).success,
    false,
  );
});
test("长度范围不会静默吞掉超长尾部", () => {
  const messages = msg("我：" + "长".repeat(24001));
  assert.equal(withinScope(messages), false);
  assert.equal(recentScope(messages).length, 0);
});

test("旧时间的新粘贴需要确认，不静默接到尾部", () => {
  const a = msg("甲\n2026年09月19日 12:20\n新的内容");
  const b = msg("乙\n2026年09月19日 12:19\n旧的内容");
  assert.equal(mergeMessages(a, b).ambiguous, true);
});
test("只有对方发言可显式标记我方不在记录里", () => {
  const parsed = parseChat("对方：嗯");
  const m = toMessages(parsed.messages, "__self_absent__");
  assert.equal(m[0].sender, "other");
});

test("情绪前三保留原概率，不重新凑成100%", async () => {
  const { topEmotions } = await import("../shared/labels");
  const top = topEmotions({
    happy: 0.4,
    confused: 0.25,
    calm: 0.2,
    angry: 0.1,
    unknown: 0.05,
  });
  assert.deepEqual(
    top.map((x) => x.key),
    ["happy", "confused", "calm"],
  );
  assert.deepEqual(
    top.map((x) => x.percent),
    ["40%", "25%", "20%"],
  );
  assert.ok(Math.abs(top.reduce((s, x) => s + x.probability, 0) - 0.85) < 1e-9);
});
test("对方并行请求情绪与意图，不请求逐句好感分", () => {
  const request = buildRequest({
    revision: 1,
    relation: "crush",
    task: "other_messages",
    targetIds: ["emotion"],
    messages: [
      {
        id: "emotion",
        sender: "other",
        text: "怎么回事？",
        timestamp: null,
        kind: "text",
      },
    ],
  });
  assert.deepEqual(Object.keys(request.questions), [
    "emotion_emotions",
    "emotion_intents",
  ]);
});
test("我方只请求表达质量和证据判断，且不看未来消息", () => {
  const request = buildRequest({
    revision: 1,
    relation: "crush",
    task: "self_message",
    targetIds: ["reply"],
    messages: [
      {
        id: "reply",
        sender: "self",
        text: "慢慢来，我等你。",
        timestamp: null,
        kind: "text",
      },
      {
        id: "future",
        sender: "other",
        text: "未来回复",
        timestamp: null,
        kind: "text",
      },
    ],
  });
  assert.ok(request.questions.reply_score);
  assert.ok(request.questions.reply_enough);
  assert.equal(request.questions.reply_reply, undefined);
  assert.equal(request.state.messages.length, 1);
});

test("零概率不凑数，不用愤怒0%等标签误导", async () => {
  const { topEmotions } = await import("../shared/labels");
  assert.deepEqual(
    topEmotions({ happy: 1, angry: 0, confused: 0 }).map((x) => x.label),
    ["开心"],
  );
});

test("回复评级覆盖七档分数边界，缺失或无效分数不评级", async () => {
  const { replyRating } = await import("../shared/ratings");
  for (const [score, label] of [
    [100, "SSS"],
    [95, "SSS"],
    [94, "SS"],
    [90, "SS"],
    [89, "S"],
    [80, "S"],
    [79, "A"],
    [70, "A"],
    [69, "B"],
    [60, "B"],
    [59, "C"],
    [40, "C"],
    [39, "D"],
    [0, "D"],
  ] as const) {
    assert.equal(replyRating(score)?.label, label);
  }
  for (const score of [null, undefined, NaN, -1, 101])
    assert.equal(replyRating(score), null);
});

test("意图候选覆盖日常与边界场景，前三项保留原始概率", async () => {
  const { INTENTS, topIntents } = await import("../shared/intents");
  for (const key of [
    "answer",
    "share",
    "ask",
    "boundary",
    "refuse",
    "other",
    "unknown",
  ])
    assert.ok(key in INTENTS);
  assert.ok(Object.values(INTENTS).every((v) => [...v.label].length === 4));
  const top = topIntents({
    answer: 0.45,
    share: 0.25,
    continue: 0.2,
    ask: 0.1,
    unknown: 0,
    invalid: 1,
    flirt: NaN,
  });
  assert.deepEqual(
    top.map((x) => [x.key, x.percent]),
    [
      ["answer", "45%"],
      ["share", "25%"],
      ["continue", "20%"],
    ],
  );
  assert.equal(topIntents({ unknown: 0.001 })[0].percent, "<1%");
  assert.deepEqual(topIntents(), []);
});
