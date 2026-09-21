/**
 * 前端出错时回报给服务端日志。
 *
 * 目的只有一个：**页面上的失败不能再是哑的**。用户点下去没反应时，
 * 服务端日志里至少要留下一行可诊断的记录。
 *
 * 本机版里这一条同样成立：用户把服务起在自己电脑上，界面坏了很难形容，
 * 而终端里的这一行日志就是他唯一能贴出来求助的东西。
 *
 * 隐私约束（重要）：
 *   - 只发错误文本、来源文件与行列号、当前页面路径、浏览器 UA；
 *   - **绝不发送聊天内容、账号、密码、cookie、API Key**；
 *   - 文本截断到 300 字符并压成单行；
 *   - 发不出去就算了，不影响任何功能（fire-and-forget，失败静默）。
 */

const REPORT_LIMIT = 300;

function trim(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value.replace(/\s+/g, " ").slice(0, REPORT_LIMIT);
}

let reported = 0;

/**
 * 记录一次用户操作（面包屑）。
 *
 * 排查「点了没反应」时，它能区分两种完全不同的情况：
 *   - 日志里有这条面包屑、但没有后续请求 → 点击进了代码，是代码里静默失败了；
 *   - 日志里连面包屑都没有 → 点击根本没到达 JavaScript（按钮被禁用/被遮住/页面是旧的）。
 * 只记动作名，不记任何聊天内容。
 */
let stepped = 0;

export function reportClientStep(step: string): void {
  if (stepped >= 12) return;
  stepped += 1;
  try {
    void fetch("/api/client-error", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "crush-monitor",
      },
      body: JSON.stringify({
        scope: "click",
        message: trim(step) ?? "unknown",
        href: trim(typeof location === "undefined" ? undefined : location.pathname),
        ua: trim(typeof navigator === "undefined" ? undefined : navigator.userAgent),
        at: new Date().toISOString(),
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 静默
  }
}

export function reportClientProblem(scope: string, error?: unknown): void {
  // 同一次会话最多回报 20 条，避免出错循环把日志刷爆
  if (reported >= 20) return;
  reported += 1;

  const err = error instanceof Error ? error : undefined;
  const body = {
    scope: trim(scope) ?? "unknown",
    message: trim(err?.message ?? (typeof error === "string" ? error : undefined)),
    stack: trim(err?.stack),
    href: trim(typeof location === "undefined" ? undefined : location.pathname),
    ua: trim(typeof navigator === "undefined" ? undefined : navigator.userAgent),
    at: new Date().toISOString(),
  };

  try {
    void fetch("/api/client-error", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "crush-monitor",
      },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 完全静默：回报失败不能影响用户操作
  }
}
