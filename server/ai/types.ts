import type {
  AnalysisRequest,
  AnalysisResponse,
  BoundaryMeta,
  DeepAnalysis,
  DeepAnalysisRequest,
  DeepAnalysisStatus,
} from "../../shared/types";

/**
 * AI 提供者抽象。
 *
 * 业务层（路由、前端）只依赖这里的接口，不直接 import 任何模型 SDK。
 * 以后换成 GPT / Kimi / Qwen / GLM，只需新增一个实现，
 * 不必改动 server/index.ts 里的流程。
 *
 * 两层职责严格分离：
 *   第一层 ObservationProvider —— 只做结构化观察，不写解释。
 *   第二层 InterpretationProvider —— 只做上下文解释，不重新生成概率、不计算趋势。
 */

/** 第一层：观察。既有 Jev 实现保持不变，这里只做接口适配。 */
export interface ObservationProvider {
  readonly id: string;
  readonly model: string;
  observe(
    request: AnalysisRequest,
    signal?: AbortSignal,
  ): Promise<AnalysisResponse>;
}

/** 第二层成功时的原始产出，尚未附加传输层信息。 */
export type InterpretationOutcome = {
  analysis: DeepAnalysis;
  model: string;
  usage: { input_tokens: number; output_tokens: number } | null;
  latencyMs: number;
  /** 边界处理痕迹：只含字段名与是否重试，绝不含聊天内容。 */
  boundary: BoundaryMeta;
};

/** 第二层：解释。 */
export interface InterpretationProvider {
  readonly id: string;
  readonly model: string;
  readonly promptVersion: number;
  /** 是否已配置到可以真正调用。false 时业务层不得调用 interpret。 */
  readonly configured: boolean;
  interpret(
    request: DeepAnalysisRequest,
    signal?: AbortSignal,
  ): Promise<InterpretationOutcome>;
}

/** 第二层可预期的失败原因。全部与第一层隔离，不会影响 Jev。 */
export type DeepAnalysisErrorCode =
  | "disabled"
  | "not_configured"
  | "timeout"
  | "upstream"
  | "invalid_output"
  | "pseudo_precision"
  | "boundary_violation";

export class DeepAnalysisError extends Error {
  constructor(
    readonly code: DeepAnalysisErrorCode,
    message: string,
    readonly status: DeepAnalysisStatus = "error",
  ) {
    super(message);
    this.name = "DeepAnalysisError";
  }
}
