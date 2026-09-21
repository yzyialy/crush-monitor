import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { emptyProfile, profileIdFor } from "../shared/profile";
import {
  applyFeedbackStats,
  commitConversationToProfile,
  confirmInProfile,
  correctInProfile,
  removeMemoryFromProfile,
  resetBaselineInProfile,
  sessionScope,
} from "../shared/profile-ops";
import {
  contextFromRelation,
  PROFILE_SCHEMA_VERSION,
  PROFILE_STORAGE_KEY,
  type DeepAnalysis,
  type LineResult,
  type Message,
  type Observation,
  type PersonProfile,
} from "../shared/types";
import {
  conversationPreview,
  conversationTitle,
  detectLegacyProfile,
  fingerprintSeed,
  lastConversationFor,
  lastMessageAtOf,
  loadChat,
  loadProfiles,
  localChat,
  LocalStorageError,
  migrateChatPayload,
  migrateProfilePayload,
  rememberConversation,
  saveProfiles,
  shortHash,
  sortConversations,
  validateProfile,
  writeStrict,
  type LocalMessage,
  type StorageLike,
  type StoredChat,
} from "../src/storage";
import {
  buildConversationId,
  readProfileOp,
  writeProfileOp,
} from "../src/local-ops";
import { scopeIdFor } from "../src/useWorkspace";
import { buildDeepRequest } from "../src/useDeepAnalysis";
import { deepRequestSchema } from "../server/deep-schema";
import { missingFrontendNotice, registerStatic } from "../server/static";

/**
 * 本机单机版（local-first）补测。
 *
 * 覆盖五件事：
 *   1. 浏览器本地存储的持久化往返（人 / 对话 / 消息）；
 *   2. 档案增量操作 —— 走本机版真正在用的那条编排路径；
 *   3. 旧 localStorage 数据的迁移；
 *   4. 消息去重指纹与顺序无关、与位置索引无关；
 *   5. 前端产物与源码里不得出现任何 API 密钥。
 *
 * 全部离线：不 import server/index.ts，不发任何请求，
 * 也不 import 任何会读 DEEPSEEK_API_KEY / TYPESAFE_API_KEY 的模块。
 */

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function fakeStorage(): { storage: StorageLike; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    },
  };
}

const AT = "2026-09-21T10:00:00.000Z";

function payload(
  rows: {
    sender: "self" | "other";
    content: string;
    sentAt?: string | null;
    mediaKind?: string | null;
  }[],
) {
  return rows.map((r) => ({
    sender: r.sender,
    content: r.content,
    sentAt: r.sentAt ?? "2026-09-21 10:00",
    mediaKind: r.mediaKind ?? null,
  }));
}

/**
 * 一次完整的本机导入，走的是 useWorkspace.ensureRemote 同一条路径：
 * 建人 → 建/复用对话 → 写消息（指纹去重）。
 */
function importBatch(
  storage: StorageLike,
  input: {
    personId: string;
    displayName?: string;
    conversationId: string;
    messages: ReturnType<typeof payload>;
    at?: string;
  },
) {
  const at = input.at ?? AT;
  localChat.ensurePerson(
    {
      id: input.personId,
      displayName: input.displayName ?? "小美",
      relationshipType: "crush",
      at,
    },
    storage,
  );
  return localChat.appendMessages(
    {
      personId: input.personId,
      conversationId: input.conversationId,
      messages: input.messages,
      at,
    },
    storage,
  );
}

function profileAt(id: string, displayName: string): PersonProfile {
  return emptyProfile({
    id,
    displayName,
    relationshipContext: contextFromRelation("crush"),
    at: Date.parse(AT),
  });
}

function msg(
  id: string,
  sender: "self" | "other",
  text: string,
  timestamp = "2026-09-21 10:00",
): Message {
  return { id, sender, text, timestamp, kind: "text" };
}

function obs(
  messageId: string,
  emotions: Record<string, number>,
  intents: Record<string, number>,
): Observation {
  return {
    messageId,
    emotions,
    intents,
    score: null,
    model: "jev-1.13.0",
    observedAt: AT,
  };
}

/** 一份结构完整、通过 deepAnalysisOutput 校验的第二层结果。 */
function deepAnalysis(): DeepAnalysis {
  return {
    status: "ok",
    model: "deepseek-flash",
    summary: "对方报备了自己的状态。",
    surfaceSignals: ["报备近况"],
    latentEmotion: {
      reading: "对方可能有点疲惫，也可能只是想被关心",
      basedOn: ["m1"],
      conflictsWith: [],
    },
    latentIntent: {
      reading: "对方可能想继续聊下去，而不是结束对话",
      basedOn: ["m3"],
      conflictsWith: [],
    },
    conversationState: {
      reading: "处在互相报备近况的阶段",
      surfaceSignals: ["有来有回"],
    },
    trend: "stable",
    turningPoint: null,
    alternativeInterpretations: [
      {
        interpretation: "对方确实想找人说话",
        supportingEvidence: ["m1"],
        contradictingEvidence: [],
      },
    ],
    evidence: [
      { messageId: "m1", quote: "我脚扭了", sender: "other", timestamp: null },
    ],
    contradiction: null,
    uncertainty: "medium",
    nextAction: {
      direction: "留意对方之后是否还会主动开启话题",
      principle: "单条消息不足以支撑长期判断",
    },
    analyzedMessageIds: ["m1", "m3"],
    promptVersion: 3,
    latencyMs: 1200,
  };
}

// ---------------------------------------------------------------------------
// 1. 持久化往返
// ---------------------------------------------------------------------------

test("本机 1. 档案写入 localStorage 后能原样读回并通过 validateProfile", () => {
  const { storage, map } = fakeStorage();
  const saved: PersonProfile = {
    ...profileAt("profile:xiaomei:crush", "小美"),
    memories: [
      {
        id: "mem:fact:1",
        kind: "fact",
        content: "她下周三要出差",
        sourceMessageIds: ["m1"],
        createdAt: AT,
        lastConfirmedAt: AT,
        status: "active",
        confidence: 0.6,
        sourceType: "observed",
      },
    ],
  };
  assert.ok(saveProfiles([saved], storage), "写入必须成功");

  // 真的落到 map 里了，而不是只在内存里
  assert.ok(map.has(PROFILE_STORAGE_KEY));
  const roundTrip = loadProfiles(storage);
  assert.equal(roundTrip.length, 1);
  assert.equal(roundTrip[0].id, saved.id);
  assert.equal(roundTrip[0].displayName, "小美");
  assert.equal(roundTrip[0].memories.length, 1);
  assert.equal(roundTrip[0].memories[0].content, "她下周三要出差");
  // 再校验一次：读回来的东西必须仍然是一份合法档案
  assert.ok(validateProfile(roundTrip[0]));
});

