import {
  deleteProfile,
  loadInterpretationFeedback,
  loadProfiles,
  LocalStorageError,
  resolveStorage,
  saveProfiles,
  shortHash,
  type StorageLike,
} from "./storage";
import { applyFeedbackStats } from "../shared/profile-ops";
import type { PersonProfile, Relation } from "../shared/types";

/**
 * 本机工作区的**无 React 编排层**。
 *
 * `useWorkspace` 只是它的一层 React 包装：状态、副作用、渲染都在 hook 里，
 * 「读档案 → 跑 shared/profile-ops 的纯函数 → 写回浏览器」这条编排放在这里，
 * 这样它可以被测试直接驱动（不用渲染任何组件），也不会出现两套口径。
 *
 * 硬约束（与第四阶段一致）：
 *   - 只有 shared 的纯函数能改档案里的数字；
 *   - feedbackStats 永远由本机数据重算，不从存储里读；
 *   - 这里不发任何网络请求。
 */

const storage = (injected?: StorageLike): StorageLike | undefined =>
  injected ?? resolveStorage() ?? undefined;

/** 同步算出一份档案的反馈统计（解读反馈 + 用户确认 + 纠错）。 */
export function withFeedbackStats(
  profile: PersonProfile,
  backend?: StorageLike,
): PersonProfile {
  return applyFeedbackStats(
    profile,
    loadInterpretationFeedback(storage(backend)),
  );
}

/** 读一个人的档案（已经重算过统计），没有就返回 null。 */
export function readProfile(
  personId: string,
  backend?: StorageLike,
): PersonProfile | null {
  const store = storage(backend);
  const found = loadProfiles(store).find((p) => p.id === personId);
  return found ? withFeedbackStats(found, store) : null;
}

/** 只读地跑一次档案变更：不改存储，只把结果算出来（给测试与预览用）。 */
export function readProfileOp(
  backend: StorageLike | undefined,
  personId: string,
  mutate: (current: PersonProfile) => PersonProfile,
): PersonProfile | null {
  const store = storage(backend);
  const found = loadProfiles(store).find((p) => p.id === personId);
  if (!found) return null;
  return withFeedbackStats(mutate(found), store);
}

/**
 * 跑一次档案变更并写回浏览器存储；personId 不存在时返回 null。
 *
 * `saveProfiles()` 失败时（存储配额满、localStorage 被禁用）原本只返回 `false`
 * 而没人看它 —— 用户确认了一堆长期结论，界面看起来成功了，其实一条都没存下来。
 * 现在这里把它变成带原因的异常，交给 `useWorkspace` → 界面红条显示。
 */
export function writeProfileOp(
  backend: StorageLike | undefined,
  personId: string,
  _at: number,
  mutate: (current: PersonProfile) => PersonProfile,
): PersonProfile | null {
  const store = storage(backend);
  const current = loadProfiles(store).find((p) => p.id === personId);
  if (!current) return null;
  const next = withFeedbackStats(mutate(current), store);
  const ok = saveProfiles(
    loadProfiles(store).map((p) => (p.id === personId ? next : p)),
    store,
  );
  if (!ok)
    throw new LocalStorageError(
      store
        ? "保存长期档案失败：本机存储已满或不可写（localStorage 一般只有 5MB 左右）。" +
          "先删掉不用的聊天记录或清空部分档案再试。"
        : "保存长期档案失败：浏览器不允许本页面使用本机存储" +
          "（无痕 / 隐私窗口，或禁用了网站数据）。",
    );
  return next;
}

/** 删除一个人：档案与聊天记录是两套存储，调用方负责一并清掉。 */
export function removeProfile(personId: string, backend?: StorageLike): void {
  deleteProfile(personId, storage(backend));
}

/**
 * 一段本机对话的稳定 id。
 *
 * 同一个人 + 同一段关系 → 同一段对话。
 * 这样刷新页面、重开浏览器都会回到同一段，基线也不会被重复累计
 * （commitConversationToProfile 用 conversationId 判断"这段是否已经并入过"）。
 * 换对象或换关系就是另一段对话，各自独立累计。
 */
export function buildConversationId(input: {
  personId: string;
  relation: Relation;
}): string {
  return `conv:${shortHash(`${input.personId}|${input.relation}`)}`;
}
