import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把 docs/USER-GUIDE.md 转成一个自包含的 HTML 页面。
 *
 * 为什么要这一步：这份说明是要发给朋友的，手机上打开 Markdown 体验很差。
 * 生成的 guide.html 会被 Vite 从 public/ 拷进 dist/，
 * 于是可以直接给朋友一个链接（http://<服务器>/guide.html），不用发文件。
 *
 * 只支持这份文档实际用到的语法：标题、段落、列表、引用、代码块、
 * 表格、粗体、行内代码、分隔线。刻意不引第三方依赖。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = join(root, "docs", "USER-GUIDE.md");
const target = join(root, "public", "guide.html");

const escapeHtml = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 行内标记：先转义，再处理 code 与 bold。 */
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function convert(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let index = 0;

  const flushParagraph = (buffer) => {
    if (buffer.length) {
      out.push(`<p>${inline(buffer.join(" "))}</p>`);
      buffer.length = 0;
    }
  };

  const paragraph = [];

  while (index < lines.length) {
    const line = lines[index];

    // 代码块
    if (line.trimStart().startsWith("```")) {
      flushParagraph(paragraph);
      const body = [];
      index++;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        body.push(lines[index]);
        index++;
      }
      index++; // 跳过结尾的 ```
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // 表格
    if (
      line.trim().startsWith("|") &&
      lines[index + 1]?.trim().match(/^\|[\s:|-]+\|$/)
    ) {
      flushParagraph(paragraph);
      const header = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(
          lines[index]
            .trim()
            .slice(1, -1)
            .split("|")
            .map((cell) => cell.trim()),
        );
        index++;
      }
      out.push(
        `<div class="tw"><table><thead><tr>${header
          .map((cell) => `<th>${inline(cell)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`,
          )
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    // 标题与分隔线
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushParagraph(paragraph);
      out.push("<hr />");
      index++;
      continue;
    }

    // 引用
    if (line.startsWith("> ")) {
      flushParagraph(paragraph);
      const body = [];
      while (index < lines.length && lines[index].startsWith("> ")) {
        body.push(lines[index].slice(2));
        index++;
      }
      out.push(`<blockquote>${convert(body.join("\n\n"))}</blockquote>`);
      continue;
    }

    // 列表
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph(paragraph);
      const tag = bullet ? "ul" : "ol";
      const items = [];
      while (index < lines.length) {
        const next = lines[index];
        const m = tag === "ul" ? next.match(/^\s*[-*]\s+(.*)$/) : next.match(/^\s*\d+\.\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
        index++;
      }
      out.push(
        `<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`,
      );
      continue;
    }

    // 空行结束段落
    if (!line.trim()) {
      flushParagraph(paragraph);
      index++;
      continue;
    }

    paragraph.push(line.trim());
    index++;
  }

  flushParagraph(paragraph);
  return out.join("\n");
}

const markdown = readFileSync(source, "utf8");
const body = convert(markdown);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>使用说明 · Crush 好感监控器</title>
<style>
  :root { --ink:#2f3432; --muted:#7c827e; --line:#e2e4e2; --accent:#49756a; --bg:#f6f7f6; }
  * { box-sizing: border-box; }
  body {
    margin:0; background:var(--bg); color:var(--ink);
    font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 20px 18px 72px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding: 22px 20px 28px; }
  h1 { font-size: 22px; margin: 4px 0 14px; line-height:1.4; }
  h2 { font-size: 18px; margin: 30px 0 10px; padding-top: 18px; border-top:1px solid var(--line); }
  h2:first-of-type { border-top:0; padding-top:0; }
  h3 { font-size: 16px; margin: 22px 0 8px; }
  h4 { font-size: 15px; margin: 18px 0 6px; }
  p { margin: 10px 0; }
  ul, ol { margin: 10px 0; padding-left: 22px; }
  li { margin: 5px 0; }
  code {
    background:#f1f2f1; border-radius:4px; padding:1px 5px;
    font: 0.92em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  pre {
    background:#2f3432; color:#eef1ef; border-radius:10px; padding:14px 15px;
    overflow-x:auto; margin: 14px 0;
  }
  pre code { background:none; color:inherit; padding:0; font-size: 13.5px; }
  blockquote {
    margin: 14px 0; padding: 10px 14px; background:#fdf9ec;
    border-left:3px solid #e0c976; border-radius:0 8px 8px 0; color:#6b5a20;
  }
  blockquote p { margin: 4px 0; }
  hr { border:0; border-top:1px solid var(--line); margin: 26px 0; }
  .tw { overflow-x:auto; margin: 14px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
  th, td { border:1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background:#f3f5f4; font-weight:600; }
  strong { font-weight: 620; }
  .foot { color:var(--muted); font-size: 13px; margin-top: 22px; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
${body}
  </div>
  <p class="foot">本机单机版：跑在你自己这台电脑上，自己维护。</p>
</div>
</body>
</html>
`;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, html, "utf8");
console.log(
  `已生成 ${target}（源 ${markdown.split("\n").length} 行 → HTML ${html.split("\n").length} 行）`,
);
