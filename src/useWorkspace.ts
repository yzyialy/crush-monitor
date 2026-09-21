import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearLocalChat,
  clearLongTerm,
  conversationPreview,
  deleteChatConversation,
  deleteChatPerson,
  detectLegacyProfile,
  lastConversationFor,
  lastMessageAtOf,
  loadLegacySnapshot,
  loadProfiles,
  localChat,
  markLegacyMigrated,
  rememberConversation,
  resolveStorage,
  saveProfiles,
  sortConversations,
  type LegacySummary,
  type StorageLike,
} from "./storage";
import {
  buildConversationId,
  readProfile,
  removeProfile,
  withFeedbackStats,
  writeProfileOp,
} from "./local-ops";
import {
  commitConversationToProfile,
  confirmInProfile,
  correctInProfile,
  removeMemoryFromProfile,
  resetBaselineInProfile,
} from "../shared/profile-ops";
import {
  emptyProfile,
  findConflictingInferences,
  profileIdFor,
} from "../shared/profile";
import { contextFromRelation } from "../shared/types";
import type {
  ConfirmationVerdict,
  DeepAnalysis,
  LineResult,
  LongTermMemory,
  Message,
  Observation,
  PersonProfile,
  Relation,
} from "../shared/types";

/**
 * 本机工作区。
 *
 * 这一版把长期数据与聊天记录都放回浏览器（localStorage）：
 *   - 没有账号、没有 session、没有服务端数据库；
 *   - 服务端只剩 /api/analyze 与 /api/deep-analysis 两个纯计算接口，
 *     每次请求自带这次要分析的消息，服务端不读也不写任何持久化数据；
 *   - 因此没有乐观锁、没有 409：本机只有一个写入者。
 *
 * 但**接口形状**与第四阶段完全一致（同样的字段、同样的返回结构），
 * 所以 App.tsx 里所有 ws.* 调用点一行都不用改。
 */

export type LegacyStatus = "none" | "detected" | "migrating" | "done" | "error";

export type LegacyState = {
  status: LegacyStatus;
  summary: LegacySummary | null;
  message: string;
  migrate: () => Promise<void>;
  dismiss: () => void;
};

/** 结构上等同于原来的服务端 person 响应。 */
export type ApiPerson = {
  id: string;
  displayName: string;
  relationshipType: "crush" | "new" | "couple";
  relationshipContext: unknown;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  conversationCount?: number;
};

export type ApiConversation = {
  id: string;
  personId: string;
  title: string | null;
  source: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  /** 「历史对话」列表用的第一句摘要（截断 80 字） */
  preview?: string | null;
  /** 最后一条带时间的消息的时间 */
  lastMessageAt?: string | null;
};

