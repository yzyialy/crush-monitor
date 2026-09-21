import { ACTIONS, STAGES, TONES, type Judgment } from "./types";
import { z } from "zod";
export const scoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number().min(0).max(4),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.number().min(0).max(1)),
});
export const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.number().min(0).max(1)),
});
export const noulAnswer = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});
export function judgment(s: unknown, e: unknown): Judgment {
  const v = scoreAnswer.parse(s),
    evidence = choiceAnswer.parse(e);
  const insufficient =
    evidence.choice === "insufficient" ||
    evidence.confidence < 0.35 ||
    v.confidence < 0.35;
  return {
    value: Math.round(v.score * 25),
    confidence: v.confidence,
    status: insufficient
      ? "insufficient"
      : v.confidence < 0.65 || evidence.choice === "limited"
        ? "ambiguous"
        : "clear",
    probabilities: v.probabilities,
  };
}
export function actionResult(a: unknown, b: unknown, p: unknown) {
  const v = choiceAnswer.parse(a);
  let action = v.confidence < 0.35 ? "insufficient" : v.choice;
  if (!(action in ACTIONS)) action = "insufficient";
  if (noulAnswer.parse(b).noul >= 0.8) action = "respect";
  else if (noulAnswer.parse(p).noul >= 0.75) action = "wait";
  const sorted = Object.entries(v.probabilities)
    .filter(([k]) => k in ACTIONS)
    .sort((a, b) => b[1] - a[1]);
  const second = sorted[1];
  return {
    action,
    alternative:
      action === v.choice &&
      !["respect", "wait", "insufficient"].includes(action) &&
      second &&
      second[1] >= 0.2 &&
      sorted[0][1] - second[1] <= 0.25
        ? second[0]
        : undefined,
  };
}
export function safeStage(a: unknown) {
  const v = choiceAnswer.parse(a);
  return v.confidence >= 0.35 && v.choice in STAGES ? v.choice : "unknown";
}
export function safeTone(a: unknown) {
  const v = choiceAnswer.parse(a);
  return {
    tone: v.confidence >= 0.35 && v.choice in TONES ? v.choice : "unknown",
    tones: v.probabilities,
    toneConfidence: v.confidence,
  };
}
export function percentages(values: Record<string, number>) {
  const entries = Object.entries(values);
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  if (!sum) return [];
  const base = entries.map(([k, v]) => ({
    key: k,
    value: Math.floor((v / sum) * 100),
    fraction: ((v / sum) * 100) % 1,
  }));
  let left = 100 - base.reduce((s, e) => s + e.value, 0);
  for (const e of [...base].sort((a, b) => b.fraction - a.fraction)) {
    if (left-- <= 0) break;
    e.value++;
  }
  return base.sort((a, b) => b.value - a.value);
}
