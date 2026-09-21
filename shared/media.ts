import type { MediaKind, Message } from "./types";

/**
 * 媒体占位识别。
 *
 * 微信复制出来的语音、图片、表情包等只有占位标识，正文是看不见的：
 *
 *   对方 21:00
 *   [语音]
 *
 * 用户可以在占位后面自己补一句描述或转述：
 *
 *   对方 21:00
 *   [语音] 她说周末要加班
 *
 * 本模块负责把这两种情况分开：
 *   - 只有占位、没有补充 → 仍然是「不可读」，不参与分析（与以前一致）
 *   - 补了内容 → 正文取补充的那段，并记下 mediaKind，
 *     让模型知道这是**转述/描述**，不是对方打出来的原文
 *
 * 它不做任何推断，只做结构识别。
 */

/** 占位标识表。左边是微信可能出现的写法，右边是归类。 */
const MEDIA_MARKERS: { marker: string; kind: MediaKind; label: string }[] = [
  { marker: "语音", kind: "voice", label: "语音" },
  { marker: "图片", kind: "image", label: "图片" },
  { marker: "视频", kind: "video", label: "视频" },
  { marker: "动画表情", kind: "sticker", label: "动画表情" },
  { marker: "表情包", kind: "sticker", label: "表情包" },
  { marker: "表情", kind: "sticker", label: "表情" },
  { marker: "文件", kind: "file", label: "文件" },
  { marker: "位置", kind: "location", label: "位置" },
  { marker: "链接", kind: "link", label: "链接" },
  { marker: "小程序", kind: "other", label: "小程序" },
  { marker: "音乐", kind: "other", label: "音乐" },
  { marker: "转账", kind: "other", label: "转账" },
  { marker: "红包", kind: "other", label: "红包" },
  { marker: "聊天记录", kind: "other", label: "聊天记录" },
  { marker: "引用", kind: "other", label: "引用" },
  { marker: "撤回消息", kind: "other", label: "撤回消息" },
  { marker: "不支持的消息", kind: "other", label: "不支持的消息" },
];

const MARKER_PATTERN = /^\[([^[\]]{1,10})\]\s*([\s\S]*)$/;

/** 给用户/模型看的名词。 */
const KIND_NOUN: Record<MediaKind, string> = {
  voice: "语音",
  image: "图片",
  video: "视频",
  sticker: "表情包",
  file: "文件",
  location: "位置",
  link: "链接",
  other: "消息卡片",
};

export function mediaNoun(kind: MediaKind): string {
  return KIND_NOUN[kind];
}

export type MediaMarker = {
  kind: MediaKind;
  /** 原始的占位写法，例如「动画表情」 */
  label: string;
  /** 用户在占位后面补的内容，没有则为空串 */
  note: string;
};

/**
 * 识别「[占位] 补充内容」。
 * 只认**整条消息以占位开头**的情况：正文中间出现方括号是普通文字，不做处理。
 */
export function parseMediaMarker(text: string): MediaMarker | null {
  const trimmed = text.trim();
  const match = trimmed.match(MARKER_PATTERN);
  if (!match) return null;
  const entry = MEDIA_MARKERS.find((item) => item.marker === match[1].trim());
  if (!entry) return null;
  return { kind: entry.kind, label: entry.label, note: match[2].trim() };
}

/** 这条消息是否是「带补充内容的媒体消息」（会参与分析）。 */
export function hasMediaDescription(message: Message): boolean {
  return Boolean(message.mediaKind) && message.kind === "text";
}

/**
 * 生成给模型看的正文。
 *
 * 关键：必须让模型知道这段话是**用户手动转述/描述**的，
 * 否则它会把转述当成对方原话，甚至把「[图片]」当成对方打的字。
 */
export function mediaPromptText(message: Message): string {
  if (!message.mediaKind) return message.text;
  const noun = mediaNoun(message.mediaKind);
  const owner = message.sender === "self" ? "我方" : "对方";
  if (message.kind === "unreadable")
    return `【${owner}发来的${noun}，内容不可见，用户没有补充描述】`;
  return `【${owner}发来的${noun}，以下内容由用户手动转述或描述，不是原始文字】${message.text}`;
}
