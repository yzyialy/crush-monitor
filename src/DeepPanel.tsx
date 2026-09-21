import { useState } from "react";
import { AlertCircle, Check, HelpCircle, RotateCcw } from "lucide-react";
import {
  FEEDBACK_REASONS,
  type InterpretationFeedback,
  type Message,
  type UserTranslation,
} from "../shared/types";

/**
 * 深度解读面板。
 *
 * 用户主要看到的是 UserTranslation 的六个部分，而不是第二层的原始 JSON。
 * 刻意不展示：模型思维链、原始 prompt、raw JSON。
 *
 * 语言原则：具体、直白、可验证；所有推断都保留「可能」措辞，
 * 不出现「她就是…」「她一定…」这类断言。
 */

export type DeepPanelProps = {
  translation: UserTranslation | null;
  messages: Message[];
  /** 展示中的解读是否基于较早的输入 */
  isStale?: boolean;
  /** 点击证据时定位到对应消息 */
  onLocate: (messageId: string) => void;
  /** 当前解读对应的 contextKey，反馈用它关联 */
  contextKey: string;
  feedback: InterpretationFeedback[];
  onFeedback: (input: {
    verdict: InterpretationFeedback["verdict"];
    reasons: string[];
    note: string;
  }) => void;
};

/** 证据字符串可能是消息 id，也可能是描述文字。 */
function EvidenceList({
  items,
  messages,
  onLocate,
  tone,
}: {
  items: string[];
  messages: Message[];
  onLocate: (id: string) => void;
  tone: "support" | "against";
}) {
  if (!items.length)
    return <p className="deep-muted">没有列出具证据。</p>;
  return (
    <ul className={`deep-evidence deep-evidence-${tone}`}>
      {items.map((item, index) => {
        const matched = messages.find((m) => m.id === item);
        if (!matched)
          return (
            <li key={`${item}-${index}`}>
              <span>{item}</span>
            </li>
          );
        return (
          <li key={`${item}-${index}`}>
            <button
              className="deep-evidence-link"
              onClick={() => onLocate(matched.id)}
              aria-label={`定位到这条消息：${matched.text}`}
            >
              {matched.sender === "other" ? "对方" : "我"}：{matched.text}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function DeepPanel({
  translation,
  messages,
  isStale = false,
  onLocate,
  contextKey,
  feedback,
  onFeedback,
}: DeepPanelProps) {
  const [mode, setMode] = useState<"none" | "problem">("none");
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const saved = feedback.filter((f) => f.contextKey === contextKey);

  if (!translation) return null;

  const submit = (verdict: InterpretationFeedback["verdict"]) => {
    onFeedback({ verdict, reasons, note });
    setMode("none");
    setReasons([]);
    setNote("");
  };

  return (
    <div className="deep-panel">
      {isStale && (
        <p className="deep-stale" role="status">
          <AlertCircle size={14} />
          聊天内容已变化，这份解读基于较早的上下文。
        </p>
      )}
      <section className="deep-section">
        <h3>发生了什么</h3>
        {translation.whatHappened.length ? (
          <ul>
            {translation.whatHappened.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="deep-muted">没有提取到可观察的事实。</p>
        )}
      </section>

      <section className="deep-section">
        <h3>和她平时相比</h3>
        <p className="deep-hint">
          这里比较的是「这一次」和过去多次对话里她自己的水平，不是和她之外的人比，
          也不是说她变冷淡了。
        </p>
        {translation.comparedToUsual.length ? (
          <ul>
            {translation.comparedToUsual.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="deep-muted">还没有足够的历史可以和她自己比较。</p>
        )}
      </section>

      <section className="deep-section">
        <h3>你可能漏掉的信号</h3>
        {translation.whatYouMightMiss.length ? (
          <ul>
            {translation.whatYouMightMiss.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="deep-muted">这次没有额外信号。</p>
        )}
      </section>

      <section className="deep-section">
        <h3>可能是什么意思</h3>
        <p className="deep-hint">
          以下是并列的可能解释，不是唯一答案，也不代表对方的真实想法。
        </p>
        {translation.possibleMeanings.length ? (
          translation.possibleMeanings.map((item, index) => (
            <div className="deep-meaning" key={index}>
              <strong>{item.interpretation}</strong>
              <div className="deep-meaning-evidence">
                <span className="deep-label">支持</span>
                <EvidenceList
                  items={item.supportingEvidence}
                  messages={messages}
                  onLocate={onLocate}
                  tone="support"
                />
              </div>
              {item.contradictingEvidence.length > 0 && (
                <div className="deep-meaning-evidence">
                  <span className="deep-label">与此冲突</span>
                  <EvidenceList
                    items={item.contradictingEvidence}
                    messages={messages}
                    onLocate={onLocate}
                    tone="against"
                  />
                </div>
              )}
            </div>
          ))
        ) : (
          <p className="deep-muted">目前没有形成可列出的解释。</p>
        )}
      </section>

      <section className="deep-section">
        <h3>为什么这么判断</h3>
        <p className="deep-hint">点击可以定位到对应的聊天消息。</p>
        <EvidenceList
          items={translation.strongestEvidence}
          messages={messages}
          onLocate={onLocate}
          tone="support"
        />
      </section>

      <section className="deep-section">
        <h3>目前不能确定</h3>
        {translation.uncertainty.length ? (
          <ul>
            {translation.uncertainty.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="deep-muted">没有额外的不确定说明。</p>
        )}
      </section>

      <section className="deep-section">
        <h3>接下来观察什么</h3>
        <p className="deep-hint">
          这里是下一步可以留意的信号，不是「你应该怎么回复」。
        </p>
        {translation.whatToWatchNext.length ? (
          <ul>
            {translation.whatToWatchNext.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="deep-muted">暂时没有可观察的方向。</p>
        )}
      </section>

      <section className="deep-feedback">
        {mode === "none" ? (
          <>
            <p className="deep-hint">
              反馈只保存在这台电脑的浏览器里（不上传任何服务器），
              用于以后校准，不会自动改动任何判断规则。
            </p>
            <div className="deep-feedback-actions">
              <button className="secondary" onClick={() => submit("helpful")}>
                <Check size={15} />
                这个解读有帮助
              </button>
              <button className="secondary" onClick={() => setMode("problem")}>
                <HelpCircle size={15} />
                我觉得判断有问题
              </button>
            </div>
            {saved.length > 0 && (
              <p className="deep-saved">
                已记录 {saved.length} 条反馈
              </p>
            )}
          </>
        ) : (
          <>
            <p className="deep-hint">哪里有问题？可多选。</p>
            <div className="deep-reasons">
              {FEEDBACK_REASONS.map((reason) => {
                const active = reasons.includes(reason.key);
                return (
                  <button
                    key={reason.key}
                    className={`deep-reason ${active ? "selected" : ""}`}
                    aria-pressed={active}
                    onClick={() =>
                      setReasons((old) =>
                        old.includes(reason.key)
                          ? old.filter((x) => x !== reason.key)
                          : [...old, reason.key],
                      )
                    }
                  >
                    {active && <Check size={13} />}
                    {reason.label}
                  </button>
                );
              })}
            </div>
            <label className="field">
              实际情况 / 我后来了解到的是（可选）
              <textarea
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如：那天她其实是在赶稿，不是不想聊"
              />
            </label>
            <div className="deep-feedback-actions">
              <button className="primary" onClick={() => submit("problem")}>
                提交反馈
              </button>
              <button className="secondary" onClick={() => setMode("none")}>
                <RotateCcw size={14} />
                返回
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** 深度解读按钮下方的一次性说明，不做弹窗。 */
export function DeepPrivacyNote() {
  return (
    <p className="deep-privacy">
      <AlertCircle size={13} />
      深度解读会把当前相关的聊天上下文发送给第二层 AI 分析。
    </p>
  );
}
