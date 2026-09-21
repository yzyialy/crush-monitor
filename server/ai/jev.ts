import { analyze } from "../analysis";
import { MODEL } from "../../shared/types";
import type { ObservationProvider } from "./types";

/**
 * Jev 提供者。
 *
 * 第一层的实现完全保留在 server/analysis.ts —— 包括 buildRequest、
 * requestSchema、超时、错误映射，一行都没有重写。
 * 这里只把它包装成接口，让业务层不必知道 @typesafe-ai/sdk 的存在。
 *
 * 注意：不要在这条路径上加入任何第二层逻辑。
 * 第一层是观察，第二层是解释，两者不可互相污染。
 */
export const jevProvider: ObservationProvider = {
  id: "jev",
  model: MODEL,
  observe: (request, signal) => analyze(request, signal),
};