test("本机 2. 对话与消息写入后能原样读回，且顺序稳定", () => {
  const { storage } = fakeStorage();
  const personId = profileIdFor({ displayName: "小美", relation: "crush" });
  const report = importBatch(storage, {
    personId,
    conversationId: "conv-a",
    messages: payload([
      { sender: "other", content: "在干嘛" },
      { sender: "self", content: "刚下班" },
      { sender: "other", content: "哦" },
    ]),
  });
  assert.equal(report.addedCount, 3);
  assert.equal(report.skippedCount, 0);

  const conversation = localChat.conversation(personId, "conv-a", storage);
  assert.ok(conversation);
  assert.deepEqual(
    conversation.messages.map((m) => m.content),
    ["在干嘛", "刚下班", "哦"],
  );
  assert.deepEqual(
    conversation.messages.map((m) => m.sender),
    ["other", "self", "other"],
  );

  // 再读一次（模拟刷新页面）：内容与 id 都不变
  const again = localChat.conversation(personId, "conv-a", storage);
  assert.deepEqual(
    again?.messages.map((m) => m.id),
    conversation.messages.map((m) => m.id),
  );
});

test("本机 3. 「最近打开的对话」也被记住，刷新后能回到同一段", () => {
  const { storage } = fakeStorage();
  const personId = profileIdFor({ displayName: "小美", relation: "crush" });
  importBatch(storage, {
    personId,
    conversationId: "conv-a",
    messages: payload([{ sender: "other", content: "在干嘛" }]),
  });
  rememberConversation(personId, "conv-a", storage);
  assert.equal(lastConversationFor(personId, storage), "conv-a");
  assert.equal(lastConversationFor("profile:another:crush", storage), null);
});

test("本机 4. 损坏的本地数据一律安全忽略，绝不让应用打不开", () => {
  const { storage, map } = fakeStorage();
  map.set(PROFILE_STORAGE_KEY, "{ this is not JSON");
  assert.deepEqual(loadProfiles(storage), []);
  map.set("crush-monitor.chat.v1", "[]");
  assert.deepEqual(loadChat(storage), { version: 1, people: [] });
  // 结构合法但字段非法的条目也会被丢掉
  const broken = migrateChatPayload({
    version: 1,
    people: [
      {
        id: "p1",
        displayName: "小美",
        conversations: [{ id: "c1", messages: [{ sender: "self" }] }],
      },
    ],
  });
  assert.equal(broken.people.length, 1);
  assert.deepEqual(broken.people[0].conversations[0].messages, []);
});

test("本机 5. 会话标题由第一条消息推出，且不会无限长", () => {
  assert.equal(conversationTitle([{ content: "在干嘛" }]), "在干嘛");
  const long = conversationTitle([{ content: "一".repeat(40) }]);
  assert.ok(long && long.length <= 21);
  assert.equal(conversationTitle([{ content: "   " }]), null);
});

// ---------------------------------------------------------------------------
// 2. 去重指纹：与顺序、与位置索引无关
// ---------------------------------------------------------------------------

test("本机 6. 指纹只由 sender + 时间 + 内容决定（顺序无关）", () => {
  const a = fingerprintSeed({
    sender: "other",
    content: "在干嘛",
    sentAt: "2026-09-21 10:00",
  });
  const b = fingerprintSeed({
    sender: "other",
    content: "在干嘛",
    sentAt: "2026-09-21 10:00",
  });
  assert.equal(a, b);
  // 三个维度任一变化，指纹都必须变
  assert.notEqual(
    a,
    fingerprintSeed({
      sender: "self",
      content: "在干嘛",
      sentAt: "2026-09-21 10:00",
    }),
  );
  assert.notEqual(
    a,
    fingerprintSeed({ sender: "other", content: "在干嘛", sentAt: null }),
  );
  assert.notEqual(
    a,
    fingerprintSeed({
      sender: "other",
      content: "在干嘛呢",
      sentAt: "2026-09-21 10:00",
    }),
  );
});

test("本机 7. 同一批消息换一次顺序，得到的 id 完全一样（位置索引不进指纹）", () => {
  const personId = "profile:order:crush";
  const rows = payload([
    { sender: "other", content: "在干嘛" },
    { sender: "self", content: "刚下班" },
    { sender: "other", content: "哦" },
  ]);

  // 同一段对话、同一批内容，只是粘贴进来的顺序不同
  const a = importBatch(fakeStorage().storage, {
    personId,
    conversationId: "conv-1",
    messages: rows,
  });
  const b = importBatch(fakeStorage().storage, {
    personId,
    conversationId: "conv-1",
    messages: [rows[2], rows[0], rows[1]],
  });

  const idOf = (report: typeof a, content: string) =>
    report.added.find((m: LocalMessage) => m.content === content)?.id;
  assert.equal(idOf(a, "在干嘛"), idOf(b, "在干嘛"));
  assert.equal(idOf(a, "刚下班"), idOf(b, "刚下班"));
  assert.equal(idOf(a, "哦"), idOf(b, "哦"));
  // 三条的 id 互不相同（同一批里不会自己撞自己）
  assert.equal(new Set(a.added.map((m) => m.id)).size, 3);
});

test("本机 8. 重复导入同一批消息是幂等的（added 0 / skipped N）", () => {
  const { storage } = fakeStorage();
  const personId = "profile:idem:crush";
  const rows = payload([
    { sender: "other", content: "在干嘛" },
    { sender: "self", content: "刚下班" },
    { sender: "other", content: "哦" },
  ]);
  const first = importBatch(storage, {
    personId,
    conversationId: "conv-1",
    messages: rows,
  });
  assert.equal(first.addedCount, 3);
  assert.equal(first.skippedCount, 0);

  const again = localChat.appendMessages(
    { personId, conversationId: "conv-1", messages: rows, at: AT },
    storage,
  );
  assert.equal(again.addedCount, 0, "同样的消息必须被去重");
  assert.equal(again.skippedCount, 3);
  assert.equal(
    localChat.conversation(personId, "conv-1", storage)?.messages.length,
    3,
    "本地仍然只有 3 条",
  );
});

test("本机 9. 同一秒两条一模一样的话都要保留（出现次数进指纹）", () => {
  const { storage } = fakeStorage();
  const personId = "profile:dup:crush";
  const rows = payload([
    { sender: "other", content: "哈哈" },
    { sender: "other", content: "哈哈" },
  ]);
  const report = importBatch(storage, {
    personId,
    conversationId: "conv-1",
    messages: rows,
  });
  assert.equal(report.addedCount, 2, "同一秒两条相同内容不能被误判成重复");
  const ids = report.added.map((m) => m.id);
  assert.equal(new Set(ids).size, 2, "两条必须各有各的 id");

  // 再单独粘贴一条同样的内容：它仍是本次导入的第 1 次出现，
  // 指纹与第一批里的第一条一致，因此不会被重复入库（宁可少记，不可重复累计）
  const again = localChat.appendMessages(
    {
      personId,
      conversationId: "conv-1",
      messages: payload([{ sender: "other", content: "哈哈" }]),
      at: AT,
    },
    storage,
  );
  assert.equal(again.addedCount, 0, "同样的指纹不得再次入库");
  assert.equal(again.skippedCount, 1);
  assert.equal(
    localChat.conversation(personId, "conv-1", storage)?.messages.length,
    2,
  );

  // 时间不同就是另一条消息
  const later = localChat.appendMessages(
    {
      personId,
      conversationId: "conv-1",
      messages: payload([
        { sender: "other", content: "哈哈", sentAt: "2026-09-21 10:05" },
      ]),
      at: AT,
    },
    storage,
  );
  assert.equal(later.addedCount, 1, "换一个时间点就是新消息");
  assert.equal(
    localChat.conversation(personId, "conv-1", storage)?.messages.length,
    3,
  );
});

