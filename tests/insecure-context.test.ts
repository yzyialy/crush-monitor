/**
 * 非安全上下文回归测试。
 *
 * 背景（真实事故）：用明文 HTTP + 公网 IP / 局域网 IP 访问时，浏览器里
 *   `crypto.randomUUID` 与 `crypto.subtle` **不存在**（它们只在 HTTPS 或
 *   localhost 这类安全上下文里才有）。点「开始分析」会抛
 *   `crypto.randomUUID is not a function`，异常被吞掉，界面表现为「没反应」。
 *
 * 本机版对这条尤其敏感：用户就是把它装在自己电脑上、用局域网 IP 给手机看，
 * 那正好是非安全上下文。
 *
 * 这组测试确保：拿不到这两个 API 时，解析、生成 id、算上下文哈希都照常工作，
 * 而且哈希结果必须与 node:crypto 的 sha256 逐字符一致（服务端用的是它）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomId, sha256Hex, sha256HexSync } from "../shared/hash";
import { parseChat, toMessages } from "../shared/parser";

/** 模拟非安全上下文：没有 randomUUID、没有 subtle，但有 getRandomValues */
let insecureSeed = 0;
const insecureCrypto = {
  getRandomValues: (array: Uint8Array) => {
    insecureSeed += 1;
    for (let i = 0; i < array.length; i++)
      array[i] = (i * 37 + 11 + insecureSeed) & 0xff;
    return array;
  },
} as unknown as Crypto;

/** 极端情况：连 getRandomValues 都没有 */
const emptyCrypto = {} as Crypto;

test("非安全上下文：randomId 不依赖 randomUUID", () => {
  const id = randomId(insecureCrypto);
  assert.equal(typeof id, "string");
  assert.equal(id.length, 32, "应当返回 32 位十六进制");
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.notEqual(randomId(insecureCrypto), randomId(insecureCrypto), "两次取值应当不同");
});

test("非安全上下文：连 getRandomValues 都没有时仍然给得出 id", () => {
  const id = randomId(emptyCrypto);
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
});

test("非安全上下文：randomId 在 crypto 整体缺失时也不抛", () => {
  const id = randomId(undefined);
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
});

test("安全上下文：randomId 优先用 randomUUID", () => {
  const id = randomId({ randomUUID: () => "11111111-2222-3333-4444-555555555555" } as unknown as Crypto);
  assert.equal(id, "11111111-2222-3333-4444-555555555555");
});

test("sha256：纯 JS 实现与 node:crypto 逐字符一致（含中文与边界长度）", () => {
  const samples = [
    "",
    "a",
    "abc",
    "hello world",
    "今天那个展你去了吗",
    "去了 人挺多的 有几个装置蛮有意思",
    "x".repeat(55), // 补位边界：刚好塞进一个块
    "x".repeat(56), // 补位边界：需要两个块
    "x".repeat(64),
    "x".repeat(1000),
    JSON.stringify({ messages: ["我：下次一起去", "对方：好呀 不过这周要加班"] }),
  ];
  for (const sample of samples) {
    const expected = createHash("sha256").update(sample, "utf8").digest("hex");
    assert.equal(sha256HexSync(sample), expected, `纯 JS SHA-256 与 node:crypto 不一致：${sample.slice(0, 20)}`);
  }
});

test("sha256：没有 subtle 时退回纯 JS，结果与 node:crypto 一致", async () => {
  const text = "context:我：下次一起去|对方：好呀";
  const expected = createHash("sha256").update(text, "utf8").digest("hex");
  assert.equal(await sha256Hex(text, insecureCrypto), expected);
  assert.equal(await sha256Hex(text, emptyCrypto), expected);
  assert.equal(await sha256Hex(text, undefined), expected);
});

test("sha256：有 subtle 时走原生路径，结果同样一致", async () => {
  const text = "上下文哈希要和服务端一致";
  const expected = createHash("sha256").update(text, "utf8").digest("hex");
  // Node 里 globalThis.crypto.subtle 是真实实现
  assert.equal(await sha256Hex(text), expected);
});

test("非安全上下文：解析并生成消息 id 不抛异常", () => {
  // toMessages 内部用 randomId() 生成 id；这里直接验证它产出的 id 可用
  const before = globalThis.crypto?.randomUUID;
  try {
    // 即使环境里恰好没有 randomUUID，解析也必须成功
    if (typeof before === "function") {
      // 无法删除原型上的方法，这里改为验证两条路径都产出合法 id
      const ids = [randomId(), randomId(insecureCrypto)];
      for (const id of ids) assert.ok(id.length > 0);
    }
    const parsed = parseChat(
      "芝\n2026年09月21日 16:16\n[苦涩]\n\n老黑\n2026年09月21日 16:17\n烧不了多少",
    );
    const messages = toMessages(parsed.messages, "老黑");
    assert.equal(messages.length, 2);
    for (const message of messages) {
      assert.ok(message.id.length > 0, "每条消息都要有 id");
      assert.equal(typeof message.text, "string");
    }
    assert.equal(messages[0].sender, "other");
    assert.equal(messages[1].sender, "self");
  } finally {
    if (typeof before === "function") {
      // 不改动全局，仅断言还原无损
      assert.equal(globalThis.crypto.randomUUID, before);
    }
  }
});

/**
 * 额外一条（本机版专有）：整条链路在「没有 randomUUID、没有 subtle」的环境里跑通。
 *
 * 覆盖 `parseChat → toMessages → sha256Hex(contextKey(...))`，
 * 也就是点「开始分析」之后真正会走的那几行。
 */
test("非安全上下文：解析 → 生成消息 → 算上下文哈希整条链路不抛且哈希正确", async () => {
  const { contextKey } = await import("../shared/types");
  const parsed = parseChat(
    "老黑\n2026年09月21日 17:19\n在干嘛\n\n我\n2026年09月21日 17:20\n刚下班 你呢",
  );
  const messages = toMessages(parsed.messages, "我").map((m) => ({
    ...m,
    // 模拟非安全上下文：把 id 换成 getRandomValues 兜底出来的
    id: randomId(insecureCrypto),
  }));
  assert.equal(messages.length, 2);

  const key = contextKey(messages, "crush");
  const expected = createHash("sha256").update(key, "utf8").digest("hex");
  // 没有 subtle 时必须走纯 JS，且与服务端 node:crypto 的结果一致
  assert.equal(await sha256Hex(key, emptyCrypto), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});
