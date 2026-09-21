/** Competing interpretations of the primary communicative purpose, not mind reading. */
export const INTENTS = {
  share: {
    label: "分享近况",
    criteria: "主动讲自己的经历、活动或状态，主要是分享而非回答问题",
  },
  answer: {
    label: "回答问题",
    criteria: "回应前面的具体询问，主要目的是提供所问信息",
  },
  inform: {
    label: "告知信息",
    criteria: "通知事实、安排或进展，区别于分享个人感受和经历",
  },
  ask: {
    label: "询问信息",
    criteria: "获取事实、原因、安排或情况，无需额外假定暧昧动机",
  },
  clarify: {
    label: "确认理解",
    criteria: "核对自己对前文的理解，询问是不是某个意思",
  },
  explain: {
    label: "解释说明",
    criteria: "澄清原因、误会或补充背景，让对方理解自己的话或行为",
  },
  opinion: {
    label: "表达观点",
    criteria: "陈述看法或评价，未明显要求对方赞同",
  },
  agree: {
    label: "表示认同",
    criteria: "赞同对方观点、感受或提议，不只是确认收到消息",
  },
  disagree: {
    label: "表达异议",
    criteria: "提出不同观点、反驳或纠正，不等于拒绝关系",
  },
  acknowledge: {
    label: "回应收到",
    criteria: "简短确认已看到或听懂，例如嗯、好的；没有更明确的沟通目的",
  },
  continue: {
    label: "延续话题",
    criteria: "接住前文或补充话头，主要在维持对话而非传达新信息",
  },
  change: {
    label: "转移话题",
    criteria: "将交流引向另一个话题，不能仅因转移就推断逃避或拒绝",
  },
  joke: {
    label: "玩笑逗趣",
    criteria: "开玩笑、接梗或善意互损，主要为了有趣；没有明显浪漫试探",
  },
  vent: {
    label: "倾诉烦恼",
    criteria: "表达困扰或抱怨以释放感受，没有明显要求解决方案",
  },
  comfort_seek: {
    label: "寻求安慰",
    criteria: "通过表达脆弱或委屈，希望得到情绪支持，而不只是分享情况",
  },
  validation: {
    label: "寻求认同",
    criteria: "希望对方肯定自己的感受、看法或价值，区别于单纯表达观点",
  },
  help: { label: "请求帮助", criteria: "希望对方提供具体建议、信息或实际帮助" },
  advice: {
    label: "提供建议",
    criteria: "主动提供解决办法或行动建议，不只是表达评价",
  },
  care: {
    label: "表达关心",
    criteria: "关注对方状态或需要，主要是关怀，不自动表示恋爱好感",
  },
  comfort: {
    label: "安慰支持",
    criteria: "接住对方困扰、鼓励或给予支持，区别于寻求安慰",
  },
  praise: { label: "赞美欣赏", criteria: "肯定对方特质或表现，不自动等于调情" },
  thanks: { label: "表达感谢", criteria: "感谢对方的回应、帮助或付出" },
  apologize: {
    label: "道歉修复",
    criteria: "承认不妥、致歉或尝试修复交流关系",
  },
  attention: {
    label: "寻求关注",
    criteria:
      "希望对方多注意、回应或陪伴自己，需要语境证据，普通分享不默认归此",
  },
  interest: {
    label: "试探好感",
    criteria: "间接探询对方是否在意自己或对自己有浪漫兴趣，须有具体上下文支持",
  },
  invite_hint: {
    label: "试探邀约",
    criteria: "含蓄创造共同活动或见面的机会，尚未直接提出邀请；单说无聊不够",
  },
  invite: {
    label: "发出邀约",
    criteria: "直接邀请对方见面、一起活动或协商具体安排",
  },
  flirt: {
    label: "暧昧逗弄",
    criteria:
      "用双关、亲昵或有浪漫意味的玩笑试探互动；普通互损不默认暧昧，不等于同意进一步行为",
  },
  affection: {
    label: "表达在意",
    criteria: "表达想念、珍惜或对彼此关系的重视，须有可见文本证据",
  },
  ease: {
    label: "缓和气氛",
    criteria: "缓解尴尬、冲突或紧张，玩笑在这里主要为了缓和关系",
  },
  refuse: {
    label: "婉拒提议",
    criteria: "委婉推辞当前提议或邀约，不能扩大成拒绝恋爱或否定对方",
  },
  boundary: {
    label: "表达边界",
    criteria: "说明不愿、不能接受或要求停止的行为，不把明确拒绝曲解为欲擒故纵",
  },
  close: {
    label: "结束聊天",
    criteria: "明确或含蓄表示本次对话先结束、自己要忙或休息",
  },
  other: {
    label: "其他意图",
    criteria: "能看出沟通目的，但不属于上述任何一类",
  },
  unknown: {
    label: "难以判断",
    criteria: "必要上下文缺失或存在无法消除的歧义，无法判断主要沟通意图",
  },
} as const;
export function topIntents(probabilities?: Record<string, number>) {
  return Object.entries(probabilities || {})
    .filter(
      ([key, p]) => key in INTENTS && Number.isFinite(p) && p > 0 && p <= 1,
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, p]) => ({
      key,
      label: INTENTS[key as keyof typeof INTENTS].label,
      probability: p,
      percent: p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`,
    }));
}