test("本机 10. 不同对话里的同一条消息互不串号", () => {
  const { storage } = fakeStorage();
  const personId = "profile:cross:crush";
  const rows = payload([{ sender: "other", content: "在干嘛" }]);
  const a = importBatch(storage, {
    personId,
    conversationId: "conv-a",
    messages: rows,
  });
  const b = importBatch(storage, {
    personId,
    conversationId: "conv-b",
    messages: rows,
  });
  assert.notEqual(a.added[0].id, b.added[0].id);
});

test("本机 11. 没有正文的消息不入库（媒体占位符不参与统计口径）", () => {
  const { storage } = fakeStorage();
  const personId = "profile:media:crush";
  // 「[语音]」没有补描述 → 上层已经过滤掉，这里再兜一层空白正文
  localChat.ensurePerson(
    { id: personId, displayName: "小美", relationshipType: "crush", at: AT },
    storage,
  );
  const report = localChat.appendMessages(
    {
      personId,
      conversationId: "conv-m",
      messages: [
        { sender: "other", content: "   ", sentAt: null },
        {
          sender: "other",
          content: "她说周末要加班",
          sentAt: "2026-09-21 10:00",
          mediaKind: "voice",
        },
      ],
      at: AT,
      title: null,
    },
    storage,
  );
  assert.equal(report.addedCount, 1);
  assert.equal(report.skippedCount, 1);
  // 用户手动转述的媒体消息仍然保留 mediaKind，上层据此标注「不是原始文字」
  assert.equal(report.added[0].mediaKind, "voice");
  assert.equal(report.added[0].content, "她说周末要加班");
});

test("本机 12. shortHash 是稳定的小哈希（同输入同输出）", () => {
  assert.equal(shortHash("abc"), shortHash("abc"));
  assert.notEqual(shortHash("abc"), shortHash("abd"));
  assert.ok(/^[0-9a-z]+$/.test(shortHash("任意中文")));
});

// ---------------------------------------------------------------------------
// 3. 档案增量操作（本机版真正在用的编排路径）
// ---------------------------------------------------------------------------

test("本机 13. commit 把会话并入基线 / 习惯 / 记忆，重复提交幂等", () => {
  const { storage } = fakeStorage();
  const personId = "profile:commit:crush";
  saveProfiles([profileAt(personId, "小美")], storage);

  const messages = [
    msg("m1", "other", "我脚扭了，走路一瘸一拐", "2026-09-21 10:00"),
    msg("m2", "self", "疼不疼，要不要去医院", "2026-09-21 10:01"),
    msg("m3", "other", "周末考试，得好好复习", "2026-09-21 10:02"),
  ];
  const observations = [
    obs("m1", { neutral: 0.6, warm: 0.4 }, { greeting: 0.7 }),
    obs("m3", { warm: 0.8 }, { sharing: 0.6 }),
  ];
  const commit = (current: PersonProfile, at: number, conversationId: string) =>
    commitConversationToProfile(current, {
      conversationId,
      messages,
      observations,
      now: AT,
      at,
    });

  const once = writeProfileOp(storage, personId, Date.parse(AT), (current) =>
    commit(current, Date.parse(AT), "conv-1"),
  );
  assert.ok(once);
  assert.equal(once.behaviorBaseline.conversationCount, 1);
  assert.deepEqual(once.sourceConversationIds, ["conv-1"]);
  assert.ok(once.memories.length > 0, "应当从对话里归纳出客观事实");
  assert.ok(
    once.memories.some((m) => m.content.includes("脚扭了")),
    "客观事实必须进长期记忆",
  );
  assert.ok(
    once.memories.every((m) => m.sourceType === "observed"),
    "从对话里归纳出来的一律是 observed，不是模型推断",
  );
  // 写回了浏览器存储，而不只是内存里
  assert.equal(loadProfiles(storage)[0].behaviorBaseline.conversationCount, 1);

  const twice = writeProfileOp(storage, personId, Date.parse(AT) + 1000, (current) =>
    commit(current, Date.parse(AT) + 1000, "conv-1"),
  );
  assert.equal(
    JSON.stringify({ ...twice, updatedAt: 0 }),
    JSON.stringify({ ...once, updatedAt: 0 }),
    "同一段对话重复提交必须完全幂等（只看内容，不看 updatedAt）",
  );
  assert.equal(
    twice?.behaviorBaseline.conversationCount,
    1,
    "重复提交不得把基线样本刷高",
  );

  // 另一段对话才会再加一个样本
  const third = writeProfileOp(storage, personId, Date.parse(AT) + 2000, (current) =>
    commit(current, Date.parse(AT) + 2000, "conv-2"),
  );
  assert.equal(third?.behaviorBaseline.conversationCount, 2);
});

