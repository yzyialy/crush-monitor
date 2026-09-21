/** Display tiers for the model's 0–100 expression-quality score. */
export const REPLY_RATINGS = [
  {
    label: "SSS",
    min: 95,
    range: "95–100",
    description: "非常出彩，表达自然且精准接住语境",
  },
  {
    label: "SS",
    min: 90,
    range: "90–94",
    description: "优秀，兼顾情绪、分寸和话题延续",
  },
  {
    label: "S",
    min: 80,
    range: "80–89",
    description: "很好，有效回应且让交流更顺畅",
  },
  {
    label: "A",
    min: 70,
    range: "70–79",
    description: "合适，回应自然且照顾语境",
  },
  {
    label: "B",
    min: 60,
    range: "60–69",
    description: "基本合适，但表达还有提升空间",
  },
  {
    label: "C",
    min: 40,
    range: "40–59",
    description: "较弱，可能接话生硬或忽略对方情绪",
  },
  {
    label: "D",
    min: 0,
    range: "0–39",
    description: "不合适，可能造成压力、冒犯或难以继续交流",
  },
] as const;
export function replyRating(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 100)
    return null;
  return REPLY_RATINGS.find((rating) => value >= rating.min) ?? null;
}
