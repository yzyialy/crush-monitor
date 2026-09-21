import { INTENTS, topIntents } from "../shared/intents";
import { REPLY_RATINGS, replyRating } from "../shared/ratings";
import { EMOTIONS, topEmotions } from "../shared/labels";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Heart,
  MoreHorizontal,
  X,
  ArrowUpRight,
  RotateCcw,
  MessageCircle,
  Settings2,
  Plus,
  ArrowRight,
  Send,
  Check,
  Sparkles,
  History,
} from "lucide-react";
import {
  parseChat,
  toMessages,
  mergeMessages,
  withinScope,
  recentScope,
} from "../shared/parser";
import {
  ACTIONS,
  MODEL,
  RELATIONS,
  statusLabel,
  meanQuality,
  type InterpretationFeedback,
  type Message,
  type Relation,
  type Parsed,
} from "../shared/types";
import { exampleText } from "../shared/fixtures";
import { mediaNoun } from "../shared/media";
import { latestSession } from "../shared/patterns";
import { useAnalysis } from "./useAnalysis";
import { useDeepAnalysis } from "./useDeepAnalysis";
import { DeepPanel, DeepPrivacyNote } from "./DeepPanel";
import {
  conversationIdFor,
  historyForSession,
  profileUiState,
} from "./useProfile";
import { useWorkspace } from "./useWorkspace";
import { LongTermPanel } from "./LongTermPanel";
import { randomId } from "../shared/hash";
import { reportClientProblem, reportClientStep } from "./clientLog";
import {
  loadInterpretationFeedback,
  recordInterpretationFeedback,
} from "./storage";
import "./deep.css";

/**
 * 解析时间戳。
 *
 * 麻烦点：粘贴进来的时间是**微信格式**「2026年09月21日 17:19」，
 * 浏览器 `new Date()` 解析不了它（返回 Invalid Date）。之前退回"截前 16 个字符"，
 * 结果 17:19 和 17:28 都显示成「2026年09月21日 17:」——两行看起来一模一样。
 * 这里显式处理中文格式，并且解析不了就原样返回，不做任何截断。
 */