test("本机 14. model_inferred 永远不会自动升级成 user_confirmed", () => {
  const { storage } = fakeStorage();
  const personId = "profile:upgrade:crush";
  saveProfiles([profileAt(personId, "小美")], storage);

  const messages = [
    msg("m1", "other", "我脚扭了，走路一瘸一拐", "2026-09-21 10:00"),
    msg("m2", "self", "疼不疼", "2026-09-21 10:01"),
    msg("m3", "other", "周末考试，得好好复习", "2026-09-21 10:02"),
  ];
  const observations = [obs("m1", { neutral: 0.7 }, { greeting: 0.6 })];
  const analysis = deepAnalysis();

  const committed = writeProfileOp(storage, personId, Date.parse(AT), (current) =>
    commitConversationToProfile(current, {
      conversationId: "conv-1",
      messages,
      observations,
      analysis,
      now: AT,
      at: Date.parse(AT),
    }),
  );
  assert.ok(committed);
  assert.ok(
    committed.inferenceCandidates.length > 0,
    "模型解读只累积候选",
  );
  assert.ok(
    committed.memories.every((m) => m.sourceType === "observed"),
    "模型解读不得直接产生长期记忆",
  );

  const candidate = committed.inferenceCandidates[0];
  // 确认用的 key 就是候选对象的 id（界面上的勾选项 key 也是这个）
  const candidateKey = candidate.id;

  // 手工放一条 model_inferred 记忆，模拟上一轮解读留下的推断
  const inferred = {
    id: `mem:pattern:${candidateKey}`,
    kind: "pattern" as const,
    content: candidate.content,
    sourceMessageIds: ["m1"],
    createdAt: AT,
    lastConfirmedAt: AT,
    status: "active" as const,
    confidence: 0.4,
    sourceType: "model_inferred" as const,
  };
  writeProfileOp(storage, personId, Date.parse(AT) + 1, (current) => ({
    ...current,
    memories: [...current.memories, inferred],
  }));

  // 只做"整体判对了"，不逐项勾选 → 推断不能升级
  const loose = writeProfileOp(storage, personId, Date.parse(AT) + 2, (current) =>
    confirmInProfile(current, {
      contextKey: "ctx-1",
      verdict: "mostly_correct",
      confirmedParts: ["emotion", "intent"],
      analysis,
      now: AT,
      at: Date.parse(AT) + 2,
    }),
  );
  assert.equal(
    loose?.memories.find((m) => m.id === inferred.id)?.sourceType,
    "model_inferred",
    "没被逐项确认的推断不能升级",
  );
  assert.equal(
    loose?.knownPatterns.filter((p) => p.sourceType === "user_confirmed")
      .length,
    0,
    "整体确认不得凭空造出用户确认的模式",
  );

  // 逐项确认那条推断 → 这时才允许升级
  const accepted = writeProfileOp(storage, personId, Date.parse(AT) + 3, (current) =>
    confirmInProfile(current, {
      contextKey: "ctx-1",
      verdict: "mostly_correct",
      confirmedParts: [`memory:${candidateKey}`],
      analysis,
      now: AT,
      at: Date.parse(AT) + 3,
    }),
  );
  assert.equal(
    accepted?.memories.find((m) => m.id === inferred.id)?.sourceType,
    "user_confirmed",
    "逐项确认后推断才升级",
  );
  assert.ok(
    accepted?.knownPatterns.some(
      (p) =>
        p.sourceType === "user_confirmed" && p.description.includes("用户确认："),
    ),
    "用户确认过的推断可以成为长期模式，并带 user_confirmed 来源",
  );
  assert.equal(accepted?.confirmations.length, 1, "同一次解读只保留最新一次确认");

  // 重复确认同一个 contextKey 不会堆出第二条
  const again = writeProfileOp(storage, personId, Date.parse(AT) + 4, (current) =>
    confirmInProfile(current, {
      contextKey: "ctx-1",
      verdict: "mostly_correct",
      confirmedParts: [`memory:${candidateKey}`],
      analysis,
      now: AT,
      at: Date.parse(AT) + 4,
    }),
  );
  assert.equal(again?.confirmations.length, 1);
});

test("本机 15. 用户纠错只标状态、不删除模型推断，也不降级已确认内容", () => {
  const { storage } = fakeStorage();
  const personId = "profile:correct:crush";
  const inferred = {
    id: "mem:pattern:cand-2",
    kind: "pattern" as const,
    content: "她对周末邀约不感兴趣",
    sourceMessageIds: ["m1"],
    createdAt: AT,
    lastConfirmedAt: AT,
    status: "active" as const,
    confidence: 0.5,
    sourceType: "model_inferred" as const,
  };
  const confirmedMemory = {
    id: "mem:confirmed:ctx-9:emotion",
    kind: "event" as const,
    content: "用户确认：她那天只是发烧",
    sourceMessageIds: ["m2"],
    createdAt: AT,
    lastConfirmedAt: AT,
    status: "active" as const,
    confidence: 1,
    sourceType: "user_confirmed" as const,
  };
  saveProfiles(
    [{ ...profileAt(personId, "小美"), memories: [inferred, confirmedMemory] }],
    storage,
  );

  const next = writeProfileOp(storage, personId, Date.parse(AT) + 1, (current) =>
    correctInProfile(current, {
      contextKey: "ctx-9",
      content: "  不是，她那天只是发烧  ",
      contradictedIds: ["mem:pattern:cand-2"],
      now: AT,
      at: Date.parse(AT) + 1,
    }),
  );
  assert.equal(next?.corrections.length, 1);
  assert.equal(next?.corrections[0].content, "不是，她那天只是发烧");
  assert.ok(next?.memories.some((m) => m.id === inferred.id), "推断不会被删除");
  assert.equal(
    next?.memories.find((m) => m.id === confirmedMemory.id)?.sourceType,
    "user_confirmed",
    "已确认的内容不能被纠错降级",
  );

  // 空内容不产生任何纠错记录
  const noop = writeProfileOp(storage, personId, Date.parse(AT) + 2, (current) =>
    correctInProfile(current, {
      contextKey: null,
      content: "   ",
      contradictedIds: [],
      now: AT,
      at: Date.parse(AT) + 2,
    }),
  );
  assert.equal(noop?.corrections.length, 1, "空内容不得新增纠错");
});

test("本机 16. 删除单条记忆 / 清空基线 / 重算反馈统计", () => {
  const personId = "profile:ops:crush";
  let profile = profileAt(personId, "小美");
  profile = {
    ...profile,
    memories: [
      {
        id: "mem:a",
        kind: "fact",
        content: "她喜欢猫",
        sourceMessageIds: ["m1"],
        createdAt: AT,
        lastConfirmedAt: AT,
        status: "active",
        confidence: 0.5,
        sourceType: "observed",
      },
      {
        id: "mem:b",
        kind: "fact",
        content: "她讨厌猫",
        sourceMessageIds: ["m2"],
        createdAt: AT,
        lastConfirmedAt: AT,
        status: "active",
        confidence: 0.5,
        sourceType: "model_inferred",
      },
    ],
    knownPatterns: [
      {
        id: "kp:deterministic:1",
        patternKey: "reply_latency:fast",
        description: "回复一向很快",
        evidenceCount: 4,
        conversationCount: 4,
        sourceType: "deterministic",
        supportingMetrics: [],
        firstObservedAt: Date.parse(AT),
        lastObservedAt: Date.parse(AT),
        status: "active",
      },
      {
        id: "kp:user:1",
        patternKey: "user:1",
        description: "用户确认：她周末通常有空",
        evidenceCount: 1,
        conversationCount: 1,
        sourceType: "user_confirmed",
        supportingMetrics: [],
        firstObservedAt: Date.parse(AT),
        lastObservedAt: Date.parse(AT),
        status: "active",
      },
    ],
    behaviorBaseline: {
      sampleCount: 12,
      conversationCount: 4,
      firstObservedAt: Date.parse(AT) - 1000,
      lastObservedAt: Date.parse(AT),
      metrics: {},
    },
    sourceConversationIds: ["conv-1", "conv-2", "conv-3", "conv-4"],
  };

  const removed = removeMemoryFromProfile(profile, "mem:a", Date.parse(AT) + 1);
  assert.deepEqual(
    removed.memories.map((m) => m.id),
    ["mem:b"],
  );

  const reset = resetBaselineInProfile(profile, Date.parse(AT) + 2);
  assert.equal(reset.behaviorBaseline.conversationCount, 0);
  assert.equal(reset.behaviorBaseline.sampleCount, 0);
  assert.deepEqual(reset.sourceConversationIds, []);
  assert.equal(reset.memories.length, 2, "清基线不动记忆");
  // 程序统计出来的模式被标记过期；用户确认过的保留
  assert.equal(
    reset.knownPatterns.find((p) => p.id === "kp:deterministic:1")?.status,
    "expired",
  );
  assert.equal(
    reset.knownPatterns.find((p) => p.id === "kp:user:1")?.status,
    "active",
  );

  const withStats = applyFeedbackStats(
    { ...profile, confirmations: [], corrections: [] },
    [
      {
        id: "f1",
        contextKey: "ctx-1",
        verdict: "problem",
        reasons: ["wrong_reading"],
        note: "",
        createdAt: AT,
      },
    ],
  );
  assert.ok(withStats.feedbackStats, "反馈统计必须被重算出来");
  assert.ok(
    Object.values(withStats.feedbackStats).every(
      (v) => typeof v === "number" && Number.isFinite(v),
    ),
  );
});

