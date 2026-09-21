import { useRef, useState } from "react";
import { sha256Hex } from "../shared/hash";
import {
  contextKey,
  meanQuality,
  type Message,
  type Relation,
  type Snapshot,
  type Overview,
  type LineResult,
  type AnalysisResponse,
  type AnalysisRequest,
} from "../shared/types";
export function useAnalysis() {
  const [overview, setOverview] = useState<Overview | null>(null),
    [overviewFresh, setOverviewFresh] = useState(false),
    [lines, setLines] = useState<Record<string, LineResult>>({}),
    [status, setStatus] = useState<"idle" | "loading" | "complete" | "error">(
      "idle",
    ),
    [error, setError] = useState(""),
    [history, setHistory] = useState<Snapshot[]>([]),
    [progress, setProgress] = useState({ done: 0, total: 0 }),
    [latency, setLatency] = useState(0),
    [currentIds, setCurrentIds] = useState<Set<string>>(new Set());
  const rev = useRef(0),
    controller = useRef<AbortController | null>(null),
    cache = useRef(new Map<string, AnalysisResponse>()),
    historyRef = useRef<Snapshot[]>([]);
  function cancel() {
    rev.current++;
    controller.current?.abort();
    setStatus("idle");
  }
  function reset() {
    cancel();
    cache.current.clear();
    historyRef.current = [];
    setHistory([]);
    setOverview(null);
    setOverviewFresh(false);
    setLines({});
    setError("");
    setLatency(0);
    setCurrentIds(new Set());
  }
  function showFixture(s: Snapshot) {
    cancel();
    setOverview(s.overview);
    setOverviewFresh(true);
    setLines(s.lines);
    setStatus("complete");
    setError("");
    setLatency(0);
    setCurrentIds(new Set(s.messages.map((m) => m.id)));
  }
  async function run(
    messages: Message[],
    relation: Relation,
    conversationId?: string | null,
  ) {
    const revision = ++rev.current;
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const start = performance.now();
    setStatus("loading");
    setOverviewFresh(false);
    setError("");
    setCurrentIds(new Set());
    let nextOverview: Overview | null = null;
    const nextLines: Record<string, LineResult> = {};
    let failures = 0;
    let done = 0;
    const task = (
      task: AnalysisRequest["task"],
      targetIds: string[],
      ms = messages,
    ): AnalysisRequest => ({
      revision,
      relation,
      messages: ms,
      task,
      targetIds,
      // 服务端会优先用这个 id 从 SQLite 读消息
      conversationId: conversationId ?? null,
    });
    const others = messages.filter(
      (m) => m.sender === "other" && m.kind === "text",
    );
    const batches: AnalysisRequest[] = [];
    for (let i = others.length; i > 0; i -= 20)
      batches.push(
        task(
          "other_messages",
          others.slice(Math.max(0, i - 20), i).map((m) => m.id),
        ),
      );
    const self = messages.flatMap((m, i) =>
      m.sender === "self" && m.kind === "text"
        ? [task("self_message", [m.id], messages.slice(0, i + 1))]
        : [],
    );
    const jobs = [
      task("overview", []),
      ...batches.slice(0, 1),
      ...self.reverse(),
      ...batches.slice(1),
    ];
    setProgress({ done: 0, total: jobs.length });
    async function execute(job: AnalysisRequest) {
      const key =
        contextKey(job.messages, relation) + job.task + job.targetIds.join(",");
      let result = cache.current.get(key);
      if (!result) {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // 服务端的 CSRF 防护：非 GET 请求要么带这个头，要么同源 Origin
            "X-Requested-With": "crush-monitor",
          },
          body: JSON.stringify(job),
          signal: ctrl.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "分析失败");
        result = data as AnalysisResponse;
        if (result.revision !== revision)
          throw new Error("分析批次不匹配，请重试");
        /**
         * 上下文哈希必须与 node:crypto 算出来的一致，所以走 shared/hash.ts。
         *
         * 踩过的坑：这里原来直接调 `crypto.subtle.digest`。`crypto.subtle`
         * 只在安全上下文（HTTPS 或 localhost）里存在，用明文 HTTP + 局域网 IP
         * 打开时它是 `undefined` —— 整条分析链路会在这里抛异常，
         * 表现就是「点了开始分析没反应」。现在拿不到 subtle 会自动退回纯 JS 实现。
         */
        const hash = await sha256Hex(contextKey(job.messages, relation));
        if (result.contextHash !== hash)
          throw new Error("分析上下文不匹配，请重试");
        if (rev.current !== revision) return;
        cache.current.set(key, result);
      }
      if (rev.current !== revision) return;
      if (result.overview) {
        nextOverview = result.overview;
        setOverview(result.overview);
        setOverviewFresh(true);
        setLatency(Math.round(performance.now() - start));
      }
      for (const line of result.lines || []) {
        nextLines[line.id] = line;
      }
      setLines((old) => ({ ...old, ...nextLines }));
      setCurrentIds(new Set(Object.keys(nextLines)));
    }
    async function worker() {
      while (jobs.length && rev.current === revision) {
        const job = jobs.shift()!;
        try {
          await execute(job);
        } catch (e) {
          if (ctrl.signal.aborted) return;
          failures++;
          setError((e as Error).message);
        } finally {
          if (rev.current === revision)
            setProgress((p) => ({ ...p, done: ++done }));
        }
      }
    }
    await Promise.all([worker(), worker()]);
    if (rev.current !== revision) return;
    setLines(nextLines);
    setCurrentIds(new Set(Object.keys(nextLines)));
    setStatus(failures ? "error" : "complete");
    if (nextOverview && !failures) {
      const previous = historyRef.current.at(-1);
      const s: Snapshot = {
        revision,
        messages: structuredClone(messages),
        relation,
        lines: nextLines,
        overview: nextOverview,
        at: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - start),
        source: "live",
        comparable:
          !!previous &&
          previous.relation === relation &&
          previous.messages.every(
            (m, i) =>
              messages[i]?.id === m.id &&
              messages[i]?.text === m.text &&
              messages[i]?.sender === m.sender,
          ),
      };
      const same =
        previous &&
        contextKey(previous.messages, previous.relation) ===
          contextKey(messages, relation);
      historyRef.current = same
        ? [...historyRef.current.slice(0, -1), s]
        : [...historyRef.current, s];
      setHistory(historyRef.current);
    }
  }
  /**
   * 把服务端已经存下来的第一层结果灌回界面。
   *
   * 第四阶段之后聊天记录与分析结果都在服务器上，换设备或刷新页面时
   * 不需要重新调用 Jev 就能看到之前的情绪/意图标签。
   * 它只做合并，不触发任何请求。
   */
  function hydrate(next: Record<string, LineResult>) {
    if (!Object.keys(next).length) return;
    setLines((old) => ({ ...old, ...next }));
  }

  return {
    overview,
    overviewFresh,
    lines,
    status,
    error,
    hydrate,
    clearError: () => setError(""),
    history,
    progress,
    latency,
    currentIds,
    run,
    reset,
    cancel,
    showFixture,
    meanQuality,
  };
}
