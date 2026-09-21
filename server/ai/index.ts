import { createDeepSeekProvider, readDeepSeekConfig } from "./deepseek";
import { jevProvider } from "./jev";
import type { InterpretationProvider, ObservationProvider } from "./types";
import type { DeepSeekConfig } from "./deepseek";

/**
 * Provider 注册表。
 * 业务层只从这里取实现，不认识任何具体的模型 SDK。
 * 换成 GPT / Kimi / Qwen / GLM 时，只需要在这里替换 interpretation 的实现。
 */
export function resolveProviders(
  env: Record<string, string | undefined> = process.env,
): {
  observation: ObservationProvider;
  interpretation: InterpretationProvider;
  deepConfig: DeepSeekConfig;
} {
  const deepConfig = readDeepSeekConfig(env);
  return {
    observation: jevProvider,
    interpretation: createDeepSeekProvider(deepConfig),
    deepConfig,
  };
}

export { jevProvider } from "./jev";
export {
  createDeepSeekProvider,
  readDeepSeekConfig,
  DEEP_ANALYSIS_INSTRUCTIONS,
  DEEP_ANALYSIS_SCHEMA,
  buildPayload,
  extractOutputText,
  findPseudoPrecision,
  scanPseudoPrecision,
} from "./deepseek";
export type { DeepSeekConfig } from "./deepseek";
export * from "./types";