test("本机 17. sessionScope 只取最近一轮对话（与 useProfile 口径一致）", () => {
  const messages = [
    msg("a", "other", "早上好", "2026-09-21 08:00"),
    msg("b", "self", "早", "2026-09-21 08:01"),
    // 超过 30 分钟 = 新的一轮
    msg("c", "other", "在干嘛", "2026-09-21 10:00"),
    msg("d", "self", "刚下班", "2026-09-21 10:01"),
  ];
  const scope = sessionScope(messages);
  assert.deepEqual(
    scope.map((m) => m.id),
    ["c", "d"],
  );
});

// ---------------------------------------------------------------------------
// 4. 旧 localStorage 数据迁移
// ---------------------------------------------------------------------------

test("本机 18. 旧版（schema v1）档案能迁移，统计数字一律重算", () => {
  const legacy = {
    version: 1,
    profiles: [
      {
        id: "profile:legacy:crush",
        displayName: "旧数据",
        relationshipContext: contextFromRelation("crush"),
        createdAt: 1,
        updatedAt: 2,
        baselineVersion: 1,
        behaviorBaseline: {
          sampleCount: 3,
          conversationCount: 1,
          firstObservedAt: 1,
          lastObservedAt: 2,
          metrics: {},
        },
        memories: [
          {
            id: "mem:1",
            kind: "fact",
            content: "她养了一只猫",
            // observed 记忆必须能指回原始消息，否则会被安全丢弃
            sourceMessageIds: ["m-legacy-1"],
            createdAt: AT,
            lastConfirmedAt: AT,
            status: "active",
            confidence: 0.7,
            sourceType: "observed",
          },
        ],
        knownPatterns: [
          {
            id: "kp:legacy",
            description: "回复一向很快",
            evidenceCount: 4,
            conversationCount: 4,
            // v1 用的是记忆来源等级：observed 要映射成 deterministic
            sourceType: "observed",
            supportingMetrics: [],
            firstObservedAt: 1,
            lastObservedAt: 2,
            status: "active",
          },
        ],
        habits: [],
        activityEvents: [],
        inferenceCandidates: [],
        // 手改出来的统计数字必须被丢掉，由 confirmations 重算
        feedbackStats: { total: 999, confirmed: 999 },
        confirmations: [],
        corrections: [],
        sourceConversationIds: ["conv-legacy"],
      },
    ],
  };
  const migrated = migrateProfilePayload(legacy);
  assert.equal(migrated.version, PROFILE_SCHEMA_VERSION);
  assert.equal(migrated.profiles.length, 1);
  const profile = migrated.profiles[0];
  assert.equal(profile.displayName, "旧数据");
  assert.equal(profile.memories.length, 1);
  assert.equal(profile.memories[0].content, "她养了一只猫");
  assert.equal(profile.knownPatterns.length, 1);
  assert.equal(
    profile.knownPatterns[0].sourceType,
    "deterministic",
    "v1 的 observed 必须映射成 deterministic",
  );
  assert.equal(
    profile.knownPatterns[0].patternKey,
    "legacy",
    "v1 没有 patternKey 时用 id 兜底",
  );
  assert.notEqual(
    (profile.feedbackStats as unknown as { total?: number }).total,
    999,
    "手改出来的统计数字不得进入系统",
  );
});

test("本机 19. 早期无版本号的档案数组也能读，来自更高版本的存储被安全忽略", () => {
  const bare = [
    {
      id: "profile:bare:crush",
      relationshipContext: contextFromRelation("crush"),
      createdAt: 0,
      updatedAt: 0,
      baselineVersion: 1,
    },
  ];
  assert.equal(migrateProfilePayload(bare).profiles.length, 1);
  assert.equal(
    migrateProfilePayload({ profiles: bare }).profiles.length,
    1,
    "缺 version 也要能读",
  );
  assert.deepEqual(
    migrateProfilePayload({
      version: PROFILE_SCHEMA_VERSION + 1,
      profiles: bare,
    }).profiles,
    [],
    "更高版本的数据不能乱动",
  );
  assert.deepEqual(migrateProfilePayload(null).profiles, []);
  assert.deepEqual(migrateProfilePayload("nonsense").profiles, []);
});

test("本机 20. legacy 检测只做只读判断：没数据就不打扰", () => {
  const { storage, map } = fakeStorage();
  assert.equal(detectLegacyProfile(storage), null, "空存储不报 legacy");

  // 有档案时给出摘要，并且**不改动**任何存储
  saveProfiles([profileAt("profile:legacy:crush", "旧数据")], storage);
  const before = new Map(map);
  const detected = detectLegacyProfile(storage);
  assert.ok(detected);
  assert.equal(detected.summary.profiles, 1);
  assert.deepEqual(
    [...map.entries()],
    [...before.entries()],
    "检测不得写任何 key",
  );
});

test("本机 21. 工作区数据损坏时不会污染档案存储", () => {
  const { storage, map } = fakeStorage();
  map.set(
    "crush-monitor.chat.v1",
    JSON.stringify({ version: 1, people: "nope" }),
  );
  const chat: StoredChat = loadChat(storage);
  assert.deepEqual(chat.people, []);
  // 档案存储仍然是独立的一条 key，互不影响
  assert.equal(map.has(PROFILE_STORAGE_KEY), false);
});