function parseStamp(value: string): Date | null {
  const text = value.trim();
  if (!text) return null;
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct;
  const chinese = text.match(
    /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  const dashed = text.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  const match = chinese ?? dashed;
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
}

/** 列表里显示的时间：同年省略年份，带分钟，保证不同时间显示不同。 */
function stampOf(value: string | null | undefined): string {
  if (!value) return "";
  const text = String(value);
  const date = parseStamp(text);
  if (!date) return text;
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `${sameYear ? "" : `${date.getFullYear()}-`}${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 一段对话的显示名。
 *
 * 默认用「第 N 段 · 时间 · 第一句」——光靠第一句是不够的：
 * 同一段聊天重复粘贴时第一句会完全一样，看起来就像"名字都一样"。
 * 序号 + 时间保证每段都能区分；用户改过名就用改过的名字
 * （本机版的 `title` 只在用户改名时才写，见 `src/useWorkspace.ts` 的 ensureRemote）。
 */
function conversationName(
  conversation: {
    title?: string | null;
    preview?: string | null;
    messageCount?: number;
    lastMessageAt?: string | null;
    updatedAt: string;
  },
  index: number,
): string {
  if (conversation.title) return conversation.title;
  const when = stampOf(conversation.lastMessageAt ?? conversation.updatedAt);
  const preview = (conversation.preview ?? "").replace(/\s+/g, " ").trim();
  const head = `第 ${index} 段${when ? ` · ${when}` : ""}`;
  if (!conversation.messageCount) return `${head} · 空对话`;
  return preview ? `${head} · ${preview.slice(0, 16)}` : head;
}

function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),select,textarea,input",
          ) || [],
        );
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" aria-label="关闭" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export default function App() {
  /**
   * 本机版没有账号与登录门：直接挂载工作区。
   * 长期数据与聊天记录都在浏览器 localStorage 里，服务端只做模型调用。
   */
  return <Workspace />;
}

function Workspace() {
  const a = useAnalysis();
  const [messages, setMessages] = useState<Message[]>([]),
    [input, setInput] = useState(""),
    [self, setSelf] = useState(""),
    [other, setOther] = useState("Crush"),
    [relation, setRelation] = useState<Relation>("crush");
  const [raw, setRaw] = useState(""),
    [parsed, setParsed] = useState<Parsed[]>([]),
    [role, setRole] = useState(""),
    [importing, setImporting] = useState(false),
    [settings, setSettings] = useState(false),
    [detail, setDetail] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [overlap, setOverlap] = useState<Message[] | null>(null),
    [scope, setScope] = useState<Message[] | null>(null);
  /**
   * 「刚才那一下到底发生了什么」。
   *
   * 之前点「开始分析」如果中途失败，界面可能什么都不显示（按钮 disabled、
   * 或者异常被 catch 掉只改了内部 state），用户看到的就是「点了没反应」。
   * 这里把所有「点下去却没有结果」的情况都写成页面上一条红条，
   * 外加全局兜底：未捕获异常与未处理的 Promise 拒绝也会落到这里。
   *
   * 本机版同样保留服务端上报：用户把服务起在自己电脑上，界面坏了很难形容，
   * 终端里的 `[client-error] ...` 一行就是他唯一能贴出来求助的东西。
   */
  const [problem, setProblem] = useState("");
  /** 所有「点下去却没有结果」都要同时落到页面上与服务端日志里，方便远程诊断 */
  const reportProblem = useCallback((text: string, error?: unknown) => {
    setProblem(text);
    reportClientProblem("ui", error instanceof Error ? error : new Error(text));
  }, []);
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const text = `页面出错：${event.message || "未知错误"}`;
      setProblem(text);
      reportClientProblem("window.error", event.error ?? new Error(event.message));
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      const detail =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "未处理的异步错误";
      setProblem(`操作没有完成：${detail}`);
      reportClientProblem("unhandledrejection", reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  // 第二层（深度解读）：只有用户主动点击才会发出请求
  const [deepOpen, setDeepOpen] = useState(false);
  const [deepSeen, setDeepSeen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<InterpretationFeedback[]>(() =>
    loadInterpretationFeedback(),
  );
  /**
   * 本机版：长期档案与聊天记录都在浏览器 localStorage 里，
   * 服务端只在单次分析时收到这次要分析的消息与检索上下文，用完即弃。
   */
  const ws = useWorkspace({ displayName: other, relation });
  const profile = ws.profile;
  const deep = useDeepAnalysis({
    messages,
    relation,
    targetId: null,
    lines: a.lines,
    observationModel: MODEL,
    profile,
    conversationId: ws.conversationId,
  });
  const bottom = useRef<HTMLDivElement>(null);
  const stay = useRef(true);
  const [longOpen, setLongOpen] = useState(false);
  /** 历史对话面板 */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 设置弹窗里的「对方称呼」草稿 */
  const [nameDraft, setNameDraft] = useState("");
  /**
   * 打开已有对话时，把本机保存的消息与第一层结果拉回界面。
   *
   * 本机版里聊天记录在浏览器 localStorage 里，所以刷新页面、重开浏览器、
   * 切换对象都不应该看到空白；已分析过的标签也不必再花一次 Jev 调用。
   * 只在界面还空着的时候加载，避免覆盖用户正在粘贴的内容。
   */
  const hydrated = useRef<string>("");
  useEffect(() => {
    const conversationId = ws.conversationId;
    if (!conversationId || !ws.ready) return;
    if (hydrated.current === conversationId) return;
    if (messages.length) {
      hydrated.current = conversationId;
      return;
    }
    hydrated.current = conversationId;
    void (async () => {
      const stored = await ws.loadStored(conversationId);
      if (!stored.messages.length) return;
      setMessages(stored.messages);
      a.hydrate(stored.lines);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.conversationId, ws.ready]);
  /** 恢复对方称呼：刷新后不应该还把顶部显示成默认的 "Crush" */
  useEffect(() => {
    const name = ws.person?.displayName;
    if (name && name !== other) setOther(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.person?.displayName]);
  /**
   * 把第一层结果写回本机存储。
   *
   * 服务端版把 `line_json` 存进 messages 表；本机版对应地存进本机的消息对象。
   * 不写这一步，「刷新页面」或「从历史对话打开某一段」就只剩光秃秃的气泡 ——
   * 情绪/意图标签全没了，只能再花一次额度重跑 Jev。
   */
  useEffect(() => {
    if (!Object.keys(a.lines).length || !ws.conversationId) return;
    void ws.saveLines(a.lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.lines, ws.conversationId]);
  const observations = deep.request.observations;
  const committed = useRef<string>("");
  /**
   * 会话提交：把这一轮对话并入本机的长期档案。
   *
   * 消息本身已经在本机存储里，这里只告诉工作区"提交哪一段对话 + 本次观察"，
   * 由它读回本机消息、跑 shared 的纯函数、写回 localStorage。
   * 同一段对话重复提交是幂等的（靠 conversationId 判断是否已经并入过）。
   */
  useEffect(() => {
    if (!messages.length || !observations.length) return;
    if (!ws.conversationId) return;
    const stamp = `${ws.conversationId}|${deep.result?.analysis ? "deep" : "session"}`;
    if (committed.current === stamp) return;
    committed.current = stamp;
    void ws.commit({
      observations,
      analysis: deep.result?.analysis ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, observations, ws.conversationId, deep.result]);
  const history = useMemo(
    () =>
      historyForSession({
        profile,
        messages,
        observations,
        patterns: deep.request.patterns,
      }),
    [profile, messages, observations, deep.request.patterns],
  );
  const profileState = profileUiState(
    profile,
    deep.profileContext?.estimatedTokens ?? 0,
  );
  useEffect(() => {
    if (stay.current) {
      const scroller = bottom.current?.parentElement;
      scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length]);
  const busy = a.status === "loading",
    ov = a.overview,
    value = ov?.affinity.value,
    quality = meanQuality(messages, a.lines);
  const last = a.history.at(-1),
    previous = a.history.at(-2);
  const delta =
    a.status === "complete" &&
    last?.comparable &&
    previous?.overview.affinity.value != null &&
    last.overview.affinity.value != null
      ? last.overview.affinity.value - previous.overview.affinity.value
      : null;
  /**
   * 开始分析。
   *
   * 本机版：先把消息写进本机工作区（localStorage 才是长期真相源），
   * 再用写回后的消息（带本机 id）去分析 —— 这样刷新页面、重开浏览器
   * 都能回到同一份聊天记录，id 也稳定，第一层结果不会对不上。
   *
   * 任何一步失败都要**说出原因**：以前 `ensureRemote` 失败只 `return null`，
   * 界面只留一行小字，用户看到的就是「点了没反应」。
   */
  async function start(ms: Message[]) {
    setProblem("");
    if (!withinScope(ms)) {
      setScope(ms);
      return;
    }
    let stored: Message[] | null = null;
    try {
      stored = await ws.ensureRemote(ms);
    } catch (err) {
      reportProblem(
        `没能把这段聊天保存到本机：${err instanceof Error ? err.message : String(err)}`,
        err,
      );
      return;
    }
    if (!stored) {
      reportProblem(
        "没能把这段聊天保存到本机（工作区没有返回消息）。上面的提示里有原因，重试一次通常能过。",
      );
      return;
    }
    setMessages(stored);
    setInput("");
    try {
      a.run(stored, relation, ws.conversationId);
    } catch (err) {
      reportProblem(
        `分析没能启动：${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
  function add(ms: Message[], mode: "auto" | "append" | "skip" = "auto") {
    const m = mergeMessages(messages, ms, mode);
    if (m.ambiguous) {
      setOverlap(ms);
      return;
    }
    if (!m.added) {
      reportProblem(
        "这次没有新增消息：这段内容之前已经导入过了，所以没有重新分析。（想重跑请点「继续分析」。）",
      );
      setInput("");
      return;
    }
    setNotice("");
    void start(m.messages);
  }
  function prepare(text: string) {
    if (!text.trim()) return;
    reportClientStep("分析聊天");
    if (text.length > 100000) {
      setNotice("请分段粘贴，每次不超过 120 条。");
      return;
    }
    const p = parseChat(text);
    const names = [...new Set(p.messages.map((x) => x.speaker))];
    if (
      messages.length &&
      self &&
      !p.warnings.length &&
      names.every((n) => n === self || n === other)
    ) {
      add(toMessages(p.messages, self));
      return;
    }
    setRaw(text);
    setParsed(p.messages);
    setRole(names.includes(self) ? self : names.includes("我") ? "我" : "");
    setImporting(true);
  }
  function confirmImport() {
    reportClientStep(`开始分析 role=${role || "(未选)"} 条数=${parsed.length}`);
    try {
      const names = [...new Set(parsed.map((x) => x.speaker))];
      setSelf(role);
      setOther(names.find((n) => n !== role) || "Crush");
      setImporting(false);
      add(toMessages(parsed, role));
    } catch (err) {
      reportProblem(
        `处理这段记录时出错：${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
  /**
   * 开始一段新对话。
   *
   * **不删除任何历史**：工作区会新建（或复用一段已有的空对话）并选中它。
   * 这样下一次粘贴写进新对话、刷新页面也停在新的空对话上，
   * 旧聊天既不会"自己跳回来"，也不会丢 —— 可以在「历史对话」里随时翻回去看。
   */
  async function clear() {
    a.reset();
    deep.reset();
    setMessages([]);
    setInput("");
    setSelf("");
    setOther("Crush");
    setNotice("");
    setSettings(false);
    setDetail(null);
    setDeepOpen(false);
    setProblem("");
    hydrated.current = "";
    try {
      await ws.startNewChat();
    } catch (err) {
      reportProblem(
        `没能开始新对话：${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  /**
   * 打开某一段历史对话：把本机存的消息与已保存的第一层结果拉回界面。
   *
   * 为什么不靠挂载 effect：那个 effect 在「界面已经有消息」时会直接跳过，
   * 那是为刷新恢复设计的；主动切换对话必须强制替换当前视图。
   */
  async function openHistory(conversationId: string) {
    setHistoryOpen(false);
    setProblem("");
    setInput("");
    setDetail(null);
    setDeepOpen(false);
    a.reset();
    deep.reset();
    setMessages([]);
    hydrated.current = conversationId;
    try {
      await ws.openConversation(conversationId);
      const stored = await ws.loadStored(conversationId);
      setMessages(stored.messages);
      a.hydrate(stored.lines);
      if (!stored.messages.length)
        reportProblem("这一段对话里还没有任何消息，粘贴新聊天就会写进这一段。");
    } catch (err) {
      hydrated.current = "";
      reportProblem(
        `打开这段历史失败：${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  /** 只删除单独一段历史对话（要确认；长期观察不受影响） */
  async function removeHistory(conversationId: string) {
    const row = ws.conversations.find((item) => item.id === conversationId);
    const index = row
      ? ws.conversations.length - ws.conversations.indexOf(row)
      : 0;
    const label = row ? conversationName(row, index) : "这一段对话";
    if (!window.confirm(`删除「${label}」？删除后无法恢复（长期观察不受影响）。`))
      return;
    try {
      await ws.deleteConversation(conversationId);
      if (conversationId === ws.conversationId) {
        setMessages([]);
        a.reset();
        deep.reset();
        hydrated.current = "";
      }
      await ws.refreshConversations();
    } catch (err) {
      reportProblem(
        `删除这段历史失败：${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  /** 给某一段历史对话改名（留空恢复自动命名，例如「第 2 段 · 09-21 17:19」） */
  async function renameHistory(conversationId: string, current: string) {
    const input = window.prompt(
      "给这段对话起个名字（留空则恢复自动命名，例如「第 2 段 · 09-21 17:19」）",
      current,
    );
    if (input === null) return;
    try {
      await ws.renameConversation(conversationId, input.trim());
      setNotice(input.trim() ? `已改名为「${input.trim()}」` : "已恢复自动命名");
    } catch (err) {
      reportProblem(
        `改名失败：${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  /** 改「对方称呼」（这个人显示在顶部与历史对话列表里，不碰聊天记录） */
  async function savePersonName() {
    const name = nameDraft.trim();
    if (!name) {
      reportProblem("称呼不能为空。");
      return;
    }
    if (ws.person && name === ws.person.displayName) {
      setSettings(false);
      return;
    }
    try {
      await ws.renamePerson(name);
      setOther(name);
      setSettings(false);
      setNotice(`已把对方称呼改成「${name}」`);
    } catch (err) {
      reportProblem(
        `改称呼失败：${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
  /** 点击证据时收起面板并定位到对应消息 */
  function locate(messageId: string) {
    setDeepOpen(false);
    setHighlight(messageId);
    requestAnimationFrame(() => {
      document
        .getElementById(`message-${messageId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    window.setTimeout(() => setHighlight(null), 2400);
  }
  const names = [...new Set(parsed.map((x) => x.speaker))];
  /**
   * 「开始分析」为什么点不了。
   *
   * 这个按钮在条件不满足时是 disabled 的，而 disabled 按钮点了不会有任何反应——
   * 之前界面上也没有任何文字说明，用户只会觉得「点了没反应」。
   * 这里把原因显式写出来，每条都给出可执行的下一步。
   */
  const disabledReason = !parsed.length
    ? "这段内容里没识别到聊天记录，检查一下粘贴的格式（昵称 → 时间 → 正文）。"
    : names.length > 2 || names.includes("未分配")
      ? `识别到 ${names.length} 个说话人，请先改成两个人的对话（我：… / 对方：…）。`
      : !role
        ? "请先在上面点一下：哪个昵称是你。"
        : role !== "__self_absent__" && !names.includes(role)
          ? "你选中的昵称不在这次粘贴的内容里，请重新选。"
          : "";
  const chosen = messages.find((m) => m.id === detail),
    result = detail ? a.lines[detail] : undefined;
  const deepUnavailable =
    deep.availability === "disabled"
      ? "深度解读尚未启用"
      : deep.availability === "not_configured"
        ? "深度解读尚未配置"
        : "";
  return (
    <main className="app">
      <div className="account-bar">
        <strong>本机版</strong>
        <span>·</span>
        <span>
          {ws.person
            ? `当前对象：${ws.person.displayName}`
            : "还没有导入过任何人"}
        </span>
        <span className="account-spacer" />
        {ws.people.length > 0 && (
          <select
            aria-label="切换对象"
            value={ws.personId ?? ""}
            onChange={(e) => {
              const id = e.target.value;
              if (id) void ws.selectPerson(id);
            }}
          >
            {!ws.personId && <option value="">选择对象…</option>}
            {ws.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        )}
        <button
          className="account-history"
          onClick={() => {
            setHistoryOpen(true);
            void ws.refreshConversations();
          }}
          title="查看这个人的全部历史对话（不会删除任何东西）"
        >
          历史对话
          {ws.conversations.length ? ` ${ws.conversations.length}` : ""}
        </button>
        <span className="account-local" title="数据只保存在这台电脑的浏览器里">
          数据仅本机
        </span>
      </div>

      {problem && (
        <div className="legacy-banner problem-banner" role="alert">
          <span>{problem}</span>
          <button className="text-button" onClick={() => setProblem("")}>
            知道了
          </button>
        </div>
      )}

      {ws.error && <div className="legacy-banner">{ws.error}</div>}

      {ws.legacy.status === "detected" && ws.legacy.summary && (
        <div className="legacy-banner">
          <span>
            检测到旧版本的浏览器本地长期数据（档案 {ws.legacy.summary.profiles} 份、
            记忆 {ws.legacy.summary.memories} 条、习惯 {ws.legacy.summary.habits} 条、
            模式 {ws.legacy.summary.patterns} 条、你确认过 {ws.legacy.summary.confirmations} 条）。
            这些数据本来就存在本机浏览器里，继续使用即可。
          </span>
          <div className="legacy-actions">
            <button onClick={() => void ws.legacy.migrate()}>
              继续使用这份数据
            </button>
            <button onClick={ws.legacy.dismiss}>不用了</button>
          </div>
        </div>
      )}
      {ws.legacy.status === "migrating" && (
        <div className="legacy-banner">正在检查旧数据…</div>
      )}
      {(ws.legacy.status === "done" || ws.legacy.status === "error") && (
        <div className="legacy-banner">
          <span>{ws.legacy.message}</span>
          <div className="legacy-actions">
            <button
              onClick={() =>
                setLongOpen(true)
              }
            >
              查看长期观察
            </button>
          </div>
        </div>
      )}

      <div className="workspace">
        <section className="wechat" aria-label="微信聊天">
          <nav className="chat-rail" aria-label="聊天工具">
            <div className="rail-avatar">
              {self && self !== "__self_absent__" ? self.slice(0, 1) : "我"}
            </div>
            <button
              className="rail-active"
              aria-label="滚动到最新聊天"
              onClick={() => {
                const el = bottom.current?.parentElement;
                el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              }}
            >
              <MessageCircle size={23} />
            </button>
            <button
              className="rail-settings"
              aria-label="聊天设置"
              onClick={() => {
                setNameDraft(ws.person?.displayName ?? other);
                setSettings(true);
              }}
            >
              <Settings2 size={22} />
            </button>
          </nav>
          <header className="chat-head">
            <div className="contact-title">
              <h2>{messages.length ? other : "微信聊天"}</h2>
              <span>{RELATIONS[relation]}</span>
            </div>
            <button
              className="header-affinity"
              onClick={() => setDetail("overview")}
              aria-label="查看好感度详情"
            >
              <span>好感度</span>
              <strong key={value} className="affinity-number">
                {value ?? "—"}
              </strong>
              {value != null && (
                <span className="affinity-hearts" aria-hidden="true">
                  <Heart className="affinity-heart heart-one" size={12} />
                  <Heart className="affinity-heart heart-two" size={9} />
                  <Heart className="affinity-heart heart-three" size={7} />
                </span>
              )}
              {delta != null && delta !== 0 && (
                <small>
                  {delta > 0 ? "+" : ""}
                  {delta}
                </small>
              )}
            </button>
            <div className="header-tools">
              <button
                className="icon"
                aria-label="新聊天"
                title="新聊天"
                onClick={() => setDetail("clear")}
              >
                <Plus size={20} />
              </button>
              <button
                className="icon"
                aria-label="更多聊天设置"
                onClick={() => {
                  setNameDraft(ws.person?.displayName ?? other);
                  setSettings(true);
                }}
              >
                <MoreHorizontal size={24} />
              </button>
            </div>
          </header>
          <div
            className="chat-scroll"
            onScroll={(e) => {
              const el = e.currentTarget;
              stay.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            }}
          >
            {!messages.length ? (
              <div className="empty">
                <h2>粘贴微信聊天记录</h2>
                <p>在微信里多选、复制，然后粘贴到下方</p>
                <button
                  className="text-button"
                  onClick={() => prepare(exampleText(0))}
                >
                  用一段示例试试 <ArrowUpRight size={16} />
                </button>
              </div>
            ) : (
              messages.map((m, i) => {
                const r = a.lines[m.id];

                return (
                  <div
                    key={m.id}
                    id={`message-${m.id}`}
                    className={`message ${m.sender}${highlight === m.id ? " highlighted" : ""}`}
                  >
                    {(i === 0 || m.timestamp !== messages[i - 1].timestamp) &&
                      m.timestamp && (
                        <div className="timestamp">
                          {m.timestamp.replace(/^\d{4}年/, "")}
                        </div>
                      )}
                    <div className="message-row">
                      <div
                        className={`avatar ${m.sender === "self" ? "mine" : ""}`}
                      >
                        {(m.sender === "self" ? self : other).slice(0, 1)}
                      </div>
                      <div className="message-content">
                        <div className="bubble">{m.text}</div>
                        {m.mediaKind && (
                          <div
                            className={`media-note ${m.kind === "text" ? "described" : ""}`}
                          >
                            <span className="media-chip">
                              {mediaNoun(m.mediaKind)}
                            </span>
                            {m.kind === "text"
                              ? "你补充的描述，会作为这条消息的内容告诉 AI"
                              : "没有补充内容，这条不会参与分析"}
                          </div>
                        )}
                        {m.kind === "text" && (
                          <div className={`message-tags ${m.sender}`}>
                            {m.sender === "other" ? (
                              <>
                                <div className="analysis-row emotion-row">
                                  <span className="analysis-row-label">
                                    情绪
                                  </span>
                                  {r?.emotions ? (
                                    topEmotions(r.emotions).map((emotion) => (
                                      <button
                                        key={emotion.key}
                                        className={`emotion-tag emotion-${emotion.key}`}
                                        onClick={() => setDetail(m.id)}
                                        aria-label={`${emotion.label} ${emotion.percent}，查看情绪分析：${m.text}`}
                                      >
                                        <span>{emotion.label}</span>
                                        <b>{emotion.percent}</b>
                                      </button>
                                    ))
                                  ) : (
                                    <button
                                      className="pending-tag"
                                      disabled={busy}
                                      onClick={() => a.run(messages, relation)}
                                    >
                                      {busy ? "分析中" : "分析情绪"}
                                    </button>
                                  )}
                                </div>
                                <div className="analysis-row intent-row">
                                  <span className="analysis-row-label">
                                    意图
                                  </span>
                                  {r?.intents ? (
                                    topIntents(r.intents).map((intent) => (
                                      <button
                                        key={intent.key}
                                        className="intent-tag"
                                        onClick={() => setDetail(m.id)}
                                        aria-label={`${intent.label} ${intent.percent}，查看意图分析：${m.text}`}
                                      >
                                        <span>{intent.label}</span>
                                        <b>{intent.percent}</b>
                                      </button>
                                    ))
                                  ) : (
                                    <button
                                      className="pending-tag"
                                      disabled={busy}
                                      onClick={() => a.run(messages, relation)}
                                    >
                                      {busy ? "分析中" : "分析意图"}
                                    </button>
                                  )}
                                </div>
                              </>
                            ) : r ? (
                              <button
                                className="reply-tag"
                                onClick={() => setDetail(m.id)}
                                aria-label={`查看回复评价：${m.text}`}
                              >
                                <span>回复评级：</span>
                                <b>
                                  {replyRating(r.score.value)?.label ??
                                    "待判断"}
                                </b>
                              </button>
                            ) : (
                              <button
                                className="pending-tag"
                                disabled={busy}
                                onClick={() => a.run(messages, relation)}
                              >
                                {busy ? "分析中" : "评价回复"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={bottom} />
          </div>
          <div className="chat-insights">
            <button
              className="reply-summary"
              onClick={() => setDetail("performance")}
            >
              <span>我的发挥</span>
              <strong>{replyRating(quality)?.label ?? "—"}</strong>
              {quality != null && <span>{quality}分</span>}
            </button>
            <span className="insight-divider" />
            <button
              className="action-summary"
              onClick={() => setDetail("action")}
            >
              <span>下一步</span>
              <strong>{ov ? ACTIONS[ov.action]?.label : "等你导入聊天"}</strong>
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="deep-entry">
            <button
              className="deep-trigger"
              disabled={
                !deep.canRun ||
                deep.status === "loading" ||
                deep.availability === "disabled" ||
                deep.availability === "not_configured"
              }
              onClick={() => {
                setDeepSeen(true);
                setDeepOpen(true);
                void deep.run();
              }}
            >
              <Sparkles size={15} />
              {deep.status === "loading" ? "正在解读…" : "深度解读"}
            </button>
            <span
              className={`deep-status${deep.status === "error" ? " error" : ""}`}
              role="status"
            >
              {deepUnavailable ||
                (deep.status === "error" ? deep.error : "")}
            </span>
            {!deepSeen && <DeepPrivacyNote />}
            <button
              className="deep-trigger lt-trigger"
              onClick={() => setLongOpen(true)}
              disabled={!messages.length}
            >
              <History size={15} />
              长期观察
              <span className="lt-trigger-status">{profileState.statusLabel}</span>
            </button>
          </div>
          <div className="composer">
            <textarea
              aria-label="粘贴微信聊天记录"
              placeholder={
                messages.length
                  ? "粘贴新的聊天，自动合并重复记录。粘贴后可以先修改内容，再点「分析聊天」"
                  : "在这里粘贴微信聊天记录。\n粘贴后不会立刻分析：可以先把手动转录的语音、错字改好，确认无误再点「分析聊天」"
              }
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (notice) setNotice("");
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
                  prepare(input);
              }}
            />
            <div className="composer-hint">
              <span>
                语音 / 图片 / 表情包可以直接在占位后面补内容：
                <code>[语音] 她说周末要加班</code>
                <code>[图片] 一只橘猫趴在键盘上</code>
                ——补了 AI 才知道是转述，不补就照旧跳过
              </span>
              {input.trim() && (
                <button
                  className="composer-clear"
                  onClick={() => {
                    setInput("");
                    setNotice("");
                  }}
                >
                  清空输入框
                </button>
              )}
            </div>
            <div className="composer-bottom">
              <div className="composer-feedback">
                <span role="status">{notice}</span>{" "}
                <div className="analysis-status" aria-live="polite">
                  {busy ? (
                    <>
                      <span className="working" />
                      正在分析 {a.progress.done}/{a.progress.total}
                      <button onClick={a.cancel}>停止</button>
                    </>
                  ) : a.status === "error" ? (
                    <>
                      <span>分析未完成</span>
                      <button onClick={() => a.run(messages, relation)}>
                        <RotateCcw size={14} />
                        重试
                      </button>
                    </>
                  ) : a.status === "complete" ? (
                    <span className="completed">
                      <Check size={14} />
                      分析完成
                      <button onClick={() => setDetail("overview")}>
                        娱乐参考
                      </button>
                    </span>
                  ) : messages.length ? (
                    <>
                      <span>分析已暂停</span>
                      <button onClick={() => a.run(messages, relation)}>
                        继续分析
                      </button>
                    </>
                  ) : null}
                </div>
                {a.error && <span className="error">{a.error}</span>}
              </div>
              <button
                className="send"
                disabled={!input.trim()}
                onClick={() => prepare(input)}
              >
                <Send size={15} />
                分析聊天
              </button>
            </div>
          </div>
        </section>
      </div>
      {importing && (
        <Modal title="确认聊天里的你" close={() => setImporting(false)}>
          <div className="role-options">
            {names
              .filter((n) => n !== "未分配")
              .map((n) => (
                <button
                  className={role === n ? "selected" : ""}
                  key={n}
                  onClick={() => setRole(n)}
                >
                  {n}
                </button>
              ))}
            {names.length === 1 && (
              <button
                className={role === "__self_absent__" ? "selected" : ""}
                onClick={() => setRole("__self_absent__")}
              >
                这些都是对方的话
              </button>
            )}
          </div>
          <label className="field">
            识别到 {parsed.length} 条聊天
            <textarea
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setParsed(parseChat(e.target.value).messages);
              }}
            />
          </label>
          {(names.length > 2 || names.includes("未分配")) && (
            <p className="error">
              请保留两个人的聊天，可改成「我：内容」「对方：内容」。
            </p>
          )}
          <button
            className="primary"
            disabled={Boolean(disabledReason)}
            onClick={confirmImport}
          >
            开始分析
          </button>
          {disabledReason ? (
            <p className="error">{disabledReason}</p>
          ) : (
            <p className="hint">
              确认后会先把这段记录存进这台电脑的浏览器里，然后开始逐句分析。
            </p>
          )}
        </Modal>
      )}
      {settings && (
        <Modal title="聊天设置" close={() => setSettings(false)}>
          <label className="field">
            对方称呼
            <input
              value={nameDraft}
              placeholder="例如：小满 / 老黑"
              maxLength={40}
              onChange={(e) => setNameDraft(e.target.value)}
            />
          </label>
          <button className="secondary" onClick={() => void savePersonName()}>
            保存称呼
          </button>
          <p className="hint">
            称呼会显示在顶部与「历史对话」里。改称呼不会影响已经存下来的聊天记录，
            也不会把长期档案拆成两份。
          </p>
          <label className="field">
            你们的关系
            <select
              value={relation}
              onChange={(e) => {
                const r = e.target.value as Relation;
                setRelation(r);
                if (messages.length) a.run(messages, r);
              }}
            >
              {Object.entries(RELATIONS).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary"
            disabled={!messages.length}
            onClick={() => {
              const ms = messages.map((m) => ({
                ...m,
                sender:
                  m.sender === "self" ? ("other" as const) : ("self" as const),
              }));
              setSelf(other);
              setOther(self === "__self_absent__" ? "我" : self);
              setMessages(ms);
              a.reset();
              a.run(ms, relation);
              setSettings(false);
            }}
          >
            交换双方身份
          </button>
          <button className="secondary danger" onClick={() => void clear()}>
            开始新对话（保留历史）
          </button>
          <p>
            聊天记录与长期档案都只存在这台电脑的浏览器里（localStorage），
            分析时才把这段聊天发给模型服务。「开始新对话」只是换一段新的记录，
            <strong>不会删除任何历史</strong>
            ——想看之前的，点顶部的「历史对话」。长期观察（基线、记忆、模式）照旧累积。
          </p>
        </Modal>
      )}
      {detail === "clear" && (
        <Modal title="开始新的聊天？" close={() => setDetail(null)}>
          <p>
            浏览器里显示的内容会清空，本机会新开一段记录。
            <strong>之前的历史都会保留</strong>
            ，随时可以在「历史对话」里翻回去看。
          </p>
          <button className="primary" onClick={() => void clear()}>
            开始新聊天
          </button>
          <button className="secondary" onClick={() => setDetail(null)}>
            保留当前聊天
          </button>
        </Modal>
      )}
      {historyOpen && (
        <Modal title="历史对话" close={() => setHistoryOpen(false)}>
          {ws.conversations.length === 0 ? (
            <p className="hint">
              还没有任何聊天记录。粘贴一段聊天、点「分析聊天」，就会开始第一段。
            </p>
          ) : (
            <div className="history-list">
              {ws.conversations.map((conversation, position) => {
                const current = conversation.id === ws.conversationId;
                // 列表按最近更新倒序，序号按"从最早到最新"给，符合直觉
                const index = ws.conversations.length - position;
                const name = conversationName(conversation, index);
                return (
                  <div
                    className={`history-row${current ? " current" : ""}`}
                    key={conversation.id}
                  >
                    <button
                      className="history-open"
                      onClick={() => void openHistory(conversation.id)}
                    >
                      <span className="history-name">
                        {name}
                        {current ? <em>当前</em> : null}
                      </span>
                      <span className="history-meta">
                        {typeof conversation.messageCount === "number"
                          ? `${conversation.messageCount} 条消息`
                          : "消息数未知"}
                        {conversation.lastMessageAt
                          ? ` · 最近一条 ${stampOf(conversation.lastMessageAt)}`
                          : ""}
                      </span>
                      <span className="history-preview">
                        {conversation.messageCount === 0
                          ? "（空对话，粘贴新聊天会写进这一段）"
                          : (conversation.preview ?? "（这段没有可显示的文字）")}
                      </span>
                    </button>
                    <div className="history-actions">
                      <button
                        className="history-rename"
                        title="给这段对话改名"
                        onClick={() =>
                          void renameHistory(conversation.id, conversation.title ?? "")
                        }
                      >
                        改名
                      </button>
                      <button
                        className="history-delete"
                        title="删除这一段（长期观察不受影响）"
                        onClick={() => void removeHistory(conversation.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="hint">
            按最近更新排序，点任意一段就能把当时的聊天和已经分析好的标签调回界面
            （不会重新调用模型、不消耗额度）。改名不会改变排序；只有「删除」会真的删掉那一段。
          </p>
        </Modal>
      )}
      {deepOpen && (
        <Modal title="深度解读" close={() => setDeepOpen(false)}>
          {deep.status === "loading" && (
            <p className="deep-loading">正在解读这段聊天…</p>
          )}
          {(deep.status === "disabled" || deep.availability === "disabled") && (
            <p>深度解读尚未启用。不影响上面的分析。</p>
          )}
          {(deep.status === "not_configured" ||
            deep.availability === "not_configured") && (
            <p>深度解读尚未配置。不影响上面的分析。</p>
          )}
          {deep.status === "error" && (
            <>
              <p className="error">{deep.error}</p>
              <button className="secondary" onClick={() => void deep.run()}>
                <RotateCcw size={14} />
                重试
              </button>
            </>
          )}
          {deep.status === "idle" && !deep.hasContent && <p>正在准备解读…</p>}
          {deep.hasContent && deep.result && (
            <DeepPanel
              isStale={deep.isStale}
              translation={deep.result.translation}
              messages={messages}
              onLocate={locate}
              contextKey={deep.key}
              feedback={feedback}
              onFeedback={(input) => {
                // 反馈只写本机 storage：它是未来校准数据，不上传任何地方
                const next = recordInterpretationFeedback({
                  // 反馈 id 走 randomId()：明文 HTTP + 局域网 IP 时
                  // crypto.randomUUID 并不存在，直接调会抛异常
                  id: randomId(),
                  contextKey: deep.key,
                  verdict: input.verdict,
                  reasons: input.reasons,
                  note: input.note,
                  now: new Date().toISOString(),
                });
                setFeedback(next);
              }}
            />
          )}
        </Modal>
      )}
      {longOpen && (
        <Modal title="长期观察" close={() => setLongOpen(false)}>
          <LongTermPanel
            state={profileState}
            analysis={deep.result?.analysis ?? null}
            contextKey={deep.key}
            historicalTrend={deep.result?.historicalTrend ?? history}
            bundle={deep.profileContext ?? deep.result?.profileContext ?? null}
            patterns={deep.request.patterns}
            messages={messages}
            candidates={profile?.inferenceCandidates ?? []}
            onConfirm={(input) =>
              void ws.confirm({
                contextKey: deep.key,
                verdict: input.verdict,
                confirmedParts: input.confirmedParts,
                analysis: deep.result?.analysis ?? null,
              })
            }
            onCorrect={(input) =>
              void ws.correct({
                contextKey: deep.key,
                content: input.content,
                contradictedIds: input.contradictedIds,
              })
            }
            suggestConflicts={(content) => ws.suggestConflicts(content)}
            onRemoveProfile={() => {
              void ws.removePerson();
              setLongOpen(false);
            }}
            onResetBaseline={() => void ws.resetBaseline()}
            onRemoveMemory={(id) => void ws.removeMemory(id)}
            onClearAll={() => {
              // 本机版：一次性清空长期数据与本机聊天记录（只删本应用自己的 key）
              a.reset();
              deep.reset();
              setMessages([]);
              void ws.clearAll();
              setLongOpen(false);
            }}
            onLocate={locate}
          />
        </Modal>
      )}
      {detail && detail !== "clear" && (
        <Modal
          title={
            detail === "overview"
              ? "好感度"
              : detail === "action"
                ? "下一步"
                : detail === "performance"
                  ? "我的发挥"
                  : chosen?.sender === "other"
                    ? "情绪与意图"
                    : "回复评价"
          }
          close={() => setDetail(null)}
        >
          {detail === "overview" ? (
            <>
              <p>
                0—100 是模型对这段聊天的好感信号评分，不是「对方喜欢你的概率」。
              </p>
              <p>
                有评分就展示数值。上下文少或表达模糊时，也保留数值供娱乐参考。
              </p>
              {ov && (
                <p>
                  本轮判断：{statusLabel(ov.affinity)}。模型确定度{" "}
                  {Math.round(ov.affinity.confidence * 100)}%。
                </p>
              )}
            </>
          ) : detail === "action" ? (
            <>
              <h3>{ov ? ACTIONS[ov.action]?.label : "等待聊天"}</h3>
              <p>{ov ? ACTIONS[ov.action]?.detail : "导入后生成建议。"}</p>
              {ov?.actionEvidenceId && (
                <blockquote>
                  {messages.find((m) => m.id === ov.actionEvidenceId)?.text}
                </blockquote>
              )}
            </>
          ) : detail === "performance" ? (
            <>
              <div className="detail-score">
                {quality ?? "—"}
                <span>/100</span>
              </div>
              <p>
                已完成分析的我方回复平均分。Jev
                根据发出时的前文评价表达质量，再按固定分数区间显示评级。
              </p>
              <div className="reply-guide">
                {REPLY_RATINGS.map((v) => (
                  <p key={v.label}>
                    <strong>
                      {v.label} · {v.range} 分
                    </strong>
                    ：{v.description}
                  </p>
                ))}
              </div>
            </>
          ) : (
            <>
              <blockquote>{chosen?.text}</blockquote>
              {chosen?.sender === "other" ? (
                <>
                  <h3>情绪</h3>
                  <div className="emotion-distribution">
                    {Object.entries(result?.emotions || {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([key, p]) => (
                        <div key={key}>
                          <span>
                            {EMOTIONS[key as keyof typeof EMOTIONS]?.label ||
                              key}
                          </span>
                          <div className="probability-track">
                            <i style={{ width: `${p * 100}%` }} />
                          </div>
                          <b>
                            {p > 0 && p < 0.005
                              ? "<1%"
                              : `${Math.round(p * 100)}%`}
                          </b>
                        </div>
                      ))}
                  </div>
                  <h3 className="intent-detail-heading">意图</h3>
                  <div className="intent-distribution">
                    {Object.entries(result?.intents || {})
                      .filter(([key, p]) => key in INTENTS && p > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([key, p]) => (
                        <div key={key} className="intent-detail-item">
                          <div>
                            <strong>
                              {INTENTS[key as keyof typeof INTENTS].label}
                            </strong>
                            <b>
                              {p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`}
                            </b>
                          </div>
                          <p>{INTENTS[key as keyof typeof INTENTS].criteria}</p>
                        </div>
                      ))}
                    {!result?.intents && <p>意图尚未分析。</p>}
                  </div>
                  <p>
                    两行分别展示主要情绪与主要沟通意图的候选解读，不代表测量真实内心。每行最多显示前三项，保留原始概率，不重新凑成
                    100%。
                  </p>
                </>
              ) : (
                <>
                  <h3 className="reply-verdict">
                    回复评级：
                    {replyRating(result?.score.value)?.label ?? "待判断"}
                  </h3>
                  <p>
                    {replyRating(result?.score.value)?.description ??
                      "当前语境不足以判断表达质量"}
                  </p>
                  <p>
                    回复评分 {result?.score.value ?? "—"} / 100 ·{" "}
                    {result && statusLabel(result.score)}
                  </p>
                </>
              )}
              <p>结合当前已导入的上下文判断，不代表对方真实想法。</p>
            </>
          )}
        </Modal>
      )}
      {overlap && (
        <Modal title="这段可能重复了" close={() => setOverlap(null)}>
          <p>相同内容也可能是新消息，请选择如何合并。</p>
          <button
            className="primary"
            onClick={() => {
              add(overlap, "skip");
              setOverlap(null);
            }}
          >
            跳过重合部分
          </button>
          <button
            className="secondary"
            onClick={() => {
              add(overlap, "append");
              setOverlap(null);
            }}
          >
            作为新消息追加
          </button>
        </Modal>
      )}
      {scope && (
        <Modal title="聊天有点长" close={() => setScope(null)}>
          <p>一次分析最多 120 条、24,000 字，保留最近一段继续。</p>
          <button
            className="primary"
            disabled={!recentScope(scope).length}
            onClick={() => {
              start(recentScope(scope));
              setScope(null);
            }}
          >
            分析最近的聊天
          </button>
        </Modal>
      )}
    </main>
  );
}
