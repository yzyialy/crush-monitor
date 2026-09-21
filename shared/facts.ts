import type { LongTermMemory, MemoryKind, Message } from "./types";

/**
 * 只允许「高确定性的客观事实」自动进入 observed 长期记忆。
 *
 * 判定标准很窄，并且刻意做得很保守：
 *   1. 只能来自对方本人说过的句子（sender=other）；
 *   2. 必须能定位到明确的 messageId；
 *   3. 内容一律以「对方说：…」的形式**引用原话**，不做任何转述；
 *   4. 句子里只要出现推测性措辞（可能 / 好像 / 其实 / 疏远 …），整句丢弃。
 *
 * 因此这个文件永远不可能产出这类内容：
 *   「她最近有点疏远」「她可能害羞」「她喜欢你」「她是回避型」。
 * 那些只能是 model_inferred，而且不能只看一次就长期保存。
 */

export type FactRule = {
  key: string;
  kind: MemoryKind;
  label: string;
  patterns: RegExp[];
};

/**
 * 客观事实规则表。
 * 每条规则只认「对方在说自己身上发生了什么」这类可核对的事实。
 */
export const FACT_RULES: FactRule[] = [
  {
    key: "work",
    kind: "event",
    label: "工作安排",
    patterns: [/加班/, /项目/, /上线/, /出差/, /开会/, /值班/, /排期/, /赶工/],
  },
  {
    key: "study",
    kind: "event",
    label: "学业安排",
    patterns: [/考试/, /复习/, /备考/, /论文/, /答辩/, /期末/],
  },
  {
    key: "health",
    kind: "event",
    label: "身体状况",
    patterns: [
      /生病/,
      /感冒/,
      /发烧/,
      /不舒服/,
      /医院/,
      /挂水/,
      /住院/,
      /扭到/,
      /扭了/,
      /受伤/,
      /摔了/,
    ],
  },
  {
    key: "trip",
    kind: "event",
    label: "出行安排",
    patterns: [/出差/, /外地/, /回老家/, /赶飞机/, /赶车/],
  },
  {
    key: "preference",
    kind: "preference",
    label: "个人偏好",
    patterns: [/不喜欢/, /不爱吃/, /讨厌/, /最怕/, /受不了/, /吃不了/],
  },
];

/**
 * 出现这些词就说明这不是事实陈述，而是推测或评价。
 * 宁可漏掉，也不能把推测自动写成 observed。
 */
export const FORBIDDEN_FACT_WORDS = [
  "可能",
  "也许",
  "大概",
  "似乎",
  "好像",
  "应该",
  "其实",
  "有点",
  "感觉",
  "疏远",
  "冷淡",
  "暧昧",
  "喜欢我",
  "回避型",
  "焦虑型",
];

/**
 * 单条事实句子的长度上下限。
 *
 * 下限只取 3：中文里「脚扭了」「感冒了」这种 3 字事实很常见，
 * 但能通过的长度仍然必须命中 FACT_RULES 的关键词，
 * 所以放宽下限不会放进任何评价性内容。
 */
const MIN_SENTENCE = 3;
const MAX_SENTENCE = 60;

/** 每段对话最多自动写入多少条事实。 */
export const MAX_FACTS_PER_CONVERSATION = 4;

export type ObservedFact = {
  id: string;
  key: string;
  kind: MemoryKind;
  content: string;
  /** 一律带上来源消息 id，保证可回溯 */
  sourceMessageIds: string[];
};

/** 稳定的小哈希，只用于生成本地 id，没有任何安全含义。 */
function hash(text: string): string {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0).toString(36);
}

/** 把一段话拆成句子。中英文标点与换行都算句子边界。 */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n；;，,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isObjective(sentence: string): boolean {
  return !FORBIDDEN_FACT_WORDS.some((word) => sentence.includes(word));
}

/**
 * 从对话里抽取可自动保存的客观事实。
 * 纯函数：不读时间、不依赖模型输出，同一段聊天永远得到同一结果。
 */
export function extractObservedFacts(messages: Message[]): ObservedFact[] {
  const facts: ObservedFact[] = [];

  for (const message of messages) {
    if (message.sender !== "other" || message.kind !== "text") continue;
    for (const sentence of splitSentences(message.text)) {
      if (sentence.length < MIN_SENTENCE || sentence.length > MAX_SENTENCE)
        continue;
      if (!isObjective(sentence)) continue;
      const rule = FACT_RULES.find((r) =>
        r.patterns.some((p) => p.test(sentence)),
      );
      if (!rule) continue;

      const content = `对方说：${sentence}`;
      const id = `mem:fact:${hash(content)}`;
      if (facts.some((f) => f.id === id)) continue;
      facts.push({
        id,
        key: rule.key,
        kind: rule.kind,
        content,
        sourceMessageIds: [message.id],
      });
      if (facts.length >= MAX_FACTS_PER_CONVERSATION) return facts;
    }
  }

  return facts;
}

/**
 * 把事实转成 observed 长期记忆。
 *
 * 注意来源等级：observed（有原话作依据），但它**仍然不等于用户确认**，
 * 系统里唯一能把来源提升到 user_confirmed 的路径是用户本人反馈。
 */
export function observedMemoriesFromFacts(
  facts: ObservedFact[],
  now: string,
): LongTermMemory[] {
  return facts.map((fact) => ({
    id: fact.id,
    kind: fact.kind,
    content: fact.content,
    sourceMessageIds: [...fact.sourceMessageIds],
    createdAt: now,
    lastConfirmedAt: now,
    status: "active" as const,
    // 原话引用接近确定，但依然不是满分：满分只留给用户确认
    confidence: 0.8,
    sourceType: "observed" as const,
  }));
}