test("本机 22. 对话 id 与档案 id 的推导是稳定且相互独立的", () => {
  const identity = {
    personId: "profile:xiaomei:crush",
    relation: "crush" as const,
    selfName: "我",
    otherName: "小美",
  };
  const first = buildConversationId(identity);
  assert.equal(first, buildConversationId(identity), "同样的身份得到同一个对话 id");
  assert.ok(first.startsWith("conv:"));
  // 换一个人 / 换一段关系就是另一段对话
  assert.notEqual(
    first,
    buildConversationId({ ...identity, personId: "profile:another:crush" }),
  );
  assert.notEqual(first, buildConversationId({ ...identity, relation: "couple" }));
  // 档案 id 只由称呼与关系决定
  assert.equal(
    scopeIdFor("小美", "crush"),
    profileIdFor({ displayName: "小美", relation: "crush" }),
  );
});

// ---------------------------------------------------------------------------
// 5. 前端产物里不得出现密钥
// ---------------------------------------------------------------------------

test("本机 23. 前端源码与构建产物里不得出现任何 API 密钥", () => {
  // 具体到真实的密钥形态：
  //   - 环境变量名（一旦被打进前端，说明有服务端代码漏进了 bundle）
  //   - sk- / apikey_ 后面跟着足够长的密钥体（"sk-" 单独出现会误伤 SVG 的
  //     mask-type、highRisk 这类标识符，所以必须连长度一起判）
  const needles = [
    "DEEPSEEK_API_KEY",
    "TYPESAFE_API_KEY",
    "process.env.DEEPSEEK",
    "process.env.TYPESAFE",
  ];
  const patterns = [/\bsk-[A-Za-z0-9_-]{16,}/, /\bapikey_[A-Za-z0-9_-]{8,}/];

  const check = (label: string, content: string) => {
    for (const n of needles)
      assert.equal(content.includes(n), false, `${label} 里出现了 ${n}`);
    for (const p of patterns)
      assert.equal(p.test(content), false, `${label} 里出现了匹配 ${p} 的密钥`);
  };

  const srcDir = join(process.cwd(), "src");
  const srcFiles = readdirSync(srcDir).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
  );
  assert.ok(srcFiles.length > 0, "src 里应该有源码");
  for (const file of srcFiles)
    check(`src/${file}`, readFileSync(join(srcDir, file), "utf8"));

  const dist = join(process.cwd(), "dist", "assets");
  if (!existsSync(dist)) return; // 还没构建过就跳过（npm run build 之后会真正检查）
  const assets = readdirSync(dist).filter((f) => f.endsWith(".js"));
  assert.ok(assets.length > 0, "dist/assets 里应该有 JS 产物");
  for (const file of assets) {
    const content = readFileSync(join(dist, file), "utf8");
    check(`dist/assets/${file}`, content);
    // 额外一条：模型域名也不应该进前端。
    // 目前 bundle 里确实没有（DEEP_ANALYSIS_DEFAULT_BASE_URL 被 tree-shaking 掉了），
    // 但如果以后有 src/ 下的文件 import 它，这条会立刻失败 —— 那是提醒，不是误报。
    for (const domain of ["api.deepseek.com", "typesafe.ai"])
      assert.equal(
        content.includes(domain),
        false,
        `dist/assets/${file} 里出现了模型域名 ${domain}`,
      );
  }
});

test("本机 24. 服务端入口不再挂载任何账号 / 持久化路由", () => {
  const entry = readFileSync(join(process.cwd(), "server", "index.ts"), "utf8");
  for (const gone of [
    "requireAuth",
    "requireSameOrigin",
    "createApiRouter",
    "createAuthMiddleware",
    "getDb",
    "recordAnalysisRun",
    "startupMaintenance",
    "node:sqlite",
  ])
    assert.equal(entry.includes(gone), false, `server/index.ts 里仍然出现 ${gone}`);
  // 该保留的还必须在
  for (const kept of ["/api/health", "/api/analyze", "/api/deep-analysis"])
    assert.ok(entry.includes(kept), `server/index.ts 缺少 ${kept}`);
  // 健康检查不得再报告 auth 相关字段
  assert.equal(entry.includes('auth: "session"'), false);
});

test("本机 25. 本机版已经没有任何账号 / 数据库模块", () => {
  const gone = [
    "server/db.ts",
    "server/auth.ts",
    "server/routes.ts",
    "src/api.ts",
    "src/useAuth.ts",
    "src/LoginPage.tsx",
    "src/login.css",
    "tests/server.test.ts",
    "scripts/user-cli.ts",
    "scripts/db-cli.ts",
  ];
  for (const file of gone)
    assert.equal(
      existsSync(join(process.cwd(), file)),
      false,
      `${file} 不应该存在于本机版`,
    );
});

// ---------------------------------------------------------------------------
// 6. 第二层请求契约（本机版：消息与跨会话上下文都由前端带上来）
// ---------------------------------------------------------------------------

const sampleMessages: Message[] = [
  msg("m1", "other", "今天好累", "2026年09月19日 22:00"),
  msg("m2", "self", "辛苦了", "2026年09月19日 22:05"),
  msg("m3", "other", "你怎么还没睡", "2026年09月19日 22:06"),
];

test("本机 26. 第二层请求永远自带消息与检索上下文，不依赖服务端读库", () => {
  const built = buildDeepRequest(
    {
      messages: sampleMessages,
      relation: "crush",
      targetId: null,
      lines: {},
      observationModel: "jev-1.13.0",
      conversationId: "conv:abcd",
    },
    AT,
  );
  // 关键回归点：本机版服务端**没有**聊天记录，
  // 所以哪怕有 conversationId，messages 也必须真的带上去。
  assert.equal(built.request.messages.length, sampleMessages.length);
  assert.equal(built.request.conversationId, "conv:abcd");
  // 没有档案时 profileContext 为空，绝不伪造一份
  assert.equal(built.profileContext, null);
  assert.equal(built.request.profile, undefined);

  // 有档案时必须把检索结果一起带上（服务端只读不存）
  const withProfile = buildDeepRequest(
    {
      messages: sampleMessages,
      relation: "crush",
      targetId: null,
      lines: {},
      observationModel: "jev-1.13.0",
      conversationId: "conv:abcd",
      profile: {
        ...profileAt("profile:deep:crush", "小美"),
        behaviorBaseline: {
          sampleCount: 8,
          conversationCount: 3,
          firstObservedAt: Date.parse(AT) - 100000,
          lastObservedAt: Date.parse(AT),
          metrics: {},
        },
      },
    },
    AT,
  );
  assert.ok(withProfile.profileContext, "有档案时必须产出检索上下文");
  assert.ok(withProfile.request.profile, "检索上下文必须随请求带走");
  assert.equal(withProfile.request.messages.length, sampleMessages.length);
});

