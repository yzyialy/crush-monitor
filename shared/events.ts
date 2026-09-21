import type { ActivityEvent, ActivityEventKind, Message } from "./types";

/**
 * 确定性事件统计：邀约与答复。
 *
 * 这是程序侧的证据来源之一，完全不依赖模型输出，也不做任何推断。
 * 它只做一件事：找出「我方明确发出邀约 → 对方明确答复」这种可核对的结构，
 * 并把它归类成可统计的事件。
 *
 * 关键词判定刻意保守：
 *   - 只有同时命中「邀约词」与「活动词」才算一次邀约；
 *   - 只有对方的紧随回复里出现明确的接受 / 拒绝措辞才算一次答复；
 *   - 说不清的（例如「到时候看」）一律不归类，宁可漏记也不猜。
 *
 * 它永远不产出「她喜欢你」「她在试探你」这类内容，只产出事件计数，
 * 措辞层面的人格或感情判断由上层禁止（见 docs/ARCHITECTURE.md）。
 */

/** 邀约的发起信号。 */
const INVITE = /(要不要|一起去|一起看|一起试|约|来不来|有空吗|有空的|想不想|一起吃|一起喝|一起玩|去看|去试)/;
/** 活动本身，避免把普通聊天误判成邀约。 */
const ACTIVITY = /(一起|展|电影|吃饭|吃个|喝|逛|玩|店|票|桌游|爬山|跑步|咖啡|酒吧|演出|演唱会|旅行|出去玩|活动|球)/;
/** 提前安排的时间标记。 */
const PLANNED = /(周末|下周|下个月|下个星期|明天|后天|哪天|提前|安排|到时候|过几天|周[一二三四五六日天])/;
/** 当天临时的时间标记。 */
const SAME_DAY = /(今天|今晚|现在|马上|待会|一会儿|这就|立刻|等会)/;
/**
 * 明确的接受。
 * 刻意不收「到时候看」「可能有」这类含糊措辞：那是没答应，
 * 归到接受会把「不确定」统计成「愿意」。
 */
const ACCEPT = /(好啊|好呀|可以啊|可以|行啊|去啊|没问题|嗯嗯|说定了|我买|我来定|那我看看|有空的|有空)/;
/** 明确的拒绝。 */
const DECLINE = /(不行|去不了|没空|没时间|下次吧|不去|算了|太忙|改天|有事|这周可能不行|再说吧|不方便|不一定|可能不行)/;

const isInvite = (text: string) => INVITE.test(text) && ACTIVITY.test(text);

function classifyTiming(text: string): "planned" | "same_day" | "unspecified" {
  if (PLANNED.test(text)) return "planned";
  if (SAME_DAY.test(text)) return "same_day";
  return "unspecified";
}

function classifyAnswer(text: string): "accepted" | "declined" | null {
  const declined = DECLINE.test(text);
  const accepted = ACCEPT.test(text);
  // 两可时以拒绝为准：「这周可能不行」同时可能命中接受词，绝不能误判成接受
  if (declined) return "declined";
  if (accepted) return "accepted";
  return null;
}

/**
 * 从一轮对话里抽出确定性事件。
 * 纯函数：不读时间、不依赖模型，同一段聊天永远得到同一结果。
 */
export function detectActivityEvents(
  messages: Message[],
  conversationId: string,
  at: number,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const usable = messages.filter((m) => m.kind === "text");

  for (let i = 0; i < usable.length; i++) {
    const message = usable[i];

    // 对方主动提出一起活动：只记「提出」这件事，不解释动机
    if (message.sender === "other" && isInvite(message.text)) {
      events.push({
        kind: "counterpart_proposes_activity",
        conversationId,
        messageIds: [message.id],
        at,
      });
      continue;
    }

    if (message.sender !== "self" || !isInvite(message.text)) continue;

    // 找我方邀约之后对方的第一条回复
    const reply = usable.slice(i + 1).find((m) => m.sender === "other");
    if (!reply) continue;
    const answer = classifyAnswer(reply.text);
    if (!answer) continue;

    const timing = classifyTiming(`${message.text} ${reply.text}`);
    const kind = `${timing}_invite_${answer}` as ActivityEventKind;
    events.push({
      kind,
      conversationId,
      messageIds: [message.id, reply.id],
      at,
    });
  }

  // 同一段对话里同一种事件只保留一次，避免复述刷高证据数
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.conversationId}|${event.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 把新事件并入既有统计。按「对话 + 事件类型」去重，并保留上限。 */
export function recordActivityEvents(
  previous: ActivityEvent[],
  incoming: ActivityEvent[],
  limit = 200,
): ActivityEvent[] {
  const merged = new Map<string, ActivityEvent>();
  for (const event of [...previous, ...incoming])
    merged.set(`${event.conversationId}|${event.kind}`, event);
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.at - a.at ||
        a.conversationId.localeCompare(b.conversationId) ||
        a.kind.localeCompare(b.kind),
    )
    .slice(0, limit);
}

/** 某个事件类型下，有多少段不同对话支持它。 */
export function eventConversations(
  events: ActivityEvent[],
  kind: ActivityEventKind,
): string[] {
  return [
    ...new Set(events.filter((e) => e.kind === kind).map((e) => e.conversationId)),
  ];
}
