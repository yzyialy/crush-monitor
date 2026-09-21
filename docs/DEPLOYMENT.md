# Crush 好感监控器（本机单机版）· 本机运行与排障

这份文档只讲一件事：**在你自己的电脑上把它跑起来、用起来、出问题怎么查**。

本机版没有服务器、没有账号、没有数据库。聊天记录与长期档案都存在你**这台电脑的浏览器**里（localStorage），服务端进程只做三件事：把 `/api/analyze`、`/api/deep-analysis` 转发给模型服务、把 `dist/` 里的静态页面发给你、以及把前端错误上报打进终端日志（`/api/client-error`）。

> 本文档里的所有命令都在**项目根目录**执行。
> 想确认当前目录：`pwd`（PowerShell 用 `Get-Location`）。

## 目录

- [1. 需要什么](#1-需要什么)
- [2. 安装](#2-安装)
- [3. 配置 .env](#3-配置-env)
- [4. 构建与启动](#4-构建与启动)
- [5. 日常使用与开发](#5-日常使用与开发)
- [6. 数据存在哪、怎么备份](#6-数据存在哪怎么备份)
- [7. 健康检查与自检命令](#7-健康检查与自检命令)
- [8. 排障](#8-排障)
- [9. 安全须知](#9-安全须知)
- [10. 这一版去掉了什么](#10-这一版去掉了什么)

> 关于**功能**（历史对话、开始新对话（保留历史）、改名与改称呼、出错红条）的说明在 `README.md` 与 `docs/USER-GUIDE.md`；
> 本文只讲运行与排障。

---

## 1. 需要什么

| 项目 | 要求 |
| --- | --- |
| Node.js | **22.12 或更高**（`node --version` 确认） |
| 包管理器 | npm（随 Node 一起装好） |
| 操作系统 | Windows / macOS / Linux 都可以；Windows 上用 `npm.cmd` 更稳（`npm.ps1` 常被执行策略挡住） |
| 网络 | 装依赖和调用模型时需要联网；分析本身不是离线功能 |
| 密钥 | 必填 `TYPESAFE_API_KEY`（第一层 Jev）；想用深度解读再加 `DEEPSEEK_API_KEY` |

磁盘占用：依赖约 200MB，构建产物约 0.5MB。

## 2. 安装

```sh
npm ci --include=dev
```

- **必须带 `--include=dev`**：服务端是用 `tsx` 直接运行 TypeScript 的，`tsx`、`typescript`、`vite` 都在 devDependencies 里，漏装会启动失败。
- 约 200MB 下载量，网络慢时耐心等。
- 用 `npm ci` 而不是 `npm install`：它按 `package-lock.json` 精确安装，避免依赖漂移。
- npm 有时会在 stderr 打印 `NativeCommandError` 之类的噪音，那是 PowerShell 读 stderr 的产物，**以 npm 自己报的退出码为准**（`echo $LASTEXITCODE` 应为 0）。

## 3. 配置 .env

```sh
npm run setup
```

它会用 `.env.example` 生成一份 `.env`；如果 `.env` 已存在就原样保留，不会覆盖你填过的密钥。

然后编辑 `.env`：

```ini
TYPESAFE_API_KEY=你的第一层key      # 必填，没有它 /api/analyze 会返回 503
PORT=3178                            # 默认端口
HOST=127.0.0.1                       # 默认只允许本机访问

DEEP_ANALYSIS_ENABLED=true           # 不用深度解读就保持 false（不产生任何 DeepSeek 请求）
DEEP_ANALYSIS_MODEL=deepseek-flash
DEEPSEEK_API_KEY=你的第二层key       # 只有启用第二层才需要
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEP_ANALYSIS_TIMEOUT_MS=45000
DEEP_ANALYSIS_PROMPT_VERSION=3       # 改 prompt 语义时必须递增，否则会错误复用旧解读
```

注意：

- **不要把 `.env` 提交进任何仓库**。`.gitignore` 已经忽略 `.env` 与 `.env.*`（只放行 `.env.example`）。
- Windows 上给它收权限（只给自己访问）：
  ```powershell
  icacls .env /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
  ```
- macOS / Linux 上：`chmod 600 .env`。
- 密钥只在服务端进程里读取。**浏览器拿不到它**：前端源码与 `dist/assets/*.js` 里既没有环境变量名，也没有 `sk-...` / `apikey_...` 形态的字符串（有测试守护，`npm test` 会扫）。

## 4. 构建与启动

```sh
npm run build   # = tsc --noEmit + 生成使用说明页 + vite build → dist/
npm start       # = tsx server/index.ts，读取 .env 后监听
```

启动成功会打印一行：

```
Crush Monitor（本机版）: http://127.0.0.1:3178 · key configured · deep on · data 全部在浏览器 localStorage
```

**如果忘了先 `npm run build`**，启动仍然成功（接口也能用），但日志里会多一行、浏览器里也会看到一段中文提示页：

```
⚠️ 没有找到前端构建产物 dist/index.html：请先运行 npm run build（或开发模式 npm run dev），然后刷新页面。
   （找的是：<项目目录>\dist\index.html）
```

这时页面返回的是 **HTTP 503 + 一段说明「先跑 npm run build」的 HTML**（不是 404、也不是空白页）；
`/api/health`、`/api/analyze`、`/api/deep-analysis` 都不受影响，照常可用。

然后浏览器打开 **http://127.0.0.1:3178/**。

- 想让同一局域网的手机也能打开：把 `HOST` 改成 `0.0.0.0`，再用 `http://<这台电脑的局域网 IP>:3178/`。**这是明文 HTTP，等于对外暴露**，自己权衡（见第 9 节）。**日常使用仍然建议只用 `127.0.0.1`**：局域网 IP 不是浏览器的「安全上下文」，历史上正是它导致 `crypto.randomUUID` / `crypto.subtle` 缺失、点「开始分析」没反应（现在已修好并有回归测试，但仍不推荐）。

## 5. 日常使用与开发

```sh
npm run dev        # 开发模式：前端 http://127.0.0.1:5178/（Vite 会把 /api 代理到 3178）
npm test           # 全部测试（229 个用例），不调用任何真实模型
npm run check:live # 真实模型调用检查，消耗你自己的 API 额度
npm run guide:build # 只重新生成 public/guide.html（build 里已经包含这一步）
```

`npm run dev` 会同时起两个进程：`tsx watch server/index.ts`（API，端口取自 `.env`）和 `vite`（前端，固定 5178）。**只有开发模式走 5178**；正式使用请用 `npm run build` + `npm start`，开 3178。

测试是**离线**的：不碰 Jev、不碰 DeepSeek、不需要 Key。想验证真实链路才用 `npm run check:live`。

## 6. 数据存在哪、怎么备份

本机版的长期数据与聊天记录都在浏览器里，键名如下（同一个浏览器配置文件下有效）：

| localStorage key | 内容 |
| --- | --- |
| `crush-monitor.chat.v1` | 人 / 对话 / 消息（聊天记录），**外加每条消息上的第一层分析结果**（情绪 / 意图 / 回复评级），所以刷新或从「历史对话」打开某一段时标签还在、不必重跑 Jev |
| `crush-monitor.profile.v1` | `PersonProfile`：基线、记忆、已知模式、习惯、确认与纠错 |
| `crush-monitor.last-conversation.v1` | 每个人最近打开的那段对话 |
| `crush-monitor.memory.v1` / `crush-monitor.feedback.v1` | 第二阶段遗留的扁平记忆与反馈（会被收编进档案） |
| `crush-monitor.deep-feedback.v1` | 深度解读的「有用 / 有问题」反馈 |
| `crush-monitor.migrated.v1` | 旧数据检测的处理标记 |

几个必须知道的点：

- **换浏览器、换用户、开无痕窗口、清「网站数据」= 数据没了。** 这是 local-first 的代价，不是 bug。
- **服务端不保存聊天内容，也不保存档案。** 每次分析只把「这次要分析的消息 + 检索出来的相关记忆」放进请求体，用完即弃。
- 想手工备份：浏览器开发者工具 → Application → Local Storage → 选中 `http://127.0.0.1:3178` → 把上面几个键的值复制出来存成文件。恢复时把值贴回去、刷新页面即可。
- 数据量提醒：localStorage 一般只有 5MB 左右。粘贴超长聊天记录时，请分批导入；真到上限时写入会失败（界面会提示保存失败，此时先删掉不用的记录）。

## 7. 健康检查与自检命令

```sh
# 服务是否在、密钥是否配上、第二层是否启用
curl http://127.0.0.1:3178/api/health
```

```powershell
# Windows 上用这个
Invoke-RestMethod http://127.0.0.1:3178/api/health | ConvertTo-Json -Depth 5
```

正常返回（本机版**没有** `auth` 之类字段）：

```json
{
  "ok": true,
  "mode": "local",
  "configured": true,
  "model": "jev-1.13.0",
  "deep": { "enabled": true, "configured": true, "model": "deepseek-flash", "promptVersion": 3 }
}
```

其它自检：

```sh
npm test        # 逻辑与不变量（含「前端产物不得含密钥 / 模型域名」与「非安全上下文」两组守卫）
npm run build   # 类型检查 + 前端构建
```

本机版的全部 HTTP 路由（只有四个，别去旧文档里找 `/api/auth/*` 或业务 CRUD）：

| 方法 | 路径 | 作用 | 需要登录 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查 | 否 |
| POST | `/api/client-error` | 前端错误上报（只记错误文本，204 返回） | 否 |
| POST | `/api/analyze` | 第一层：Jev 逐句情绪 / 意图 / 回复评级 | 否 |
| POST | `/api/deep-analysis` | 第二层：DeepSeek 深度解读 | 否 |
| GET | 其它非 `/api/` 路径 | `dist/` 静态页面（未命中回退 `index.html`；缺 dist 时返回「先 npm run build」的提示页） | 否 |

## 8. 排障

按「现象 → 先查什么 → 常见原因」组织。

### 页面打不开 / 404 / 只有一段中文提示

按顺序查：

1. **看到一段说「先运行 npm run build」的中文页面** → 就是没构建前端。在项目根目录跑 `npm run build`，再刷新。这时服务本身是好的：`curl http://127.0.0.1:3178/api/health` 会正常返回。
   终端里也会同时打印 `⚠️ 没有找到前端构建产物 dist/index.html：…`，两处提示说的是同一件事。
2. 终端里有没有 `Crush Monitor（本机版）: http://127.0.0.1:3178` 这一行？没有就是没启动成功。
3. 端口对不对：`.env` 里的 `PORT` 与浏览器地址栏要一致。
4. 真的 404（不是上面那段提示页）：`dist/` 里缺少对应文件，重新 `npm run build`。

> 这条兜底是给「陌生人第一次跑」准备的：新用户很容易先 `npm start` 而忘了 `npm run build`，
> 以前会得到 404 / 空白页，看起来像"项目坏了"。现在页面与日志都会直接告诉他下一步做什么。
> 守护用例：`tests/local-workspace.test.ts` 的「本机 28」。

### 页面能开，但一点「分析聊天」就失败

1. `curl http://127.0.0.1:3178/api/health` → 看 `configured` 是不是 `false`（说明 `.env` 里 `TYPESAFE_API_KEY` 没读到）。
2. 看终端里的 `[analyze] ... status=...` 日志：
   - `401` → Key 不对；
   - `403` → 这个 API 账号没权限；
   - `422` → 这次输入模型处理不了，缩小聊天范围重试；
   - `429 / 529` → 上游忙，稍后重试；
   - `503` → 服务端没有配 Key。
3. 界面提示「请分段粘贴，每次不超过 120 条」→ 单次请求上限 120 条 / 24,000 字，分批粘贴。
4. **页面顶部出现了红条** → 那是新增的「点下去没反应」兜底，红条里就是原因，同时终端里会有一行日志：

   ```
   [client-error] scope=ui msg=没能把这段聊天保存到本机：… href=/ ua=Mozilla/…
   ```

   它只含错误文本、页面路径与浏览器 UA，**不含聊天内容、不含密钥**（前端也做了限额：同一会话最多 20 条错误 / 12 条点击面包屑）。
   - `scope=click msg=分析聊天` 但没有后续 `/api/analyze` 日志 → 点击进了代码但中途失败，看紧随其后的 `scope=ui` 那条；
   - **连 `scope=click` 都没有** → 点击根本没到达 JavaScript：按钮是灰的（弹窗里有红字说明原因）、或者浏览器加载的是旧页面。

### 按钮是灰的，点不动

确认弹窗里的「开始分析」在条件不满足时是禁用的，**按钮下方现在会用红字写出原因**：
没识别到聊天记录 / 识别到 3 个说话人 / 还没选哪个昵称是你 / 选中的昵称不在这次粘贴的内容里。
以前这里什么都不显示，用户只能得到「点了没反应」。

### 深度解读点了没反应 / 一直没结果

1. `/api/health` 里 `deep.enabled` 是否为 `true`；`deep.configured` 是否为 `true`（`DEEPSEEK_API_KEY` 有没有读到）。
2. 终端里搜 `[deep-analysis]`：有 `status=timeout` 就是上游超时（可调大 `DEEP_ANALYSIS_TIMEOUT_MS`）。
3. 如果返回 400「深层分析输入不符合要求」：说明请求体不符合 `server/deep-schema.ts` 的约束。本机版**必须有非空 `messages`**（消息在前端，服务端没有聊天记录可读）。这条约束由对象级校验统一判断，而不是字段级 `.min(1)`——后者会把「空数组 + 其它有效输入」这种组合误判成 400。
4. 深度解读**不会自动触发**：粘贴聊天只做第一层，第二层必须由你点按钮。

### 「清空了但刷新又回来了」

- 设置里的按钮现在叫「**开始新对话（保留历史）**」，它**不删任何东西**：本机会新开（或复用已有的空记录）一段并切过去，下一次粘贴写进新段，旧记录留在顶部的「历史对话」里。
- 想看/回到旧记录：点顶部「历史对话 N」。每一行是「名字 + 条数 + 最近一条时间 + 第一句」，点一下就把那段的聊天与已分析标签调回界面（不重新调用模型）。
- 想彻底删掉长期数据：用「长期观察」里的**清空全部长期数据**，或手工删 localStorage 键。单独删一段聊天用历史列表里的「删除」（要二次确认，只删那一段）。
- 反过来：只删 localStorage 的 `crush-monitor.chat.v1` 会留下档案（"人"还在，但没有聊天记录）。

### 历史对话列表里每段「名字都一样」

- 默认名字是「第 N 段 · 时间 · 第一句摘要」，**序号与时间保证不重复**；时间按微信格式（`2026年09月21日 17:19`）显式解析并显示到分钟，解析不了就原样显示、绝不截断（早期版本截前 16 字符，导致 17:19 与 17:28 显示成一模一样）。
- 本机版的 `title` **只在你自己改过名时才写**；导入时不会把第一句塞进去（旧数据里那种自动标题会在读取时被认回「没改过名」，见 `migrateChatPayload`/`parseLocalConversation`）。
- 改名**不会改变排序**：本地存储里刻意不更新 `updatedAt`。守护用例：「本机 29 / 30 / 31 / 32」。

### 界面提示「保存到本机失败」/「本机存储已满」

- 本机存储（localStorage）一般只有 5MB 左右。写不进去时界面会**明说**原因与办法（以前是静默失败，用户以为存好了）：
  - 「浏览器不允许本页面使用本机存储」→ 无痕 / 隐私窗口，或浏览器设置里禁用了网站数据；
  - 「本机存储已满…先删掉不用的聊天记录再试」→ 去「历史对话」里删掉不要的段，或导出后清理。
- 同一把 key 的写入是整体覆盖（`crush-monitor.chat.v1` 里放着全部聊天记录），所以导入超长聊天时要分批。

### 界面提示「检测到旧版本的浏览器本地长期数据」

- 这是旧结构的数据检测（见第 6 节的键名）。本机版不再有"上传到服务器"这一步，点「继续使用这份数据」只是确认按当前结构读一遍并标记处理完成，不会发任何模型请求；点「不用了」也只是不再提示。

### 刷新页面后回到的不是刚才那段对话

- 打开某个人时优先恢复 `crush-monitor.last-conversation.v1` 里记的那一段；如果没有记录，就打开这个人的**最近更新**的那一段（列表按 `updatedAt` 倒序，和服务端 `ORDER BY updated_at DESC` 同口径）。
- 点了「开始新对话（保留历史）」之后，那段新（空）记录是最新的，所以刷新后会停回它上面，旧聊天不会自己跳回来。
- 一段对话的消息 id 由「对话 + 指纹」稳定推导，同一个人同一种关系也不会每次粘贴都新建一段。

### 依赖 / 构建类问题

| 报错 | 原因与处理 |
| --- | --- |
| `Cannot find module 'tsx'` | 装依赖时漏了 `--include=dev`，重跑 `npm ci --include=dev` |
| `tsc` 报类型错误 | 先 `npx tsc --noEmit` 看完整列表；不要用 `ts-ignore` 压过去 |
| Vite `EBUSY` 崩掉 dev server | Windows 上编辑器/压缩软件锁住了被 watch 的文件；关掉占用进程，或把文件移出项目目录 |
| `EADDRINUSE` | 端口被占，改 `PORT` 或结束占用进程 |
| npm 打印 `NativeCommandError` | PowerShell 读 stderr 的噪音，看退出码是否为 0 |

## 9. 安全须知

- **默认只监听 127.0.0.1**：只有这台电脑能访问，不需要 HTTPS。
- 改成 `HOST=0.0.0.0` 之后就是明文 HTTP 暴露在网络上：同一网段的任何人都能打开页面、看到你能看到的东西（本机版没有登录这道门）。**别在不受信任的网络里这么做。**
- **别用「局域网 / 公网 IP + 明文 HTTP」当日常入口**。除了上面那条暴露风险，这种地址在浏览器眼里不是**安全上下文**：`crypto.randomUUID` 与 `crypto.subtle` 会不存在，历史上正是它让「开始分析」点了没反应（异常被吞掉，界面一片安静）。本机版现在统一走 `shared/hash.ts`（`randomId()` 用 `getRandomValues` 兜底、`sha256Hex()` 拿不到 subtle 时走纯 JS SHA-256，与服务端 `node:crypto` 逐字节一致），并有 `tests/insecure-context.test.ts` 守着——但 127.0.0.1 仍是唯一被支持的打开方式。
- `.env` 里的 Key 只在服务端进程内存里；前端 bundle 不含任何 Key 与模型域名（有测试守护）。`.gitignore` 忽略 `.env` 与 `.env.*`（只放行 `.env.example`）。
- **上报接口 `/api/client-error` 故意不要求登录、不做同源校验**：它存在的意义就是在"页面根本没跑起来"时也能留下日志。代价是它会往终端多打一行；它只接收并打印错误文本 / 路径 / UA（各字段有长度上限），**不接收也不打印聊天内容**。
- 分析时数据会离开本机：第一层发给 TypeSafe（Jev），启用第二层时这段对话与检索出的相关记忆会发给 DeepSeek。**"数据存在本机"不等于"分析过程离线"。**
- 不要把 `.env` 或私人聊天记录提交到仓库；`.gitignore` 已忽略 `.env`、`data/`、`logs/`、`*.sqlite*`。

## 10. 这一版去掉了什么

从「服务端多账号版」改回本机单机版时删掉的能力（**不要在本机版里找它们**）：

- 账号与登录：`server/auth.ts`、`src/useAuth.ts`、`src/LoginPage.tsx`、`src/login.css`，以及 `/api/auth/*` 全部接口。密码哈希、session、CSRF/同源校验、登录限速都不存在了。
- 服务端持久化：`server/db.ts`、`server/routes.ts`（人 / 对话 / 消息 / 档案 / 反馈 / 账号路由），以及 `DATA_DIR`、`COOKIE_SECURE`、`TRUST_PROXY` 这些配置项。`data/` 目录与 `*.sqlite` 文件都不再产生。
- 多账号隔离与多设备同步：没有 `user_id`，没有"换设备登录看到同一份数据"。数据跟着浏览器走。
- 乐观锁与 409 冲突：本机只有一个写入者，`ws.version` 恒为 0、`ws.conflict` 恒为空字符串（保留字段是为了不改调用点）。
- 管理脚本：`scripts/user-cli.ts`、`scripts/db-cli.ts` 及其 npm 脚本（`user:*`、`db:*`）。

保留不变的：两层分析（Jev + DeepSeek）、`server/ai/*` 的输入重算与 Interpretation Boundary 安全层、长期观察的全部能力（基线 / 记忆 / 习惯 / 长期模式 / 用户确认与纠错），以及 `shared/` 里的全部纯函数。

本机版**新增**的（都在本文里有对应条目）：

- **历史对话面板**（顶部入口）：每段可打开、可改名、可单独删除，切换不消耗额度；
- **「开始新对话（保留历史）」**：新开一段而不是删掉旧记录；
- **改「对方称呼」**：只改显示名；
- **出错红条 + `/api/client-error`**：任何「点了没反应」都在页面上说明原因，并在终端留一行可诊断日志；
- **dist 缺失兜底**：忘了 `npm run build` 时给中文提示页而不是 404；
- **非安全上下文兜底**：`shared/hash.ts` 让 `crypto.randomUUID` / `crypto.subtle` 缺失时仍能工作（但请仍然用 `127.0.0.1`）。
