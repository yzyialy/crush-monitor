import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { analyze, requestSchema } from "./analysis";
import { z } from "zod";
import { DeepAnalysisError, resolveProviders } from "./ai";
import { buildProviderInput } from "./ai/input";
import { deepRequestSchema } from "./deep-schema";
import { missingFrontendNotice, registerStatic } from "./static";
import {
  DEEP_CONTEXT_WINDOW,
  type DeepAnalysisRequest,
  type DeepAnalysisStatus,
  type Message,
  type Observation,
  type ProfileContextBundle,
} from "../shared/types";

/**
 * HTTP 入口（本机单机版）。
 *
 * 结构只有四块：
 *   /api/health          健康检查（不暴露密钥、不暴露任何账号信息）
 *   /api/client-error    前端错误上报（只记错误文本，不记聊天内容）
 *   /api/analyze         第一层：Jev 逐句情绪 / 意图 / 回复评级
 *   /api/deep-analysis   第二层：DeepSeek 深度解读
 *   /                     dist 静态页面
 *
 * 与第四阶段相比去掉的东西：
 *   - session / 登录 / 账号（没有 /api/auth/*）
 *   - 同源与 CSRF 中间件（本机版只监听 127.0.0.1，没有跨站面）
 *   - SQLite 与全部业务路由（人 / 对话 / 消息 / 档案 / 反馈 / 账号）
 *
 * 仍然成立的两条硬边界：
 *   1. 长期数据（档案、基线、记忆、反馈）只在浏览器里，服务端用完即弃；
 *   2. API Key 只存在于服务端 .env，浏览器永远拿不到。
 */

const app = express();
app.disable("x-powered-by");