test("本机 27. 深层分析请求校验：「必须有输入」由对象级校验判断，不是字段级 min(1)", () => {
  const base = {
    relation: "crush" as const,
    targetId: null,
    messages: [
      {
        id: "m1",
        sender: "other" as const,
        text: "今天好累",
        timestamp: null,
        kind: "text" as const,
      },
    ],
  };
  // 有消息：通过
  assert.equal(deepRequestSchema.safeParse(base).success, true);
  // 空数组 / 缺字段：被对象级 refine 拒掉（而不是字段级 min(1) 直接 400 掉合法请求）
  assert.equal(
    deepRequestSchema.safeParse({ ...base, messages: [] }).success,
    false,
  );
  const missing = { ...base } as Record<string, unknown>;
  delete missing.messages;
  assert.equal(deepRequestSchema.safeParse(missing).success, false);
  // 关系与目标消息的其它约束仍然生效
  assert.equal(
    deepRequestSchema.safeParse({ ...base, relation: "friend" }).success,
    false,
  );
  assert.equal(deepRequestSchema.safeParse({ ...base, messages: [] }).success, false);
});

// ---------------------------------------------------------------------------
// 7. dist 缺失时的兜底（新用户先 npm start、忘了 npm run build）
// ---------------------------------------------------------------------------

test("本机 28. dist 缺失时不 404：浏览器里看到「先运行 npm run build」的提示页", async () => {
  const app = express();
  // 先挂兜底、后挂 API 路由：这样能真正验证「非 /api/ 才拦」这条规则
  const built = registerStatic(app, {
    // 注入 exists 假装没有构建产物：不依赖真实文件系统状态
    dir: join(tmpdir(), "crush-monitor-no-such-dist"),
    exists: () => false,
  });
  assert.equal(built, false, "没有 dist/index.html 时必须报告「没构建」");
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, mode: "local" });
  });

  // 启动日志里的那句提示也要能拿到，且必须写出下一步命令
  const notice = missingFrontendNotice(join(tmpdir(), "crush-monitor-no-such-dist"));
  assert.ok(notice.includes("npm run build"), "启动日志必须写出下一步命令");

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.notEqual(page.status, 404, "缺 dist 时不能只给 404");
    const html = await page.text();
    assert.ok(
      html.includes("npm run build"),
      "提示页必须能在浏览器里直接看到「先运行 npm run build」",
    );
    // 接口不受影响：兜底只拦非 /api/ 路径
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, mode: "local" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// 8. 历史对话：排序 / 条数 / 摘要 / 改名 / 新建空对话（本机版真机链路的数据层）
// ---------------------------------------------------------------------------

/** 造两段不同时间的对话（后一段更晚）。 */
function twoConversations() {
  const { storage } = fakeStorage();
  const personId = "profile:history:crush";
  const early = "2026-09-20T10:00:00.000Z";
  const late = "2026-09-21T10:00:00.000Z";
  importBatch(storage, {
    personId,
    conversationId: "conv-old",
    at: early,
    messages: payload([
      { sender: "other", content: "在干嘛", sentAt: "2026年09月20日 17:19" },
      { sender: "self", content: "刚下班", sentAt: "2026年09月20日 17:28" },
    ]),
  });
  importBatch(storage, {
    personId,
    conversationId: "conv-new",
    at: late,
    messages: payload([
      { sender: "other", content: "在干嘛", sentAt: "2026年09月21日 17:19" },
    ]),
  });
  return { storage, personId };
}

test("本机 29. 历史对话列表按最近更新倒序，并带条数 / 第一句 / 最近一条时间", () => {
  const { storage, personId } = twoConversations();
  const list = sortConversations(localChat.conversations(personId, storage));
  assert.deepEqual(
    list.map((c) => c.id),
    ["conv-new", "conv-old"],
    "最近更新的那段必须排最前",
  );
  const old = list[1];
  // 这两段的「第一句」完全一样 —— 光靠摘要分不出它们，所以还必须有时间与序号
  assert.equal(conversationPreview(old.messages), "在干嘛");
  assert.equal(old.messages.length, 2);
  assert.equal(lastMessageAtOf(old.messages), "2026年09月20日 17:28");
  // 时间不同才能区分（微信格式 new Date() 解析不了，必须显式解析中文格式）
  assert.notEqual(
    lastMessageAtOf(old.messages),
    lastMessageAtOf(list[0].messages),
  );
});

test("本机 30. 改名生效 / 留空恢复自动命名 / 改名不改变排序", () => {
  const { storage, personId } = twoConversations();
  const before = sortConversations(localChat.conversations(personId, storage));
  const target = before.find((c) => c.id === "conv-old")!;
  assert.equal(target.title, null, "导入时不写 title（默认名字由界面现场算）");

  localChat.renameConversation(personId, "conv-old", "第一次聊天", storage);
  const renamed = localChat.conversation(personId, "conv-old", storage)!;
  assert.equal(renamed.title, "第一次聊天");
  assert.equal(
    renamed.updatedAt,
    target.updatedAt,
    "改名绝对不能动 updatedAt，否则这段会被顶到列表最前面",
  );

  const after = sortConversations(localChat.conversations(personId, storage));
  assert.deepEqual(
    after.map((c) => c.id),
    before.map((c) => c.id),
    "改名后顺序必须一模一样",
  );

  localChat.renameConversation(personId, "conv-old", "   ", storage);
  assert.equal(
    localChat.conversation(personId, "conv-old", storage)!.title,
    null,
    "留空（或全空格）= 恢复自动命名",
  );
});

test("本机 31. 开始新对话不删历史：空对话被复用、新导入写进新段、旧段仍完整可读", () => {
  const { storage, personId } = twoConversations();
  const at = "2026-09-22T10:00:00.000Z";

  // 「开始新对话」= 找一段已有的空对话，没有就新建（这里没有 → 新建）
  assert.equal(localChat.emptyConversation(personId, storage), null);
  const created = localChat.createConversation({ personId, at }, storage)!;
  assert.equal(created.messages.length, 0);
  assert.ok(created.updatedAt >= "2026-09-21", "新对话按 updatedAt 排最前");
  rememberConversation(personId, created.id, storage);
  assert.equal(
    lastConversationFor(personId, storage),
    created.id,
    "刷新页面后必须停在这段新的空对话上",
  );

  // 再点一次：复用同一段空对话，不会堆出一堆空记录
  const again = localChat.emptyConversation(personId, storage)!;
  assert.equal(again.id, created.id);

  // 下一次导入写进新对话
  const report = localChat.appendMessages(
    {
      personId,
      conversationId: created.id,
      at: "2026-09-22T10:05:00.000Z",
      messages: payload([
        { sender: "other", content: "在干嘛", sentAt: "2026年09月22日 09:00" },
      ]),
    },
    storage,
  );
  assert.equal(report.addedCount, 1);
  assert.equal(report.conversationId, created.id);

  // 旧对话一条都没少，而且内容一模一样
  const old = localChat.conversation(personId, "conv-old", storage)!;
  assert.equal(old.messages.length, 2);
  assert.deepEqual(
    old.messages.map((m) => m.content),
    ["在干嘛", "刚下班"],
  );
  const newOne = localChat.conversation(personId, "conv-new", storage)!;
  assert.equal(newOne.messages.length, 1, "另一段旧对话也不受影响");
  // 三段的顺序：最新写入的那段在最前
  assert.equal(
    sortConversations(localChat.conversations(personId, storage))[0].id,
    created.id,
  );
});

