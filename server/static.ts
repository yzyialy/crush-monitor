import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 前端构建产物的托管与「还没 build」的兜底。
 *
 * 为什么单独一个模块：`server/index.ts` 导入即 `app.listen`，
 * 测试不能 import 它。这里只有纯函数 + 一个注册函数（没有副作用），
 * 所以测试可以直接注入「假装没有 dist」并把整个流程真跑一遍。
 *
 * 背景（真实场景）：本机版是 `npm start` 由 Express 提供 `dist/`。
 * 新用户很容易先 `npm start` 而忘了 `npm run build` ——
 * 那时 `express.static` 什么都找不到，浏览器里只有一个 404 或空白页，
 * 看起来像「项目坏了」。所以这里必须给出一句能照做的话。
 */

/** 前端入口文件（相对 dist 根）。 */
export const FRONTEND_ENTRY = "index.html";

/** dist 根目录下的入口文件路径（用 path.join，不写死任何绝对路径）。 */
export function frontendEntryPath(distDir: string): string {
  return join(distDir, FRONTEND_ENTRY);
}

/** 构建产物在不在。`exists` 可注入，测试用它模拟「没有 dist」。 */
export function hasFrontendBuild(
  distDir: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return exists(frontendEntryPath(distDir));
}

/** 启动日志里的那行中文提示（下一步要做什么写得明明白白）。 */
export function missingFrontendNotice(distDir: string): string {
  return (
    "⚠️ 没有找到前端构建产物 dist/index.html：" +
    "请先运行 npm run build（或开发模式 npm run dev），然后刷新页面。\n" +
    `   （找的是：${frontendEntryPath(distDir)}）`
  );
}

/**
 * dist 缺失时给浏览器看的最小提示页。
 *
 * 刻意内联样式、不引用任何静态资源：此刻 dist 里什么都没有，
 * 引用任何文件都会再 404 一次。文案必须能在浏览器里直接读懂。
 */
export function missingFrontendPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>还差一步：先构建前端</title>
<style>
  body { margin: 0; padding: 40px 20px; background: #f3f3f3; color: #343735;
         font: 14px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 620px; margin: 0 auto; background: #fff; border: 1px solid #cfd1d2;
         border-radius: 10px; padding: 26px 24px; }
  h1 { font-size: 17px; margin: 0 0 12px; }
  code { background: #f1f2f1; border-radius: 4px; padding: 1px 6px; }
  ol { padding-left: 20px; }
  p.hint { color: #7c827e; font-size: 12.5px; }
</style>
</head>
<body>
<main>
  <h1>服务已经起来了，但前端还没构建</h1>
  <p>浏览器能连上，说明 <code>npm start</code> 成功了；只是 <code>dist/</code> 里还没有页面 ——
     所以刚才看到的不是「项目坏了」，而是少跑了一步。</p>
  <ol>
    <li>在这个项目的根目录执行 <code>npm run build</code>（会做类型检查并生成 dist/）。</li>
    <li>然后刷新本页即可。</li>
  </ol>
  <p>开发模式则用 <code>npm run dev</code>，改代码即时生效（前端在 5178 端口）。</p>
  <p class="hint">API 不受影响：<code>/api/health</code>、<code>/api/analyze</code>、
     <code>/api/deep-analysis</code> 现在就能用。</p>
</main>
</body>
</html>
`;
}

export type StaticOptions = {
  /** dist 目录（绝对路径） */
  dir: string;
  /** 注入式的存在性检查，默认 node:fs 的 existsSync */
  exists?: (path: string) => boolean;
};

/**
 * 把静态页面挂到 app 上。
 *
 * 返回「构建产物在不在」，方便启动日志再补一句提示。
 * 缺失时**不抛异常、不崩**：所有非 `/api/` 路径都返回一段中文提示页，
 * `/api/*` 原样放行给后面的路由（这也是唯一不能挡住的东西）。
 */
export function registerStatic(
  app: express.Express,
  options: StaticOptions,
): boolean {
  const exists = options.exists ?? existsSync;
  if (!hasFrontendBuild(options.dir, exists)) {
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/")) {
        next();
        return;
      }
      res.status(503).type("html").send(missingFrontendPage());
    });
    return false;
  }
  app.use(express.static(options.dir, { index: false }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(frontendEntryPath(options.dir));
  });
  return true;
}