// 请求体上限：一次分析最多 120 条消息，1MB 已经非常宽松
app.use(express.json({ limit: "1mb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  const { deepConfig } = resolveProviders();
  res.json({
    ok: true,
    mode: "local",
    // 只报告事实，不暴露路径、密钥或任何账号信息
    configured: Boolean(process.env.TYPESAFE_API_KEY),
    model: "jev-1.13.0",
    deep: {
      enabled: deepConfig.enabled,
      configured: deepConfig.enabled && Boolean(deepConfig.apiKey),
      model: deepConfig.model,
      promptVersion: deepConfig.promptVersion,
    },
  });
});

// ---------------------------------------------------------------------------
// 前端错误上报（只记错误文本，**绝不记聊天内容**）
//
// 为什么需要它：界面上「点了没反应」是最难查的一类问题——请求可能压根没发出去。
// 有了这条通路，服务端日志里至少会留下一行可诊断的记录：
//
//   [client-error] scope=click msg=分析聊天 href=/ ua=Mozilla/...
//
// 本机版同样**不要求任何登录 / 同源校验**（本机版本来就没有这两层）：
// 出错的场景往往就是「页面根本没跑起来」，这时候再加一道门只会让日志也一起消失。
// ---------------------------------------------------------------------------

const clientErrorSchema = z.object({
  scope: z.string().max(40).optional(),
  message: z.string().max(400).optional(),
  stack: z.string().max(400).optional(),
  href: z.string().max(200).optional(),
  ua: z.string().max(200).optional(),
  at: z.string().max(40).optional(),
});

app.post("/api/client-error", (req, res) => {
  const parsed = clientErrorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(204).end();
    return;
  }
  // 单行输出：日志按行读，换行会把一条记录拆散
  const oneLine = (value?: string) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  console.log(
    `[client-error] scope=${oneLine(parsed.data.scope) || "unknown"} ` +
      `msg=${oneLine(parsed.data.message) || "(空)"} ` +
      `href=${oneLine(parsed.data.href) || "-"} ` +
      `ua=${oneLine(parsed.data.ua).slice(0, 60) || "-"}`,
  );
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// 限流：本机版没有账号，按进程计数即可
// ---------------------------------------------------------------------------

let calls = 0;
let windowAt = Date.now();
let active = 0;
const budgets = new Map<string, { count: number; at: number }>();

function withinRateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  let entry = budgets.get(key);
  if (!entry || now - entry.at > windowMs) {
    entry = { count: 0, at: now };
    budgets.set(key, entry);
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

const apiMessageSchema = z.object({
  id: z.string().min(1).max(80),
  sender: z.enum(["self", "other"]),
  text: z.string().min(1).max(24000),
  timestamp: z.string().max(80).nullable(),
  kind: z.enum(["text", "unreadable"]),
  mediaKind: z
    .enum(["voice", "image", "video", "sticker", "file", "location", "link", "other"])
    .optional(),
});

// ---------------------------------------------------------------------------
// 第一层：Jev 分析
//
// 消息一律由请求体带来：服务端没有聊天记录的副本，也不落盘。
// ---------------------------------------------------------------------------

app.post("/api/analyze", async (req, res) => {
  const payload = req.body as Record<string, unknown>;
  const valid = requestSchema.safeParse(payload);
  if (!valid.success) {
    res.status(400).json({ error: "聊天结构或长度不符合要求，请校正后重试" });
    return;
  }
  if (!process.env.TYPESAFE_API_KEY) {
    res
      .status(503)
      .json({ error: "分析服务尚未配置，请在服务端设置 TYPESAFE_API_KEY" });
    return;
  }
  const now = Date.now();
  if (now - windowAt > 3_600_000) {
    calls = 0;
    windowAt = now;
    budgets.clear();
  }
  const ip = req.ip || "local";
  if (!withinRateLimit(`${ip}|analyze`, 180) || calls >= 3000 || active >= 8) {
    res.status(429).json({ error: "分析请求较多，请稍后重试" });
    return;
  }
  calls++;
  active++;
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const started = Date.now();
    const result = await analyze(valid.data, controller.signal);
    res.json(result);
    console.log(
      `[analyze] route=/api/analyze status=200 latency=${Date.now() - started}ms tokens=${result.usage?.input_tokens ?? 0}/${result.usage?.output_tokens ?? 0}`,
    );
  } catch (error) {
    const code = Number((error as { status?: number }).status) || 502;
    if (!res.headersSent) {
      const messagesByCode: Record<number, string> = {
        401: "Jev 认证失败，请检查服务端 API 配置",
        403: "当前 API 账号没有调用权限",
        422: "模型无法处理当前输入，请缩小聊天范围重试",
        429: "Jev 正忙，请稍后重试",
        529: "Jev 暂时繁忙，请重试",
      };
      res.status(code >= 400 && code < 600 ? code : 502).json({
        error:
          messagesByCode[code] ||
          "分析未完成，可能是网络超时。已保留聊天，可重试。",
      });
    }
    // 只记状态码，不记内容
    console.error(`[analyze] status=${code}`);
  } finally {
    active--;
  }
});

// ---------------------------------------------------------------------------
// 第二层：深层分析
//
// 与第一层隔离：独立校验、独立限流、独立错误处理。
// 长期数据（检索结果 + 基线）由浏览器随请求带上来，服务端只读不存。
// 请求 schema 单独放在 ./deep-schema（无副作用），测试可以直接导入。
// ---------------------------------------------------------------------------

let activeDeep = 0;

app.post("/api/deep-analysis", async (req, res) => {
  const valid = deepRequestSchema.safeParse(req.body);
  if (!valid.success) {
    res.status(400).json({ error: "深层分析输入不符合要求" });
    return;
  }

  const { interpretation, deepConfig } = resolveProviders();
  const envelope = {
    analysis: null,
    model: deepConfig.model,
    promptVersion: deepConfig.promptVersion,
    latencyMs: 0,
    usage: null,
  };

  if (!deepConfig.enabled) {
    res.json({ ...envelope, status: "disabled", error: "第二层分析未启用" });
    return;
  }
  if (!deepConfig.apiKey) {
    res.status(503).json({
      ...envelope,
      status: "not_configured",
      error: "未配置 DEEPSEEK_API_KEY",
    });
    return;
  }
  if (
    activeDeep >= 2 ||
    !withinRateLimit(`${req.ip || "local"}|deep`, 60)
  ) {
    res.status(429).json({
      ...envelope,
      status: "error",
      error: "深层分析请求较多，请稍后重试",
    });
    return;
  }

  const data = valid.data;
  const request: DeepAnalysisRequest = {
    revision: data.revision ?? 1,
    relation: data.relation,
    targetId: data.targetId,
    // 空数组在这里是无害的（上面 refine 已经保证至少有一条消息）
    messages: (data.messages ?? []) as Message[],
    observations: (data.observations ?? []) as Observation[],
    memory: data.memory ?? [],
    // patterns 由服务端用 computePatterns 重新计算，客户端传入的被丢弃
    patterns: [],
    ...(data.relationshipContext
      ? { relationshipContext: data.relationshipContext }
      : {}),
    ...(data.profile
      ? { profile: data.profile as ProfileContextBundle }
      : {}),
  };

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  activeDeep++;
  const started = Date.now();
  try {
    const providerInput = buildProviderInput(request);
    const outcome = await interpretation.interpret(
      providerInput,
      controller.signal,
    );
    const boundaryMeta = outcome.boundary;
    const codes = boundaryMeta.violationCodes ?? [];
    if (
      boundaryMeta.softenedFields.length ||
      boundaryMeta.removedFields.length ||
      boundaryMeta.retried ||
      codes.length
    )
      console.log(
        `[deep-analysis] model=${outcome.model} latency=${outcome.latencyMs}ms ` +
          `softened=${boundaryMeta.softenedFields.length} ` +
          `removed=${boundaryMeta.removedFields.length} ` +
          `retried=${boundaryMeta.retried} ` +
          `history=${providerInput.profile?.baselineStatus ?? "none"} ` +
          `codes=${codes.length ? codes.join("|") : "none"}`,
      );

    // 只返回最终安全结果与计量：不落盘、没有隐藏推理、没有 prompt。
    // 翻译层由前端用同一份 shared/translation 构建，避免两套口径。

    res.json({
      status: "ok",
      analysis: outcome.analysis,
      error: null,
      model: outcome.model,
      promptVersion: interpretation.promptVersion,
      latencyMs: outcome.latencyMs,
      usage: outcome.usage,
      patternTrend: providerInput.patternTrend,
      historicalTrend: providerInput.profile?.historicalTrend ?? null,
    });
  } catch (error) {
    const known = error instanceof DeepAnalysisError;
    const status: DeepAnalysisStatus = known ? error.status : "error";
    const latencyMs = Date.now() - started;
    if (!res.headersSent && !controller.signal.aborted) {
      const code =
        status === "not_configured"
          ? 503
          : known && error.code === "timeout"
            ? 504
            : 502;
      res.status(code).json({
        analysis: null,
        status,
        error: known ? error.message : "深层分析未完成",
        model: deepConfig.model,
        promptVersion: deepConfig.promptVersion,
        latencyMs,
        usage: null,
      });
    }
    console.error(
      `[deep-analysis] model=${deepConfig.model} latency=${latencyMs}ms status=${status} code=${known ? error.code : "unknown"}`,
    );
  } finally {
    activeDeep--;
  }
});

// ---------------------------------------------------------------------------
// 静态页面
//
// dist 缺失时不 404、不空白：所有非 /api/ 路径都回一段中文提示页
// （「先运行 npm run build」），启动日志里同时打一句同样的话。
// 具体实现在 ./static（无副作用，测试可以直接驱动）。
// ---------------------------------------------------------------------------

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const frontendBuilt = registerStatic(app, { dir: dist });

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    // 对外只说"输入不受支持"，绝不返回 stack 或内部细节
    const tooLarge = (err as { type?: string }).type === "entity.too.large";
    if (!res.headersSent)
      res
        .status(tooLarge ? 413 : 400)
        .json({ error: tooLarge ? "内容过大" : "输入格式或体积不受支持" });
    if (!tooLarge)
      console.error(
        `[error] ${(err as Error)?.name ?? "unknown"} code=${(err as { code?: string }).code ?? "-"}`,
      );
  },
);

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT || 3178);
const host = process.env.HOST || "127.0.0.1";

app.listen(port, host, () => {
  console.log(
    `Crush Monitor（本机版）: http://${host}:${port} · ` +
      `key ${process.env.TYPESAFE_API_KEY ? "configured" : "missing"} · ` +
      `deep ${resolveProviders().deepConfig.enabled ? "on" : "off"} · ` +
      `data 全部在浏览器 localStorage`,
  );
  // 没构建过前端时，浏览器里只会看到一段中文提示页；日志里也说一遍原因
  if (!frontendBuilt) console.warn(missingFrontendNotice(dist));
});