export type Workspace = {
  ready: boolean;
  error: string;
  people: ApiPerson[];
  person: ApiPerson | null;
  personId: string | null;
  conversationId: string | null;
  conversations: ApiConversation[];
  profile: PersonProfile | null;
  /** 本机版没有多写入者，版本号恒为 0（保留字段以免改调用点） */
  version: number;
  /** 本机版不会发生写冲突，恒为空字符串 */
  conflict: string;
  selectPerson: (personId: string) => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  /** 把本地解析出的消息写进本机工作区，返回带本机 id 的消息 */
  ensureRemote: (messages: Message[], title?: string) => Promise<Message[] | null>;
  /** 把本机已保存的消息拉回来 */
  loadMessages: (conversationId?: string) => Promise<Message[]>;
  /** 拉回消息时一并取回已保存的第一层结果（不必重跑 Jev） */
  loadStored: (
    conversationId?: string,
  ) => Promise<{ messages: Message[]; lines: Record<string, LineResult> }>;
  /**
   * 把第一层结果写回本机存储。
   *
   * 不写的话，刷新页面或从「历史对话」打开某一段时，标签就没了 ——
   * 用户要么重新看一遍空白，要么再花一次额度重跑 Jev。
   */
  saveLines: (
    lines: Record<string, LineResult>,
    conversationId?: string,
  ) => Promise<void>;
  commit: (input: {
    observations: Observation[];
    analysis?: DeepAnalysis | null;
  }) => Promise<void>;
  confirm: (input: {
    contextKey: string;
    verdict: ConfirmationVerdict;
    confirmedParts: string[];
    analysis?: DeepAnalysis | null;
  }) => Promise<void>;
  correct: (input: {
    contextKey: string | null;
    content: string;
    contradictedIds: string[];
  }) => Promise<void>;
  suggestConflicts: (content: string) => LongTermMemory[];
  removeMemory: (memoryId: string) => Promise<void>;
  resetBaseline: () => Promise<void>;
  /** 清空全部长期数据 + 本机聊天记录（只删本应用自己的 key） */
  clearAll: () => Promise<void>;
  removePerson: () => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  /**
   * 开始一段新对话（**历史全部保留**，可随时在「历史对话」里翻回去看）。
   *
   * 语义：找一段已有的空对话复用，没有就新建一段空对话并选中它。
   * 不删任何东西 —— 以前「清空聊天」只清界面状态、conversationId 还指着旧对话，
   * 下一次导入会追加到旧对话里，用户看到「清空后旧聊天又回来了」；而改成删对话
   * 又会把历史毁掉。用户明确要求：不许删历史。
   */
  startNewChat: () => Promise<void>;
  /** 打开某一段历史对话（消息与已保存的第一层标签由调用方 loadStored 拉回界面） */
  openConversation: (conversationId: string) => Promise<void>;
  /** 重新读一遍这个人的对话列表（历史对话面板用） */
  refreshConversations: () => Promise<void>;
  /** 给某一段对话改名（空字符串 = 恢复自动命名；**不改变排序**） */
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  /** 改「对方称呼」：只改显示名，不动任何聊天记录，也不换档案 id */
  renamePerson: (displayName: string) => Promise<void>;
  refresh: () => Promise<void>;
  legacy: LegacyState;
};

/** 前端 Message → 本机导入载荷。 */
function toImportPayload(messages: Message[]) {
  return messages
    // 没有补充内容的媒体消息没有正文，不入库（它们本来就不参与分析）
    .filter((m) => m.kind === "text" && m.text.trim())
    .map((m) => ({
      sender: m.sender,
      content: m.text,
      sentAt: m.timestamp,
      mediaKind: m.mediaKind ?? null,
    }));
}

/** 本机消息 → 前端 Message。 */
function toLocalMessage(row: {
  id: string;
  sender: "self" | "other";
  content: string;
  sentAt: string | null;
  mediaKind: string | null;
}): Message {
  return {
    id: row.id,
    sender: row.sender,
    text: row.content,
    timestamp: row.sentAt,
    kind: "text",
    ...(row.mediaKind
      ? { mediaKind: row.mediaKind as Message["mediaKind"] }
      : {}),
  };
}

const RELATION_TYPES = ["crush", "new", "couple"] as const;

/** 档案 → UI 需要的人；关系类型取自档案里的关系上下文。 */
function personFromProfile(profile: PersonProfile): ApiPerson {
  const type = profile.relationshipContext.type;
  return {
    id: profile.id,
    displayName: profile.displayName ?? "对方",
    relationshipType: (RELATION_TYPES as readonly string[]).includes(type)
      ? (type as ApiPerson["relationshipType"])
      : "crush",
    relationshipContext: profile.relationshipContext,
    archived: false,
    createdAt: new Date(profile.createdAt).toISOString(),
    updatedAt: new Date(profile.updatedAt).toISOString(),
  };
}

/** 由称呼与关系推出稳定的档案 id（与第三 / 第四阶段同一套规则）。 */
export function scopeIdFor(displayName: string, relation: Relation): string {
  return profileIdFor({ displayName: displayName || "对方", relation });
}

