/** The UI labels and semantic criteria share one registry. */
export const EMOTIONS = {
  happy: { label: "开心", criteria: "愉快、满足、开心或兴奋" },
  confused: { label: "疑惑", criteria: "不理解、好奇、疑问或困惑" },
  angry: {
    label: "愤怒",
    criteria: "真实生气、愤怒或强烈不满，排除亲密玩笑式骂人",
  },
  sad: { label: "难过", criteria: "伤心、低落、悲伤" },
  shy: { label: "害羞", criteria: "羞涩、难为情或暧昧时不好意思" },
  caring: { label: "关心", criteria: "担心、关切或体贴对方" },
  teasing: { label: "调侃", criteria: "开玩笑、逗对方、玩梗或善意戏谑" },
  calm: { label: "平静", criteria: "客观陈述、平静中性交流，无明显情绪" },
  annoyed: { label: "不耐烦", criteria: "厌烦、想赶紧结束、不愿重复解释" },
  surprised: { label: "惊讶", criteria: "意外、吃惊、超出预期" },
  disappointed: { label: "失落", criteria: "期待落空、委屈、失望" },
  unknown: { label: "难判断", criteria: "无法判断主要情绪或以上均不适合" },
} as const;
export function topEmotions(probabilities?: Record<string, number>) {
  return Object.entries(probabilities || {})
    .filter(
      ([key, p]) => key in EMOTIONS && Number.isFinite(p) && p > 0 && p <= 1,
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, p]) => ({
      key,
      label: EMOTIONS[key as keyof typeof EMOTIONS].label,
      probability: p,
      percent: p > 0 && p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`,
    }));
}
