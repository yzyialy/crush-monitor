import { useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Trash2,
  Undo2,
} from "lucide-react";
import { confirmationParts } from "../shared/profile";
import { coldStartNotice } from "./useProfile";
import { buildAuditTrace } from "../shared/retrieval";
import type { ProfileUiState } from "./useProfile";
import type {
  ConfirmationVerdict,
  DeepAnalysis,
  HistoricalPatternTrend,
  InferenceCandidate,
  KnownPattern,
  LongTermMemory,
  Message,
  Pattern,
  ProfileContextBundle,
} from "../shared/types";
import "./longterm.css";

/**
 * 长期观察面板（第三阶段第一版 UI）。
 *
 * 设计原则：
 *   - 不大改页面，一个可折叠区域 + 一个「查看详细依据」；
 *   - 只展示行为层面的信息，不出现人格标签、类型判断或喜欢概率；
 *   - 历史不足时明确说明，不假装已经认识这个人；
 *   - 用户可以删除任何一条、清空基线，也可以清空全部长期数据。
 */

const VERDICT_OPTIONS: { key: ConfirmationVerdict; label: string }[] = [
  { key: "mostly_correct", label: "基本正确" },
  { key: "partly_correct", label: "部分正确" },
  { key: "incorrect", label: "不正确" },
  { key: "unknown", label: "还不知道" },
];

const SOURCE_LABEL: Record<string, string> = {
  USER_CONFIRMED: "你确认的",
  OBSERVED: "观察到的事实",
  MODEL_INFERRED: "模型推测（弱背景）",
};

/** 模式的证据标签。模型推测不会以「长期模式」的形式出现。 */
function patternSourceLabel(pattern: KnownPattern): string {
  if (pattern.sourceType === "user_confirmed") return "你确认过";
  if (pattern.sourceType === "model_inferred")
    return `模型推测（${pattern.evidenceCount} 次），不作为长期结论`;
  return `程序统计 · ${pattern.conversationCount} 段对话支持`;
}

export type LongTermPanelProps = {
  state: ProfileUiState;
  analysis: DeepAnalysis | null;
  contextKey: string;
  historicalTrend: HistoricalPatternTrend | null;
  bundle: ProfileContextBundle | null;
  patterns?: Pattern[];
  messages: Message[];
  candidates: InferenceCandidate[];
  onConfirm: (input: {
    verdict: ConfirmationVerdict;
    confirmedParts: string[];
  }) => void;
  onCorrect: (input: { content: string; contradictedIds: string[] }) => void;
  suggestConflicts: (content: string) => LongTermMemory[];
  onRemoveProfile: () => void;
  onResetBaseline: () => void;
  onRemoveMemory: (memoryId: string) => void;
  onClearAll: () => void;
  onLocate?: (messageId: string) => void;
};