export function useWorkspace(input: {
  displayName: string;
  relation: Relation;
  /** 有存档时优先打开的那一段 */
  onError?: (message: string) => void;
}): Workspace {
  const storage: StorageLike | undefined = useMemo(
    () => resolveStorage() ?? undefined,
    [],
  );

  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [people, setPeople] = useState<ApiPerson[]>([]);
  const [person, setPerson] = useState<ApiPerson | null>(null);
  const [conversations, setConversations] = useState<ApiConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [profile, setProfile] = useState<PersonProfile | null>(null);

  const personRef = useRef<string | null>(null);
  const conversationRef = useRef<string | null>(null);
  personRef.current = person?.id ?? null;
  conversationRef.current = conversationId;

  const inputRef = useRef(input);
  inputRef.current = input;

  const [legacy, setLegacy] = useState<{
    status: LegacyStatus;
    summary: LegacyState["summary"];
    message: string;
  }>({ status: "none", summary: null, message: "" });

  /** 档案里的反馈统计由本机数据重算：confirmations / corrections / 解读反馈。 */
  const stats = useCallback(
    (next: PersonProfile) => withFeedbackStats(next, storage),
    [storage],
  );

  const profileOf = useCallback(
    (personId: string): PersonProfile | null => readProfile(personId, storage),
    [storage],
  );

  /**
   * 一份对话列表 → UI 用的形状（与第四阶段服务端的 `conversationToApi` 同字段）。
   *
   * 顺序按最近更新倒序，字段补齐 `messageCount` / `preview` / `lastMessageAt`：
   * 「历史对话」面板正是拿这些渲染的，缺了它们每一段都只会显示成
   * 「0 条消息 · 空对话」，看起来像"名字都一样"（服务端也踩过同一个坑）。
   */
  const conversationsOf = useCallback(
    (personId: string): ApiConversation[] =>
      sortConversations(localChat.conversations(personId, storage)).map((c) => ({
        id: c.id,
        personId,
        title: c.title,
        source: "local",
        archived: false,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
        preview: conversationPreview(c.messages),
        lastMessageAt: lastMessageAtOf(c.messages),
      })),
    [storage],
  );

  /** 打开某个人：档案 + 对话列表 + 上次打开的那一段。 */
  const selectPerson = useCallback(
    async (personId: string) => {
      const found = profileOf(personId);
      setPerson(found ? personFromProfile(found) : null);
      setProfile(found);
      const list = conversationsOf(personId);
      setConversations(list);
      const last = lastConversationFor(personId, storage);
      const target = list.find((c) => c.id === last) ?? list[0] ?? null;
      setConversationId(target?.id ?? null);
    },
    [conversationsOf, profileOf, storage],
  );

  const refresh = useCallback(async () => {
    const list = loadProfiles(storage).map(personFromProfile);
    setPeople(list);
    const currentId = personRef.current;
    if (!currentId) return;
    const current = list.find((p) => p.id === currentId) ?? null;
    setPerson(current);
    if (current) {
      setProfile(profileOf(current.id));
      setConversations(conversationsOf(current.id));
    }
  }, [conversationsOf, profileOf, storage]);

  // 初次加载：打开已有的最近一个人（本机版没有账号，所以也没有登录这一步）
  useEffect(() => {
    let alive = true;
    try {
      const profiles = loadProfiles(storage);
      const list = profiles.map(personFromProfile);
      setPeople(list);
      const preferred =
        list.find((p) => p.displayName === inputRef.current.displayName) ??
        list[0] ??
        null;
      if (preferred) {
        setPerson(preferred);
        setProfile(readProfile(preferred.id, storage));
        const convs = conversationsOf(preferred.id);
        setConversations(convs);
        const last = lastConversationFor(preferred.id, storage);
        const target = convs.find((c) => c.id === last) ?? convs[0] ?? null;
        setConversationId(target?.id ?? null);
      }
    } catch (err) {
      if (alive) setError(err instanceof Error ? err.message : "加载本机数据失败");
    } finally {
      if (alive) setReady(true);
    }
    return () => {
      alive = false;
    };
    // 只在挂载时跑一次：切换 person 由 selectPerson 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 旧版本浏览器本地数据检测（什么都不做也不会丢，只是提示一下）
  useEffect(() => {
    const snapshot = detectLegacyProfile(storage);
    if (snapshot)
      setLegacy({
        status: "detected",
        summary: snapshot.summary,
        message: "",
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 把本地解析出的消息写进本机工作区，返回带本机 id 的消息。
   *
   * **失败必须说出来**：以前这里失败就 `return null`（连"localStorage 写不进去"
   * 都直接吞掉），界面只在角落显示一行小字，用户看到的就是「点了没反应」。
   * 现在这里抛出带原因的 Error，由 `App.tsx` 的 `start()` 捕获后放到页面顶部红条上。
   */
  const ensureRemote = useCallback(
    async (messages: Message[], title?: string): Promise<Message[] | null> => {
      const payload = toImportPayload(messages);
      if (!payload.length) {
        const message =
          "这段聊天里没有可分析的文字消息（语音 / 图片 / 表情包需要在占位符后面补一句描述）";
        setError(message);
        throw new Error(message);
      }
      try {
        const at = new Date().toISOString();
        const displayName = inputRef.current.displayName || "对方";
        const relation = inputRef.current.relation;
        const personId = personRef.current ?? scopeIdFor(displayName, relation);

        // 1) 确保"人"存在（档案 + 工作区条目）；档案只在导入时按需创建
        const existing = loadProfiles(storage);
        const found = existing.find((p) => p.id === personId);
        if (!found) {
          const ok = saveProfiles(
            [
              ...existing,
              emptyProfile({
                id: personId,
                displayName,
                relationshipContext: contextFromRelation(relation),
                at: Date.parse(at),
              }),
            ],
            storage,
          );
          if (!ok) throw new Error("保存本机档案失败：本机存储不可写（可能已满或被浏览器禁用）");
        } else if (found.displayName !== displayName) {
          const ok = saveProfiles(
            existing.map((p) => (p.id === personId ? { ...p, displayName } : p)),
            storage,
          );
          if (!ok) throw new Error("更新本机档案失败：本机存储不可写（可能已满或被浏览器禁用）");
        }
        localChat.ensurePerson(
          { id: personId, displayName, relationshipType: relation, at },
          storage,
        );

        // 2) 写入消息（幂等：同一批重复导入不会重复入库）
        // 对话 id 由「人 + 关系 + 双方称呼」推出，刷新页面后回到同一段，
        // 基线也不会被重复累计（commitConversationToProfile 靠它判断幂等）。
        const target =
          conversationRef.current ??
          buildConversationId({ personId, relation });
        /**
         * 刻意**不**自动往 `conversation.title` 里写「第一句摘要」：
         * `title` 的唯一含义是「用户自己起的名字」，默认名字由界面现场算
         * （`第 N 段 · 时间 · 第一句`，见 `src/App.tsx` 的 `conversationName`）。
         * 自动写进去会让同一段聊天重复粘贴时看起来"名字都一样"。
         */
        const report = localChat.appendMessages(
          {
            personId,
            conversationId: target,
            messages: payload,
            at,
            title: title ?? null,
          },
          storage,
        );
        const id = report.conversationId;
        rememberConversation(personId, id, storage);

        // 3) 用本机数据重建 UI 状态（导入本身不触发任何模型调用）
        setConversationId(id);
        const nextProfile = profileOf(personId);
        if (nextProfile) {
          setPerson(personFromProfile(nextProfile));
          setProfile(nextProfile);
        }
        setConversations(conversationsOf(personId));
        setPeople(loadProfiles(storage).map(personFromProfile));
        setError("");
        const stored = localChat.conversation(personId, id, storage)?.messages ?? [];
        return stored.map(toLocalMessage);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "保存到本机失败（原因未知）";
        setError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [conversationsOf, profileOf, storage],
  );

  const loadMessages = useCallback(
    async (target?: string) => {
      const id = target ?? conversationRef.current;
      const personId = personRef.current;
      if (!id || !personId) return [];
      const conversation = localChat.conversation(personId, id, storage);
      return (conversation?.messages ?? []).map(toLocalMessage);
    },
    [storage],
  );

  /**
   * 拉回消息 + 已保存的第一层结果。
   * 只读操作：不会触发任何模型调用，也不会写任何存储。
   */
  const loadStored = useCallback(
    async (target?: string) => {
      const id = target ?? conversationRef.current;
      const personId = personRef.current;
      if (!id || !personId) return { messages: [], lines: {} };
      const conversation = localChat.conversation(personId, id, storage);
      const lines: Record<string, LineResult> = {};
      for (const row of conversation?.messages ?? []) {
        const line = (row as { line?: LineResult }).line;
        if (line && typeof line.id === "string") lines[line.id] = line;
      }
      return {
        messages: (conversation?.messages ?? []).map(toLocalMessage),
        lines,
      };
    },
    [storage],
  );

  /**
   * 把第一层结果写回本机存储（幂等：同一份结果重复写不会真的写盘）。
   * 失败时说出来，但不打断分析 —— 标签丢了顶多下次重跑，不能因此中断。
   */
  const saveLines = useCallback(
    async (lines: Record<string, LineResult>, target?: string) => {
      const personId = personRef.current;
      const conversationId = target ?? conversationRef.current;
      if (!personId || !conversationId) return;
      if (!Object.keys(lines).length) return;
      try {
        localChat.saveLines({ personId, conversationId, lines }, storage);
      } catch (err) {
        setError(
          err instanceof Error
            ? `${err.message}（本次的标签没能存下来，刷新后会消失）`
            : "标签没能存到本机",
        );
      }
    },
    [storage],
  );

  /** 统一的档案写入：读 → 纯函数 → 写回 → 重算反馈统计。
   *
   * 写失败（配额满 / localStorage 被禁用）必须让调用方知道：这里既把原因写进
   * `error`，也把异常继续抛出去，界面顶部的红条与全局 unhandledrejection 兜底
   * 都能接到它 —— 用户确认的长期结论不能悄悄丢。
   */
  const runOp = useCallback(
    (mutate: (current: PersonProfile) => PersonProfile) => {
      const personId = personRef.current;
      if (!personId) return;
      try {
        const next = writeProfileOp(storage, personId, Date.now(), mutate);
        if (!next) return;
        setProfile(next);
        setError("");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "保存档案失败（原因未知）";
        setError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [storage],
  );

  const commit = useCallback(
    async (opts: {
      observations: Observation[];
      analysis?: DeepAnalysis | null;
    }) => {
      const target = conversationRef.current;
      const personId = personRef.current;
      if (!target || !personId) return;
      const conversation = localChat.conversation(personId, target, storage);
      if (!conversation) return;
      const messages = conversation.messages.map(toLocalMessage);
      const now = new Date().toISOString();
      const at = Date.now();
      runOp((current) =>
        commitConversationToProfile(current, {
          conversationId: target,
          messages,
          observations: opts.observations,
          analysis: opts.analysis ?? null,
          now,
          at,
        }),
      );
    },
    [runOp, storage],
  );

  const confirm = useCallback(
    async (opts: {
      contextKey: string;
      verdict: ConfirmationVerdict;
      confirmedParts: string[];
      analysis?: DeepAnalysis | null;
    }) => {
      const now = new Date().toISOString();
      const at = Date.now();
      runOp((current) =>
        confirmInProfile(current, {
          contextKey: opts.contextKey,
          verdict: opts.verdict,
          confirmedParts: opts.confirmedParts,
          analysis: opts.analysis ?? null,
          now,
          at,
        }),
      );
    },
    [runOp],
  );

  const correct = useCallback(
    async (opts: {
      contextKey: string | null;
      content: string;
      contradictedIds: string[];
    }) => {
      const now = new Date().toISOString();
      const at = Date.now();
      runOp((current) =>
        correctInProfile(current, {
          contextKey: opts.contextKey,
          content: opts.content,
          contradictedIds: opts.contradictedIds,
          now,
          at,
        }),
      );
    },
    [runOp],
  );

  const suggestConflicts = useCallback(
    (content: string) =>
      profile ? findConflictingInferences(profile.memories, content) : [],
    [profile],
  );

  const removeMemory = useCallback(
    async (memoryId: string) => {
      const at = Date.now();
      runOp((current) => removeMemoryFromProfile(current, memoryId, at));
    },
    [runOp],
  );

  const resetBaseline = useCallback(async () => {
    const at = Date.now();
    runOp((current) => resetBaselineInProfile(current, at));
  }, [runOp]);

  /**
   * 清空全部长期数据（档案 / 基线 / 记忆 / 模式 / 反馈）与本机聊天记录。
   * 只删本应用自己写的 key；页面里正在显示的内容由 UI 自己清。
   */
  const clearAll = useCallback(async () => {
    clearLongTerm(storage);
    clearLocalChat(storage);
    setProfile(null);
    setPerson(null);
    setConversationId(null);
    setConversations([]);
    setPeople([]);
    setError("");
  }, [storage]);

  const removePerson = useCallback(async () => {
    const personId = personRef.current;
    if (!personId) return;
    // 档案与聊天记录是两套存储，删除时两套都要清
    removeProfile(personId, storage);
    deleteChatPerson(personId, storage);
    setPerson(null);
    setConversationId(null);
    setProfile(null);
    setConversations([]);
    const list = loadProfiles(storage).map(personFromProfile);
    setPeople(list);
    const next = list[0];
    if (next) await selectPerson(next.id);
  }, [selectPerson, storage]);

  const deleteConversation = useCallback(
    async (target: string) => {
      const personId = personRef.current;
      if (!personId) return;
      deleteChatConversation(personId, target, storage);
      const list = conversationsOf(personId);
      setConversations(list);
      setConversationId(list[0]?.id ?? null);
      const next = list[0];
      if (next) rememberConversation(personId, next.id, storage);
    },
    [conversationsOf, storage],
  );

  /**
   * 开始一段新对话（**不删除任何历史**）。
   *
   * 做法：复用一段已有的空对话，没有就新建一段空的并选中它。
   *   - 下一次粘贴写进这段新对话，不再追加到旧对话里；
   *   - 新对话的 `updatedAt` 最新，刷新页面时正好又落回它上面，
   *     所以旧聊天不会"自己跳回来"；
   *   - 旧对话原样留在 localStorage 里，随时可以在「历史对话」里翻回去看。
   */
  const startNewChat = useCallback(async () => {
    const personId = personRef.current;
    if (!personId) {
      setConversationId(null);
      setError("");
      return;
    }
    try {
      const at = new Date().toISOString();
      const empty = localChat.emptyConversation(personId, storage);
      const target =
        empty ?? localChat.createConversation({ personId, at }, storage);
      if (!target) throw new Error("新建对话失败：这个对象不在本机工作区里");
      rememberConversation(personId, target.id, storage);
      setConversations(conversationsOf(personId));
      setConversationId(target.id);
      setError("");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "开始新对话失败（原因未知）";
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, [conversationsOf, storage]);

  /** 打开某一段历史对话（消息与第一层结果由调用方 loadStored 拉回界面）。 */
  const openConversation = useCallback(
    async (target: string) => {
      setError("");
      setConversationId(target);
      const personId = personRef.current;
      if (personId) rememberConversation(personId, target, storage);
    },
    [storage],
  );

  /** 重新读一遍这个人的对话列表（历史对话面板用） */
  const refreshConversations = useCallback(async () => {
    const personId = personRef.current;
    if (!personId) return;
    setConversations(conversationsOf(personId));
  }, [conversationsOf]);

  /**
   * 给某一段对话改名（空字符串 = 恢复自动命名）。
   *
   * 改名**不改变排序**：本地存储里刻意不写 `updatedAt`，
   * 否则改个名字就把这段顶到列表最前面，用户会以为"顺序乱了"
   * （服务端为此修过一次无条件写 updated_at 的 bug）。
   */
  const renameConversation = useCallback(
    async (target: string, title: string) => {
      const personId = personRef.current;
      if (!personId) return;
      localChat.renameConversation(personId, target, title, storage);
      setConversations(conversationsOf(personId));
    },
    [conversationsOf, storage],
  );

  /**
   * 改「对方称呼」。
   *
   * 只改显示名：档案的 id 由「称呼 + 关系」推导，但已经有了 id 的人不会再重算，
   * 所以改名不会把长期档案拆成两份；聊天记录一条都不动。
   */
  const renamePerson = useCallback(
    async (displayName: string) => {
      const personId = personRef.current;
      if (!personId) return;
      const clean = displayName.trim();
      if (!clean) throw new Error("称呼不能为空");
      const at = new Date().toISOString();
      const profiles = loadProfiles(storage);
      const found = profiles.find((p) => p.id === personId);
      if (found) {
        const ok = saveProfiles(
          profiles.map((p) =>
            p.id === personId
              ? { ...p, displayName: clean, updatedAt: Date.parse(at) }
              : p,
          ),
          storage,
        );
        if (!ok)
          throw new Error("保存称呼失败：本机存储不可写（可能已满或被浏览器禁用）");
      }
      localChat.renamePerson(personId, clean, at, storage);
      const next = readProfile(personId, storage);
      if (next) setProfile(next);
      const list = loadProfiles(storage).map(personFromProfile);
      setPeople(list);
      setPerson(list.find((p) => p.id === personId) ?? null);
      setConversations(conversationsOf(personId));
    },
    [conversationsOf, storage],
  );

  /**
   * 旧版本浏览器数据的确认流程。
   *
   * 本机版里长期档案本来就住在浏览器里，所以这里不再"上传"，
   * 只是把检测到的旧档案重新按当前结构读一遍并确认它仍然有效。
   * 不触发任何模型调用。
   */
  const migrateLegacy = useCallback(async () => {
    setLegacy((old) => ({ ...old, status: "migrating", message: "" }));
    try {
      const snapshot = loadLegacySnapshot(storage);
      if (!snapshot) {
        setLegacy({ status: "none", summary: null, message: "" });
        return;
      }
      const profiles = loadProfiles(storage);
      const report = snapshot.profiles.map(
        (entry) =>
          `已保留「${entry.displayName ?? entry.id}」：记忆 ${entry.memories.length} 条、` +
          `习惯 ${entry.habits.length} 条、模式 ${entry.knownPatterns.length} 条`,
      );
      markLegacyMigrated(storage);
      setPeople(profiles.map(personFromProfile));
      setLegacy({
        status: "done",
        summary: snapshot.summary,
        message: report.join("；") || "没有需要处理的内容",
      });
    } catch (err) {
      setLegacy({
        status: "error",
        summary: null,
        message: err instanceof Error ? err.message : "处理旧数据失败",
      });
    }
  }, [storage]);

  const dismissLegacy = useCallback(() => {
    markLegacyMigrated(storage);
    setLegacy({ status: "none", summary: null, message: "" });
  }, [storage]);

  const legacyState = useMemo<LegacyState>(
    () => ({
      ...legacy,
      migrate: migrateLegacy,
      dismiss: dismissLegacy,
    }),
    [legacy, migrateLegacy, dismissLegacy],
  );

  return {
    ready,
    error,
    people,
    person,
    personId: person?.id ?? null,
    conversationId,
    conversations,
    profile,
    version: 0,
    conflict: "",
    selectPerson,
    selectConversation: async (target: string) => {
      setConversationId(target);
      const personId = personRef.current;
      if (personId) rememberConversation(personId, target, storage);
    },
    ensureRemote,
    loadMessages,
    loadStored,
    saveLines,
    commit,
    confirm,
    correct,
    suggestConflicts,
    removeMemory,
    resetBaseline,
    clearAll,
    removePerson,
    deleteConversation,
    startNewChat,
    openConversation,
    refreshConversations,
    renameConversation,
    renamePerson,
    refresh,
    legacy: legacyState,
  };
}

/** 清空本机版的聊天记录（供"清空聊天"使用，不影响长期档案）。 */
export function clearWorkspaceChat(storage?: StorageLike): void {
  clearLocalChat(storage);
}

export {
  commitConversationToProfile,
  confirmInProfile,
  correctInProfile,
  removeMemoryFromProfile,
  resetBaselineInProfile,
};
