import type { OioCard } from "./types";

export function makeId(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function hasChineseText(text: string) {
  return /[\u4e00-\u9fff]/.test(text);
}

export function deriveAutoTitle(body: string, aiTitle?: string, chineseMeaning?: string) {
  if (aiTitle?.trim() && hasChineseText(aiTitle)) return aiTitle.trim();
  if (chineseMeaning?.trim() && hasChineseText(chineseMeaning)) return chineseMeaning.trim();
  const trimmed = body.trim();
  if (!trimmed) return "日常随记";
  // 如果输入本身含有中文，提取第一句中文核心短句
  if (hasChineseText(trimmed)) {
    const firstLine = trimmed.split(/[\n，。！？.!?]/)[0].trim();
    return firstLine ? firstLine.slice(0, 18) : trimmed.slice(0, 18);
  }
  // 如果输入是纯英文，根据语义关键词智能映射中文主题（绝不输出英文切片）
  const lower = trimmed.toLowerCase();
  if (/\b(welcome|home|friend|party|meet|visit|guest|invite)\b/i.test(lower)) return "朋友聚会与拜访";
  if (/\b(dinner|lunch|breakfast|cook|eat|food|coffee|tea|restaurant|delicious|meal|dish)\b/i.test(lower)) return "美食与烹饪聚餐";
  if (/\b(weather|sunny|rain|snow|hot|cold|warm|cloudy|wind|storm|spring|summer|autumn|winter)\b/i.test(lower)) return "晴朗好天气与日常";
  if (/\b(work|meeting|project|office|job|busy|deadline|boss|email|company)\b/i.test(lower)) return "职场工作与任务";
  if (/\b(study|learn|book|english|read|exam|school|class|practice)\b/i.test(lower)) return "学习与语言心得";
  if (/\b(drive|car|train|bus|flight|trip|travel|subway|walk|traffic|hotel)\b/i.test(lower)) return "出行与旅途碎念";
  if (/\b(happy|tired|sleep|relax|weekend|morning|night|exhausted|feeling|mood)\b/i.test(lower)) return "生活随笔与心境";
  if (/\b(who\s+are\s+you|what('s|\s+is)\s+your\s+name|my\s+name\s+is|i\s+am\s+|nice\s+to\s+meet)\b/i.test(lower)) return "自我介绍与打招呼";
  if (/\b(thank|thanks|grateful|appreciate)\b/i.test(lower)) return "感谢与礼貌客套";
  if (/\b(how\s+are\s+you|good\s+morning|good\s+afternoon|good\s+evening|hey|hello|hi)\b/i.test(lower)) return "日常问候与交流";
  return "生活随笔记录";
}

export function dayKeyOf(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 连续活跃天数：从今天（若无记录则从昨天）往回数连续有活动的天数 */
export function computeStreak(dateKeys: Iterable<string>) {
  const set = new Set(dateKeys);
  const cursor = new Date();
  if (!set.has(dayKeyOf(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (set.has(dayKeyOf(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** 互译/回忆的提示语：中文原文优先，英文卡用 AI 中文释义，都没有则退回标题提示（标题若是原句前缀则给通用提示，避免泄底） */
export function recallPromptOf(card: Pick<OioCard, "body" | "title"> & { ai: { chineseMeaning?: string } }): { prompt: string; kind: "chinese" | "hint" } {
  if (hasChineseText(card.body)) return { prompt: card.body, kind: "chinese" };
  const meaning = card.ai.chineseMeaning?.trim();
  if (meaning) return { prompt: meaning, kind: "chinese" };
  const title = card.title.trim();
  const hint = title && !card.body.startsWith(title) ? title : "你之前记录的一段表达";
  return { prompt: hint, kind: "hint" };
}

const notableWords = (card: OioCard) =>
  new Set(`${card.title} ${card.body} ${card.ai.rewrittenSentences.join(" ")} ${card.ai.practiceKeywords.join(" ")}`.toLowerCase().match(/[a-z'’-]{4,}/g) ?? []);

/** 轻量相关记录推荐：显著单词重合度 + AI 场景标签重合度加权 */
export function relatedCards(card: OioCard, all: OioCard[], limit = 3): OioCard[] {
  const own = notableWords(card);
  const ownTags = new Set((card.ai.relatedTags ?? []).map((tag) => tag.trim()));
  if (!own.size && !ownTags.size) return [];
  return all
    .filter((candidate) => candidate.id !== card.id)
    .map((candidate) => {
      const theirs = notableWords(candidate);
      let score = 0;
      own.forEach((word) => { if (theirs.has(word)) score += 1; });
      const theirTags = new Set((candidate.ai.relatedTags ?? []).map((tag) => tag.trim()));
      ownTags.forEach((tag) => { if (theirTags.has(tag)) score += 2; });
      return { candidate, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

export function formatTime(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

export function formatFullDate(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
}

export function isSameLocalDay(a: string, b: Date) {
  const date = new Date(a);
  return date.getFullYear() === b.getFullYear() && date.getMonth() === b.getMonth() && date.getDate() === b.getDate();
}

export function cardPreview(card: OioCard) {
  return card.ai.rewrittenSentences.join(" ") || card.body;
}

export function speak(text: string, language = "en-US") {
  if (!("speechSynthesis" in window)) return false;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    utterance.rate = 0.92;
    // 优先选择自然度高的英文本地发音引擎（如 Samantha、Daniel、Ava、Google 等）
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      const preferred = voices.find(
        (v) => (v.lang === language || v.lang.startsWith("en")) && (v.localService || v.name.includes("Natural") || v.name.includes("Enhanced") || v.name.includes("Samantha") || v.name.includes("Daniel") || v.name.includes("Alex"))
      ) || voices.find((v) => v.lang.startsWith("en"));
      if (preferred) utterance.voice = preferred;
    }
    // Safari / iOS 某些版本下 cancel 后立即 speak 需要微小延迟以防挂起
    window.setTimeout(() => {
      window.speechSynthesis.speak(utterance);
    }, 16);
    return true;
  } catch {
    return false;
  }
}

export async function hashCardContent(card: Pick<OioCard, "body" | "tasks">) {
  const source = new TextEncoder().encode(JSON.stringify({ body: card.body.trim(), tasks: [...card.tasks].sort() }));
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function clozeSentence(sentence: string, keywords: string[]) {
  const selected = keywords.find((keyword) => sentence.toLowerCase().includes(keyword.toLowerCase()))
    ?? sentence.split(/\s+/).filter((word) => word.replace(/[^a-z]/gi, "").length > 5)[0];
  if (!selected) return { prompt: sentence, answer: "" };
  const escaped = selected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { prompt: sentence.replace(new RegExp(escaped, "i"), "_____"), answer: selected.replace(/[^a-z'-]/gi, "") };
}

export function normalizeWord(value: string) {
  // \p{L} 保留中文等所有语言的字母，不再只认英文字母
  return value.trim().toLowerCase().replace(/[^\p{L}'’-]/gu, "");
}

export interface ClozeSegment {
  type: "text" | "blank";
  value: string;
}

/** 把句子按挖空词切段：支持多词短语与中文（中文按子串匹配），拉丁词不会命中其他单词的内部 */
export function splitClozeSegments(sentence: string, words: string[]): ClozeSegment[] {
  // 先按空白拆词再逐词归一化（normalizeWord 会去掉空格，顺序不能反）。
  // 归一化后仅剩字母/撇号/连字符（已小写），用 indexOf 精确扫描即可，无需动态正则。
  const phrases = [...new Set(words.map((word) => word.split(/\s+/).map((part) => normalizeWord(part)).filter(Boolean).join(" ")).filter(Boolean))];
  if (!phrases.length || !sentence.trim()) return [{ type: "text", value: sentence }];

  const lower = sentence.toLowerCase();
  const isLetter = (char: string | undefined) => Boolean(char && /\p{L}/u.test(char));
  const intervals: Array<{ start: number; end: number }> = [];
  for (const phrase of phrases) {
    const hasCJK = /[\u4e00-\u9fff]/.test(phrase);
    let searchFrom = 0;
    while (searchFrom <= lower.length - phrase.length) {
      const index = lower.indexOf(phrase, searchFrom);
      if (index === -1) break;
      searchFrom = index + 1;
      // 拉丁词要求两侧不是字母（避免 cat 命中 category）；中文直接按子串匹配
      if (!hasCJK) {
        const before = index > 0 ? sentence[index - 1] : undefined;
        const after = sentence[index + phrase.length];
        if (isLetter(before) || isLetter(after)) continue;
      }
      intervals.push({ start: index, end: index + phrase.length });
    }
  }
  if (!intervals.length) return [{ type: "text", value: sentence }];
  intervals.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start < last.end) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ ...interval });
  }

  const segments: ClozeSegment[] = [];
  let cursor = 0;
  for (const { start, end } of merged) {
    if (start > cursor) segments.push({ type: "text", value: `${sentence.slice(cursor, start)} ` });
    segments.push({ type: "blank", value: sentence.slice(start, end) });
    cursor = end;
  }
  if (cursor < sentence.length) segments.push({ type: "text", value: sentence.slice(cursor) });
  return segments;
}

export function toggleWordInList(words: string[], word: string) {
  const norm = normalizeWord(word);
  if (!norm) return words;
  const exists = words.some((item) => normalizeWord(item) === norm);
  return exists ? words.filter((item) => normalizeWord(item) !== norm) : [...words, norm];
}

export function estimateCost(inputTokens: number, outputTokens: number, inputPrice?: number, outputPrice?: number) {
  if (inputPrice == null || outputPrice == null) return null;
  return (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice;
}