export function LongTermPanel(props: LongTermPanelProps) {
  const { state, analysis, historicalTrend, bundle } = props;
  const [detail, setDetail] = useState(false);
  const [verdict, setVerdict] = useState<ConfirmationVerdict | null>(null);
  const [parts, setParts] = useState<string[]>([]);
  const [correction, setCorrection] = useState("");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [notice, setNotice] = useState("");

  const parts_ = useMemo(
    () => (analysis ? confirmationParts(analysis, props.candidates) : []),
    [analysis, props.candidates],
  );

  const audit = useMemo(
    () =>
      bundle
        ? buildAuditTrace({
            bundle,
            patterns: props.patterns,
            historicalTrend,
            analysis,
            habits: state.habits,
            messages: props.messages,
          })
        : null,
    [bundle, historicalTrend, analysis, state.habits, props.patterns, props.messages],
  );

  const cold = coldStartNotice(state.status);

  const submitConfirm = () => {
    if (!verdict) return;
    // 「基本正确」也不能整份升级：只提交用户真正勾选的那几部分
    props.onConfirm({ verdict, confirmedParts: parts });
    setNotice(
      verdict === "mostly_correct" || verdict === "partly_correct"
        ? `已记录。只有你勾选的 ${parts.length} 项被记为已确认，其他内容仍然是推测。`
        : "已记录你的判断。",
    );
    setVerdict(null);
    setParts([]);
  };

  const submitCorrection = () => {
    if (!correction.trim()) return;
    props.onCorrect({ content: correction, contradictedIds: conflicts });
    setNotice(
      conflicts.length
        ? `已记下你的纠正，并把 ${conflicts.length} 条相关推断标为「已被推翻」。历史推断不会删除，以后可以复盘。`
        : "已记下你确认的事实。",
    );
    setCorrection("");
    setConflicts([]);
    setDrafting(false);
  };

  return (
    <div className="lt-panel">
      <section className="lt-section">
        <h3>历史样本</h3>
        <p className={cold ? "lt-cold" : "lt-status"}>
          {cold && <AlertCircle size={13} />}
          {state.statusLabel}
        </p>
        {state.conversations > 0 && (
          <p className="lt-muted">
            已记录 {state.conversations} 段对话 · 表达习惯 {state.habits.length} 条 ·
            观察中的模式 {state.knownPatterns.length} 条
          </p>
        )}
      </section>

      <section className="lt-section">
        <h3>最近明显变化</h3>
        {historicalTrend && !historicalTrend.insufficientHistory ? (
          <ul className="lt-list">
            {historicalTrend.deltas
              .filter((d) => d.significance !== "none")
              .slice(0, 4)
              .map((delta) => (
                <li key={delta.metric}>
                  {delta.label}：这次 {delta.current}，她平时约 {delta.historical}
                  <span className="lt-tag">
                    {delta.significance === "large"
                      ? "非常明显"
                      : delta.significance === "moderate"
                        ? "明显"
                        : "略微"}
                  </span>
                </li>
              ))}
            {historicalTrend.deltas.every((d) => d.significance === "none") && (
              <li className="lt-muted">
                这次的行为指标和她平时的水平接近，没有观察到明显不同。
              </li>
            )}
          </ul>
        ) : (
          <p className="lt-muted">
            还没有足够的历史可以比较「这次和她平时有什么不同」。
          </p>
        )}
        {historicalTrend && (
          <p className="lt-muted">
            会话内趋势与历史趋势分开计算：会话内看前半段 vs 后半段，
            历史看这一次 vs 过去多次，两者不会合并成一个结论。
          </p>
        )}
      </section>

      <section className="lt-section">
        <h3>已确认事实</h3>
        {state.confirmed.length ? (
          <ul className="lt-list">
            {state.confirmed.map((memory) => (
              <li key={memory.id}>
                {memory.content}
                <button
                  className="lt-remove"
                  aria-label={`删除这条已确认事实：${memory.content}`}
                  onClick={() => props.onRemoveMemory(memory.id)}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="lt-muted">
            还没有你确认过的事实。模型自己的推测永远不会自动变成事实。
          </p>
        )}
      </section>

      <section className="lt-section">
        <h3>观察到的事实</h3>
        {state.observed.length ? (
          <ul className="lt-list">
            {state.observed.slice(0, 6).map((memory) => (
              <li key={memory.id}>
                {memory.content}
                <button
                  className="lt-remove"
                  aria-label={`删除这条观察：${memory.content}`}
                  onClick={() => props.onRemoveMemory(memory.id)}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="lt-muted">还没有从对话里记录到可核对的事实。</p>
        )}
      </section>

      <section className="lt-section">
        <h3>观察中的模式</h3>
        <p className="lt-muted">
          这里的模式只由程序统计产生（至少 3 段对话支持；涉及一起活动这类解释需要 4 段），
          模型自己的推测不会成为长期模式。
        </p>
        {state.knownPatterns.length ? (
          <ul className="lt-list">
            {state.knownPatterns.slice(0, 8).map((pattern) => (
              <li key={pattern.id}>
                {pattern.description}
                <span className="lt-tag">{patternSourceLabel(pattern)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="lt-muted">
            还没有形成模式。模型只说一次就下结论的内容不会进入长期记录。
          </p>
        )}
      </section>

      <section className="lt-section">
        <h3>常见表达习惯</h3>
        {state.habits.length ? (
          <ul className="lt-list">
            {state.habits.slice(0, 6).map((habit) => (
              <li key={habit.expression}>
                「{habit.expression}」出现 {habit.observedCount} 次 ·{" "}
                {habit.usualMeaning}
              </li>
            ))}
          </ul>
        ) : (
          <p className="lt-muted">
            还没有统计到稳定的表达习惯（需要至少两次对话里反复出现）。
          </p>
        )}
      </section>

      <section className="lt-section">
        <h3>模型推测（不作为长期结论）</h3>
        <p className="lt-muted">
          这些只是这次解读里的猜测，需要你确认才会变成事实。系统不会把它们
          自动写成长期模式。
        </p>
        {state.inferred.length ? (
          <ul className="lt-list">
            {state.inferred.map((item) => (
              <li key={item.id}>{item.content}</li>
            ))}
          </ul>
        ) : (
          <p className="lt-muted">还没有模型推测。</p>
        )}
      </section>

      <section className="lt-section lt-confirm">
        <h3>这个判断后来被证实了吗？</h3>
        {analysis ? (
          <>
            <div className="lt-verdicts">
              {VERDICT_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  className={`lt-verdict ${verdict === option.key ? "selected" : ""}`}
                  aria-pressed={verdict === option.key}
                  onClick={() => setVerdict(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {(verdict === "mostly_correct" || verdict === "partly_correct") && (
              <div className="lt-parts">
                <p className="lt-muted">
                  你确认的是哪一部分？只有勾选的内容会被记为已确认事实。
                </p>
                {parts_.map((part) => {
                  const active = parts.includes(part.key);
                  return (
                    <button
                      key={part.key}
                      className={`lt-part ${active ? "selected" : ""}`}
                      aria-pressed={active}
                      onClick={() =>
                        setParts((old) =>
                          old.includes(part.key)
                            ? old.filter((x) => x !== part.key)
                            : [...old, part.key],
                        )
                      }
                    >
                      <span className="lt-part-label">{part.label}</span>
                      <span className="lt-part-detail">{part.detail}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="lt-actions">
              <button className="primary" disabled={!verdict} onClick={submitConfirm}>
                记录
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setDrafting((v) => !v);
                  setConflicts([]);
                }}
              >
                <Undo2 size={14} />
                不是这样，我来说实际情况
              </button>
            </div>
          </>
        ) : (
          <p className="lt-muted">先做一次深度解读，然后可以在这里确认或纠正它。</p>
        )}

        {drafting && (
          <div className="lt-correction">
            <label className="field">
              实际情况
              <textarea
                value={correction}
                maxLength={300}
                onChange={(e) => {
                  setCorrection(e.target.value);
                  setConflicts(
                    props
                      .suggestConflicts(e.target.value)
                      .map((m) => m.id),
                  );
                }}
                placeholder="例如：不是，她那天只是发烧"
              />
            </label>
            {conflicts.length > 0 && (
              <p className="lt-muted">
                以下推断看起来和你的说明冲突，会一并标为「已被推翻」（内容保留）：
                {conflicts.map((id) => {
                  const memory = props.candidates.find(
                    (c) => `mem:pattern:${c.id}` === id,
                  );
                  return (
                    <span key={id} className="lt-conflict">
                      {memory?.content ?? id}
                    </span>
                  );
                })}
              </p>
            )}
            <div className="lt-actions">
              <button
                className="primary"
                disabled={!correction.trim()}
                onClick={submitCorrection}
              >
                保存纠正
              </button>
              <button className="secondary" onClick={() => setDrafting(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        {notice && (
          <p className="lt-notice" role="status">
            {notice}
          </p>
        )}
      </section>

      <section className="lt-section">
        <button
          className="lt-detail-toggle"
          aria-expanded={detail}
          onClick={() => setDetail((v) => !v)}
        >
          {detail ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          查看详细依据
        </button>
        {detail && audit && (
          <div className="lt-detail">
            <h4>当前证据（事实）</h4>
            {audit.facts.length ? (
              <ul className="lt-list">
                {audit.facts.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="lt-muted">这次没有可核对的事实记录。</p>
            )}

            <h4>历史基线</h4>
            {audit.historical.length ? (
              <ul className="lt-list">
                {audit.historical.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="lt-muted">还没有历史基线。</p>
            )}

            <h4>这次的落点</h4>
            {audit.current.length ? (
              <ul className="lt-list">
                {audit.current.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="lt-muted">还没有算出本次指标。</p>
            )}

            {audit.habits.length > 0 && (
              <>
                <h4>个人表达习惯（用于抑制误判）</h4>
                <ul className="lt-list">
                  {audit.habits.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </>
            )}

            <h4>模型解释（不是事实）</h4>
            {audit.interpretation.length ? (
              <ul className="lt-list">
                {audit.interpretation.map((item, i) => (
                  <li key={i}>
                    <span className="lt-tag">{item.label}</span>
                    {item.detail}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="lt-muted">还没有模型解释。</p>
            )}

            <h4>来源等级</h4>
            {audit.bySource.map((group) => (
              <div key={group.source}>
                <p className="lt-muted">
                  {SOURCE_LABEL[group.source]}（{group.items.length} 条）
                </p>
                {group.items.length > 0 && (
                  <ul className="lt-list">
                    {group.items.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}

            <h4>没有参与本次判断的内容</h4>
            <ul className="lt-list">
              {audit.excluded.map((line, i) => (
                <li key={i} className="lt-muted">
                  {line}
                </li>
              ))}
            </ul>
            {bundle && (
              <p className="lt-muted">
                本次送入模型的上下文约 {bundle.estimatedTokens} tokens
                {bundle.truncated ? "（已按预算截断）" : ""}。
              </p>
            )}
          </div>
        )}
      </section>

      <section className="lt-section lt-danger">
        <h3>删除</h3>
        <p className="lt-muted">
          这些操作只影响长期观察数据，不会删除你导入的聊天记录。
        </p>
        <div className="lt-actions">
          <button className="secondary" onClick={props.onResetBaseline}>
            清空历史基线
          </button>
          <button className="secondary" onClick={props.onRemoveProfile}>
            <Trash2 size={14} />
            删除这个人的档案
          </button>
          <button className="secondary" onClick={props.onClearAll}>
            <Trash2 size={14} />
            清空全部长期数据
          </button>
        </div>
      </section>
    </div>
  );
}