test("本机 32. 旧版本自动写进 title 的「第一句」会被迁移成自动命名，用户改的名字保留", () => {
  const { storage } = fakeStorage();
  const personId = "profile:title:crush";
  const messages = [
    {
      id: "m:1",
      sender: "other" as const,
      content: "在干嘛",
      sentAt: "2026年09月20日 17:19",
      mediaKind: null,
    },
  ];
  const raw = {
    version: 1,
    people: [
      {
        id: personId,
        displayName: "小美",
        relationshipType: "crush",
        createdAt: AT,
        updatedAt: AT,
        conversations: [
          {
            id: "conv-a",
            // 旧版本导入时会自动把第一句写进 title
            title: conversationTitle(messages),
            createdAt: AT,
            updatedAt: AT,
            messages,
          },
          {
            id: "conv-b",
            title: "我自己起的名字",
            createdAt: AT,
            updatedAt: AT,
            messages,
          },
        ],
      },
    ],
  };
  storage.setItem("crush-monitor.chat.v1", JSON.stringify(raw));
  const loaded = loadChat(storage);
  assert.equal(
    loaded.people[0].conversations[0].title,
    null,
    "自动写入的标题必须被认成「没改过名」，否则列表里每段都只剩一句摘要",
  );
  assert.equal(
    loaded.people[0].conversations[1].title,
    "我自己起的名字",
    "用户自己起的名字必须原样保留",
  );
});

// ---------------------------------------------------------------------------
// 9. 保存失败不再静默
// ---------------------------------------------------------------------------

/** 读得到、写不进去的存储（模拟 localStorage 配额满）。 */
function quotaStorage(map: Map<string, string>): StorageLike {
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: () => {
      const err = new Error("QuotaExceededError: exceeded the quota");
      throw err;
    },
    removeItem: (k) => void map.delete(k),
  };
}

test("本机 33. 写不进本机存储时抛出带原因的 Error（不再静默吞掉）", () => {
  const { storage, map } = fakeStorage();
  const full = quotaStorage(map);

  // 1) 底层：写入失败必须带「为什么」与「怎么办」
  assert.throws(
    () => writeStrict("k", { a: 1 }, "本机聊天记录", full),
    (err: unknown) => {
      assert.ok(err instanceof LocalStorageError);
      assert.match(err.message, /5MB/);
      assert.match(err.message, /删掉不用的聊天记录/);
      return true;
    },
  );

  // 2) 浏览器完全不给用时（无痕 / 禁用了网站数据）也要说清楚
  assert.throws(
    () => writeStrict("k", { a: 1 }, "本机聊天记录", undefined),
    /无痕|禁用/,
  );

  // 3) 聊天导入路径：写不进去就不能假装成功
  assert.throws(
    () =>
      localChat.ensurePerson(
        { id: "profile:full:crush", displayName: "小美", relationshipType: "crush", at: AT },
        full,
      ),
    (err: unknown) => err instanceof LocalStorageError,
  );

  // 4) 长期档案路径：确认/纠错写不进去同样要抛（以前只返回 false 没人看）
  const personId = "profile:full:crush";
  saveProfiles([profileAt(personId, "小美")], storage);
  const copy = new Map(map);
  assert.throws(
    () => writeProfileOp(quotaStorage(copy), personId, Date.now(), (p) => p),
    (err: unknown) => {
      assert.ok(err instanceof LocalStorageError);
      assert.match(err.message, /长期档案/);
      return true;
    },
  );
  // 存储正常时不该抛（这条是防误报）
  assert.ok(writeProfileOp(storage, personId, Date.now(), (p) => p));
});

// ---------------------------------------------------------------------------
// 10. 第一层结果跟着消息存在本机（刷新/切段回来不必重跑 Jev）
// ---------------------------------------------------------------------------

test("本机 34. 第一层结果存进本机消息：刷新后标签还在，且不重复写盘", () => {
  const { storage, map } = fakeStorage();
  const personId = "profile:lines:crush";
  const report = importBatch(storage, {
    personId,
    conversationId: "conv-lines",
    messages: payload([
      { sender: "other", content: "今天那个展你去了吗", sentAt: "2026年09月21日 16:16" },
      { sender: "self", content: "去了 人挺多的", sentAt: "2026年09月21日 16:17" },
    ]),
  });
  assert.equal(report.addedCount, 2);

  const target = report.added[0].id;
  const line = {
    id: target,
    emotions: { calm: 0.84, confused: 0.06 },
    intents: { asking: 0.7 },
    score: { value: null, status: "unknown" },
  } as unknown as LineResult;

  const first = localChat.saveLines(
    { personId, conversationId: "conv-lines", lines: { [target]: line } },
    storage,
  );
  assert.equal(first.updated, 1, "第一次写应当真的写进去");

  // 模拟「刷新页面 / 从历史对话打开这一段」：重新从存储读一遍
  const reloaded = localChat.conversation(personId, "conv-lines", storage)!;
  assert.deepEqual(
    reloaded.messages[0].line,
    line,
    "第一层结果必须能原样读回来（useWorkspace.loadStored 读的就是这个字段）",
  );
  assert.equal(reloaded.messages[1].line, undefined, "没分析过的那条不该被塞东西");

  // 幂等：同一份结果再写一次不产生写盘（分析是分批返回的，不能每批都白写）
  const before = map.get("crush-monitor.chat.v1");
  const again = localChat.saveLines(
    { personId, conversationId: "conv-lines", lines: { [target]: line } },
    storage,
  );
  assert.equal(again.updated, 0);
  assert.equal(map.get("crush-monitor.chat.v1"), before, "内容应当完全没变");

  // 写盘失败同样要说出来
  assert.throws(
    () =>
      localChat.saveLines(
        {
          personId,
          conversationId: "conv-lines",
          lines: { [target]: { ...line, emotions: { calm: 0.5 } } as unknown as LineResult },
        },
        quotaStorage(new Map(map)),
      ),
    (err: unknown) => err instanceof LocalStorageError,
  );

  // 坏数据（手改出来的 line）必须被丢掉，而不是让整份聊天读不出来
  const raw = JSON.parse(map.get("crush-monitor.chat.v1")!) as {
    people: { conversations: { messages: { line?: unknown }[] }[] }[];
  };
  const messages = raw.people[0].conversations[0].messages;
  messages[0].line = "这不是一个对象";
  messages[1].line = { noId: true };
  storage.setItem("crush-monitor.chat.v1", JSON.stringify(raw));
  const cleaned = localChat.conversation(personId, "conv-lines", storage)!;
  assert.equal(cleaned.messages.length, 2, "坏 line 不该影响消息本身");
  assert.equal(cleaned.messages[0].line, undefined);
  assert.equal(cleaned.messages[1].line, undefined);
});
